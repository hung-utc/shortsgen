// Generates shortsgenerated PWA icons (red rounded tile, white play triangle,
// dark circle badge with red "5") as PNGs. Mirrors the rr-mark SVG in
// src/studio/studio.ts (viewBox 0 0 32 32).
// Pure stdlib: pixel shapes rendered at 2x supersampling, hand-encoded PNG
// (zlib deflate + CRC32). No external downloads, no native deps.
// Run: bun scripts/gen-icons.ts   (writes public/icons/*.png)
import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const RED: [number, number, number] = [255, 51, 85]; // #ff3355 (tile + digit)
const WHITE: [number, number, number] = [255, 255, 255]; // play triangle
const DARK: [number, number, number] = [11, 11, 16]; // #0b0b10 (badge)

// ---- CRC32 ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
function encodePNG(w: number, h: number, rgba: Uint8Array): Uint8Array {
  const stride = w * 4 + 1;
  const raw = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0; // filter: none
    raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * stride + 1);
  }
  const comp = deflateSync(raw, { level: 9 });
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, chunk("IHDR", ihdr), chunk("IDAT", new Uint8Array(comp)), chunk("IEND", new Uint8Array(0))];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// ---- geometry helpers (unit space, y grows downward) ----
function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy || 1e-9;
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx - px;
  const cy = ay + t * dy - py;
  return Math.hypot(cx, cy);
}
function inTri(px: number, py: number, ax: number, ay: number, bx: number, by: number, cx: number, cy: number): boolean {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

interface IconOpts {
  size: number;
  bleed: boolean; // true: full-bleed square (maskable / apple touch); false: rounded corners + transparency
  glyph: number; // glyph scale factor around center (maskable uses smaller for safe zone)
}

// SVG mark geometry in unit space (from viewBox 0 0 32 32, y downward):
// - red rounded tile fills the canvas (SVG rect is inset 1.5/32; icons use the
//   tile as the canvas itself)
// - white play triangle: (12.5,10.5) (12.5,21.5) (22,16)  -> (0.391,0.328) (0.391,0.672) (0.688,0.5)
// - dark badge: circle center (22.6,10.2), r=2.6            -> (0.706,0.319), r=0.081
// - red "5": seven-segment bars centered on the badge, red on the dark circle
const TRI = [
  [0.390625, 0.328125],
  [0.390625, 0.671875],
  [0.6875, 0.5],
] as const;
const BADGE_CX = 0.70625;
const BADGE_CY = 0.31875;
const BADGE_R = 0.08125;
// Seven-segment "5" bars (A top, F upper-left, G middle, C lower-right, D bottom)
// as [ax, ay, bx, by] centerlines; thickness applied on hit test.
const DIGIT_SEGS: [number, number, number, number][] = [
  [BADGE_CX - 0.032, BADGE_CY - 0.040, BADGE_CX + 0.032, BADGE_CY - 0.040], // A
  [BADGE_CX - 0.032, BADGE_CY - 0.040, BADGE_CX - 0.032, BADGE_CY + 0.000], // F
  [BADGE_CX - 0.032, BADGE_CY + 0.000, BADGE_CX + 0.032, BADGE_CY + 0.000], // G
  [BADGE_CX + 0.032, BADGE_CY + 0.000, BADGE_CX + 0.032, BADGE_CY + 0.040], // C
  [BADGE_CX - 0.032, BADGE_CY + 0.040, BADGE_CX + 0.032, BADGE_CY + 0.040], // D
];
const DIGIT_T = 0.0125 / 2; // half-bar thickness

function renderIcon({ size: S, bleed, glyph: gs }: IconOpts): Uint8Array {
  const SS = 2; // supersample factor for antialiased edges
  const W = S * SS;
  const buf = new Uint8Array(W * W * 4);
  const rad = 0.225; // corner radius (unit)

  const tx = (x: number) => 0.5 + (x - 0.5) * gs;
  const ty = (y: number) => 0.5 + (y - 0.5) * gs;

  const inPlay = (x: number, y: number): boolean =>
    inTri(x, y, tx(TRI[0][0]), ty(TRI[0][1]), tx(TRI[1][0]), ty(TRI[1][1]), tx(TRI[2][0]), ty(TRI[2][1]));
  const inBadge = (x: number, y: number): boolean =>
    Math.hypot(x - tx(BADGE_CX), y - ty(BADGE_CY)) <= BADGE_R * gs;
  const inDigit = (x: number, y: number): boolean => {
    for (const [ax, ay, bx, by] of DIGIT_SEGS) {
      if (segDist(x, y, tx(ax), ty(ay), tx(bx), ty(by)) <= DIGIT_T * gs) return true;
    }
    return false;
  };

  for (let py = 0; py < W; py++) {
    const y = (py + 0.5) / W;
    for (let px = 0; px < W; px++) {
      const x = (px + 0.5) / W;
      let insideBg: boolean;
      if (bleed) {
        insideBg = true;
      } else {
        // rounded-box SDF
        const hx = 0.5 - rad;
        const hy = 0.5 - rad;
        const qx = Math.abs(x - 0.5) - hx;
        const qy = Math.abs(y - 0.5) - hy;
        const ax = Math.max(qx, 0);
        const ay = Math.max(qy, 0);
        const sdf = Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - rad;
        insideBg = sdf < 0;
      }
      const i = (py * W + px) * 4;
      if (!insideBg) {
        buf[i + 3] = 0;
        continue;
      }
      // Layering matches the SVG: red tile, white triangle, dark badge over it, red "5" on the badge.
      let c: [number, number, number] = RED;
      if (inPlay(x, y)) c = WHITE;
      if (inBadge(x, y)) c = inDigit(x, y) ? RED : DARK;
      buf[i] = c[0];
      buf[i + 1] = c[1];
      buf[i + 2] = c[2];
      buf[i + 3] = 255;
    }
  }

  // Box-downsample 2x -> target size.
  const out = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let dy = 0; dy < SS; dy++) {
        for (let dx = 0; dx < SS; dx++) {
          const i = ((y * SS + dy) * W + (x * SS + dx)) * 4;
          r += buf[i];
          g += buf[i + 1];
          b += buf[i + 2];
          a += buf[i + 3];
        }
      }
      const o = (y * S + x) * 4;
      const n = SS * SS;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
    }
  }
  return encodePNG(S, S, out);
}

const dir = new URL("../public/icons/", import.meta.url);
mkdirSync(dir, { recursive: true });
const jobs: [string, IconOpts][] = [
  ["icon-192.png", { size: 192, bleed: false, glyph: 1 }],
  ["icon-512.png", { size: 512, bleed: false, glyph: 1 }],
  ["maskable-512.png", { size: 512, bleed: true, glyph: 0.72 }],
  ["apple-touch-icon.png", { size: 180, bleed: true, glyph: 0.95 }],
];
for (const [name, opts] of jobs) {
  writeFileSync(new URL(name, dir), renderIcon(opts));
  console.log(`wrote public/icons/${name} (${opts.size}x${opts.size}${opts.bleed ? ", full-bleed" : ""})`);
}