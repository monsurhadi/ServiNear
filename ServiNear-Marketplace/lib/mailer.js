"use strict";
// Email delivery. One interface, four providers:
//   brevo   HTTPS API  (works on hosts that block SMTP, e.g. Render free tier)
//   resend  HTTPS API  (same)
//   smtp    any SMTP server via nodemailer (needs outbound port 465/587, e.g. paid hosting or a VPS)
//   console development only: prints the message instead of sending it
// send() resolves with a provider message id, or throws. Retries are handled by the outbox queue, not here.

const nodemailer = require("nodemailer");

const clean = (s) => String(s ?? "").replace(/[\r\n]+/g, " ").trim(); // blocks header injection
const EMAIL_RE = /^[^\s@<>()\[\]\\,;:"]+@[^\s@<>()\[\]\\,;:"]+\.[^\s@<>()\[\]\\,;:"]+$/;

function parseFrom(raw) {
  const s = clean(raw);
  const m = /^"?([^"<]*?)"?\s*<([^>]+)>$/.exec(s);
  return m ? { name: m[1].trim(), email: m[2].trim() } : { name: "", email: s };
}
const formatFrom = (f) => (f.name ? `"${f.name.replace(/"/g, "")}" <${f.email}>` : f.email);

function createMailer(env = process.env) {
  const isProd = env.NODE_ENV === "production";
  const want = String(env.EMAIL_PROVIDER || (isProd ? "" : "console")).toLowerCase();
  const from = parseFrom(env.EMAIL_FROM || (isProd ? "" : "ServiNear <no-reply@servinear.local>"));
  const replyTo = env.EMAIL_REPLY_TO ? clean(env.EMAIL_REPLY_TO) : null;
  const timeoutMs = Number(env.EMAIL_TIMEOUT_MS || 15000);
  const brevoUrl = env.BREVO_API_URL || "https://api.brevo.com/v3/smtp/email";
  const resendUrl = env.RESEND_API_URL || "https://api.resend.com/emails";

  let transport = null;
  const smtp = () => (transport ||= nodemailer.createTransport({
    host: env.SMTP_HOST, port: Number(env.SMTP_PORT || 587),
    secure: env.SMTP_SECURE === "1" || Number(env.SMTP_PORT) === 465,
    requireTLS: env.SMTP_REQUIRE_TLS === "1",
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS || "" } : undefined,
    tls: { rejectUnauthorized: env.SMTP_TLS_REJECT_UNAUTHORIZED !== "0" },
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: timeoutMs
  }));

  const keyed = { brevo: env.BREVO_API_KEY, resend: env.RESEND_API_KEY };
  let provider = "none", problem = null;
  if (want === "console") {
    if (isProd) problem = "The console email provider is disabled in production.";
    else provider = "console";
  } else if (want === "smtp") {
    if (!env.SMTP_HOST) problem = "SMTP_HOST is not set."; else provider = "smtp";
  } else if (want === "brevo" || want === "resend") {
    if (!keyed[want]) problem = `${want.toUpperCase()}_API_KEY is not set.`; else provider = want;
  } else if (want) problem = `Unknown EMAIL_PROVIDER "${want}".`;
  if (provider !== "none" && provider !== "console" && !EMAIL_RE.test(from.email)) { problem = "EMAIL_FROM must be a valid address, e.g. ServiNear <no-reply@yourdomain.com>."; provider = "none"; }

  async function viaFetch(url, headers, body, label) {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    let json = {}; try { json = JSON.parse(text); } catch { /* non-JSON error body */ }
    if (!res.ok) throw Object.assign(new Error(`${label} rejected the email (HTTP ${res.status}${json.message ? ": " + String(json.message).slice(0, 120) : ""})`), { permanent: res.status >= 400 && res.status < 500 && res.status !== 429 && res.status !== 408 });
    return json.messageId || json.id || null;
  }

  return {
    provider,
    configured: provider !== "none",
    problem,
    from: formatFrom(from),
    isReal: provider !== "none" && provider !== "console",
    isValidAddress: (e) => EMAIL_RE.test(String(e || "")),
    async send({ to, subject, html, text, headers = {} }) {
      to = clean(to); subject = clean(subject);
      if (!EMAIL_RE.test(to)) throw Object.assign(new Error("Invalid recipient address."), { permanent: true });
      const hdr = Object.fromEntries(Object.entries(headers).map(([k, v]) => [clean(k), clean(v)]));
      if (provider === "console") { console.log(`[email:console] to=${to} subject="${subject}"`); return "console-" + Date.now(); }
      if (provider === "smtp") {
        try {
          const info = await smtp().sendMail({ from: formatFrom(from), to, subject, html, text, headers: hdr, ...(replyTo ? { replyTo } : {}) });
          return info.messageId || null;
        } catch (e) {
          // 5xx replies (bad mailbox, policy rejection, auth failure) will never succeed on retry; 4xx and network errors will.
          e.permanent = Number(e.responseCode) >= 500 && Number(e.responseCode) < 600;
          throw e;
        }
      }
      if (provider === "brevo") {
        return viaFetch(brevoUrl, { "api-key": keyed.brevo }, {
          sender: from.name ? { name: from.name, email: from.email } : { email: from.email }, to: [{ email: to }], subject,
          htmlContent: html, textContent: text, ...(replyTo ? { replyTo: { email: replyTo } } : {}), ...(Object.keys(hdr).length ? { headers: hdr } : {})
        }, "Brevo");
      }
      if (provider === "resend") {
        return viaFetch(resendUrl, { Authorization: `Bearer ${keyed.resend}` }, {
          from: formatFrom(from), to: [to], subject, html, text, ...(replyTo ? { reply_to: replyTo } : {}), ...(Object.keys(hdr).length ? { headers: hdr } : {})
        }, "Resend");
      }
      throw Object.assign(new Error(problem || "No email provider is configured."), { permanent: true });
    }
  };
}

module.exports = { createMailer };
