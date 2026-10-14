"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const output = path.join(root, "dist");
const apiBase = String(process.env.SERVINEAR_API_BASE || "").replace(/\/$/, "");

if (apiBase && !/^https:\/\//i.test(apiBase)) {
  throw new Error("SERVINEAR_API_BASE must be an HTTPS origin, for example https://api.example.com");
}

fs.rmSync(output, { recursive: true, force: true });
fs.cpSync(path.join(root, "public"), output, { recursive: true });
fs.writeFileSync(path.join(output, "runtime-config.js"), `window.SERVINEAR_API_BASE = ${JSON.stringify(apiBase)};\n`);
console.log(`Built static frontend in dist; API origin: ${apiBase || "same origin"}`);
