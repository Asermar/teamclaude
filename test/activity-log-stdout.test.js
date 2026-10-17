import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnServer } from '../test-helpers/spawn-server.js';

// `--activity-log -` is how a supervised daemon puts one line per request into
// its journal: the request lines go to stdout with a full timestamp, and the
// console lines — which already reach stdout — are not written a second time.
// What the journal has to answer is which session a request belonged to,
// which account served it, whether it changed account on the way, and, when
// nothing could serve it, that it was refused.

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})  /;
const SESSION = 'abcdef0123456789';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// Answers per api key: `reject` keys get a 429 that rejects the 5-hour quota
// (a spent bucket, so the proxy switches account), the rest a 200.
// `fail` keys get a 503, which the proxy fails over from once.
function startStubUpstream(reject, fail) {
  return http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (fail.has(req.headers['x-api-key'])) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'down' } }));
        return;
      }
      if (reject.has(req.headers['x-api-key'])) {
        res.writeHead(429, {
          'content-type': 'application/json',
          'retry-after': '3600',
          'anthropic-ratelimit-unified-5h-status': 'rejected',
          'anthropic-ratelimit-unified-5h-utilization': '1.02',
        });
        res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'quota' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  });
}

async function message(port) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-claude-code-session-id': SESSION },
    body: JSON.stringify({ model: 'claude-test', max_tokens: 1, messages: [] }),
    signal: AbortSignal.timeout(20_000),
  });
  await res.text();
  return res.status;
}

// The request line for the session, once it has been written.
async function requestLines(server, n) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const lines = server.output().split('\n').filter(l => l.includes(`${SESSION.slice(0, 6)} POST /v1/messages`));
    if (lines.length >= n || Date.now() > deadline) return lines;
    await new Promise(r => setTimeout(r, 50));
  }
}

async function withServer(reject, fn, fail = []) {
  const stub = startStubUpstream(new Set(reject), new Set(fail));
  const stubPort = await listen(stub);
  const server = await spawnServer({
    config: () => ({
      upstream: `http://127.0.0.1:${stubPort}`,
      upstreamProxy: false,
      accounts: [
        { name: 'first', type: 'apikey', apiKey: 'k1', priority: 0 },
        { name: 'second', type: 'apikey', apiKey: 'k2', priority: 1 },
      ],
    }),
    args: ['--activity-log', '-'],
  });
  try {
    await fn(server);
  } finally {
    await server.stop();
    stub.close();
  }
}

test('--activity-log - writes one timestamped line per request to stdout, without repeating the console', async () => {
  await withServer([], async server => {
    assert.equal(await message(server.port), 200);
    const lines = await requestLines(server, 1);
    assert.equal(lines.length, 1, server.output());
    assert.match(lines[0], ISO, lines[0]);
    assert.match(lines[0], /→ first \(200, /, lines[0]);
    // A console line reaches stdout once, not once as itself and once more as
    // an activity entry.
    const out = server.output();
    assert.equal(out.split('\n').filter(l => l.includes('Starting on account "first"')).length, 1, out);
    assert.equal(out.split('\n').filter(l => ISO.test(l) && !l.includes('POST /v1/messages')).length, 0,
      `only request lines carry the activity timestamp:\n${out}`);
  });
});

test('a request that changed account says which one served it and where it came from', async () => {
  await withServer(['k1'], async server => {
    assert.equal(await message(server.port), 200);
    const [line] = await requestLines(server, 1);
    assert.ok(line, server.output());
    assert.match(line, /→ second \[retry from first\] \(200, /, line);
  });
});

test('a request that failed over from a 5xx says so too', async () => {
  await withServer([], async server => {
    assert.equal(await message(server.port), 200);
    const [line] = await requestLines(server, 1);
    assert.ok(line, server.output());
    assert.match(line, /→ second \[retry from first\] \(200, /, line);
  }, ['k1']);
});

test('a request no account can serve is logged as refused, with its session', async () => {
  await withServer(['k1', 'k2'], async server => {
    assert.equal(await message(server.port), 429);
    const [line] = await requestLines(server, 1);
    assert.ok(line, server.output());
    assert.match(line, ISO, line);
    assert.match(line, /→ \(none available\).*\(429, /, line);
  });
});
