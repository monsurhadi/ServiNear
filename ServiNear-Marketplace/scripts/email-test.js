"use strict";
// Email: provider adapters, templates, and the full app flows against a real local SMTP server.
const http = require("node:http");
const { spawn } = require("node:child_process");
const { SMTPServer } = require("smtp-server");
const { simpleParser } = require("mailparser");
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createMailer } = require("../lib/mailer");
const { render } = require("../lib/email-templates");

let failed = 0;
const ok = (name, cond, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  -> " + extra}`); if (!cond) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- fake SMTP inbox ----------
const inbox = []; let smtpMode = "accept"; // accept | tempfail | permfail
function startSmtp(port) {
  const srv = new SMTPServer({ authOptional: true, disabledCommands: ["STARTTLS", "AUTH"], logger: false,
    onData(stream, session, cb) {
      let raw = ""; stream.on("data", (c) => (raw += c)); stream.on("end", async () => {
        if (smtpMode === "tempfail") { const e = new Error("451 Try again later"); e.responseCode = 451; return cb(e); }
        if (smtpMode === "permfail") { const e = new Error("550 Mailbox unavailable"); e.responseCode = 550; return cb(e); }
        inbox.push(await simpleParser(raw)); cb();
      });
    } });
  return new Promise((r) => srv.listen(port, "127.0.0.1", () => r(srv)));
}
async function waitMail(pred, ms = 6000) { const t = Date.now(); while (Date.now() - t < ms) { const m = inbox.find(pred); if (m) return m; await sleep(100); } return null; }
// mailparser turns List-* headers into objects, so read the raw header line.
const rawHdr = (m, name) => { const h = (m?.headerLines || []).find((x) => x.key === name); return h ? h.line.slice(name.length + 1).trim() : ""; };
const to = (addr) => (m) => m.to?.value?.[0]?.address === addr;
const subj = (re) => (m) => re.test(m.subject || "");
const both = (...fs) => (m) => fs.every((f) => f(m));

// ---------- fake HTTP providers ----------
function startApi(port, replies) {
  const seen = [];
  const srv = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    seen.push({ url: req.url, headers: req.headers, body: JSON.parse(b || "{}") });
    const r = replies.shift() || { status: 201, json: { messageId: "<abc@brevo>", id: "re_123" } };
    res.writeHead(r.status, { "Content-Type": "application/json" }); res.end(JSON.stringify(r.json));
  }); });
  return new Promise((r) => srv.listen(port, "127.0.0.1", () => r({ srv, seen })));
}

(async () => {
  console.log("\n-- Providers");
  const brevoApi = await startApi(5085, [{ status: 201, json: { messageId: "<b1>" } }, { status: 500, json: { message: "boom" } }, { status: 400, json: { message: "bad sender" } }]);
  const brevo = createMailer({ NODE_ENV: "production", EMAIL_PROVIDER: "brevo", BREVO_API_KEY: "k-brevo", BREVO_API_URL: "http://127.0.0.1:5085/v3/smtp/email", EMAIL_FROM: "ServiNear <no-reply@example.com>", EMAIL_REPLY_TO: "help@example.com" });
  ok("brevo is configured from env", brevo.configured && brevo.provider === "brevo");
  const id = await brevo.send({ to: "a@example.com", subject: "Hi\r\nBcc: evil@x.com", html: "<p>x</p>", text: "x", headers: { "List-Unsubscribe": "<https://x/u>" } });
  const b0 = brevoApi.seen[0];
  ok("brevo request has api-key, sender, recipient, bodies, reply-to", b0.headers["api-key"] === "k-brevo" && b0.body.sender.email === "no-reply@example.com" && b0.body.sender.name === "ServiNear" && b0.body.to[0].email === "a@example.com" && b0.body.htmlContent === "<p>x</p>" && b0.body.replyTo.email === "help@example.com" && id === "<b1>", JSON.stringify(b0.body));
  ok("header injection in subject is neutralised", !/[\r\n]/.test(b0.body.subject) && b0.body.subject.startsWith("Hi"));
  const e500 = await brevo.send({ to: "a@example.com", subject: "s", html: "h", text: "t" }).catch((e) => e);
  ok("provider 5xx is treated as retryable", e500 instanceof Error && !e500.permanent, e500.message);
  const e400 = await brevo.send({ to: "a@example.com", subject: "s", html: "h", text: "t" }).catch((e) => e);
  ok("provider 4xx is treated as permanent", e400.permanent === true, e400.message);
  ok("invalid recipient is refused before any request", (await brevo.send({ to: "not-an-email", subject: "s", html: "h", text: "t" }).catch((e) => e)).permanent === true);
  const resendApi = await startApi(5084, []);
  const resend = createMailer({ NODE_ENV: "production", EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_key", RESEND_API_URL: "http://127.0.0.1:5084/emails", EMAIL_FROM: "ServiNear <no-reply@example.com>" });
  await resend.send({ to: "b@example.com", subject: "S", html: "<b>h</b>", text: "t" });
  const r0 = resendApi.seen[0];
  ok("resend request has bearer auth, from, to[], html", r0.headers.authorization === "Bearer re_key" && r0.body.from.includes("no-reply@example.com") && r0.body.to[0] === "b@example.com" && r0.body.html === "<b>h</b>", JSON.stringify(r0.body));
  ok("production refuses the console provider", !createMailer({ NODE_ENV: "production", EMAIL_PROVIDER: "console" }).configured);
  ok("production with no provider is off, not silently console", !createMailer({ NODE_ENV: "production" }).configured);
  ok("missing API key is reported", /BREVO_API_KEY/.test(createMailer({ NODE_ENV: "production", EMAIL_PROVIDER: "brevo", EMAIL_FROM: "a@b.com" }).problem || ""));
  ok("bad EMAIL_FROM is rejected", !createMailer({ NODE_ENV: "production", EMAIL_PROVIDER: "resend", RESEND_API_KEY: "k", EMAIL_FROM: "nonsense" }).configured);
  brevoApi.srv.close(); resendApi.srv.close();

  console.log("\n-- Templates");
  const evil = '<script>alert(1)</script> & "Q"';
  const n = render("notification", { name: evil, title: "Offer <b>now</b>", message: evil, url: "https://app.example.com/tasks/1", ctaLabel: "View", unsubscribeUrl: "https://api.example.com/u" });
  ok("user input is HTML-escaped everywhere", !n.html.includes("<script>") && !n.html.includes("<b>now</b>") && n.html.includes("&lt;script&gt;"));
  ok("plain-text twin keeps the original text", n.text.includes("<script>alert(1)</script>") && n.text.includes("Unsubscribe"));
  ok("javascript: URLs never become links", !render("notification", { name: "x", title: "t", message: "m", url: "javascript:alert(1)" }).html.includes("javascript:"));
  ok("reset email shows the code in subject, html and text", ["subject", "html", "text"].every((k) => render("reset", { name: "A", code: "482913", minutes: 15 })[k].includes("482913")));
  ok("transactional templates have no unsubscribe link", !render("reset", { name: "A", code: "111111", minutes: 15 }).html.includes("Unsubscribe"));

  console.log("\n-- App flows (real SMTP)");
  const smtp = await startSmtp(5092);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sn-email-"));
  const PORT = 5091, B = `http://127.0.0.1:${PORT}`;
  const server = spawn(process.execPath, ["server.js"], { cwd: path.join(__dirname, ".."), stdio: "ignore", env: { ...process.env, PORT, DATA_DIR: dir, NODE_ENV: "development", SEED_DEMO_DATA: "false",
    EMAIL_PROVIDER: "smtp", SMTP_HOST: "127.0.0.1", SMTP_PORT: "5092", EMAIL_FROM: "ServiNear <no-reply@example.com>", EMAIL_RETRY_BASE_MS: "150", EMAIL_QUEUE_INTERVAL_MS: "200",
    ADMIN_EMAIL: "root@example.com", ADMIN_PASSWORD: "a-very-long-pass-123", PAYMENT_PROVIDER: "mock" } });
  class Client { constructor() { this.cookie = ""; }
    async call(method, p, body, form) {
      const r = await fetch(B + p, { method, redirect: "manual", headers: { ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : { "Content-Type": "application/json" }), ...(this.cookie ? { cookie: this.cookie } : {}) }, body: body === undefined ? undefined : form ? new URLSearchParams(body).toString() : JSON.stringify(body) });
      const sc = r.headers.get("set-cookie"); if (sc) this.cookie = sc.split(";")[0];
      const ct = r.headers.get("content-type") || ""; const json = ct.includes("json") ? await r.json().catch(() => ({})) : {}; const text = ct.includes("html") ? await r.text() : "";
      return { status: r.status, json, text, headers: r.headers }; } }
  const reg = (c, p) => c.call("POST", "/api/auth/register", { first_name: p.first, surname: p.last || "T", email: p.email, password: "Passw0rd!long", role: p.role || "customer", gender: "male", city: "Dhaka", occupation: "tester", phone: p.phone || "01711111111", area: "Dhanmondi", address: "House 1, Road 2", category: p.role === "worker" ? "Electrical" : undefined, rate: p.role === "worker" ? 500 : undefined, bio: "Experienced tester for email flows." });
  const me = async (c) => (await c.call("GET", "/api/bootstrap")).json.user;
  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(B + "/api/health")).ok) break; } catch {} await sleep(400); }

    // 1. verification
    const cust = new Client();
    const r1 = await reg(cust, { first: "<b>Eve</b>", last: "Cust", email: "cust@example.com" });
    const vmail = await waitMail(both(to("cust@example.com"), subj(/confirm your email/i)));
    ok("registration sends a verification email", r1.status === 201 && !!vmail);
    ok("name in the email is escaped", vmail && !vmail.html.includes("<b>Eve</b>") && vmail.html.includes("&lt;b&gt;Eve"));
    ok("verification email has no unsubscribe header (it is transactional)", vmail && !rawHdr(vmail, "list-unsubscribe"));
    const vlink = (vmail?.text.match(/https?:\/\/\S+\/api\/email\/verify\?token=[\w-]+/) || [])[0];
    ok("verification link is present and absolute", !!vlink, vmail?.text);
    ok("account starts unverified", (await me(cust)).email_verified === 0);
    const v1 = await fetch(vlink, { redirect: "manual" });
    ok("clicking the link verifies the address", v1.status === 302 && /email=verified/.test(v1.headers.get("location")) && (await me(cust)).email_verified === 1, v1.headers.get("location"));
    const v2 = await fetch(vlink, { redirect: "manual" });
    ok("a verification link works only once", /email=invalid/.test(v2.headers.get("location")));
    ok("a forged token is rejected", /email=invalid/.test((await fetch(B + "/api/email/verify?token=AAAA", { redirect: "manual" })).headers.get("location")));
    const verified = (await me(cust)).email_verified === 1;
    const before = inbox.length; const rs = await cust.call("POST", "/api/email/resend-verification");
    ok("resend is a no-op for verified users", verified && rs.json.already_verified === true && inbox.length === before);

    // 2. password reset
    const anon = new Client();
    const f1 = await anon.call("POST", "/api/auth/forgot-password", { email: "cust@example.com" });
    const f2 = await anon.call("POST", "/api/auth/forgot-password", { email: "nobody@example.com" });
    ok("forgot-password NEVER returns the code", !JSON.stringify(f1.json).match(/\d{6}/) && !("reset_code" in f1.json) && !("dev_code" in f1.json), JSON.stringify(f1.json));
    ok("known and unknown emails get identical responses (no enumeration)", f1.status === f2.status && JSON.stringify(f1.json) === JSON.stringify(f2.json), JSON.stringify([f1.json, f2.json]));
    const rmail = await waitMail(both(to("cust@example.com"), subj(/password reset code/i)));
    const code = (rmail?.subject.match(/(\d{6})/) || [])[1];
    ok("reset code arrives by email", !!code && rmail.text.includes(code));
    await sleep(500);
    ok("no email is sent to an unregistered address", !inbox.some(to("nobody@example.com")));
    const wrong = code === "000000" ? "111111" : "000000";
    ok("wrong code is rejected", (await anon.call("POST", "/api/auth/reset-password", { email: "cust@example.com", code: wrong, password: "NewPassw0rd!x" })).status === 400);
    ok("weak password is rejected", (await anon.call("POST", "/api/auth/reset-password", { email: "cust@example.com", code, password: "short" })).status === 400);
    const oldSession = cust.cookie;
    const done = await anon.call("POST", "/api/auth/reset-password", { email: "cust@example.com", code, password: "NewPassw0rd!x" });
    ok("correct code resets the password", done.status === 200, JSON.stringify(done.json));
    ok("new password signs in, old one does not", (await new Client().call("POST", "/api/auth/login", { email: "cust@example.com", password: "NewPassw0rd!x" })).status === 200 && (await new Client().call("POST", "/api/auth/login", { email: "cust@example.com", password: "Passw0rd!long" })).status === 401);
    const stale = new Client(); stale.cookie = oldSession;
    ok("existing sessions are signed out after a reset", (await me(stale)) === null);
    ok("a 'password changed' alert is emailed", !!(await waitMail(both(to("cust@example.com"), subj(/password was changed/i)))));
    ok("a used code cannot be replayed", (await anon.call("POST", "/api/auth/reset-password", { email: "cust@example.com", code, password: "Another0ne!!" })).status === 400);
    await anon.call("POST", "/api/auth/forgot-password", { email: "cust@example.com" }); await sleep(900);
    const codes = inbox.filter(both(to("cust@example.com"), subj(/password reset code/i)));
    const live = (codes[codes.length - 1].subject.match(/(\d{6})/) || [])[1]; const wr = live === "000000" ? "111111" : "000000";
    let locked = false; for (let i = 0; i < 6; i++) if ((await anon.call("POST", "/api/auth/reset-password", { email: "cust@example.com", code: wr, password: "NewPassw0rd!y" })).status === 429) locked = true;
    ok("repeated wrong guesses lock the code", locked);
    ok("the locked code no longer works even when correct", (await anon.call("POST", "/api/auth/reset-password", { email: "cust@example.com", code: live, password: "NewPassw0rd!y" })).status >= 400);
    for (let i = 0; i < 5; i++) await anon.call("POST", "/api/auth/forgot-password", { email: "cust@example.com" });
    await sleep(900);
    ok("reset emails to one address are capped per hour (no flooding)", inbox.filter(both(to("cust@example.com"), subj(/password reset code/i))).length <= 3, String(inbox.filter(both(to("cust@example.com"), subj(/password reset code/i))).length));
    const custLogin = new Client(); await custLogin.call("POST", "/api/auth/login", { email: "cust@example.com", password: "NewPassw0rd!x" }); cust.cookie = custLogin.cookie;

    // 3. notifications + preferences
    const worker = new Client(); await reg(worker, { first: "Wally", last: "Worker", email: "worker@example.com", role: "worker", phone: "01933333333" });
    const mkJob = (title) => cust.call("POST", "/api/jobs", { title, category: "Electrical", details: "Fan stopped working after a power cut, needs rewiring.", area: "Dhanmondi", budget: 1500, contact_phone: "01711111111", exact_address: "House 1, Road 2" });
    const j1 = (await mkJob("Fix my ceiling fan wiring")).json.id;
    await worker.call("POST", "/api/offers", { job_id: j1, price: 1200, message: "I can fix this today." });
    const om = await waitMail(both(to("cust@example.com"), (m) => /offer/i.test(m.subject)));
    ok("verified customer is emailed about a new offer", !!om, inbox.map((m) => m.subject).join(" | "));
    ok("activity emails carry List-Unsubscribe + one-click header", om && /<https?:\/\/.+\/api\/email\/unsubscribe\?u=\d+&t=.+>/.test(rawHdr(om, "list-unsubscribe")) && /One-Click/.test(rawHdr(om, "list-unsubscribe-post")), rawHdr(om, "list-unsubscribe"));
    ok("activity emails include a footer unsubscribe link and an absolute CTA", !!om && /Unsubscribe/.test(om.html) && /href="https?:\/\//.test(om.html));
    const unsubUrl = rawHdr(om, "list-unsubscribe").replace(/^<|>$/g, "");
    ok("unverified recipients get no activity emails", await (async () => { const w2 = new Client(); const c2 = new Client(); await reg(c2, { first: "Una", email: "una@example.com", phone: "01822222222" }); await waitMail(to("una@example.com")); const mark = inbox.length;
      const jj = (await c2.call("POST", "/api/jobs", { title: "Paint my bedroom walls", category: "Painting", details: "Two coats of paint needed for a small bedroom.", area: "Dhanmondi", budget: 3000, contact_phone: "01822222222", exact_address: "Flat 3B" })).json.id;
      await worker.call("POST", "/api/offers", { job_id: jj, price: 2800, message: "Happy to help." }); await sleep(900); return !inbox.slice(mark).some((m) => to("una@example.com")(m) && /offer/i.test(m.subject)); })());

    // 4. unsubscribe (GET must not change anything; POST does)
    const g = await fetch(unsubUrl); const gtxt = await g.text();
    ok("unsubscribe page asks for confirmation on GET", g.status === 200 && /<button>Unsubscribe<\/button>/.test(gtxt));
    ok("GET alone does not unsubscribe (mail scanners prefetch links)", (await me(cust)).email_notifications === 1);
    ok("a tampered unsubscribe token is rejected", (await fetch(unsubUrl.replace(/t=.{6}/, "t=XXXXXX"))).status === 400);
    const post = await fetch(unsubUrl, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" });
    ok("RFC 8058 one-click POST unsubscribes", post.status === 200 && (await me(cust)).email_notifications === 0, String(post.status));
    const mark2 = inbox.length; const j2 = (await mkJob("Replace kitchen switchboard")).json.id;
    await worker.call("POST", "/api/offers", { job_id: j2, price: 900, message: "Can do it tomorrow." }); await sleep(900);
    ok("no more activity emails after unsubscribing", !inbox.slice(mark2).some((m) => to("cust@example.com")(m) && /offer/i.test(m.subject)));

    // 5. transactional emails ignore the opt-out
    const mk = await cust.call("POST", "/api/payments/create", { amount: 800 });
    await fetch(`${B}/api/payments/mock/pay`, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `tran_id=${mk.json.tran_id}&state=paid` });
    ok("payment receipts are still emailed to unsubscribed users", !!(await waitMail(both(to("cust@example.com"), subj(/payment received/i)))));
    ok("receipts have no unsubscribe link", (() => { const pm = inbox.find(both(to("cust@example.com"), subj(/payment received/i))); return !!pm && !rawHdr(pm, "list-unsubscribe"); })());

    // 6. settings toggle round-trips
    await cust.call("PATCH", "/api/user/settings", { email_notifications: true });
    ok("email preference can be switched back on in settings", (await me(cust)).email_notifications === 1);

    // 7. message throttling
    const wid = (await me(worker)).id, cid = (await me(cust)).id; const mark3 = inbox.length;
    for (let i = 0; i < 3; i++) await worker.call("POST", "/api/messages", { recipient_id: cid, content: "Hello, are you free tomorrow? #" + i });
    await sleep(1200);
    ok("a burst of chat messages produces one email, not three", inbox.slice(mark3).filter((m) => to("cust@example.com")(m) && /message/i.test(m.subject)).length === 1);

    // 8. retries and failures
    const adm = new Client(); await adm.call("POST", "/api/auth/login", { email: "root@example.com", password: "a-very-long-pass-123" });
    smtpMode = "tempfail"; await adm.call("POST", "/api/admin/email/test"); await sleep(700);
    const during = (await adm.call("GET", "/api/admin/email")).json;
    ok("temporary SMTP failure keeps the email queued for retry", during.outbox.some((e) => e.kind === "test" && e.status === "pending" && e.attempts >= 1 && /451|Try again/.test(e.last_error || "")), JSON.stringify(during.outbox.slice(0, 2)));
    const mark6 = inbox.length; smtpMode = "accept";
    ok("queued email is delivered once the server recovers", !!(await waitMail((m) => inbox.indexOf(m) >= mark6 && to("root@example.com")(m) && /test email/i.test(m.subject), 8000)));
    smtpMode = "permfail"; const sent0 = (await adm.call("POST", "/api/admin/email/test")).json.id; await sleep(900);
    const failedRow = (await adm.call("GET", "/api/admin/email")).json.outbox.find((e) => e.id === sent0);
    ok("permanent rejection fails immediately without endless retries", failedRow && failedRow.status === "failed" && failedRow.attempts === 1, JSON.stringify(failedRow));
    smtpMode = "accept"; const retried = await adm.call("POST", `/api/admin/email/${failedRow.id}/retry`);
    const mark7 = inbox.length;
    ok("admin can retry a failed email", retried.status === 200 && !!(await waitMail((m) => inbox.indexOf(m) >= mark7 && to("root@example.com")(m), 6000)));

    // 9. admin + data hygiene
    ok("email admin API is admin-only", (await cust.call("GET", "/api/admin/email")).status === 403 && (await anon.call("GET", "/api/admin/email")).status === 401);
    const st = (await adm.call("GET", "/api/admin/email")).json;
    ok("admin sees provider, counts and verified users", st.provider === "smtp" && st.counts.sent > 5 && st.verifiedUsers >= 2 && !JSON.stringify(st.outbox).includes("html"));
    const raw = new DatabaseSync(path.join(dir, "servinear.sqlite"), { readOnly: true });
    const leftovers = raw.prepare("SELECT COUNT(*) c FROM email_outbox WHERE kind IN ('reset','verify','password_changed') AND status='sent' AND html NOT LIKE '[removed%'").get().c;
    ok("codes and verify links are wiped from the outbox after delivery", leftovers === 0, String(leftovers));
    const plainCodes = raw.prepare("SELECT COUNT(*) c FROM password_resets WHERE code_hash GLOB '[0-9][0-9][0-9][0-9][0-9][0-9]'").get().c; raw.close();
    ok("reset codes are stored hashed, never in plain text", plainCodes === 0);

    // 10. edge cases
    const mark4 = inbox.length; const rr = await reg(new Client(), { first: "Local", email: "x@demo.servinear.local", phone: "01655555555" }); await sleep(700);
    ok("reserved/undeliverable domains are skipped without errors", rr.status === 201 && inbox.length === mark4);
    const t1 = await cust.call("POST", "/api/support", { name: "Eve", email: "cust@example.com", subject: "Payment question", message: "I topped up but wanted to confirm the amount shown." });
    ok("support requests get an emailed receipt for the signed-in owner", t1.status === 201 && !!(await waitMail(both(to("cust@example.com"), subj(/received your request/i)))));
    const mark5 = inbox.length; await anon.call("POST", "/api/support", { name: "Troll", email: "victim@example.com", subject: "Spam attempt here", message: "Trying to make ServiNear email someone else." }); await sleep(700);
    ok("anonymous support form cannot be used to email third parties", !inbox.slice(mark5).some(to("victim@example.com")));
  } finally {
    server.kill();
    smtp.close();
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (_) {}
  }
})().catch((e) => { console.error(e); failed++; }).finally(() => { console.log(failed ? `\n${failed} check(s) failed` : "\nAll email checks passed"); process.exit(failed ? 1 : 0); });
