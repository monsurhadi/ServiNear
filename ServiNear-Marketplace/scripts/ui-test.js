"use strict";
// UI quality gate: runs the real app in Chromium and fails on accessibility violations (axe, WCAG 2.1 AA),
// sideways scrolling on phones, missing translations, missing focus rings and unreachable controls.
// Needs a browser:  npx playwright install --with-deps chromium     Run with:  npm run test:ui
const { spawn } = require("node:child_process");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { chromium } = require("playwright");
const axeSource = fs.readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

const PORT = 5089, B = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sn-ui-"));
const server = spawn(process.execPath, ["server.js"], { cwd: path.join(__dirname, ".."), stdio: "ignore",
  env: { ...process.env, PORT, DATA_DIR: dir, NODE_ENV: "development", SEED_DEMO_DATA: "true", EMAIL_PROVIDER: "console", PAYMENT_PROVIDER: "mock" } });
let failed = 0;
const ok = (name, cond, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  -> " + extra}`); if (!cond) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PUBLIC = ["/", "/categories", "/jobs", "/hot-offers", "/about", "/how-it-works", "/help"];
const PRIVATE = ["/profile", "/inbox", "/saved", "/tasks/1"];
const VIEWPORTS = { desktop: { width: 1360, height: 900 }, phone: { width: 390, height: 844, isMobile: true, hasTouch: true }, small: { width: 360, height: 780, isMobile: true, hasTouch: true } };
const AXE = "axe.run(document,{runOnly:['wcag2a','wcag2aa','wcag21aa','best-practice']}).then(r=>r.violations.map(v=>v.id+' x'+v.nodes.length+' '+v.nodes[0].target.join(' ').slice(0,60)))";

async function newPage(browser, vp, login) {
  const ctx = await browser.newContext(vp);
  await ctx.route("**/runtime-config.js*", (r) => r.fulfill({ contentType: "application/javascript", body: `window.SERVINEAR_API_BASE="${B}";` }));
  await ctx.route(/tile\.openstreetmap\.org|fonts\.g/, (r) => r.abort());
  if (login) await ctx.request.post(B + "/api/auth/login", { data: { email: "khadija.akhter@gmail.com", password: "ServiNear123!" } });
  const page = await ctx.newPage(); const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  return { ctx, page, errors };
}

(async () => {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(B + "/api/health")).ok) break; } catch {} await sleep(400); }
  const browser = await chromium.launch();
  try {
    console.log("\n-- Accessibility (axe, WCAG 2.1 AA) and layout");
    for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
      for (const login of [false, true]) {
        const { ctx, page, errors } = await newPage(browser, vp, login);
        const problems = [], overflow = [];
        for (const p of PUBLIC.concat(login ? PRIVATE : ["/tasks/1"])) {
          await page.goto(B + p); await sleep(1100);
          if (vpName === "desktop") { await page.evaluate(axeSource); const v = await page.evaluate(AXE); if (v.length) problems.push(p + ": " + v.join("; ")); }
          if ((await page.evaluate("document.documentElement.scrollWidth - innerWidth")) > 0) overflow.push(p);
        }
        if (vpName === "desktop") ok(`axe: no violations (${login ? "signed in" : "signed out"})`, !problems.length, problems.join(" | "));
        ok(`${vpName} ${login ? "signed in" : "signed out"}: no sideways scrolling`, !overflow.length, overflow.join(", "));
        ok(`${vpName} ${login ? "signed in" : "signed out"}: no JavaScript errors`, !errors.length, errors[0]);
        await ctx.close();
      }
    }

    console.log("\n-- Dialogs and panels");
    { const { ctx, page } = await newPage(browser, VIEWPORTS.desktop, true); const bad = [];
      await page.goto(B); await sleep(1200);
      for (const [name, js] of [["post task", "openJobDialog()"], ["phone", "ServiMoney.openPhone()"], ["top-up", "ServiMoney.openTopup()"]]) {
        await page.evaluate("document.querySelectorAll('dialog[open]').forEach(d=>d.close())"); await page.evaluate(js); await sleep(350);
        await page.evaluate(axeSource); const v = await page.evaluate(AXE); if (v.length) bad.push(name + ": " + v.join("; "));
      }
      await page.goto(B + "/profile"); await sleep(900); await page.evaluate("state.settingsTab='notifications'; renderSettingsView(document.querySelector('#profile-workspace'),0)"); await sleep(300);
      await page.evaluate(axeSource); const sv = await page.evaluate(AXE); if (sv.length) bad.push("settings: " + sv.join("; "));
      ok("axe: dialogs and settings have no violations", !bad.length, bad.join(" | ")); await ctx.close(); }

    console.log("\n-- Language");
    for (const lang of ["en", "bn"]) {
      const { ctx, page } = await newPage(browser, VIEWPORTS.desktop, false);
      await page.addInitScript((l) => localStorage.setItem("servinear_lang", l), lang);
      const missing = [];
      for (const p of ["/", "/jobs", "/help", "/how-it-works", "/about"]) {
        await page.goto(B + p); await sleep(900);
        const r = await page.evaluate(() => ({ lang: document.documentElement.lang, title: document.title, miss: [...new Set([...document.querySelectorAll("[data-i18n]")].map((e) => e.dataset.i18n))].filter((k) => !I18N[state.lang][k]) }));
        if (r.lang !== lang) missing.push(p + " html lang=" + r.lang); if (r.miss.length) missing.push(p + " missing " + r.miss.join(",")); if (/^ServiNear \|/.test(r.title)) missing.push(p + " generic title");
      }
      ok(`${lang}: every string translated, html lang and page titles set`, !missing.length, missing.join(" | "));
      if (lang === "bn") { await page.goto(B); await sleep(900); const chips = await page.evaluate("[...document.querySelectorAll('#finder-chips .chip')].map(c=>c.textContent)"); ok("bn: category names are translated", chips.length > 0 && chips.every((c) => /[\u0980-\u09FF]/.test(c)), chips.join(",")); }
      await ctx.close();
    }
    { const ctx = await browser.newContext({ locale: "bn-BD" }); const page = await ctx.newPage();
      await page.route("**/runtime-config.js*", (r) => r.fulfill({ contentType: "application/javascript", body: `window.SERVINEAR_API_BASE="${B}";` })); await page.route(/tile\.openstreetmap\.org|fonts\.g/, (r) => r.abort());
      await page.goto(B); await sleep(700); ok("a Bangla browser gets Bangla by default", (await page.evaluate("state.lang")) === "bn"); await ctx.close(); }

    console.log("\n-- Keyboard");
    { const { ctx, page } = await newPage(browser, VIEWPORTS.desktop, false); await page.goto(B); await sleep(1300);
      await page.keyboard.press("Tab"); await sleep(300);
      ok("first Tab reaches the skip link", (await page.evaluate("document.activeElement.className")) === "skip-link");
      await page.keyboard.press("Enter"); await sleep(150); ok("skip link moves focus to main content", (await page.evaluate("document.activeElement.id")) === "main");
      await page.goto(B); await sleep(1200); const seen = [];
      for (let i = 0; i < 36; i++) { await page.keyboard.press("Tab"); await sleep(220);
        const r = await page.evaluate(() => { const e = document.activeElement; const cs = getComputedStyle(e); const wrap = e.closest(".finder-field") || e.closest(".toggle-control")?.querySelector(".toggle-track"); const wcs = wrap && getComputedStyle(wrap);
          return { name: (e.getAttribute("aria-label") || e.textContent || e.id || e.tagName).trim().slice(0, 24), ring: (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) >= 2) || (wcs && wcs.outlineStyle !== "none") || cs.borderTopColor !== cs.borderBottomColor, tag: e.tagName }; });
        if (r.tag !== "BODY") seen.push(r); }
      const noRing = seen.filter((s) => !s.ring).map((s) => s.name);
      ok(`all ${seen.length} keyboard stops show a focus indicator`, !noRing.length, noRing.join(", "));
      await page.goto(B); await sleep(1000); await page.focus("#auth-button"); await page.keyboard.press("Enter"); await sleep(350);
      ok("dialog opens by keyboard and traps focus inside", await page.evaluate("!!document.activeElement.closest('dialog')"));
      await page.keyboard.press("Escape"); await sleep(250); ok("Escape closes the dialog", await page.evaluate("!document.querySelector('dialog[open]')"));
      const small = await page.evaluate(() => [...document.querySelectorAll("button, a.button, .nav-link, select")].filter((e) => e.offsetParent !== null && e.getBoundingClientRect().height < 36).map((e) => (e.getAttribute("aria-label") || e.textContent || e.id).trim().slice(0, 20)));
      ok("interactive controls are at least 36px tall", !small.length, small.join(", ")); await ctx.close(); }
  } finally { await browser.close(); server.kill(); fs.rmSync(dir, { recursive: true, force: true }); }
})().catch((e) => { console.error(e); failed++; }).finally(() => { console.log(failed ? `\n${failed} check(s) failed` : "\nAll UI checks passed"); process.exit(failed ? 1 : 0); });
