/* shortsgenerated — Google AI client (Phase 2).
   All calls go browser → Google's public API with the user's own key.
   The key is sent ONLY to generativelanguage.googleapis.com endpoints —
   never to any other host. No server involvement anywhere. */

const BASE = "https://generativelanguage.googleapis.com/v1beta";

export interface TtsModelOption {
  id: string;
  label: string;
}
export const TTS_MODELS: TtsModelOption[] = [
  { id: "gemini-3.1-flash-tts-preview", label: "Gemini 3.1 Flash TTS (preview)" },
  { id: "gemini-2.5-flash-tts", label: "Gemini 2.5 Flash TTS" },
];
export const DEFAULT_TTS_MODEL = TTS_MODELS[0].id;

export interface VeoModelOption {
  id: string;
  label: string;
}
export const VEO_MODELS: VeoModelOption[] = [
  { id: "veo-3.1-fast-generate-preview", label: "Veo 3.1 Fast — quicker" },
  { id: "veo-3.1-generate-preview", label: "Veo 3.1 Quality — best output" },
  { id: "veo-3.1-lite-generate-preview", label: "Veo 3.1 Lite — cheapest" },
];
export const DEFAULT_VEO_MODEL = VEO_MODELS[0].id;

export interface VoiceOption {
  name: string;
  tag: string;
}
/* The 30 prebuilt Gemini TTS voices with their documented personality tags. */
export const VOICES: VoiceOption[] = [
  { name: "Zephyr", tag: "Bright" },
  { name: "Puck", tag: "Upbeat" },
  { name: "Charon", tag: "Informative" },
  { name: "Kore", tag: "Firm" },
  { name: "Fenrir", tag: "Excitable" },
  { name: "Leda", tag: "Youthful" },
  { name: "Orus", tag: "Balanced" },
  { name: "Aoede", tag: "Breezy" },
  { name: "Callirrhoe", tag: "Easy-going" },
  { name: "Autonoe", tag: "Bright" },
  { name: "Enceladus", tag: "Breathy" },
  { name: "Iapetus", tag: "Clear" },
  { name: "Umbriel", tag: "Easy-going" },
  { name: "Algieba", tag: "Smooth" },
  { name: "Despina", tag: "Smooth" },
  { name: "Erinome", tag: "Clear" },
  { name: "Algenib", tag: "Gravelly" },
  { name: "Rasalgethi", tag: "Informative" },
  { name: "Laomedeia", tag: "Upbeat" },
  { name: "Achernar", tag: "Soft" },
  { name: "Alnilam", tag: "Firm" },
  { name: "Schedar", tag: "Even" },
  { name: "Gacrux", tag: "Mature" },
  { name: "Pulcherrima", tag: "Forward" },
  { name: "Achird", tag: "Friendly" },
  { name: "Zubenelgenubi", tag: "Casual" },
  { name: "Vindemiatrix", tag: "Gentle" },
  { name: "Sadachbia", tag: "Lively" },
  { name: "Sadaltager", tag: "Knowledgeable" },
  { name: "Sulafat", tag: "Warm" },
];

function headers(key: string): Record<string, string> {
  return { "Content-Type": "application/json", "x-goog-api-key": key };
}

/* Optional environment-bundled Gemini API key (for copies of this app hosted
   in environments that inject a key, e.g. Google AI Studio Build imports).
   Precedence everywhere: user-pasted localStorage key first (existing
   behavior, unchanged), else this env key if present.
   Sources checked, in order:
     1. import.meta.env.VITE_GEMINI_API_KEY (Vite build-time var)
     2. import.meta.env.GEMINI_API_KEY (alt build-time name)
     3. process.env.GEMINI_API_KEY / process.env.API_KEY (AI Studio Build's
        documented runtime injection name for its own managed key)
   Every access is guarded so SSR, plain node, and browsers without either
   object never crash. Returns "" when no env key is present.
   Billing note: in an AI Studio copy, generation bills to whatever
   project/key backs that environment — Flow credits do NOT apply (the Flow
   web app and the Gemini API are separate systems). */
export function envBundledKey(): string {
  try {
    const env = (import.meta as unknown as { env?: Record<string, string | undefined> })?.env;
    const v = env?.VITE_GEMINI_API_KEY || env?.GEMINI_API_KEY;
    if (typeof v === "string" && v.trim()) return v.trim();
  } catch {
    /* import.meta.env unavailable (non-Vite runtime) — fall through */
  }
  try {
    const penv = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } })?.process?.env;
    const v = penv?.GEMINI_API_KEY || penv?.API_KEY;
    if (typeof v === "string" && v.trim()) return v.trim();
  } catch {
    /* no node-style process env — no env key */
  }
  return "";
}

/* Pull Google's error message out verbatim so quota/billing/region failures
   are readable in the studio instead of swallowed. */
async function googleError(r: Response): Promise<string> {
  let body = "";
  try {
    body = await r.text();
  } catch {
    /* body unreadable */
  }
  try {
    const j = JSON.parse(body) as { error?: { message?: string; status?: string } };
    if (j?.error?.message) {
      const st = j.error.status ? ` [${j.error.status}]` : "";
      return `Google API error ${r.status}${st}: ${j.error.message}`;
    }
  } catch {
    /* not JSON */
  }
  const snip = body ? ` — ${body.slice(0, 240)}` : "";
  return `Google API error ${r.status} ${r.statusText || ""}${snip}`.trimEnd();
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => window.setTimeout(res, ms));
}

/* Vietnamese delivery directive. Gemini TTS treats a leading instruction as
   delivery direction (not spoken content): the narration comes out in
   Vietnamese no matter what language the script text is in. Applied to every
   narration chunk in ttsSpeak so ALL AI paths (Generate, Regenerate) read in
   Vietnamese. Kept out of the key-validation probe, which stays an English
   one-word "Connected." */
const VI_DIRECTIVE = "[Đọc bằng tiếng Việt] ";

/* base64 s16le PCM → Int16 samples (little-endian pairs). */
function base64ToI16(b64: string): Int16Array {
  const bin = atob(b64);
  const n = bin.length >> 1;
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const lo = bin.charCodeAt(i * 2);
    const hi = bin.charCodeAt(i * 2 + 1);
    out[i] = (hi << 8) | lo; // Int16Array store wraps to the signed value
  }
  return out;
}

/* Wrap s16le mono PCM in a minimal WAV container so the result behaves like
   any uploaded voiceover (probe duration, decode for render mixing, etc). */
export function pcm16ToWavBlob(samples: Int16Array, rate: number): Blob {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const dv = new DataView(buf);
  const w = (o: number, s: string): void => {
    for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i));
  };
  w(0, "RIFF");
  dv.setUint32(4, 36 + samples.length * 2, true);
  w(8, "WAVE");
  w(12, "fmt ");
  dv.setUint32(16, 16, true); // PCM chunk size
  dv.setUint16(20, 1, true); // PCM format
  dv.setUint16(22, 1, true); // mono
  dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * 2, true); // byte rate
  dv.setUint16(32, 2, true); // block align
  dv.setUint16(34, 16, true); // bits per sample
  w(36, "data");
  dv.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) dv.setInt16(44 + i * 2, samples[i], true);
  return new Blob([buf], { type: "audio/wav" });
}

/* Split a script into TTS-sized chunks at sentence boundaries (~4k chars,
   well under the 8,192-token input limit per request). */
function chunkScript(text: string, maxChars: number): string[] {
  const sentences = text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const units = sentences.length ? sentences : text.trim() ? [text.trim()] : [];
  const chunks: string[] = [];
  let cur = "";
  for (const s of units) {
    if (s.length > maxChars) {
      if (cur) {
        chunks.push(cur);
        cur = "";
      }
      let piece = "";
      for (const w of s.split(/\s+/)) {
        if ((piece + " " + w).trim().length > maxChars) {
          if (piece) chunks.push(piece.trim());
          piece = w;
        } else {
          piece = piece ? `${piece} ${w}` : w;
        }
      }
      if (piece) chunks.push(piece.trim());
      continue;
    }
    if ((cur ? `${cur} ${s}` : s).length > maxChars) {
      if (cur) chunks.push(cur);
      cur = s;
    } else {
      cur = cur ? `${cur} ${s}` : s;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

export interface TtsResult {
  wav: Blob;
  duration: number;
}

/* Generate a narrated voiceover via Gemini TTS. Long scripts are chunked at
   sentence boundaries and the decoded PCM segments are concatenated. */
export async function ttsSpeak(
  key: string,
  model: string,
  text: string,
  voiceName: string,
  onStatus?: (s: string) => void,
): Promise<TtsResult> {
  const chunks = chunkScript(text, 3800);
  if (!chunks.length) throw new Error("The script is empty — nothing to narrate.");
  const segs: Int16Array[] = [];
  let rate = 24000;
  for (let i = 0; i < chunks.length; i++) {
    onStatus?.(chunks.length > 1 ? `Generating narration — part ${i + 1}/${chunks.length}…` : "Generating narration…");
    const body = {
      contents: [{ parts: [{ text: VI_DIRECTIVE + chunks[i] }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
      },
    };
    const r = await fetch(`${BASE}/models/${model}:generateContent`, {
      method: "POST",
      headers: headers(key),
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(await googleError(r));
    const j = (await r.json()) as {
      candidates?: { content?: { parts?: { inlineData?: { data?: string; mimeType?: string } }[] }; finishReason?: string }[];
      promptFeedback?: { blockReason?: string };
    };
    const parts = j?.candidates?.[0]?.content?.parts ?? [];
    const inline = parts.find((p) => p?.inlineData?.data);
    if (!inline || !inline.inlineData?.data) {
      const why = j?.candidates?.[0]?.finishReason || j?.promptFeedback?.blockReason;
      throw new Error(
        why
          ? `Google TTS returned no audio (reason: ${why}). Try shortening or rewording the script.`
          : "Google TTS returned no audio for this script.",
      );
    }
    const mime = inline.inlineData.mimeType || "audio/L16;codec=pcm;rate=24000";
    const m = /rate=(\d+)/.exec(mime);
    if (m) rate = Number(m[1]);
    segs.push(base64ToI16(inline.inlineData.data));
  }
  const totalLen = segs.reduce((a, b) => a + b.length, 0);
  if (!totalLen) throw new Error("Google TTS returned empty audio.");
  const merged = new Int16Array(totalLen);
  let off = 0;
  for (const s of segs) {
    merged.set(s, off);
    off += s.length;
  }
  return { wav: pcm16ToWavBlob(merged, rate), duration: totalLen / rate };
}

/* Lightweight key check: one tiny TTS probe call. Tries each known TTS model
   in turn so a renamed preview model doesn't fail an otherwise valid key. */
export async function validateKey(key: string): Promise<void> {
  let lastErr = "";
  for (const m of TTS_MODELS) {
    try {
      await ttsSpeak(key, m.id, "Connected.", "Kore");
      return;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      // model-not-found → try the next model; anything else (bad key, quota,
      // billing, region) is a real answer — surface it verbatim.
      if (!/Google API error 40[04]|not found|NOT_FOUND|unsupported/i.test(lastErr)) throw e;
    }
  }
  throw new Error(lastErr || "Google rejected the key.");
}

export interface VeoOptions {
  durationSeconds: "4" | "6" | "8";
  onStatus?: (s: string) => void;
  isCancelled?: () => boolean;
  /* Channel style lock: when true (default), the fixed iconographic style
     suffix is appended to the user's prompt so every shot matches the
     channel template. Pass false to send the raw prompt (old behavior). */
  styleLock?: boolean;
}

/* Defensively pull the result video URI from the operation response, brief
   shape first. */
function findVideoUri(op: {
  response?: {
    generateVideoResponse?: { generatedSamples?: { video?: { uri?: string } }[]; generatedVideos?: { video?: { uri?: string } }[] };
    generatedSamples?: { video?: { uri?: string } }[];
    generatedVideos?: { video?: { uri?: string } }[];
    videos?: { uri?: string }[];
  };
}): string {
  const r = op?.response ?? {};
  return (
    r?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri ||
    r?.generatedSamples?.[0]?.video?.uri ||
    r?.generateVideoResponse?.generatedVideos?.[0]?.video?.uri ||
    r?.generatedVideos?.[0]?.video?.uri ||
    r?.videos?.[0]?.uri ||
    ""
  );
}

const PROMPT_CAP = 4000; // ~1,024 tokens per Veo instance

/* Channel visual-style lock (owner template: behavioral-economics
   iconographic look). Appended to every Veo prompt unless the caller opts
   out, so all generated shots match the channel style without the user
   typing style words. Kept in English — Veo follows English best. */
export const STYLE_SUFFIX =
  "Vertical 9:16 still-image composition, flat solid off-white background (#FAF7F2, no scenery, no environment art, no gradient, no texture); " +
  "abstract iconographic subjects only — simple geometric forms (circles, blobs, rounded shapes), one accent color per concept " +
  "(warm orange / coral red / blue / green / purple / gold), one symbolic prop per concept; " +
  "NO human faces, NO realistic people, NO stick-figure line-art characters, NO readable text, NO words, NO letters, NO logos, NO watermarks; " +
  "minimalist, warm, high negative space; single visual beat, subtle centered composition.";

/* Merge the user's prompt with the style suffix. The user's own words come
   first; the suffix is truncated-fit so it ALWAYS fits inside PROMPT_CAP. */
export function applyStyleLock(prompt: string, styleLock: boolean): string {
  const trimmed = prompt.trim();
  if (!styleLock || !trimmed) return trimmed.slice(0, PROMPT_CAP);
  if (trimmed.length + 2 + STYLE_SUFFIX.length <= PROMPT_CAP) return `${trimmed}. ${STYLE_SUFFIX}`;
  const room = PROMPT_CAP - STYLE_SUFFIX.length - 2;
  if (room <= 0) return STYLE_SUFFIX.slice(0, PROMPT_CAP);
  return `${trimmed.slice(0, room).trimEnd()}. ${STYLE_SUFFIX}`;
}

/* Generate one 9:16 vertical shot with Veo: predictLongRunning + poll the
   operation with backoff until done, then download the mp4. Takes 1–3 min. */
export async function veoGenerateShot(
  key: string,
  model: string,
  prompt: string,
  opts: VeoOptions,
): Promise<{ blob: Blob; name: string }> {
  const trimmed = applyStyleLock(prompt, opts.styleLock !== false);
  opts.onStatus?.("Starting Veo generation…");
  const start = await fetch(`${BASE}/models/${model}:predictLongRunning`, {
    method: "POST",
    headers: headers(key),
    body: JSON.stringify({
      instances: [{ prompt: trimmed }],
      parameters: { aspectRatio: "9:16", durationSeconds: Number(opts.durationSeconds), resolution: "720p" },
    }),
  });
  if (!start.ok) throw new Error(await googleError(start));
  const op = (await start.json()) as { name?: string };
  const opName = op?.name;
  if (!opName) throw new Error("Google accepted the request but returned no operation to track.");
  const t0 = Date.now();
  const deadline = t0 + 10 * 60_000;
  let delay = 8000;
  for (;;) {
    if (opts.isCancelled?.()) throw new Error("Generation cancelled.");
    await sleep(delay);
    delay = Math.min(15000, Math.round(delay * 1.15));
    if (opts.isCancelled?.()) throw new Error("Generation cancelled.");
    const el = Math.round((Date.now() - t0) / 1000);
    opts.onStatus?.(`Rendering shot on your Google AI account… ${el}s elapsed (typical 1–3 min)`);
    const poll = await fetch(`${BASE}/${opName}`, { headers: headers(key) });
    if (!poll.ok) throw new Error(await googleError(poll));
    const st = (await poll.json()) as {
      done?: boolean;
      error?: { message?: string };
      response?: Parameters<typeof findVideoUri>[0]["response"];
    };
    if (st?.error) {
      const msg = st.error?.message || JSON.stringify(st.error);
      throw new Error(`Google API error: ${msg}`);
    }
    if (st?.done) {
      const uri = findVideoUri(st);
      if (!uri) {
        const reasons = st?.response as { generateVideoResponse?: { raiMediaFilteredReasons?: string[] } } | undefined;
        const rf = reasons?.generateVideoResponse?.raiMediaFilteredReasons?.[0];
        throw new Error(
          rf
            ? `Google filtered the result: ${rf}`
            : `Generation finished but Google returned no video. Raw response: ${JSON.stringify(st).slice(0, 240)}`,
        );
      }
      // The key must only ever go to Google — refuse any other download host.
      const u = new URL(uri);
      if (!u.hostname.endsWith("googleapis.com")) {
        throw new Error(`Google returned an unexpected download host (${u.hostname}) — refused for safety.`);
      }
      opts.onStatus?.("Downloading video…");
      const dl = await fetch(uri, { headers: headers(key) });
      if (!dl.ok) throw new Error(await googleError(dl));
      const blob = await dl.blob();
      return { blob, name: `veo-shot-${Date.now().toString(36)}.mp4` };
    }
    if (Date.now() > deadline) {
      throw new Error("Timed out after 10 minutes waiting for Google to finish the shot. It may still complete — try again shortly.");
    }
  }
}
