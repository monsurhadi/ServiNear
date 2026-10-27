"use strict";
/* ServiNear email UI: confirmation prompt, return-from-link toasts, and working notification settings. */
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  let cfg = {};

  // "Confirm your email" prompt under the profile name.
  function addVerifyChip() {
    $("#sidebar-email-chip")?.remove();
    const u = state.user, host = $("#sidebar-headline");
    if (!u || u.email_verified || !host || !cfg.emailEnabled) return;
    const box = document.createElement("div");
    box.id = "sidebar-email-chip";
    box.style.cssText = "margin:10px 12px 0;padding:10px 12px;border-radius:12px;background:#fbf3df;border:1px solid #ecd9a6;font-size:12px;line-height:1.45;text-align:left";
    box.innerHTML = `<b>Confirm your email</b><br><span style="color:#5b6a63">We sent a link to ${String(u.email).replace(/[&<>"']/g, "")}.</span><br><button type="button" id="resend-verify" style="margin-top:6px;padding:0;border:0;background:none;color:var(--teal);font-weight:700;cursor:pointer;text-decoration:underline">Resend email</button>`;
    host.after(box);
  }
  const orig = window.renderProfileSidebar;
  if (typeof orig === "function") window.renderProfileSidebar = function () { orig.apply(this, arguments); addVerifyChip(); };

  document.addEventListener("click", async (e) => {
    if (!e.target.closest("#resend-verify")) return;
    const btn = e.target.closest("#resend-verify"); btn.disabled = true;
    try { await post("/api/email/resend-verification", {}); toast("Confirmation email sent. Check your inbox and spam folder."); }
    catch (err) { toast(err.message); } finally { btn.disabled = false; }
  });

  // Notification settings: the form previously had no handler at all.
  document.addEventListener("submit", async (e) => {
    if (e.target.id !== "settings-notifications-form") return;
    e.preventDefault();
    const body = {};
    e.target.querySelectorAll('input[type="checkbox"]').forEach((c) => { if (!c.disabled) body[c.name] = c.checked; });
    const btn = e.target.querySelector('[type="submit"]'); if (btn) btn.disabled = true;
    try {
      await post("/api/user/settings", body, "PATCH");
      const b = await api("/api/bootstrap"); state.user = b.user;
      toast("Notification settings saved.");
    } catch (err) { toast(err.message); } finally { if (btn) btn.disabled = false; }
  });

  async function handleReturn() {
    const status = new URLSearchParams(location.search).get("email");
    if (!status) return;
    history.replaceState({}, "", location.pathname);
    for (let i = 0; i < 40 && !state.user; i++) await new Promise((r) => setTimeout(r, 150));
    if (status === "verified") {
      toast("Email confirmed. Thank you!");
      try { const b = await api("/api/bootstrap"); state.user = b.user; renderProfileSidebar(); } catch {}
    } else toast("That confirmation link is invalid or has already been used. You can request a new one from your profile.");
  }

  (async () => {
    try { cfg = await api("/api/config"); } catch {}
    addVerifyChip(); handleReturn();
    const t = setInterval(() => { if (state.user) { clearInterval(t); addVerifyChip(); } }, 400); setTimeout(() => clearInterval(t), 12000);
  })();
})();
