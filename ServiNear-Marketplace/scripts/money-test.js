"use strict";
// Verifies phone OTP, wallet top-ups, escrow funding/release, payouts and admin controls end to end.
const { spawn } = require("node:child_process");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const PORT = 5097, B = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sn-money-"));
const server = spawn(process.execPath, ["server.js"], { cwd: path.join(__dirname, ".."), stdio: "ignore",
  env: { ...process.env, PORT, DATA_DIR: dir, NODE_ENV: "development", SEED_DEMO_DATA: "false", REQUIRE_PHONE_VERIFIED: "1", OTP_COOLDOWN_MS: "0", PAYMENT_PROVIDER: "mock", SMS_PROVIDER: "console", ADMIN_EMAIL: "root@example.com", ADMIN_PASSWORD: "a-very-long-pass-123" } });
let failed = 0;
const ok = (name, cond, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  -> " + extra}`); if (!cond) failed++; };
class Client {
  constructor() { this.cookie = ""; }
  async call(method, p, body, raw) {
    const r = await fetch(B + p, { method, redirect: "manual", headers: { ...(raw ? { "Content-Type": "application/x-www-form-urlencoded" } : { "Content-Type": "application/json" }), ...(this.cookie ? { cookie: this.cookie } : {}) },
      body: body === undefined ? undefined : raw ? new URLSearchParams(body).toString() : JSON.stringify(body) });
    const sc = r.headers.get("set-cookie"); if (sc) this.cookie = sc.split(";")[0];
    let json = {}; const ct = r.headers.get("content-type") || ""; if (ct.includes("json")) json = await r.json().catch(() => ({}));
    return { status: r.status, json, headers: r.headers };
  }
}
let n = 0;
async function newUser(role, phone, verify = true) {
  const c = new Client(); n++;
  const reg = await c.call("POST", "/api/auth/register", { first_name: role, surname: "T" + n, email: `${role}${n}@example.com`, password: "Passw0rd!long", role,
    gender: "male", city: "Dhaka", occupation: "tester", phone, area: "Dhanmondi", address: "House 1, Road 2", category: role === "worker" ? "Electrical" : undefined, rate: role === "worker" ? 500 : undefined, bio: "Experienced tester for money flows." });
  if (reg.status !== 201) throw new Error("register failed: " + JSON.stringify(reg.json));
  c.id = reg.json.user.id;
  if (verify) { const r = await c.call("POST", "/api/phone/request", { phone }); await c.call("POST", "/api/phone/verify", { code: r.json.dev_code }); }
  return c;
}
async function topUp(c, amount) {
  const made = await c.call("POST", "/api/payments/create", { amount });
  const t = made.json.tran_id;
  const page = await fetch(made.json.redirect_url); const html = await page.text();
  await fetch(`${B}/api/payments/mock/pay`, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `tran_id=${t}&state=paid` });
  return { t, made, checkoutOk: page.ok && html.includes("Pay now") };
}
const wallet = async (c) => (await c.call("GET", "/api/wallet")).json.wallet;

(async () => {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(B + "/api/health")).ok) break; } catch {} await new Promise((r) => setTimeout(r, 400)); }
  const cust = await newUser("customer", "01711111111", false);
  console.log("\n-- Phone verification");
  ok("invalid number rejected", (await cust.call("POST", "/api/phone/request", { phone: "12345" })).status === 400);
  ok("unverified customer is blocked from paying", (await cust.call("POST", "/api/payments/create", { amount: 500 })).json.code === "phone_verification_required");
  const r1 = await cust.call("POST", "/api/phone/request", { phone: "+88 01711-111111" });
  ok("OTP request accepted, number masked", r1.status === 200 && /^017\*+111$/.test(r1.json.phone) && /^\d{6}$/.test(r1.json.dev_code), JSON.stringify(r1.json));
  const wrong = String((Number(r1.json.dev_code) + 1) % 1000000).padStart(6, "0");
  const w1 = await cust.call("POST", "/api/phone/verify", { code: wrong });
  ok("wrong code rejected with attempts left", w1.status === 400 && /attempt/.test(w1.json.message), JSON.stringify(w1.json));
  let locked = false; for (let i = 0; i < 5; i++) { const x = await cust.call("POST", "/api/phone/verify", { code: wrong }); if (x.status === 429) locked = true; }
  ok("code locks after repeated wrong guesses", locked);
  ok("locked code no longer works even if correct", (await cust.call("POST", "/api/phone/verify", { code: r1.json.dev_code })).status >= 400);
  const r2 = await cust.call("POST", "/api/phone/request", { phone: "01711111111" });
  const v = await cust.call("POST", "/api/phone/verify", { code: r2.json.dev_code });
  ok("correct code verifies the number", v.status === 200 && v.json.user.phone_verified === 1, JSON.stringify(v.json));
  ok("used code cannot be replayed", (await cust.call("POST", "/api/phone/verify", { code: r2.json.dev_code })).status === 400);
  const other = await newUser("customer", "01822222222", false);
  const r3 = await other.call("POST", "/api/phone/request", { phone: "01711111111" });
  ok("a verified number cannot be claimed by another account", r3.status === 409, JSON.stringify(r3.json));

  console.log("\n-- Wallet top-up");
  ok("amount below minimum rejected", (await cust.call("POST", "/api/payments/create", { amount: 10 })).status === 400);
  ok("fractional amount rejected", (await cust.call("POST", "/api/payments/create", { amount: 100.5 })).status === 400);
  const pay = await topUp(cust, 5000);
  ok("hosted checkout page served", pay.checkoutOk);
  ok("successful payment credits the wallet", (await wallet(cust)).balance === 5000, JSON.stringify(await wallet(cust)));
  await fetch(`${B}/api/payments/mock/ipn`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `tran_id=${pay.t}&val_id=whatever` });
  const sc = (await cust.call("GET", "/api/payments/status?tran_id=" + pay.t)).json;
  ok("replayed IPN does not double-credit", (await wallet(cust)).balance === 5000 && sc.status === "paid");
  const forged = (await cust.call("POST", "/api/payments/create", { amount: 900 })).json.tran_id;
  const fr = await fetch(`${B}/api/payments/mock/success`, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "https://evil.example" }, body: `tran_id=${forged}&val_id=FORGED&status=VALID&amount=900` });
  ok("forged success callback is NOT trusted", (await wallet(cust)).balance === 5000 && /payment=failed/.test(fr.headers.get("location") || ""), fr.headers.get("location"));
  const cancelled = (await cust.call("POST", "/api/payments/create", { amount: 700 })).json.tran_id;
  await fetch(`${B}/api/payments/mock/pay`, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `tran_id=${cancelled}&state=cancelled` });
  ok("cancelled payment adds nothing", (await wallet(cust)).balance === 5000);
  ok("other users cannot read my payment", (await other.call("GET", "/api/payments/status?tran_id=" + pay.t)).status === 404);

  console.log("\n-- Escrow");
  const worker = await newUser("worker", "01933333333");
  const poor = await newUser("customer", "01644444444");
  const mkJob = (c) => c.call("POST", "/api/jobs", { title: "Fix my ceiling fan wiring", category: "Electrical", details: "Fan stopped working after a power cut, needs rewiring.", area: "Dhanmondi", budget: 1500, contact_phone: "01711111111", exact_address: "House 1, Road 2, Dhanmondi" });
  const job = (await mkJob(cust)).json.id, poorJob = (await mkJob(poor)).json.id;
  const bid = (await worker.call("POST", "/api/offers", { job_id: job, price: 1500, message: "I can fix this today." })).json.id;
  const poorBid = (await worker.call("POST", "/api/offers", { job_id: poorJob, price: 1500, message: "I can fix this today." })).json.id;
  const noFunds = await poor.call("POST", `/api/offers/${poorBid}/accept`);
  ok("accepting without funds is refused (402) with the shortfall", noFunds.status === 402 && noFunds.json.shortfall === 1500 && noFunds.json.code === "insufficient_funds", JSON.stringify(noFunds.json));
  ok("failed accept leaves the task open", (await poor.call("GET", "/api/bootstrap")).json.jobs?.find?.((j) => j.id === poorJob)?.status !== "accepted");
  const acc = await cust.call("POST", `/api/offers/${bid}/accept`);
  const w = await wallet(cust);
  ok("accepting debits the customer and locks escrow", acc.status === 200 && w.balance === 3500 && w.locked_escrow === 1500, JSON.stringify([acc.json, w]));
  const otp = acc.json.escrow.release_otp;
  ok("release code is 6 digits", /^\d{6}$/.test(otp));
  ok("a stranger cannot release someone else's escrow", (await other.call("POST", `/api/jobs/${job}/release-escrow`, { otp })).status === 403);
  let blocked = false; const wrongOtp = otp === "000000" ? "111111" : "000000";
  for (let i = 0; i < 7; i++) if ((await worker.call("POST", `/api/jobs/${job}/release-escrow`, { otp: wrongOtp })).status === 429) blocked = true;
  ok("guessing the release code is rate-limited", blocked);
  const adm = new Client(); await adm.call("POST", "/api/auth/login", { email: "root@example.com", password: "a-very-long-pass-123" });
  const ov = await adm.call("GET", "/api/admin/payments");
  const esc = ov.json.escrows.find((e) => e.job_id === job);
  ok("admin sees the held escrow", esc && esc.status === "held");
  const noNote = await adm.call("POST", `/api/admin/escrows/${esc.id}/release`, { note: "" });
  ok("admin must justify an escrow decision", noNote.status === 400);
  const rel = await adm.call("POST", `/api/admin/escrows/${esc.id}/release`, { note: "Work confirmed by both parties" });
  const ww = await wallet(worker);
  ok("admin release pays the provider and unlocks the customer", rel.status === 200 && ww.balance === 1500 && (await wallet(cust)).locked_escrow === 0, JSON.stringify([rel.json, ww]));
  ok("escrow cannot be settled twice", (await adm.call("POST", `/api/admin/escrows/${esc.id}/refund`, { note: "second attempt" })).status === 409);

  console.log("\n-- Payouts");
  const unverifiedW = await newUser("worker", "01555555555", false);
  ok("payout requires a verified phone", (await unverifiedW.call("POST", "/api/wallet/withdraw", { amount: 200, method: "bKash", phone: "01555555555" })).json.code === "phone_verification_required");
  ok("payout only to the verified number", (await worker.call("POST", "/api/wallet/withdraw", { amount: 500, method: "bKash", phone: "01999999999" })).status === 400);
  ok("cannot withdraw more than the balance", (await worker.call("POST", "/api/wallet/withdraw", { amount: 99999, method: "bKash", phone: "01933333333" })).status === 400);
  const wd = await worker.call("POST", "/api/wallet/withdraw", { amount: 600, method: "bKash", phone: "01933333333" });
  ok("payout request queues and reserves the money", wd.status === 200 && wd.json.status === "pending" && (await wallet(worker)).balance === 900, JSON.stringify(wd.json));
  const po = (await adm.call("GET", "/api/admin/payments")).json.payouts.find((p) => p.id === wd.json.payout_id);
  ok("admin sees the pending payout with the verified number", po && po.status === "pending" && po.account === "01933333333");
  ok("admin must enter the MFS reference to mark paid", (await adm.call("POST", `/api/admin/payouts/${po.id}/pay`, {})).status === 400);
  ok("admin marks payout paid", (await adm.call("POST", `/api/admin/payouts/${po.id}/pay`, { reference: "BKX123456789" })).status === 200);
  const wd2 = await worker.call("POST", "/api/wallet/withdraw", { amount: 300, method: "Nagad", phone: "01933333333" });
  ok("second payout request reserves its amount", wd2.status === 200 && (await wallet(worker)).balance === 600, JSON.stringify(wd2.json));
  await adm.call("POST", `/api/admin/payouts/${wd2.json.payout_id}/reject`, { note: "Name mismatch" });
  ok("rejected payout returns the money to the wallet", (await wallet(worker)).balance === 900, JSON.stringify(await wallet(worker)));
  ok("a payout cannot be processed twice", (await adm.call("POST", `/api/admin/payouts/${po.id}/reject`, {})).status === 409);

  console.log("\n-- Phone change");
  const ch = await cust.call("PATCH", "/api/user/settings", { phone: "01788888888" });
  const me = (await cust.call("GET", "/api/bootstrap")).json.user;
  ok("changing the number clears verification", me.phone_verified === 0, JSON.stringify([ch.status, me.phone_verified]));
  ok("audit log records money decisions", (await adm.call("GET", "/api/admin/audit?limit=50")).json.some((a) => a.action === "escrow.release") );
})().catch((e) => { console.error(e); failed++; }).finally(() => {
  server.kill(); fs.rmSync(dir, { recursive: true, force: true });
  console.log(failed ? `\n${failed} check(s) failed` : "\nAll money/phone checks passed"); process.exit(failed ? 1 : 0);
});
