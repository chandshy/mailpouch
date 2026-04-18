#!/usr/bin/env node
/**
 * mailpouch — System Tray entry point
 *
 * Starts the settings HTTP server and shows a system tray icon
 * matching the style of the Proton Bridge tray icon:
 *
 *   ● Connected
 *   user@proton.me
 *   ──────────────
 *   Open Settings
 *   ──────────────
 *   Quit
 *
 * Requires the optional `systray2` package. If it is not installed the
 * settings server still starts and the browser is opened automatically.
 */

import { createRequire } from "module";
import { deflateSync }   from "zlib";
import { loadConfig }    from "./config/loader.js";
import { startSettingsServer } from "./settings/server.js";
import { openBrowser }   from "./settings/tui.js";
// Type-only imports from the ambient module in src/types/systray2.d.ts.
// The actual runtime value is loaded lazily via _require() below to avoid a
// hard dependency on the optional systray2 package.
import type SysTrayClass from "systray2";
import type { MenuItem }  from "systray2";

const _require = createRequire(import.meta.url);

// ── Icon generation (pure Node.js, no deps) ───────────────────────────────────
// Builds a 32×32 RGBA PNG envelope icon then wraps it in an ICO container so
// Windows shows a proper tray icon.  macOS receives the raw PNG directly.

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

/** Draw a 32×32 RGBA PNG: purple background with a white envelope outline + V-flap. */
function makeEnvelopePng(): Buffer {
  const W = 32, H = 32;
  const rowSize = 1 + W * 4; // filter byte + 4 bytes per pixel (RGBA)
  const raw = Buffer.allocUnsafe(H * rowSize);

  // Fill entire canvas with Proton purple (#6D4AFF)
  for (let y = 0; y < H; y++) {
    raw[y * rowSize] = 0; // filter byte: None
    for (let x = 0; x < W; x++) {
      const o = y * rowSize + 1 + x * 4;
      raw[o] = 109; raw[o + 1] = 74; raw[o + 2] = 255; raw[o + 3] = 255;
    }
  }

  function setWhite(x: number, y: number) {
    if (x < 0 || x >= W || y < 0 || y >= H) return;
    const o = y * rowSize + 1 + x * 4;
    raw[o] = 255; raw[o + 1] = 255; raw[o + 2] = 255; raw[o + 3] = 255;
  }

  function drawLine(ax: number, ay: number, bx: number, by: number) {
    const dx = Math.abs(bx - ax), dy = Math.abs(by - ay);
    const sx = ax < bx ? 1 : -1, sy = ay < by ? 1 : -1;
    let err = dx - dy;
    for (;;) {
      setWhite(ax, ay);
      if (ax === bx && ay === by) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; ax += sx; }
      if (e2 <  dx) { err += dx; ay += sy; }
    }
  }

  // Envelope body rectangle: leave ~3px margin on all sides
  const x1 = 3, y1 = 9, x2 = 28, y2 = 22;

  // Rectangle outline
  for (let x = x1; x <= x2; x++) { setWhite(x, y1); setWhite(x, y2); }
  for (let y = y1; y <= y2; y++) { setWhite(x1, y); setWhite(x2, y); }

  // V-flap: lines from top-left and top-right corners meeting at center
  const cx = Math.floor((x1 + x2) / 2); // 15
  const cy = y1 + Math.floor((y2 - y1) * 0.5); // 15
  drawLine(x1, y1, cx, cy);
  drawLine(x2, y1, cx, cy);

  // Build RGBA PNG (color type 6 = RGBA)
  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), // PNG signature
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Wrap a PNG into a minimal single-image ICO (Vista+ supports PNG-in-ICO). */
function pngToIco(png: Buffer): Buffer {
  const hdr   = Buffer.from([0, 0, 1, 0, 1, 0]); // reserved | type=1 | count=1
  const entry = Buffer.allocUnsafe(16);
  entry[0] = 32; entry[1] = 32; // 32×32
  entry[2] = 0;  entry[3] = 0;  // colorCount, reserved
  entry.writeUInt16LE(1,  4);    // planes
  entry.writeUInt16LE(32, 6);    // bit depth
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(22, 12);   // image data offset: 6 (hdr) + 16 (entry)
  return Buffer.concat([hdr, entry, png]);
}

// Purple envelope icon
const iconPng = makeEnvelopePng();
const ICON_B64 = process.platform === "win32"
  ? pngToIco(iconPng).toString("base64")
  : iconPng.toString("base64");

// ── Helpers ───────────────────────────────────────────────────────────────────

function item(title: string, tooltip = "", enabled = true): MenuItem {
  return { title, tooltip, checked: false, enabled };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let port  = 8765;
  let email = "";
  try {
    const cfg = loadConfig();
    if (cfg?.settingsPort && cfg.settingsPort >= 1 && cfg.settingsPort <= 65535) {
      port = cfg.settingsPort;
    }
    email = cfg?.connection?.username ?? "";
  } catch { /* config not yet written — use defaults */ }

  const lan = process.argv.includes("--lan");
  const { scheme } = await startSettingsServer(port, lan);
  const settingsUrl = `${scheme}://localhost:${port}`;

  // ── Try loading systray2 (optional dependency) ─────────────────────────────
  // The package is optional: if absent the settings server still runs.
  // We assert the module shape via the ambient types in src/types/systray2.d.ts.
  type SysTrayConstructor = typeof SysTrayClass;
  let SysTray: SysTrayConstructor | undefined;
  try {
    SysTray = (_require("systray2") as { default: SysTrayConstructor }).default;
  } catch {
    // systray2 not installed — start server and open browser, no tray icon
    openBrowser(settingsUrl);
    process.stdout.write(
      `\nmailpouch Settings: ${settingsUrl}\nPress Ctrl+C to stop.\n\n`
    );
    return;
  }

  // After the catch block's early return, SysTray is guaranteed to be defined.
  const ST = SysTray!;
  const sep: MenuItem = ST.separator;

  const tray: InstanceType<SysTrayConstructor> = new ST({
    menu: {
      icon:    ICON_B64,
      title:   "",
      tooltip: "mailpouch",
      items: [
        item("mailpouch", "Proton Mail via Proton Bridge", false),
        sep,
        item(`\u25CF Connected`,    "", false),
        item(email || "Not configured", "", false),
        sep,
        item("Open Settings", `Open ${settingsUrl}`),
        sep,
        item("Quit", "Stop the settings server"),
      ],
    },
    debug:   false,
    copyDir: true,
  });

  tray.onClick((action: { item: MenuItem }) => {
    switch (action.item.title) {
      case "Open Settings":
        openBrowser(settingsUrl);
        break;
      case "Quit":
        tray.kill(false);
        process.exit(0);
        break;
    }
  });

  process.stdout.write(
    `\nmailpouch tray icon active.\nSettings: ${settingsUrl}\nRight-click the tray icon to manage.\n\n`
  );
}

main().catch((err: Error) => {
  process.stderr.write(`Tray startup failed: ${err?.message ?? err}\n`);
  process.exit(1);
});
