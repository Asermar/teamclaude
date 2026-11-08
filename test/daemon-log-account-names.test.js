import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnServer } from '../test-helpers/spawn-server.js';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { setUpstreamProxy, resolveUpstreamProxy, resetUpstreamProxy } from '../src/upstream-proxy.js';

// A headless daemon's console is its journal, one entry per line. An account
// name is free text from the config, so a name carrying a newline would split
// a console line into two entries, the second reading as one the daemon wrote.
// One representative path through the lines that name an account: the accounts
// startup drops, startup and its banner, a quota rejection on each account, the
// switch between them and the refusal when neither can serve.

const MARK = 'FORGED';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function startRejectingUpstream() {
  return http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(429, {
        'content-type': 'application/json',
        'retry-after': '3600',
        'anthropic-ratelimit-unified-5h-status': 'rejected',
        'anthropic-ratelimit-unified-5h-utilization': '1.02',
      });
      res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'quota' } }));
    });
  });
}

test('an account name carrying a newline does not split any daemon console line', async () => {
  const stub = startRejectingUpstream();
  const stubPort = await listen(stub);
  const server = await spawnServer({
    config: () => ({
      upstream: `http://127.0.0.1:${stubPort}`,
      upstreamProxy: false,
      accounts: [
        { name: `first\n${MARK} a`, type: 'apikey', apiKey: 'k1', priority: 0 },
        { name: `second\n${MARK} b`, type: 'apikey', apiKey: 'k2', priority: 1 },
        // Dropped at startup by resolveAccounts, each with its own line.
        { name: `third\n${MARK} c`, type: 'oauth' },
        { name: `fourth\n${MARK} d`, type: 'oauth', importFrom: '/nonexistent/teamclaude-test/credentials.json' },
      ],
    }),
  });
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-test', max_tokens: 1, messages: [] }),
      signal: AbortSignal.timeout(20_000),
    });
    await res.text();
    assert.equal(res.status, 429);
    const out = server.output();
    // Control: the path did log the account-naming lines this is about.
    for (const expected of ['No token for', 'Failed to import', 'Starting on account', 'Quota rejection (429)', 'Switched to account']) {
      assert.ok(out.includes(expected), `expected a "${expected}" line:\n${out}`);
    }
    const split = out.split('\n').filter(l => l.trimStart().startsWith(MARK));
    assert.deepEqual(split, [], `lines split by an account name:\n${out}`);
  } finally {
    await server.stop();
    stub.close();
  }
});

// The lines the walk above does not reach, each by the shortest path to it: the
// 403 refusal in both of its forms, a session pin released by a weekly rollover,
// and a session pinned by hand. They are asserted in-process, on what the line
// was handed, so a name that splits it is caught even if nothing prints it.

/** Run `fn` with console.log and console.error captured; returns what they got.
 * @param {() => Promise<void> | void} fn */
async function captured(fn) {
  const lines = [];
  const original = { log: console.log, error: console.error };
  console.log = (...args) => lines.push(args.map(String).join(' '));
  console.error = (...args) => lines.push(args.map(String).join(' '));
  try { await fn(); } finally { console.log = original.log; console.error = original.error; }
  return lines;
}

/** @param {string[]} lines @param {string} expected */
function assertNotSplit(lines, expected) {
  const out = lines.join('\n');
  assert.ok(out.includes(expected), `expected a "${expected}" line:\n${out}`);
  const split = out.split('\n').filter(l => l.trimStart().startsWith(MARK));
  assert.deepEqual(split, [], `lines split by an account name:\n${out}`);
}

const HOUR = 3600_000;
const oauthNamed = (name, token) => ({ name, type: 'oauth', accessToken: token, refreshToken: 'r', expiresAt: Date.now() + HOUR });

for (const [form, error, expected] of [
  ['a refused credential', { type: 'permission_error', message: 'Request not allowed' }, 'upstream refused the account credential'],
  ['an identity-verification hold', {
    type: 'permission_error',
    message: "Your account can't receive replies from Claude right now.",
    details: { error_code: 'verification_required', remediation_url: 'https://portal.anthropic.com/verify', capability: 'avocado' },
  }, 'upstream requires identity verification'],
]) {
  test(`the 403 line for ${form} does not split on an account name`, async () => {
    setUpstreamProxy(resolveUpstreamProxy({ upstreamProxy: false }, {}));
    const upstream = http.createServer((req, res) => {
      req.resume();
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error, request_id: 'req_test' }));
    });
    const upstreamPort = await listen(upstream);
    const am = new AccountManager([oauthNamed(`first\n${MARK} a`, 'ta')], 0.98, {
      refreshFn: async () => { throw new Error('must not refresh on a 403'); },
    });
    const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` });
    const proxyPort = await listen(proxy);
    try {
      const lines = await captured(async () => {
        const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': 'k' },
          body: JSON.stringify({ model: 'x', messages: [] }),
        });
        await res.text();
      });
      assertNotSplit(lines, expected);
    } finally {
      proxy.close();
      upstream.close();
      resetUpstreamProxy();
    }
  });
}

test('the session-pin release on a weekly rollover does not split on an account name', async () => {
  const am = new AccountManager([oauthNamed(`first\n${MARK} a`, 'ta'), oauthNamed(`second\n${MARK} b`, 'tb')], 0.98, {
    expiryRouting: { enabled: true, preempt: true }, distributeSessions: true,
  });
  for (const a of am.accounts) {
    a.quota.unified7d = 0.4;
    a.quota.unified7dReset = Date.now() + 10 * HOUR;
    a.probing = false;
  }
  const serve = () => {
    am.beginSession('s1');
    const account = am.getActiveAccount(null, 'claude-opus-5', null, 's1');
    if (account) am.recordSession('s1', account.index, 'claude-opus-5');
    am.endSession('s1');
    return account;
  };
  const first = serve();
  am.accounts[first.index].quota.unified7dReset += 7 * 24 * HOUR;
  const lines = await captured(() => { serve(); });
  assertNotSplit(lines, 'its weekly window rolled over');
});

test('a session pinned by hand does not split its line on an account name', async () => {
  const name = `second\n${MARK} b`;
  const am = new AccountManager([
    { name: 'first', type: 'apikey', apiKey: 'k1' },
    { name, type: 'apikey', apiKey: 'k2' },
  ], 0.98);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: 'http://127.0.0.1:9' });
  const port = await listen(proxy);
  try {
    const lines = await captured(async () => {
      const res = await fetch(`http://127.0.0.1:${port}/teamclaude/session-pin`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'k' },
        body: JSON.stringify({ sessionId: '3f2a1b9c-0000-4000-8000-000000000001', account: name }),
      });
      assert.equal(res.status, 200, await res.text());
    });
    assertNotSplit(lines, 'pinned to account');
  } finally {
    proxy.close();
  }
});

// The same line also prints why the pinned account is not eligible, and one
// reason, being outranked, names ANOTHER account: the one that preempts it.
test('a session pinned by hand to an outranked account does not split on the outranking name', async () => {
  const am = new AccountManager([
    { name: `first\n${MARK} a`, type: 'apikey', apiKey: 'k1', priority: 0 },
    { name: 'second', type: 'apikey', apiKey: 'k2', priority: 1 },
  ], 0.98);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: 'http://127.0.0.1:9' });
  const port = await listen(proxy);
  try {
    const lines = await captured(async () => {
      const res = await fetch(`http://127.0.0.1:${port}/teamclaude/session-pin`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'k' },
        body: JSON.stringify({ sessionId: '3f2a1b9c-0000-4000-8000-000000000001', account: 'second' }),
      });
      assert.equal(res.status, 200, await res.text());
    });
    assertNotSplit(lines, 'outranked by higher-priority account');
  } finally {
    proxy.close();
  }
});

// The control endpoint leaves a line for each account change it makes; the
// cordon (#647) is the third, beside priority and enable/disable.
for (const [path, body, expected] of [
  ['/teamclaude/account-cordon', { cordoned: true }, 'Cordoned account'],
  ['/teamclaude/disable', { disabled: true }, 'Disabled account'],
  ['/teamclaude/priority', { priority: 3 }, 'Set priority of'],
]) {
  test(`the control endpoint's "${expected}" line does not split on an account name`, async () => {
    const name = `first\n${MARK} a`;
    const am = new AccountManager([{ name, type: 'apikey', apiKey: 'k1' }, { name: 'second', type: 'apikey', apiKey: 'k2' }], 0.98);
    const hook = async (/** @type {string} */ account, /** @type {any} */ value) => ({ name: account, cordoned: value, disabled: value, priority: value?.priority });
    const hooks = { setAccountCordoned: hook, setAccountDisabled: hook, setAccountPriority: hook, reload: async () => 0 };
    const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: 'http://127.0.0.1:9' }, hooks);
    const port = await listen(proxy);
    try {
      const lines = await captured(async () => {
        const res = await fetch(`http://127.0.0.1:${port}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': 'k' },
          body: JSON.stringify({ account: name, ...body }),
        });
        assert.equal(res.status, 200, await res.text());
      });
      assertNotSplit(lines, expected);
    } finally {
      proxy.close();
    }
  });
}
