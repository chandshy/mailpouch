/**
 * Tests for src/utils/icon.ts — the tray / app icon generator.
 *
 * These are format / structure checks, not pixel-level snapshot tests:
 * the pixel output of the programmatic raster is sensitive to rounding
 * and would churn on any tweak to the gradient math, producing noisy
 * diffs without catching real regressions. Instead we assert:
 *
 *   - PNG and ICO produce valid, non-empty, signature-bearing buffers
 *   - Windows multi-resolution ICO contains exactly the expected
 *     sub-sizes in the header directory
 *   - The renderer honors the requested size (IHDR width/height match)
 *   - The rounded-rect mask leaves corners transparent and the center
 *     opaque (catches an accidental mask inversion)
 */
import { describe, it, expect } from "vitest";
import {
  makeIconPng,
  pngsToIco,
  makeTrayIconBytes,
  renderIconRgba,
} from "./icon.js";

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
const ICO_SIG = Buffer.from([0x00, 0x00, 0x01, 0x00]); // reserved | type=1

describe("icon generator", () => {
  it("makeIconPng returns a valid PNG with the 8-byte signature", () => {
    const png = makeIconPng(64);
    expect(png.length).toBeGreaterThan(100);
    expect(png.subarray(0, 8)).toEqual(PNG_SIG);
  });

  it("IHDR width/height match the requested size", () => {
    const png = makeIconPng(32);
    // IHDR starts at byte 8 (PNG sig) + 4 (length field). Width is bytes 16..19.
    const width  = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    expect(width).toBe(32);
    expect(height).toBe(32);
  });

  it("renderIconRgba produces a buffer of size * size * 4 bytes", () => {
    const rgba = renderIconRgba(16);
    expect(rgba.length).toBe(16 * 16 * 4);
  });

  it("renders transparent corners (rounded-rect mask) and opaque center", () => {
    const rgba = renderIconRgba(64);
    // Top-left pixel (0, 0) sits well inside the 10-px corner radius, so
    // alpha should be 0 after the mask.
    const tlAlpha = rgba[0 * 64 * 4 + 0 * 4 + 3];
    expect(tlAlpha).toBe(0);
    // Center pixel (32, 32) is deep inside the rounded-rect — full alpha.
    const centerAlpha = rgba[32 * 64 * 4 + 32 * 4 + 3];
    expect(centerAlpha).toBe(255);
  });

  it("pngsToIco wraps multiple PNGs with the expected signature + count", () => {
    const ico = pngsToIco([
      { size: 16, data: makeIconPng(16) },
      { size: 32, data: makeIconPng(32) },
    ]);
    expect(ico.subarray(0, 4)).toEqual(ICO_SIG);
    // Count field is LE uint16 at offset 4.
    expect(ico.readUInt16LE(4)).toBe(2);
    // First entry: width byte at offset 6.
    expect(ico[6]).toBe(16);
    // Second entry: width byte at offset 6 + 16 = 22.
    expect(ico[22]).toBe(32);
  });

  it("makeTrayIconBytes returns ICO on win32 and PNG elsewhere", () => {
    const win = makeTrayIconBytes("win32");
    const lin = makeTrayIconBytes("linux");
    const mac = makeTrayIconBytes("darwin");
    expect(win.subarray(0, 4)).toEqual(ICO_SIG);
    expect(lin.subarray(0, 8)).toEqual(PNG_SIG);
    expect(mac.subarray(0, 8)).toEqual(PNG_SIG);
  });

  it("ICO packs 16/32/48/64 sub-sizes for Windows hi-DPI scaling", () => {
    const ico = makeTrayIconBytes("win32");
    const count = ico.readUInt16LE(4);
    expect(count).toBe(4);
    // Walk the ICONDIRENTRY table (16 bytes each, first at offset 6) and
    // collect the width byte from each entry. 256 is encoded as 0 in the
    // spec, but we never use that size so expect a literal match.
    const sizes: number[] = [];
    for (let i = 0; i < count; i++) {
      sizes.push(ico[6 + i * 16]);
    }
    expect(sizes).toEqual([16, 32, 48, 64]);
  });
});
