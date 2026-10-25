"use strict";
// SMS delivery for OTP codes. Providers: twilio, bulksmsbd, console (development only).

// Bangladesh mobile numbers: 01[3-9]XXXXXXXX. Returns { e164: "+8801712345678", local: "01712345678" } or null.
function normalizeBdPhone(input) {
  let d = String(input || "").replace(/[\s\-().]/g, "");
  if (d.startsWith("+")) d = d.slice(1);
  if (d.startsWith("00")) d = d.slice(2);
  if (d.startsWith("880")) d = d.slice(3);
  if (d.length === 10 && d.startsWith("1")) d = "0" + d;
  if (!/^01[3-9]\d{8}$/.test(d)) return null;
  return { e164: "+880" + d.slice(1), local: d };
}
const maskPhone = (local) => local.slice(0, 3) + "*****" + local.slice(-3);

function createSmsSender(env = process.env) {
  const provider = String(env.SMS_PROVIDER || (env.NODE_ENV === "production" ? "" : "console")).toLowerCase();
  const timeout = AbortSignal.timeout.bind(AbortSignal);

  async function twilio(p, text) {
    const sid = env.TWILIO_ACCOUNT_SID, token = env.TWILIO_AUTH_TOKEN;
    if (!sid || !token || !(env.TWILIO_FROM || env.TWILIO_MESSAGING_SERVICE_SID)) throw new Error("Twilio is not fully configured.");
    const form = new URLSearchParams({ To: p.e164, Body: text });
    if (env.TWILIO_MESSAGING_SERVICE_SID) form.set("MessagingServiceSid", env.TWILIO_MESSAGING_SERVICE_SID); else form.set("From", env.TWILIO_FROM);
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
      method: "POST", body: form, signal: timeout(10000),
      headers: { Authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64") }
    });
    if (res.status !== 201) throw new Error(`Twilio rejected the message (${res.status})`);
  }

  // NOTE: request/response shape taken from community client libraries; confirm against your BulkSMSBD account docs.
  async function bulksmsbd(p, text) {
    if (!env.BULKSMSBD_API_KEY || !env.BULKSMSBD_SENDER_ID) throw new Error("BulkSMSBD is not fully configured.");
    const form = new URLSearchParams({ api_key: env.BULKSMSBD_API_KEY, senderid: env.BULKSMSBD_SENDER_ID, number: p.e164.slice(1), message: text });
    const res = await fetch(env.BULKSMSBD_URL || "https://bulksmsbd.net/api/smsapi", { method: "POST", body: form, signal: timeout(10000) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || Number(body.response_code) !== 202) throw new Error(`BulkSMSBD rejected the message (${body.response_code ?? res.status})`);
  }

  return {
    provider,
    configured: Boolean(provider) && (provider !== "console" || env.NODE_ENV !== "production"),
    exposesDevCode: provider === "console" && env.NODE_ENV !== "production",
    async send(p, code) {
      const text = `ServiNear code: ${code}. It expires in 5 minutes. Never share it with anyone.`;
      if (provider === "console") { if (env.NODE_ENV === "production") throw new Error("Console SMS is disabled in production."); console.log(`[sms:console] to ${p.e164}: ${text}`); return; }
      if (provider === "twilio") return twilio(p, text);
      if (provider === "bulksmsbd") return bulksmsbd(p, text);
      throw new Error("No SMS provider configured. Set SMS_PROVIDER.");
    }
  };
}

module.exports = { normalizeBdPhone, maskPhone, createSmsSender };
