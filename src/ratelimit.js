// In-memory token bucket, keyed by client IP, for POST /login.
//
// Each key holds up to `capacity` tokens and regains them at
// capacity / window — so a burst of `capacity` attempts is allowed, then one
// more per (window / capacity). Memory is bounded: when the map grows past
// `maxKeys`, keys whose bucket has refilled completely (idle clients) are
// dropped first, then the oldest.
//
// Per-process only. One Fly machine serves the app, so that is the whole
// picture; the per-account lockout (src/accounts.js) is stored in the
// database and holds across restarts and machines.

export class TokenBucketLimiter {
  constructor({ capacity, windowSeconds, now = () => Date.now(), maxKeys = 10_000 }) {
    if (!(capacity > 0) || !(windowSeconds > 0)) throw new RangeError("capacity and windowSeconds must be positive");
    this.capacity = capacity;
    this.refillPerMs = capacity / (windowSeconds * 1000);
    this.now = now;
    this.maxKeys = maxKeys;
    this.buckets = new Map();
  }

  level(bucket, at) {
    return Math.min(this.capacity, bucket.tokens + (at - bucket.updated) * this.refillPerMs);
  }

  /** Spend one token for `key`. Returns { allowed, retryAfterSeconds }. */
  take(key) {
    const at = this.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, updated: at };
    const tokens = this.level(bucket, at);
    if (tokens < 1) {
      bucket.tokens = tokens;
      bucket.updated = at;
      this.buckets.set(key, bucket);
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((1 - tokens) / this.refillPerMs / 1000)) };
    }
    bucket.tokens = tokens - 1;
    bucket.updated = at;
    // Re-insert so Map order tracks recency for the eviction below.
    this.buckets.delete(key);
    this.buckets.set(key, bucket);
    if (this.buckets.size > this.maxKeys) this.prune(at);
    return { allowed: true, retryAfterSeconds: 0 };
  }

  prune(at) {
    for (const [key, bucket] of this.buckets) {
      if (this.level(bucket, at) >= this.capacity) this.buckets.delete(key);
    }
    for (const key of this.buckets.keys()) {
      if (this.buckets.size <= this.maxKeys) break;
      this.buckets.delete(key);
    }
  }
}
