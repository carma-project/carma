// In-memory token-bucket rate limiter, keyed per subject (or client address).
// Suitable for a single instance; front multiple replicas with a shared limiter
// (e.g. Redis) if you scale horizontally.

export class RateLimiter {
  constructor({ rps = 20, burst = 40, now = () => Date.now() } = {}) {
    this.rps = rps;
    this.burst = burst;
    this.now = now;
    this.buckets = new Map();
    this.lastSweep = now();
  }

  // Returns { allowed, retryAfter } where retryAfter is seconds until a token
  // is available (only meaningful when !allowed).
  take(key, cost = 1) {
    const t = this.now();
    this._maybeSweep(t);
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.burst, last: t };
      this.buckets.set(key, b);
    }
    const elapsedSec = (t - b.last) / 1000;
    b.tokens = Math.min(this.burst, b.tokens + elapsedSec * this.rps);
    b.last = t;
    if (b.tokens >= cost) {
      b.tokens -= cost;
      return { allowed: true, retryAfter: 0 };
    }
    const deficit = cost - b.tokens;
    return { allowed: false, retryAfter: Math.ceil(deficit / this.rps) };
  }

  // Drop buckets that have fully refilled and gone idle, to bound memory.
  _maybeSweep(t) {
    if (t - this.lastSweep < 60_000) return;
    this.lastSweep = t;
    for (const [key, b] of this.buckets) {
      const elapsedSec = (t - b.last) / 1000;
      if (Math.min(this.burst, b.tokens + elapsedSec * this.rps) >= this.burst) {
        this.buckets.delete(key);
      }
    }
  }
}
