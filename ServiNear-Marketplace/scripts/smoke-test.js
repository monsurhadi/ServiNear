"use strict";
// End-to-end smoke test: boots the server on a throwaway database and checks the security-critical paths.
const { spawn } = require("node:child_process");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const PORT = 5099, B = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sn-smoke-"));
const ADMIN_EMAIL = "admin@servinear.test";
const ADMIN_PASSWORD = "AdminSecretPassword123!";

const server = spawn(process.execPath, ["server.js"], {
  cwd: path.join(__dirname, ".."),
  stdio: "ignore",
  env: {
    ...process.env,
    PORT,
    DATA_DIR: dir,
    NODE_ENV: "development",
    GOOGLE_AUTH_MOCK: "1",
    SEED_DEMO_DATA: "true",
    ADMIN_EMAIL,
    ADMIN_PASSWORD
  }
});

let failed = 0;
const ok = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); if (!cond) failed++; };
const j = (p, o = {}, cookie) => fetch(B + p, { ...o, headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) } });
const cookieOf = (r) => (r.headers.get("set-cookie") || "").split(";")[0];

(async () => {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(B + "/api/health")).ok) break; } catch {} await new Promise((r) => setTimeout(r, 500)); }
  ok("health endpoint", (await j("/api/health")).ok);
  ok("admin API rejects anonymous", (await j("/api/admin/overview")).status === 401);

  const login = await j("/api/auth/login", { method: "POST", body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }) });
  const admin = cookieOf(login);
  ok("admin can sign in (env admin)", login.ok && admin.startsWith("servinear_session="));

  const users = await (await j("/api/admin/users", {}, admin)).json();
  ok("admin users list returns default page size", users.rows.length === Math.min(users.total, 25));
  ok("admin overview works", (await j("/api/admin/overview", {}, admin)).ok);

  const g = await j("/api/auth/google", { method: "POST", body: JSON.stringify({ credential: "mock:smoke@example.com:Smoke" }) });
  ok("google sign-in creates account (mock verifier)", g.status === 201);

  // Stranger cannot become admin
  const stranger = await j("/api/auth/google", { method: "POST", body: JSON.stringify({ credential: "mock:stranger@example.com:Stranger" }) });
  ok("google sign-in stranger is regular user", stranger.status === 201 && (await stranger.json()).user.role === "customer");

  ok("unsigned google credential is rejected", [401, 503].includes((await j("/api/auth/google", { method: "POST", body: JSON.stringify({ credential: "a.b.c" }) })).status));

  const sus = await j(`/api/admin/users/${(await g.json()).user.id}`, { method: "PATCH", body: JSON.stringify({ status: "suspended" }) }, admin);
  ok("admin can suspend a user", sus.ok);
  ok("suspended session is rejected", (await (await j("/api/bootstrap", {}, cookieOf(g))).json()).user === null);

  const currentAdmin = (await (await j("/api/bootstrap", {}, admin)).json()).user;
  ok("admin cannot demote self", (await j(`/api/admin/users/${currentAdmin.id}`, { method: "PATCH", body: JSON.stringify({ role: "customer" }) }, admin)).status === 400);

  // change password
  const pw = await j("/api/auth/register", { method: "POST", body: JSON.stringify({ first_name: "Pat", surname: "Word", email: "pat@example.com", password: "OldPassw0rd!x", role: "customer", gender: "male", city: "Dhaka", occupation: "tester", phone: "01711111111", area: "Dhaka", address: "House 1, Road 2" }) });
  const sess1 = cookieOf(pw);
  const sess2 = cookieOf(await j("/api/auth/login", { method: "POST", body: JSON.stringify({ email: "pat@example.com", password: "OldPassw0rd!x" }) }));
  ok("change-password requires sign-in", (await j("/api/auth/change-password", { method: "POST", body: JSON.stringify({ current_password: "a", new_password: "NewPassw0rd!x" }) })).status === 401);
  ok("wrong current password is rejected", (await j("/api/auth/change-password", { method: "POST", body: JSON.stringify({ current_password: "nope-nope-1", new_password: "NewPassw0rd!x" }) }, sess1)).status === 400);
  ok("weak new password is rejected", (await j("/api/auth/change-password", { method: "POST", body: JSON.stringify({ current_password: "OldPassw0rd!x", new_password: "short" }) }, sess1)).status === 400);
  ok("correct current password changes it", (await j("/api/auth/change-password", { method: "POST", body: JSON.stringify({ current_password: "OldPassw0rd!x", new_password: "NewPassw0rd!x" }) }, sess1)).status === 200);
  ok("new password works and old one does not", (await j("/api/auth/login", { method: "POST", body: JSON.stringify({ email: "pat@example.com", password: "NewPassw0rd!x" }) })).status === 200 && (await j("/api/auth/login", { method: "POST", body: JSON.stringify({ email: "pat@example.com", password: "OldPassw0rd!x" }) })).status === 401);
  ok("other devices are signed out, this one stays in", (await (await j("/api/bootstrap", {}, sess2)).json()).user === null && (await (await j("/api/bootstrap", {}, sess1)).json()).user !== null);

  let limited = false;
  for (let i = 0; i < 12; i++) if ((await j("/api/auth/login", { method: "POST", body: JSON.stringify({ email: "nobody@x.com", password: "bad" }) })).status === 429) limited = true;
  ok("login brute-force is rate limited", limited);

  const hdr = (await fetch(B + "/")).headers;
  ok("security headers present", hdr.get("x-content-type-options") === "nosniff" && /frame-ancestors 'none'/.test(hdr.get("content-security-policy") || ""));
})().catch((e) => {
  console.error(e); failed++;
}).finally(() => {
  server.kill();
  setTimeout(() => {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  }, 300);
  console.log(failed ? `\n${failed} check(s) failed` : "\nAll checks passed");
  process.exit(failed ? 1 : 0);
});
