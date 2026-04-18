#!/usr/bin/env node
/**
 * pm-bridge-mcp — Settings entry point
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

// ─── Parse CLI flags ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function flagIndex(name: string): number { return args.indexOf(name); }
function hasFlag(name: string): boolean  { return flagIndex(name) !== -1; }

if (hasFlag("--help") || hasFlag("-h")) {
  process.stdout.write(
    "Usage: pm-bridge-mcp-settings [options]\n\n" +
    "Options:\n" +
    "  --port <n>    HTTP server port (default: 8765)\n" +
    "  --browser     Force browser mode\n" +
    "  --tui         Force interactive TUI\n" +
    "  --plain       Force plain readline menus (no ANSI)\n" +
    "  --no-open     Start HTTP server without auto-opening browser\n" +
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
  process.stderr.write("Invalid port. Usage: pm-bridge-mcp-settings [--port <1-65535>]\n");
  process.exit(1);
}

const forceBrowser = hasFlag("--browser");
const forceTUI     = hasFlag("--tui");
const forcePlain   = hasFlag("--plain");
const noOpen       = hasFlag("--no-open");
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
          process.stdout.write(`\n  pm-bridge-mcp Settings\n`);
          process.stdout.write(`  Could not auto-open browser. Open manually:\n`);
          process.stdout.write(`  ${url}\n\n`);
        }
      }
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
