"use strict";
// Payment gateways. SSLCOMMERZ is the production provider (it fronts bKash, Nagad, Rocket, cards and banking).
// "mock" is a local stand-in for development and automated tests; it is refused when NODE_ENV=production.
//
// Contract:
//   init({ tranId, amount, user, urls })  -> { gatewayUrl, sessionKey }
//   validate({ valId, tranId, amount })   -> { valid, status, amount, bankTranId, method, riskLevel, raw }
// A callback from the browser or an IPN is NEVER trusted on its own: every payment is confirmed server-to-server.

const crypto = require("node:crypto");

function sslcommerz(env) {
  const live = env.SSLCOMMERZ_LIVE === "1";
  const host = live ? "https://securepay.sslcommerz.com" : "https://sandbox.sslcommerz.com";
  const storeId = env.SSLCOMMERZ_STORE_ID, storePass = env.SSLCOMMERZ_STORE_PASSWORD;
  return {
    provider: "sslcommerz",
    enabled: Boolean(storeId && storePass),
    live,
    async init({ tranId, amount, user, urls }) {
      const form = new URLSearchParams({
        store_id: storeId, store_passwd: storePass, total_amount: String(amount), currency: "BDT", tran_id: tranId,
        success_url: urls.success, fail_url: urls.fail, cancel_url: urls.cancel, ipn_url: urls.ipn,
        cus_name: user.name || "ServiNear user", cus_email: user.email || "noreply@servinear.local", cus_add1: user.address || user.area || "Dhaka",
        cus_city: user.city || "Dhaka", cus_postcode: "1200", cus_country: "Bangladesh", cus_phone: user.phone || "01700000000",
        shipping_method: "NO", product_name: "ServiNear wallet top-up", product_category: "Service", product_profile: "non-physical-goods",
        value_a: String(user.id)
      });
      const res = await fetch(`${host}/gwprocess/v4/api.php`, { method: "POST", body: form, signal: AbortSignal.timeout(15000) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.status !== "SUCCESS" || !json.GatewayPageURL) throw new Error(`SSLCOMMERZ could not start the payment${json.failedreason ? ": " + json.failedreason : ""}`);
      return { gatewayUrl: json.GatewayPageURL, sessionKey: json.sessionkey || null };
    },
    async validate({ valId, tranId, amount }) {
      const q = new URLSearchParams({ val_id: valId, store_id: storeId, store_passwd: storePass, v: "1", format: "json" });
      const res = await fetch(`${host}/validator/api/validationserverAPI.php?${q}`, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`SSLCOMMERZ validation failed (${res.status})`);
      const j = await res.json();
      const statusOk = j.status === "VALID" || j.status === "VALIDATED";
      const currencyOk = !j.currency_type || j.currency_type === "BDT";
      const amountOk = Math.abs(Number(j.amount) - Number(amount)) < 0.01;
      return {
        valid: statusOk && currencyOk && amountOk && j.tran_id === tranId,
        status: j.status, amount: Number(j.amount), bankTranId: j.bank_tran_id || null, method: j.card_type || null,
        riskLevel: j.risk_level === undefined ? 0 : Number(j.risk_level), raw: j
      };
    }
  };
}

function mock(env) {
  const sessions = new Map(); // tranId -> { amount, state: 'created'|'paid'|'failed'|'cancelled', valId }
  return {
    provider: "mock",
    enabled: env.NODE_ENV !== "production",
    live: false,
    sessions,
    async init({ tranId, amount, urls }) {
      sessions.set(tranId, { amount, state: "created", valId: null, urls });
      return { gatewayUrl: `${urls.base}/api/payments/mock/checkout?tran_id=${encodeURIComponent(tranId)}`, sessionKey: "mock-" + tranId };
    },
    // Test hooks that emulate the customer's action on the hosted payment page.
    complete(tranId, state) {
      const s = sessions.get(tranId); if (!s) return null;
      s.state = state; if (state === "paid") s.valId = "mockval-" + crypto.randomBytes(6).toString("hex");
      return s;
    },
    async validate({ valId, tranId, amount }) {
      const s = sessions.get(tranId);
      const ok = Boolean(s && s.state === "paid" && s.valId === valId);
      const tamper = env.MOCK_PAY_TAMPER_AMOUNT ? Number(env.MOCK_PAY_TAMPER_AMOUNT) : null;
      const paidAmount = tamper ?? (s ? s.amount : 0);
      return { valid: ok && Math.abs(paidAmount - Number(amount)) < 0.01, status: ok ? "VALID" : "INVALID", amount: paidAmount,
        bankTranId: ok ? "MOCKBANK" + tranId.slice(-6) : null, method: "mock", riskLevel: env.MOCK_PAY_RISKY ? 1 : 0, raw: { mock: true } };
    }
  };
}

function createGateway(env = process.env) {
  const want = String(env.PAYMENT_PROVIDER || (env.NODE_ENV === "production" ? "sslcommerz" : "mock")).toLowerCase();
  if (want === "mock") return env.NODE_ENV === "production" ? { provider: "none", enabled: false } : mock(env);
  if (want === "sslcommerz") return sslcommerz(env);
  return { provider: "none", enabled: false };
}

module.exports = { createGateway };
