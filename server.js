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
const AISHA_API_KEY = process.env.AISHA_API_KEY || ""; // ovoz uchun (aisha.group)
const VEO_MODEL = process.env.VEO_MODEL || "veo-3.1-fast-generate-preview"; // Google Veo (Gemini kalit orqali, $300 kreditdan)

const TEXT_MODEL = process.env.TEXT_MODEL || "gemini-3.6-flash";
const VIDEO_MODEL = process.env.VIDEO_MODEL || "fal-ai/ltx-video";
// Rasm-orqali-video (zanjir usuli uchun) — t2v modeldan avtomatik hosil qilamiz
const VIDEO_MODEL_I2V = process.env.VIDEO_MODEL_I2V || VIDEO_MODEL.replace("text-to-video", "image-to-video");
// Personaj bir xilligi uchun: Nano Banana (referensdan yangi sahna rasmi yasaydi)
const IMAGE_EDIT_MODEL = process.env.IMAGE_EDIT_MODEL || "fal-ai/nano-banana/edit";

// Tanlanadigan video modellar (interfeysdan tanlanadi)
const VIDEO_PROFILES = {
  // 1) Eng arzon — LTX (~$0.05/s)
  tejamkor: {
    t2v: process.env.VIDEO_MODEL || "fal-ai/ltx-2.5/text-to-video/fast",
    i2v: process.env.VIDEO_MODEL_I2V || (process.env.VIDEO_MODEL || "fal-ai/ltx-2.5/text-to-video/fast").replace("text-to-video", "image-to-video"),
    t2vInput: (prompt) => ({ prompt }),
    i2vInput: (imgUrl, prompt) => ({ image_url: imgUrl, prompt }),
  },
  // 2) O'rtacha — Kling 2.1 Standard (~$0.05/s i2v, arzon lekin sifatli)
  ortacha: {
    t2v: process.env.KLING_STD_T2V || "fal-ai/kling-video/v2.5-turbo/pro/text-to-video",
    i2v: process.env.KLING_STD_I2V || "fal-ai/kling-video/v2.1/standard/image-to-video",
    t2vInput: (prompt) => ({ prompt, duration: "5" }),
    i2vInput: (imgUrl, prompt) => ({ image_url: imgUrl, prompt, duration: "5" }),
  },
  // 3) Professional — Kling 2.5 Turbo (~$0.07/s)
  professional: {
    t2v: process.env.KLING_T2V || "fal-ai/kling-video/v2.5-turbo/pro/text-to-video",
    i2v: process.env.KLING_I2V || "fal-ai/kling-video/v2.5-turbo/pro/image-to-video",
    t2vInput: (prompt) => ({ prompt, duration: "5" }),
    i2vInput: (imgUrl, prompt) => ({ image_url: imgUrl, prompt, duration: "5" }),
  },
  // 4) Premium — Kling 2.6 Pro (eng yuqori sifat, ~$0.07-0.14/s)
  premium: {
    t2v: process.env.KLING_PRO_T2V || "fal-ai/kling-video/v2.5-turbo/pro/text-to-video",
    i2v: process.env.KLING_PRO_I2V || "fal-ai/kling-video/v2.6/pro/image-to-video",
    t2vInput: (prompt) => ({ prompt, duration: "5" }),
    i2vInput: (imgUrl, prompt) => ({ start_image_url: imgUrl, prompt, duration: "5", generate_audio: false }),
  },
};

if (FAL_KEY) fal.config({ credentials: FAL_KEY });

const app = express();
app.use(express.json({ limit: "25mb" }));

// ---- PAROL HIMOYASI ----
// Railway Variables'da APP_PASSWORD qo'ysang, sayt parol so'raydi.
// Qo'ymasang — hammaga ochiq (parolsiz) ishlayveradi.
const APP_PASSWORD = process.env.APP_PASSWORD || "";
app.post("/login", (req, res) => {
  if (!APP_PASSWORD) return res.json({ ok: true }); // parol yo'q — ochiq
  if (req.body && req.body.password === APP_PASSWORD) return res.json({ ok: true });
  res.status(401).json({ error: "Parol noto'g'ri" });
});
// Video yasaydigan yo'llarni parol bilan himoyalaymiz (pulni himoya qiladi)
function requireAuth(req, res, next) {
  if (!APP_PASSWORD) return next();
  const p = req.headers["x-app-password"];
  if (p === APP_PASSWORD) return next();
  res.status(401).json({ error: "Ruxsat yo'q — avval parol kiriting" });
}
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

// Aisha (o'zbekcha ovoz) — matnni ovozga aylantiradi, WAV bufer qaytaradi
const AISHA_MOODS = ["Neutral", "Cheerful", "Happy", "Sad"];
// fal.ai chaqiruvi (3 marta qayta urinish bilan)
async function falGen(model, input) {
  let last = null;
  for (let a = 1; a <= 3; a++) {
    try { return await fal.subscribe(model, { input, logs: false }); }
    catch (e) { last = e; if (a < 3) await sleep(2500 * a); }
  }
  throw last || new Error("fal xatosi");
}
function videoUrlOf(r){ return r?.data?.video?.url || r?.data?.videos?.[0]?.url || r?.video?.url; }
// Google Veo (Gemini API orqali) — so'rov yuboradi, kutadi, video buferini qaytaradi
async function genVeo(prompt, imageBuffer, aspectRatio) {
  const GB = "https://generativelanguage.googleapis.com/v1beta";
  const instance = { prompt };
  if (imageBuffer) instance.image = { bytesBase64Encoded: imageBuffer.toString("base64") };
  const body = { instances: [instance], parameters: { aspectRatio: aspectRatio || "16:9" } };
  const sub = await fetch(`${GB}/models/${VEO_MODEL}:predictLongRunning`, {
    method: "POST",
    headers: { "x-goog-api-key": GEMINI_API_KEY, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const subd = await sub.json().catch(() => ({}));
  if (!sub.ok) throw new Error(subd.error?.message || ("Veo submit " + sub.status));
  const opName = subd.name;
  if (!opName) throw new Error("Veo operation nomi yo'q");
  let uri = null;
  for (let i = 0; i < 60; i++) {          // ~5 daqiqagacha kutamiz
    await sleep(5000);
    const st = await fetch(`${GB}/${opName}`, { headers: { "x-goog-api-key": GEMINI_API_KEY } });
    const std = await st.json().catch(() => ({}));
    if (std.error) throw new Error(std.error.message || "Veo poll xatosi");
    if (std.done) {
      uri = std.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri
         || std.response?.generatedSamples?.[0]?.video?.uri
         || std.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.gcsUri;
      if (!uri) throw new Error("Veo video uri topilmadi");
      break;
    }
  }
  if (!uri) throw new Error("Veo juda uzoq javob bermadi (timeout)");
  const vid = await fetch(uri, { headers: { "x-goog-api-key": GEMINI_API_KEY } });
  return Buffer.from(await vid.arrayBuffer());
}
function imageUrlOf(r){ return r?.data?.images?.[0]?.url || r?.images?.[0]?.url || r?.data?.image?.url; }
async function saveFrom(url, filePath){ fs.writeFileSync(filePath, Buffer.from(await (await fetch(url)).arrayBuffer())); }

async function aishaTTS(text, mood) {
  const m = AISHA_MOODS.includes(mood) ? mood : "Neutral";
  const form = new FormData();
  form.append("transcript", String(text).slice(0, 1000));
  form.append("language", "uz");
  form.append("model", "Gulnoza");
  form.append("mood", m);
  form.append("speed", "1.0");
  const r = await fetch("https://back.aisha.group/api/v1/tts/post/", {
    method: "POST",
    headers: { "X-Api-Key": AISHA_API_KEY },
    body: form,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.detail || d.error || ("Aisha " + r.status));
  const ap = d.audio_path;
  if (!ap) throw new Error("audio_path yo'q");
  const buf = Buffer.from(await (await fetch("https://back.aisha.group" + ap)).arrayBuffer());
  return buf;
}

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
// Har klipni AYNAN belgilangan soniyaga keltiramiz (uzun bo'lsa kesadi, qisqa bo'lsa oxirgi kadrni cho'zadi)
async function forceDuration(clipPath, seconds) {
  const tmp = clipPath + ".fix.mp4";
  await runFfmpeg(["-y", "-i", clipPath,
    "-filter_complex", `[0:v]tpad=stop_mode=clone:stop_duration=${seconds}[v]`,
    "-map", "[v]", "-t", String(seconds),
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", "-r", "24",
    "-movflags", "+faststart", tmp]);
  fs.renameSync(tmp, clipPath);
}

app.post("/scenario", requireAuth, async (req, res) => {
  try {
    if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY o'rnatilmagan (Railway Variables).");
    const { brief, style, dur = "auto", lang = "Uzbek (Latin script)" } = req.body;
    if (!brief) throw new Error("brief bo'sh");
    const auto = String(dur) === "auto";
    const target = auto ? null : Math.max(2, Math.round(dur / FRAME_LEN));
    const countRule = auto
      ? "Decide the BEST number of shots YOURSELF, between 2 and 8, based purely on how much story the idea naturally needs. A short/simple idea should get FEWER shots (even just 2-3) — do NOT stretch it. Return exactly that many beats, each a DISTINCT new moment. Never repeat a beat."
      : ("The user wants EXACTLY " + target + " shots. EXPAND the idea into " + target + " DISTINCT beats by adding new story moments, actions, angles and developments so it naturally fills the length. CRITICAL: every beat must be a DIFFERENT moment that moves the story forward — NEVER repeat or rephrase the same action across shots. If the idea is small, invent believable extra scenes (before/after, reactions, details, new locations) to enrich it rather than repeating.");

    const planSys = `You are a professional AI-video pipeline director. Return ONLY valid JSON (no markdown):
{"title":"catchy title","logline":"1-2 sentence summary","characters":[{"name":"Name","description":"FIXED detailed look: age, hair, build, face, signature clothing — reused every shot for consistency"}],"beats":["short sentence for shot 1","..."]}
Rules: ${countRule} 2-4 characters.
CONTINUITY IS CRITICAL — the video has NO on-screen text and must feel like ONE continuous short film, not disconnected clips:
- Each beat continues DIRECTLY from the previous one (clear cause and effect).
- Keep the SAME location and time-of-day across consecutive shots; change scene only when the story truly moves, and minimize scene changes.
- Character appearance stays IDENTICAL throughout.
- One clear emotional arc: setup -> development -> payoff.`;
    const plan = parseJson(await callAI(planSys, `BRIEF: ${brief}\nSTYLE: ${style}\n${auto ? "Choose the shot count yourself." : ("Shots: " + target)}`, 3000));

    const characters = plan.characters || [];
    let beats = plan.beats || [];
    if (auto) { beats = beats.slice(0, 8); while (beats.length < 2) beats.push("Continue the story."); }
    else { while (beats.length < target) beats.push("Continue the story."); beats = beats.slice(0, target); }
    const frameCount = beats.length;
    const bible = characters.map((c) => c.name + ": " + c.description).join("\n");

    const frames = [];
    const BATCH = 5;
    for (let i = 0; i < frameCount; i += BATCH) {
      const from = i + 1, to = Math.min(i + BATCH, frameCount);
      const tb = beats.slice(i, to).map((b, k) => `Shot #${i + k + 1}: ${b}`).join("\n");
      const expSys = `Expand story beats into AI text-to-video prompts.
MANDATORY VISUAL STYLE (every prompt MUST start with and strictly follow this exact style): ${style}
DIALOG LANGUAGE: ${lang}
CHARACTER BIBLE (reuse EXACT descriptions when a character appears):
${bible}
Return ONLY JSON: {"frames":[{"n":<int>,"location":"scene name","visual_prompt":"detailed ENGLISH prompt that MUST begin with the mandatory style, then full description of any character present, camera angle, lighting, and the specific action of THIS shot","speaker":"name or empty","dialog":"line in ${lang} or empty"}]}`;
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

app.post("/clip", requireAuth, async (req, res) => {
  try {
    const qReq = req.body.quality;
    if (qReq === "veo" && !GEMINI_API_KEY) throw new Error("GEMINI_API_KEY o'rnatilmagan.");
    if (qReq !== "veo" && !FAL_KEY) throw new Error("FAL_KEY o'rnatilmagan (Railway Variables).");
    const { jobId, frame, characters } = req.body;
    if (!jobId || !frame) throw new Error("jobId yoki frame yo'q");

    const clean = jobId.replace(/[^a-z0-9]/gi, "");
    const workDir = path.join(OUT_DIR, "work_" + clean);
    fs.mkdirSync(workDir, { recursive: true });
    const base = (req.headers["x-forwarded-proto"] || "https") + "://" + req.headers.host;

    const charBible = (characters && characters.length)
      ? characters.map(c => c.name + " — " + c.description).join(". ")
      : "";
    const scenePrompt = (charBible ? "Characters: " + charBible + ". SCENE: " : "") + frame.visual_prompt;

    const fileName = `clip_${String(frame.n).padStart(3, "0")}.mp4`;
    const clipPath = path.join(workDir, fileName);
    const charrefPath = path.join(workDir, "charref.png");
    const charrefExists = fs.existsSync(charrefPath);

    const quality = (req.body.quality === "veo" || VIDEO_PROFILES[req.body.quality]) ? req.body.quality : "tejamkor";
    const useConsistency = req.body.consistency !== false; // personaj bir xilligi (default yoniq)
    const userImageUrl = req.body.userImageUrl || null;    // foydalanuvchi yuklagan mahsulot/personaj rasmi
    let mode = quality;

    // Agar foydalanuvchi rasm yuklagan bo'lsa — uni doimiy referens qilamiz (1-marta)
    if (userImageUrl && !charrefExists) {
      try {
        const buf = Buffer.from(await (await fetch(userImageUrl)).arrayBuffer());
        fs.writeFileSync(charrefPath, buf);
      } catch (e) { console.log("user rasm yuklashda xato:", e.message); }
    }
    const hasRef = fs.existsSync(charrefPath);

    if (quality === "veo") {
      // GOOGLE VEO ($300 kreditdan). 1-kadr matndan, keyingilar Nano Banana referens rasmidan.
      let imgBuf = null;
      if (frame.n > 1 && charrefExists) {
        try {
          const charrefUrl = `${base}/output/work_${clean}/charref.png`;
          const editPrompt = "Keep the EXACT same character(s), faces, clothing and age as in the reference image. New scene and action: " + frame.visual_prompt + ". Cinematic, high detail.";
          const ir = await falGen(IMAGE_EDIT_MODEL, { prompt: editPrompt, image_urls: [charrefUrl] });
          const kfUrl = imageUrlOf(ir);
          if (kfUrl) imgBuf = Buffer.from(await (await fetch(kfUrl)).arrayBuffer());
        } catch (e) { imgBuf = null; }
      }
      const buf = await genVeo(imgBuf ? (frame.visual_prompt + " Natural motion, cinematic.") : scenePrompt, imgBuf, req.body.aspect_ratio || "16:9");
      fs.writeFileSync(clipPath, buf);
      if (frame.n === 1) {
        try { await runFfmpeg(["-y", "-ss", "1", "-i", clipPath, "-frames:v", "1", charrefPath]); }
        catch (e) { try { await runFfmpeg(["-y", "-i", clipPath, "-frames:v", "1", charrefPath]); } catch (e2) {} }
      }
      mode = imgBuf ? "veo+referens" : "veo";
    } else {
    const prof = VIDEO_PROFILES[quality];
    // Referensdan foydalanamizmi? (personaj bir xilligi yoniq VA referens bor VA 1-kadr emas yoki rasm yuklangan)
    const useRef = useConsistency && hasRef && (frame.n > 1 || userImageUrl);

    if (!useRef) {
      // Matndan video (arzonroq — Nano Banana ishlatilmaydi)
      const r = await falGen(prof.t2v, prof.t2vInput(scenePrompt));
      const url = videoUrlOf(r);
      if (!url) throw new Error("video URL topilmadi");
      await saveFrom(url, clipPath);
      // 1-kadr bo'lsa va bir xillik yoniq bo'lsa — referens rasmni saqlab qo'yamiz
      if (frame.n === 1 && useConsistency && !userImageUrl) {
        try { await runFfmpeg(["-y", "-ss", "1", "-i", clipPath, "-frames:v", "1", charrefPath]); }
        catch (e) { try { await runFfmpeg(["-y", "-i", clipPath, "-frames:v", "1", charrefPath]); } catch (e2) {} }
      }
      mode = quality;
    } else {
      // Nano Banana referensdan yangi sahna rasmi (personaj/mahsulot bir xil)
      const charrefUrl = `${base}/output/work_${clean}/charref.png`;
      let keyframeUrl = null;
      try {
        const editPrompt = "Keep the EXACT same main subject/character/product, same appearance, from the reference image. New scene and action: " + frame.visual_prompt + ". Cinematic, high detail.";
        const ir = await falGen(IMAGE_EDIT_MODEL, { prompt: editPrompt, image_urls: [charrefUrl] });
        keyframeUrl = imageUrlOf(ir);
      } catch (e) { keyframeUrl = null; }

      if (keyframeUrl) {
        const r = await falGen(prof.i2v, prof.i2vInput(keyframeUrl, frame.visual_prompt + " Natural motion and camera movement, cinematic."));
        const url = videoUrlOf(r);
        if (!url) throw new Error("video URL topilmadi");
        await saveFrom(url, clipPath);
        mode = quality + "+referens";
      } else {
        const r = await falGen(prof.t2v, prof.t2vInput(scenePrompt));
        const url = videoUrlOf(r);
        if (!url) throw new Error("video URL topilmadi");
        await saveFrom(url, clipPath);
        mode = quality + "+zaxira";
      }
    }
    } // veo else tugadi

    // Klipni AYNAN 6 soniyaga keltiramiz (davomiylik 100% bir xil bo'lsin)
    try { await forceDuration(clipPath, FRAME_LEN); } catch (e) { console.log("duration fix xato:", e.message); }

    res.json({ ok: true, n: frame.n, clipUrl: `/output/work_${clean}/${fileName}`, mode });
  } catch (e) {
    res.status(500).json({ error: e.message, n: req.body?.frame?.n });
  }
});
app.post("/stitch", requireAuth, async (req, res) => {
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
    const silentPath = path.join(OUT_DIR, "silent_" + clean + ".mp4");

    // Har bir klip davomiyligini o'lchaymiz (ovoz vaqti uchun ham kerak)
    const durs = [];
    for (const c of clips) durs.push(await getDuration(c));

    // --- 1) Silliq o'tishlar (crossfade) bilan ulashga urinamiz ---
    let stitched = false;
    let t = 0.4;                          // o'tish davomiyligi (soniya)
    if (clips.length > 1) {
      try {
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
          "-movflags", "+faststart", silentPath]);
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
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", "-movflags", "+faststart", silentPath]);
    }

    // --- 3) OVOZ: dialoglarni Aisha bilan ovozga aylantirib qo'shamiz ---
    const st = [0];
    for (let i = 1; i < clips.length; i++) st[i] = st[i - 1] + durs[i - 1] - (stitched ? t : 0);

    const frames = Array.isArray(req.body.frames) ? req.body.frames : [];
    const spoken = frames.filter((f) => f && f.dialog && String(f.dialog).trim());
    let audioDone = false;
    if (AISHA_API_KEY && spoken.length) {
      try {
        const voices = [];
        for (const f of frames) {
          if (!f.dialog || !String(f.dialog).trim()) continue;
          const idx = (f.n || 1) - 1;
          if (idx < 0 || idx >= clips.length) continue;
          try {
            const buf = await aishaTTS(String(f.dialog), f.mood);
            const wav = path.join(workDir, `voice_${String(f.n).padStart(3, "0")}.wav`);
            fs.writeFileSync(wav, buf);
            voices.push({ startMs: Math.round((st[idx] || 0) * 1000) + 250, wav });
          } catch (e) { console.log("TTS xato #" + f.n + ":", e.message); }
        }
        if (voices.length) {
          const inputs = ["-i", silentPath];
          voices.forEach((v) => inputs.push("-i", v.wav));
          let fc = "";
          voices.forEach((v, i) => { fc += `[${i + 1}:a]adelay=${v.startMs}|${v.startMs}[a${i}];`; });
          fc += voices.map((_, i) => `[a${i}]`).join("") + `amix=inputs=${voices.length}:normalize=0[aout]`;
          await runFfmpeg(["-y", ...inputs, "-filter_complex", fc,
            "-map", "0:v", "-map", "[aout]", "-c:v", "copy", "-c:a", "aac",
            "-movflags", "+faststart", finalPath]);
          audioDone = true;
        }
      } catch (e) { console.log("ovoz qo'shishda umumiy xato:", e.message); }
    }

    if (audioDone) { try { fs.unlinkSync(silentPath); } catch (e) {} }
    else { fs.renameSync(silentPath, finalPath); }

    // Tarixga yozamiz (yig'ilib boradigan ro'yxat)
    try {
      const histFile = path.join(OUT_DIR, "history.json");
      let hist = [];
      if (fs.existsSync(histFile)) hist = JSON.parse(fs.readFileSync(histFile, "utf8"));
      hist.unshift({ title: project, url: `/output/${finalName}`, date: new Date().toISOString() });
      fs.writeFileSync(histFile, JSON.stringify(hist.slice(0, 200), null, 2));
    } catch (e) {}

    res.json({ ok: true, url: `/output/${finalName}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Videolar tarixini beradi
app.get("/history", requireAuth, (_, res) => {
  try {
    const histFile = path.join(OUT_DIR, "history.json");
    const hist = fs.existsSync(histFile) ? JSON.parse(fs.readFileSync(histFile, "utf8")) : [];
    res.json({ items: hist });
  } catch (e) {
    res.json({ items: [] });
  }
});

// Foydalanuvchi rasm yuklaydi (mahsulot/personaj) — base64, referens uchun
app.post("/upload-image", requireAuth, (req, res) => {
  try {
    const { jobId, dataUrl } = req.body;
    if (!jobId || !dataUrl) throw new Error("jobId yoki rasm yo'q");
    const clean = jobId.replace(/[^a-z0-9]/gi, "");
    const workDir = path.join(OUT_DIR, "work_" + clean);
    fs.mkdirSync(workDir, { recursive: true });
    const m = String(dataUrl).match(/^data:image\/(png|jpe?g|webp);base64,(.+)$/);
    if (!m) throw new Error("rasm formati noto'g'ri (png/jpg/webp bo'lsin)");
    const buf = Buffer.from(m[2], "base64");
    const imgPath = path.join(workDir, "userimg.png");
    fs.writeFileSync(imgPath, buf);
    const base = (req.headers["x-forwarded-proto"] || "https") + "://" + req.headers.host;
    res.json({ ok: true, url: `${base}/output/work_${clean}/userimg.png` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/health", (_, res) =>
  res.json({ ok: true, text_model: TEXT_MODEL, veo_model: VEO_MODEL, keys: { gemini: !!GEMINI_API_KEY, fal: !!FAL_KEY, aisha: !!AISHA_API_KEY } })
);

app.listen(PORT, () => console.log(`🚀 Video Fabrikasi: http://localhost:${PORT}`));
