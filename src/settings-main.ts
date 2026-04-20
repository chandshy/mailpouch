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
 *   --port <n>      HTTP server port (default 8765)
 *   --browser       Force browser mode (starts HTTP server + opens browser)
 *   --tui           Force interactive TUI (skips browser even if display available)
 *   --plain         Force plain readline menus (no ANSI escape codes)
 *   --no-open       Start HTTP server but do not auto-open browser
 *   --version       Print version and exit
 *   --help          Show usage and exit
 */

import { createRequire } from "module";
import {
  detectEnvironment,
  openBrowser,
  runAnsiTUI,
  runPlainTUI,
  printNonInteractive,
} from "./settings/tui.js";
import { startSettingsServer } from "./settings/server.js";
import { loadConfig } from "./config/loader.js";
import { createTray, trayPreconditionSkip, type TrayHandle } from "./utils/tray.js";
import { makeIconPng, makeTrayIconBytes } from "./utils/icon.js";

// ─── Parse CLI flags ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function flagIndex(name: string): number { return args.indexOf(name); }
function hasFlag(name: string): boolean  { return flagIndex(name) !== -1; }

if (hasFlag("--help") || hasFlag("-h")) {
  process.stdout.write(
    "Usage: mailpouch-settings [options]\n\n" +
    "Options:\n" +
    "  --port <n>    HTTP server port (default: 8765)\n" +
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
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../package.json") as { version: string };
    process.stdout.write(`${pkg.version}\n`);
  } catch {
    process.stdout.write("unknown\n");
  }
  process.exit(0);
}

// Read settingsPort from config file (lowest priority — CLI and env override it)
let configPort = 8765;
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
  startSettingsServer(p, lan).catch((err: Error) => {
    process.stderr.write(`Settings server error: ${err?.message ?? err}\n`);
    process.exit(1);
  });
}

// ─── Helper: persistent tray icon ────────────────────────────────────────────
// When `mailpouch-settings` is the user's always-on background process (their
// autostart entry), the tray icon is how they get back to the settings UI.
// The menu is intentionally spartan — this entry point doesn't have agent
// grants / escalation queue state to surface, unlike the MCP's embedded
// tray. Just the three things the user actually needs:
//
//   mailpouch                — header label (disabled)
//   Open Settings            — re-opens the browser at the live URL
//   Quit                     — stops the HTTP server and exits cleanly
//
// Backend selection (native tray-icon vs systray2 fallback) lives in
// utils/tray.ts; we just call createTray() and let it pick. Skips
// silently on headless/arm64 hosts; the HTTP server still runs so
// browser access keeps working from a different machine on the LAN.
let _activeTray: TrayHandle | null = null;
function _startTrayIcon(url: string): void {
  if (noTray) return;
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
      items: [
        { id: "header",   label: "mailpouch", enabled: false },
        { id: "sep1",     label: "",          separator: true },
        { id: "open",     label: "Open Settings" },
        { id: "sep2",     label: "",          separator: true },
        { id: "quit",     label: "Quit" },
      ],
      onClick: (id) => {
        switch (id) {
          case "open":
            openBrowser(url);
            break;
          case "quit":
            try { _activeTray?.destroy(); } catch { /* already gone */ }
            // Let the tray teardown flush, then exit cleanly.
            setTimeout(() => process.exit(0), 150);
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
    startSettingsServer(port, lan).then(({ scheme }) => {
      const url = `${scheme}://localhost:${port}`;
      serverStarted = true;

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
      // HTTP server is the process's anchor either way.
      void _startTrayIcon(url);
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
