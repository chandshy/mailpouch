/**
 * Tray / app icon generator — pure Node, no graphics dependency.
 *
 * Produces a mailpouch-branded 64×64 RGBA PNG matching the settings-UI
 * header logo: rounded-square canvas with a linear gradient from
 * `#6D4AFF` (top-left) to `#9B6DFF` (bottom-right), a white envelope
 * glyph centered on top, and alpha-masked corners (10-px radius on the
 * 64-px canvas, ~15 %).
 *
 * Why build the PNG by hand instead of shipping a PNG asset:
 *   - Keeps the MCP zero-asset: a single JS bundle continues to work
 *     when installed via `npm i -g` with no postinstall copy step.
 *   - Lets the icon track the product's brand constants (see
 *     BRAND_GRADIENT below) without a re-export/design round-trip.
 *
 * Why 64×64 base resolution instead of 32×32:
 *   - Hi-DPI displays (macOS retina, Windows 150 %) downsample a 32×32
 *     source into a blurry 32-equivalent; 64×64 source downsamples
 *     cleanly and still fits every tray's pixel budget.
 *   - Windows ICO packs multiple sub-sizes (16/32/48/64) from one
 *     source — the OS picks the closest to the display scale.
 */
import { deflateSync } from "zlib";

// ── Brand constants (must match src/settings/server.ts .logo-icon CSS) ────
const BRAND_GRADIENT = {
  from: { r: 0x6D, g: 0x4A, b: 0xFF }, // #6D4AFF — top-left
  to:   { r: 0x9B, g: 0x6D, b: 0xFF }, // #9B6DFF — bottom-right
} as const;

const CANVAS = 64;                  // base render size
const CORNER_RADIUS = 10;           // ~15 % radius matches .logo-icon (9 px on 34 px)

// ── Primitive: CRC32 for PNG chunks ─────────────────────────────────────
// Inlined so the module has no runtime deps. Standard reverse-polynomial
// implementation matching libpng.
function crc32(buf: Buffer): number {
  const tbl = Array.from({ length: 256 }, (_, i) => {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    return c >>> 0;
  });
  let crc = 0xFFFFFFFF;
  for (const b of buf) crc = (crc >>> 8) ^ tbl[(crc ^ b) & 0xFF];
  return (~crc) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const t   = Buffer.from(type, "ascii");
  const len = Buffer.allocUnsafe(4); len.writeUInt32BE(data.length, 0);
  const crc = Buffer.allocUnsafe(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

// ── Raster helpers ──────────────────────────────────────────────────────
interface Px { r: number; g: number; b: number; a: number }

/**
 * Rounded-rectangle alpha mask at (x, y) on a W×H canvas with corner
 * radius `r`. Returns 0 (fully transparent) through 255 (opaque) with a
 * 1-px anti-aliased border for clean corners at small sizes.
 */
function roundedRectAlpha(x: number, y: number, W: number, H: number, r: number): number {
  // Distance from nearest corner center — only matters inside the
  // quarter-circle region; elsewhere the pixel is fully opaque.
  let dx = 0, dy = 0;
  if      (x <  r)         dx = r - x;
  else if (x >= W - r)     dx = x - (W - r - 1);
  if      (y <  r)         dy = r - y;
  else if (y >= H - r)     dy = y - (H - r - 1);
  if (dx === 0 && dy === 0) return 255;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist <= r - 1) return 255;
  if (dist >= r)     return 0;
  return Math.round(255 * (r - dist));
}

/** Linear gradient along the TL→BR diagonal. t ∈ [0, 1]. */
function gradientAt(x: number, y: number, W: number, H: number): Px {
  const t = (x + y) / (W + H - 2);
  const r = Math.round(BRAND_GRADIENT.from.r + (BRAND_GRADIENT.to.r - BRAND_GRADIENT.from.r) * t);
  const g = Math.round(BRAND_GRADIENT.from.g + (BRAND_GRADIENT.to.g - BRAND_GRADIENT.from.g) * t);
  const b = Math.round(BRAND_GRADIENT.from.b + (BRAND_GRADIENT.to.b - BRAND_GRADIENT.from.b) * t);
  return { r, g, b, a: 255 };
}

/**
 * Draw a white envelope glyph (rectangle body + V-flap) at integer
 * coords. Uses supersampled anti-aliasing on the V-flap — the diagonal
 * would otherwise stair-step at this size.
 *
 * Returns a 2-D coverage map: coverage[y][x] is 0–255 indicating how
 * "white" that pixel should blend over the gradient underneath.
 */
function envelopeCoverage(W: number, H: number): Uint8Array {
  const cov = new Uint8Array(W * H);
  // Envelope occupies ~60 % of the canvas, centered. Slightly wider than
  // tall so it reads as an envelope not a card.
  const pad = Math.round(W * 0.18);
  const x1 = pad, y1 = Math.round(H * 0.28);
  const x2 = W - pad - 1, y2 = H - pad - 2;
  const flapY = Math.round((y1 + y2) * 0.52); // where the V meets
  const stroke = Math.max(2, Math.round(W / 28)); // stroke thickness

  // Rectangle outline — filled stroke on all four edges.
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const onTop    = y >= y1 && y <  y1 + stroke && x >= x1 && x <= x2;
      const onBot    = y >  y2 - stroke && y <= y2 && x >= x1 && x <= x2;
      const onLeft   = x >= x1 && x <  x1 + stroke && y >= y1 && y <= y2;
      const onRight  = x >  x2 - stroke && x <= x2 && y >= y1 && y <= y2;
      if (onTop || onBot || onLeft || onRight) cov[y * W + x] = 255;
    }
  }

  // V-flap — two diagonal strokes from (x1,y1) and (x2,y1) to (cx,flapY).
  const cx = (x1 + x2) / 2;
  const drawLine = (ax: number, ay: number, bx: number, by: number): void => {
    // Supersampled 3×3 per pixel for clean anti-aliasing on the diagonal.
    const ss = 3;
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy);
    const nx = -dy / len, ny = dx / len; // normal to the stroke
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let hits = 0;
        for (let sy = 0; sy < ss; sy++) {
          for (let sx = 0; sx < ss; sx++) {
            const px = x + (sx + 0.5) / ss - 0.5;
            const py = y + (sy + 0.5) / ss - 0.5;
            // Projection t along the line, 0..1
            const t = ((px - ax) * dx + (py - ay) * dy) / (len * len);
            if (t < 0 || t > 1) continue;
            // Perpendicular distance from the line
            const perp = Math.abs((px - ax) * nx + (py - ay) * ny);
            if (perp < stroke / 2) hits++;
          }
        }
        if (hits > 0) {
          const a = Math.round((hits / (ss * ss)) * 255);
          const idx = y * W + x;
          if (a > cov[idx]) cov[idx] = a;
        }
      }
    }
  };
  drawLine(x1, y1, cx, flapY);
  drawLine(x2, y1, cx, flapY);

  return cov;
}

/**
 * Compose the full icon as raw RGBA bytes (no filter prefix) — kept
 * separate from the PNG packaging so tests can inspect the bitmap.
 */
export function renderIconRgba(size = CANVAS): Buffer {
  const W = size, H = size;
  const scale = size / CANVAS;
  const r = Math.max(1, Math.round(CORNER_RADIUS * scale));
  const rgba = Buffer.alloc(W * H * 4);
  const cov = envelopeCoverage(W, H);

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const alpha = roundedRectAlpha(x, y, W, H, r);
      const i = (y * W + x) * 4;
      if (alpha === 0) {
        // Fully transparent outside the rounded-rect mask.
        rgba[i] = 0; rgba[i + 1] = 0; rgba[i + 2] = 0; rgba[i + 3] = 0;
        continue;
      }
      const bg = gradientAt(x, y, W, H);
      const envAlpha = cov[y * W + x];
      // Alpha-blend the white envelope over the gradient.
      const whiteBlend = envAlpha / 255;
      const rr = Math.round(bg.r + (255 - bg.r) * whiteBlend);
      const gg = Math.round(bg.g + (255 - bg.g) * whiteBlend);
      const bb = Math.round(bg.b + (255 - bg.b) * whiteBlend);
      rgba[i] = rr; rgba[i + 1] = gg; rgba[i + 2] = bb; rgba[i + 3] = alpha;
    }
  }
  return rgba;
}

/** Wrap RGBA bytes into a standard PNG. */
function rgbaToPng(rgba: Buffer, W: number, H: number): Buffer {
  // Add the filter byte (0 = None) to each scanline.
  const rowSize = 1 + W * 4;
  const filtered = Buffer.alloc(H * rowSize);
  for (let y = 0; y < H; y++) {
    filtered[y * rowSize] = 0;
    rgba.copy(filtered, y * rowSize + 1, y * W * 4, (y + 1) * W * 4);
  }
  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(filtered)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Build a PNG of the mailpouch icon at the requested size. */
export function makeIconPng(size = CANVAS): Buffer {
  const rgba = renderIconRgba(size);
  return rgbaToPng(rgba, size, size);
}

/**
 * Wrap one or more PNGs into a multi-resolution ICO. Windows picks the
 * closest sub-size to the current DPI scale, so shipping 16/32/48/64 in
 * one ICO keeps the tray crisp across 100/125/150/200 % scaling.
 */
export function pngsToIco(pngs: Array<{ size: number; data: Buffer }>): Buffer {
  // ICONDIR: reserved(2) | type=1(2) | count(2) = 6 bytes
  // Then N × ICONDIRENTRY (16 bytes each), then image data concatenated.
  const hdr = Buffer.alloc(6);
  hdr.writeUInt16LE(0, 0);
  hdr.writeUInt16LE(1, 2);
  hdr.writeUInt16LE(pngs.length, 4);

  const entries: Buffer[] = [];
  const images: Buffer[]  = [];
  let offset = 6 + pngs.length * 16;
  for (const { size, data } of pngs) {
    const entry = Buffer.alloc(16);
    // ICO spec encodes 256 as 0. Clamp any other value to 1-255.
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0; entry[3] = 0;
    entry.writeUInt16LE(1,  4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    images.push(data);
    offset += data.length;
  }
  return Buffer.concat([hdr, ...entries, ...images]);
}

/**
 * Return the right-format icon bytes for the given platform.
 *
 * - Windows: multi-resolution ICO with 16/32/48/64 sub-sizes. Windows
 *   picks the closest to the current DPI scale automatically.
 * - macOS / Linux: single 64×64 PNG. systray2 / libappindicator both
 *   accept PNG-base64 and handle downscaling on their end.
 */
export function makeTrayIconBytes(platform: NodeJS.Platform = process.platform): Buffer {
  if (platform === "win32") {
    return pngsToIco([
      { size: 16, data: makeIconPng(16) },
      { size: 32, data: makeIconPng(32) },
      { size: 48, data: makeIconPng(48) },
      { size: 64, data: makeIconPng(64) },
    ]);
  }
  return makeIconPng(64);
}

/** Base64 encoding of the platform-appropriate icon — what systray2 wants. */
export function makeTrayIconBase64(platform: NodeJS.Platform = process.platform): string {
  return makeTrayIconBytes(platform).toString("base64");
}
