"use strict";
// Email templates: table-based, inline-styled (works in Gmail/Outlook/Apple Mail), with a plain-text twin.
// Every dynamic value goes through esc(); never concatenate user input into HTML directly.

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeUrl = (u) => (/^https?:\/\//i.test(String(u || "")) ? String(u) : "");
const C = { teal: "#0e6b5c", tealDark: "#094f44", rust: "#bd4d2c", ink: "#17242a", soft: "#4c5d62", muted: "#74827b", paper: "#f4f1e8", card: "#ffffff", line: "#e4dccb" };
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function button(label, url) {
  const u = safeUrl(url);
  if (!u) return "";
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:26px 0 8px"><tr><td style="border-radius:10px;background:${C.teal}">
    <a href="${esc(u)}" style="display:inline-block;padding:14px 28px;font:700 15px ${FONT};color:#ffffff;text-decoration:none;border-radius:10px">${esc(label)}</a></td></tr></table>
    <p style="margin:10px 0 0;font:12px/1.5 ${FONT};color:${C.muted}">Button not working? Copy this link into your browser:<br><a href="${esc(u)}" style="color:${C.teal};word-break:break-all">${esc(u)}</a></p>`;
}

function layout({ preheader = "", heading, bodyHtml, cta = "", footerNote = "", unsubscribeUrl = "" }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(heading)}</title></head>
<body style="margin:0;padding:0;background:${C.paper}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${esc(preheader)}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.paper}"><tr><td align="center" style="padding:28px 14px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
    <tr><td style="padding:0 4px 16px;font:800 22px ${FONT};color:${C.ink};letter-spacing:-.3px">Servi<span style="color:${C.rust}">Near</span></td></tr>
    <tr><td style="background:${C.card};border:1px solid ${C.line};border-radius:16px;padding:32px 30px">
      <h1 style="margin:0 0 14px;font:700 22px/1.3 ${FONT};color:${C.ink}">${esc(heading)}</h1>
      ${bodyHtml}${cta}
    </td></tr>
    <tr><td style="padding:18px 8px 0;font:12px/1.6 ${FONT};color:${C.muted}">
      ${footerNote ? `<p style="margin:0 0 8px">${footerNote}</p>` : ""}
      <p style="margin:0">ServiNear, Bangladesh's verified local services marketplace.</p>
      ${unsubscribeUrl ? `<p style="margin:8px 0 0">Don't want these emails? <a href="${esc(unsubscribeUrl)}" style="color:${C.muted}">Unsubscribe</a> (security and payment emails will still be sent).</p>` : ""}
    </td></tr>
  </table></td></tr></table></body></html>`;
}
const p = (t) => `<p style="margin:0 0 14px;font:15px/1.65 ${FONT};color:${C.soft}">${t}</p>`;
const hi = (name) => p(`Hi ${esc(String(name || "there").split(" ")[0])},`);

function plain({ heading, lines, url, unsubscribeUrl }) {
  return [heading, "", ...lines, ...(safeUrl(url) ? ["", safeUrl(url)] : []), "", "-- ServiNear",
    ...(unsubscribeUrl ? ["", `Unsubscribe from non-essential emails: ${unsubscribeUrl}`] : [])].join("\n");
}

const T = {
  verify({ name, url }) {
    const heading = "Confirm your email address";
    return {
      subject: "Confirm your email for ServiNear",
      html: layout({ preheader: "One tap to confirm your email and finish setting up.", heading, bodyHtml: hi(name) + p("Welcome to ServiNear! Please confirm that this is your email address so we can send you offer updates, receipts and security alerts."), cta: button("Confirm my email", url), footerNote: "This link expires in 48 hours. If you didn't create a ServiNear account, you can ignore this email." }),
      text: plain({ heading, lines: [`Hi ${String(name || "there").split(" ")[0]},`, "", "Welcome to ServiNear! Confirm your email address using this link (valid for 48 hours):"], url })
    };
  },
  reset({ name, code, minutes }) {
    const heading = "Your password reset code";
    return {
      subject: `${code} is your ServiNear password reset code`,
      html: layout({ preheader: `Your code is ${code}. It expires in ${minutes} minutes.`, heading, bodyHtml: hi(name) + p("Use this code to set a new password:") +
        `<div style="margin:18px 0;padding:18px;text-align:center;background:${C.paper};border:1px dashed ${C.line};border-radius:12px;font:800 34px ${FONT};letter-spacing:10px;color:${C.teal}">${esc(code)}</div>` +
        p(`It expires in <b>${esc(minutes)} minutes</b> and works once.`), footerNote: "If you didn't ask to reset your password, ignore this email. Your password stays the same and nobody can use this code without access to your inbox. Never share this code with anyone." }),
      text: plain({ heading, lines: [`Hi ${String(name || "there").split(" ")[0]},`, "", `Your ServiNear password reset code is: ${code}`, `It expires in ${minutes} minutes and works once.`, "", "If you didn't request this, ignore this email. Never share this code with anyone."] })
    };
  },
  password_changed({ name, when, url }) {
    const heading = "Your password was changed";
    return {
      subject: "Your ServiNear password was changed",
      html: layout({ preheader: "If this wasn't you, act now.", heading, bodyHtml: hi(name) + p(`The password for your ServiNear account was just changed (${esc(when)}). You were signed out everywhere.`) + p("<b>Wasn't you?</b> Reset your password again right away and contact support."), cta: button("Reset my password", url) }),
      text: plain({ heading, lines: [`Hi ${String(name || "there").split(" ")[0]},`, "", `The password for your ServiNear account was just changed (${when}). You were signed out everywhere.`, "If this wasn't you, reset your password again right away and contact support."], url })
    };
  },
  notification({ name, title, message, url, ctaLabel = "Open ServiNear", unsubscribeUrl }) {
    return {
      subject: title,
      html: layout({ preheader: message, heading: title, bodyHtml: hi(name) + p(esc(message)), cta: button(ctaLabel, url), unsubscribeUrl }),
      text: plain({ heading: title, lines: [`Hi ${String(name || "there").split(" ")[0]},`, "", message], url, unsubscribeUrl })
    };
  },
  ticket_received({ name, subject, ticketId }) {
    const heading = "We got your message";
    return {
      subject: `We received your request (#${ticketId})`,
      html: layout({ preheader: "Our team will reply by email.", heading, bodyHtml: hi(name) + p(`Thanks for contacting ServiNear support. We received your request <b>"${esc(subject)}"</b> (reference #${esc(ticketId)}) and will reply to this email address.`) }),
      text: plain({ heading, lines: [`Hi ${String(name || "there").split(" ")[0]},`, "", `Thanks for contacting ServiNear support. We received your request "${subject}" (reference #${ticketId}) and will reply to this email address.`] })
    };
  },
  test({ name, provider }) {
    const heading = "Email delivery is working";
    return {
      subject: "ServiNear test email",
      html: layout({ preheader: "Your email settings are correct.", heading, bodyHtml: hi(name) + p(`This is a test message sent through the <b>${esc(provider)}</b> provider. If you can read it, ServiNear can reach your users' inboxes.`) }),
      text: plain({ heading, lines: [`Hi ${String(name || "there").split(" ")[0]},`, "", `This is a test message sent through the ${provider} provider. If you can read it, ServiNear can reach your users' inboxes.`] })
    };
  }
};

function render(kind, data) {
  if (!T[kind]) throw new Error("Unknown email template: " + kind);
  return T[kind](data);
}

module.exports = { render, esc };
