'use strict';

const crypto = require('node:crypto');

const COOKIE_NAME = 'cmdlan_session';

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest();
}

// Hashing both sides first gives equal-length buffers, so the comparison
// leaks neither the password's content nor its length through timing.
function passwordMatches(candidate, expected) {
  if (typeof candidate !== 'string') return false;
  return crypto.timingSafeEqual(sha256(candidate), sha256(expected));
}

function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    cookies[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return cookies;
}

class SessionStore {
  constructor({ ttlMs = 12 * 60 * 60 * 1000, now = Date.now } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.expiries = new Map();
  }

  create() {
    const token = crypto.randomBytes(32).toString('hex');
    this.expiries.set(token, this.now() + this.ttlMs);
    return token;
  }

  has(token) {
    const expiry = this.expiries.get(token);
    if (expiry === undefined) return false;
    if (expiry <= this.now()) {
      this.expiries.delete(token);
      return false;
    }
    return true;
  }

  delete(token) {
    this.expiries.delete(token);
  }
}

// Locks an IP out for `lockoutMs` once it reaches `maxFailures` wrong passwords.
class LoginLimiter {
  constructor({ maxFailures = 5, lockoutMs = 5 * 60 * 1000, now = Date.now } = {}) {
    this.maxFailures = maxFailures;
    this.lockoutMs = lockoutMs;
    this.now = now;
    this.entries = new Map();
  }

  // Seconds until this IP may try again; 0 when it isn't locked out.
  retryAfter(ip) {
    const entry = this.entries.get(ip);
    if (!entry || !entry.lockedUntil) return 0;
    const remaining = entry.lockedUntil - this.now();
    if (remaining <= 0) {
      this.entries.delete(ip);
      return 0;
    }
    return Math.ceil(remaining / 1000);
  }

  recordFailure(ip) {
    this.prune();
    const entry = this.entries.get(ip) || { failures: 0, lockedUntil: 0, lastFailure: 0 };
    entry.failures += 1;
    entry.lastFailure = this.now();
    if (entry.failures >= this.maxFailures) entry.lockedUntil = this.now() + this.lockoutMs;
    this.entries.set(ip, entry);
  }

  reset(ip) {
    this.entries.delete(ip);
  }

  // Forget IPs whose lockout ended or whose last failure is old, so the map can't grow forever.
  prune() {
    const now = this.now();
    for (const [ip, entry] of this.entries) {
      const stale = entry.lockedUntil ? entry.lockedUntil <= now : entry.lastFailure <= now - this.lockoutMs;
      if (stale) this.entries.delete(ip);
    }
  }
}

module.exports = { COOKIE_NAME, passwordMatches, parseCookies, SessionStore, LoginLimiter };
