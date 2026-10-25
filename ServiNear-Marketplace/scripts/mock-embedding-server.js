"use strict";
// Tiny OpenAI-compatible embeddings server for tests. It maps synonyms onto shared concept axes,
// which mimics what a real model does: "air conditioner" and "AC" land close together with no shared words.
const http = require("node:http");
const CONCEPTS = [
  ["ac", "air", "conditioner", "cooling", "cool", "refrigerant", "hvac", "compressor", "বাতানুকূল"],
  ["electric", "electrician", "wiring", "wire", "switch", "fan", "mcb", "circuit", "power", "বিদ্যুৎ"],
  ["plumber", "plumbing", "pipe", "leak", "leaking", "tap", "water", "sink", "faucet", "কল"],
  ["clean", "cleaning", "maid", "sweep", "sanitize", "dust"],
  ["move", "moving", "shift", "shifting", "truck", "removals", "furniture", "transport"],
  ["laptop", "computer", "wifi", "router", "it", "software", "pc", "network"]
];
const DIM = 48;
function embed(text) {
  const v = new Array(DIM).fill(0), toks = String(text).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  CONCEPTS.forEach((words, i) => { for (const t of toks) if (words.includes(t)) v[i] += 1; });
  toks.forEach((t) => { let h = 7; for (const ch of t) h = (h * 31 + ch.charCodeAt(0)) % 9973; v[CONCEPTS.length + (h % (DIM - CONCEPTS.length))] += 0.15; });
  return v;
}
function start(port) {
  const calls = { count: 0, last: null };
  const srv = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c));
    req.on("end", () => {
      if (req.url !== "/v1/embeddings" || req.method !== "POST") { res.writeHead(404); return res.end(); }
      const body = JSON.parse(b || "{}"); calls.count++; calls.last = body;
      if (req.headers.authorization !== "Bearer test-key") { res.writeHead(401); return res.end("{}"); }
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", model: body.model, data: inputs.map((t, index) => ({ object: "embedding", index, embedding: embed(t) })) }));
    });
  });
  return new Promise((r) => srv.listen(port, "127.0.0.1", () => r({ srv, calls })));
}
module.exports = { start };
if (require.main === module) start(Number(process.env.PORT || 5098)).then(() => console.log("mock embeddings on", process.env.PORT || 5098));
