// server.cjs — Backend for fal.ai (Node >=18, CommonJS)
// Matches the endpoints your frontend expects

const express = require("express");
const cors = require("cors");

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));

const PORT = process.env.PORT || 8080;
const FAL_KEY_ID = process.env.FAL_KEY_ID;
const FAL_KEY_SECRET = process.env.FAL_KEY_SECRET;

// Simple check
if (!FAL_KEY_ID || !FAL_KEY_SECRET) {
  console.error("[ERR] Missing FAL_KEY_ID or FAL_KEY_SECRET");
}

const AUTH_HEADER =
  "Basic " + Buffer.from(`${FAL_KEY_ID}:${FAL_KEY_SECRET}`).toString("base64");

// ---- Root + Health ----
app.get("/", (_req, res) => res.send("FAL backend running"));
app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));
app.get("/diag", (_req, res) =>
  res.json({ ok: true, FAL_KEY: !!FAL_KEY_ID && !!FAL_KEY_SECRET })
);

// ---- Proxy helpers ----
async function callFal(endpoint, body) {
  const url = `https://fal.run/${endpoint}`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: AUTH_HEADER,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body || {}),
  });
  const txt = await r.text();
  try {
    return { status: r.status, data: JSON.parse(txt) };
  } catch {
    return { status: r.status, data: { raw: txt } };
  }
}

// ---- Endpoints your frontend calls ----
app.post("/generate-fast", async (req, res) => {
  const payload = req.body || {};
  const resp = await callFal("fal-ai/fast-video", payload);
  res.status(resp.status).json(resp.data);
});

app.post("/generate-quality", async (req, res) => {
  const payload = req.body || {};
  const resp = await callFal("fal-ai/quality-video", payload);
  res.status(resp.status).json(resp.data);
});

// ---- Start ----
app.listen(PORT, () =>
  console.log(`[OK] fal-backend listening on :${PORT}`)
);
