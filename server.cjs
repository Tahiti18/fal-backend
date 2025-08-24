// server.cjs — Minimal FAL.ai proxy (CommonJS, Node >= 18)
//
// Endpoints exposed:
//   GET  /health
//   GET  /diag
//   POST /generate-fast
//   POST /generate-quality
//   GET  /result/:id
//
// Env required in Railway:
//   FAL_KEY_ID
//   FAL_KEY_SECRET
// Optional:
//   PORT=8080
//   CORS_ORIGIN=*

const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 8080;
const FAL_KEY_ID = process.env.FAL_KEY_ID || "";
const FAL_KEY_SECRET = process.env.FAL_KEY_SECRET || "";

// Use Node 18+ global fetch
const fetchFn = (...args) => fetch(...args);

// Build the FAL Authorization header
function falHeaders(extra) {
  return Object.assign(
    {
      "Content-Type": "application/json",
      // FAL expects: Authorization: Key <id>:<secret>
      "Authorization": `Key ${FAL_KEY_ID}:${FAL_KEY_SECRET}`,
    },
    extra || {}
  );
}

// ---------- Health & Diag ----------
app.get("/health", (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

app.get("/diag", (_req, res) => {
  res.json({
    ok: true,
    ts: new Date().toISOString(),
    falKeyPresent: Boolean(FAL_KEY_ID && FAL_KEY_SECRET),
    routes: ["/generate-fast", "/generate-quality", "/result/:id"],
  });
});

// ---------- Proxy helpers ----------
async function proxyFalJson(method, url, body, res) {
  if (!FAL_KEY_ID || !FAL_KEY_SECRET) {
    return res.status(401).json({ error: "FAL key missing" });
  }
  try {
    const r = await fetchFn(url, {
      method,
      headers: falHeaders(),
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    return res.status(r.status).json(data);
  } catch (e) {
    return res.status(502).json({ error: e?.message || String(e) });
  }
}

// ---------- VEO via FAL.ai ----------
app.post("/generate-fast", (req, res) => {
  // FAL “fast” endpoint
  return proxyFalJson("POST", "https://fal.run/fal-ai/video/generate-fast", req.body, res);
});

app.post("/generate-quality", (req, res) => {
  // FAL “quality” endpoint
  return proxyFalJson("POST", "https://fal.run/fal-ai/video/generate-quality", req.body, res);
});

app.get("/result/:id", (req, res) => {
  const id = encodeURIComponent(req.params.id);
  return proxyFalJson("GET", `https://fal.run/fal-ai/video/result/${id}`, null, res);
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`[OK] fal-backend on :${PORT}`);
  console.log(`[CONFIG] FAL key present: ${Boolean(FAL_KEY_ID && FAL_KEY_SECRET)}`);
});
