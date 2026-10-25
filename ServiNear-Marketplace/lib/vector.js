"use strict";
// Semantic search over providers and tasks.
//  - Vectors are stored as binary Float32 BLOBs in SQLite, with the model id that produced them.
//  - Search keeps an in-memory copy (fast for tens of thousands of rows; move to pgvector beyond that).
//  - Embedding happens in a background queue so writes never wait on a network call.
//  - Ranking is hybrid: semantic similarity + keyword match + verified + rating + proximity.
const crypto = require("node:crypto");
const { normalise } = require("./embeddings");

const TOKEN_SPLIT = /[^\p{L}\p{N}]+/u;
const STOP = new Set(["the", "a", "an", "for", "and", "or", "to", "in", "of", "my", "me", "i", "need", "want", "near", "please", "is", "at", "on", "with", "এবং", "আমার", "দরকার", "চাই"]);
const tokens = (s) => String(s || "").toLowerCase().split(TOKEN_SPLIT).filter((t) => t.length > 1 && !STOP.has(t));
const sha = (s) => crypto.createHash("sha1").update(s).digest("hex");
const toBlob = (f32) => Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
const fromBlob = (b) => { const u = new Uint8Array(b); return new Float32Array(u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength)); };
function dot(a, b) { if (a.length !== b.length) return 0; let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }
function km(a, b) {
  const R = 6371, r = (x) => (x * Math.PI) / 180, dLa = r(b.lat - a.lat), dLo = r(b.lng - a.lng);
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function skillText(s) {
  if (Array.isArray(s)) return s.join(" ");
  if (typeof s === "string" && s.trim().startsWith("[")) { try { return JSON.parse(s).join(" "); } catch { /* fall through */ } }
  return s || "";
}

function createVectorService({ db, embedder, hashEmbed, log = console }) {
  const MODEL = embedder.id;
  const mem = new Map(); // "type:id" -> { type,id,title,category,area,content,toks,vec,model }
  const queue = new Set();
  const qCache = new Map(); // query -> { vec, at }
  let pumping = false, lastError = null, lastEmbedAt = null;

  // ---- schema ----
  const cols = db.prepare("PRAGMA table_info(vector_index)").all().map((c) => c.name);
  for (const [c, def] of [["embedding", "BLOB"], ["model", "TEXT"], ["content_hash", "TEXT"], ["embedded_hash", "TEXT"]])
    if (!cols.includes(c)) db.exec(`ALTER TABLE vector_index ADD COLUMN ${c} ${def}`);

  const upsertMeta = db.prepare(`
    INSERT INTO vector_index(entity_type,entity_id,title,category,area,content,vector,content_hash,updated_at)
    VALUES(?,?,?,?,?,?,'[]',?,CURRENT_TIMESTAMP)
    ON CONFLICT(entity_type,entity_id) DO UPDATE SET title=excluded.title,category=excluded.category,area=excluded.area,
      content=excluded.content,content_hash=excluded.content_hash,updated_at=CURRENT_TIMESTAMP`);
  const setVector = db.prepare("UPDATE vector_index SET embedding=?,model=?,embedded_hash=? WHERE entity_type=? AND entity_id=?");
  const getRow = db.prepare("SELECT * FROM vector_index WHERE entity_type=? AND entity_id=?");

  function remember(row, vec, model) {
    mem.set(`${row.entity_type}:${row.entity_id}`, {
      type: row.entity_type, id: row.entity_id, title: row.title, category: row.category, area: row.area,
      content: row.content, toks: new Set(tokens(`${row.title} ${row.category} ${row.area} ${row.content}`)), vec, model
    });
  }

  function load() {
    mem.clear();
    for (const row of db.prepare("SELECT * FROM vector_index").all()) {
      const vec = row.embedding ? fromBlob(row.embedding) : null;
      remember(row, vec, row.model || null);
    }
  }

  // ---- indexing ----
  function upsert(type, e) {
    if (!e || !e.id) return;
    const isWorker = type === "worker";
    const title = isWorker ? e.name : e.title;
    const content = isWorker
      ? [e.name, e.category, e.area, e.city, e.bio, e.occupation, skillText(e.skills)].filter(Boolean).join(" ")
      : [e.title, e.category, e.area, e.details].filter(Boolean).join(" ");
    const hash = sha(content);
    const before = getRow.get(type, e.id);
    upsertMeta.run(type, e.id, title || "", e.category || "General", e.area || "", content, hash);
    const row = getRow.get(type, e.id);
    if (!embedder.enabled) {
      // No external provider: use the built-in lexical-semantic hash vector, computed synchronously.
      const vec = normalise(hashEmbed(content));
      setVector.run(toBlob(vec), MODEL, hash, type, e.id);
      remember(row, vec, MODEL);
      return;
    }
    const stale = before && before.embedding ? fromBlob(before.embedding) : null;
    remember(row, stale, before?.model || null); // keep the old vector searchable until the new one arrives
    if (!before || before.embedded_hash !== hash || before.model !== MODEL) { queue.add(`${type}:${e.id}`); pump(); }
  }

  function remove(type, id) { db.prepare("DELETE FROM vector_index WHERE entity_type=? AND entity_id=?").run(type, id); mem.delete(`${type}:${id}`); queue.delete(`${type}:${id}`); }

  async function pump() {
    if (pumping || !embedder.enabled || !queue.size) return;
    pumping = true;
    try {
      while (queue.size) {
        const keys = [...queue].slice(0, 32);
        const rows = keys.map((k) => { const [t, id] = k.split(":"); return getRow.get(t, Number(id)); }).filter(Boolean);
        keys.forEach((k) => queue.delete(k));
        if (!rows.length) continue;
        try {
          const vecs = await embedder.embedDocuments(rows.map((r) => r.content));
          rows.forEach((r, i) => { setVector.run(toBlob(vecs[i]), MODEL, r.content_hash, r.entity_type, r.entity_id); remember(r, vecs[i], MODEL); });
          lastEmbedAt = new Date().toISOString(); lastError = null;
        } catch (e) {
          lastError = e.message; log.warn?.("Embedding batch failed:", e.message);
          keys.forEach((k) => queue.add(k)); // retry later
          await new Promise((r) => setTimeout(r, 15000));
          break;
        }
      }
    } finally { pumping = false; }
  }
  const timer = setInterval(() => pump(), 20000); timer.unref();

  // Re-embed everything that was produced by a different model or from older content.
  function backfill() {
    let n = 0;
    for (const r of db.prepare("SELECT entity_type,entity_id,content,content_hash,embedded_hash,model,embedding FROM vector_index").all()) {
      if (!embedder.enabled) {
        if (r.model !== MODEL || !r.embedding) { const vec = normalise(hashEmbed(r.content)); setVector.run(toBlob(vec), MODEL, r.content_hash || sha(r.content), r.entity_type, r.entity_id); n++; }
      } else if (r.model !== MODEL || r.embedded_hash !== r.content_hash || !r.embedding) { queue.add(`${r.entity_type}:${r.entity_id}`); n++; }
    }
    load(); pump();
    return n;
  }

  function ensureHashes() {
    for (const r of db.prepare("SELECT entity_type,entity_id,content FROM vector_index WHERE content_hash IS NULL").all())
      db.prepare("UPDATE vector_index SET content_hash=? WHERE entity_type=? AND entity_id=?").run(sha(r.content), r.entity_type, r.entity_id);
  }

  // ---- search ----
  async function queryVector(q) {
    const hit = qCache.get(q);
    if (hit && Date.now() - hit.at < 3600000) return hit.vec;
    const vec = embedder.enabled ? await embedder.embedQuery(q) : normalise(hashEmbed(q));
    qCache.set(q, { vec, at: Date.now() });
    if (qCache.size > 500) qCache.delete(qCache.keys().next().value);
    return vec;
  }

  async function search({ query, type = "all", limit = 20, lat = null, lng = null, category = null }) {
    const q = String(query || "").trim().slice(0, 200);
    const out = { engine: embedder.enabled ? `semantic:${MODEL}` : "built-in hash vectors", results: [] };
    if (q.length < 2) return out;
    const qt = tokens(q);
    let qv = null;
    try { qv = await queryVector(q); } catch (e) { out.engine = "keyword-fallback"; lastError = e.message; }
    const want = type === "workers" || type === "worker" ? "worker" : type === "jobs" || type === "job" ? "job" : null;

    const cands = [];
    for (const it of mem.values()) {
      if (want && it.type !== want) continue;
      if (category && String(it.category).toLowerCase() !== String(category).toLowerCase()) continue;
      let sem = 0;
      if (qv && it.vec && it.model === MODEL) sem = Math.max(0, dot(qv, it.vec));
      let lexHits = 0;
      for (const t of qt) { if (it.toks.has(t)) lexHits++; else for (const w of it.toks) if (w.startsWith(t) || (t.length > 3 && t.startsWith(w) && w.length > 3)) { lexHits += 0.7; break; } }
      const lex = qt.length ? Math.min(1, lexHits / qt.length) : 0;
      if (sem < 0.2 && lex === 0) continue;
      cands.push({ it, sem, lex });
    }
    cands.sort((a, b) => b.sem * 0.7 + b.lex * 0.3 - (a.sem * 0.7 + a.lex * 0.3));
    const top = cands.slice(0, Math.min(200, limit * 4));

    const meta = new Map();
    const wIds = top.filter((c) => c.it.type === "worker").map((c) => c.it.id);
    if (wIds.length) {
      const ph = wIds.map(() => "?").join(",");
      for (const r of db.prepare(`SELECT u.id,u.verified,u.status,u.latitude,u.longitude,u.availability,
        (SELECT ROUND(AVG(rating),2) FROM reviews WHERE worker_id=u.id) AS rating,(SELECT COUNT(*) FROM reviews WHERE worker_id=u.id) AS reviews
        FROM users u WHERE u.id IN (${ph})`).all(...wIds)) meta.set(r.id, r);
    }
    const here = Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
    const scored = [];
    for (const { it, sem, lex } of top) {
      let score = qv ? sem * 0.62 + lex * 0.2 : lex * 0.8, distKm = null;
      if (it.type === "worker") {
        const m = meta.get(it.id);
        if (!m || m.status !== "active") continue;
        if (m.verified) score += 0.06;
        if (m.reviews > 0) score += (Number(m.rating) / 5) * 0.06 * Math.min(1, m.reviews / 5);
        if (m.availability && /available/i.test(m.availability)) score += 0.02;
        if (here && m.latitude && m.longitude) { distKm = km(here, { lat: m.latitude, lng: m.longitude }); score += Math.max(0, 1 - distKm / 25) * 0.1; }
      }
      scored.push({
        entity_type: it.type, entity_id: it.id, title: it.title, category: it.category, area: it.area, content: it.content.slice(0, 240),
        score: Math.round(score * 1000) / 1000, semantic: Math.round(sem * 1000) / 1000, keyword: Math.round(lex * 100) / 100,
        distance_km: distKm == null ? null : Math.round(distKm * 10) / 10, match_pct: Math.max(1, Math.min(99, Math.round(score * 100))) + "%"
      });
    }
    scored.sort((a, b) => b.score - a.score);
    out.results = scored.slice(0, limit);
    return out;
  }

  function stats() {
    const byModel = db.prepare("SELECT COALESCE(model,'none') AS model, COUNT(*) AS n FROM vector_index GROUP BY model").all();
    return { provider: embedder.enabled ? "external" : "built-in", model: MODEL, total: mem.size, by_model: byModel, queued: queue.size, last_embedded_at: lastEmbedAt, last_error: lastError };
  }

  ensureHashes(); load();
  return { upsert, remove, search, backfill, stats, pump, size: () => mem.size };
}

module.exports = { createVectorService };
