// server.cjs — fal.ai proxy backend (CommonJS, Node >= 18)

const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));
app.use(express.json({ limit: "2mb" }));

// -------- ENV --------
const PORT = process.env.PORT || 8080;

// fal.ai credentials (you already set these in Railway)
const FAL_KEY_ID = process.env.FAL_KEY_ID || "";
const FAL_KEY_SECRET = process.env.FAL_KEY_SECRET || "";

// Where to send your video jobs on fal.ai (set these in Railway)
// Examples (YOU fill with the ones that worked for you):
//   FAL_FAST_URL=https://fal.run/xxx/veo-fast
//   FAL_QUALITY_URL=https://fal.run/yyy/veo-quality
// If your flow returns a request id you can poll, set:
//   FAL_RESULT_BASE=https://fal.run/requests   (so /requests/:id is valid)
const FAL_FAST_URL    = (process.env.FAL_FAST_URL || "").replace(/\/$/,"");
const FAL_QUALITY_URL = (process.env.FAL_QUALITY_URL || "").replace(/\/$/,"");
const FAL_RESULT_BASE = (process.env.FAL_RESULT_BASE || "").replace(/\/$/,"");

// Basic auth header for fal.ai
function falAuthHeader() {
  if (!FAL_KEY_ID || !FAL_KEY_SECRET) return null;
  const token = Buffer.from(`${FAL_KEY_ID}:${FAL_KEY_SECRET}`).toString("base64");
  return `Basic ${token
