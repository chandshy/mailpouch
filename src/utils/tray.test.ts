/**
 * Tests for src/utils/tray.ts — the systray2 preflight helpers shared
 * between src/index.ts (MCP embedded tray) and src/settings-main.ts
 * (standalone persistent tray). Covers only the pure decision logic;
 * the chmod side-effect is exercised live during CI + dev spawns, not
 * here (mocking fs/path/os in a way that's realistic across all four
 * platforms is more churn than it's worth for a one-line helper).
 */
import { describe, it, expect } from "vitest";
import { trayPreconditionSkip } from "./tray.js";

describe("trayPreconditionSkip", () => {
  it("returns null on macOS x86_64 with any env (GUI assumed)", () => {
    expect(trayPreconditionSkip("darwin", "x64", {})).toBeNull();
  });

  it("returns null on Windows with any env (GUI assumed)", () => {
    expect(trayPreconditionSkip("win32", "x64", {})).toBeNull();
  });

  it("returns null on Linux x86_64 when DISPLAY is set (X11)", () => {
    expect(trayPreconditionSkip("linux", "x64", { DISPLAY: ":0" })).toBeNull();
  });

  it("returns null on Linux x86_64 when WAYLAND_DISPLAY is set (Wayland)", () => {
    expect(trayPreconditionSkip("linux", "x64", { WAYLAND_DISPLAY: "wayland-0" })).toBeNull();
  });

  it("returns a skip reason on Linux x86_64 with no display env", () => {
    const reason = trayPreconditionSkip("linux", "x64", {});
    expect(reason).toMatch(/no display environment/);
    expect(reason).toMatch(/DISPLAY/);
    expect(reason).toMatch(/WAYLAND_DISPLAY/);
  });

  it("env with only unrelated vars still counts as headless on Linux", () => {
    expect(trayPreconditionSkip("linux", "x64", { HOME: "/home/x", PATH: "/usr/bin" }))
      .toMatch(/no display environment/);
  });
});
