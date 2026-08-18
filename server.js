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
const VIDEO_MODEL = process.env.VIDEO_MODEL || "fal-ai/ltx-video";

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
async function sleep(ms){return new Promise(r=>setTimeout(r,ms));}

function parseJson(t) {
  t = (t || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const s = t.indexOf("{"), e = t.lastIndexOf("}");
  if (s >= 0 && e >= 0) t = t.slice(s, e + 1);
  return JSON.parse(t);
}

// clip davomiyligini o'lchash (ffmpeg orqali)
function getDuration(file) {
  return new Promise((resolve) => {
    const ff = spawn(ffmpegPath, ["-i", file]);
    let err = "";
    ff.stderr.on("data", (d) => (err += d));
    ff.on("close", () => {
      const m = err.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
      resolve(m ? (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]) : 5);
    });
    ff.on("error", () => resolve(5));
  });
}
function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const ff = spawn(ffmpegPath, args);
    let err = "";
    ff.stderr.on("data", (d) => (err += d));
    ff.on("close", (c) => (c === 0 ? resolve() : reject(new Error("ffmpeg: " + err.slice(-400)))));
    ff.on("error", (e) => reject(e));
  });
}

app.post("/scenario", async (req, res) => {
  try {
    if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY o'rnatilmagan (Railway Variables).");
    const { brief, style, dur = 60, lang = "Uzbek (Latin script)" } = req.body;
    if (!brief) throw new Error("brief bo'sh");
    const frameCount = Math.round(dur / FRAME_LEN);

    const planSys = `You are a professional AI-video pipeline director. Return ONLY valid JSON (no markdown):
{"title":"catchy title","logline":"1-2 sentence summary","characters":[{"name":"Name","description":"FIXED detailed look: age, hair, build, face, signature clothing — reused every shot for consistency"}],"beats":["short sentence for shot 1","..."]}
Rules: exactly ${frameCount} beats (one per ${FRAME_LEN}s shot). 2-4 characters.
CONTINUITY IS CRITICAL — the video has NO on-screen text and must feel like ONE continuous short film, not disconnected clips:
- Each beat continues DIRECTLY from the previous one (clear cause and effect).
- Keep the SAME location and time-of-day across consecutive shots; change scene only when the story truly moves, and minimize scene changes.
- Character appearance stays IDENTICAL throughout.
- One clear emotional arc: setup -> development -> payoff.`;
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

    // Personaj bir xilligi uchun: har kadr promti oldiga to'liq tavsif qo'shamiz
    const charPrefix = (req.body.characters && req.body.characters.length)
      ? "Consistent characters (keep EXACTLY the same appearance every time): " +
        req.body.characters.map(c => c.name + " — " + c.description).join(". ") + ". SCENE: "
      : "";
    const finalPrompt = charPrefix + frame.visual_prompt;

    // Forbidden/rate-limit bo'lsa 2 marta qayta urinamiz (orasida kutib)
    let url = null, lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const result = await fal.subscribe(VIDEO_MODEL, {
          input: { prompt: finalPrompt },
          logs: false,
        });
        url =
          result?.data?.video?.url ||
          result?.data?.videos?.[0]?.url ||
          result?.video?.url;
        if (url) break;
        throw new Error("video URL topilmadi");
      } catch (err) {
        lastErr = err;
        if (attempt < 3) await sleep(3000 * attempt); // 3s, keyin 6s kutamiz
      }
    }
    if (!url) throw lastErr || new Error("video yasalmadi");

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

    const clips = fs.readdirSync(workDir).filter((f) => f.endsWith(".mp4")).sort()
      .map((c) => path.join(workDir, c));
    if (!clips.length) throw new Error("birorta klip yo'q");

    const finalName = `${project.replace(/[^a-z0-9]/gi, "_")}_${clean}.mp4`;
    const finalPath = path.join(OUT_DIR, finalName);

    // --- 1) Silliq o'tishlar (crossfade) bilan ulashga urinamiz ---
    let stitched = false;
    if (clips.length > 1) {
      try {
        const durs = [];
        for (const c of clips) durs.push(await getDuration(c));
        let t = 0.4;                       // o'tish davomiyligi (soniya)
        const minDur = Math.min(...durs);
        if (minDur < t * 2) t = Math.max(0.15, minDur / 3);

        const inputs = [];
        clips.forEach((c) => inputs.push("-i", c));

        // Har bir klipni bir xil formatga keltiramiz (xfade shart qiladi)
        let filter = "";
        clips.forEach((_, i) => {
          filter += `[${i}:v]settb=AVTB,fps=24,format=yuv420p,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2[v${i}];`;
        });
        // xfade zanjiri
        let prev = "v0", off = 0;
        for (let i = 1; i < clips.length; i++) {
          off += durs[i - 1] - t;
          const out = i === clips.length - 1 ? "vout" : `vx${i}`;
          filter += `[${prev}][v${i}]xfade=transition=fade:duration=${t}:offset=${off.toFixed(3)}[${out}];`;
          prev = out;
        }
        filter = filter.replace(/;$/, "");

        await runFfmpeg(["-y", ...inputs, "-filter_complex", filter,
          "-map", "[vout]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an",
          "-movflags", "+faststart", finalPath]);
        stitched = true;
      } catch (e) {
        console.log("crossfade ishlamadi, oddiy usulga o'tamiz:", e.message);
        stitched = false;
      }
    }

    // --- 2) Zaxira: oddiy ulash (agar crossfade ishlamasa yoki 1 ta klip) ---
    if (!stitched) {
      const listFile = path.join(workDir, "list.txt");
      fs.writeFileSync(listFile, clips.map((c) => `file '${c}'`).join("\n"));
      await runFfmpeg(["-y", "-f", "concat", "-safe", "0", "-i", listFile,
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", finalPath]);
    }

    res.json({ ok: true, url: `/output/${finalName}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/health", (_, res) =>
  res.json({ ok: true, text_model: TEXT_MODEL, video_model: VIDEO_MODEL, keys: { gemini: !!GEMINI_API_KEY, fal: !!FAL_KEY } })
);

app.listen(PORT, () => console.log(`🚀 Video Fabrikasi: http://localhost:${PORT}`));
