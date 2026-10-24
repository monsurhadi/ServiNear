"use strict";
// Verifies Google Sign-In ID tokens (RS256 JWTs) against Google's published keys.
const crypto = require("node:crypto");

const JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);
let keyCache = { keys: [], expires: 0 };

function b64urlJson(part) {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

async function getKeys() {
  if (keyCache.expires > Date.now() && keyCache.keys.length) return keyCache.keys;
  const res = await fetch(JWKS_URL, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error("Could not load Google signing keys.");
  const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get("cache-control") || "")?.[1] || 3600);
  const body = await res.json();
  keyCache = { keys: body.keys || [], expires: Date.now() + maxAge * 1000 };
  return keyCache.keys;
}

async function verifyGoogleIdToken(idToken, clientId) {
  const mockOn = process.env.NODE_ENV !== "production" && process.env.GOOGLE_AUTH_MOCK === "1";
  if (mockOn && String(idToken).startsWith("mock:")) {
    const [, email, name] = String(idToken).split(":");
    return { sub: "mock-" + crypto.createHash("sha256").update(email).digest("hex").slice(0, 16), email, name: name || "Mock User", picture: null };
  }
  if (!clientId) throw Object.assign(new Error("Google sign-in is not configured on this server."), { status: 503 });
  const parts = String(idToken || "").split(".");
  if (parts.length !== 3) throw Object.assign(new Error("Invalid Google credential."), { status: 401 });
  const header = b64urlJson(parts[0]);
  const claims = b64urlJson(parts[1]);
  if (header.alg !== "RS256") throw Object.assign(new Error("Invalid Google credential."), { status: 401 });
  const jwk = (await getKeys()).find((k) => k.kid === header.kid);
  if (!jwk) throw Object.assign(new Error("Unknown Google signing key."), { status: 401 });
  const ok = crypto.verify("RSA-SHA256", Buffer.from(parts[0] + "." + parts[1]),
    crypto.createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(parts[2], "base64url"));
  const now = Math.floor(Date.now() / 1000);
  if (!ok || !ISSUERS.has(claims.iss) || claims.aud !== clientId || !(claims.exp > now) || claims.email_verified !== true || !claims.sub || !claims.email) {
    throw Object.assign(new Error("Google could not verify this sign-in."), { status: 401 });
  }
  return { sub: String(claims.sub), email: String(claims.email).toLowerCase(), name: claims.name || claims.email.split("@")[0], picture: claims.picture || null };
}

module.exports = { verifyGoogleIdToken };
