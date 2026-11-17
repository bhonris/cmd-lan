'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { passwordMatches, parseCookies, SessionStore, LoginLimiter } = require('../src/auth');

function fakeClock(start = 1_000_000) {
  const clock = { time: start, now: () => clock.time };
  return clock;
}

test('passwordMatches accepts only the exact password', () => {
  assert.equal(passwordMatches('hunter2-hunter2', 'hunter2-hunter2'), true);
  assert.equal(passwordMatches('hunter2', 'hunter2-hunter2'), false);
  assert.equal(passwordMatches('', 'hunter2-hunter2'), false);
  assert.equal(passwordMatches(undefined, 'hunter2-hunter2'), false);
  assert.equal(passwordMatches(12345678, '12345678'), false);
});

test('parseCookies reads name=value pairs and skips junk', () => {
  assert.deepEqual(parseCookies('a=1; b=two=2; junk; c = 3 '), { a: '1', b: 'two=2', c: '3' });
  assert.deepEqual(parseCookies(undefined), {});
  assert.deepEqual(parseCookies(''), {});
});

test('SessionStore issues unique tokens that expire and can be deleted', () => {
  const clock = fakeClock();
  const store = new SessionStore({ ttlMs: 1000, now: clock.now });
  const a = store.create();
  const b = store.create();
  assert.notEqual(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(store.has(a), true);
  assert.equal(store.has('nope'), false);

  store.delete(b);
  assert.equal(store.has(b), false);

  clock.time += 999;
  assert.equal(store.has(a), true);
  clock.time += 1;
  assert.equal(store.has(a), false);
  assert.equal(store.expiries.size, 0);
});

test('LoginLimiter locks an IP out after repeated failures, then lets it back in', () => {
  const clock = fakeClock();
  const limiter = new LoginLimiter({ maxFailures: 3, lockoutMs: 10_000, now: clock.now });

  limiter.recordFailure('10.0.0.5');
  limiter.recordFailure('10.0.0.5');
  assert.equal(limiter.retryAfter('10.0.0.5'), 0);
  limiter.recordFailure('10.0.0.5');
  assert.equal(limiter.retryAfter('10.0.0.5'), 10);
  assert.equal(limiter.retryAfter('10.0.0.6'), 0, 'other IPs are unaffected');

  clock.time += 9_500;
  assert.equal(limiter.retryAfter('10.0.0.5'), 1);
  clock.time += 500;
  assert.equal(limiter.retryAfter('10.0.0.5'), 0);
  assert.equal(limiter.entries.size, 0);
});

test('LoginLimiter.reset clears the failure count', () => {
  const limiter = new LoginLimiter({ maxFailures: 2 });
  limiter.recordFailure('ip');
  limiter.reset('ip');
  limiter.recordFailure('ip');
  assert.equal(limiter.retryAfter('ip'), 0);
});

test('LoginLimiter forgets stale entries', () => {
  const clock = fakeClock();
  const limiter = new LoginLimiter({ maxFailures: 2, lockoutMs: 10_000, now: clock.now });
  limiter.recordFailure('one-old-failure');
  limiter.recordFailure('locked');
  limiter.recordFailure('locked');
  clock.time += 5_000;
  limiter.recordFailure('recent');
  clock.time += 5_000;

  limiter.recordFailure('trigger');
  assert.deepEqual([...limiter.entries.keys()].sort(), ['recent', 'trigger']);
});
