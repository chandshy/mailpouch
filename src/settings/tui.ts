/**
 * ProtonMail MCP Server — Terminal UI
 *
 * Provides interactive configuration management when a browser is not
 * available. Detects the environment at runtime and selects the best
 * rendering mode:
 *
 *   browser  — start HTTP server + auto-open system browser
 *   ansi     — full-colour interactive TUI with arrow-key navigation
 *   plain    — readline numbered-menu TUI (no escape codes)
 *   none     — print status summary and exit (piped / non-interactive)
 *
 * No external dependencies — uses only Node.js built-ins.
 */

import readline from "readline";
import { spawnSync, spawn } from "child_process";
import { Socket } from "net";
import {
  loadConfig,
  saveConfig,
  defaultConfig,
  buildPermissions,
  configExists,
  getConfigPath,
} from "../config/loader.js";
import {
  TOOL_CATEGORIES,
  type PermissionPreset,
  type ServerConfig,
} from "../config/schema.js";
import {
  getPendingEscalations,
  approveEscalation,
  denyEscalation,
  getAuditLog,
  type EscalationRecord,
} from "../permissions/escalation.js";

// ─── Environment detection ─────────────────────────────────────────────────────

export interface EnvCapabilities {
  isTTY: boolean;
  hasAnsi: boolean;
  hasDisplay: boolean; // X11 / Wayland / macOS / Windows desktop
  platform: NodeJS.Platform;
  /** Preferred display mode given the above */
  mode: "browser" | "ansi" | "plain" | "none";
}

export function detectEnvironment(): EnvCapabilities {
  const platform = process.platform as NodeJS.Platform;
  const isTTY = process.stdout.isTTY === true && process.stdin.isTTY === true;

  // ── ANSI colour detection ────────────────────────────────────────────────
  let hasAnsi = false;
  if (isTTY) {
    if (process.env.NO_COLOR || process.env.TERM === "dumb") {
      hasAnsi = false;
    } else if (process.env.FORCE_COLOR) {
      hasAnsi = true;
    } else if (platform === "win32") {
      // Windows Terminal, VS Code, ConEmu, JetBrains — all support ANSI
      hasAnsi = !!(
        process.env.WT_SESSION ||
        process.env.TERM_PROGRAM ||
        process.env.ConEmuANSI === "ON" ||
        process.env.ANSICON
      );
      // Windows 10 v1511+ supports ANSI natively in conhost
      if (!hasAnsi) {
        const release = process.version; // crude fallback: Node ≥20 on Win10+ is safe
        hasAnsi = parseInt(release.replace("v", "")) >= 20;
      }
    } else {
      // macOS / Linux: COLORTERM, non-dumb TERM, or presence of TERM at all
      hasAnsi = !!(process.env.COLORTERM || process.env.TERM);
    }
  }

  // ── Desktop / display detection ──────────────────────────────────────────
  let hasDisplay = false;
  if (platform === "darwin" || platform === "win32") {
    hasDisplay = true; // always have a browser on desktop OS
  } else {
    // Linux/BSD: X11 or Wayland
    hasDisplay = !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  }

  // ── Mode selection ───────────────────────────────────────────────────────
  let mode: EnvCapabilities["mode"];
  if (hasDisplay) {
    mode = "browser";
  } else if (isTTY && hasAnsi) {
    mode = "ansi";
  } else if (isTTY) {
    mode = "plain";
  } else {
    mode = "none";
  }

  return { isTTY, hasAnsi, hasDisplay, platform, mode };
}

// ─── Browser launcher ──────────────────────────────────────────────────────────

export function openBrowser(url: string): boolean {
  const platform = process.platform;
  try {
    if (platform === "darwin") {
      spawnSync("open", [url], { stdio: "ignore" });
      return true;
    } else if (platform === "win32") {
      // `start` is a shell built-in; need shell: true
      spawnSync("cmd", ["/c", "start", "", url], { stdio: "ignore", shell: false });
      return true;
    } else {
      // Linux/BSD: try xdg-open, then fallback candidates
      for (const cmd of ["xdg-open", "sensible-browser", "x-www-browser", "gnome-open"]) {
        const r = spawnSync(cmd, [url], { stdio: "ignore" });
        if (r.status === 0 || r.error === undefined) return true;
      }
    }
  } catch {
    // ignore — caller will print URL instead
  }
  return false;
}

// ─── Shared helpers ────────────────────────────────────────────────────────────

async function tcpCheck(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = new Socket();
    s.setTimeout(3000);
    s.on("connect", () => { s.destroy(); resolve(true); });
    s.on("error", () => resolve(false));
    s.on("timeout", () => { s.destroy(); resolve(false); });
    s.connect(port, host);
  });
}

function loadOrDefault(): ServerConfig {
  return loadConfig() ?? defaultConfig();
}

/**
 * Ask a question via an existing readline interface while suppressing echoed
 * input — suitable for password fields.  Uses the caller's `rl` to avoid
 * opening a second interface on the same stdin.
 *
 * Implementation: `rl.question()` writes the prompt synchronously via
 * `_writeToOutput`, then waits for a line event.  We set `muted = true`
 * immediately after the call (prompt already written) so all subsequent
 * character output is suppressed until the user presses Enter.
 */
function mutedQuestion(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise(resolve => {
    let muted = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const orig: ((s: string) => void) | undefined = (rl as any)._writeToOutput?.bind(rl);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (rl as any)._writeToOutput = (s: string) => { if (!muted) orig?.(s); };
    rl.question(prompt, answer => {
      // Restore normal output before the next prompt
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (orig) (rl as any)._writeToOutput = orig;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (rl as any).output?.write('\n'); // move to next line after hidden input
      resolve(answer);
    });
    muted = true; // suppress all further _writeToOutput calls until answer received
  });
}

/** Strip ANSI/VT escape sequences from a string (defense-in-depth for terminal output). */
function stripAnsi(s: string): string {
  return s
    .replace(/\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

// ─── Non-interactive mode ──────────────────────────────────────────────────────

export function printNonInteractive(): void {
  const cfg = loadConfig();
  const path = getConfigPath();

  process.stdout.write("\npm-bridge-mcp — Settings\n");
  process.stdout.write("─".repeat(48) + "\n");

  if (cfg) {
    process.stdout.write(`Config file   : ${path}\n`);
    process.stdout.write(`Username      : ${cfg.connection.username || "(not set)"}\n`);
    process.stdout.write(`SMTP          : ${cfg.connection.smtpHost}:${cfg.connection.smtpPort}\n`);
    process.stdout.write(`IMAP          : ${cfg.connection.imapHost}:${cfg.connection.imapPort}\n`);
    process.stdout.write(`Preset        : ${cfg.permissions.preset}\n`);
    process.stdout.write(`Bridge cert   : ${cfg.connection.bridgeCertPath || "(none)"}\n`);
  } else {
    process.stdout.write(`Config file   : ${path} (not found — read-only defaults apply)\n`);
  }

  process.stdout.write("\nTo configure: run in an interactive terminal, or start the browser UI:\n");
  process.stdout.write("  npx protonmail-mcp-settings\n\n");
}

// ─── Colour helpers (ANSI) ────────────────────────────────────────────────────

const C = {
  reset:   "\x1b[0m",
  bold:    "\x1b[1m",
  dim:     "\x1b[2m",
  ul:      "\x1b[4m",
  black:   "\x1b[30m",
  red:     "\x1b[31m",
  green:   "\x1b[32m",
  yellow:  "\x1b[33m",
  blue:    "\x1b[34m",
  magenta: "\x1b[35m",
  cyan:    "\x1b[36m",
  white:   "\x1b[37m",
  gray:    "\x1b[90m",
  bRed:    "\x1b[91m",
  bGreen:  "\x1b[92m",
  bYellow: "\x1b[93m",
  bBlue:   "\x1b[94m",
  bMag:    "\x1b[95m",
  bCyan:   "\x1b[96m",
  bWhite:  "\x1b[97m",
  bgBlue:  "\x1b[44m",
  bgNav:   "\x1b[48;5;17m",   // deep navy background
  clrScr:  "\x1b[2J\x1b[H",
  clrLine: "\x1b[2K",
  hideCur: "\x1b[?25l",
  showCur: "\x1b[?25h",
  saveCur: "\x1b[s",
  restCur: "\x1b[u",
};

function c(colour: keyof typeof C, text: string): string {
  return C[colour] + text + C.reset;
}

// ─── ANSI Interactive TUI ─────────────────────────────────────────────────────

type AnsiView = "main" | "config" | "preset" | "escalation" | "test" | "server";

interface AnsiState {
  view: AnsiView;
  menuIdx: number;
  presetIdx: number;
  testResults: { smtp: boolean | null; imap: boolean | null } | null;
  serverPort: number;
  serverStarted: boolean;
  cfg: ServerConfig;
  dirty: boolean; // needs redraw
}

const MAIN_MENU = [
  { label: "View current configuration",    key: "config"    },
  { label: "Edit connection settings",      key: "edit"      },
  { label: "Set permission preset",         key: "preset"    },
  { label: "Escalation requests",           key: "escalation"},
  { label: "Test connectivity",             key: "test"      },
  { label: "Open browser UI",               key: "server"    },
  { label: "Reset to defaults",             key: "reset"     },
  { label: "Quit",                          key: "quit"      },
] as const;

type MainKey = typeof MAIN_MENU[number]["key"];

// ─── Escalation display helper ────────────────────────────────────────────────

function renderEscalationRecord(e: EscalationRecord, ansi: boolean): string {
  const bold  = ansi ? C.bold  : "";
  const rst   = ansi ? C.reset : "";
  const warn  = ansi ? C.yellow : "";
  const ok    = ansi ? C.bGreen : "";
  const err   = ansi ? C.bRed  : "";
  const gray  = ansi ? C.gray  : "";
  const cyan  = ansi ? C.bCyan : "";

  const secsLeft = Math.max(0, Math.round((new Date(e.expiresAt).getTime() - Date.now()) / 1000));
  const minStr = `${Math.floor(secsLeft / 60)}m${secsLeft % 60}s`;

  const lines: string[] = [
    `${bold}${warn}  ⚠ Pending Escalation Request${rst}`,
    `  ${gray}ID:${rst}       ${e.id}`,
    `  ${gray}From:${rst}     ${e.currentPreset}  ${warn}→${rst}  ${cyan}${e.targetPreset}${rst}`,
    `  ${gray}Reason:${rst}   ${stripAnsi(e.reason)}`,
    `  ${gray}Expires:${rst}  in ${secsLeft < 60 ? err : warn}${minStr}${rst}`,
    "",
  ];

  if (e.newTools.length > 0) {
    lines.push(`  ${gray}New tools that will be enabled:${rst}`);
    for (const t of e.newTools) lines.push(`    ${warn}• ${t}${rst}`);
    lines.push("");
  }

  return lines.join("\n");
}

const PRESETS: { id: PermissionPreset; label: string; desc: string }[] = [
  { id: "read_only",  label: "Read-Only",   desc: "Reading, analytics, system only — no writes"             },
  { id: "supervised", label: "Supervised",  desc: "All tools; deletion ≤5/hr, sending ≤20/hr"              },
  { id: "send_only",  label: "Send-Only",   desc: "Reading + sending only — no deletion or folder writes"   },
  { id: "full",       label: "Full Access", desc: "All 40 tools, no rate limits — full agent trust"         },
];

function ansiDraw(st: AnsiState): void {
  const out: string[] = [];
  const w = Math.min(process.stdout.columns || 80, 90);
  const pad = (s: string, n: number) => s.slice(0, n).padEnd(n);

  // Clear
  out.push(C.clrScr + C.hideCur);

  // Header
  const title = "  ✉  pm-bridge-mcp — Settings";
  out.push(C.bgNav + C.bCyan + C.bold + title.padEnd(w) + C.reset + "\n");

  const cfgExists = configExists();
  const cfgPath = getConfigPath();
  const presetLabel = st.cfg.permissions.preset ?? "read_only";
  const username = st.cfg.connection.username || c("gray", "(not set)");

  out.push(C.gray + `  Config: ${cfgPath} ` +
    (cfgExists ? c("bGreen", "[exists]") : c("yellow", "[not found — defaults applied]")) +
    C.reset + "\n");
  out.push(C.gray + `  User:   ` + C.bWhite + username + C.gray +
    `   Preset: ` + C.bCyan + presetLabel + C.reset + "\n");
  out.push("\n");

  if (st.view === "main") {
    out.push(C.bold + "  Main Menu\n" + C.reset);
    out.push(C.gray + "  " + "─".repeat(w - 4) + C.reset + "\n\n");

    MAIN_MENU.forEach((item, i) => {
      const selected = i === st.menuIdx;
      const arrow = selected ? C.bCyan + "  ▶ " + C.reset : "    ";
      const text = selected
        ? C.bold + C.bWhite + item.label + C.reset
        : C.white + item.label + C.reset;
      out.push(arrow + text + "\n");
    });

    out.push("\n");
    out.push(C.gray + "  ↑↓ navigate · Enter select · Q quit" + C.reset + "\n");

  } else if (st.view === "config") {
    out.push(C.bold + "  Current Configuration\n" + C.reset);
    out.push(C.gray + "  " + "─".repeat(w - 4) + C.reset + "\n\n");

    const cn = st.cfg.connection;
    const rows: [string, string][] = [
      ["Username",       cn.username || "(not set)"],
      ["SMTP",           `${cn.smtpHost}:${cn.smtpPort}`],
      ["IMAP",           `${cn.imapHost}:${cn.imapPort}`],
      ["Bridge cert",    cn.bridgeCertPath || "(none)"],
      ["SMTP token",     cn.smtpToken ? "••••••••" : "(none)"],
      ["Debug",          cn.debug ? "enabled" : "off"],
      ["Preset",         st.cfg.permissions.preset],
    ];

    // Enabled tools per category
    out.push(C.gray + "  " + "─".repeat(w - 4) + C.reset + "\n");
    for (const [k, v] of rows) {
      out.push(`  ${C.gray}${pad(k, 14)}${C.reset}${C.bWhite}${v}${C.reset}\n`);
    }

    out.push("\n");
    out.push(C.bold + "  Tool permissions\n" + C.reset);
    for (const [catKey, cat] of Object.entries(TOOL_CATEGORIES)) {
      const tools = cat.tools as readonly string[];
      const perms = st.cfg.permissions.tools;
      const allEnabled = tools.every(t => perms[t as keyof typeof perms]?.enabled !== false);
      const someEnabled = tools.some(t => perms[t as keyof typeof perms]?.enabled !== false);
      const icon = allEnabled ? c("bGreen", "●") : someEnabled ? c("yellow", "◐") : c("red", "○");
      out.push(`  ${icon} ${C.white}${cat.label}${C.reset}` +
        `${C.gray} (${tools.length} tools)${C.reset}\n`);
    }

    out.push("\n");
    out.push(C.gray + "  Press Escape or B to go back\n" + C.reset);

  } else if (st.view === "preset") {
    out.push(C.bold + "  Set Permission Preset\n" + C.reset);
    out.push(C.gray + "  " + "─".repeat(w - 4) + C.reset + "\n\n");

    PRESETS.forEach((p, i) => {
      const selected = i === st.presetIdx;
      const isCurrent = p.id === st.cfg.permissions.preset;
      const arrow = selected ? C.bCyan + "  ▶ " : "    ";
      const name = selected
        ? C.bold + C.bWhite + p.label
        : C.white + p.label;
      const curr = isCurrent ? C.bGreen + " ✓ current" + C.reset : "";
      out.push(arrow + name + C.reset + curr + "\n");
      out.push(`    ${C.gray}${p.desc}${C.reset}\n\n`);
    });

    out.push(C.gray + "  ↑↓ navigate · Enter apply · Escape back\n" + C.reset);

  } else if (st.view === "escalation") {
    const pending = getPendingEscalations();
    out.push(C.bold + "  Escalation Requests\n" + C.reset);
    out.push(C.gray + "  " + "─".repeat(w - 4) + C.reset + "\n\n");

    if (pending.length === 0) {
      out.push(C.gray + "  No pending escalation requests.\n" + C.reset);
      const audit = getAuditLog(5);
      if (audit.length > 0) {
        out.push("\n" + C.bold + "  Recent audit events:\n" + C.reset);
        for (const e of audit) {
          const col = e.event === "approved" ? C.bGreen : e.event === "denied" ? C.bRed : C.gray;
          out.push(`  ${col}${e.event.padEnd(10)}${C.reset}${C.gray} ${e.fromPreset} → ${e.toPreset}${C.reset}\n`);
        }
      }
    } else {
      for (const e of pending) {
        out.push(renderEscalationRecord(e, true));
      }
      out.push(C.bold + "  T — approve request · D — deny request\n" + C.reset);
    }
    out.push("\n" + C.gray + "  Escape to go back\n" + C.reset);

  } else if (st.view === "test") {
    out.push(C.bold + "  Test Connectivity\n" + C.reset);
    out.push(C.gray + "  " + "─".repeat(w - 4) + C.reset + "\n\n");

    const cn = st.cfg.connection;
    out.push(`  SMTP  ${cn.smtpHost}:${cn.smtpPort}  `);
    if (st.testResults === null) {
      out.push(C.gray + "— press T to test" + C.reset);
    } else if (st.testResults.smtp === null) {
      out.push(C.yellow + "checking…" + C.reset);
    } else {
      out.push(st.testResults.smtp ? c("bGreen", "✅ reachable") : c("bRed", "❌ unreachable"));
    }
    out.push("\n");

    out.push(`  IMAP  ${cn.imapHost}:${cn.imapPort}  `);
    if (st.testResults === null) {
      out.push(C.gray + "— press T to test" + C.reset);
    } else if (st.testResults.imap === null) {
      out.push(C.yellow + "checking…" + C.reset);
    } else {
      out.push(st.testResults.imap ? c("bGreen", "✅ reachable") : c("bRed", "❌ unreachable"));
    }
    out.push("\n\n");

    if (st.testResults && !st.testResults.smtp && !st.testResults.imap) {
      out.push(c("yellow", "  ⚠  Make sure Proton Bridge is running and signed in.\n"));
      out.push(C.gray + "     Download: https://proton.me/mail/bridge\n" + C.reset);
    }

    out.push(C.gray + "  T — run test · Escape back\n" + C.reset);

  } else if (st.view === "server") {
    const url = `http://localhost:${st.serverPort}`;
    out.push(C.bold + "  Browser UI\n" + C.reset);
    out.push(C.gray + "  " + "─".repeat(w - 4) + C.reset + "\n\n");

    if (st.serverStarted) {
      out.push(c("bGreen", "  ✅ Server running: ") + C.bold + C.bCyan + url + C.reset + "\n\n");
      out.push(C.white + "  Open the URL above in your browser to access\n");
      out.push("  the full settings UI. Press Escape to return here.\n" + C.reset);
    } else {
      out.push(C.gray + "  Press S to start the browser UI server.\n" + C.reset);
    }

    out.push("\n" + C.gray + "  S — start server · Escape back\n" + C.reset);
  }

  out.push("\n");
  process.stdout.write(out.join(""));
}

export async function runAnsiTUI(serverPort: number, startServerFn: (port: number) => void): Promise<void> {
  const st: AnsiState = {
    view: "main",
    menuIdx: 0,
    presetIdx: 0,
    testResults: null,
    serverPort,
    serverStarted: false,
    cfg: loadOrDefault(),
    dirty: true,
  };

  // Find current preset index
  const curPresetIdx = PRESETS.findIndex(p => p.id === st.cfg.permissions.preset);
  if (curPresetIdx >= 0) st.presetIdx = curPresetIdx;

  function redraw() { ansiDraw(st); }

  // Put stdin in raw mode so we get key-by-key input
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  // Cleanup on exit
  function cleanup() {
    process.stdin.setRawMode(false);
    process.stdout.write(C.showCur + C.reset + "\n");
  }
  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(0); });
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });

  redraw();

  process.stdin.on("data", async (key: string) => {
    const UP    = "\x1b[A";
    const DOWN  = "\x1b[B";
    const ENTER = "\r";
    const ESC   = "\x1b";
    const CTRL_C = "\x03";

    if (key === CTRL_C) { cleanup(); process.exit(0); }

    if (st.view === "main") {
      if (key === UP)    { st.menuIdx = (st.menuIdx - 1 + MAIN_MENU.length) % MAIN_MENU.length; redraw(); return; }
      if (key === DOWN)  { st.menuIdx = (st.menuIdx + 1) % MAIN_MENU.length; redraw(); return; }
      if (key === "q" || key === "Q") { cleanup(); process.exit(0); }

      if (key === ENTER) {
        const action = MAIN_MENU[st.menuIdx].key as MainKey;

        if (action === "quit") { cleanup(); process.exit(0); }

        if (action === "config") {
          st.cfg = loadOrDefault();
          st.view = "config";
          redraw();
          return;
        }

        if (action === "preset") {
          st.cfg = loadOrDefault();
          const ci = PRESETS.findIndex(p => p.id === st.cfg.permissions.preset);
          if (ci >= 0) st.presetIdx = ci;
          st.view = "preset";
          redraw();
          return;
        }

        if (action === "escalation") {
          st.view = "escalation";
          redraw();
          return;
        }

        if (action === "test") {
          st.testResults = null;
          st.view = "test";
          redraw();
          return;
        }

        if (action === "server") {
          st.view = "server";
          redraw();
          return;
        }

        if (action === "reset") {
          // Temporarily exit raw mode for confirmation
          process.stdin.setRawMode(false);
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          rl.question(
            C.yellow + "\n  Reset config to defaults? All settings will be lost. (y/N): " + C.reset,
            (ans) => {
              rl.close();
              process.stdin.setRawMode(true);
              if (ans.trim().toLowerCase() === "y") {
                saveConfig(defaultConfig());
                st.cfg = loadOrDefault();
              }
              st.view = "main";
              redraw();
            }
          );
          return;
        }

        if (action === "edit") {
          // Edit connection via readline prompts (exit raw, gather fields, re-enter raw)
          process.stdin.setRawMode(false);
          process.stdout.write(C.clrScr);
          process.stdout.write(C.bold + "\n  Edit Connection Settings\n" + C.reset);
          process.stdout.write(C.gray + "  Leave blank to keep current value. Ctrl+C to cancel.\n\n" + C.reset);

          const cfg = loadOrDefault();
          const cn = cfg.connection;

          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          const ask = (q: string): Promise<string> =>
            new Promise(res => rl.question(C.gray + "  " + q + C.reset, res));

          try {
            const username = await ask(`Username [${cn.username || ""}]: `);
            const password = await mutedQuestion(rl, C.gray + "  Bridge password (leave blank to keep): " + C.reset);
            const smtpHost = await ask(`SMTP host [${cn.smtpHost}]: `);
            const smtpPort = await ask(`SMTP port [${cn.smtpPort}]: `);
            const imapHost = await ask(`IMAP host [${cn.imapHost}]: `);
            const imapPort = await ask(`IMAP port [${cn.imapPort}]: `);
            const bridgeCert = await ask(`Bridge cert path [${cn.bridgeCertPath || "none"}]: `);

            if (username.trim())  cn.username      = username.trim();
            if (password.trim())  cn.password      = password.trim();
            if (smtpHost.trim())  cn.smtpHost      = smtpHost.trim();
            if (smtpPort.trim()) {
              const p = parseInt(smtpPort, 10);
              if (!isNaN(p) && p > 0 && p <= 65535) cn.smtpPort = p;
            }
            if (imapHost.trim())  cn.imapHost      = imapHost.trim();
            if (imapPort.trim()) {
              const p = parseInt(imapPort, 10);
              if (!isNaN(p) && p > 0 && p <= 65535) cn.imapPort = p;
            }
            if (bridgeCert.trim() !== cn.bridgeCertPath) {
              cn.bridgeCertPath = bridgeCert.trim();
            }

            cfg.connection = cn;
            saveConfig(cfg);
            st.cfg = cfg;
            process.stdout.write(c("bGreen", "\n  ✅ Connection settings saved.\n"));
          } catch {
            process.stdout.write(c("yellow", "\n  Cancelled.\n"));
          } finally {
            rl.close();
          }

          await new Promise(r => setTimeout(r, 800));
          process.stdin.setRawMode(true);
          st.view = "main";
          redraw();
          return;
        }
      }
    } else if (st.view === "config") {
      if (key === ESC || key === "b" || key === "B" || key === ENTER) {
        st.view = "main";
        redraw();
      }

    } else if (st.view === "preset") {
      if (key === UP)   { st.presetIdx = (st.presetIdx - 1 + PRESETS.length) % PRESETS.length; redraw(); return; }
      if (key === DOWN) { st.presetIdx = (st.presetIdx + 1) % PRESETS.length; redraw(); return; }
      if (key === ESC)  { st.view = "main"; redraw(); return; }
      if (key === ENTER) {
        const preset = PRESETS[st.presetIdx].id;
        const cfg = loadOrDefault();
        cfg.permissions = buildPermissions(preset);
        saveConfig(cfg);
        st.cfg = cfg;
        st.view = "main";
        redraw();
      }

    } else if (st.view === "escalation") {
      if (key === ESC) { st.view = "main"; redraw(); return; }
      const pending = getPendingEscalations();
      if (pending.length > 0) {
        const e = pending[0];
        if (key === "t" || key === "T") {
          // Approve — exit raw mode to get typed confirmation
          process.stdin.setRawMode(false);
          const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
          rl2.question(
            C.yellow + "\n  Type APPROVE to confirm escalation (anything else cancels): " + C.reset,
            (ans) => {
              rl2.close();
              process.stdin.setRawMode(true);
              if (ans.trim() === "APPROVE") {
                const result = approveEscalation(e.id, "terminal_tui");
                if (result.ok) {
                  const cfg = loadConfig() ?? defaultConfig();
                  cfg.permissions = buildPermissions(result.targetPreset);
                  saveConfig(cfg);
                  st.cfg = cfg;
                  process.stdout.write(C.bGreen + "\n  ✅ Approved. New preset: " + result.targetPreset + "\n" + C.reset);
                } else {
                  process.stdout.write(C.bRed + "\n  Error: " + result.error + "\n" + C.reset);
                }
              } else {
                process.stdout.write(C.gray + "\n  Cancelled.\n" + C.reset);
              }
              setTimeout(() => { st.view = "main"; redraw(); }, 900);
            }
          );
          return;
        }
        if (key === "d" || key === "D") {
          denyEscalation(e.id, "terminal_tui");
          process.stdout.write(C.bRed + "\n  Escalation denied.\n" + C.reset);
          setTimeout(() => { st.view = "main"; redraw(); }, 700);
          return;
        }
      }

    } else if (st.view === "test") {
      if (key === ESC) { st.view = "main"; redraw(); return; }
      if (key === "t" || key === "T") {
        st.testResults = { smtp: null, imap: null };
        redraw();
        const cn = st.cfg.connection;
        const [smtp, imap] = await Promise.all([
          tcpCheck(cn.smtpHost, cn.smtpPort),
          tcpCheck(cn.imapHost, cn.imapPort),
        ]);
        st.testResults = { smtp, imap };
        redraw();
      }

    } else if (st.view === "server") {
      if (key === ESC) { st.view = "main"; redraw(); return; }
      if ((key === "s" || key === "S") && !st.serverStarted) {
        st.serverStarted = true;
        startServerFn(st.serverPort);
        redraw();
      }
    }
  });

  // Keep process alive
  await new Promise<void>(() => {});
}

// ─── Plain (no-ANSI) Interactive TUI ──────────────────────────────────────────

export async function runPlainTUI(serverPort: number, startServerFn: (port: number) => void): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> => new Promise(res => rl.question(q, res));

  function hr() { process.stdout.write("─".repeat(48) + "\n"); }

  function printHeader() {
    process.stdout.write("\npm-bridge-mcp — Settings\n");
    hr();
    const cfg = loadConfig();
    const path = getConfigPath();
    if (cfg) {
      process.stdout.write(`Config : ${path}\n`);
      process.stdout.write(`User   : ${cfg.connection.username || "(not set)"}\n`);
      process.stdout.write(`Preset : ${cfg.permissions.preset}\n`);
    } else {
      process.stdout.write(`Config : ${path} (not found — defaults apply)\n`);
    }
    hr();
  }

  async function mainMenu(): Promise<boolean> {
    printHeader();
    // Show pending escalation alert
    const pendingEsc = getPendingEscalations();
    if (pendingEsc.length > 0) {
      process.stdout.write("\n  *** PENDING ESCALATION REQUEST — AI agent is requesting more access ***\n");
      process.stdout.write("  Option 4 to review and approve/deny.\n");
    }
    process.stdout.write("  1. View current configuration\n");
    process.stdout.write("  2. Edit connection settings\n");
    process.stdout.write("  3. Set permission preset\n");
    process.stdout.write(`  4. Manage escalation requests${pendingEsc.length ? ` [${pendingEsc.length} PENDING]` : ""}\n`);
    process.stdout.write("  5. Test connectivity\n");
    process.stdout.write("  6. Start browser UI\n");
    process.stdout.write("  7. Reset to defaults\n");
    process.stdout.write("  0. Quit\n");
    hr();

    const choice = (await ask("Choice: ")).trim();

    switch (choice) {
      case "1": await viewConfig(); break;
      case "2": await editConnection(); break;
      case "3": await setPreset(); break;
      case "4": await manageEscalations(); break;
      case "5": await testConnectivity(); break;
      case "6": await startBrowserUI(); break;
      case "7": await resetDefaults(); break;
      case "0": return false;
      default:  process.stdout.write("Unknown option.\n"); break;
    }
    return true;
  }

  async function viewConfig(): Promise<void> {
    const cfg = loadOrDefault();
    const cn = cfg.connection;
    process.stdout.write("\n── Configuration ──\n");
    process.stdout.write(`Username    : ${cn.username || "(not set)"}\n`);
    process.stdout.write(`SMTP        : ${cn.smtpHost}:${cn.smtpPort}\n`);
    process.stdout.write(`IMAP        : ${cn.imapHost}:${cn.imapPort}\n`);
    process.stdout.write(`Bridge cert : ${cn.bridgeCertPath || "(none)"}\n`);
    process.stdout.write(`SMTP token  : ${cn.smtpToken ? "set" : "(none)"}\n`);
    process.stdout.write(`Debug       : ${cn.debug ? "yes" : "no"}\n`);
    process.stdout.write(`Preset      : ${cfg.permissions.preset}\n`);
    process.stdout.write("\n── Tool permissions ──\n");
    for (const [, cat] of Object.entries(TOOL_CATEGORIES)) {
      const perms = cfg.permissions.tools;
      const enabled = cat.tools.filter(t => perms[t as keyof typeof perms]?.enabled !== false).length;
      process.stdout.write(`${cat.label.padEnd(20)}: ${enabled}/${cat.tools.length} tools enabled\n`);
    }
    await ask("\nPress Enter to continue...");
  }

  async function editConnection(): Promise<void> {
    const cfg = loadOrDefault();
    const cn = cfg.connection;
    process.stdout.write("\n── Edit Connection (blank = keep current) ──\n");
    const username   = await ask(`Username [${cn.username || ""}]: `);
    const password   = await mutedQuestion(rl, `Bridge password (blank to keep): `);
    const smtpHost   = await ask(`SMTP host [${cn.smtpHost}]: `);
    const smtpPort   = await ask(`SMTP port [${cn.smtpPort}]: `);
    const imapHost   = await ask(`IMAP host [${cn.imapHost}]: `);
    const imapPort   = await ask(`IMAP port [${cn.imapPort}]: `);
    const cert       = await ask(`Bridge cert path [${cn.bridgeCertPath || "none"}]: `);

    if (username.trim())  cn.username       = username.trim();
    if (password.trim())  cn.password       = password.trim();
    if (smtpHost.trim())  cn.smtpHost       = smtpHost.trim();
    if (smtpPort.trim()) {
      const p = parseInt(smtpPort, 10);
      if (!isNaN(p) && p > 0 && p <= 65535) cn.smtpPort = p;
    }
    if (imapHost.trim())  cn.imapHost       = imapHost.trim();
    if (imapPort.trim()) {
      const p = parseInt(imapPort, 10);
      if (!isNaN(p) && p > 0 && p <= 65535) cn.imapPort = p;
    }
    if (cert.trim())      cn.bridgeCertPath = cert.trim();

    cfg.connection = cn;
    saveConfig(cfg);
    process.stdout.write("Connection settings saved.\n");
  }

  async function setPreset(): Promise<void> {
    process.stdout.write("\n── Set Permission Preset ──\n");
    PRESETS.forEach((p, i) => {
      process.stdout.write(`  ${i + 1}. ${p.label.padEnd(14)} — ${p.desc}\n`);
    });
    const choice = (await ask("Choice (1-4, 0 to cancel): ")).trim();
    const idx = parseInt(choice, 10) - 1;
    if (idx >= 0 && idx < PRESETS.length) {
      const cfg = loadOrDefault();
      cfg.permissions = buildPermissions(PRESETS[idx].id);
      saveConfig(cfg);
      process.stdout.write(`Preset set to: ${PRESETS[idx].label}\n`);
    } else if (choice !== "0") {
      process.stdout.write("Invalid choice.\n");
    }
  }

  async function manageEscalations(): Promise<void> {
    const pending = getPendingEscalations();
    process.stdout.write("\n── Escalation Requests ──\n");

    if (pending.length === 0) {
      process.stdout.write("No pending escalation requests.\n");
      const audit = getAuditLog(5);
      if (audit.length > 0) {
        process.stdout.write("\nRecent audit log:\n");
        for (const e of audit) {
          process.stdout.write(`  ${e.time.slice(0,19)}  ${e.event.padEnd(10)}  ${e.fromPreset} → ${e.toPreset}\n`);
        }
      }
      await ask("\nPress Enter to continue...");
      return;
    }

    for (const e of pending) {
      process.stdout.write(renderEscalationRecord(e, false));
      process.stdout.write("  Actions: A = Approve · D = Deny · S = Skip\n");
      const action = (await ask("  Choice: ")).trim().toUpperCase();

      if (action === "A") {
        const confirm = (await ask("  Type APPROVE to confirm: ")).trim();
        if (confirm === "APPROVE") {
          const result = approveEscalation(e.id, "terminal_tui");
          if (result.ok) {
            const cfg = loadOrDefault();
            cfg.permissions = buildPermissions(result.targetPreset);
            saveConfig(cfg);
            process.stdout.write(`Approved. New preset: ${result.targetPreset}\n`);
          } else {
            process.stdout.write(`Error: ${result.error}\n`);
          }
        } else {
          process.stdout.write("Confirmation text did not match. Cancelled.\n");
        }
      } else if (action === "D") {
        denyEscalation(e.id, "terminal_tui");
        process.stdout.write("Escalation denied.\n");
      }
    }
    await ask("\nPress Enter to continue...");
  }

  async function testConnectivity(): Promise<void> {
    const cfg = loadOrDefault();
    const cn = cfg.connection;
    process.stdout.write(`\nTesting SMTP ${cn.smtpHost}:${cn.smtpPort}... `);
    const smtp = await tcpCheck(cn.smtpHost, cn.smtpPort);
    process.stdout.write(smtp ? "OK\n" : "UNREACHABLE\n");

    process.stdout.write(`Testing IMAP ${cn.imapHost}:${cn.imapPort}... `);
    const imap = await tcpCheck(cn.imapHost, cn.imapPort);
    process.stdout.write(imap ? "OK\n" : "UNREACHABLE\n");

    if (!smtp || !imap) {
      process.stdout.write("\nMake sure Proton Bridge is running and signed in.\n");
      process.stdout.write("Download: https://proton.me/mail/bridge\n");
    }
    await ask("\nPress Enter to continue...");
  }

  async function startBrowserUI(): Promise<void> {
    const url = `http://localhost:${serverPort}`;
    startServerFn(serverPort);
    process.stdout.write(`\nBrowser UI running at: ${url}\n`);
    process.stdout.write("Open the URL in your browser.\n");
    process.stdout.write("Press Ctrl+C to stop.\n");
    await new Promise<void>(() => {}); // wait forever (user Ctrl+C)
  }

  async function resetDefaults(): Promise<void> {
    const confirm = (await ask("Reset config to defaults? All settings will be lost. (y/N): ")).trim();
    if (confirm.toLowerCase() === "y") {
      saveConfig(defaultConfig());
      process.stdout.write("Config reset to defaults.\n");
    } else {
      process.stdout.write("Cancelled.\n");
    }
  }

  // Main loop
  let running = true;
  while (running) {
    running = await mainMenu();
  }

  rl.close();
  process.stdout.write("\nGoodbye.\n");
}
