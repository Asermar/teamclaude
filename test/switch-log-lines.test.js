import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

// The two console lines that explain a rotation have to say why and from where.
// The threshold line used to print the weekly figure whatever tripped it, so
// an account whose 5-hour window was spent read "at 87.0% usage — will switch",
// pointing at the wrong bucket; and "Switched to account" named only the
// destination.

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}

/** Run fn with console.log captured; returns the lines it emitted. */
function captureLog(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try { fn(); } finally { console.log = original; }
  return lines;
}

test('the threshold line names the bucket that tripped it, its use and its threshold', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98);
  const reset = String(Math.floor(Date.now() / 1000) + 3600);
  const lines = captureLog(() => am.updateQuota(0, {
    'anthropic-ratelimit-unified-5h-utilization': '1.02',
    'anthropic-ratelimit-unified-5h-reset': reset,
    'anthropic-ratelimit-unified-7d-utilization': '0.87',
    'anthropic-ratelimit-unified-7d-reset': String(Number(reset) + 86400),
  }));
  const line = lines.find(l => l.includes('will switch'));
  assert.ok(line, lines.join('\n'));
  assert.match(line, /Account "a" at 102\.0% unified5h \(threshold 98\.0%\) — will switch on next request/, line);
});

test('the switch line names the account it switched from', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98);
  assert.equal(am.getActiveAccount().name, 'a');
  am.setDisabled(0, true);
  const lines = captureLog(() => assert.equal(am.getActiveAccount().name, 'b'));
  assert.ok(lines.some(l => l.includes('Switched to account "b" from "a"')), lines.join('\n'));
});
