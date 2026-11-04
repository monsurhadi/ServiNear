"use strict";
// Verifies Google Sign-In and Firebase Auth ID tokens (RS256 JWTs) against published keys.
const crypto = require("node:crypto");

const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const FIREBASE_JWKS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

const GOOGLE_ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);

const caches = {
  google: { keys: [], expires: 0 },
  firebase: { keys: [], expires: 0 }
};

function b64urlJson(part) {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

async function getKeys(type) {
  const cache = caches[type];
  if (cache.expires > Date.now() && cache.keys.length) return cache.keys;
  const url = type === "firebase" ? FIREBASE_JWKS_URL : GOOGLE_JWKS_URL;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Could not load ${type} signing keys.`);
  const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get("cache-control") || "")?.[1] || 3600);
  const body = await res.json();
  cache.keys = body.keys || [];
  cache.expires = Date.now() + maxAge * 1000;
  return cache.keys;
}

async function verifyGoogleIdToken(idToken, clientId) {
  const mockOn = process.env.NODE_ENV !== "production" && process.env.GOOGLE_AUTH_MOCK === "1";
  if (mockOn && String(idToken).startsWith("mock:")) {
    const [, email, name] = String(idToken).split(":");
    return { sub: "mock-" + crypto.createHash("sha256").update(email).digest("hex").slice(0, 16), email: email.toLowerCase(), name: name || "Mock User", picture: null };
  }

  const parts = String(idToken || "").split(".");
  if (parts.length !== 3) throw Object.assign(new Error("Invalid authentication credential."), { status: 401 });

  let header, claims;
  try {
    header = b64urlJson(parts[0]);
    claims = b64urlJson(parts[1]);
  } catch {
    throw Object.assign(new Error("Invalid token format."), { status: 401 });
  }

  if (header.alg !== "RS256") throw Object.assign(new Error("Invalid credential signature algorithm."), { status: 401 });

  const now = Math.floor(Date.now() / 1000);
  const isFirebase = typeof claims.iss === "string" && claims.iss.startsWith("https://securetoken.google.com/");
  const isGoogle = GOOGLE_ISSUERS.has(claims.iss);

  if (!isFirebase && !isGoogle) {
    throw Object.assign(new Error("Unrecognized token issuer."), { status: 401 });
  }

  const keyType = isFirebase ? "firebase" : "google";
  const keys = await getKeys(keyType);
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw Object.assign(new Error(`Unknown ${keyType} signing key.`), { status: 401 });

  const ok = crypto.verify(
    "RSA-SHA256",
    Buffer.from(parts[0] + "." + parts[1]),
    crypto.createPublicKey({ key: jwk, format: "jwk" }),
    Buffer.from(parts[2], "base64url")
  );

  if (!ok) {
    throw Object.assign(new Error("Signature verification failed."), { status: 401 });
  }

  if (!(claims.exp > now)) {
    throw Object.assign(new Error("Credential has expired."), { status: 401 });
  }

  if (!claims.sub || !claims.email) {
    throw Object.assign(new Error("Credential missing identity claims."), { status: 401 });
  }

  if (isFirebase) {
    const tokenProjectId = claims.iss.slice("https://securetoken.google.com/".length);
    const configuredProjectId = process.env.FIREBASE_PROJECT_ID;
    if (configuredProjectId && claims.aud !== configuredProjectId) {
      throw Object.assign(new Error("Firebase project mismatch."), { status: 401 });
    }
    if (claims.aud !== tokenProjectId) {
      throw Object.assign(new Error("Invalid Firebase audience."), { status: 401 });
    }
  } else {
    const effectiveClientId = clientId || process.env.GOOGLE_CLIENT_ID;
    if (effectiveClientId && claims.aud !== effectiveClientId) {
      throw Object.assign(new Error("Google client ID mismatch."), { status: 401 });
    }
  }

  return {
    sub: String(claims.sub),
    email: String(claims.email).toLowerCase(),
    name: claims.name || claims.email.split("@")[0],
    picture: claims.picture || null,
    provider: isFirebase ? "firebase" : "google"
  };
}

module.exports = { verifyGoogleIdToken };
