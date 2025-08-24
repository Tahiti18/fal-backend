// server.cjs  — Express backend for your VEO front-end (FAL.ai + ElevenLabs)
// Node >= 18 (uses built-in fetch). CommonJS to match your repo.
// Routes your UI expects: /generate-fast, /generate-quality, /result/:jobId, /eleven/*, /mux, /health, /diag

const express = require("express");
const cors = require("cors");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));

// ---------- ENV ----------
const PORT = process.env.PORT || 8080;

// FAL auth (use separate id/secret — recommended)
const FAL_KEY_ID = process.env.FAL_KEY_ID || "";
const FAL_KEY_SECRET = process.env.FAL_KEY_SECRET || "";

// If you previously used a single colon-joined key, you can still supply FAL_KEY in the form id:secret
const FAL_KEY = process.env.FAL_KEY || "";
let BASIC_AUTH = "";
if (FAL_KEY_ID && FAL_KEY_SECRET) {
  BASIC_AUTH = Buffer.from(`${FAL_KEY_ID}:${FAL_KEY_SECRET}`).toString("base64");
} else if (FAL_KEY.includes(":")) {
  BASIC_AUTH = Buffer.from(FAL_KEY).toString("base64");
}

// FAL base + endpoints (defaults are best-guess; you can override in Railway if your pipeline differs)
const FAL_BASE = (process.env.FAL_API_BASE || "https://api.fal.ai").replace(/\/$/, "");
const FAL_SUBMIT_PATH = process.env.FAL_SUBMIT_PATH || "/v1/pipelines/google/veo/submit"; // POST
const FAL_RESULT_BASE = (process.env.FAL_RESULT_BASE || "/v1/pipelines/google/veo/requests").replace(/\/$/, ""); // GET {base}/{id}

// Model names (sent through to FAL; override if your pipeline expects different flags)
const VEO_MODEL_FAST = process.env.VEO_MODEL_FAST || "V3_5";
const VEO_MODEL_QUALITY = process.env.VEO_MODEL_QUALITY || "V4_5PLUS";

// ElevenLabs
const ELEVEN_KEY =
  process.env.ELEVEN_LABS ||
  process.env.ELEVENLABS_API_KEY ||
  process.env.ELEVEN_LABS_API_KEY ||
  process.env["11_Labs"] ||
  process.env["ELEVEN_KEY"] ||
  "";

// Optional mux
const ENABLE_MUX = String(process.env.ENABLE_MUX || "") === "1";
const FFMPEG_PATH = process.env.FFMPEG_PATH || "ffmpeg";

// Writable static dir (Railway safe)
const TMP_ROOT = "/tmp";
const STATIC_ROOT = path.join(TMP_ROOT, "public");
const TTS_DIR = path.join(STATIC_ROOT, "tts");
const MUX_DIR = path.join(STATIC_ROOT, "mux");
(async () => {
  try { await fs.mkdir(TTS_DIR, { recursive: true }); await fs.mkdir(MUX_DIR, { recursive: true }); } catch {}
})();

// ---------- Helpers ----------
function falHeaders(extra = {}) {
  const h = { "Content-Type": "application/json", ...extra };
  if (BASIC_AUTH) h["Authorization"] = `Basic ${BASIC_AUTH}`;
  return h;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Try hard to find a playable video URL in any FAL response shape */
function findVideoUrl(maybe) {
  if (!maybe) return null;
  try {
    const stack = [maybe];
    while (stack.length) {
      const v = stack.pop();
      if (typeof v === "string" && /https?:\/\/.+\.(mp4|mov|m4v|m3u8)(\?|$)/i.test(v)) return v;
      if (v && typeof v === "object") {
        if (typeof v.video_url === "string") return v.video_url;
        if (v.output && typeof v.output.video_url === "string") return v.output.video_url;
        if (v.video && typeof v.video.url === "string") return v.video.url;
        if (v.data && typeof v.data.url === "string") return v.data.url;
        for (const k of Object.keys(v)) stack.push(v[k]);
      }
    }
  } catch {}
  return null;
}

/** POST submit to FAL, then short poll for a ready URL (up to ~25s). */
async function submitAndMaybeWait(body, modelName) {
  const payload = { ...body, model: modelName };

  const submitURL = FAL_BASE + FAL_SUBMIT_PATH;
  const r = await fetch(submitURL, { method: "POST", headers: falHeaders(), body: JSON.stringify(payload) });
  const submitText = await r.text();
  let submitJson = {};
  try { submitJson = JSON.parse(submitText); } catch { submitJson = { raw: submitText }; }

  if (!r.ok) {
    return { status: r.status, ok: false, error: submitJson.error || submitText || `FAL submit ${r.status}` };
  }

  const jobId =
    submitJson.request_id || submitJson.id || submitJson.job_id ||
    (submitJson.data && (submitJson.data.request_id || submitJson.data.id)) ||
    null;

  const immediateUrl = findVideoUrl(submitJson);
  if (immediateUrl) {
    return { status: 200, ok: true, job_id: jobId, video_url: immediateUrl, raw: submitJson };
  }

  if (!jobId) return { status: 202, ok: true, pending: true, job_id: null, raw: submitJson };
  const resultBase = FAL_BASE + FAL_RESULT_BASE;
  const resultURL = (id) => `${resultBase}/${encodeURIComponent(id)}`;

  for (let i = 0; i < 5; i++) {
    await sleep(i === 0 ? 3000 : 5000);
    const sr = await fetch(resultURL(jobId), { headers: falHeaders() });
    const stxt = await sr.text();
    let sj = {}; try { sj = JSON.parse(stxt); } catch { sj = { raw: stxt }; }
    if (sr.ok) {
      const url = findVideoUrl(sj);
      if (url) return { status: 200, ok: true, job_id: jobId, video_url: url, raw: sj };
      if (/pending|running|processing/i.test(JSON.stringify(sj))) continue;
    }
  }
  return { status: 202, ok: true, pending: true, job_id: jobId, raw: submitJson };
}

// ---------- Routes your front-end calls ----------

// Health
app.get("/health", (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// Diagnostics (no secrets)
app.get("/diag", async (_req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString(),
    fal: {
      base: FAL_BASE,
      submitPath: FAL_SUBMIT_PATH,
      resultBase: FAL_RESULT_BASE,
      hasAuth: !!BASIC_AUTH,
      fastModel: VEO_MODEL_FAST,
      qualityModel: VEO_MODEL_QUALITY
    },
    elevenKeyPresent: !!ELEVEN_KEY,
    muxEnabled: ENABLE_MUX
  });
});

// Generate (Fast)
app.post("/generate-fast", async (req, res) => {
  try {
    if (!BASIC_AUTH) return res.status(401).json({ success:false, error:"FAL auth missing (FAL_KEY_ID/FAL_KEY_SECRET)" });
    const body = req.body || {};
    const out = await submitAndMaybeWait(body, VEO_MODEL_FAST);
    return res.status(out.status || 200).json({
      success: !!out.ok,
      job_id: out.job_id || null,
      pending: !!out.pending,
      video_url: out.video_url || null,
      provider: "fal",
      meta: out.raw
    });
  } catch (e) {
    res.status(502).json({ success:false, error: e?.message || String(e) });
  }
});

// Generate (Quality)
app.post("/generate-quality", async (req, res) => {
  try {
    if (!BASIC_AUTH) return res.status(401).json({ success:false, error:"FAL auth missing (FAL_KEY_ID/FAL_KEY_SECRET)" });
    const body = req.body || {};
    const out = await submitAndMaybeWait(body, VEO_MODEL_QUALITY);
    return res.status(out.status || 200).json({
      success: !!out.ok,
      job_id: out.job_id || null,
      pending: !!out.pending,
      video_url: out.video_url || null,
      provider: "fal",
      meta: out.raw
    });
  } catch (e) {
    res.status(502).json({ success:false, error: e?.message || String(e) });
  }
});

// Result polling
app.get("/result/:jobId", async (req, res) => {
  try {
    if (!BASIC_AUTH) return res.status(401).json({ success:false, error:"FAL auth missing" });
    const id = req.params.jobId;
    const url = `${FAL_BASE}${FAL_RESULT_BASE}/${encodeURIComponent(id)}`;
    const r = await fetch(url, { headers: falHeaders() });
    const t = await r.text();
    let j = {}; try { j = JSON.parse(t); } catch { j = { raw: t }; }
    const video_url = findVideoUrl(j);
    res.status(r.status).json({ success: r.ok, job_id: id, pending: !video_url, video_url, raw: j });
  } catch (e) {
    res.status(502).json({ success:false, error: e?.message || String(e) });
  }
});

// ---------- ElevenLabs ----------
app.get("/eleven/voices", async (_req, res) => {
  if (!ELEVEN_KEY) return res.status(401).json({ error: "ElevenLabs key missing" });
  try {
    const r = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": ELEVEN_KEY } });
    const j = await r.json();
    if (!r.ok) return res.status(r.status).json(j);
    const voices = (j.voices || []).map(v => ({
      id: v.voice_id || v.id,
      name: v.name,
      category: v.category || ""
    }));
    res.json({ voices });
  } catch (e) {
    res.status(502).json({ error: e?.message || String(e) });
  }
});

app.post("/eleven/tts", async (req, res) => {
  if (!ELEVEN_KEY) return res.status(401).json({ error: "ElevenLabs key missing" });
  const { voice_id, text, model_id, params } = req.body || {};
  if (!voice_id || !text) return res.status(400).json({ error: "voice_id and text required" });

  try {
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice_id)}?optimize_streaming_latency=0`;
    const payload = {
      text,
      model_id: model_id || "eleven_multilingual_v2",
      voice_settings: {
        stability: params?.stability ?? 0.45,
        similarity_boost: params?.similarity_boost ?? 0.8,
        style: params?.style ?? 0.0,
        use_speaker_boost: params?.use_speaker_boost ?? true
      }
    };
    const r = await fetch(url, {
      method: "POST",
      headers: { "xi-api-key": ELEVEN_KEY, "Content-Type": "application/json", "Accept": "audio/mpeg" },
      body: JSON.stringify(payload)
    });
    if (!r.ok) {
      const errTxt = await r.text().catch(()=> "");
      return res.status(r.status).json({ error: "ElevenLabs error", detail: errTxt });
    }
    const buf = Buffer.from(await r.arrayBuffer());
    const fname = `tts_${Date.now()}_${crypto.randomBytes(5).toString("hex")}.mp3`;
    await fs.writeFile(path.join(TTS_DIR, fname), buf);
    res.json({ audio_url: `/static/tts/${fname}`, bytes: buf.length });
  } catch (e) {
    res.status(502).json({ error: e?.message || String(e) });
  }
});

// ---------- Optional Mux (ffmpeg) ----------
app.post("/mux", async (req, res) => {
  if (!ENABLE_MUX) return res.status(403).json({ error: "Mux disabled. Set ENABLE_MUX=1 and ensure ffmpeg is available." });
  const { video_url, audio_url } = req.body || {};
  if (!video_url || !audio_url) return res.status(400).json({ error: "video_url and audio_url required" });

  const vPath = path.join(TMP_ROOT, `v_${Date.now()}.mp4`);
  const aPath = path.join(TMP_ROOT, `a_${Date.now()}.mp3`);
  const outPath = path.join(MUX_DIR, `out_${Date.now()}_${crypto.randomBytes(4).toString("hex")}.mp4`);

  try {
    const dl = async (u, fp) => {
      const r = await fetch(u);
      if (!r.ok) throw new Error(`Download failed: ${u} -> ${r.status}`);
      const b = Buffer.from(await r.arrayBuffer());
      await fs.writeFile(fp, b);
    };
    await dl(video_url, vPath);
    await dl(audio_url, aPath);

    const { spawn } = require("child_process");
    const args = ["-y", "-i", vPath, "-i", aPath, "-c:v", "copy", "-c:a", "aac", "-shortest", outPath];
    const proc = spawn(FFMPEG_PATH, args);
    proc.on("error", err => res.status(500).json({ error: "FFmpeg spawn failed", detail: String(err) }));
    proc.on("close", async (code) => {
      try { await fs.rm(vPath,{force:true}); await fs.rm(aPath,{force:true}); } catch {}
      if (code !== 0) return res.status(500).json({ error: `FFmpeg exit ${code}` });
      res.json({ merged_url: `/static/mux/${path.basename(outPath)}` });
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// Serve saved assets
app.use("/static", express.static(STATIC_ROOT, {
  setHeaders: (res) => res.setHeader("Cache-Control", "public, max-age=31536000, immutable")
}));

// Root (for Railway healthcheck)
app.get("/", (_req, res) => res.status(200).send("Backend running OK"));

// Start
app.listen(PORT, () => {
  console.log(`[OK] fal-backend listening on :${PORT}`);
  console.log(`[CONFIG] FAL base: ${FAL_BASE}`);
  console.log(`[CONFIG] Submit: ${FAL_SUBMIT_PATH}  | Result base: ${FAL_RESULT_BASE}`);
  console.log(`[CONFIG] FAL auth present: ${!!BASIC_AUTH}`);
  console.log(`[CONFIG] ElevenLabs key present: ${!!ELEVEN_KEY}`);
});
