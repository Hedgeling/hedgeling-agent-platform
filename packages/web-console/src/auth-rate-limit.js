import crypto from "node:crypto";

const buckets = new Map();
let requestsSinceCleanup = 0;

function cleanup(now) {
  requestsSinceCleanup += 1;
  if (requestsSinceCleanup < 500) return;
  requestsSinceCleanup = 0;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

function requestBucketKey(key, req, identity) {
  const address = req.ip || req.socket?.remoteAddress || "unknown";
  const identityValue = typeof identity === "function"
    ? String(identity(req) || "").trim().toLowerCase()
    : "";
  if (!identityValue) return `${key}:${address}`;
  const identityDigest = crypto.createHash("sha256").update(identityValue).digest("hex");
  return `${key}:${address}:${identityDigest}`;
}

function responseFailed(statusCode) {
  return statusCode >= 400 && statusCode < 500 && statusCode !== 429;
}

export function authRateLimit({
  key,
  limit,
  windowMs = 15 * 60 * 1000,
  countFailuresOnly = false,
  identity,
  headers = true,
}) {
  return (req, res, next) => {
    const now = Date.now();
    cleanup(now);
    const bucketKey = requestBucketKey(key, req, identity);
    let bucket = buckets.get(bucketKey);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(bucketKey, bucket);
    }
    if (!countFailuresOnly) bucket.count += 1;
    const blocked = countFailuresOnly ? bucket.count >= limit : bucket.count > limit;
    if (headers) {
      res.set("RateLimit-Limit", String(limit));
      res.set("RateLimit-Remaining", String(Math.max(0, limit - bucket.count)));
      res.set("RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));
    }
    if (blocked) {
      res.set("Retry-After", String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
      return res.status(429).json({ error: "Too many authentication attempts. Try again later." });
    }
    if (countFailuresOnly) {
      res.once("finish", () => {
        if (responseFailed(res.statusCode)) {
          bucket.count += 1;
        } else if (res.statusCode < 400) {
          buckets.delete(bucketKey);
        }
      });
    }
    return next();
  };
}

export function resetAuthRateLimitsForTests() {
  buckets.clear();
  requestsSinceCleanup = 0;
}
