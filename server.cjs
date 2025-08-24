// fal-backend: minimal proxy to fal.ai
// Accepts your frontend calls:
//   POST /generate-fast     -> FAL_UPSTREAM_FAST
//   POST /generate-quality  -> FAL_UPSTREAM_QUALITY
// Auth header format: "Key <FAL_KEY_ID>:<FAL_KEY_SECRET>"

const express = require("express");
const cors = require("cors");
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));
app.use(express.json({ limit: "4mb" }));

const PORT     = process.env.PORT || 8080;
const KEY_ID   = process.env.FAL_KEY_ID || "";
const KEY_SEC  = process.env.FAL_KEY_SECRET || "";
const FAST_URL = (process.env.FAL_UPSTREAM_FAST || "").replace(/\/$/,"");
const QUAL_URL = (process.env.FAL_UPSTREAM_QUALITY || "").replace(/\/$/,"");

function authHeaders() {
  const h = { "Content-Type": "application/json" };
  if (KEY_ID && KEY_SEC) h.Authorization = `Key ${KEY_ID}:${KEY_SEC}`;
  return h;
}

const okEnv = () => !!KEY_ID && !!KEY_SEC && !!FAST_URL && !!QUAL_URL;

// Health + simple diag (no secrets leaked)
app.get("/health", (_req, res) => {
  res.json({
    ok: okEnv(),
    ts: new Date().toISOString(),
    falKeyPresent: !!(KEY_ID && KEY_SEC),
    fastConfigured: !!FAST_URL,
    qualityConfigured: !!QUAL_URL
  });
});

async function proxyJsonPost(target, req, res, timeoutMs = 120000) {
  if (!target) return res.status(500).json({ success:false, error:"Upstream URL missing" });
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(target, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(req.body || {}),
      signal: ctrl.signal
    });
    const text = await r.text();
    let data = {}; try { data = JSON.parse(text); } catch { data = { raw: text }; }
    return res.status(r.status).json(data);
  } catch (e) {
    const msg = e && e.name === "AbortError" ? "Upstream timeout" : (e.message || String(e));
    return res.status(502).json({ success:false, error: msg });
  } finally {
    clearTimeout(t);
  }
}

// Frontend-facing routes
app.post("/generate-fast",    (req, res) => proxyJsonPost(FAST_URL, req, res));
app.post("/generate-quality", (req, res) => proxyJsonPost(QUAL_URL, req, res));

// Optional: if your fal flow returns a job id and needs polling, add a /result passthrough here.

// Start
app.listen(PORT, "0.0.0.0", () => console.log(`[OK] fal-backend on :${PORT}`));
