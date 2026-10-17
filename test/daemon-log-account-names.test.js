import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnServer } from '../test-helpers/spawn-server.js';

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
