const assert = require('node:assert/strict');
const test = require('node:test');

const { assertNodeVersionContract } = require('../../scripts/check-node-version');

test('authentication and SQLite dependencies support the pinned Node 20 CommonJS runtime', () => {
  assert.deepEqual(assertNodeVersionContract(), {
    expected: '20.20.2',
    actual: '20.20.2',
  });
  assert.equal(typeof require('express-session'), 'function');
  assert.equal(typeof require('express-rate-limit').rateLimit, 'function');
  assert.equal(typeof require('sqlite3').Database, 'function');
});

test('Node runtime contract rejects a different active version', () => {
  assert.throws(
    () => assertNodeVersionContract('24.16.0'),
    error => error.code === 'NODE_VERSION_MISMATCH' && /20\.20\.2/.test(error.message),
  );
});
