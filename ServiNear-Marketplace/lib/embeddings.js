"use strict";
// Embedding client for any provider that speaks the OpenAI-style POST {base}/embeddings schema.
// Works with OpenAI, Voyage AI (https://api.voyageai.com/v1), and self-hosted servers (Ollama, LiteLLM, vLLM...).
// Returns L2-normalised Float32Arrays so cosine similarity is a plain dot product.

function normalise(vec) {
  let n = 0;
  for (let i = 0; i < vec.length; i++) n += vec[i] * vec[i];
  n = Math.sqrt(n) || 1;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / n;
  return out;
}

function createEmbedder(env = process.env) {
  const baseUrl = String(env.EMBEDDING_BASE_URL || "").replace(/\/+$/, "");
  const apiKey = env.EMBEDDING_API_KEY || "";
  const model = env.EMBEDDING_MODEL || "";
  const dimensions = env.EMBEDDING_DIMENSIONS ? Number(env.EMBEDDING_DIMENSIONS) : null;
  const timeoutMs = Number(env.EMBEDDING_TIMEOUT_MS || 8000);
  const enabled = Boolean(baseUrl && model);
  const isVoyage = /voyageai\.com|ai\.mongodb\.com/.test(baseUrl);
  const batchSize = Number(env.EMBEDDING_BATCH_SIZE || 64);
  let consecutiveFailures = 0, pausedUntil = 0;

  async function call(inputs, inputType, opts = {}) {
    if (Date.now() < pausedUntil) throw new Error("Embedding provider temporarily paused after repeated failures.");
    const body = { model, input: inputs };
    if (dimensions) body.dimensions = dimensions; // OpenAI text-embedding-3 and Voyage (output_dimension) differ; see below
    if (isVoyage) { delete body.dimensions; if (dimensions) body.output_dimension = dimensions; if (inputType) body.input_type = inputType; }
    let lastErr;
    for (let attempt = 0; attempt < (opts.attempts || 3); attempt++) {
      try {
        const res = await fetch(`${baseUrl}/embeddings`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(opts.timeout || timeoutMs)
        });
        if (res.status === 429 || res.status >= 500) throw Object.assign(new Error(`Embedding provider returned ${res.status}`), { retry: true });
        if (!res.ok) throw new Error(`Embedding provider rejected the request (${res.status})`);
        const json = await res.json();
        const rows = [...(json.data || [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
        if (rows.length !== inputs.length || !rows.every((r) => Array.isArray(r.embedding) && r.embedding.length)) throw new Error("Unexpected embedding response shape.");
        consecutiveFailures = 0;
        return rows.map((r) => normalise(Float32Array.from(r.embedding)));
      } catch (e) {
        lastErr = e;
        if (!(e.retry || e.name === "TimeoutError" || e.name === "TypeError")) break;
        await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
      }
    }
    if (++consecutiveFailures >= 4) pausedUntil = Date.now() + 60000; // circuit breaker: stop hammering a failing provider
    throw lastErr;
  }

  return {
    enabled,
    // Identifies the vector space. Vectors from different ids must never be compared with each other.
    id: enabled ? `${model}${dimensions ? "@" + dimensions : ""}` : "local-hash-v1",
    async embedDocuments(texts) {
      const out = [];
      for (let i = 0; i < texts.length; i += batchSize) out.push(...(await call(texts.slice(i, i + batchSize).map((t) => String(t).slice(0, 6000)), "document")));
      return out;
    },
    // Interactive search path: fail fast so the UI can fall back to keyword results instead of making people wait.
    async embedQuery(text) { return (await call([String(text).slice(0, 500)], "query", { timeout: Number(env.EMBEDDING_QUERY_TIMEOUT_MS || 3000), attempts: 2 }))[0]; }
  };
}

module.exports = { createEmbedder, normalise };
