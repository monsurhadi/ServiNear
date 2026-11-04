"use strict";
// Email service: persistent outbox with retries, address verification, hardened password reset,
// notification routing that honours user preferences, and signed one-click unsubscribe.
const crypto = require("node:crypto");
const limiter = require("./ratelimit");

const MAX_ATTEMPTS = 5;
const RESET_TTL_MS = 15 * 60 * 1000, RESET_MAX_ATTEMPTS = 5, VERIFY_TTL_MS = 48 * 3600 * 1000;
const SENSITIVE = new Set(["reset", "verify", "password_changed"]); // bodies contain codes/links: wiped once handled
// Notification type -> how it is emailed. transactional always sends; the rest respect preferences and need a verified address.
const TYPE_CATEGORY = { wallet: "transactional", escrow: "transactional", security: "transactional", verification: "transactional", offer: "activity", accepted: "activity", completed: "activity", chat: "messages" };
const CTA = { offer: "View offer", accepted: "View task", completed: "View task", chat: "Read message", wallet: "Open wallet", escrow: "Open wallet", verification: "Open my profile", security: "Review account" };
const RESERVED = /\.(local|invalid|localhost)$/i;

function createEmailService({ db, mailer, render, fail, apiBase, appBase, hashPassword, env = process.env }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_secrets (name TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS email_outbox (
      id INTEGER PRIMARY KEY, user_id INTEGER, to_email TEXT NOT NULL, subject TEXT NOT NULL, html TEXT NOT NULL, text TEXT NOT NULL,
      headers TEXT, kind TEXT NOT NULL, category TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','failed','skipped')),
      attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, provider_id TEXT, dedupe_key TEXT,
      next_attempt_at INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, sent_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_outbox_due ON email_outbox(status, next_attempt_at);
    CREATE INDEX IF NOT EXISTS idx_outbox_dedupe ON email_outbox(dedupe_key, created_at);
    CREATE TABLE IF NOT EXISTS email_tokens (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, token_hash TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS password_resets (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, consumed INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, ip TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_resets_user ON password_resets(user_id, created_at DESC);
  `);
  const have = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
  if (!have.includes("email_verified")) db.exec("ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0");
  if (!have.includes("email_notifications")) db.exec("ALTER TABLE users ADD COLUMN email_notifications INTEGER NOT NULL DEFAULT 1");
  db.exec("UPDATE users SET email_verified=1 WHERE google_id IS NOT NULL AND email_verified=0"); // Google already verified these
  db.exec("UPDATE users SET email_verified=1 WHERE role='admin' AND email_verified=0");

  const secret = () => {
    const row = db.prepare("SELECT value FROM app_secrets WHERE name='email'").get();
    if (row) return row.value;
    db.prepare("INSERT OR IGNORE INTO app_secrets(name,value) VALUES('email',?)").run(crypto.randomBytes(32).toString("hex"));
    return db.prepare("SELECT value FROM app_secrets WHERE name='email'").get().value;
  };
  const hmac = (s) => crypto.createHmac("sha256", secret()).update(s).digest("base64url");
  const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
  const eq = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };

  const retryBase = Number(env.EMAIL_RETRY_BASE_MS || 60000);
  const delays = [1, 5, 30, 120].map((m) => m * retryBase);

  // ---------- unsubscribe ----------
  const unsubSig = (userId) => hmac("unsub:" + userId);
  const unsubscribeUrl = (userId) => `${apiBase()}/api/email/unsubscribe?u=${userId}&t=${unsubSig(userId)}`;
  const checkUnsub = (userId, t) => eq(unsubSig(Number(userId)), String(t || ""));
  const unsubHeaders = (userId) => { const u = unsubscribeUrl(userId); return { "List-Unsubscribe": `<${u}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }; };
  function unsubscribe(userId) { return db.prepare("UPDATE users SET email_notifications=0 WHERE id=?").run(Number(userId)).changes > 0; }

  // ---------- outbox ----------
  function enqueue({ userId = null, to, kind, data, category = "transactional", dedupeKey = null, dedupeMs = 0, headers = {} }) {
    if (!mailer.configured) return { queued: false, reason: "not_configured" };
    const addr = String(to || "").trim();
    if (!mailer.isValidAddress(addr) || RESERVED.test(addr.split("@")[1] || "")) return { queued: false, reason: "undeliverable_address" };
    if (dedupeKey && dedupeMs && db.prepare("SELECT 1 FROM email_outbox WHERE dedupe_key=? AND created_at > datetime('now', ?)").get(dedupeKey, `-${Math.ceil(dedupeMs / 1000)} seconds`))
      return { queued: false, reason: "throttled" };
    const mail = render(kind, data);
    const id = Number(db.prepare(`INSERT INTO email_outbox(user_id,to_email,subject,html,text,headers,kind,category,dedupe_key,next_attempt_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .run(userId, addr, mail.subject, mail.html, mail.text, JSON.stringify(headers), kind, category, dedupeKey, Date.now()).lastInsertRowid);
    setImmediate(() => processQueue().catch((e) => console.error("Email queue error:", e.message)));
    return { queued: true, id };
  }

  let running = false;
  async function processQueue(max = 25) {
    if (running || !mailer.configured) return 0;
    running = true; let done = 0;
    try {
      db.prepare("UPDATE email_outbox SET status='pending' WHERE status='sending' AND next_attempt_at < ?").run(Date.now() - 5 * 60 * 1000);
      const rows = db.prepare("SELECT * FROM email_outbox WHERE status='pending' AND next_attempt_at<=? ORDER BY id LIMIT ?").all(Date.now(), max);
      for (const r of rows) {
        if (!db.prepare("UPDATE email_outbox SET status='sending', next_attempt_at=? WHERE id=? AND status='pending'").run(Date.now(), r.id).changes) continue;
        const wipe = SENSITIVE.has(r.kind) ? ", html='[removed after delivery]', text='[removed after delivery]'" : "";
        try {
          const pid = await mailer.send({ to: r.to_email, subject: r.subject, html: r.html, text: r.text, headers: JSON.parse(r.headers || "{}") });
          db.prepare(`UPDATE email_outbox SET status='sent', provider_id=?, attempts=attempts+1, last_error=NULL, sent_at=CURRENT_TIMESTAMP${wipe} WHERE id=?`).run(pid, r.id);
          done++;
        } catch (e) {
          const attempts = r.attempts + 1, final = e.permanent || attempts >= MAX_ATTEMPTS;
          db.prepare(`UPDATE email_outbox SET status=?, attempts=?, last_error=?, next_attempt_at=?${final ? wipe : ""} WHERE id=?`)
            .run(final ? "failed" : "pending", attempts, String(e.message).slice(0, 300), Date.now() + (delays[attempts - 1] || delays[delays.length - 1]), r.id);
          console.warn(`Email #${r.id} (${r.kind}) ${final ? "failed permanently" : "will retry"}: ${e.message}`);
        }
      }
    } finally { running = false; }
    return done;
  }
  const timer = setInterval(() => processQueue().catch(() => {}), Number(env.EMAIL_QUEUE_INTERVAL_MS || 5000)); timer.unref();
  let lastClean = 0;
  const tidy = setInterval(() => {
    if (Date.now() - lastClean < 3600000) return; lastClean = Date.now();
    db.prepare("DELETE FROM email_outbox WHERE created_at < datetime('now','-30 days')").run();
    db.prepare("DELETE FROM email_tokens WHERE expires_at < ?").run(Date.now() - 86400000);
    db.prepare("DELETE FROM password_resets WHERE expires_at < ?").run(Date.now() - 86400000);
  }, 60000); tidy.unref();

  // ---------- verification ----------
  function sendVerification(user) {
    if (!user || user.email_verified) return { queued: false, reason: "already_verified" };
    const token = crypto.randomBytes(32).toString("base64url");
    db.prepare("UPDATE email_tokens SET used=1 WHERE user_id=? AND used=0").run(user.id);
    db.prepare("INSERT INTO email_tokens(user_id,token_hash,expires_at) VALUES(?,?,?)").run(user.id, sha(token), Date.now() + VERIFY_TTL_MS);
    return enqueue({ userId: user.id, to: user.email, kind: "verify", category: "transactional", data: { name: user.name, url: `${apiBase()}/api/email/verify?token=${token}` } });
  }
  function verifyToken(token) {
    const row = db.prepare("SELECT * FROM email_tokens WHERE token_hash=? AND used=0").get(sha(String(token || "")));
    if (!row || row.expires_at < Date.now()) return null;
    db.exec("BEGIN IMMEDIATE");
    try {
      if (!db.prepare("UPDATE email_tokens SET used=1 WHERE id=? AND used=0").run(row.id).changes) { db.exec("ROLLBACK"); return null; }
      db.prepare("UPDATE users SET email_verified=1 WHERE id=?").run(row.user_id);
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
    return { userId: row.user_id };
  }

  // ---------- password reset ----------
  const UNIFORM = { ok: true, message: "If that email is registered, we've sent a 6-digit code. It expires in 15 minutes." };
  function requestReset(emailRaw, ip) {
    if (!mailer.configured) fail(503, "Password reset by email isn't available right now. Please contact support."); // same for every address: no enumeration
    const email = String(emailRaw || "").trim().toLowerCase();
    if (!mailer.isValidAddress(email)) fail(400, "Please enter a valid email address.");
    const ipOk = limiter.hit("reset:ip:" + ip, 8, 3600 * 1000).allowed, mailOk = limiter.hit("reset:mail:" + email, 3, 3600 * 1000).allowed;
    const out = { ...UNIFORM };
    if (!ipOk || !mailOk) return out; // silently capped: an attacker learns nothing and a victim isn't flooded
    const u = db.prepare("SELECT id,name,email,status FROM users WHERE email=?").get(email);
    if (!u || u.status === "suspended") return out;
    const code = String(crypto.randomInt(100000, 1000000));
    db.prepare("UPDATE password_resets SET consumed=1 WHERE user_id=? AND consumed=0").run(u.id);
    db.prepare("INSERT INTO password_resets(user_id,code_hash,expires_at,created_at,ip) VALUES(?,?,?,?,?)").run(u.id, hmac(`reset:${u.id}:${code}`), Date.now() + RESET_TTL_MS, Date.now(), ip || null);
    enqueue({ userId: u.id, to: u.email, kind: "reset", category: "transactional", data: { name: u.name, code, minutes: RESET_TTL_MS / 60000 } });
    if (mailer.provider === "console" && env.NODE_ENV !== "production") out.dev_code = code; // development convenience only
    return out;
  }
  async function confirmReset(emailRaw, codeRaw, newPassword, ip) {
    const bad = () => fail(400, "That code is invalid or has expired. Request a new one.");
    if (!limiter.hit("reset-confirm:ip:" + ip, 20, 3600 * 1000).allowed) fail(429, "Too many attempts. Please try again later.");
    const email = String(emailRaw || "").trim().toLowerCase(), code = String(codeRaw || "").trim();
    if (String(newPassword || "").length < 8) fail(400, "Password must be at least 8 characters.");
    if (!/^\d{6}$/.test(code)) bad();
    const u = db.prepare("SELECT id,name,email FROM users WHERE email=?").get(email);
    if (!u) bad();
    const row = db.prepare("SELECT * FROM password_resets WHERE user_id=? AND consumed=0 ORDER BY created_at DESC LIMIT 1").get(u.id);
    if (!row || row.expires_at < Date.now()) bad();
    if (row.attempts >= RESET_MAX_ATTEMPTS) { db.prepare("UPDATE password_resets SET consumed=1 WHERE id=?").run(row.id); fail(429, "Too many wrong codes. Request a new one."); }
    db.prepare("UPDATE password_resets SET attempts=attempts+1 WHERE id=?").run(row.id);
    if (!eq(hmac(`reset:${u.id}:${code}`), row.code_hash)) bad();
    const hash = await hashPassword(String(newPassword));
    db.exec("BEGIN IMMEDIATE");
    try {
      if (!db.prepare("UPDATE password_resets SET consumed=1 WHERE id=? AND consumed=0").run(row.id).changes) { db.exec("ROLLBACK"); bad(); }
      db.prepare("UPDATE users SET password_hash=?, email_verified=1 WHERE id=?").run(hash, u.id); // they just proved inbox access
      db.prepare("DELETE FROM sessions WHERE user_id=?").run(u.id); // sign out every device
      db.exec("COMMIT");
    } catch (e) { try { db.exec("ROLLBACK"); } catch { /* already rolled back */ } throw e; }
    enqueue({ userId: u.id, to: u.email, kind: "password_changed", category: "transactional", data: { name: u.name, when: new Date().toUTCString(), url: `${appBase()}/` } });
    return { ok: true };
  }

  // ---------- notifications ----------
  function notify(userId, { title, message, type, link }) {
    const category = TYPE_CATEGORY[type];
    if (!category || !mailer.configured) return;
    const u = db.prepare("SELECT id,name,email,email_verified,email_notifications,notif_all,notif_messages,status FROM users WHERE id=?").get(userId);
    if (!u || u.status === "suspended") return;
    if (category !== "transactional") {
      if (!u.email_verified || u.email_notifications === 0 || u.notif_all === 0) return;
      if (category === "messages" && u.notif_messages === 0) return;
    }
    const url = link && String(link).startsWith("/") ? appBase() + link : appBase() + "/";
    const optional = category !== "transactional";
    enqueue({ userId: u.id, to: u.email, kind: "notification", category,
      data: { name: u.name, title, message, url, ctaLabel: CTA[type] || "Open ServiNear", unsubscribeUrl: optional ? unsubscribeUrl(u.id) : "" },
      headers: optional ? unsubHeaders(u.id) : {}, dedupeKey: category === "messages" ? `chat:${u.id}` : null, dedupeMs: 30 * 60 * 1000 });
  }

  // ---------- admin ----------
  const stats = () => ({
    provider: mailer.provider, configured: mailer.configured, from: mailer.from, problem: mailer.problem,
    counts: Object.fromEntries(db.prepare("SELECT status, COUNT(*) n FROM email_outbox GROUP BY status").all().map((r) => [r.status, r.n])),
    verifiedUsers: db.prepare("SELECT COUNT(*) c FROM users WHERE email_verified=1").get().c, totalUsers: db.prepare("SELECT COUNT(*) c FROM users").get().c,
    unsubscribed: db.prepare("SELECT COUNT(*) c FROM users WHERE email_notifications=0").get().c
  });
  const list = (limit = 100) => db.prepare("SELECT id,to_email,subject,kind,category,status,attempts,last_error,created_at,sent_at FROM email_outbox ORDER BY id DESC LIMIT ?").all(limit);
  function retry(id) {
    const r = db.prepare("SELECT id,status FROM email_outbox WHERE id=?").get(id);
    if (!r) return false;
    if (r.status !== "failed") fail(409, "Only failed emails can be retried.");
    db.prepare("UPDATE email_outbox SET status='pending', attempts=0, next_attempt_at=? WHERE id=?").run(Date.now(), id);
    setImmediate(() => processQueue().catch(() => {}));
    return true;
  }
  const sendTest = (admin) => enqueue({ userId: admin.id, to: admin.email, kind: "test", category: "transactional", data: { name: admin.name, provider: mailer.provider } });

  return { enqueue, processQueue, sendVerification, verifyToken, requestReset, confirmReset, notify, unsubscribe, checkUnsub, unsubscribeUrl, stats, list, retry, sendTest, flush: () => processQueue(500) };
}

module.exports = { createEmailService };
