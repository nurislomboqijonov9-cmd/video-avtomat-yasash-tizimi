// =====================================================================
//  AI VIDEO FABRIKASI — to'liq server (bitta faylda hamma narsa)
//  ---------------------------------------------------------------------
//  1. Interfeysni beradi (public/index.html)
//  2. /scenario  — Google Gemini (BEPUL) orqali senariy yozadi
//  3. /clip      — fal.ai orqali bitta kadr videosini yasaydi
//  4. /stitch    — barcha kliplarni ffmpeg bilan bitta videoga ulaydi
//
//  Railway "Variables" bo'limida kerak:
//    GEMINI_API_KEY  — aistudio.google.com/apikey dan (BEPUL)
//    FAL_KEY         — fal.ai dan (video uchun)
// =====================================================================

import express from "express";
import { fal } from "@fal-ai/client";
import ffmpegPath from "ffmpeg-static";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const FAL_KEY = process.env.FAL_KEY;

const TEXT_MODEL = process.env.TEXT_MODEL || "gemini-2.5-flash";
const VIDEO_MODEL = process.env.VIDEO_MODEL || "fal-ai/ltx-2/text-to-video";

if (FAL_KEY) fal.config({ credentials: FAL_KEY });

const app = express();
app.use(express.json({ limit: "6mb" }));
app.use(express.static(path.join(__dirname, "public")));

const OUT_DIR = path.join(__dirname, "output");
fs.mkdirSync(OUT_DIR, { recursive: true });
app.use("/output", express.static(OUT_DIR));

const FRAME_LEN = 6;

async function callAI(system, user, maxTokens = 3000) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${TEXT_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: { maxOutputTokens: maxTokens, temperature: 0.9 },
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || "Gemini xatosi");
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
  if (!text) throw new Error("Gemini bo'sh javob qaytardi");
  return text;
}
function parseJson(t) {
  t = (t || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const s = t.indexOf("{"), e = t.lastIndexOf("}");
  if (s >= 0 && e >= 0) t = t.slice(s, e + 1);
  return JSON.parse(t);
}

app.post("/scenario", async (req, res) => {
  try {
    if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY o'rnatilmagan (Railway Variables).");
    const { brief, style, dur = 60, lang = "Uzbek (Latin script)" } = req.body;
    if (!brief) throw new Error("brief bo'sh");
    const frameCount = Math.round(dur / FRAME_LEN);

    const planSys = `You are a professional AI-video pipeline director. Return ONLY valid JSON (no markdown):
{"title":"catchy title","logline":"1-2 sentence summary","characters":[{"name":"Name","description":"FIXED detailed look: age, hair, build, face, signature clothing — reused every shot for consistency"}],"beats":["short sentence for shot 1","..."]}
Rules: exactly ${frameCount} beats (one per ${FRAME_LEN}s shot). Clear beginning, middle, emotional payoff. 2-4 characters.`;
    const plan = parseJson(await callAI(planSys, `BRIEF: ${brief}\nSTYLE: ${style}\nShots: ${frameCount}`, 3000));

    const characters = plan.characters || [];
    let beats = plan.beats || [];
    while (beats.length < frameCount) beats.push("Continue the story.");
    beats = beats.slice(0, frameCount);
    const bible = characters.map((c) => c.name + ": " + c.description).join("\n");

    const frames = [];
    const BATCH = 5;
    for (let i = 0; i < frameCount; i += BATCH) {
      const from = i + 1, to = Math.min(i + BATCH, frameCount);
      const tb = beats.slice(i, to).map((b, k) => `Shot #${i + k + 1}: ${b}`).join("\n");
      const expSys = `Expand story beats into AI text-to-video prompts.
STYLE: ${style}
DIALOG LANGUAGE: ${lang}
CHARACTER BIBLE (reuse EXACT descriptions when a character appears):
${bible}
Return ONLY JSON: {"frames":[{"n":<int>,"location":"scene name","visual_prompt":"detailed ENGLISH prompt incl full description of any character present, camera, lighting, action","speaker":"name or empty","dialog":"line in ${lang} or empty"}]}`;
      let batch = [];
      try { batch = parseJson(await callAI(expSys, `Expand:\n${tb}\nLogline: ${plan.logline}`, 3000)).frames || []; } catch (e) {}
      for (let k = 0; k < to - from + 1; k++) {
        const n = from + k;
        const bf = batch.find((x) => +x.n === n) || batch[k] || {};
        frames.push({
          n, start: (n - 1) * FRAME_LEN, end: n * FRAME_LEN,
          location: bf.location || "Scene",
          visual_prompt: bf.visual_prompt || `[${style}] ${beats[n - 1]}`,
          speaker: bf.speaker || "", dialog: bf.dialog || "",
        });
      }
    }
    res.json({ title: plan.title || "Video", logline: plan.logline || "", characters, frames });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/clip", async (req, res) => {
  try {
    if (!FAL_KEY) throw new Error("FAL_KEY o'rnatilmagan (Railway Variables).");
    const { jobId, frame, aspect_ratio = "16:9" } = req.body;
    if (!jobId || !frame) throw new Error("jobId yoki frame yo'q");

    const workDir = path.join(OUT_DIR, "work_" + jobId.replace(/[^a-z0-9]/gi, ""));
    fs.mkdirSync(workDir, { recursive: true });

    const result = await fal.subscribe(VIDEO_MODEL, {
      input: { prompt: frame.visual_prompt, aspect_ratio, resolution: "720p" },
      logs: false,
    });
    const url =
      result?.data?.video?.url ||
      result?.data?.videos?.[0]?.url ||
      result?.video?.url;
    if (!url) throw new Error("video URL topilmadi");

    const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
    const fileName = `clip_${String(frame.n).padStart(3, "0")}.mp4`;
    fs.writeFileSync(path.join(workDir, fileName), buf);

    res.json({ ok: true, n: frame.n, clipUrl: `/output/work_${jobId.replace(/[^a-z0-9]/gi, "")}/${fileName}` });
  } catch (e) {
    res.status(500).json({ error: e.message, n: req.body?.frame?.n });
  }
});

app.post("/stitch", async (req, res) => {
  try {
    const { jobId, project = "video" } = req.body;
    if (!jobId) throw new Error("jobId yo'q");
    const clean = jobId.replace(/[^a-z0-9]/gi, "");
    const workDir = path.join(OUT_DIR, "work_" + clean);
    if (!fs.existsSync(workDir)) throw new Error("kliplar topilmadi");

    const clips = fs.readdirSync(workDir).filter((f) => f.endsWith(".mp4")).sort();
    if (!clips.length) throw new Error("birorta klip yo'q");

    const listFile = path.join(workDir, "list.txt");
    fs.writeFileSync(listFile, clips.map((c) => `file '${path.join(workDir, c)}'`).join("\n"));

    const finalName = `${project.replace(/[^a-z0-9]/gi, "_")}_${clean}.mp4`;
    const finalPath = path.join(OUT_DIR, finalName);

    await new Promise((resolve, reject) => {
      const ff = spawn(ffmpegPath, [
        "-y", "-f", "concat", "-safe", "0", "-i", listFile,
        "-c:v", "libx264", "-c:a", "aac", "-pix_fmt", "yuv420p",
        "-movflags", "+faststart", finalPath,
      ]);
      let err = "";
      ff.stderr.on("data", (d) => (err += d));
      ff.on("close", (c) => (c === 0 ? resolve() : reject(new Error("ffmpeg: " + err.slice(-400)))));
      ff.on("error", (e) => reject(e));
    });

    res.json({ ok: true, url: `/output/${finalName}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/health", (_, res) =>
  res.json({ ok: true, text_model: TEXT_MODEL, video_model: VIDEO_MODEL, keys: { gemini: !!GEMINI_API_KEY, fal: !!FAL_KEY } })
);

app.listen(PORT, () => console.log(`🚀 Video Fabrikasi: http://localhost:${PORT}`));
