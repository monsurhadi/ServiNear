"use strict";
// Small in-memory sliding-window limiter. Fine for one instance; use Redis if you scale out.
const buckets = new Map();
function hit(key, limit, windowMs) {
  const now = Date.now();
  const arr = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  buckets.set(key, arr);
  return { allowed: arr.length <= limit, retryAfter: Math.ceil((windowMs - (now - arr[0])) / 1000) };
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets) if (!v.length || now - v[v.length - 1] > 3600000) buckets.delete(k);
}, 600000).unref();
function clientIp(req, trustProxy) {
  if (trustProxy) {
    const fwd = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress || "unknown";
}
module.exports = { hit, clientIp };
