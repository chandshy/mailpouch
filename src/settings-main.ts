#!/usr/bin/env node
/**
 * mailpouch — Settings entry point
 *
 * Auto-detects the display environment and launches the best available UI:
 *
 *   browser  — HTTP settings server + auto-opens system browser
 *              (macOS, Windows, Linux with X11/Wayland)
 *   ansi     — full-colour interactive TUI with arrow-key navigation
 *              (SSH sessions, headless Linux terminals with colour support)
 *   plain    — readline numbered-menu TUI, no escape codes
 *              (dumb terminals, TERM=dumb, NO_COLOR, old Windows console)
 *   none     — prints config status and instructions, then exits
 *              (piped/CI environments, non-TTY contexts)
 *
 * CLI flags:
 *   --port <n>      HTTP server port (default 8766)
 *   --browser       Force browser mode (starts HTTP server + opens browser)
 *   --tui           Force interactive TUI (skips browser even if display available)
 *   --plain         Force plain readline menus (no ANSI escape codes)
 *   --no-open       Start HTTP server but do not auto-open browser
 *   --version       Print version and exit
 *   --help          Show usage and exit
 */

import { spawn } from "child_process";
import { readFileSync } from "fs";
import { fileURLToPath as _fileURLToPath } from "url";
import nodePath from "path";
import {
  detectEnvironment,
  openBrowser,
  runAnsiTUI,
  runPlainTUI,
  printNonInteractive,
} from "./settings/tui.js";
import { startSettingsServer } from "./settings/server.js";
import { loadConfig } from "./config/loader.js";
import { createTray, trayPreconditionSkip, inheritDisplayFromParent, type TrayHandle } from "./utils/tray.js";
import { buildLauncherTrayMenu } from "./utils/tray-menu.js";
import { makeIconPng, makeTrayIconBytes } from "./utils/icon.js";

const _pkgVersion = (() => {
  try {
    const dir = nodePath.dirname(_fileURLToPath(import.meta.url));
    return (JSON.parse(readFileSync(nodePath.resolve(dir, "../package.json"), "utf-8")) as { version: string }).version;
  } catch { return "unknown"; }
})();

// ─── Parse CLI flags ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function flagIndex(name: string): number { return args.indexOf(name); }
function hasFlag(name: string): boolean  { return flagIndex(name) !== -1; }

if (hasFlag("--help") || hasFlag("-h")) {
  process.stdout.write(
    "Usage: mailpouch-settings [options]\n\n" +
    "Options:\n" +
    "  --port <n>    HTTP server port (default: 8766)\n" +
    "  --browser     Force browser mode\n" +
    "  --tui         Force interactive TUI\n" +
    "  --plain       Force plain readline menus (no ANSI)\n" +
    "  --no-open     Start HTTP server without auto-opening browser\n" +
    "  --no-tray     Don't attach a system tray icon (server only)\n" +
    "  --lan         Bind HTTP server to LAN interface\n" +
    "  --version     Print version and exit\n" +
    "  --help        Show this help message\n"
  );
  process.exit(0);
}

if (hasFlag("--version") || hasFlag("-v")) {
  process.stdout.write(`${_pkgVersion}\n`);
  process.exit(0);
}

// Read settingsPort from config file (lowest priority — CLI and env override it)
let configPort = 8766;
try {
  const cfg = loadConfig();
  if (cfg?.settingsPort && cfg.settingsPort >= 1 && cfg.settingsPort <= 65535) {
    configPort = cfg.settingsPort;
  }
} catch { /* ignore — config may not exist yet */ }

const portArg = flagIndex("--port");
const port = portArg !== -1
  ? parseInt(args[portArg + 1], 10)
  : process.env.PORT
    ? parseInt(process.env.PORT, 10)
    : configPort;

if (isNaN(port) || port < 1 || port > 65535) {
  process.stderr.write("Invalid port. Usage: mailpouch-settings [--port <1-65535>]\n");
  process.exit(1);
}

const forceBrowser = hasFlag("--browser");
const forceTUI     = hasFlag("--tui");
const forcePlain   = hasFlag("--plain");
const noOpen       = hasFlag("--no-open");
const noTray       = hasFlag("--no-tray"); // server-only mode (no system tray)
const lan          = hasFlag("--lan");   // bind to LAN for 3rd-device approval

// ─── Detect environment ───────────────────────────────────────────────────────

const env = detectEnvironment();

// CLI overrides take precedence over auto-detection
let mode = env.mode;
if (forceBrowser) mode = "browser";
if (forceTUI)     mode = env.hasAnsi ? "ansi" : "plain";
if (forcePlain)   mode = "plain";

// ─── Helper: start HTTP(S) server (deferred so TUI can start it on demand) ────

let serverStarted = false;
function startServer(p: number): void {
  if (serverStarted) return;
  serverStarted = true;
  // Return value ({ scheme }) is only needed for browser auto-open; TUI handles
  // the URL itself after the server is running, so we can safely discard it.
  startSettingsServer(p, lan, false, { onRestartRequested: _onRestartRequested, onShutdownRequested: _onShutdownRequested }).catch((err: Error) => {
    process.stderr.write(`Settings server error: ${err?.message ?? err}\n`);
    process.exit(1);
  });
}

// ─── Helper: restart after a successful npm update install ────────────────────
// Tears down the tray, spawns a fresh copy of this process, then exits so the
// new binary is in use and the old one is gone cleanly.
function _onRestartRequested(): void {
  try { _activeTray?.destroy(); } catch { /* already gone */ }
  const child = spawn(process.execPath, process.argv.slice(1), {
    stdio: "ignore",
    detached: true,
  });
  child.on("error", () => { /* ignore — new process may still start */ });
  child.unref();
  setTimeout(() => process.exit(0), 200);
}

// ─── Helper: graceful shutdown from the in-UI "Shutdown" button ───────────────
// This standalone entry owns _activeTray, so a UI shutdown must destroy the tray
// subprocess before exiting (UI-006) — otherwise the systray2 helper binary is
// orphaned. Mirrors the tray "Quit" cleanup.
function _onShutdownRequested(): void {
  try { _activeTray?.destroy(); } catch { /* already gone */ }
  setTimeout(() => process.exit(0), 200);
}

// ─── Helper: persistent tray icon ────────────────────────────────────────────
// When `mailpouch-settings` is the user's always-on background process (their
// autostart entry), the tray icon is how they control the settings UI:
//
//   mailpouch                — header label (disabled)
//   Open Settings            — re-opens the browser at the live URL (UI on only)
//   Enable/Disable Settings UI — toggles the HTTP server WITHOUT killing the
//                              tray, mirroring the MCP-server tray. "Disable"
//                              stops serving; "Enable" brings it back up.
//   Quit                     — stops the server and exits cleanly
//
// Spartan vs. the MCP tray (no agent/connection state here). Backend selection
// (native vs systray2 fallback) lives in utils/tray.ts. Skips silently on
// headless/arm64 hosts.
let _activeTray: TrayHandle | null = null;
let _uiStop: (() => Promise<void>) | null = null; // stop fn for the running server
let _uiEnabled = false;
let _uiUrl = "";

function _rebuildLauncherTray(): void {
  if (!_activeTray) return;
  try {
    _activeTray.setMenu(buildLauncherTrayMenu({
      version: _pkgVersion,
      settingsEnabled: _uiEnabled,
      settingsUrl: _uiUrl,
    }));
  } catch { /* tray backend may not support live updates — non-fatal */ }
}

/** Bring the HTTP server back up on the original port (tray "Enable"). */
async function _enableUi(): Promise<void> {
  if (_uiEnabled) return;
  const { scheme, stop } = await startSettingsServer(port, lan, false, {
    onRestartRequested: _onRestartRequested,
    onShutdownRequested: _onShutdownRequested,
  });
  _uiStop = stop;
  _uiUrl = `${scheme}://localhost:${port}`;
  _uiEnabled = true;
}

/** Stop serving but keep the tray + process alive (tray "Disable"). */
async function _disableUi(): Promise<void> {
  if (!_uiEnabled) return;
  try { if (_uiStop) await _uiStop(); }
  finally { _uiStop = null; _uiUrl = ""; _uiEnabled = false; }
}

function _startTrayIcon(): void {
  if (noTray) return;
  // GUI MCP clients (Claude Desktop, VS Code) strip DISPLAY from
  // stdio-spawned children; copy it from the parent's environ on Linux
  // before the precondition check so GTK can connect.
  inheritDisplayFromParent();
  const skip = trayPreconditionSkip();
  if (skip) {
    process.stderr.write(`Tray skipped: ${skip}\n`);
    return;
  }

  try {
    _activeTray = createTray({
      iconPng: makeIconPng(64),
      // Hi-DPI override for the systray2 fallback path on Windows —
      // multi-resolution ICO so the tray stays crisp at 100/125/150/200%
      // scaling. Native backend ignores this.
      iconLegacyOverride: process.platform === "win32" ? makeTrayIconBytes("win32") : undefined,
      tooltip: "mailpouch — Proton Mail via Bridge",
      items: buildLauncherTrayMenu({ version: _pkgVersion, settingsEnabled: _uiEnabled, settingsUrl: _uiUrl }),
      onClick: (id) => {
        switch (id) {
          case "open":
            if (_uiUrl) openBrowser(_uiUrl);
            break;
          case "disable":
            _disableUi().then(_rebuildLauncherTray).catch((e) =>
              process.stderr.write(`Disable Settings UI failed: ${e instanceof Error ? e.message : String(e)}\n`));
            break;
          case "enable":
            _enableUi().then(_rebuildLauncherTray).catch((e) =>
              process.stderr.write(`Enable Settings UI failed: ${e instanceof Error ? e.message : String(e)}\n`));
            break;
          case "quit":
            try { _activeTray?.destroy(); } catch { /* already gone */ }
            // Give the native D-Bus SNI deregistration message time to flush
            // before file descriptors close on exit.
            setTimeout(() => process.exit(0), 300);
            break;
        }
      },
    });
    process.stdout.write(`  Tray icon active (${_activeTray.backend} backend).\n`);
  } catch (err: unknown) {
    process.stderr.write(`Tray icon failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

// ─── Dispatch ─────────────────────────────────────────────────────────────────

switch (mode) {
  // ── Browser mode ───────────────────────────────────────────────────────────
  case "browser": {
    // Start server first (async), then open browser once it's listening.
    // startSettingsServer returns the actual scheme (http/https) so we open
    // the correct URL regardless of whether openssl was available.
    startSettingsServer(port, lan, false, { onRestartRequested: _onRestartRequested, onShutdownRequested: _onShutdownRequested }).then(({ scheme, stop }) => {
      const url = `${scheme}://localhost:${port}`;
      serverStarted = true;
      _uiStop = stop;
      _uiUrl = url;
      _uiEnabled = true;

      if (!noOpen) {
        const opened = openBrowser(url);
        if (!opened) {
          process.stdout.write(`\n  mailpouch Settings\n`);
          process.stdout.write(`  Could not auto-open browser. Open manually:\n`);
          process.stdout.write(`  ${url}\n\n`);
        }
      }

      // Fire the tray in the background — user wanted an always-available
      // control point. Start it AFTER openBrowser so the browser opens
      // immediately even if tray init takes a moment. Fire-and-forget; the
      // tray stays alive across enable/disable so it's always reachable.
      void _startTrayIcon();
    }).catch((err: Error) => {
      process.stderr.write(`Settings server error: ${err?.message ?? err}\n`);
      process.exit(1);
    });
    // The server keeps the process alive; nothing more to do here.
    break;
  }

  // ── ANSI TUI ───────────────────────────────────────────────────────────────
  case "ansi": {
    runAnsiTUI(port, startServer).catch((err) => {
      process.stderr.write(`TUI error: ${err?.message ?? err}\n`);
      process.exit(1);
    });
    break;
  }

  // ── Plain readline TUI ─────────────────────────────────────────────────────
  case "plain": {
    runPlainTUI(port, startServer).catch((err) => {
      process.stderr.write(`Error: ${err?.message ?? err}\n`);
      process.exit(1);
    });
    break;
  }

  // ── Non-interactive ────────────────────────────────────────────────────────
  case "none":
  default: {
    printNonInteractive();
    process.exit(0);
  }
}
