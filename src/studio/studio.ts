/* shortsgenerated — Phase 2.
   Complete studio shell with the Google AI swap: Gemini TTS voiceover +
   Veo 9:16 shots, all direct browser→Google calls with the user's own key.
   Everything client-side: canvas preview, MediaRecorder render. */

import {
  DEFAULT_TTS_MODEL,
  DEFAULT_VEO_MODEL,
  TTS_MODELS,
  VOICES,
  VEO_MODELS,
  envBundledKey,
  ttsSpeak,
  validateKey,
  veoGenerateShot,
} from "./googleai";

export interface MediaItem {
  id: string;
  name: string;
  url: string;
  duration: number;
  width: number;
  height: number;
  thumb: string;
  source: "upload" | "link" | "ai" | "record";
  tainted: boolean;
  kind: "video" | "audio" | "image";
}

export interface TimelineClip {
  id: string;
  mediaId: string;
  src: string;
  name: string;
  start: number;
  dur: number;
  muted: boolean;
  number: number;
  label: string;
}

export interface Caption {
  start: number;
  end: number;
  text: string;
}

interface Prefs {
  script: string;
  voVolume: number;
  captionsOn: boolean;
  clipFit: "fill" | "fit";
  bgColor: string;
  hookOn: boolean;
  hookText: string;
  rankingOn: boolean;
  countdownOn: boolean;
  zoom: number;
  voiceName: string;
  ttsModel: string;
  veoModel: string;
  veoSeconds: "4" | "6" | "8";
  styleLock: boolean;
}

const PREFS_KEY = "rankreel.prefs.v1";
const GKEY_KEY = "rankreel.geminiKey";
const SCRIPT_CAP = 5000;
const WPM = 150;

const DEFAULTS: Prefs = {
  script: "",
  voVolume: 80,
  captionsOn: true,
  clipFit: "fill",
  bgColor: "#FAF7F2",
  hookOn: false,
  hookText: "Top 5 moments you missed",
  rankingOn: false,
  countdownOn: true,
  zoom: 60,
  voiceName: "Kore",
  ttsModel: DEFAULT_TTS_MODEL,
  veoModel: DEFAULT_VEO_MODEL,
  veoSeconds: "8",
  styleLock: true,
};

// keep prefs forward-compatible with sanity clamps on the AI picks
function fixPrefs(p: Prefs): void {
  if (typeof p.styleLock !== "boolean") p.styleLock = true;
  if (!VOICES.some((v) => v.name === p.voiceName)) p.voiceName = "Kore";
  if (!TTS_MODELS.some((m) => m.id === p.ttsModel)) p.ttsModel = DEFAULT_TTS_MODEL;
  if (!VEO_MODELS.some((m) => m.id === p.veoModel)) p.veoModel = DEFAULT_VEO_MODEL;
  if (!["4", "6", "8"].includes(p.veoSeconds)) p.veoSeconds = "8";
}

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return { ...DEFAULTS };
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Prefs>) };
  } catch {
    return { ...DEFAULTS };
  }
}

let uidN = 0;
function uid(p: string): string {
  uidN += 1;
  return `${p}-${Date.now().toString(36)}-${uidN}`;
}

export function fmtT(s: number): string {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

export function wordCount(text: string): number {
  const w = text.trim().split(/\s+/).filter(Boolean);
  return text.trim() ? w.length : 0;
}

export function spokenSec(text: string): number {
  return (wordCount(text) / WPM) * 60;
}

// ---------- voiceover persistence (IndexedDB) ----------
// Audio blobs are far too big for localStorage, so the current voiceover
// (blob + lane geometry) lives in a tiny idb wrapper: DB `rankreel`,
// store `voiceover`, key `current`. The localStorage keys
// rankreel.prefs.v1 / rankreel.geminiKey stay untouched.
interface VoRecord {
  blob: Blob;
  name: string;
  kind: string;
  offset: number;
  trim: number;
  len: number;
}
const VO_DB = "rankreel";
const VO_STORE = "voiceover";
const VO_KEY = "current";

function voIdbOpen(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    try {
      const req = indexedDB.open(VO_DB, 1);
      req.onupgradeneeded = () => {
        try {
          if (!req.result.objectStoreNames.contains(VO_STORE)) req.result.createObjectStore(VO_STORE);
        } catch {
          /* store exists */
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error("indexeddb open failed"));
      req.onblocked = () => reject(new Error("indexeddb blocked"));
    } catch (e) {
      reject(e);
    }
  });
}

function voIdbStore(mode: IDBTransactionMode): Promise<IDBObjectStore> {
  return voIdbOpen().then(
    (db) =>
      new Promise<IDBObjectStore>((resolve, reject) => {
        try {
          const tx = db.transaction(VO_STORE, mode);
          const store = tx.objectStore(VO_STORE);
          const close = () => {
            try {
              db.close();
            } catch {
              /* noop */
            }
          };
          tx.oncomplete = close;
          tx.onabort = close;
          tx.onerror = () => {
            close();
            reject(tx.error || new Error("indexeddb transaction failed"));
          };
          resolve(store);
        } catch (e) {
          try {
            db.close();
          } catch {
            /* noop */
          }
          reject(e);
        }
      }),
  );
}

function idbSetVo(rec: VoRecord): Promise<void> {
  return voIdbStore("readwrite").then(
    (store) =>
      new Promise<void>((resolve, reject) => {
        try {
          const req = store.put(rec, VO_KEY);
          req.onsuccess = () => resolve();
          req.onerror = () => reject(req.error || new Error("indexeddb put failed"));
        } catch (e) {
          reject(e);
        }
      }),
  );
}

function idbGetVo(): Promise<VoRecord | null> {
  return voIdbStore("readonly").then(
    (store) =>
      new Promise<VoRecord | null>((resolve, reject) => {
        try {
          const req = store.get(VO_KEY);
          req.onsuccess = () => resolve((req.result as VoRecord) || null);
          req.onerror = () => reject(req.error || new Error("indexeddb get failed"));
        } catch (e) {
          reject(e);
        }
      }),
  );
}

function idbDelVo(): Promise<void> {
  return voIdbStore("readwrite")
    .then(
      (store) =>
        new Promise<void>((resolve, reject) => {
          try {
            const req = store.delete(VO_KEY);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error || new Error("indexeddb delete failed"));
          } catch (e) {
            reject(e);
          }
        }),
    )
    .catch(() => undefined); // deletion must never surface an error
}

export function mountStudio(root: HTMLElement): () => void {
  const prefs: Prefs = loadPrefs();
  fixPrefs(prefs);
  const savePrefs = () => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      /* storage full/blocked — non-fatal */
    }
    try {
      paintPreview();
    } catch {
      /* preview not mounted yet */
    }
  };

  // ---------- state (in-memory; blob URLs can't survive reload) ----------
  const media: MediaItem[] = [];
  const timeline: TimelineClip[] = [];
  let captions: Caption[] = [];
  let voiceover: {
    url: string;
    name: string;
    duration: number;
    kind: string;
    offset: number; // start position on the timeline (seconds, >= 0)
    trim: number; // source in-point skipped from the head (seconds, >= 0)
    len: number; // audible length after trimming (seconds, <= duration - trim)
  } | null = null;
  let voSelected = false;
  let selectedId: string | null = null;
  let leftTab: "script" | "media" | "ranking" = "script";
  let rightTab: "captions" | "canvas" = "canvas";
  let mediaSrc: "ai" | "upload" | "link" = "upload";

  // ---------- voiceover lane model ----------
  // duration = true decoded audio length. The editable lane block spans
  // [offset, offset + len) on the timeline and plays source [trim, trim + len).
  //
  // IMPORTANT: setVoiceoverFromBlob is the only entry point that may attach a
  // blob to the voiceover state, because it also owns the IndexedDB write.
  // Removing goes through removeVoiceover (revoke + repaint + idb delete).
  // Everything in between (probe, drag, trim) only mutates offset/trim/len
  // and re-saves via persistVo().
  let voBlob: Blob | null = null; // raw audio bytes behind the current object URL
  let disposed = false;
  const disposeFns: (() => void)[] = [];
  function voLen(): number {
    if (!voiceover) return 0;
    return voiceover.duration > 0 ? voiceover.len : 0;
  }
  function voEnd(): number {
    if (!voiceover) return 0;
    return voiceover.offset + voLen();
  }
  function clampVo(): void {
    if (!voiceover) return;
    if (!(voiceover.duration > 0)) {
      voiceover.offset = 0;
      voiceover.trim = 0;
      voiceover.len = 0;
      return;
    }
    voiceover.trim = Math.max(0, Math.min(voiceover.duration - 0.2, voiceover.trim));
    voiceover.len = Math.max(0.2, Math.min(voiceover.duration - voiceover.trim, voiceover.len));
    voiceover.offset = Math.max(0, voiceover.offset);
  }
  // Save the current voiceover (blob + lane geometry) to IndexedDB. Fire and
  // forget — persistence is a bonus, so failures stay silent.
  function persistVo(): void {
    if (!voiceover || !voBlob) return;
    clampVo();
    const rec: VoRecord = {
      blob: voBlob,
      name: voiceover.name,
      kind: voiceover.kind,
      offset: voiceover.offset,
      trim: voiceover.trim,
      len: voiceover.len,
    };
    idbSetVo(rec).catch(() => undefined);
  }
  function removeVoiceover(msg = "Voiceover removed."): void {
    if (!voiceover) {
      // No stale state survives a delete: ensure the slot, lane, captions,
      // and inspector are all in the empty state even if called twice.
      captions = [];
      voSelected = false;
      paintVoSlot();
      paintRight();
      renderStrip();
      updateStatus();
      return;
    }
    try {
      URL.revokeObjectURL(voiceover.url);
    } catch {
      /* noop */
    }
    voiceover = null;
    voBlob = null;
    voSelected = false;
    captions = [];
    try {
      voAudio.pause();
      voAudio.removeAttribute("src");
      voAudio.load();
    } catch {
      /* noop */
    }
    // Best-effort: the persisted copy must go too, so a refresh after a
    // delete starts clean. Never surfaces errors.
    void idbDelVo();
    paintVoSlot();
    paintRight();
    renderStrip();
    updateStatus();
    toast(msg);
  }

  // ---------- phase 2: google ai state ----------
  let aiBusy = false; // any generation in flight (TTS or Veo)
  let aiSrc: "tts" | "veo" | "" = ""; // which one is running
  let aiStatus = ""; // live progress line for whichever generation is running
  let aiCancel: (() => void) | null = null;
  const shots: MediaItem[] = []; // "your shots" gallery (source==="ai" items)

  // ---------- playback conductor ----------
  let playing = false;
  let playT = 0;
  let raf = 0;
  let lastTs = 0;
  let allMuted = false;
  let rendering = false;
  const videoEls = new Map<string, HTMLVideoElement>();
  const voAudio = new Audio();
  voAudio.preload = "auto";

  const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
    const el = root.querySelector<T>(`#${id}`);
    if (!el) throw new Error(`missing #${id}`);
    return el;
  };

  let toastTimer = 0;
  function toast(msg: string): void {
    const t = $("rrToast");
    t.textContent = msg;
    t.classList.add("show");
    t.classList.toggle("multiline", msg.length > 90);
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(
      () => {
        t.classList.remove("show");
        t.classList.remove("multiline");
      },
      msg.length > 90 ? 9000 : 2600,
    );
  }

  function getKey(): string {
    try {
      const pasted = localStorage.getItem(GKEY_KEY) || "";
      if (pasted) return pasted;
    } catch {
      /* storage blocked — fall through to env key */
    }
    // Optional build-time/runtime env key (e.g. an AI Studio Build import that
    // injects GEMINI_API_KEY). User-pasted localStorage key always wins.
    try {
      return envBundledKey();
    } catch {
      return "";
    }
  }
  /* Where the active key came from: "local" (user-pasted), "env" (bundled /
  injected by the host environment), or "" (none). Guards mirror getKey. */
  function keySource(): "local" | "env" | "" {
    try {
      if (localStorage.getItem(GKEY_KEY)) return "local";
    } catch {
      /* ignore */
    }
    try {
      if (envBundledKey()) return "env";
    } catch {
      /* ignore */
    }
    return "";
  }

  // ---------- layout helpers ----------
  function layout(): { clip: TimelineClip; start: number; end: number }[] {
    const out: { clip: TimelineClip; start: number; end: number }[] = [];
    let t = 0;
    for (const c of timeline) {
      out.push({ clip: c, start: t, end: t + c.dur });
      t += c.dur;
    }
    return out;
  }
  function totalDur(): number {
    return timeline.reduce((a, c) => a + c.dur, 0);
  }
  function clipAt(t: number): { clip: TimelineClip; start: number; end: number; index: number } | null {
    const L = layout();
    for (let i = 0; i < L.length; i++) {
      if (t < L[i].end || (i === L.length - 1 && t <= L[i].end)) {
        return { ...L[i], index: i };
      }
    }
    return null;
  }

  function ensureVideoEl(item: MediaItem): HTMLVideoElement {
    let el = videoEls.get(item.id);
    if (!el) {
      el = document.createElement("video");
      el.preload = "auto";
      el.playsInline = true;
      (el as HTMLVideoElement & { disablePictureInPicture?: boolean }).disablePictureInPicture = true;
      if (item.source === "link") el.crossOrigin = "anonymous";
      el.src = item.url;
      videoEls.set(item.id, el);
      el.addEventListener("loadedmetadata", () => {
        item.duration = el!.duration || item.duration;
        item.width = el!.videoWidth || item.width;
        item.height = el!.videoHeight || item.height;
        // adopt freshly-probed duration into timeline clips that used the 5s fallback
        for (const c of timeline) {
          if (c.mediaId === item.id && c.dur === 5 && item.duration > 0) c.dur = item.duration;
        }
        makeThumb(item, el!);
        refreshMediaGrid();
        renderStrip();
        updateStatus();
        updateTransport();
      });
      el.addEventListener("error", () => {
        // CORS-tainted remote file? retry without crossOrigin so at least preview plays.
        if (el!.getAttribute("crossOrigin") !== null) {
          el!.removeAttribute("crossOrigin");
          item.tainted = true;
          el!.src = item.url;
        } else {
          toast(`Could not load "${item.name}". The link may block embedding.`);
        }
      });
    }
    return el;
  }

  function makeThumb(item: MediaItem, el: HTMLVideoElement): void {
    if (item.tainted || !el.videoWidth) return;
    try {
      const c = document.createElement("canvas");
      c.width = 72;
      c.height = 112;
      const x = c.getContext("2d");
      if (!x) return;
      const t = Math.min(1, (el.duration || 2) / 3);
      const grab = () => {
        try {
          x.fillStyle = "#000";
          x.fillRect(0, 0, c.width, c.height);
          const vw = el.videoWidth;
          const vh = el.videoHeight;
          const s = Math.max(c.width / vw, c.height / vh);
          const dw = vw * s;
          const dh = vh * s;
          x.drawImage(el, (c.width - dw) / 2, (c.height - dh) / 2, dw, dh);
          item.thumb = c.toDataURL("image/jpeg", 0.6);
          refreshMediaGrid();
          renderStrip();
        } catch {
          /* tainted — leave placeholder */
        }
        el.removeEventListener("seeked", grab);
      };
      if (el.readyState >= 2) {
        el.currentTime = t;
        el.addEventListener("seeked", grab, { once: true });
      } else {
        el.addEventListener(
          "loadeddata",
          () => {
            try {
              el.currentTime = t;
            } catch {
              /* noop */
            }
            el.addEventListener("seeked", grab, { once: true });
          },
          { once: true },
        );
      }
    } catch {
      /* noop */
    }
  }

  function guessKind(file: File, url: string): MediaItem["kind"] {
    if (file.type.startsWith("image/")) return "image";
    if (file.type.startsWith("audio/")) return "audio";
    const ext = url.split("?")[0].split(".").pop()?.toLowerCase() || "";
    if (["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp"].includes(ext)) return "image";
    if (["mp3", "wav", "ogg", "oga", "m4a", "aac", "flac"].includes(ext)) return "audio";
    return "video";
  }

  function addMediaFile(file: File, source: MediaItem["source"]): void {
    const url = URL.createObjectURL(file);
    const kind = guessKind(file, file.name);
    const item: MediaItem = {
      id: uid("m"),
      name: file.name,
      url,
      duration: kind === "image" ? 5 : 0,
      width: 0,
      height: 0,
      thumb: "",
      source,
      tainted: false,
      kind,
    };
    if (kind === "image") {
      const img = new Image();
      img.onload = () => {
        item.width = img.naturalWidth;
        item.height = img.naturalHeight;
        item.thumb = makeImageThumb(img);
        URL.revokeObjectURL(url);
        // persist stills as data URLs so they survive in-memory use
        try {
          const c = document.createElement("canvas");
          const s = Math.min(1, 720 / Math.max(img.naturalWidth, img.naturalHeight));
          c.width = Math.max(1, Math.round(img.naturalWidth * s));
          c.height = Math.max(1, Math.round(img.naturalHeight * s));
          c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
          item.url = c.toDataURL("image/jpeg", 0.85);
        } catch {
          /* keep object URL */
        }
        for (const tc of timeline) {
          if (tc.mediaId === item.id) tc.src = item.url;
        }
        refreshMediaGrid();
      };
      img.onerror = () => toast(`Could not read "${file.name}".`);
      img.src = url;
    } else if (kind === "audio") {
      const probe = new Audio();
      probe.preload = "auto";
      probe.src = url;
      probe.addEventListener("loadedmetadata", () => {
        item.duration = probe.duration || 0;
        refreshMediaGrid();
      });
    }
    media.unshift(item);
    if (kind === "video") ensureVideoEl(item);
    refreshMediaGrid();
    toast(`Added "${file.name}" to project media.`);
  }

  function makeImageThumb(img: HTMLImageElement): string {
    try {
      const c = document.createElement("canvas");
      c.width = 72;
      c.height = 112;
      const x = c.getContext("2d")!;
      x.fillStyle = "#000";
      x.fillRect(0, 0, c.width, c.height);
      const s = Math.max(c.width / img.naturalWidth, c.height / img.naturalHeight);
      const dw = img.naturalWidth * s;
      const dh = img.naturalHeight * s;
      x.drawImage(img, (c.width - dw) / 2, (c.height - dh) / 2, dw, dh);
      return c.toDataURL("image/jpeg", 0.6);
    } catch {
      return "";
    }
  }

  function importLink(url: string): void {
    const clean = url.trim();
    if (!clean) return;
    const kind: MediaItem["kind"] = guessKind(new File([], clean), clean);
    // Try to fetch into a blob first (avoids hotlink/CORS-canvas issues).
    toast("Importing link…");
    fetch(clean)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.blob();
      })
      .then((blob) => {
        if (!blob.type.startsWith("video/") && !blob.type.startsWith("audio/") && !blob.type.startsWith("image/")) {
          throw new Error("not a media file");
        }
        const name = clean.split("?")[0].split("/").pop() || "linked-media";
        const objUrl = URL.createObjectURL(blob);
        const item: MediaItem = {
          id: uid("m"),
          name,
          url: objUrl,
          duration: kind === "image" ? 5 : 0,
          width: 0,
          height: 0,
          thumb: "",
          source: "link",
          tainted: false,
          kind,
        };
        media.unshift(item);
        if (kind !== "image") ensureVideoEl(item);
        refreshMediaGrid();
        toast(`Imported "${name}".`);
      })
      .catch(() => {
        // Fall back to direct URL (may be tainted for canvas, preview still plays).
        const name = clean.split("?")[0].split("/").pop() || "linked-video";
        const item: MediaItem = {
          id: uid("m"),
          name,
          url: clean,
          duration: 0,
          width: 0,
          height: 0,
          thumb: "",
          source: "link",
          tainted: false,
          kind,
        };
        media.unshift(item);
        if (kind !== "image") ensureVideoEl(item);
        refreshMediaGrid();
        toast("Direct link added — if the host blocks embedding it may not load.");
      });
  }

  // ================= HTML SHELL =================
  root.innerHTML = `
  <div class="rr-app">
    <div class="rr-topbar">
      <div class="rr-logo"><svg class="rr-mark" viewBox="0 0 32 32" width="22" height="22" aria-hidden="true"><rect x="1.5" y="1.5" width="29" height="29" rx="8" fill="#ff3355"/><path d="M12.5 10.5v11l9.5-5.5z" fill="#fff"/><circle cx="22.6" cy="10.2" r="2.6" fill="#0b0b10"/><text x="22.6" y="11.6" text-anchor="middle" font-size="3.4" font-weight="800" fill="#ff3355" font-family="system-ui,sans-serif">5</text></svg><b>shorts</b>generated<span>STUDIO</span></div>
      <div class="rr-status" id="rrStatus"></div>
      <button class="rr-btn primary" id="rrRenderBtn" disabled>Render</button>
    </div>
    <div class="rr-main">
      <div class="rr-panel left">
        <div class="rr-tabs">
          <button class="rr-tab" data-ltab="script">Script &amp; voice</button>
          <button class="rr-tab" data-ltab="media">Media</button>
          <button class="rr-tab" data-ltab="ranking">Ranking</button>
        </div>
        <div class="rr-tabbody" id="rrLeftBody"></div>
      </div>
      <div class="rr-center">
        <div class="rr-stage"><canvas id="rrCanvas" width="540" height="960"></canvas></div>
      </div>
      <div class="rr-panel right">
        <div class="rr-tabs">
          <button class="rr-tab" data-rtab="captions">Captions</button>
          <button class="rr-tab" data-rtab="canvas">Canvas &amp; title</button>
        </div>
        <div class="rr-tabbody" id="rrRightBody"></div>
      </div>
    </div>
    <div class="rr-bottom">
      <div class="rr-transport">
        <span class="rr-time" id="rrCurT">0:00</span>
        <input class="rr-playhead" id="rrSeek" type="range" min="0" max="1000" value="0" step="1">
        <button class="rr-tbtn" id="rrBack" title="Back 1s">&#8722;1s</button>
        <button class="rr-tbtn play" id="rrPlay" title="Play/Pause">&#9654;</button>
        <button class="rr-tbtn" id="rrFwd" title="Forward 1s">+1s</button>
        <button class="rr-tbtn" id="rrMute" title="Mute">&#128266;</button>
        <span class="rr-time right" id="rrTotT">0:00</span>
      </div>
      <div class="rr-timelinebar">
        <span class="rr-tl-label">TIMELINE</span>
        <span class="rr-tl-count" id="rrTlCount"></span>
        <span class="rr-tl-spacer"></span>
        <button class="rr-btn small" id="rrSplit">Split at playhead</button>
        <button class="rr-btn small" id="rrDelete">Delete selected</button>
        <button class="rr-btn small" id="rrFitVo">Fit to voiceover</button>
        <span class="rr-zoom">Zoom <input id="rrZoom" type="range" min="20" max="140" step="5"></span>
      </div>
      <div class="rr-insp" id="rrInsp"></div>
      <div class="rr-stripwrap"><div class="rr-strip" id="rrStrip"></div></div>
      <div id="rrTlEmpty"></div>
      <div class="rr-renderbar" id="rrRenderBar">
        <div class="rr-prog"><div id="rrProgFill"></div></div>
        <div class="rr-renderrow"><span id="rrProgLabel"></span><span id="rrDlSlot"></span></div>
      </div>
    </div>
    <div class="rr-toast" id="rrToast"></div>
  </div>
  <input type="file" id="rrFileVo" accept="audio/*,video/*" style="display:none">
  <input type="file" id="rrFileMedia" accept="video/*,audio/*,image/*" multiple style="display:none">
  `;

  const canvas = $("rrCanvas") as unknown as HTMLCanvasElement;
  const ctx = canvas.getContext("2d")!;

  // ================= LEFT PANEL =================
  function paintLeft(): void {
    root.querySelectorAll("[data-ltab]").forEach((b) => {
      b.classList.toggle("active", (b as HTMLElement).dataset.ltab === leftTab);
    });
    const body = $("rrLeftBody");
    if (leftTab === "script") paintScript(body);
    else if (leftTab === "media") paintMedia(body);
    else paintRanking(body);
  }

  function paintScript(body: HTMLElement): void {
    const wc = wordCount(prefs.script);
    const sp = spokenSec(prefs.script);
    const connected = !!getKey();
    body.innerHTML = `
      <div class="rr-h">SCRIPT</div>
      <textarea class="rr-textarea" id="rrScript" maxlength="${SCRIPT_CAP}"
        placeholder="Mỗi chiếc máy bay đều có một lỗ nhỏ trên cửa sổ. Và đó không phải là lỗi của nhà sản xuất."></textarea>
      <div class="rr-counter" id="rrScriptCount">${wc} words &middot; ~${fmtT(sp)} spoken &middot; ${prefs.script.length}/${SCRIPT_CAP}</div>
      <div class="rr-h">VOICEOVER</div>
      <div class="rr-sub"><b style="color:var(--rr-text)">AI read</b><br>Turns your script into a narrated voiceover in the voice you pick.</div>
      <div class="rr-row" style="gap:6px">
        <select class="rr-select" id="rrVoice" title="Narrator voice (Vietnamese)"></select>
        <select class="rr-select" id="rrTtsModel" title="TTS model"></select>
      </div>
      <div class="rr-note">Narrator voice (Vietnamese) &mdash; all voices read your script in Vietnamese.</div>
      <button class="rr-btn block primary" id="rrGenVo">Generate AI read</button>
      <div class="rr-ai-status" id="rrTtsStatus"></div>
      <div class="rr-keystate" id="rrKeyState">${connected ? (keySource() === "env" ? "Connected via this app's built-in environment key — your key works for AI read and AI shots." : "Connected — your key works for AI read and AI shots.") : "Not connected yet — pick a voice, hit Generate, and you'll be asked to connect."}</div>
      <button class="rr-btn block" id="rrConnect">${!connected ? "Connect Google AI" : keySource() === "env" ? "Using built-in key — use your own instead" : "Manage Google AI key"}</button>
      <button class="rr-btn block" id="rrRecord">Record your read</button>
      <button class="rr-btn block" id="rrUploadVo">Upload a voiceover file</button>
      <div id="rrVoSlot"></div>
      <div class="rr-h">MIX</div>
      <div class="rr-row"><span style="color:var(--rr-dim)">Voiceover volume</span>
        <input class="rr-slider" id="rrVoVol" type="range" min="0" max="100" value="${prefs.voVolume}">
        <span id="rrVoVolV" style="min-width:36px;text-align:right">${prefs.voVolume}%</span></div>
      <div class="rr-note">Clip audio lands muted and is unmuted per clip in the timeline inspector.</div>
    `;
    const ta = $("rrScript") as unknown as HTMLTextAreaElement;
    ta.value = prefs.script;
    ta.addEventListener("input", () => {
      prefs.script = ta.value.slice(0, SCRIPT_CAP);
      const w = wordCount(prefs.script);
      const s = spokenSec(prefs.script);
      $("rrScriptCount").innerHTML = `${w} words &middot; ~${fmtT(s)} spoken &middot; ${prefs.script.length}/${SCRIPT_CAP}`;
      savePrefs();
    });
    const voiceSel = $("rrVoice") as unknown as HTMLSelectElement;
    voiceSel.innerHTML = VOICES.map((v) => `<option value="${v.name}">${v.name} — ${v.tag}</option>`).join("");
    voiceSel.value = prefs.voiceName;
    voiceSel.addEventListener("change", () => {
      prefs.voiceName = voiceSel.value;
      savePrefs();
    });
    const ttsSel = $("rrTtsModel") as unknown as HTMLSelectElement;
    ttsSel.innerHTML = TTS_MODELS.map((m) => `<option value="${m.id}">${m.label}</option>`).join("");
    ttsSel.value = prefs.ttsModel;
    ttsSel.addEventListener("change", () => {
      prefs.ttsModel = ttsSel.value;
      savePrefs();
    });
    const genVo = $("rrGenVo") as HTMLButtonElement;
    genVo.disabled = aiBusy;
    genVo.addEventListener("click", () => void generateAiRead());
    ($("rrConnect") as HTMLButtonElement).addEventListener("click", () => openConnect());
    ($("rrRecord") as HTMLButtonElement).addEventListener("click", toggleRecord);
    ($("rrUploadVo") as HTMLButtonElement).addEventListener("click", () =>
      ($("rrFileVo") as unknown as HTMLInputElement).click(),
    );
    ($("rrVoVol") as unknown as HTMLInputElement).addEventListener("input", (e) => {
      prefs.voVolume = Number((e.target as HTMLInputElement).value);
      $("rrVoVolV").textContent = `${prefs.voVolume}%`;
      voAudio.volume = allMuted ? 0 : prefs.voVolume / 100;
      savePrefs();
    });
    paintVoSlot();
    if (aiStatus && aiSrc === "tts") {
      const st = $("rrTtsStatus");
      st.textContent = aiStatus;
      st.classList.add("show");
    }
  }

  /* ================= GOOGLE AI: TTS VOICEOVER ================= */
  async function generateAiRead(): Promise<void> {
    const key = getKey();
    if (!key) {
      openConnect("generate the AI read");
      return;
    }
    if (aiBusy) return;
    if (!prefs.script.trim()) {
      toast("Write a script first — the AI read narrates it.");
      return;
    }
    aiBusy = true;
    aiSrc = "tts";
    const btn = root.querySelector("#rrGenVo") as HTMLButtonElement | null;
    if (btn) btn.disabled = true;
    try {
      const { wav } = await ttsSpeak(key, prefs.ttsModel, prefs.script, prefs.voiceName, setAiStatusEl);
      setVoiceoverFromBlob(wav, `ai-read-${prefs.voiceName.toLowerCase()}.wav`, "ai");
      if (leftTab === "script") paintLeft();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast(`AI read failed — ${msg}`);
    } finally {
      aiBusy = false;
      aiSrc = "";
      aiStatus = "";
      setAiStatusEl("");
      if (btn) btn.disabled = false;
    }
  }

  function setAiStatusEl(s: string): void {
    aiStatus = s;
    const el = root.querySelector("#rrTtsStatus");
    if (el) {
      el.textContent = s;
      el.classList.toggle("show", !!s);
    }
  }

  function paintVoSlot(): void {
    const slot = root.querySelector("#rrVoSlot");
    if (!slot) return;
    if (!voiceover) {
      slot.innerHTML = "";
      return;
    }
    slot.innerHTML = `
      <div class="rr-vo-card"><div class="rr-row">
        <span class="rr-vo-name" title="${esc(voiceover.name)}">${esc(voiceover.name)}</span>
        <span class="rr-vo-dur">${fmtT(voiceover.duration)}</span>
      </div><div class="rr-vo-actions">
        <button class="rr-btn small" id="rrVoPlay">Preview</button>
        <a class="rr-btn small rr-dl-link" id="rrVoDl" href="${voiceover.url}" download="${escAttr(downloadName(voiceover.name))}">Download</a>
        ${voiceover.kind === "ai" ? `<button class="rr-btn small" id="rrVoRegen">Regenerate</button>` : ""}
        <button class="rr-btn small" id="rrVoDel">Remove</button>
      </div></div>`;
    ($("rrVoPlay") as HTMLButtonElement).addEventListener("click", () => {
      const a = new Audio(voiceover!.url);
      a.volume = prefs.voVolume / 100;
      a.play().catch(() => toast("Could not play that file."));
    });
    // Download: plain <a download> on the blob URL — no JS fetch, so it
    // works for AI wav, recordings, and uploads alike.
    const dl = $("rrVoDl") as unknown as HTMLAnchorElement;
    dl.addEventListener("click", () => {
      toast(`Downloading ${voiceover!.name}…`);
    });
    const regen = root.querySelector("#rrVoRegen") as HTMLButtonElement | null;
    if (regen) {
      regen.disabled = aiBusy;
      regen.addEventListener("click", () => void regenerateVo());
    }
    ($("rrVoDel") as HTMLButtonElement).addEventListener("click", () => removeVoiceover());
  }

  // Re-run the last AI read with the current voice+model. Only offered for
  // AI-kind voiceovers (the card hides the button otherwise). Deleting the
  // old audio first means a failed regen leaves the slot cleanly empty —
  // and Generate AI read immediately works again, no dead end.
  async function regenerateVo(): Promise<void> {
    if (aiBusy) return;
    const key = getKey();
    if (!key) {
      openConnect("regenerate the AI read");
      return;
    }
    if (!prefs.script.trim()) {
      toast("Write a script first — the AI read narrates it.");
      return;
    }
    removeVoiceoverSilent();
    await generateAiRead();
  }

  // Same full reset as removeVoiceover but without the toast (the caller's
  // success/failure toast follows immediately).
  function removeVoiceoverSilent(): void {
    if (!voiceover) return;
    try {
      URL.revokeObjectURL(voiceover.url);
    } catch {
      /* noop */
    }
    voiceover = null;
    voBlob = null;
    voSelected = false;
    captions = [];
    try {
      voAudio.pause();
      voAudio.removeAttribute("src");
      voAudio.load();
    } catch {
      /* noop */
    }
    void idbDelVo();
    paintVoSlot();
    paintRight();
    renderStrip();
    updateStatus();
  }

  let recorder: MediaRecorder | null = null;
  let recChunks: Blob[] = [];
  let recStream: MediaStream | null = null;

  function toggleRecord(): void {
    if (recorder && recorder.state === "recording") {
      recorder.stop();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      toast("This browser cannot access the microphone.");
      return;
    }
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => {
        recStream = stream;
        recChunks = [];
        const mr = new MediaRecorder(stream);
        recorder = mr;
        mr.ondataavailable = (e) => {
          if (e.data.size) recChunks.push(e.data);
        };
        mr.onstop = () => {
          recStream?.getTracks().forEach((t) => t.stop());
          recStream = null;
          const blob = new Blob(recChunks, { type: mr.mimeType || "audio/webm" });
          setVoiceoverFromBlob(blob, "my-read.webm", "record");
          recorder = null;
          if (leftTab === "script") paintLeft();
        };
        mr.start();
        if (leftTab === "script") paintLeft();
        toast("Recording… click again to stop.");
      })
      .catch(() => toast("Microphone blocked. Allow mic access to record."));
  }

  function setVoiceoverFromBlob(blob: Blob, name: string, kind: string, saved?: { offset: number; trim: number; len: number }): void {
    if (voiceover) {
      try {
        URL.revokeObjectURL(voiceover.url);
      } catch {
        /* noop */
      }
    }
    const url = URL.createObjectURL(blob);
    voBlob = blob;
    const probe = new Audio();
    probe.preload = "auto";
    probe.src = url;
    voiceover = { url, name, duration: 0, kind, offset: 0, trim: 0, len: 0 };
    voSelected = false;
    probe.addEventListener("loadedmetadata", () => {
      if (!voiceover || voiceover.url !== url || disposed) return;
      voiceover.duration = probe.duration || 0;
      if (saved && voiceover.duration > 0) {
        voiceover.trim = saved.trim;
        voiceover.len = saved.len;
        voiceover.offset = saved.offset;
      } else {
        voiceover.trim = 0;
        voiceover.len = voiceover.duration;
        voiceover.offset = 0;
      }
      clampVo();
      persistVo();
      if (buildCaptions()) {
        if (!saved) toast(`Voiceover set: ${name} — captions timed to it.`);
      }
      paintVoSlot();
      paintRight();
      renderStrip();
      updateStatus();
    });
    probe.addEventListener("error", () => {
      if (!voiceover || voiceover.url !== url || disposed) return;
      removeVoiceoverSilent();
      if (!saved) toast(`Could not read "${name}" — try a different audio file.`);
    });
    voAudio.src = url;
    voAudio.volume = prefs.voVolume / 100;
    captions = [];
    persistVo();
    paintVoSlot();
    paintRight();
    renderStrip();
    if (!saved) toast(`Voiceover set: ${name}`);
  }


  /* Even word-rate caption timing across the voiceover's effective span
     (trimmed length), shifted by its lane offset. Returns
     false (and leaves captions empty) when there's nothing to time against. */
  function buildCaptions(): boolean {
    if (!voiceover || !(voiceover.duration > 0)) {
      captions = [];
      return false;
    }
    clampVo();
    const lines = splitSentences(prefs.script);
    if (!lines.length) {
      captions = [];
      return false;
    }
    const total = voLen();
    if (!(total > 0)) {
      captions = [];
      return false;
    }
    const weights = lines.map((l) => Math.max(1, l.split(/\s+/).length));
    const wSum = weights.reduce((a, b) => a + b, 0);
    captions = [];
    let t = 0;
    lines.forEach((line, i) => {
      const d = i === lines.length - 1 ? total - t : (weights[i] / wSum) * total;
      captions.push({
        start: voiceover!.offset + t,
        end: Math.min(voiceover!.offset + total, voiceover!.offset + t + d),
        text: line,
      });
      t += d;
    });
    return true;
  }

  // Re-time existing captions to the voiceover's current offset/trim without
  // changing their text. Pure lane moves shift every caption by the same
  // delta (exact); trims rescale relative timings into the new span. If
  // there are no captions to shift, rebuild from scratch.
  function retimeCaptionsToVo(mode: "move" | "rescale" = "rescale", delta = 0): void {
    if (!voiceover) {
      captions = [];
      return;
    }
    clampVo();
    if (!captions.length) {
      buildCaptions();
      return;
    }
    if (mode === "move") {
      for (const c of captions) {
        c.start = Math.max(0, c.start + delta);
        c.end = Math.max(0, c.end + delta);
      }
      return;
    }
    // Map old absolute timings into fractions of the previous span, then into
    // the new span. The previous span is unknown here, so use the current
    // caption bounds as the old span — good enough for offset/trim edits.
    let lo = Infinity;
    let hi = -Infinity;
    for (const c of captions) {
      lo = Math.min(lo, c.start);
      hi = Math.max(hi, c.end);
    }
    const oldSpan = hi - lo;
    const newLen = voLen();
    if (!(oldSpan > 0) || !(newLen > 0)) {
      buildCaptions();
      return;
    }
    const base = voiceover.offset;
    for (const c of captions) {
      const fs = (c.start - lo) / oldSpan;
      const fe = (c.end - lo) / oldSpan;
      c.start = base + fs * newLen;
      c.end = base + fe * newLen;
    }
  }

  // Voiceover audibility at timeline time t: inside the lane block and with
  // a decoded duration. Returns the source time to play, or null = silent.
  function voSourceAt(t: number): number | null {
    if (!voiceover || !(voiceover.duration > 0)) return null;
    const len = voLen();
    if (!(len > 0)) return null;
    if (t < voiceover.offset || t >= voiceover.offset + len) return null;
    const src = voiceover.trim + (t - voiceover.offset);
    if (src < 0 || src >= voiceover.duration) return null;
    return src;
  }

  function syncVoToPlayhead(): void {
    if (!voiceover) return;
    const src = voSourceAt(playT);
    if (src === null) {
      if (!voAudio.paused) voAudio.pause();
      return;
    }
    if (Math.abs(voAudio.currentTime - src) > 0.4) {
      try {
        voAudio.currentTime = Math.min(src, voiceover.duration - 0.05);
      } catch {
        /* noop */
      }
    }
    if (playing && voAudio.paused) voAudio.play().catch(() => undefined);
  }

  function paintMedia(body: HTMLElement): void {
    body.innerHTML = `
      <div class="rr-h">SOURCE</div>
      <div class="rr-seg" style="margin-bottom:8px">
        <button data-msrc="ai">AI</button>
        <button data-msrc="upload">Upload</button>
        <button data-msrc="link">Link</button>
      </div>
      <div id="rrSrcBody"></div>
      <div class="rr-h">PROJECT MEDIA</div>
      <div class="rr-sub">Everything in this edit. Send items to the timeline.</div>
      <div class="rr-grid" id="rrMediaGrid"></div>
      <div class="rr-h">YOUR SHOTS</div>
      <div class="rr-sub">AI generations saved in this browser. Nothing here yet.</div>
      <div class="rr-empty" id="rrShotsEmpty">No saved shots yet.</div>
    `;
    body.querySelectorAll("[data-msrc]").forEach((b) => {
      const on = (b as HTMLElement).dataset.msrc === mediaSrc;
      b.classList.toggle("active", on);
      (b as HTMLButtonElement).addEventListener("click", () => {
        mediaSrc = (b as HTMLElement).dataset.msrc as typeof mediaSrc;
        paintMedia(body);
      });
    });
    const sb = $("rrSrcBody");
    if (mediaSrc === "ai") {
      const has = !!getKey();
      sb.innerHTML = has
        ? `
        <div class="rr-row" style="gap:6px">
          <select class="rr-select" id="rrVeoModel" title="Veo model"></select>
          <select class="rr-select" id="rrVeoSec" title="Shot length">
            <option value="4">4s</option><option value="6">6s</option><option value="8">8s</option>
          </select>
        </div>
        <textarea class="rr-textarea" id="rrVeoPrompt" style="min-height:64px"
          placeholder="Describe the shot — e.g. slow push-in on a glowing scoreboard in a dark arena"></textarea>
        <label class="rr-row" for="rrStyleLock" title="On: every shot is rendered in the channel's iconographic light style (off-white background, abstract shapes, no faces, no text). Off: Veo gets your raw prompt only."
          style="gap:8px;align-items:center;margin:6px 0 8px;cursor:pointer">
          <input type="checkbox" id="rrStyleLock" ${prefs.styleLock !== false ? "checked" : ""} style="width:18px;height:18px;accent-color:#f59e0b">
          <span style="font-size:12px">Channel style lock <span style="color:var(--rr-dim)">— every shot in the iconographic light style</span></span>
        </label>
        <button class="rr-btn block primary" id="rrGenShot">Generate shot</button>
        <div class="rr-ai-status" id="rrAiStatus"></div>
        <div class="rr-note">9:16 vertical &middot; 720p &middot; renders on your Google AI account &middot; typically takes 1&ndash;3 min.</div>`
        : `<div class="rr-sub"><b style="color:var(--rr-text)">Sign in to generate</b><br>AI shots render on your Google AI account.</div>
           <button class="rr-btn block" id="rrConnect2">Connect Google AI</button>`;
      const c2 = root.querySelector("#rrConnect2");
      if (c2) c2.addEventListener("click", openConnect);
      if (has) {
        const vm = $("rrVeoModel") as unknown as HTMLSelectElement;
        vm.innerHTML = VEO_MODELS.map((m) => `<option value="${m.id}">${m.label}</option>`).join("");
        vm.value = prefs.veoModel;
        vm.addEventListener("change", () => {
          prefs.veoModel = vm.value;
          savePrefs();
        });
        const vs = $("rrVeoSec") as unknown as HTMLSelectElement;
        vs.value = prefs.veoSeconds;
        vs.addEventListener("change", () => {
          prefs.veoSeconds = vs.value as typeof prefs.veoSeconds;
          savePrefs();
        });
        const lock = $("rrStyleLock") as HTMLInputElement;
        lock.addEventListener("change", () => {
          prefs.styleLock = lock.checked;
          savePrefs();
        });
        const gen = $("rrGenShot") as HTMLButtonElement;
        gen.disabled = aiBusy;
        gen.addEventListener("click", () => void generateShot());
        const st = $("rrAiStatus");
        if (aiStatus && aiSrc === "veo") {
          st.textContent = aiStatus;
          st.classList.add("show");
        }
      }
    } else if (mediaSrc === "upload") {
      sb.innerHTML = `<button class="rr-btn block" id="rrUploadMedia">Upload video / audio / image</button>`;
      ($("rrUploadMedia") as HTMLButtonElement).addEventListener("click", () =>
        ($("rrFileMedia") as unknown as HTMLInputElement).click(),
      );
    } else {
      sb.innerHTML = `
        <div class="rr-row">
          <input class="rr-textinput" id="rrLinkUrl" type="url" placeholder="Paste a direct video link (mp4/webm)…">
          <button class="rr-btn" id="rrLinkGo">Import</button>
        </div>
        <div class="rr-note">Tip: needs a direct file link. Pages like YouTube watch URLs won't import.</div>`;
      const go = () => {
        const v = ($("rrLinkUrl") as unknown as HTMLInputElement).value.trim();
        if (v) importLink(v);
      };
      ($("rrLinkGo") as HTMLButtonElement).addEventListener("click", go);
      ($("rrLinkUrl") as unknown as HTMLInputElement).addEventListener("keydown", (e) => {
        if (e.key === "Enter") go();
      });
    }
    refreshMediaGrid();
    refreshShotsGrid();
  }

  function refreshShotsGrid(): void {
    const empty = root.querySelector("#rrShotsEmpty");
    if (!empty) return;
    if (!shots.length) {
      empty.style.display = "";
      return;
    }
    empty.style.display = "none";
    let grid = root.querySelector<HTMLDivElement>("#rrShotsGrid");
    if (!grid) {
      grid = document.createElement("div");
      grid.className = "rr-grid";
      grid.id = "rrShotsGrid";
      empty.parentElement!.insertBefore(grid, empty);
    }
    grid.innerHTML = "";
    for (const m of [...shots].reverse()) {
      const card = document.createElement("div");
      card.className = "rr-card";
      const img = document.createElement("img");
      img.alt = m.name;
      img.src = m.thumb || thumbPlaceholder();
      card.appendChild(img);
      const meta = document.createElement("div");
      meta.className = "rr-meta";
      const nm = document.createElement("div");
      nm.className = "rr-name";
      nm.textContent = m.name;
      nm.title = m.name;
      meta.appendChild(nm);
      const du = document.createElement("div");
      du.className = "rr-dur";
      du.textContent = m.duration ? `${fmtT(m.duration)} · ai` : "ai";
      meta.appendChild(du);
      const btn = document.createElement("button");
      btn.className = "rr-btn small";
      btn.style.width = "100%";
      btn.textContent = "Send to timeline";
      btn.addEventListener("click", () => sendToTimeline(m.id));
      meta.appendChild(btn);
      card.appendChild(meta);
      grid.appendChild(card);
    }
  }

  /* ================= GOOGLE AI: VEO SHOT GENERATION ================= */
  function setAiStatus(s: string): void {
    aiStatus = s;
    const el = root.querySelector("#rrAiStatus");
    if (el) {
      el.textContent = s;
      el.classList.toggle("show", !!s);
    }
  }

  async function generateShot(): Promise<void> {
    const key = getKey();
    if (!key) {
      openConnect("Generate a shot");
      return;
    }
    if (aiBusy) return;
    let prompt = "";
    try {
      prompt = ($("rrVeoPrompt") as unknown as HTMLTextAreaElement).value.trim();
    } catch {
      /* panel not mounted */
    }
    if (!prompt) {
      toast("Describe the shot first — what should Veo render?");
      return;
    }
    aiBusy = true;
    aiSrc = "veo";
    const genBtn = root.querySelector("#rrGenShot") as HTMLButtonElement | null;
    if (genBtn) genBtn.disabled = true;
    let cancelled = false;
    aiCancel = () => {
      cancelled = true;
    };
    const t0 = Date.now();
    try {
      const { blob, name } = await veoGenerateShot(key, prefs.veoModel, prompt, {
        durationSeconds: prefs.veoSeconds,
        styleLock: prefs.styleLock !== false,
        onStatus: setAiStatus,
        isCancelled: () => cancelled,
      });
      addAiShot(blob, name, (Date.now() - t0) / 1000);
      setAiStatus("");
      aiStatus = "";
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (cancelled) {
        setAiStatus("");
        aiStatus = "";
        toast("Shot generation cancelled.");
      } else {
        setAiStatus("");
        aiStatus = "";
        toast(`AI shot failed — ${msg}`);
      }
    } finally {
      aiBusy = false;
      aiCancel = null;
      if (genBtn) genBtn.disabled = false;
    }
  }

  /* Blob in, library item out: wire duration/thumb probing like an upload. */
  function addAiShot(blob: Blob, name: string, genSecs: number): void {
    const url = URL.createObjectURL(blob);
    const item: MediaItem = {
      id: uid("m"),
      name,
      url,
      duration: 0,
      width: 0,
      height: 0,
      thumb: "",
      source: "ai",
      tainted: false,
      kind: "video",
    };
    media.unshift(item);
    shots.unshift(item);
    ensureVideoEl(item);
    refreshMediaGrid();
    refreshShotsGrid();
    toast(`Shot ready after ${Math.round(genSecs)}s — "${name}" added to project media.`);
  }

  function refreshMediaGrid(): void {
    const grid = root.querySelector("#rrMediaGrid");
    if (!grid) return;
    if (!media.length) {
      grid.innerHTML = `<div class="rr-empty">Nothing yet — upload a file or import a link above.</div>`;
      return;
    }
    grid.innerHTML = "";
    for (const m of media) {
      const card = document.createElement("div");
      card.className = "rr-card";
      const img = document.createElement("img");
      img.alt = m.name;
      img.src = m.thumb || thumbPlaceholder();
      card.appendChild(img);
      const meta = document.createElement("div");
      meta.className = "rr-meta";
      const nm = document.createElement("div");
      nm.className = "rr-name";
      nm.textContent = m.name;
      nm.title = m.name;
      meta.appendChild(nm);
      const du = document.createElement("div");
      du.className = "rr-dur";
      du.textContent = m.duration ? `${fmtT(m.duration)} · ${m.source}` : m.source;
      meta.appendChild(du);
      const btn = document.createElement("button");
      btn.className = "rr-btn small";
      btn.style.width = "100%";
      btn.textContent = "Send to timeline";
      btn.addEventListener("click", () => sendToTimeline(m.id));
      meta.appendChild(btn);
      card.appendChild(meta);
      grid.appendChild(card);
    }
  }

  function thumbPlaceholder(): string {
    return (
      "data:image/svg+xml," +
      encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="112"><rect width="72" height="112" fill="#1b1b26"/><text x="36" y="60" fill="#6d6d80" font-size="10" text-anchor="middle">video</text></svg>`,
      )
    );
  }

  function sendToTimeline(mediaId: string): void {
    const m = media.find((x) => x.id === mediaId);
    if (!m) return;
    ensureVideoEl(m);
    const dur = m.duration > 0 ? m.duration : 5;
    const n = timeline.length + 1;
    timeline.push({
      id: uid("c"),
      mediaId: m.id,
      src: m.url,
      name: m.name,
      start: 0,
      dur,
      muted: true,
      number: n,
      label: "",
    });
    selectedId = timeline[timeline.length - 1].id;
    afterTimelineChange();
    if (leftTab === "ranking") paintLeft();
    toast(`Clip added to timeline (${fmtT(dur)}).`);
  }

  function paintRanking(body: HTMLElement): void {
    body.innerHTML = `
      <div class="rr-row between">
        <div><div class="rr-h" style="margin:0">RANKING</div>
        <div class="rr-sub" style="margin:2px 0 0">Countdown chrome for Top-5 style videos. Turning it on also keeps the title on screen for the whole video.</div></div>
        <label class="rr-switch"><input type="checkbox" id="rrRankOn" ${prefs.rankingOn ? "checked" : ""}><span class="rr-track"></span></label>
      </div>
      <div id="rrRankBody"></div>
    `;
    ($("rrRankOn") as unknown as HTMLInputElement).addEventListener("change", (e) => {
      prefs.rankingOn = (e.target as HTMLInputElement).checked;
      savePrefs();
      paintRanking(body);
    });
    const rb = $("rrRankBody");
    if (!prefs.rankingOn) {
      rb.innerHTML = `<div class="rr-note">Ranking is off. Turn it on to number your clips and show countdown chrome.</div>`;
      return;
    }
    rb.innerHTML = `
      <div class="rr-row" style="margin-top:8px"><span style="color:var(--rr-dim)">On-screen countdown</span>
        <span style="flex:1"></span>
        <label class="rr-switch"><input type="checkbox" id="rrCountOn" ${prefs.countdownOn ? "checked" : ""}><span class="rr-track"></span></label>
      </div>
      <div class="rr-note">Tap a row to select that clip. Numbers burn into the video.</div>
      <div id="rrRankRows"></div>
    `;
    ($("rrCountOn") as unknown as HTMLInputElement).addEventListener("change", (e) => {
      prefs.countdownOn = (e.target as HTMLInputElement).checked;
      savePrefs();
    });
    const rows = $("rrRankRows");
    if (!timeline.length) {
      rows.innerHTML = `<div class="rr-empty">No clips yet — send media to the timeline first.</div>`;
      return;
    }
    timeline.forEach((c, i) => {
      const row = document.createElement("div");
      row.className = "rr-rankrow" + (c.id === selectedId ? " selected" : "");
      row.innerHTML = `
        <span class="rr-numbadge">${c.number}</span>
        <input type="text" placeholder="Moment label (e.g. The window hole)" value="${esc(c.label)}">
        <input type="number" min="1" max="99" value="${c.number}" title="Clip number">`;
      row.addEventListener("click", () => {
        selectedId = c.id;
        renderStrip();
        paintInspector();
        rows.querySelectorAll(".rr-rankrow").forEach((r) => r.classList.remove("selected"));
        row.classList.add("selected");
      });
      const [labelIn, numIn] = row.querySelectorAll("input");
      labelIn.addEventListener("input", () => {
        c.label = (labelIn as HTMLInputElement).value;
      });
      numIn.addEventListener("change", () => {
        c.number = Math.max(1, Math.min(99, Number((numIn as HTMLInputElement).value) || c.number));
        (numIn as HTMLInputElement).value = String(c.number);
        row.querySelector(".rr-numbadge")!.textContent = String(c.number);
        renderStrip();
      });
      rows.appendChild(row);
      void i;
    });
  }

  function openConnect(context?: string): void {
    const back = document.createElement("div");
    back.className = "rr-modalback";
    const src = keySource();
    const existing = src === "local" ? getKey() : "";
    const envNote =
      src === "env"
        ? `<p class="rr-note" style="color:var(--rr-ok);margin:0 0 6px">This copy of the app already provides an environment key — generation works without pasting anything. Pasting your own key below overrides it (and bills to your own Google account instead).</p>`
        : "";
    const ctxLine = context
      ? `<p class="rr-note" style="color:var(--rr-accent2);margin:0 0 6px">Needed to ${esc(context)}.</p>`
      : "";
    back.innerHTML = `
      <div class="rr-modal">
        <h3>Connect Google AI</h3>
        <p>Paste a Gemini API key — it stays in this browser's local storage only and is sent
        only to Google's API (generativelanguage.googleapis.com). AI shots and narration render on
        <b style="color:var(--rr-text)">your own Google AI account</b>, billed to you, never us. Get a key at
        <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a>.</p>
        ${envNote}
        ${ctxLine}
        <input class="rr-textinput" id="rrKeyIn" type="password" placeholder="Gemini API key" value="${esc(existing)}" style="margin:10px 0">
        <div class="rr-keymsg" id="rrKeyMsg"></div>
        <div class="rr-row" style="justify-content:flex-end;margin-top:8px">
          <button class="rr-btn" id="rrKeyCancel">Cancel</button>
          ${existing ? `<button class="rr-btn" id="rrKeyDisconnect">Disconnect</button>` : ""}
          <button class="rr-btn primary" id="rrKeySave">Save &amp; verify</button>
        </div>
      </div>`;
    root.appendChild(back);
    const close = () => back.remove();
    back.addEventListener("click", (e) => {
      if (e.target === back) close();
    });
    (back.querySelector("#rrKeyCancel") as HTMLButtonElement).addEventListener("click", close);
    const disconnectBtn = back.querySelector("#rrKeyDisconnect") as HTMLButtonElement | null;
    if (disconnectBtn) {
      disconnectBtn.addEventListener("click", () => {
        try {
          localStorage.removeItem(GKEY_KEY);
        } catch {
          /* noop */
        }
        close();
        toast(
          keySource() === "env"
            ? "Your pasted key was removed — this copy still uses its built-in environment key."
            : "Google AI disconnected — key removed from this browser.",
        );
        repaintForConnection();
      });
    }
    (back.querySelector("#rrKeySave") as HTMLButtonElement).addEventListener("click", async () => {
      const inp = back.querySelector("#rrKeyIn") as HTMLInputElement;
      const msg = back.querySelector("#rrKeyMsg") as HTMLElement;
      const save = back.querySelector("#rrKeySave") as HTMLButtonElement;
      const v = inp.value.trim();
      if (!v) {
        msg.textContent = "Paste a key first (aistudio.google.com/apikey).";
        msg.className = "rr-keymsg show err";
        return;
      }
      save.disabled = true;
      save.textContent = "Verifying…";
      msg.textContent = "Checking the key with a tiny Google call…";
      msg.className = "rr-keymsg show";
      try {
        await validateKey(v);
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        msg.textContent = m;
        msg.className = "rr-keymsg show err";
        save.disabled = false;
        save.textContent = "Save & verify";
        return;
      }
      try {
        localStorage.setItem(GKEY_KEY, v);
      } catch {
        /* storage blocked — key just won't survive reload */
      }
      close();
      toast("Google AI connected — generation bills to your Google account.");
      repaintForConnection();
    });
  }

  function repaintForConnection(): void {
    if (leftTab === "media") paintLeft();
    const scriptBody = root.querySelector<HTMLDivElement>("#rrLeftBody");
    if (leftTab === "script" && scriptBody) {
      const btn = scriptBody.querySelector<HTMLButtonElement>("#rrConnect");
      if (btn) {
        if (keySource() === "env") {
          btn.textContent = "Using built-in key — use your own instead";
          btn.disabled = false;
        } else {
          btn.textContent = "Google AI connected";
          btn.disabled = true;
        }
      }
      const m = scriptBody.querySelector<HTMLElement>("#rrKeyState");
      if (m)
        m.textContent =
          keySource() === "env"
            ? "Connected via this app's built-in environment key — your key works for AI read and AI shots."
            : "Connected — your key works for AI read and AI shots.";
    }
  }

  function esc(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function escAttr(s: string): string {
    return esc(s).replace(/'/g, "&#39;");
  }
  // Safe filename for the voice download: keep the voice name but strip
  // path separators and other characters browsers dislike.
  function downloadName(name: string): string {
    const base = name.replace(/[\\/:*?"<>|]/g, "_").trim() || "voiceover";
    return /\.[a-z0-9]{2,5}$/i.test(base) ? base : `${base}.wav`;
  }

  // ================= RIGHT PANEL =================
  function paintRight(): void {
    root.querySelectorAll("[data-rtab]").forEach((b) => {
      b.classList.toggle("active", (b as HTMLElement).dataset.rtab === rightTab);
    });
    const body = $("rrRightBody");
    if (rightTab === "captions") paintCaptions(body);
    else paintCanvasPanel(body);
  }

  function splitSentences(text: string): string[] {
    const parts = text
      .split(/(?<=[.!?])\s+|\n+/)
      .map((s) => s.trim())
      .filter(Boolean);
    return parts.length ? parts : text.trim() ? [text.trim()] : [];
  }

  function generateCaptions(): void {
    if (!voiceover || !voiceover.duration) {
      toast("Add a voiceover after your script and captions time themselves.");
      return;
    }
    if (!splitSentences(prefs.script).length) {
      toast("Write a script first — captions come from its lines.");
      return;
    }
    if (buildCaptions()) {
      paintRight();
      toast(`${captions.length} captions timed against the voiceover.`);
    }
  }

  function paintCaptions(body: HTMLElement): void {
    const hasVo = !!voiceover;
    body.innerHTML = `
      <div class="rr-row between">
        <div class="rr-h" style="margin:0">CAPTIONS</div>
        <label class="rr-row" style="gap:6px;color:var(--rr-dim)">On
          <span class="rr-switch"><input type="checkbox" id="rrCapOn" ${prefs.captionsOn ? "checked" : ""}><span class="rr-track"></span></span>
        </label>
      </div>
      <div class="rr-sub">Timed against the voiceover. Regenerate after you change the script.</div>
      <button class="rr-btn block" id="rrGenCap" ${hasVo ? "" : "disabled"}>Generate captions</button>
      ${hasVo ? "" : `<div class="rr-warnbox">NO VOICEOVER: upload or record one and the captions get something to time against.</div>`}
      <div id="rrCapList"></div>
    `;
    ($("rrCapOn") as unknown as HTMLInputElement).addEventListener("change", (e) => {
      prefs.captionsOn = (e.target as HTMLInputElement).checked;
      savePrefs();
    });
    ($("rrGenCap") as HTMLButtonElement).addEventListener("click", generateCaptions);
    const list = $("rrCapList");
    if (!captions.length) {
      list.innerHTML = hasVo
        ? `<div class="rr-empty">No captions yet — hit Generate.</div>`
        : "";
      return;
    }
    for (const c of captions) {
      const row = document.createElement("div");
      row.className = "rr-caprow";
      const tm = document.createElement("div");
      tm.className = "rr-t";
      tm.textContent = `${fmtT(c.start)} → ${fmtT(c.end)}`;
      row.appendChild(tm);
      const tx = document.createElement("div");
      tx.textContent = c.text;
      row.appendChild(tx);
      list.appendChild(row);
    }
  }

  function paintCanvasPanel(body: HTMLElement): void {
    body.innerHTML = `
      <div class="rr-h">CLIP FIT</div>
      <div class="rr-seg">
        <button data-fit="fill" class="${prefs.clipFit === "fill" ? "active" : ""}">Fill frame</button>
        <button data-fit="fit" class="${prefs.clipFit === "fit" ? "active" : ""}">Fit inside</button>
      </div>
      <div class="rr-h" style="margin-top:14px">BACKGROUND</div>
      <div class="rr-row"><input class="rr-colorwell" id="rrBg" type="color" value="${esc(prefs.bgColor)}">
        <span style="color:var(--rr-dim)">${esc(prefs.bgColor)}</span></div>
      <div class="rr-row between" style="margin-top:14px">
        <div><div class="rr-h" style="margin:0">HOOK TITLE</div>
        <div class="rr-sub" style="margin:2px 0 0">Optional text held over the opening seconds.</div></div>
        <label class="rr-switch"><input type="checkbox" id="rrHookOn" ${prefs.hookOn ? "checked" : ""}><span class="rr-track"></span></label>
      </div>
      <div id="rrHookSlot"></div>
    `;
    body.querySelectorAll("[data-fit]").forEach((b) => {
      (b as HTMLButtonElement).addEventListener("click", () => {
        prefs.clipFit = (b as HTMLElement).dataset.fit as "fill" | "fit";
        savePrefs();
        paintCanvasPanel(body);
      });
    });
    ($("rrBg") as unknown as HTMLInputElement).addEventListener("input", (e) => {
      prefs.bgColor = (e.target as HTMLInputElement).value;
      savePrefs();
    });
    ($("rrHookOn") as unknown as HTMLInputElement).addEventListener("change", (e) => {
      prefs.hookOn = (e.target as HTMLInputElement).checked;
      savePrefs();
      paintCanvasPanel(body);
    });
    const slot = $("rrHookSlot");
    if (prefs.hookOn) {
      slot.innerHTML = `<textarea class="rr-textarea" id="rrHookText" style="min-height:60px;margin-top:8px"></textarea>`;
      const ht = $("rrHookText") as unknown as HTMLTextAreaElement;
      ht.value = prefs.hookText;
      ht.addEventListener("input", () => {
        prefs.hookText = ht.value;
        savePrefs();
      });
    }
  }

  // ================= OVERLAY DRAWING (shared by preview + render) =================
  const OUT_W = 1080;
  const OUT_H = 1920;

  function wrapLines(g: CanvasRenderingContext2D, text: string, maxW: number): string[] {
    const words = text.split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let cur = "";
    for (const w of words) {
      const t = cur ? `${cur} ${w}` : w;
      if (g.measureText(t).width > maxW && cur) {
        lines.push(cur);
        cur = w;
      } else {
        cur = t;
      }
    }
    if (cur) lines.push(cur);
    return lines.slice(0, 4);
  }

  function activeCaption(t: number): Caption | null {
    if (!prefs.captionsOn) return null;
    for (const c of captions) {
      if (t >= c.start && t < c.end) return c;
    }
    return null;
  }

  function drawFrame(
    g: CanvasRenderingContext2D,
    W: number,
    H: number,
    src: HTMLVideoElement | HTMLImageElement | null,
    t: number,
    clip: TimelineClip | null,
    clipIndex: number,
  ): void {
    g.fillStyle = prefs.bgColor || "#000000";
    g.fillRect(0, 0, W, H);
    if (src) {
      const vw = (src as HTMLVideoElement).videoWidth || (src as HTMLImageElement).width || 0;
      const vh = (src as HTMLVideoElement).videoHeight || (src as HTMLImageElement).height || 0;
      if (vw > 0 && vh > 0) {
        let dw: number;
        let dh: number;
        if (prefs.clipFit === "fill") {
          const s = Math.max(W / vw, H / vh);
          dw = vw * s;
          dh = vh * s;
        } else {
          const s = Math.min(W / vw, H / vh);
          dw = vw * s;
          dh = vh * s;
        }
        try {
          g.drawImage(src, (W - dw) / 2, (H - dh) / 2, dw, dh);
        } catch {
          /* tainted cross-origin frame — keep background */
        }
      }
    }

    const sc = W / 540; // overlay metrics authored at 540 wide
    // --- ranking chrome ---
    if (clip && prefs.rankingOn) {
      // clip number badge, top-left
      g.save();
      g.fillStyle = "rgba(0,0,0,0.55)";
      const bw = 64 * sc;
      const bh = 64 * sc;
      const bx = 24 * sc;
      const by = 24 * sc;
      g.beginPath();
      (g as CanvasRenderingContext2D & { roundRect?: (x: number, y: number, w: number, h: number, r: number) => void }).roundRect?.(
        bx, by, bw, bh, 14 * sc,
      );
      g.fill();
      g.fillStyle = "#ff3355";
      g.font = `800 ${40 * sc}px system-ui, sans-serif`;
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(String(clip.number), bx + bw / 2, by + bh / 2 + 2 * sc);
      g.restore();
      // moment label under the badge
      if (clip.label) {
        g.save();
        g.font = `700 ${30 * sc}px system-ui, sans-serif`;
        g.textAlign = "left";
        g.textBaseline = "top";
        const lx = 24 * sc;
        const ly = 100 * sc;
        const maxW = W - 48 * sc;
        const lines = wrapLines(g, clip.label.toUpperCase(), maxW);
        lines.forEach((ln, i) => {
          const y = ly + i * 38 * sc;
          g.lineWidth = 6 * sc;
          g.strokeStyle = "rgba(0,0,0,0.8)";
          g.strokeText(ln, lx, y);
          g.fillStyle = "#fff";
          g.fillText(ln, lx, y);
        });
        g.restore();
      }
      // countdown, top-right ("5 • 4 • 3…" remaining)
      if (prefs.countdownOn && timeline.length > 1) {
        g.save();
        g.font = `800 ${32 * sc}px system-ui, sans-serif`;
        g.textAlign = "right";
        g.textBaseline = "top";
        const txt = `${timeline.length - clipIndex} / ${timeline.length}`;
        const tx = W - 24 * sc;
        const ty = 30 * sc;
        g.lineWidth = 6 * sc;
        g.strokeStyle = "rgba(0,0,0,0.8)";
        g.strokeText(txt, tx, ty);
        g.fillStyle = "#ffb3c2";
        g.fillText(txt, tx, ty);
        g.restore();
      }
    }
    // --- hook title: opening 3s, or whole video when ranking is on ---
    const hookHold = prefs.rankingOn ? Infinity : 3;
    if (prefs.hookOn && prefs.hookText.trim() && t < hookHold) {
      g.save();
      const lines = wrapLines(g, prefs.hookText.trim(), W - 120 * sc);
      g.font = `800 ${52 * sc}px system-ui, sans-serif`;
      g.textAlign = "center";
      g.textBaseline = "middle";
      const lh = 64 * sc;
      const cy = 300 * sc;
      const y0 = cy - ((lines.length - 1) * lh) / 2;
      lines.forEach((ln, i) => {
        const y = y0 + i * lh;
        g.lineWidth = 10 * sc;
        g.strokeStyle = "rgba(0,0,0,0.85)";
        g.strokeText(ln, W / 2, y);
        g.fillStyle = "#fff";
        g.fillText(ln, W / 2, y);
      });
      g.restore();
    }
    // --- captions: bottom-anchored word cards ---
    const cap = activeCaption(t);
    if (cap) {
      g.save();
      const lines = wrapLines(g, cap.text, W - 140 * sc);
      g.font = `800 ${46 * sc}px system-ui, sans-serif`;
      g.textAlign = "center";
      g.textBaseline = "middle";
      const lh = 60 * sc;
      const baseY = H - 260 * sc;
      const y0 = baseY - (lines.length - 1) * lh;
      lines.forEach((ln, i) => {
        const y = y0 + i * lh;
        const w = g.measureText(ln).width + 36 * sc;
        g.fillStyle = "rgba(0,0,0,0.72)";
        g.beginPath();
        (g as CanvasRenderingContext2D & { roundRect?: (x: number, y: number, w: number, h: number, r: number) => void }).roundRect?.(
          W / 2 - w / 2, y - lh / 2, w, lh, 12 * sc,
        );
        g.fill();
        g.fillStyle = "#ffde59";
        g.fillText(ln, W / 2, y);
      });
      g.restore();
    }
  }

  // ================= PREVIEW / TRANSPORT =================
  function previewVideoFor(clip: TimelineClip): HTMLVideoElement | null {
    const m = media.find((x) => x.id === clip.mediaId);
    if (!m) return null;
    try {
      const el = ensureVideoEl(m);
      if (el.src !== clip.src && clip.src.startsWith("blob:")) el.src = clip.src;
      return el;
    } catch {
      return null;
    }
  }

  function paintPreview(): void {
    const found = clipAt(playT);
    if (!found) {
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#6d6d80";
      ctx.font = "600 20px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Timeline is empty", canvas.width / 2, canvas.height / 2);
      return;
    }
    const el = previewVideoFor(found.clip);
    const local = playT - found.start;
    if (el && el.readyState >= 2 && Math.abs(el.currentTime - (found.clip.start + local)) > 0.35) {
      try {
        el.currentTime = found.clip.start + local;
      } catch {
        /* noop */
      }
    }
    drawFrame(ctx, canvas.width, canvas.height, el && el.readyState >= 2 ? el : null, playT, found.clip, found.index);
  }

  function tick(ts: number): void {
    if (!playing) return;
    const dt = (ts - lastTs) / 1000;
    lastTs = ts;
    playT += dt;
    const total = totalDur();
    // drive clip video elements + voiceover
    const found = clipAt(playT);
    const actives = new Set<string>();
    if (found) {
      const el = previewVideoFor(found.clip);
      if (el) {
        actives.add(found.clip.mediaId);
        el.muted = allMuted || found.clip.muted;
        if (el.paused) {
          el.play().catch(() => undefined);
        }
      }
    }
    videoEls.forEach((el, id) => {
      if (!actives.has(id) && !el.paused) el.pause();
    });
    if (voiceover) {
      syncVoToPlayhead();
    }
    if (playT >= total) {
      pause();
      playT = total;
    }
    paintPreview();
    syncTransportUI();
    raf = requestAnimationFrame(tick);
  }

  function play(): void {
    if (rendering) return;
    if (!timeline.length) {
      toast("Timeline is empty — send media here first.");
      return;
    }
    if (playT >= totalDur()) playT = 0;
    playing = true;
    lastTs = performance.now();
    ($("rrPlay") as HTMLButtonElement).innerHTML = "&#10074;&#10074;";
    raf = requestAnimationFrame(tick);
  }

  function pause(): void {
    playing = false;
    cancelAnimationFrame(raf);
    videoEls.forEach((el) => el.pause());
    voAudio.pause();
    ($("rrPlay") as HTMLButtonElement).innerHTML = "&#9654;";
  }

  function seek(t: number): void {
    const total = totalDur();
    playT = Math.max(0, Math.min(total, t));
    syncVoToPlayhead();
    const found = clipAt(playT);
    if (found) {
      const el = previewVideoFor(found.clip);
      if (el && el.readyState >= 1) {
        try {
          el.currentTime = found.clip.start + (playT - found.start);
        } catch {
          /* noop */
        }
      }
    }
    paintPreview();
    syncTransportUI();
    renderStrip();
  }

  function syncTransportUI(): void {
    const total = totalDur();
    ($("rrCurT") as HTMLElement).textContent = fmtT(playT);
    ($("rrTotT") as HTMLElement).textContent = fmtT(total);
    ($("rrSeek") as unknown as HTMLInputElement).value = String(total ? Math.round((playT / total) * 1000) : 0);
  }

  // ================= TIMELINE STRIP =================
  function pxPerSec(): number {
    return prefs.zoom * 1.6;
  }

  function renderStrip(): void {
    const strip = $("rrStrip");
    strip.querySelectorAll(".rr-playline").forEach((n) => n.remove());
    if (!timeline.length && !voiceover) {
      strip.innerHTML = "";
      const empty = $("rrTlEmpty");
      empty.innerHTML = `<div class="rr-tl-empty">Empty. Generate a shot, upload a file, or import a link, then send it here from the library.<br><b>NO VOICEOVER:</b> generate one and the visuals get something to cut against</div>`;
    } else {
      ($("rrTlEmpty") as HTMLElement).innerHTML = "";
      const pps = pxPerSec();
      const L = layout();
      const spanLen = Math.max(totalDur(), voEnd());
      strip.innerHTML = "";
      // --- voiceover lane (own track above the video clips) ---
      if (voiceover) {
        const lane = document.createElement("div");
        lane.className = "rr-volane";
        lane.style.width = `${Math.max(60, spanLen * pps)}px`;
        const tag = document.createElement("span");
        tag.className = "rr-volane-tag";
        tag.textContent = "VOICEOVER";
        lane.appendChild(tag);
        if (voiceover.duration > 0 && voLen() > 0) {
          const blk = document.createElement("div");
          blk.className = "rr-voblk" + (voSelected ? " selected" : "");
          blk.style.left = `${VO_LANE_PAD + voiceover.offset * pps}px`;
          blk.style.width = `${Math.max(34, voLen() * pps)}px`;
          blk.title = `${voiceover.name} · ${fmtT(voLen())} (drag to move, edges trim)`;
          blk.setAttribute("role", "slider");
          blk.setAttribute("aria-label", `Voiceover ${voiceover.name}, starts at ${fmtT(voiceover.offset)}`);
          blk.innerHTML = `<span class="rr-vohandle left" data-voh="l" title="Trim head"></span>
            <span class="rr-voname">${esc(voiceover.name)}</span>
            <span class="rr-vodur">${fmtT(voLen())}</span>
            <button class="rr-vox" title="Remove voiceover">×</button>
            <span class="rr-vohandle right" data-voh="r" title="Trim tail"></span>`;
          blk.addEventListener("click", (e) => {
            if ((e.target as HTMLElement).classList.contains("rr-vox")) return;
            voSelected = true;
            selectedId = null;
            renderStrip();
          });
          blk.addEventListener("dblclick", () => seek(voiceover!.offset + 0.01));
          (blk.querySelector(".rr-vox") as HTMLButtonElement).addEventListener("click", (e) => {
            e.stopPropagation();
            removeVoiceover();
          });
          wireVoDrag(blk, pps);
          lane.appendChild(blk);
        } else {
          const pend = document.createElement("span");
          pend.className = "rr-vo-pending";
          pend.textContent = voiceover ? `loading ${voiceover.name}…` : "";
          lane.appendChild(pend);
        }
        strip.appendChild(lane);
      }
      if (!timeline.length) {
        const note = document.createElement("div");
        note.className = "rr-novideo";
        note.textContent = "No video clips yet — send media to the timeline. The voiceover lane above still edits, previews, and renders.";
        strip.appendChild(note);
      }
      const clipRow = document.createElement("div");
      clipRow.className = "rr-cliprow";
      clipRow.style.width = `${Math.max(60, spanLen * pps)}px`;
      L.forEach(({ clip, start }) => {
        const m = media.find((x) => x.id === clip.mediaId);
        const d = document.createElement("div");
        d.className = "rr-clip" + (clip.id === selectedId ? " selected" : "");
        d.style.width = `${Math.max(34, clip.dur * pps)}px`;
        if (m?.thumb) d.style.backgroundImage = `url("${m.thumb}")`;
        d.title = `${clip.name} · ${fmtT(clip.dur)}`;
        d.innerHTML = `<span class="rr-cn">${prefs.rankingOn ? `#${clip.number}` : `#${layout().findIndex((l) => l.clip.id === clip.id) + 1}`}</span>
          <button class="rr-cmute" title="Toggle clip audio">${clip.muted ? "muted" : "sound"}</button>
          <span class="rr-cd">${fmtT(clip.dur)}</span>`;
        d.addEventListener("click", (e) => {
          if ((e.target as HTMLElement).classList.contains("rr-cmute")) return;
          selectedId = clip.id;
          voSelected = false;
          seek(start + 0.01);
          paintInspector();
          if (leftTab === "ranking") paintLeft();
        });
        const muteBtn = d.querySelector(".rr-cmute") as HTMLButtonElement;
        muteBtn.addEventListener("click", () => {
          clip.muted = !clip.muted;
          muteBtn.textContent = clip.muted ? "muted" : "sound";
          paintInspector();
        });
        clipRow.appendChild(d);
      });
      strip.appendChild(clipRow);
    }
    // playhead line spans both lanes (voiceover + clips)
    const line = document.createElement("div");
    line.className = "rr-playline";
    line.style.left = `calc(14px + ${playT * pxPerSec()}px)`;
    strip.appendChild(line);
    paintInspector();
  }

  // Pointer-based lane editing for the voiceover block: body drag = move
  // (clamp offset >= 0), edge handles = trim head/tail (min 0.2s, stays
  // inside the true audio length). Captions follow: pure moves shift them
  // by the same delta, trims rescale them into the new span.
  // Coordinate note: the VO block is absolutely positioned inside .rr-volane
  // which has 6px side padding, so block-left = 6 + offset*pps.
  const VO_LANE_PAD = 6;
  function wireVoDrag(blk: HTMLElement, pps: number): void {
    if (!voiceover) return;
    let mode: "move" | "l" | "r" = "move";
    blk.addEventListener("pointerdown", (e) => {
      if (!voiceover) return;
      if ((e.target as HTMLElement).closest(".rr-vox")) return;
      e.preventDefault();
      blk.setPointerCapture?.(e.pointerId);
      const edge = (e.target as HTMLElement).closest("[data-voh]") as HTMLElement | null;
      mode = edge?.dataset.voh === "l" ? "l" : edge?.dataset.voh === "r" ? "r" : "move";
      const x0 = e.clientX;
      const o0 = voiceover.offset;
      const t0 = voiceover.trim;
      const l0 = voiceover.len;
      const dur = voiceover.duration;
      let moved = false;
      // widen trim handles once a drag starts so fat fingers can adjust mid-gesture
      blk.classList.add("dragging");
      const onMove = (ev: PointerEvent) => {
        if (!voiceover) return;
        const dt = (ev.clientX - x0) / pps;
        if (Math.abs(ev.clientX - x0) > 3) moved = true;
        if (mode === "move") {
          voiceover.offset = Math.max(0, o0 + dt);
        } else if (mode === "l") {
          const nt = Math.max(0, Math.min(t0 + l0 - 0.2, t0 + dt));
          const applied = nt - t0;
          voiceover.trim = nt;
          voiceover.offset = Math.max(0, o0 + applied);
          voiceover.len = Math.max(0.2, l0 - applied);
        } else {
          voiceover.len = Math.max(0.2, Math.min(dur - t0, l0 + dt));
        }
        clampVo();
        // live reposition without a full strip repaint
        blk.style.left = `${VO_LANE_PAD + voiceover.offset * pps}px`;
        blk.style.width = `${Math.max(34, voiceover.len * pps)}px`;
        const line = $("rrStrip").querySelector(".rr-playline") as HTMLElement | null;
        if (line) line.style.left = `calc(14px + ${playT * pps}px)`;
        syncVoToPlayhead();
      };
      const onUp = (ev: PointerEvent) => {
        blk.classList.remove("dragging");
        blk.removeEventListener("pointermove", onMove);
        blk.removeEventListener("pointerup", onUp);
        blk.removeEventListener("pointercancel", onUp);
        if (!voiceover) return;
        clampVo();
        if (mode === "move") {
          const delta = voiceover.offset - o0;
          if (Math.abs(delta) > 1e-6) retimeCaptionsToVo("move", delta);
        } else {
          retimeCaptionsToVo("rescale");
        }
        persistVo();
        voSelected = true;
        selectedId = null;
        renderStrip();
        if (rightTab === "captions") paintRight();
        updateStatus();
        if (moved) {
          const nm = voiceover.name;
          if (mode === "move") toast(`Voiceover starts at ${fmtT(voiceover.offset)} — ${nm}`);
          else toast(`Voiceover trimmed to ${fmtT(voiceover.len)} — ${nm}`);
        }
        void ev;
      };
      blk.addEventListener("pointermove", onMove);
      blk.addEventListener("pointerup", onUp);
      blk.addEventListener("pointercancel", onUp);
    });
  }

  function paintInspector(): void {
    const el = $("rrInsp");
    if (voSelected && voiceover) {
      ($("rrDelete") as HTMLButtonElement).disabled = false;
      el.innerHTML = "";
      const b = document.createElement("b");
      b.textContent = `Voiceover: ${voiceover.name}`;
      el.appendChild(b);
      const span = document.createElement("span");
      span.textContent = `${fmtT(voLen())} audible · starts ${fmtT(voiceover.offset)} · source ${fmtT(voiceover.trim)}→${fmtT(voiceover.trim + voLen())}`;
      el.appendChild(span);
      const rm = document.createElement("button");
      rm.className = "rr-btn small";
      rm.textContent = "Remove voiceover";
      rm.addEventListener("click", () => removeVoiceover());
      el.appendChild(rm);
      return;
    }
    const c = timeline.find((x) => x.id === selectedId);
    if (!c) {
      el.innerHTML = timeline.length ? `<span>Click a clip to select it.</span>` : "";
      ($("rrDelete") as HTMLButtonElement).disabled = true;
      return;
    }
    ($("rrDelete") as HTMLButtonElement).disabled = false;
    const L = layout();
    const idx = L.findIndex((l) => l.clip.id === c.id);
    el.innerHTML = "";
    const b = document.createElement("b");
    b.textContent = `Clip ${idx + 1}: ${c.name}`;
    el.appendChild(b);
    const span = document.createElement("span");
    span.textContent = `${fmtT(c.dur)} · starts ${fmtT(L[idx].start)}`;
    el.appendChild(span);
    const muteBtn = document.createElement("button");
    muteBtn.className = "rr-btn small";
    muteBtn.textContent = c.muted ? "Unmute audio" : "Mute audio";
    muteBtn.addEventListener("click", () => {
      c.muted = !c.muted;
      renderStrip();
    });
    el.appendChild(muteBtn);
  }

  function afterTimelineChange(): void {
    if (playT > totalDur()) playT = totalDur();
    renderStrip();
    updateStatus();
    updateTransport();
    paintPreview();
    if (leftTab === "ranking") paintLeft();
  }

  function updateStatus(): void {
    const total = totalDur();
    $("rrStatus").textContent =
      `${timeline.length} clips · ${fmtT(total)} · 1080×1920 · renders in your browser` +
      (voiceover ? ` · voiceover ${fmtT(voiceover.duration)}` : "");
    ($("rrRenderBtn") as HTMLButtonElement).disabled = !timeline.length || rendering;
    ($("rrTlCount") as HTMLElement).textContent =
      timeline.length ? `${timeline.length} clips · ${fmtT(total)}` : "";
  }

  function updateTransport(): void {
    const empty = !timeline.length;
    (["rrBack", "rrPlay", "rrFwd", "rrSeek"] as const).forEach((id) => {
      ($(id) as unknown as HTMLButtonElement | HTMLInputElement).disabled = empty;
    });
    syncTransportUI();
  }

  function splitAtPlayhead(): void {
    const found = clipAt(playT);
    if (!found || timeline.length === 0) {
      toast("Nothing to split here.");
      return;
    }
    const local = playT - found.start;
    if (local <= 0.15 || local >= found.clip.dur - 0.15) {
      toast("Move the playhead inside a clip to split it.");
      return;
    }
    const idx = timeline.findIndex((c) => c.id === found.clip.id);
    const right: TimelineClip = {
      ...found.clip,
      id: uid("c"),
      start: found.clip.start + local,
      dur: found.clip.dur - local,
    };
    found.clip.dur = local;
    timeline.splice(idx + 1, 0, right);
    selectedId = right.id;
    afterTimelineChange();
    toast("Clip split.");
  }

  function deleteSelected(): void {
    if (voSelected && voiceover) {
      removeVoiceover();
      return;
    }
    const idx = timeline.findIndex((c) => c.id === selectedId);
    if (idx < 0) {
      toast("Select a clip first.");
      return;
    }
    timeline.splice(idx, 1);
    selectedId = timeline[Math.min(idx, timeline.length - 1)]?.id ?? null;
    afterTimelineChange();
    toast("Clip deleted.");
  }

  function fitToVoiceover(): void {
    if (!voiceover || !(voiceover.duration > 0)) {
      toast("Add a voiceover first — there is nothing to fit to.");
      return;
    }
    if (!timeline.length) {
      toast("Timeline is empty — add clips first.");
      return;
    }
    // Fit clips to the voiceover's effective lane span (offset + trimmed
    // length). Clips start at 0, so when the lane starts later the tail
    // stretches to cover the offset too — least surprising: the visuals
    // always cover the whole narration.
    clampVo();
    const target = Math.max(0.2, voEnd());
    const per = target / timeline.length;
    for (const c of timeline) c.dur = per;
    afterTimelineChange();
    toast(`Timeline fitted to voiceover (${fmtT(target)} incl. offset).`);
  }

  // ================= RENDER (in-browser 1080×1920) =================
  function pickMime(): { mime: string; ext: string } {
    const cands: [string, string][] = [
      ["video/mp4;codecs=avc1,mp4a", "mp4"],
      ["video/mp4", "mp4"],
      ["video/webm;codecs=vp9,opus", "webm"],
      ["video/webm;codecs=vp8,opus", "webm"],
      ["video/webm", "webm"],
    ];
    for (const [m, e] of cands) {
      try {
        if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)) {
          return { mime: m, ext: e };
        }
      } catch {
        /* try next */
      }
    }
    return { mime: "", ext: "" };
  }

  function waitEvent(el: HTMLElement, ev: string, ms: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const to = window.setTimeout(() => {
        el.removeEventListener(ev, done);
        reject(new Error("timeout"));
      }, ms);
      const done = () => {
        window.clearTimeout(to);
        resolve();
      };
      el.addEventListener(ev, done, { once: true });
    });
  }

  function loadImageEl(url: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("img"));
      img.src = url;
    });
  }

  let lastDlUrl: string | null = null;

  async function doRender(): Promise<void> {
    if (rendering || !timeline.length) return;
    pause();
    rendering = true;
    updateStatus();
    const { mime, ext } = pickMime();
    const bar = $("rrRenderBar");
    const fillEl = $("rrProgFill");
    const label = $("rrProgLabel");
    const dlSlot = $("rrDlSlot");
    dlSlot.innerHTML = "";
    if (!mime) {
      toast("This browser cannot record video — try Chrome or Edge.");
      rendering = false;
      updateStatus();
      return;
    }
    const kind = ext.toUpperCase();
    bar.classList.add("show");
    fillEl.style.width = "0%";
    label.textContent = `Rendering ${kind}… 0%`;

    const rc = document.createElement("canvas");
    rc.width = OUT_W;
    rc.height = OUT_H;
    const g = rc.getContext("2d")!;

    // ---- mixed audio: voiceover at its volume + unmuted clip audio ----
    let mixedTracks: MediaStreamTrack[] = [];
    let actx: AudioContext | null = null;
    try {
      actx = new AudioContext();
      await actx.resume().catch(() => undefined);
      const dest = actx.createMediaStreamDestination();
      const master = actx.createGain();
      master.gain.value = 1;
      master.connect(dest);
      const total = totalDur();
      if (voiceover) {
        try {
          const buf = await fetch(voiceover.url)
            .then((r) => {
              if (!r.ok) throw new Error("vo");
              return r.arrayBuffer();
            })
            .then((b) => actx!.decodeAudioData(b));
          // Place the trimmed voiceover range at its lane offset in the mix.
          const voOff = Math.max(0, voiceover.offset);
          const voTrim = Math.max(0, Math.min(buf.duration - 0.05, voiceover.trim));
          const voPlayLen = Math.max(0, Math.min(voiceover.len, buf.duration - voTrim));
          if (voPlayLen > 0.05 && voOff < total) {
            const src = actx.createBufferSource();
            src.buffer = buf;
            const gn = actx.createGain();
            gn.gain.value = prefs.voVolume / 100;
            src.connect(gn);
            gn.connect(master);
            src.start(voOff, voTrim, Math.min(voPlayLen, total - voOff));
          }
        } catch {
          /* voiceover skipped */
        }
      }
      for (const { clip, start } of layout()) {
        if (clip.muted) continue;
        try {
          const buf = await fetch(clip.src)
            .then((r) => {
              if (!r.ok) throw new Error("clip");
              return r.arrayBuffer();
            })
            .then((b) => actx!.decodeAudioData(b));
          if (clip.start >= buf.duration) continue;
          const src = actx.createBufferSource();
          src.buffer = buf;
          src.connect(master);
          src.start(start, clip.start, Math.min(clip.dur, buf.duration - clip.start));
        } catch {
          /* clip without decodable audio — stays silent */
        }
      }
      mixedTracks = dest.stream.getAudioTracks();
    } catch {
      actx = null;
    }

    const stream = rc.captureStream(30);
    const tracks: MediaStreamTrack[] = [...stream.getVideoTracks(), ...mixedTracks];
    const rec = new MediaRecorder(new MediaStream(tracks), {
      mimeType: mime,
      videoBitsPerSecond: 12_000_000,
    });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    const stopped = new Promise<void>((res) => {
      rec.onstop = () => res();
    });
    rec.start(250);

    // ---- frame pump: draws current render source + burned-in overlays ----
    const total = totalDur();
    let rsSrc: HTMLVideoElement | HTMLImageElement | null = null;
    let rsT = 0;
    let rsClip: TimelineClip | null = null;
    let rsIdx = 0;
    let pumpOn = true;
    const pump = () => {
      if (!pumpOn) return;
      drawFrame(g, OUT_W, OUT_H, rsSrc, rsT, rsClip, rsIdx);
      requestAnimationFrame(pump);
    };
    requestAnimationFrame(pump);

    const wallWait = (dur: number, fromT: number): Promise<void> =>
      new Promise((res) => {
        const t0 = performance.now();
        const step = () => {
          if (!rendering) {
            res();
            return;
          }
          const e = (performance.now() - t0) / 1000;
          rsT = Math.min(total, fromT + Math.min(e, dur));
          const pct = Math.round((rsT / total) * 100);
          fillEl.style.width = `${pct}%`;
          label.textContent = `Rendering ${kind}… ${pct}%`;
          if (e >= dur) res();
          else window.setTimeout(step, 66);
        };
        step();
      });

    try {
      const L = layout();
      for (let i = 0; i < L.length; i++) {
        const { clip, start } = L[i];
        rsClip = clip;
        rsIdx = i;
        const m = media.find((x) => x.id === clip.mediaId);
        if (m && m.kind === "image") {
          try {
            rsSrc = await loadImageEl(m.url);
          } catch {
            rsSrc = null;
          }
          await wallWait(clip.dur, start);
        } else if (m && m.kind === "audio") {
          rsSrc = null;
          await wallWait(clip.dur, start);
        } else {
          const el = document.createElement("video");
          el.muted = true;
          el.playsInline = true;
          el.preload = "auto";
          if (m?.source === "link") el.crossOrigin = "anonymous";
          el.src = clip.src;
          try {
            await waitEvent(el, "loadedmetadata", 5000);
            const avail = (el.duration || clip.dur) - clip.start;
            const playDur = Math.max(0.25, Math.min(clip.dur, avail > 0 ? avail : clip.dur));
            try {
              el.currentTime = Math.min(Math.max(0, clip.start), Math.max(0, (el.duration || 1) - 0.15));
            } catch {
              /* noop */
            }
            await waitEvent(el, "seeked", 5000).catch(() => undefined);
            rsSrc = el;
            await el.play().catch(() => undefined);
            await wallWait(playDur, start);
            try {
              el.pause();
            } catch {
              /* noop */
            }
            // hold the last frame if the timeline clip outlasts the source
            if (playDur < clip.dur - 0.05) {
              await wallWait(clip.dur - playDur, start + playDur);
            }
          } catch {
            rsSrc = null;
            await wallWait(clip.dur, start);
          }
        }
        if (!rendering) break;
      }
    } finally {
      pumpOn = false;
    }

    await new Promise((r) => window.setTimeout(r, 300));
    try {
      rec.stop();
    } catch {
      /* noop */
    }
    await stopped;
    if (actx) {
      actx.close().catch(() => undefined);
    }

    const blob = new Blob(chunks, { type: mime.split(";")[0] });
    if (lastDlUrl) URL.revokeObjectURL(lastDlUrl);
    lastDlUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.className = "rr-dl";
    a.href = lastDlUrl;
    a.download = `shortsgenerated-1080x1920.${ext}`;
    a.textContent = `Download ${kind} (${(blob.size / 1048576).toFixed(1)} MB)`;
    dlSlot.appendChild(a);
    fillEl.style.width = "100%";
    label.textContent = `Done — 1080×1920 ${kind} with overlays burned in.`;
    rendering = false;
    updateStatus();
    paintPreview();
    toast("Render complete.");
  }

  // ================= WIRING + INIT =================
  function wire(): void {
    root.querySelectorAll("[data-ltab]").forEach((b) => {
      (b as HTMLButtonElement).addEventListener("click", () => {
        leftTab = (b as HTMLElement).dataset.ltab as typeof leftTab;
        paintLeft();
      });
    });
    root.querySelectorAll("[data-rtab]").forEach((b) => {
      (b as HTMLButtonElement).addEventListener("click", () => {
        rightTab = (b as HTMLElement).dataset.rtab as typeof rightTab;
        paintRight();
      });
    });

    ($("rrRenderBtn") as HTMLButtonElement).addEventListener("click", () => {
      void doRender();
    });
    // honest output label: MP4 where supported, WebM where not
    try {
      const { ext } = pickMime();
      ($("rrRenderBtn") as HTMLButtonElement).textContent = ext ? `Render ${ext.toUpperCase()}` : "Render";
    } catch {
      /* noop */
    }

    const playBtn = $("rrPlay") as HTMLButtonElement;
    playBtn.addEventListener("click", () => {
      if (playing) pause();
      else play();
    });
    ($("rrBack") as HTMLButtonElement).addEventListener("click", () => seek(playT - 1));
    ($("rrFwd") as HTMLButtonElement).addEventListener("click", () => seek(playT + 1));
    ($("rrMute") as HTMLButtonElement).addEventListener("click", (e) => {
      allMuted = !allMuted;
      voAudio.volume = allMuted ? 0 : prefs.voVolume / 100;
      (e.target as HTMLButtonElement).innerHTML = allMuted ? "&#128263;" : "&#128266;";
    });
    ($("rrSeek") as unknown as HTMLInputElement).addEventListener("input", (e) => {
      const total = totalDur();
      seek((Number((e.target as HTMLInputElement).value) / 1000) * total);
    });

    ($("rrSplit") as HTMLButtonElement).addEventListener("click", splitAtPlayhead);
    ($("rrDelete") as HTMLButtonElement).addEventListener("click", deleteSelected);
    ($("rrFitVo") as HTMLButtonElement).addEventListener("click", fitToVoiceover);
    const zoom = $("rrZoom") as unknown as HTMLInputElement;
    zoom.value = String(prefs.zoom);
    zoom.addEventListener("input", () => {
      prefs.zoom = Number(zoom.value);
      savePrefs();
      renderStrip();
    });

    const fileVo = $("rrFileVo") as unknown as HTMLInputElement;
    fileVo.addEventListener("change", () => {
      const f = fileVo.files?.[0];
      fileVo.value = "";
      if (f) setVoiceoverFromBlob(f, f.name, "upload");
    });
    const fileMedia = $("rrFileMedia") as unknown as HTMLInputElement;
    fileMedia.addEventListener("change", () => {
      const files = [...(fileMedia.files || [])];
      fileMedia.value = "";
      files.forEach((f) => addMediaFile(f, "upload"));
      if (leftTab !== "media") {
        leftTab = "media";
        paintLeft();
      }
    });

    document.addEventListener("keydown", (e) => {
      const t = e.target as HTMLElement;
      if (e.code === "Space" && !/INPUT|TEXTAREA|BUTTON/.test(t.tagName)) {
        e.preventDefault();
        if (playing) pause();
        else play();
      }
      // Delete/Backspace removes the selected clip — or the voiceover block
      // when the VO lane is selected. Never while typing in a field.
      if ((e.key === "Delete" || e.key === "Backspace") && !/INPUT|TEXTAREA|SELECT/.test(t.tagName)) {
        if (voSelected && voiceover) {
          e.preventDefault();
          removeVoiceover();
        }
      }
    });

    document.addEventListener("visibilitychange", () => {
      if (document.hidden && playing) pause();
    });
  }

  wire();
  paintLeft();
  paintRight();
  renderStrip();
  updateStatus();
  updateTransport();
  paintPreview();
  // Restore the persisted voiceover (IndexedDB), if any. Guard: a missing
  // or corrupt blob starts clean with no error toast storm — the studio
  // simply behaves as if there were no voiceover.
  restoreVoFromIdb();

  function restoreVoFromIdb(): void {
    let cancelled = false;
    const cancel = () => {
      cancelled = true;
    };
    disposeFns.push(cancel);
    idbGetVo()
      .then((rec) => {
        if (disposed || cancelled || !rec) return;
        if (!rec.blob || !(rec.blob.size > 0)) return; // missing/corrupt → clean start
        if (rec.blob.size > 64 * 1024 * 1024) return; // absurdly large → refuse quietly
        setVoiceoverFromBlob(rec.blob, rec.name || "voiceover", rec.kind || "upload", {
          offset: Number(rec.offset) || 0,
          trim: Number(rec.trim) || 0,
          len: Math.max(0.2, Number(rec.len) || 0),
        });
      })
      .catch(() => undefined); // idb unavailable/blocked → clean start, silent
  }

  return () => {
    disposed = true;
    pause();
    pumpStop();
    for (const fn of disposeFns) {
      try {
        fn();
      } catch {
        /* noop */
      }
    }
  };

  function pumpStop(): void {
    rendering = false;
  }
}

