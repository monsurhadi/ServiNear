/**
 * capture-screenshots.js
 * Captures notification screenshots for the presentation:
 *   - 07-notifications-drawer.png  (bell dropdown open)
 *   - 08-notifications-full-page.png  (full /notifications page)
 *
 * Key fix: intercepts runtime-config.js to point SERVINEAR_API_BASE at
 * the local server instead of the hardcoded production URL.
 *
 * Usage:  node scripts/capture-screenshots.js
 */
"use strict";

const { chromium } = require("playwright");
const { spawn }    = require("child_process");
const http         = require("http");
const path         = require("path");
const fs           = require("fs");

const PORT      = 4021;
const BASE      = `http://localhost:${PORT}`;
const ARTIFACT  = "C:\\Users\\Asad\\.gemini\\antigravity\\brain\\5a3c9770-bfc1-47ff-a1a2-bd0c1f223168";

const DEMO_EMAIL    = "nusrat.jahan@gmail.com";
const DEMO_PASSWORD = "ServiNear123!";

// ── helpers ──────────────────────────────────────────────────────────────────
function waitForPort(port, timeoutMs = 40000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    function attempt() {
      http.get(`http://localhost:${port}/api/health`, (r) => {
        if (r.statusCode < 500) return resolve();
        schedule();
      }).on("error", schedule);
      function schedule() {
        if (Date.now() > deadline) reject(new Error("Server start timeout"));
        else setTimeout(attempt, 500);
      }
    }
    attempt();
  });
}

async function apiFetch(urlPath, opts = {}) {
  const url = BASE + urlPath;
  const res = await fetch(url, { ...opts });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { _raw: text }; }
  return { status: res.status, ok: res.ok, data };
}

async function shot(page, name) {
  const dest = path.join(ARTIFACT, name);
  await page.screenshot({ path: dest, fullPage: true });
  const kb = (fs.statSync(dest).size / 1024).toFixed(0);
  console.log(`  ✓ Saved ${name}  (${kb} KB)`);
  return Number(kb);
}

// ── main ─────────────────────────────────────────────────────────────────────
(async () => {
  // ── 1. Start server ────────────────────────────────────────────────────────
  console.log(`\n[1] Starting local server on port ${PORT}…`);
  const env = {
    ...process.env,
    PORT: String(PORT),
    SEED_DEMO_DATA: "true",
    NODE_ENV: "development",
  };
  const srv = spawn("node", ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  srv.stdout.on("data", d => process.stdout.write("  srv> " + d.toString()));
  srv.stderr.on("data", d => process.stderr.write("  srv! " + d.toString()));
  process.on("exit", () => { try { srv.kill(); } catch {} });

  await waitForPort(PORT);
  console.log(`[1] Server ready ✓`);

  // ── 2. Log in as demo customer via API ────────────────────────────────────
  console.log(`\n[2] Logging in as ${DEMO_EMAIL}…`);
  const loginResp = await apiFetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: DEMO_EMAIL, password: DEMO_PASSWORD }),
  });
  if (!loginResp.ok) throw new Error(`Login failed (${loginResp.status}): ${JSON.stringify(loginResp.data)}`);
  const token    = loginResp.data.token || loginResp.data.session_token;
  const nusratId = loginResp.data.user?.id;
  if (!token) throw new Error("No token: " + JSON.stringify(loginResp.data));
  console.log(`[2] Signed in: id=${nusratId}, name=${loginResp.data.user?.name}`);

  const authHdr = { "Authorization": `Bearer ${token}` };

  // ── 3. Check & seed notifications ────────────────────────────────────────
  const checkResp = await apiFetch("/api/notifications", { headers: authHdr });
  let notifs = checkResp.data.notifications ?? [];
  console.log(`\n[3] Existing notifications: ${notifs.length}`);

  if (notifs.length < 2) {
    console.log("[3] Seeding notifications…");

    async function workerLogin(email) {
      const r = await apiFetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: "ServiNear123!" }),
      });
      if (!r.ok) { console.log(`  ⚠ Worker login failed: ${email} → ${r.status}`); return null; }
      return r.data.token || r.data.session_token;
    }

    // Tanvir (electrician) sends Nusrat a message → "New message from Engr. Tanvir Hasan"
    const tanvirToken = await workerLogin("tanvir.electrician@gmail.com");
    if (tanvirToken && nusratId) {
      const r = await apiFetch("/api/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${tanvirToken}` },
        body: JSON.stringify({ recipient_id: nusratId, content: "Hello Nusrat! I saw your AC servicing request and I am available this week. I also handle minor electrical checks during appliance visits." }),
      });
      console.log(`  → Tanvir→Nusrat message: HTTP ${r.status}`);
    }

    // Nazmul (plumber) sends Nusrat a message
    const nazmulToken = await workerLogin("nazmul.plumbing@gmail.com");
    if (nazmulToken && nusratId) {
      const r = await apiFetch("/api/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${nazmulToken}` },
        body: JSON.stringify({ recipient_id: nusratId, content: "Hi! I am a master plumber in Dhanmondi. If you need any pipe inspection or water pump maintenance, I can visit same-day." }),
      });
      console.log(`  → Nazmul→Nusrat message: HTTP ${r.status}`);
    }

    // Rashed (removals) sends Nusrat a message
    const rashedToken = await workerLogin("rashed.cargo@gmail.com");
    if (rashedToken && nusratId) {
      const r = await apiFetch("/api/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${rashedToken}` },
        body: JSON.stringify({ recipient_id: nusratId, content: "Hello! Saw your profile on ServiNear. I provide covered pickup van services for home shifting, available on weekends." }),
      });
      console.log(`  → Rashed→Nusrat message: HTTP ${r.status}`);
    }

    // Also try to submit a new offer on Job#1 (may already exist → 409 is fine)
    const shamimToken = await workerLogin("shamim.ac.expert@gmail.com");
    if (shamimToken) {
      const r = await apiFetch("/api/jobs/1/offers", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${shamimToken}` },
        body: JSON.stringify({ price: 2800, message: "Daikin & Gree specialist, 11 years experience. Chemical wash + R410A gas refill + drain unclog. Can visit Dhanmondi 27 tomorrow morning." }),
      });
      console.log(`  → Shamim offer on Job#1: HTTP ${r.status} ${r.ok ? "✓" : "(already exists)"}`);
    }

    await new Promise(r => setTimeout(r, 600));
    const recheck = await apiFetch("/api/notifications", { headers: authHdr });
    notifs = recheck.data.notifications ?? [];
    console.log(`[3] Notifications after seeding: ${notifs.length}`);
  }

  // ── 4. Launch Playwright ──────────────────────────────────────────────────
  console.log("\n[4] Launching browser…");
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
  });

  const ctx = await browser.newContext({
    viewport:          { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    locale:            "en-GB",
    colorScheme:       "light",
  });

  // KEY FIX: intercept runtime-config.js and replace the API base URL
  // so the browser talks to the local server instead of production Render.
  await ctx.route("**/runtime-config.js*", (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: `"use strict";\nwindow.SERVINEAR_API_BASE = "${BASE}";\n`,
    });
  });

  // Also inject the token into localStorage before any script runs
  await ctx.addInitScript((tk) => {
    try { localStorage.setItem("servinear_token", tk); } catch {}
  }, token);

  const page = await ctx.newPage();
  page.on("console", m => {
    const type = m.type();
    if (type === "error" || type === "warn") {
      const txt = m.text();
      // Skip noisy CSP/network errors about production URL
      if (txt.includes("servinear-api.onrender.com") || txt.includes("Content Security Policy")) return;
      console.log(`  browser[${type}]: ${txt.slice(0, 160)}`);
    }
  });
  page.on("pageerror", err => console.error("  PAGE ERR:", err.message.slice(0, 200)));

  // ── 5. Load homepage ──────────────────────────────────────────────────────
  console.log("[5] Loading app…");
  await page.goto(BASE, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(2500);

  // Verify we're logged in — the bell button is hidden when logged out
  // The HTML id is #notif-toggle-btn (not #notif-nav-btn)
  const isLoggedIn = await page.locator("#notif-toggle-btn:not(.hidden)").isVisible().catch(() => false);
  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 400));
  console.log(`[5] Auth check (notif-btn visible): ${isLoggedIn}`);
  console.log(`[5] Page body: ${bodyText.replace(/\n/g, " ").slice(0, 200)}`);

  if (!isLoggedIn) {
    // Even if button is hidden, the app may be showing user info
    const hasLogout = bodyText.toLowerCase().includes("log out") || bodyText.toLowerCase().includes("logout");
    if (!hasLogout) {
      throw new Error("Not logged in — aborting. Check token injection and runtime-config override.");
    }
    console.log("[5] User IS logged in (Log out text found). Button may need unhiding via JS…");
    // Force the button to be visible
    await page.evaluate(() => {
      const btn = document.querySelector("#notif-toggle-btn");
      if (btn) btn.classList.remove("hidden");
    });
    await page.waitForTimeout(500);
  }

  // ── 6. Screenshot: Notifications Drawer ──────────────────────────────────
  console.log("\n[6] Opening notifications drawer…");
  const bellBtn = page.locator("#notif-toggle-btn");
  await bellBtn.click();
  await page.waitForTimeout(1500);

  // Wait for notifications to populate in the drawer
  await page.waitForFunction(() => {
    const list = document.querySelector("#notif-list");
    return list && list.querySelectorAll(".notif-item").length > 0;
  }, { timeout: 8000 }).catch(() => console.log("  ⚠ Drawer may be empty"));

  await page.waitForTimeout(500);
  const kb7 = await shot(page, "07-notifications-drawer.png");

  // Close drawer
  await page.evaluate(() => {
    document.querySelector("#notif-drawer")?.classList.add("hidden");
    document.querySelector("#notif-toggle-btn")?.setAttribute("aria-expanded", "false");
  });
  await page.waitForTimeout(400);

  // ── 7. Full /notifications page ───────────────────────────────────────────
  console.log("\n[7] Navigating to /notifications page…");
  // Use the app's navigate() function which handles routing correctly
  await page.evaluate(() => {
    if (typeof navigate === "function") navigate("/notifications");
    else { history.pushState({}, "", "/notifications"); window.dispatchEvent(new PopStateEvent("popstate")); }
  });
  await page.waitForTimeout(2000);

  // Wait for the full notifications list to have items
  await page.waitForFunction(() => {
    const el = document.querySelector("#notifications-full-list");
    return el && el.querySelectorAll(".notif-item").length > 0;
  }, { timeout: 10000 }).catch(() => console.log("  ⚠ Full-page list may be empty"));

  await page.waitForTimeout(600);
  const kb8 = await shot(page, "08-notifications-full-page.png");

  // ── 8. Cleanup ────────────────────────────────────────────────────────────
  await browser.close();
  srv.kill();

  console.log(`\n${"=".repeat(60)}`);
  console.log("✅  Screenshots captured!");
  console.log(`   07-notifications-drawer.png  : ${kb7} KB`);
  console.log(`   08-notifications-full-page.png: ${kb8} KB`);

  if (kb8 < 150) {
    console.warn("\n  ⚠ Full-page screenshot looks small (<150KB). Notifications may not have loaded.");
  } else {
    console.log("\n  ✓ Both screenshots look good!");
  }

  process.exit(0);
})().catch((err) => {
  console.error("\n❌ Script error:", err.message ?? err);
  process.exit(1);
});
