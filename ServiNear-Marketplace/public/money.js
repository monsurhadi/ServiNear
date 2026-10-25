"use strict";
/* ServiNear money UI: mobile-number verification (OTP), wallet top-up via the payment gateway,
   funded escrow acceptance, and the post-payment return flow. Loaded after app.js and finder.js. */
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const taka = (n) => "৳" + Number(n || 0).toLocaleString();
  let cfg = { minTopup: 50, maxTopup: 100000 };
  let afterVerify = null, resendTimer = null, topupCtx = {};

  function inject() {
    if ($("#phone-dialog")) return;
    document.body.insertAdjacentHTML("beforeend", `
      <dialog class="dialog money-dialog" id="phone-dialog" aria-labelledby="phone-title">
        <div class="dialog-content">
          <button class="icon-button dialog-close" data-close-dialog type="button" aria-label="Close dialog"><i data-lucide="x"></i></button>
          <div class="escrow-badge"><i data-lucide="smartphone"></i> Verify your mobile number</div>
          <h2 id="phone-title">Keep your account and money safe</h2>
          <p class="dialog-copy" id="phone-copy">We will text you a 6-digit code. Verified numbers unlock payments, bids and payouts.</p>
          <form id="phone-form" novalidate>
            <div id="phone-step-1">
              <label class="form-field"><span>Mobile number</span>
                <input id="phone-input" type="tel" inputmode="tel" autocomplete="tel" placeholder="01712345678" maxlength="20" required>
              </label>
              <button class="button button-teal full-width mt-3" id="phone-send" type="submit"><i data-lucide="send"></i> Send code</button>
            </div>
            <div id="phone-step-2" class="hidden">
              <label class="form-field"><span id="phone-sent-to">6-digit code</span>
                <input id="phone-code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="\\d{6}" maxlength="6" placeholder="••••••" class="text-center text-lg font-bold">
              </label>
              <button class="button button-teal full-width mt-3" id="phone-confirm" type="submit"><i data-lucide="check-circle-2"></i> Verify</button>
              <button class="button button-quiet full-width mt-2" id="phone-resend" type="button" disabled>Resend code</button>
              <button class="button button-quiet full-width mt-1" id="phone-change" type="button">Use a different number</button>
            </div>
            <p class="inline-message mt-2" id="phone-msg" role="status" aria-live="polite"></p>
          </form>
        </div>
      </dialog>
      <dialog class="dialog money-dialog" id="topup-dialog" aria-labelledby="topup-title">
        <div class="dialog-content">
          <button class="icon-button dialog-close" data-close-dialog type="button" aria-label="Close dialog"><i data-lucide="x"></i></button>
          <div class="escrow-badge"><i data-lucide="wallet"></i> Add money</div>
          <h2 id="topup-title">Top up your wallet</h2>
          <p class="dialog-copy" id="topup-copy">Pay securely with bKash, Nagad, Rocket or a card. Your money is held safely until a task is completed.</p>
          <form id="topup-form" novalidate>
            <div class="topup-chips" id="topup-chips"></div>
            <label class="form-field"><span>Amount (৳)</span>
              <input id="topup-amount" type="number" inputmode="numeric" step="1" min="50" required placeholder="1000">
            </label>
            <button class="button button-teal full-width mt-3" id="topup-pay" type="submit"><i data-lucide="lock"></i> Continue to secure payment</button>
            <p class="inline-message mt-2" id="topup-msg" role="status" aria-live="polite"></p>
          </form>
        </div>
      </dialog>`);
    const style = document.createElement("style");
    style.textContent = ".money-dialog .dialog-content{padding:28px 26px 24px;display:grid;gap:4px}.money-dialog h2{margin:12px 0 4px;font:600 22px/1.2 Fraunces,Georgia,serif}.money-dialog .dialog-copy{font-size:13px;margin:4px 0 14px}.money-dialog .form-field{font-size:12px;margin-top:6px}.money-dialog input{min-height:46px;padding:0 14px;border:1.5px solid var(--line);border-radius:10px;font-size:16px}.money-dialog input:focus{outline:0;border-color:var(--teal);box-shadow:0 0 0 4px #0e6b5c1f}.money-dialog .button{min-height:46px;border-radius:10px;font-size:14px;margin-top:10px}.money-dialog .inline-message{font-size:12px;min-height:18px;margin-top:10px}.money-dialog .escrow-badge{display:inline-flex;align-items:center;gap:6px;width:fit-content;padding:5px 11px;border-radius:99px;background:#e1efe8;color:var(--teal);font-size:11px;font-weight:700}.money-dialog .escrow-badge svg{width:14px;height:14px}.hidden{display:none!important}.topup-chips{display:flex;gap:8px;flex-wrap:wrap;margin:6px 0 10px}.topup-chips button{padding:8px 14px;border:1px solid var(--line);border-radius:99px;background:#fff;font-weight:700;font-size:13px;cursor:pointer}.topup-chips button:hover,.topup-chips button.on{background:var(--teal);color:#fff;border-color:var(--teal)}.wallet-note{display:flex;gap:10px;align-items:center;padding:12px 14px;border-radius:12px;background:#fbf3df;border:1px solid #ecd9a6;font-size:13px;margin-bottom:14px}.wallet-note button{margin-left:auto}";
    document.head.appendChild(style);
    refreshIcons?.(document.body);
  }

  const setMsg = (id, t, bad = true) => { const m = $(id); if (m) { m.textContent = t || ""; m.style.color = bad ? "var(--rust)" : "var(--teal)"; } };
  const post2 = (path, body) => post(path, body);

  /* ---------- Phone verification ---------- */
  function startResend(sec) {
    clearInterval(resendTimer);
    const b = $("#phone-resend"); let left = sec;
    const tick = () => { b.disabled = left > 0; b.textContent = left > 0 ? `Resend code in ${left}s` : "Resend code"; left--; if (left < 0) clearInterval(resendTimer); };
    tick(); resendTimer = setInterval(tick, 1000);
  }
  function openPhone(cb) {
    inject(); afterVerify = cb || null;
    $("#phone-step-1").classList.remove("hidden"); $("#phone-step-2").classList.add("hidden");
    $("#phone-input").value = state.user?.phone || ""; $("#phone-code").value = ""; setMsg("#phone-msg", "");
    $("#phone-dialog").showModal(); setTimeout(() => $("#phone-input").focus(), 50);
  }
  async function sendCode() {
    const phone = $("#phone-input").value.trim();
    const btn = $("#phone-send"); btn.disabled = true; setMsg("#phone-msg", "Sending…", false);
    try {
      const r = await post2("/api/phone/request", { phone });
      if (r.already_verified) { setMsg("#phone-msg", "This number is already verified.", false); await refreshUser(); return; }
      $("#phone-step-1").classList.add("hidden"); $("#phone-step-2").classList.remove("hidden");
      $("#phone-sent-to").textContent = `Code sent to ${r.phone}`;
      setMsg("#phone-msg", r.dev_code ? `Development mode: your code is ${r.dev_code}` : "", false);
      startResend(r.resend_in || 60); setTimeout(() => $("#phone-code").focus(), 50);
    } catch (e) { setMsg("#phone-msg", e.message); } finally { btn.disabled = false; }
  }
  async function confirmCode() {
    const code = $("#phone-code").value.trim();
    if (!/^\d{6}$/.test(code)) return setMsg("#phone-msg", "Enter the 6-digit code.");
    const btn = $("#phone-confirm"); btn.disabled = true;
    try {
      const r = await post2("/api/phone/verify", { code });
      state.user = r.user; $("#phone-dialog").close(); toast("Mobile number verified ✓");
      const cb = afterVerify; afterVerify = null; if (cb) cb(); else if (state.profileSection === "wallet") renderWalletSection?.();
    } catch (e) { setMsg("#phone-msg", e.message); } finally { btn.disabled = false; }
  }
  async function refreshUser() { try { const b = await api("/api/bootstrap"); state.user = b.user; } catch {} }

  /* ---------- Top-up ---------- */
  function openTopup(ctx = {}) {
    inject(); topupCtx = ctx;
    if (!state.user?.phone_verified && cfg.requirePhone) return openPhone(() => openTopup(ctx));
    const dlg = $("#topup-dialog");
    const base = ctx.shortfall ? Math.max(cfg.minTopup, ctx.shortfall) : 1000;
    $("#topup-amount").value = base; $("#topup-amount").min = cfg.minTopup; setMsg("#topup-msg", "");
    $("#topup-copy").textContent = ctx.shortfall
      ? `This task costs ${taka(ctx.price)}. Add ${taka(ctx.shortfall)} more so we can hold it safely in escrow, then your offer is accepted automatically.`
      : "Pay securely with bKash, Nagad, Rocket or a card. Your money is held safely until a task is completed.";
    const steps = [...new Set([ctx.shortfall, 500, 1000, 2000, 5000].filter((n) => n && n >= cfg.minTopup && n <= cfg.maxTopup))].slice(0, 5);
    $("#topup-chips").innerHTML = steps.map((n) => `<button type="button" data-amt="${n}">${taka(n)}</button>`).join("");
    dlg.showModal(); setTimeout(() => $("#topup-amount").select(), 50);
  }
  async function submitTopup() {
    const amount = Number($("#topup-amount").value);
    if (!Number.isInteger(amount) || amount < cfg.minTopup || amount > cfg.maxTopup) return setMsg("#topup-msg", `Enter a whole-taka amount between ${taka(cfg.minTopup)} and ${taka(cfg.maxTopup)}.`);
    const btn = $("#topup-pay"); btn.disabled = true; setMsg("#topup-msg", "Opening secure payment…", false);
    try {
      const r = await post2("/api/payments/create", { amount, offer_id: topupCtx.offerId || undefined });
      window.location.assign(r.redirect_url);
    } catch (e) {
      btn.disabled = false;
      if (e.data?.code === "phone_verification_required") { $("#topup-dialog").close(); return openPhone(() => openTopup(topupCtx)); }
      setMsg("#topup-msg", e.message);
    }
  }

  /* ---------- Funded escrow acceptance ---------- */
  async function acceptOffer(offerId) {
    try {
      const res = await post2(`/api/offers/${offerId}/accept`, {});
      await reload();
      if (state.selectedJob) renderTaskDetail?.(state.selectedJob);
      toast(`Offer accepted. ${taka(res.escrow.amount)} is now held safely in escrow. Your completion code was sent to your notifications.`);
    } catch (e) {
      if (e.data?.code === "insufficient_funds") return openTopup({ shortfall: e.data.shortfall, price: e.data.price, offerId });
      if (e.data?.code === "phone_verification_required") return openPhone(() => acceptOffer(offerId));
      toast(e.message);
    }
  }

  /* ---------- Return from the payment gateway ---------- */
  async function handleReturn() {
    const q = new URLSearchParams(location.search);
    const status = q.get("payment"); if (!status) return;
    const offer = q.get("offer");
    history.replaceState({}, "", location.pathname);
    for (let i = 0; i < 40 && !state.user; i++) await new Promise((r) => setTimeout(r, 150));
    if (status === "success") {
      toast("Payment received. Your wallet has been topped up ✓");
      try { await reload(); } catch {}
      if (offer) return acceptOffer(Number(offer));
    } else if (status === "review") toast("Payment received and under a quick safety review. We will credit your wallet shortly.");
    else if (status === "pending") toast("We are confirming your payment. Your wallet will update in a moment.");
    else if (status === "cancelled") toast("Payment cancelled. You were not charged.");
    else toast("Payment was not completed. You were not charged.");
    document.querySelector("#sidebar-wallet-btn")?.click();
  }

  /* ---------- Wallet screen helpers (called from renderWalletSection) ---------- */
  function walletBanner() {
    if (state.user?.phone_verified) return `<div class="wallet-note" style="background:#e7f3ee;border-color:#bcdccf"><i data-lucide="badge-check"></i><span>Mobile number <b>${esc(state.user.phone)}</b> is verified.</span></div>`;
    return `<div class="wallet-note"><i data-lucide="smartphone"></i><span>Verify your mobile number to add money, place bids and request payouts.</span><button class="button button-teal text-xs" type="button" data-verify-phone>Verify now</button></div>`;
  }

  function bind() {
    document.addEventListener("submit", (e) => {
      if (e.target.id === "phone-form") { e.preventDefault(); ($("#phone-step-2").classList.contains("hidden") ? sendCode() : confirmCode()); }
      if (e.target.id === "topup-form") { e.preventDefault(); submitTopup(); }
    });
    document.addEventListener("click", (e) => {
      const t = e.target;
      if (t.closest("#phone-resend") && !t.closest("#phone-resend").disabled) sendCode();
      if (t.closest("#phone-change")) { $("#phone-step-2").classList.add("hidden"); $("#phone-step-1").classList.remove("hidden"); setMsg("#phone-msg", ""); }
      const sec = t.closest("[data-profile-section]");
      if (sec) { e.preventDefault(); if (sec.dataset.profileSection === "wallet") renderWalletSection(); else renderProfile(); }
      if (t.closest("[data-verify-phone]")) openPhone();
      if (t.closest("#topup-btn")) openTopup();
      const chip = t.closest("[data-amt]"); if (chip) { $("#topup-amount").value = chip.dataset.amt; }
      const acc = t.closest("[data-accept-offer]"); if (acc) { e.preventDefault(); e.stopImmediatePropagation(); acceptOffer(Number(acc.dataset.acceptOffer)); }
    }, true);
  }

  window.ServiMoney = { openPhone, askPhone: () => openPhone(), openTopup, acceptOffer, walletBanner, config: () => cfg };
  (async () => {
    inject(); bind();
    try { cfg = { ...cfg, ...(await api("/api/config")) }; } catch {}
    handleReturn();
  })();
})();
