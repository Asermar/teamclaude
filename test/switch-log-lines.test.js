import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

// The line that explains a rotation has to say where it came from:
// "Switched to account" used to name only the destination. (The threshold line
// naming the bucket that tripped it is upstream's since v1.1.28, #639, and is
// tested in near-quota-bucket.test.js.)

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

test('the switch line names the account it switched from', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98);
  assert.equal(am.getActiveAccount().name, 'a');
  am.setDisabled(0, true);
  const lines = captureLog(() => assert.equal(am.getActiveAccount().name, 'b'));
  assert.ok(lines.some(l => l.includes('Switched to account "b" from "a"')), lines.join('\n'));
});

test('a name carrying a newline cannot split the switch line into two entries', () => {
  const am = new AccountManager([oauth('a\nforged'), oauth('b\nforged')], 0.98);
  am.getActiveAccount();
  am.setDisabled(0, true);
  const lines = captureLog(() => am.getActiveAccount());
  const line = lines.find(l => l.includes('Switched to account'));
  assert.ok(line, lines.join('\n'));
  assert.equal(line.includes('\n'), false, JSON.stringify(line));
});

test('a name carrying a newline cannot split the divert line into two entries', () => {
  const am = new AccountManager([oauth('a\nforged'), oauth('b\nforged')], 0.98);
  assert.equal(am.getActiveAccount(null, 'claude-opus-4-8').name, 'a\nforged');
  // a's Fable weekly is spent: it serves Opus but a Fable request is diverted.
  am.accounts[0].quota.unified7dFable = 0.999;
  am.accounts[0].quota.unified7dFableReset = Date.now() + 3600_000;
  const lines = captureLog(() => am.getActiveAccount(null, 'claude-fable-5'));
  const line = lines.find(l => l.includes('Diverting'));
  assert.ok(line, lines.join('\n'));
  assert.equal(line.includes('\n'), false, JSON.stringify(line));
});
