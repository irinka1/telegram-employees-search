function createRateLimiter({ windowMs, maxRequests, banDurationMs }) {
  const buckets = new Map();

  function getBucket(key) {
    const now = Date.now();
    const existing = buckets.get(key);

    if (!existing) {
      const created = { hits: [], bannedUntil: 0 };
      buckets.set(key, created);
      return created;
    }

    if (existing.bannedUntil && existing.bannedUntil <= now) {
      existing.bannedUntil = 0;
    }

    existing.hits = existing.hits.filter((timestamp) => now - timestamp <= windowMs);
    return existing;
  }

  function check(key) {
    const bucket = getBucket(key);
    const now = Date.now();

    if (bucket.bannedUntil && bucket.bannedUntil > now) {
      return { allowed: false, banned: true };
    }

    bucket.hits.push(now);

    if (bucket.hits.length > maxRequests) {
      bucket.bannedUntil = now + banDurationMs;
      bucket.hits = [];
      return { allowed: false, banned: true };
    }

    return { allowed: true, banned: false };
  }

  return { check };
}

module.exports = {
  createRateLimiter
};