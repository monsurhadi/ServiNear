"use strict";
// Phone verification: short-lived, single-use, hashed, rate-limited one-time codes.
const crypto = require("node:crypto");
const limiter = require("./ratelimit");
const { normalizeBdPhone, maskPhone } = require("./sms");

const TTL_MS = 5 * 60 * 1000, MAX_ATTEMPTS = 5;
const COOLDOWN_MS = process.env.NODE_ENV === "production" ? 60 * 1000 : Number(process.env.OTP_COOLDOWN_MS ?? 60000);

function createOtpService({ db, sms, fail }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_secrets (name TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS phone_otps (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, phone TEXT NOT NULL, code_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, consumed INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, ip TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_otp_user ON phone_otps(user_id, created_at DESC);
  `);
  for (const [c, d] of [["phone_verified", "INTEGER NOT NULL DEFAULT 0"], ["phone_e164", "TEXT"], ["phone_verified_at", "TEXT"]]) {
    if (!db.prepare("PRAGMA table_info(users)").all().some((x) => x.name === c)) db.exec(`ALTER TABLE users ADD COLUMN ${c} ${d}`);
  }
  // One verified account per phone number.
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone_verified ON users(phone_e164) WHERE phone_verified=1");

  function secret() {
    const row = db.prepare("SELECT value FROM app_secrets WHERE name='otp'").get();
    if (row) return row.value;
    const v = crypto.randomBytes(32).toString("hex");
    db.prepare("INSERT OR IGNORE INTO app_secrets(name,value) VALUES('otp',?)").run(v);
    return db.prepare("SELECT value FROM app_secrets WHERE name='otp'").get().value;
  }
  const hmac = (userId, phone, code) => crypto.createHmac("sha256", secret()).update(`${userId}:${phone}:${code}`).digest("hex");

  async function request(user, rawPhone, ip) {
    if (!sms.configured) fail(503, "Phone verification is not available right now.");
    const p = normalizeBdPhone(rawPhone);
    if (!p) fail(400, "Enter a valid Bangladeshi mobile number, for example 01712345678.");
    if (user.phone_verified && user.phone_e164 === p.e164) return { ok: true, already_verified: true, phone: maskPhone(p.local) };
    if (db.prepare("SELECT 1 FROM users WHERE phone_e164=? AND phone_verified=1 AND id!=?").get(p.e164, user.id)) fail(409, "That number is already verified on another account.");

    const last = db.prepare("SELECT created_at FROM phone_otps WHERE user_id=? ORDER BY created_at DESC LIMIT 1").get(user.id);
    if (last && Date.now() - last.created_at < COOLDOWN_MS) fail(429, `Please wait ${Math.ceil((COOLDOWN_MS - (Date.now() - last.created_at)) / 1000)} seconds before requesting another code.`, { retry_after: Math.ceil((COOLDOWN_MS - (Date.now() - last.created_at)) / 1000) });
    for (const [key, lim] of [[`otp:u:${user.id}`, 5], [`otp:p:${p.e164}`, 5], [`otp:ip:${ip}`, 10]]) {
      if (!limiter.hit(key, lim, 3600 * 1000).allowed) fail(429, "Too many verification requests. Please try again later.");
    }

    const code = String(crypto.randomInt(100000, 1000000));
    db.prepare("UPDATE phone_otps SET consumed=1 WHERE user_id=? AND consumed=0").run(user.id);
    const id = Number(db.prepare("INSERT INTO phone_otps(user_id,phone,code_hash,expires_at,created_at,ip) VALUES(?,?,?,?,?,?)")
      .run(user.id, p.e164, hmac(user.id, p.e164, code), Date.now() + TTL_MS, Date.now(), ip || null).lastInsertRowid);
    try { await sms.send(p, code); }
    catch (e) { db.prepare("DELETE FROM phone_otps WHERE id=?").run(id); console.error("SMS send failed:", e.message); fail(502, "We couldn't send the SMS. Please try again in a moment."); }
    return { ok: true, phone: maskPhone(p.local), expires_in: TTL_MS / 1000, resend_in: COOLDOWN_MS / 1000, ...(sms.exposesDevCode ? { dev_code: code } : {}) };
  }

  function verify(user, rawCode) {
    const code = String(rawCode || "").trim();
    if (!/^\d{6}$/.test(code)) fail(400, "Enter the 6-digit code from the SMS.");
    const row = db.prepare("SELECT * FROM phone_otps WHERE user_id=? AND consumed=0 ORDER BY created_at DESC LIMIT 1").get(user.id);
    if (!row || row.expires_at < Date.now()) fail(400, "That code has expired. Request a new one.");
    if (row.attempts >= MAX_ATTEMPTS) { db.prepare("UPDATE phone_otps SET consumed=1 WHERE id=?").run(row.id); fail(429, "Too many wrong attempts. Request a new code."); }
    db.prepare("UPDATE phone_otps SET attempts=attempts+1 WHERE id=?").run(row.id);
    const a = Buffer.from(hmac(user.id, row.phone, code)), b = Buffer.from(row.code_hash);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) fail(400, `That code is incorrect. ${MAX_ATTEMPTS - row.attempts - 1} attempt(s) left.`);
    const p = normalizeBdPhone(row.phone);
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("UPDATE phone_otps SET consumed=1 WHERE id=?").run(row.id);
      db.prepare("UPDATE users SET phone=?, phone_e164=?, phone_verified=1, phone_verified_at=CURRENT_TIMESTAMP WHERE id=?").run(p.local, p.e164, user.id);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      if (String(e.message).includes("UNIQUE")) fail(409, "That number is already verified on another account.");
      throw e;
    }
    return { ok: true, phone: maskPhone(p.local) };
  }

  // Call after any profile edit that may change the phone number.
  function resetIfChanged(userId, newPhone) {
    const p = normalizeBdPhone(newPhone);
    const cur = db.prepare("SELECT phone_e164, phone_verified FROM users WHERE id=?").get(userId);
    if (cur?.phone_verified && (!p || p.e164 !== cur.phone_e164)) db.prepare("UPDATE users SET phone_verified=0, phone_e164=NULL, phone_verified_at=NULL WHERE id=?").run(userId);
  }

  return { request, verify, resetIfChanged };
}

module.exports = { createOtpService };
