"use strict";
// Semantic search: boots the app against a local mock embedding provider and checks ranking, fallback and cost controls.
const { spawn } = require("node:child_process");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const mock = require("./mock-embedding-server");
const PORT = 5096, B = `http://127.0.0.1:${PORT}`;
let failed = 0; const ok = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : "  -> " + x}`); if (!c) failed++; };
(async () => {
  const m = await mock.start(5095); const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sn-search-"));
  const server = spawn(process.execPath, ["server.js"], { cwd: path.join(__dirname, ".."), stdio: "ignore",
    env: { ...process.env, PORT, DATA_DIR: dir, NODE_ENV: "development", SEED_DEMO_DATA: "true", EMBEDDING_BASE_URL: "http://127.0.0.1:5095/v1", EMBEDDING_MODEL: "test-embed", EMBEDDING_API_KEY: "test-key", EMBEDDING_QUERY_TIMEOUT_MS: "800" } });
  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(B + "/api/health")).ok) break; } catch {} await new Promise((r) => setTimeout(r, 400)); }
    await new Promise((r) => setTimeout(r, 2500));
    const q = async (s) => (await fetch(`${B}/api/vector/search?type=workers&limit=5&q=${encodeURIComponent(s)}`)).json();
    const r1 = await q("something to cool my room");
    ok("uses the external embedding provider", /semantic:test-embed/.test(r1.engine), r1.engine);
    ok("finds the AC specialist with zero shared keywords", r1.results[0]?.category === "Appliances" && r1.results[0].keyword === 0, JSON.stringify(r1.results[0]));
    const r2 = await q("water dripping under kitchen sink");
    ok("routes a plumbing problem to plumbers", r2.results[0]?.category === "Plumbing");
    const callsBefore = m.calls.count; await q("water dripping under kitchen sink");
    ok("repeat queries are served from cache (no extra paid call)", m.calls.count === callsBefore);
    ok("provider key never leaks to the client", !JSON.stringify(r1).includes("test-key"));
    const reg = await fetch(B + "/api/auth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ first_name: "Rina", surname: "Akter", email: "rina@example.com", password: "Passw0rd!long", role: "worker", gender: "female", city: "Dhaka", occupation: "ac technician", phone: "01712121212", area: "Uttara", address: "Sector 4", category: "Appliances", rate: 700, bio: "Air conditioner gas refill and cooling repair specialist" }) });
    await new Promise((r) => setTimeout(r, 1500));
    const r3 = await q("my air conditioner stopped cooling");
    ok("newly registered providers become searchable", reg.status === 201 && r3.results.some((x) => x.title.includes("Rina")), JSON.stringify(r3.results.map((x) => x.title)));
    ok("anonymous callers cannot read index internals", (await fetch(B + "/api/vector/stats")).status === 401);
    m.srv.close(); m.srv.closeAllConnections?.();
    const r4 = await (await fetch(`${B}/api/vector/search?type=workers&q=${encodeURIComponent("plumber leak urgent now")}`)).json();
    ok("provider outage degrades to keyword search instead of failing", r4.engine === "keyword-fallback" && r4.results.length > 0, JSON.stringify(r4).slice(0, 200));
    let limited = false; for (let i = 0; i < 45; i++) if ((await fetch(`${B}/api/vector/search?q=spam${i}`)).status === 429) limited = true;
    ok("search is rate-limited to cap provider spend", limited);

  } finally { server.kill(); m.srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
})().catch((e) => { console.error(e); failed++; }).finally(() => { console.log(failed ? `\n${failed} check(s) failed` : "\nAll search checks passed"); process.exit(failed ? 1 : 0); });
