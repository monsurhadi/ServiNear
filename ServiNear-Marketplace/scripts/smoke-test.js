"use strict";
// End-to-end smoke test: boots the server on a throwaway database and checks the security-critical paths.
const { spawn } = require("node:child_process");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const PORT = 5099, B = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sn-smoke-"));
const server = spawn(process.execPath, ["server.js"], { cwd: path.join(__dirname, ".."), stdio: "ignore",
  env: { ...process.env, PORT, DATA_DIR: dir, NODE_ENV: "development", GOOGLE_AUTH_MOCK: "1", SEED_DEMO_DATA: "true" } });
let failed = 0;
const ok = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); if (!cond) failed++; };
const j = (p, o = {}, cookie) => fetch(B + p, { ...o, headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) } });
const cookieOf = (r) => (r.headers.get("set-cookie") || "").split(";")[0];

(async () => {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(B + "/api/health")).ok) break; } catch {} await new Promise((r) => setTimeout(r, 500)); }
  ok("health endpoint", (await j("/api/health")).ok);
  ok("admin API rejects anonymous", (await j("/api/admin/overview")).status === 401);
  const login = await j("/api/auth/login", { method: "POST", body: JSON.stringify({ email: "admin@servinear.local", password: "ServiNear123!" }) });
  const admin = cookieOf(login); ok("admin can sign in (dev seed)", login.ok && admin.startsWith("servinear_session="));
  const users = await (await j("/api/admin/users", {}, admin)).json();
  ok("admin users list returns default page size", users.rows.length === Math.min(users.total, 25));
  ok("admin overview works", (await j("/api/admin/overview", {}, admin)).ok);
  const g = await j("/api/auth/google", { method: "POST", body: JSON.stringify({ credential: "mock:smoke@example.com:Smoke" }) });
  ok("google sign-in creates account (mock verifier)", g.status === 201);
  ok("google sign-in cannot log into admin", (await j("/api/auth/google", { method: "POST", body: JSON.stringify({ credential: "mock:admin@servinear.local:x" }) })).status === 403);
  ok("unsigned google credential is rejected", [401, 503].includes((await j("/api/auth/google", { method: "POST", body: JSON.stringify({ credential: "a.b.c" }) })).status));
  const sus = await j(`/api/admin/users/${(await g.json()).user.id}`, { method: "PATCH", body: JSON.stringify({ status: "suspended" }) }, admin);
  ok("admin can suspend a user", sus.ok);
  ok("suspended session is rejected", (await (await j("/api/bootstrap", {}, cookieOf(g))).json()).user === null);
  ok("admin cannot demote self", (await j("/api/admin/users/1", { method: "PATCH", body: JSON.stringify({ role: "customer" }) }, admin)).status === 400);
  let limited = false;
  for (let i = 0; i < 12; i++) if ((await j("/api/auth/login", { method: "POST", body: JSON.stringify({ email: "nobody@x.com", password: "bad" }) })).status === 429) limited = true;
  ok("login brute-force is rate limited", limited);
  const hdr = (await fetch(B + "/")).headers;
  ok("security headers present", hdr.get("x-content-type-options") === "nosniff" && /frame-ancestors 'none'/.test(hdr.get("content-security-policy") || ""));
})().catch((e) => { console.error(e); failed++; }).finally(() => {
  server.kill(); fs.rmSync(dir, { recursive: true, force: true });
  console.log(failed ? `\n${failed} check(s) failed` : "\nAll checks passed"); process.exit(failed ? 1 : 0);
});
