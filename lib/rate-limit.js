'use strict';

class RateLimiter {
  constructor({ limit, windowMs, name = 'rate-limit' }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.name = name;
    this.hits = new Map();
    this.cleanupTimer = setInterval(() => this.cleanup(), Math.max(windowMs, 60000));
    this.cleanupTimer.unref?.();
  }

  consume(key, amount = 1) {
    const now = Date.now();
    let entry = this.hits.get(key);

    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + this.windowMs };
      this.hits.set(key, entry);
    }

    entry.count += amount;
    const allowed = entry.count <= this.limit;
    return {
      allowed,
      limit: this.limit,
      remaining: Math.max(0, this.limit - entry.count),
      resetAt: entry.resetAt,
      retryAfterMs: allowed ? 0 : Math.max(0, entry.resetAt - now),
    };
  }

  reset(key) {
    this.hits.delete(key);
  }

  cleanup() {
    const now = Date.now();
    for (const [key, entry] of this.hits) {
      if (entry.resetAt <= now) this.hits.delete(key);
    }
  }

  stop() {
    clearInterval(this.cleanupTimer);
  }

  get size() {
    return this.hits.size;
  }
}

function applyRateLimitHeaders(res, result) {
  res.set('RateLimit-Limit', String(result.limit));
  res.set('RateLimit-Remaining', String(result.remaining));
  res.set('RateLimit-Reset', String(Math.ceil(result.resetAt / 1000)));
}

function expressRateLimit(limiter, options = {}) {
  const {
    message = 'Too many requests. Please try again shortly.',
    keyGenerator = (req) => req.ip || req.socket.remoteAddress || 'unknown',
    skip = () => false,
  } = options;

  return function rateLimitMiddleware(req, res, next) {
    if (skip(req)) return next();
    const result = limiter.consume(keyGenerator(req));
    applyRateLimitHeaders(res, result);
    if (result.allowed) return next();

    res.set('Retry-After', String(Math.ceil(result.retryAfterMs / 1000)));
    res.status(429).json({
      error: 'rate_limited',
      message,
    });
  };
}

function getRequestIp(req) {
  if (!req) return 'unknown';
  if (req.ip) return req.ip;
  if (req.socket && req.socket.remoteAddress) return req.socket.remoteAddress;
  return 'unknown';
}

module.exports = { RateLimiter, expressRateLimit, getRequestIp };
