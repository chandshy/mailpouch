/**
 * ProtonMail MCP Server — Settings UI Server
 *
 * Starts a localhost-only HTTP server that serves a browser-based
 * configuration interface.  The UI lets users:
 *   • Set up SMTP / IMAP connection credentials
 *   • Choose a permission preset or configure per-tool access
 *   • Set per-tool rate limits
 *   • Test connectivity
 *   • View server status and the generated Claude Desktop config snippet
 *
 * The config is persisted to ~/.protonmail-mcp.json (mode 0600).
 * The MCP server reads that file every 15 s, so changes take effect
 * without a restart.
 */

import http from "http";
import https from "https";
import { Socket } from "net";
import { randomBytes, timingSafeEqual } from "crypto";
import {
  RateLimiter,
  readBodySafe,
  isValidOrigin,
  isValidChallengeId,
  sanitizeText,
  clientIP,
  generateAccessToken,
  hasValidAccessToken,
  tryGenerateSelfSignedCert,
  getPrimaryLanIP,
  GENERAL_RATE_LIMIT,
  ESCALATION_RATE_LIMIT,
  type AccessToken,
  type TlsCredentials,
} from "./security.js";
import {
  loadConfig,
  saveConfig,
  saveConfigWithCredentials,
  getConfigPath,
  defaultConfig,
  buildPermissions,
  configExists,
} from "../config/loader.js";
import {
  ALL_TOOLS,
  TOOL_CATEGORIES,
  type ServerConfig,
  type PermissionPreset,
  type ToolName,
} from "../config/schema.js";
import {
  getPendingEscalations,
  approveEscalation,
  denyEscalation,
  getAuditLog,
  type EscalationRecord,
  type AuditEntry,
} from "../permissions/escalation.js";

// ─── TCP connectivity test ─────────────────────────────────────────────────────

function tcpCheck(host: string, port: number, timeoutMs = 5000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    socket.setTimeout(timeoutMs);
    socket.on("connect", () => { socket.destroy(); resolve(true); });
    socket.on("error", () => resolve(false));
    socket.on("timeout", () => { socket.destroy(); resolve(false); });
    socket.connect(port, host);
  });
}

// ─── REST API helpers ──────────────────────────────────────────────────────────

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type":           "application/json",
    "Content-Length":         Buffer.byteLength(payload),
    "Cache-Control":          "no-store, no-cache, must-revalidate",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options":        "DENY",
    "Referrer-Policy":        "no-referrer",
  });
  res.end(payload);
}

/** Strip password fields before sending config to the browser */
function safeConfig(cfg: ServerConfig): unknown {
  return {
    ...cfg,
    credentialStorage: cfg.credentialStorage ?? "config",
    connection: {
      ...cfg.connection,
      password: cfg.connection.password ? "••••••••" : "",
      smtpToken: cfg.connection.smtpToken ? "••••••••" : "",
    },
  };
}

// ─── Embedded HTML UI ─────────────────────────────────────────────────────────

function buildHtml(configPath: string, csrfToken: string): string {
  const toolsJson = JSON.stringify(ALL_TOOLS);
  const categoriesJson = JSON.stringify(TOOL_CATEGORIES);
  // configPath comes from process.env.PROTONMAIL_MCP_CONFIG and is injected
  // directly into two <code> elements via template-literal interpolation.
  // A path like `/home/u/<script>alert(1)</script>.json` (set by a malicious
  // env var or via path manipulation) would produce XSS in the settings page.
  // HTML-escape the path before insertion.
  const safeConfigPath = configPath
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

  return `<!DOCTYPE html>
<!-- NEW WIZARD UI -->
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="csrf-token" content="${csrfToken}">
<title>ProtonMail MCP — Settings</title>
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --bg:          #0f0e1a;
  --surface:     #1a1830;
  --surface2:    #22203a;
  --surface3:    #2a2845;
  --border:      #302e50;
  --border2:     #403d68;
  --primary:     #6d4aff;
  --primary-h:   #5535e0;
  --primary-bg:  #6d4aff18;
  --success:     #1cc47e;
  --success-bg:  #1cc47e18;
  --danger:      #e84646;
  --danger-bg:   #e8464618;
  --warn:        #f5a623;
  --warn-bg:     #f5a62318;
  --text:        #e8e6f8;
  --text2:       #c4c0e0;
  --muted:       #7c78a8;
  --radius:      14px;
  --radius-sm:   8px;
  --radius-xs:   5px;
  --shadow:      0 2px 8px rgba(0,0,0,.4);
  --shadow-md:   0 8px 24px rgba(0,0,0,.5);
  --shadow-lg:   0 16px 48px rgba(0,0,0,.6);
  --glow:        0 0 20px rgba(109,74,255,.25);
}

body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  background: var(--bg);
  color: var(--text);
  min-height: 100vh;
  font-size: 14px;
  line-height: 1.6;
}

/* ── Scrollbar ── */
::-webkit-scrollbar { width: 6px; }
::-webkit-scrollbar-track { background: var(--surface); }
::-webkit-scrollbar-thumb { background: var(--border2); border-radius: 3px; }

/* ── Animated background ── */
body::before {
  content: '';
  position: fixed; inset: 0; z-index: -1;
  background:
    radial-gradient(ellipse 80% 60% at 20% 10%, rgba(109,74,255,.12) 0%, transparent 70%),
    radial-gradient(ellipse 60% 40% at 80% 90%, rgba(28,196,126,.07) 0%, transparent 70%);
  pointer-events: none;
}

/* ── Header ── */
header {
  background: rgba(26,24,48,.9);
  border-bottom: 1px solid var(--border);
  padding: 0 28px;
  display: flex; align-items: center; gap: 14px;
  height: 58px;
  position: sticky; top: 0; z-index: 30;
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
}
.logo-wrap { display: flex; align-items: center; gap: 10px; }
.logo-icon {
  width: 34px; height: 34px; border-radius: 9px;
  background: linear-gradient(135deg, #6d4aff 0%, #9b6dff 100%);
  display: flex; align-items: center; justify-content: center;
  color: #fff; font-size: 18px; flex-shrink: 0;
  box-shadow: 0 2px 8px rgba(109,74,255,.4);
}
.header-title   { font-weight: 700; font-size: 15px; color: var(--text); }
.header-subtitle{ font-size: 11px; color: var(--muted); }
.header-spacer  { flex: 1; }
.status-pill {
  display: flex; align-items: center; gap: 6px;
  font-size: 12px; color: var(--muted);
  background: var(--surface2); border: 1px solid var(--border);
  padding: 5px 12px; border-radius: 20px;
}
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--muted); flex-shrink: 0; }
.dot.ok  { background: var(--success); box-shadow: 0 0 0 3px var(--success-bg); }
.dot.err { background: var(--danger);  box-shadow: 0 0 0 3px var(--danger-bg); }

/* Settings tab nav (post-setup view) */
nav {
  background: rgba(26,24,48,.85);
  border-bottom: 1px solid var(--border);
  display: flex; padding: 0 28px; gap: 2px;
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}
nav button {
  background: none; border: none; cursor: pointer;
  color: var(--muted); font-size: 13px; font-weight: 500;
  padding: 14px 16px;
  border-bottom: 2px solid transparent;
  transition: color .15s, border-color .15s;
}
nav button:hover { color: var(--text2); }
nav button.active { border-bottom-color: var(--primary); color: var(--primary); }

main { max-width: 900px; margin: 0 auto; padding: 32px 24px 100px; }
section { display: none; }
section.active { display: block; }

/* ── Card ── */
.card {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 24px; margin-bottom: 16px;
  box-shadow: var(--shadow);
}
.card-title { font-weight: 700; font-size: 15px; color: var(--text); margin-bottom: 4px; }
.card-desc  { color: var(--muted); font-size: 13px; margin-bottom: 18px; line-height: 1.6; }

.section-heading    { font-size: 20px; font-weight: 700; color: var(--text); margin-bottom: 4px; }
.section-subheading { font-size: 14px; color: var(--muted); margin-bottom: 28px; }

fieldset { border: none; }
legend {
  font-size: 11px; font-weight: 700; color: var(--muted);
  text-transform: uppercase; letter-spacing: .07em; margin-bottom: 14px;
}

/* ── Form fields ── */
.field { margin-bottom: 18px; }
.field label:not(.toggle-wrap) {
  display: block; font-size: 13px; font-weight: 600;
  color: var(--text2); margin-bottom: 6px;
}
.field input[type=text],
.field input[type=email],
.field input[type=password],
.field input[type=number] {
  width: 100%; padding: 10px 14px;
  background: var(--surface2); border: 1.5px solid var(--border);
  border-radius: var(--radius-sm); color: var(--text); font-size: 14px;
  outline: none; transition: border-color .15s, box-shadow .15s;
}
.field input:focus {
  border-color: var(--primary);
  box-shadow: 0 0 0 3px rgba(109,74,255,.2);
}
.field input.invalid { border-color: var(--danger); }
.field .hint    { font-size: 12px; color: var(--muted); margin-top: 5px; line-height: 1.5; }
.field .err-msg { font-size: 12px; color: var(--danger); margin-top: 5px; display: none; }
.field.has-error .err-msg   { display: block; }
.field.has-error input      { border-color: var(--danger); }

/* show/hide password wrapper */
.pw-wrap { position: relative; }
.pw-wrap input { padding-right: 42px; }
.pw-toggle {
  position: absolute; right: 11px; top: 50%; transform: translateY(-50%);
  background: none; border: none; cursor: pointer; color: var(--muted);
  padding: 3px; display: flex; align-items: center; font-size: 15px;
  transition: color .15s;
}
.pw-toggle:hover { color: var(--text2); }

.row-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.row-3 { display: grid; grid-template-columns: 2fr 1fr 1fr; gap: 16px; }

/* ── Buttons ── */
button.btn {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 10px 20px; border-radius: var(--radius-sm); border: none;
  font-size: 14px; font-weight: 600; cursor: pointer;
  transition: background .15s, transform .1s, box-shadow .15s;
  line-height: 1; white-space: nowrap;
}
button.btn:active:not(:disabled) { transform: scale(.97); }
button.btn:disabled { opacity: .4; cursor: not-allowed; }
.btn-primary {
  background: var(--primary); color: #fff;
  box-shadow: 0 2px 8px rgba(109,74,255,.35);
}
.btn-primary:hover:not(:disabled) {
  background: var(--primary-h);
  box-shadow: 0 4px 16px rgba(109,74,255,.5);
}
.btn-ghost {
  background: var(--surface2); color: var(--text2);
  border: 1.5px solid var(--border);
}
.btn-ghost:hover:not(:disabled) { background: var(--surface3); border-color: var(--border2); }
.btn-danger { background: var(--danger); color: #fff; }
.btn-danger:hover:not(:disabled) { background: #c53030; }
.btn-success { background: var(--success); color: #000; }
.btn-sm { padding: 7px 14px; font-size: 13px; }

.actions { display: flex; gap: 10px; margin-top: 24px; flex-wrap: wrap; align-items: center; }

/* ── Toggle switch ── */
.toggle-wrap { display: flex; align-items: center; gap: 10px; cursor: pointer; user-select: none; }
.toggle { position: relative; width: 40px; height: 22px; flex-shrink: 0; }
.toggle input { opacity: 0; width: 0; height: 0; position: absolute; }
.slider {
  position: absolute; inset: 0;
  background: var(--border2); border-radius: 11px; transition: background .2s;
}
.slider::before {
  content: ""; position: absolute;
  width: 16px; height: 16px; left: 3px; top: 3px;
  background: #fff; border-radius: 50%;
  transition: transform .2s; box-shadow: 0 1px 3px rgba(0,0,0,.3);
}
.toggle input:checked + .slider { background: var(--primary); }
.toggle input:checked + .slider::before { transform: translateX(18px); }
.toggle input:focus-visible + .slider { outline: 2px solid var(--primary); outline-offset: 2px; }

/* ── Category accordion (Permissions tab) ── */
.category {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); margin-bottom: 10px; overflow: hidden;
}
.category-header {
  display: flex; align-items: center; gap: 12px;
  padding: 14px 16px; cursor: pointer; transition: background .1s;
}
.category-header:hover { background: var(--surface2); }
.category-header .caret { color: var(--muted); font-size: 12px; transition: transform .2s; }
.category-header.open .caret { transform: rotate(90deg); }
.category-info { flex: 1; }
.category-info .name { font-weight: 600; font-size: 14px; }
.category-info .desc { font-size: 12px; color: var(--muted); }
.risk-badge {
  font-size: 11px; font-weight: 600; padding: 2px 8px;
  border-radius: 10px; text-transform: uppercase; letter-spacing: .04em;
}
.risk-safe        { background: #1cc47e22; color: var(--success); }
.risk-moderate    { background: #f5a62322; color: var(--warn); }
.risk-destructive { background: #e8464622; color: var(--danger); }
.category-body { display: none; border-top: 1px solid var(--border); }
.category-body.open { display: block; }
.tool-row {
  display: flex; align-items: center; gap: 12px;
  padding: 10px 16px; border-bottom: 1px solid var(--border);
  transition: background .1s;
}
.tool-row:last-child { border-bottom: none; }
.tool-row:hover { background: var(--surface2); }
.tool-name { font-family: monospace; font-size: 13px; flex: 1; color: var(--text2); }
.rate-wrap { display: flex; align-items: center; gap: 6px; }
.rate-wrap label { font-size: 12px; color: var(--muted); white-space: nowrap; }
.rate-input {
  width: 72px; padding: 4px 8px;
  background: var(--surface2); border: 1px solid var(--border);
  border-radius: 4px; color: var(--text); font-size: 13px;
  text-align: center; outline: none;
}
.rate-input:focus { border-color: var(--primary); }
.rate-input:disabled { opacity: .35; }

/* ── Toast ── */
#toast {
  position: fixed; bottom: 24px; right: 24px;
  background: var(--surface2); border: 1px solid var(--border);
  padding: 12px 18px; border-radius: var(--radius);
  font-size: 14px; max-width: 360px;
  opacity: 0; transform: translateY(12px);
  transition: opacity .25s, transform .25s;
  z-index: 200; pointer-events: none;
  box-shadow: var(--shadow-md);
}
#toast.show { opacity: 1; transform: translateY(0); }
#toast.ok   { border-color: var(--success); color: var(--success); }
#toast.err  { border-color: var(--danger);  color: var(--danger); }

/* ── Code block ── */
.code-block {
  background: #06060f; border: 1px solid var(--border);
  border-radius: var(--radius-sm); padding: 14px 16px;
  font-family: monospace; font-size: 12px; line-height: 1.7;
  overflow-x: auto; white-space: pre; color: #b8c4e0;
}
.copy-row { display: flex; justify-content: flex-end; margin-top: 8px; }

/* ── Info table ── */
.info-table { width: 100%; border-collapse: collapse; }
.info-table td { padding: 8px 0; border-bottom: 1px solid var(--border); font-size: 13px; }
.info-table td:first-child { color: var(--muted); width: 180px; }
.info-table tr:last-child td { border-bottom: none; }
.info-table code {
  background: var(--surface2); padding: 2px 6px; border-radius: 4px;
  font-family: monospace; font-size: 12px;
}

/* ── Alert boxes ── */
.alert {
  padding: 12px 16px; border-radius: var(--radius-sm); font-size: 13px;
  margin-bottom: 14px; display: flex; gap: 10px; align-items: flex-start;
}
.alert-warn { background: var(--warn-bg);    border: 1px solid #f5a62340; color: var(--warn); }
.alert-info { background: var(--primary-bg); border: 1px solid #6d4aff40; color: #a080ff; }

/* ── Spinner ── */
.spinner {
  display: inline-block; width: 14px; height: 14px;
  border: 2px solid rgba(255,255,255,.25); border-top-color: #fff;
  border-radius: 50%; animation: spin .7s linear infinite; flex-shrink: 0;
}
.spinner-dark {
  display: inline-block; width: 14px; height: 14px;
  border: 2px solid rgba(109,74,255,.25); border-top-color: var(--primary);
  border-radius: 50%; animation: spin .7s linear infinite; flex-shrink: 0;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* ── Preset buttons (Permissions tab) ── */
.presets { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 20px; }
.preset-btn {
  padding: 7px 14px; border-radius: var(--radius-sm); border: 1.5px solid var(--border);
  background: var(--surface2); color: var(--text2);
  font-size: 13px; font-weight: 500; cursor: pointer; transition: all .15s;
}
.preset-btn:hover { border-color: var(--primary); color: var(--primary); background: var(--primary-bg); }
.preset-btn.active { background: var(--primary); border-color: var(--primary); color: #fff; }

/* ── Escalation cards ── */
#escalation-banner {
  background: #1e0c0c; border: 2px solid var(--danger);
  border-radius: var(--radius); padding: 0; margin-bottom: 16px; display: none;
}
.escalation-banner-title {
  background: var(--danger); color: #fff; font-weight: 700;
  padding: 10px 16px; font-size: 14px;
  display: flex; align-items: center; gap: 8px;
}
.escalation-card-body { padding: 16px 20px; }
.escalation-meta { font-size: 12px; color: var(--muted); margin-bottom: 14px; }
.escalation-field { margin-bottom: 12px; }
.escalation-field label {
  display: block; font-size: 12px; font-weight: 600;
  color: var(--muted); text-transform: uppercase; letter-spacing: .04em; margin-bottom: 4px;
}
.escalation-reason {
  background: var(--surface2); border: 1px solid var(--border);
  border-radius: var(--radius-xs); padding: 10px 14px;
  font-size: 13px; font-style: italic; color: var(--text);
}
.escalation-preset-row { display: flex; align-items: center; gap: 12px; font-size: 13px; }
.preset-badge {
  padding: 2px 10px; border-radius: 20px; font-size: 12px; font-weight: 600;
}
.preset-badge.safe     { background: #1cc47e22; color: var(--success); border: 1px solid #1cc47e44; }
.preset-badge.moderate { background: #f5a62322; color: var(--warn);    border: 1px solid #f5a62344; }
.preset-badge.high     { background: #e8464622; color: var(--danger);  border: 1px solid #e8464644; }
.tool-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.tool-chip-new {
  background: #6d4aff22; border: 1px solid #6d4aff55;
  border-radius: 4px; padding: 2px 8px; font-size: 11px;
  font-family: monospace; color: #a090ff;
}
.escalation-confirm-wrap { margin-top: 14px; }
.escalation-confirm-wrap label {
  display: block; font-size: 12px; font-weight: 600;
  color: var(--warn); text-transform: uppercase; letter-spacing: .04em; margin-bottom: 6px;
}
.escalation-confirm-input {
  width: 100%; max-width: 280px;
  padding: 8px 12px; border-radius: var(--radius-xs);
  background: var(--surface2); border: 1px solid var(--warn);
  color: var(--text); font-size: 14px; font-weight: 600; letter-spacing: .08em; outline: none;
}
.escalation-confirm-input:focus { border-color: var(--danger); }
.escalation-actions { display: flex; gap: 10px; margin-top: 14px; }
.btn-deny    { background: #e8464622; border: 1px solid var(--danger); color: var(--danger); }
.btn-deny:hover    { background: var(--danger); color: #fff; }
.btn-approve { background: #1cc47e22; border: 1px solid var(--success); color: var(--success); }
.btn-approve:not(:disabled):hover { background: var(--success); color: #000; }
.btn-approve:disabled { opacity: .35; cursor: not-allowed; }
.escalation-countdown { font-size: 12px; color: var(--muted); align-self: center; margin-left: auto; }
.escalation-countdown.urgent { color: var(--danger); font-weight: 600; }

/* ── Audit log ── */
.audit-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.audit-table th {
  text-align: left; padding: 6px 10px; color: var(--muted);
  border-bottom: 1px solid var(--border); font-weight: 600;
  text-transform: uppercase; letter-spacing: .04em;
}
.audit-table td { padding: 6px 10px; border-bottom: 1px solid rgba(48,46,80,.5); }
.audit-table tr:last-child td { border-bottom: none; }
.audit-event-approved { color: var(--success); font-weight: 600; }
.audit-event-denied   { color: var(--danger);  font-weight: 600; }
.audit-event-expired  { color: var(--muted); }
.audit-event-requested{ color: var(--warn); }

/* ═══════════════════════════════════════════════════════
   WIZARD STYLES
   ═══════════════════════════════════════════════════════ */

/* Wizard takes over the full viewport */
#wizard-view {
  min-height: calc(100vh - 58px);
  display: flex; align-items: flex-start; justify-content: center;
  padding: 40px 20px 80px;
}

.wiz-shell {
  width: 100%; max-width: 680px;
}

/* ── Progress bar ── */
.wiz-progress {
  display: flex; align-items: center; gap: 0;
  margin-bottom: 36px; position: relative;
}
.wiz-progress::before {
  content: '';
  position: absolute; top: 17px; left: 0; right: 0; height: 2px;
  background: var(--border); z-index: 0;
}
.wiz-progress-fill {
  position: absolute; top: 17px; left: 0; height: 2px;
  background: var(--primary); z-index: 1;
  transition: width .4s ease;
}
.wiz-step-node {
  display: flex; flex-direction: column; align-items: center; gap: 6px;
  flex: 1; position: relative; z-index: 2; cursor: default;
}
.wiz-step-circle {
  width: 34px; height: 34px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 13px; font-weight: 700;
  border: 2px solid var(--border);
  background: var(--surface2); color: var(--muted);
  transition: all .3s ease;
}
.wiz-step-node.done   .wiz-step-circle { background: var(--success); border-color: var(--success); color: #000; }
.wiz-step-node.active .wiz-step-circle {
  background: var(--primary); border-color: var(--primary); color: #fff;
  box-shadow: 0 0 0 4px rgba(109,74,255,.25);
}
.wiz-step-label {
  font-size: 11px; font-weight: 500; color: var(--muted);
  white-space: nowrap; transition: color .3s;
}
.wiz-step-node.active .wiz-step-label { color: var(--primary); font-weight: 700; }
.wiz-step-node.done   .wiz-step-label { color: var(--success); }

/* ── Wizard card ── */
.wiz-card {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 36px 40px 32px;
  box-shadow: var(--shadow-lg);
  position: relative; overflow: hidden;
}
.wiz-card::before {
  content: '';
  position: absolute; top: 0; left: 0; right: 0; height: 3px;
  background: linear-gradient(90deg, #6d4aff, #9b6dff, #1cc47e);
}

/* ── Step transitions ── */
.wiz-panel { display: none; animation: panelIn .3s ease; }
.wiz-panel.active { display: block; }
@keyframes panelIn {
  from { opacity: 0; transform: translateX(24px); }
  to   { opacity: 1; transform: translateX(0); }
}

.wiz-title    { font-size: 24px; font-weight: 800; color: var(--text); margin-bottom: 6px; }
.wiz-subtitle { color: var(--muted); font-size: 14px; margin-bottom: 28px; line-height: 1.7; }

/* ── Welcome step ── */
.wiz-feature-grid {
  display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 24px;
}
.wiz-feature-card {
  background: var(--surface2); border: 1px solid var(--border);
  border-radius: var(--radius-sm); padding: 14px 16px;
  display: flex; align-items: flex-start; gap: 10px;
}
.wiz-feature-icon { font-size: 20px; flex-shrink: 0; margin-top: 1px; }
.wiz-feature-title { font-weight: 600; font-size: 13px; color: var(--text); }
.wiz-feature-desc  { font-size: 12px; color: var(--muted); margin-top: 2px; line-height: 1.5; }

.wiz-prereqs { margin-bottom: 24px; }
.wiz-prereqs-title {
  font-size: 11px; font-weight: 700; text-transform: uppercase;
  letter-spacing: .08em; color: var(--muted); margin-bottom: 10px;
}
.wiz-prereq {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 14px; border-radius: var(--radius-sm);
  background: var(--surface2); border: 1px solid var(--border);
  margin-bottom: 8px; font-size: 13px;
}
.wiz-prereq-icon { font-size: 16px; flex-shrink: 0; }
.wiz-prereq-name { font-weight: 600; color: var(--text); }
.wiz-prereq-desc { font-size: 12px; color: var(--muted); }

/* ── Bridge step ── */
.conn-test-grid {
  display: grid; gap: 10px; margin-bottom: 20px;
}
.conn-row {
  background: var(--surface2); border: 1.5px solid var(--border);
  border-radius: var(--radius-sm); padding: 14px 16px;
  display: flex; align-items: center; gap: 12px;
  transition: border-color .2s;
}
.conn-row.ok   { border-color: var(--success); background: var(--success-bg); }
.conn-row.fail { border-color: var(--danger);  background: var(--danger-bg); }
.conn-row-icon { font-size: 18px; flex-shrink: 0; }
.conn-row-label { flex: 1; }
.conn-row-label strong { display: block; font-size: 13px; font-weight: 600; }
.conn-row-label span   { font-size: 12px; color: var(--muted); }
.conn-row-status {
  font-size: 13px; font-weight: 600; min-width: 100px; text-align: right;
}
.conn-row-status.idle { color: var(--muted); }
.conn-row-status.ok   { color: var(--success); }
.conn-row-status.fail { color: var(--danger); }

.bridge-hint {
  padding: 12px 16px; border-radius: var(--radius-sm); font-size: 13px;
  background: var(--danger-bg); border: 1px solid #e8464640; color: var(--danger);
  display: none; margin-bottom: 16px;
}
.bridge-hint a { color: var(--primary); }

/* ── Auth step ── */
.cred-storage-options {
  display: grid; grid-template-columns: 1fr 1fr; gap: 10px;
  margin-bottom: 20px;
}
.cred-opt {
  padding: 14px 16px; border-radius: var(--radius-sm); cursor: pointer;
  border: 1.5px solid var(--border); background: var(--surface2);
  transition: border-color .15s;
  display: flex; align-items: flex-start; gap: 10px;
}
.cred-opt input[type=radio] { margin-top: 2px; accent-color: var(--primary); flex-shrink: 0; }
.cred-opt:has(input:checked) { border-color: var(--primary); background: var(--primary-bg); }
.cred-opt-icon  { font-size: 20px; flex-shrink: 0; }
.cred-opt-name  { font-weight: 600; font-size: 13px; }
.cred-opt-desc  { font-size: 12px; color: var(--muted); margin-top: 2px; line-height: 1.5; }

/* ── Permissions step ── */
.perm-preset-grid {
  display: grid; gap: 10px; margin-bottom: 24px;
}
.perm-preset-opt {
  padding: 16px 18px; border-radius: var(--radius-sm); cursor: pointer;
  border: 1.5px solid var(--border); background: var(--surface2);
  transition: border-color .15s, background .15s;
  display: flex; align-items: flex-start; gap: 14px;
}
.perm-preset-opt:has(input:checked) { border-color: var(--primary); background: var(--primary-bg); }
.perm-preset-opt input[type=radio]  { margin-top: 3px; accent-color: var(--primary); flex-shrink: 0; }
.perm-preset-badge {
  width: 36px; height: 36px; border-radius: 9px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center; font-size: 18px;
}
.perm-preset-name { font-weight: 700; font-size: 14px; }
.perm-preset-desc { font-size: 12px; color: var(--muted); margin-top: 3px; line-height: 1.5; }
.perm-preset-tag  {
  display: inline-block; margin-left: 8px;
  font-size: 10px; font-weight: 600; padding: 2px 7px;
  border-radius: 10px; text-transform: uppercase; letter-spacing: .05em; vertical-align: middle;
}
.tag-safe { background: var(--success-bg); color: var(--success); }
.tag-mod  { background: var(--warn-bg); color: var(--warn); }
.tag-high { background: var(--danger-bg); color: var(--danger); }

/* ── Review step ── */
.review-grid {
  display: grid; gap: 12px; margin-bottom: 24px;
}
.review-row {
  display: flex; align-items: center; gap: 14px;
  background: var(--surface2); border: 1px solid var(--border);
  border-radius: var(--radius-sm); padding: 14px 16px;
}
.review-icon { font-size: 18px; flex-shrink: 0; width: 28px; text-align: center; }
.review-label { font-size: 12px; color: var(--muted); font-weight: 600; text-transform: uppercase; letter-spacing: .05em; }
.review-value { font-size: 14px; color: var(--text); font-weight: 500; margin-top: 2px; }

/* ── Done step ── */
.done-hero {
  text-align: center; padding: 16px 0 28px;
}
.done-checkmark {
  width: 70px; height: 70px; border-radius: 50%;
  background: var(--success-bg); border: 2px solid var(--success);
  display: flex; align-items: center; justify-content: center;
  font-size: 34px; margin: 0 auto 16px;
  box-shadow: 0 0 24px rgba(28,196,126,.3);
  animation: popIn .5s cubic-bezier(.17,.67,.3,1.3);
}
@keyframes popIn {
  from { transform: scale(0); opacity: 0; }
  to   { transform: scale(1); opacity: 1; }
}
.done-title    { font-size: 26px; font-weight: 800; color: var(--text); margin-bottom: 8px; }
.done-subtitle { font-size: 15px; color: var(--muted); }

.snippet-wrap {
  background: #06060f; border: 1px solid var(--border);
  border-radius: var(--radius-sm); padding: 16px;
  font-family: monospace; font-size: 12px; line-height: 1.7;
  white-space: pre; overflow-x: auto; color: #b8c4e0;
  margin-bottom: 12px; max-height: 260px; overflow-y: auto;
}
.snippet-actions { display: flex; gap: 10px; margin-bottom: 24px; }

.prompt-pills { margin-bottom: 8px; }
.prompt-pills-title {
  font-size: 12px; color: var(--muted); font-weight: 600;
  text-transform: uppercase; letter-spacing: .06em; margin-bottom: 8px;
}
.prompt-pill {
  display: inline-block; background: var(--surface2); border: 1px solid var(--border);
  border-radius: 20px; padding: 5px 14px; font-size: 12px; margin: 3px 4px 3px 0;
  cursor: pointer; transition: border-color .15s; color: var(--text2);
}
.prompt-pill:hover { border-color: var(--primary); color: var(--primary); }

.config-path-locations {
  font-size: 12px; color: var(--muted); line-height: 1.9;
  background: var(--surface2); border: 1px solid var(--border);
  border-radius: var(--radius-sm); padding: 12px 16px; margin-bottom: 24px;
}
.config-path-locations strong { color: var(--text2); }
.config-path-locations code {
  background: var(--surface3); padding: 1px 5px; border-radius: 3px;
  font-family: monospace; font-size: 11px;
}

/* ── Wizard action row ── */
.wiz-actions {
  display: flex; gap: 10px; margin-top: 28px; align-items: center;
}
.wiz-actions .spacer { flex: 1; }
.wiz-skip {
  font-size: 13px; color: var(--muted); background: none; border: none;
  cursor: pointer; padding: 0; text-decoration: underline;
}
.wiz-skip:hover { color: var(--text); }

/* ── Responsive ── */
@media (max-width: 640px) {
  .wiz-card                { padding: 24px 20px 20px; }
  .wiz-feature-grid        { grid-template-columns: 1fr; }
  .cred-storage-options    { grid-template-columns: 1fr; }
  .row-2, .row-3           { grid-template-columns: 1fr; }
  .wiz-step-label          { display: none; }
  nav                      { overflow-x: auto; }
}

/* Connection mode buttons */
.mode-btns { display: flex; gap: 10px; margin-bottom: 20px; }
.mode-btn {
  flex: 1; padding: 12px 16px; border-radius: var(--radius-sm);
  border: 1.5px solid var(--border); background: var(--surface2);
  color: var(--text2); cursor: pointer; font-size: 13px; font-weight: 600;
  transition: all .15s; text-align: center;
}
.mode-btn:hover { border-color: var(--primary); color: var(--primary); }
.mode-btn.active { border-color: var(--primary); background: var(--primary-bg); color: var(--primary); }
</style>
</head>
<body>

<header>
  <div class="logo-wrap">
    <div class="logo-icon">✉</div>
    <div>
      <div class="header-title">ProtonMail MCP</div>
      <div class="header-subtitle">Settings</div>
    </div>
  </div>
  <div class="header-spacer"></div>
  <div class="status-pill" id="header-status">
    <div class="dot" id="config-dot"></div>
    <span id="config-status-text">Loading…</span>
  </div>
</header>

<!-- ══ POST-SETUP NAV (hidden until config saved) ══ -->
<nav id="main-nav" style="display:none">
  <button class="active" onclick="showTab('setup',this)">Setup</button>
  <button onclick="showTab('permissions',this)">Permissions</button>
  <button onclick="showTab('status',this)">Status</button>
</nav>

<!-- ══ ESCALATION BANNER (shown on all views when pending) ══ -->
<div id="escalation-banner">
  <div class="escalation-banner-title">
    <span>⚠</span>
    <span>AI Permission Escalation Request — Human Approval Required</span>
  </div>
  <div id="escalation-cards"></div>
</div>

<!-- ═══════════════════════════════════════════════
     WIZARD VIEW  (first-time setup)
     ═══════════════════════════════════════════════ -->
<div id="wizard-view">
  <div class="wiz-shell">

    <!-- Progress bar -->
    <div class="wiz-progress" id="wiz-progress" role="progressbar" aria-label="Setup progress">
      <div class="wiz-progress-fill" id="wiz-progress-fill" style="width:0%"></div>
      <div class="wiz-step-node active" id="wnode-0">
        <div class="wiz-step-circle">1</div>
        <div class="wiz-step-label">Welcome</div>
      </div>
      <div class="wiz-step-node" id="wnode-1">
        <div class="wiz-step-circle">2</div>
        <div class="wiz-step-label">Bridge</div>
      </div>
      <div class="wiz-step-node" id="wnode-2">
        <div class="wiz-step-circle">3</div>
        <div class="wiz-step-label">Account</div>
      </div>
      <div class="wiz-step-node" id="wnode-3">
        <div class="wiz-step-circle">4</div>
        <div class="wiz-step-label">Permissions</div>
      </div>
      <div class="wiz-step-node" id="wnode-4">
        <div class="wiz-step-circle">5</div>
        <div class="wiz-step-label">Review</div>
      </div>
      <div class="wiz-step-node" id="wnode-5">
        <div class="wiz-step-circle">6</div>
        <div class="wiz-step-label">Done</div>
      </div>
    </div>

    <div class="wiz-card">

      <!-- ══ Step 1: Welcome ══ -->
      <div class="wiz-panel active" id="wpanel-0" role="tabpanel" aria-label="Welcome">
        <div class="wiz-title">Welcome to ProtonMail MCP</div>
        <div class="wiz-subtitle">
          Give Claude secure, permission-controlled access to your ProtonMail inbox
          via Proton Bridge. Setup takes about 3 minutes.
        </div>

        <div class="wiz-feature-grid">
          <div class="wiz-feature-card">
            <div class="wiz-feature-icon">📖</div>
            <div>
              <div class="wiz-feature-title">Read &amp; Search</div>
              <div class="wiz-feature-desc">Search emails, get summaries, analyse patterns</div>
            </div>
          </div>
          <div class="wiz-feature-card">
            <div class="wiz-feature-icon">✉</div>
            <div>
              <div class="wiz-feature-title">Send &amp; Reply</div>
              <div class="wiz-feature-desc">Draft, send, and reply to emails on your behalf</div>
            </div>
          </div>
          <div class="wiz-feature-card">
            <div class="wiz-feature-icon">📁</div>
            <div>
              <div class="wiz-feature-title">Organise</div>
              <div class="wiz-feature-desc">Move, label, archive, and manage folders</div>
            </div>
          </div>
          <div class="wiz-feature-card">
            <div class="wiz-feature-icon">🔒</div>
            <div>
              <div class="wiz-feature-title">Permission Controls</div>
              <div class="wiz-feature-desc">You choose exactly what Claude is allowed to do</div>
            </div>
          </div>
        </div>

        <div class="wiz-prereqs">
          <div class="wiz-prereqs-title">Before you begin</div>
          <div class="wiz-prereq">
            <div class="wiz-prereq-icon">🔒</div>
            <div>
              <div class="wiz-prereq-name">Proton Bridge</div>
              <div class="wiz-prereq-desc">Must be installed, running, and signed in.
                <a href="https://proton.me/mail/bridge" target="_blank" rel="noopener" style="color:var(--primary)">Download →</a>
              </div>
            </div>
          </div>
          <div class="wiz-prereq">
            <div class="wiz-prereq-icon">⬡</div>
            <div>
              <div class="wiz-prereq-name">Node.js 20+</div>
              <div class="wiz-prereq-desc">Check with <code style="background:var(--surface3);padding:1px 5px;border-radius:3px;font-size:11px">node --version</code></div>
            </div>
          </div>
          <div class="wiz-prereq">
            <div class="wiz-prereq-icon">🤖</div>
            <div>
              <div class="wiz-prereq-name">Claude Desktop</div>
              <div class="wiz-prereq-desc">Or another MCP-compatible host.
                <a href="https://claude.ai/download" target="_blank" rel="noopener" style="color:var(--primary)">Download →</a>
              </div>
            </div>
          </div>
        </div>

        <div class="wiz-actions">
          <button class="wiz-skip" id="wiz-skip-btn" onclick="openSettingsView()" aria-label="Skip wizard and go to settings">Skip wizard</button>
          <div class="spacer"></div>
          <button class="btn btn-primary" onclick="wizGo(1)" aria-label="Start setup">Get Started →</button>
        </div>
      </div>

      <!-- ══ Step 2: Bridge ══ -->
      <div class="wiz-panel" id="wpanel-1" role="tabpanel" aria-label="Bridge connection">
        <div class="wiz-title">Proton Bridge</div>
        <div class="wiz-subtitle">
          Bridge creates a local SMTP port (1025) and IMAP port (1143) so this server
          can send and read your encrypted emails — entirely on your machine.<br><br>
          Make sure Bridge is <strong style="color:var(--text)">open and signed in</strong>, then click Test.
        </div>

        <div class="conn-test-grid" id="conn-test-grid">
          <div class="conn-row" id="smtp-row">
            <div class="conn-row-icon">📤</div>
            <div class="conn-row-label">
              <strong>SMTP</strong>
              <span id="smtp-host-label">localhost:1025</span>
            </div>
            <div class="conn-row-status idle" id="smtp-conn-status">—</div>
          </div>
          <div class="conn-row" id="imap-row">
            <div class="conn-row-icon">📥</div>
            <div class="conn-row-label">
              <strong>IMAP</strong>
              <span id="imap-host-label">localhost:1143</span>
            </div>
            <div class="conn-row-status idle" id="imap-conn-status">—</div>
          </div>
        </div>

        <div class="bridge-hint" id="bridge-hint">
          One or both ports are not reachable. Make sure Proton Bridge is running and signed in.
          <a href="https://proton.me/mail/bridge" target="_blank" rel="noopener">Download Bridge →</a>
        </div>

        <div style="margin-bottom:20px">
          <div class="field">
            <label>Bridge TLS certificate path <span style="color:var(--muted);font-weight:400">(optional)</span></label>
            <input type="text" id="wiz-cert-path" placeholder="/path/to/bridge-cert.crt"
              aria-label="Bridge TLS certificate path">
            <div class="hint">Export from Bridge → Settings → Export TLS certificates. Enables proper TLS trust.</div>
          </div>
        </div>

        <div class="wiz-actions">
          <button class="btn btn-ghost" onclick="wizGo(0)" aria-label="Back to Welcome">← Back</button>
          <div class="spacer"></div>
          <button class="btn btn-ghost" id="wiz-test-bridge-btn" onclick="wizTestBridge()" aria-label="Test bridge connection">
            Test Connection
          </button>
          <button class="btn btn-primary" id="wiz-bridge-next" onclick="wizGo(2)" aria-label="Continue to Account">
            Continue →
          </button>
        </div>
      </div>

      <!-- ══ Step 3: Account ══ -->
      <div class="wiz-panel" id="wpanel-2" role="tabpanel" aria-label="Account credentials">
        <div class="wiz-title">Connect Your Account</div>
        <div class="wiz-subtitle">
          Enter your ProtonMail address and your <strong style="color:var(--text)">Bridge password</strong>
          — this is shown inside the Proton Bridge app, not your ProtonMail login password.
        </div>

        <div class="field">
          <label for="wiz-username">ProtonMail email address</label>
          <input type="email" id="wiz-username" placeholder="you@proton.me"
            autocomplete="username" aria-required="true"
            oninput="wizClearError('wiz-username')">
          <div class="err-msg" id="err-wiz-username">Please enter your email address.</div>
        </div>

        <div class="field">
          <label for="wiz-password">
            Bridge password
            <span style="color:var(--muted);font-weight:400">(from the Bridge app)</span>
          </label>
          <div class="pw-wrap">
            <input type="password" id="wiz-password" placeholder="Bridge password"
              autocomplete="current-password" aria-required="true"
              oninput="wizClearError('wiz-password')">
            <button class="pw-toggle" onclick="togglePw('wiz-password',this)" type="button"
              aria-label="Show/hide password">👁</button>
          </div>
          <div class="hint">Bridge app → Settings → IMAP/SMTP → Password</div>
          <div class="err-msg" id="err-wiz-password">Please enter your Bridge password.</div>
        </div>

        <div class="field" id="smtp-token-field" style="display:none">
          <label for="wiz-smtp-token">SMTP token <span style="color:var(--muted);font-weight:400">(required for direct smtp.protonmail.ch)</span></label>
          <div class="pw-wrap">
            <input type="password" id="wiz-smtp-token" placeholder="SMTP token from Bridge settings"
              autocomplete="off" aria-label="SMTP token">
            <button class="pw-toggle" onclick="togglePw('wiz-smtp-token',this)" type="button"
              aria-label="Show/hide SMTP token">👁</button>
          </div>
          <div class="hint">Required for paid plans using direct smtp.protonmail.ch. Leave blank for Bridge.</div>
        </div>

        <div class="field" style="margin-top:8px">
          <label class="toggle-wrap" style="width:fit-content">
            <span class="toggle">
              <input type="checkbox" id="wiz-debug">
              <span class="slider"></span>
            </span>
            <span>Enable debug logging</span>
          </label>
        </div>

        <div class="wiz-actions">
          <button class="btn btn-ghost" onclick="wizGo(1)" aria-label="Back to Bridge">← Back</button>
          <div class="spacer"></div>
          <button class="btn btn-primary" onclick="wizSaveCreds()" id="wiz-save-creds-btn"
            aria-label="Save credentials and continue">
            Save &amp; Continue →
          </button>
        </div>
      </div>

      <!-- ══ Step 4: Permissions ══ -->
      <div class="wiz-panel" id="wpanel-3" role="tabpanel" aria-label="Permissions">
        <div class="wiz-title">Set AI Permissions</div>
        <div class="wiz-subtitle">
          Choose how much Claude is allowed to do. You can fine-tune individual tools
          from the Permissions tab after setup.
        </div>

        <div class="perm-preset-grid" role="radiogroup" aria-label="Permission preset">
          <label class="perm-preset-opt">
            <input type="radio" name="wiz-preset" value="read_only" checked aria-label="Read-Only preset">
            <div class="perm-preset-badge" style="background:#1cc47e22">📖</div>
            <div>
              <div class="perm-preset-name">
                Read-Only
                <span class="perm-preset-tag tag-safe">Recommended</span>
              </div>
              <div class="perm-preset-desc">Reading, searching, analytics, and connection status only. Cannot send, move, delete, or modify anything. Safest starting point.</div>
            </div>
          </label>

          <label class="perm-preset-opt">
            <input type="radio" name="wiz-preset" value="supervised" aria-label="Supervised preset">
            <div class="perm-preset-badge" style="background:#f5a62322">👁</div>
            <div>
              <div class="perm-preset-name">
                Supervised
                <span class="perm-preset-tag tag-mod">Rate limited</span>
              </div>
              <div class="perm-preset-desc">All tools enabled with safety caps: deletion at 5/hr, sending at 20/hr, bulk actions at 10/hr.</div>
            </div>
          </label>

          <label class="perm-preset-opt">
            <input type="radio" name="wiz-preset" value="send_only" aria-label="Send-Only preset">
            <div class="perm-preset-badge" style="background:#6d4aff22">📤</div>
            <div>
              <div class="perm-preset-name">Send-Only</div>
              <div class="perm-preset-desc">Reading and sending only. No deletion, no folder writes, no bulk operations.</div>
            </div>
          </label>

          <label class="perm-preset-opt">
            <input type="radio" name="wiz-preset" value="full" aria-label="Full Access preset">
            <div class="perm-preset-badge" style="background:#e8464622">⚡</div>
            <div>
              <div class="perm-preset-name">
                Full Access
                <span class="perm-preset-tag tag-high">No limits</span>
              </div>
              <div class="perm-preset-desc">All 47 tools, no rate limits. Grant only when you fully trust the agent to act autonomously.</div>
            </div>
          </label>
        </div>

        <div class="wiz-actions">
          <button class="btn btn-ghost" onclick="wizGo(2)" aria-label="Back to Account">← Back</button>
          <div class="spacer"></div>
          <button class="btn btn-primary" onclick="wizSavePreset()" id="wiz-apply-preset-btn"
            aria-label="Apply preset and continue to review">
            Apply &amp; Continue →
          </button>
        </div>
      </div>

      <!-- ══ Step 5: Review & Save ══ -->
      <div class="wiz-panel" id="wpanel-4" role="tabpanel" aria-label="Review and save">
        <div class="wiz-title">Review &amp; Save</div>
        <div class="wiz-subtitle">
          Confirm your settings before saving. You can edit any value by going back.
        </div>

        <div class="review-grid">
          <div class="review-row">
            <div class="review-icon">🌉</div>
            <div>
              <div class="review-label">Connection</div>
              <div class="review-value" id="review-connection">—</div>
            </div>
          </div>
          <div class="review-row">
            <div class="review-icon">👤</div>
            <div>
              <div class="review-label">Account</div>
              <div class="review-value" id="review-account">—</div>
            </div>
          </div>
          <div class="review-row">
            <div class="review-icon">🔒</div>
            <div>
              <div class="review-label">Permission Preset</div>
              <div class="review-value" id="review-preset">—</div>
            </div>
          </div>
          <div class="review-row">
            <div class="review-icon">🛡</div>
            <div>
              <div class="review-label">Credential Storage</div>
              <div class="review-value" id="review-storage">Config file (0600)</div>
            </div>
          </div>
        </div>

        <div class="wiz-actions">
          <button class="btn btn-ghost" onclick="wizGo(3)" aria-label="Back to Permissions">← Back</button>
          <div class="spacer"></div>
          <button class="btn btn-primary" onclick="wizFinalSave()" id="wiz-final-save-btn"
            aria-label="Save configuration">
            Save Configuration
          </button>
        </div>
      </div>

      <!-- ══ Step 6: Done ══ -->
      <div class="wiz-panel" id="wpanel-5" role="tabpanel" aria-label="Setup complete">
        <div class="done-hero">
          <div class="done-checkmark" aria-hidden="true">✓</div>
          <div class="done-title">You're all set!</div>
          <div class="done-subtitle">Add the snippet below to Claude Desktop and restart it.</div>
        </div>

        <div class="snippet-wrap" id="wiz-snippet" aria-label="Claude Desktop config snippet">Loading…</div>
        <div class="snippet-actions">
          <button class="btn btn-ghost btn-sm" onclick="wizCopySnippet()" aria-label="Copy config snippet">
            Copy Snippet
          </button>
        </div>

        <div class="config-path-locations">
          <strong>Claude Desktop config file location:</strong><br>
          macOS: <code>~/Library/Application Support/Claude/claude_desktop_config.json</code><br>
          Windows: <code>%APPDATA%\\Claude\\claude_desktop_config.json</code><br>
          Linux: <code>~/.config/Claude/claude_desktop_config.json</code>
        </div>

        <div class="prompt-pills">
          <div class="prompt-pills-title">Try these prompts in Claude</div>
          <span class="prompt-pill">"Show my unread emails"</span>
          <span class="prompt-pill">"What folders do I have?"</span>
          <span class="prompt-pill">"Check my connection status"</span>
          <span class="prompt-pill">"Summarise emails from this week"</span>
          <span class="prompt-pill">"Who do I email most often?"</span>
        </div>

        <div class="wiz-actions" style="margin-top:20px">
          <div class="spacer"></div>
          <button class="btn btn-primary" onclick="openSettingsView()" aria-label="Open settings">
            Open Settings ↗
          </button>
        </div>
      </div>

    </div><!-- /.wiz-card -->
  </div><!-- /.wiz-shell -->
</div><!-- /#wizard-view -->

<!-- ═══════════════════════════════════════════════
     SETTINGS VIEW  (post-setup / tab-based)
     ═══════════════════════════════════════════════ -->
<div id="settings-view" style="display:none">
<main>

<!-- ══ SETUP TAB ══ -->
<section id="setup" class="active">
  <div class="section-heading">Connection Settings</div>
  <div class="section-subheading">Configure your Proton Bridge SMTP and IMAP endpoints.</div>

  <div class="alert alert-info">
    <span>ℹ</span>
    <span>Credentials are saved to <code id="config-path-setup">${safeConfigPath}</code> (mode 0600).
    The MCP server reads this file every 15 s — env vars still override these values when both are set.</span>
  </div>

  <div class="card">
    <div class="card-title">Connection Mode</div>
    <div class="card-desc">Most users run via Proton Bridge (localhost). Direct SMTP requires a paid plan and SMTP token.</div>
    <div class="mode-btns">
      <button class="mode-btn active" id="mode-bridge" onclick="setMode('bridge')">Proton Bridge (localhost)</button>
      <button class="mode-btn" id="mode-direct" onclick="setMode('direct')">Direct smtp.protonmail.ch</button>
    </div>
  </div>

  <form id="setup-form" onsubmit="return false">
    <div class="card">
      <fieldset>
        <legend>Account</legend>
        <div class="row-2">
          <div class="field">
            <label for="username">ProtonMail username / email</label>
            <input type="email" id="username" placeholder="user@proton.me" autocomplete="username">
          </div>
          <div class="field">
            <label for="password">Bridge password <span style="color:var(--muted);font-weight:400">(from Bridge app)</span></label>
            <div class="pw-wrap">
              <input type="password" id="password" placeholder="••••••••" autocomplete="current-password">
              <button class="pw-toggle" onclick="togglePw('password',this)" type="button" aria-label="Show/hide password">👁</button>
            </div>
            <div class="hint">Leave blank to keep the saved value.</div>
          </div>
        </div>
      </fieldset>
    </div>

    <div class="card">
      <fieldset>
        <legend>SMTP</legend>
        <div class="row-3">
          <div class="field">
            <label for="smtp-host">Host</label>
            <input type="text" id="smtp-host" placeholder="localhost">
          </div>
          <div class="field">
            <label for="smtp-port">Port</label>
            <input type="number" id="smtp-port" min="1" max="65535" placeholder="1025">
          </div>
          <div class="field">
            <label>TLS mode</label>
            <input type="text" id="smtp-tls" readonly style="color:var(--muted)">
          </div>
        </div>
        <div class="field" id="setup-smtp-token-field" style="display:none">
          <label for="smtp-token">SMTP token <span style="color:var(--muted);font-weight:400">(required for direct)</span></label>
          <div class="pw-wrap">
            <input type="password" id="smtp-token" placeholder="Generated in Bridge Settings → IMAP/SMTP">
            <button class="pw-toggle" onclick="togglePw('smtp-token',this)" type="button" aria-label="Show/hide SMTP token">👁</button>
          </div>
          <div class="hint">Leave blank to keep the saved value.</div>
        </div>
      </fieldset>
    </div>

    <div class="card">
      <fieldset>
        <legend>IMAP</legend>
        <div class="row-3">
          <div class="field">
            <label for="imap-host">Host</label>
            <input type="text" id="imap-host" placeholder="localhost">
          </div>
          <div class="field">
            <label for="imap-port">Port</label>
            <input type="number" id="imap-port" min="1" max="65535" placeholder="1143">
          </div>
          <div class="field"></div>
        </div>
      </fieldset>
    </div>

    <div class="card">
      <fieldset>
        <legend>Bridge TLS Certificate (optional but recommended)</legend>
        <div class="field">
          <label for="bridge-cert">Path to exported .crt file</label>
          <input type="text" id="bridge-cert" placeholder="/path/to/bridge-cert.crt">
          <div class="hint">Export from Bridge → Settings → Export TLS certificates.</div>
        </div>
        <div class="field" style="margin-top:6px">
          <label class="toggle-wrap" style="width:fit-content">
            <span class="toggle"><input type="checkbox" id="debug-mode"><span class="slider"></span></span>
            <span>Enable debug logging</span>
          </label>
        </div>
      </fieldset>
    </div>

    <div class="actions">
      <button class="btn btn-primary" onclick="saveSetup()" id="save-btn">Save Configuration</button>
      <button class="btn btn-ghost"   onclick="testConnections()" id="test-btn">Test Connections</button>
      <span id="test-result" style="align-self:center;font-size:13px;color:var(--muted)"></span>
    </div>
  </form>
</section>

<!-- ══ PERMISSIONS TAB ══ -->
<section id="permissions">
  <div class="section-heading">Permissions</div>
  <div class="section-subheading">Control which tools Claude can use and at what rate.</div>

  <div class="card">
    <div class="card-title">Permission Presets</div>
    <div class="card-desc">Apply a preset to quickly configure access, then fine-tune individual tools below.</div>
    <div class="presets" id="preset-btns">
      <button class="preset-btn" data-preset="full"       onclick="applyPreset('full')">Full Access</button>
      <button class="preset-btn" data-preset="supervised" onclick="applyPreset('supervised')">Supervised</button>
      <button class="preset-btn" data-preset="send_only"  onclick="applyPreset('send_only')">Send-Only</button>
      <button class="preset-btn" data-preset="read_only"  onclick="applyPreset('read_only')">Read-Only</button>
      <button class="preset-btn" data-preset="custom" id="custom-preset-btn" style="display:none">Custom</button>
    </div>
    <table style="font-size:12px;color:var(--muted);border-collapse:collapse;width:100%">
      <tr><td style="padding:3px 8px 3px 0;font-weight:600;color:var(--text)">Read-Only</td><td>Reading, analytics, and system tools only.</td></tr>
      <tr><td style="padding:3px 8px 3px 0;font-weight:600;color:var(--text)">Supervised</td><td>All tools with rate caps: deletion 5/hr, sending 20/hr, bulk 10/hr.</td></tr>
      <tr><td style="padding:3px 8px 3px 0;font-weight:600;color:var(--text)">Send-Only</td><td>Reading and sending only — no deletion, no folder writes.</td></tr>
      <tr><td style="padding:3px 8px 3px 0;font-weight:600;color:var(--text)">Full Access</td><td>All tools, no rate limits.</td></tr>
    </table>
  </div>

  <div id="categories"></div>

  <div class="actions">
    <button class="btn btn-primary" onclick="savePermissions()">Save Permissions</button>
  </div>
</section>

<!-- ══ STATUS TAB ══ -->
<section id="status">
  <div class="section-heading">Status</div>
  <div class="section-subheading">Server information and connection health.</div>

  <div class="card">
    <div class="card-title">Server Information</div>
    <table class="info-table">
      <tr><td>Config file</td><td><code id="info-config-path">${safeConfigPath}</code></td></tr>
      <tr><td>Config exists</td><td id="info-config-exists">—</td></tr>
      <tr><td>Active preset</td><td id="info-preset">—</td></tr>
      <tr><td>Disabled tools</td><td id="info-disabled">—</td></tr>
      <tr><td>Rate-limited tools</td><td id="info-rate-limited">—</td></tr>
    </table>
  </div>

  <div class="card">
    <div class="card-title">Claude Desktop Integration</div>
    <div class="card-desc">Paste this into your <code>claude_desktop_config.json</code> under <code>mcpServers</code>.</div>
    <pre class="code-block" id="claude-snippet">Loading…</pre>
    <div class="copy-row">
      <button class="btn btn-ghost btn-sm" onclick="copySnippet()">Copy</button>
    </div>
  </div>

  <div class="card">
    <div class="card-title">Connection Check</div>
    <div class="card-desc">Checks whether SMTP and IMAP ports are reachable from this machine.</div>
    <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
      <button class="btn btn-ghost" onclick="runStatusCheck()" id="status-check-btn">Check Now</button>
      <div id="status-check-result" style="font-size:13px;color:var(--muted)"></div>
    </div>
    <div id="connectivity-results" style="margin-top:14px;display:none">
      <div style="display:flex;gap:20px;flex-wrap:wrap">
        <div>
          <div style="font-size:12px;color:var(--muted);margin-bottom:4px">SMTP</div>
          <div id="smtp-check-status" style="font-weight:600">—</div>
        </div>
        <div>
          <div style="font-size:12px;color:var(--muted);margin-bottom:4px">IMAP</div>
          <div id="imap-check-status" style="font-weight:600">—</div>
        </div>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-title">Reset</div>
    <div class="card-desc">Delete the config file and revert to env-var-only mode.</div>
    <div class="actions" style="margin-top:0">
      <button class="btn btn-danger" onclick="resetConfig()">Reset to Defaults</button>
    </div>
  </div>

  <div class="card">
    <div class="card-title">Escalation Audit Log</div>
    <div class="card-desc">Record of all permission escalation requests and their outcomes.</div>
    <div id="audit-log-wrap">
      <table class="audit-table">
        <thead>
          <tr><th>Time</th><th>Event</th><th>From</th><th>To</th><th>Via</th><th>Reason</th></tr>
        </thead>
        <tbody id="audit-log-body">
          <tr><td colspan="6" style="color:var(--muted);padding:12px 10px">Loading…</td></tr>
        </tbody>
      </table>
    </div>
  </div>

</section>
</main>
</div><!-- /#settings-view -->

<div id="toast" role="status" aria-live="polite"></div>

<script>
(function() {
  // ── Constants ─────────────────────────────────────────────────────────────
  const ALL_TOOLS  = ${toolsJson};
  const CATEGORIES = ${categoriesJson};

  // ── State ─────────────────────────────────────────────────────────────────
  let cfg         = null;
  let toolEnabled = {};
  let toolRate    = {};

  // Wizard in-progress state
  const W = {
    smtpHost: 'localhost', smtpPort: 1025,
    imapHost: 'localhost', imapPort: 1143,
    certPath: '',
    username: '', debug: false,
    preset: 'read_only',
    bridgeTested: false,
    credsSaved: false,
    presetSaved: false,
  };

  // ── CSRF ──────────────────────────────────────────────────────────────────
  const CSRF = document.querySelector('meta[name="csrf-token"]')?.content || '';

  // ── Boot ──────────────────────────────────────────────────────────────────
  window.addEventListener('DOMContentLoaded', async () => {
    buildCategoryUI();
    let st;
    try { st = await fetch('/api/status').then(r => r.json()); } catch { st = { hasConfig: false }; }
    if (st.hasConfig) {
      await refresh();
      openSettingsView();
    } else {
      document.getElementById('wizard-view').style.display = 'flex';
      document.getElementById('settings-view').style.display = 'none';
      wizShowStep(0);
    }
    loadEscalations();
    loadAuditLog();
    setInterval(loadEscalations, 15_000);
  });

  async function refresh() {
    try {
      const r = await fetch('/api/config');
      cfg = await r.json();
      populateSetup(cfg);
      populatePermissions(cfg);
      populateStatus(cfg);
      updateHeaderStatus(true);
    } catch {
      updateHeaderStatus(false);
    }
  }

  // ── View switching ────────────────────────────────────────────────────────
  window.openSettingsView = function() {
    document.getElementById('wizard-view').style.display = 'none';
    document.getElementById('settings-view').style.display = '';
    document.getElementById('main-nav').style.display = '';
    refresh();
  };

  window.showTab = function(id, btn) {
    document.querySelectorAll('#settings-view section').forEach(s => s.classList.remove('active'));
    document.querySelectorAll('#main-nav button').forEach(b => b.classList.remove('active'));
    document.getElementById(id).classList.add('active');
    btn.classList.add('active');
    if (id === 'status') { populateStatus(cfg); loadAuditLog(); }
  };

  // ── Header status ─────────────────────────────────────────────────────────
  function updateHeaderStatus(ok) {
    document.getElementById('config-dot').className        = 'dot ' + (ok ? 'ok' : 'err');
    document.getElementById('config-status-text').textContent = ok ? 'Config loaded' : 'Not connected';
  }

  // ══ WIZARD LOGIC ══════════════════════════════════════════════════════════

  const STEP_LABELS = ['Welcome','Bridge','Account','Permissions','Review','Done'];
  const STEP_COUNT  = 6;

  function wizShowStep(n) {
    // Hide all panels
    document.querySelectorAll('.wiz-panel').forEach((el, i) => {
      el.classList.toggle('active', i === n);
    });
    // Update nodes
    for (let i = 0; i < STEP_COUNT; i++) {
      const node = document.getElementById('wnode-' + i);
      if (!node) continue;
      node.className = 'wiz-step-node' +
        (i === n ? ' active' : i < n ? ' done' : '');
      node.querySelector('.wiz-step-circle').textContent =
        i < n ? '✓' : String(i + 1);
    }
    // Progress fill
    const pct = n === 0 ? 0 : Math.round((n / (STEP_COUNT - 1)) * 100);
    document.getElementById('wiz-progress-fill').style.width = pct + '%';
    // Focus first focusable element
    const panel = document.getElementById('wpanel-' + n);
    if (panel) {
      const first = panel.querySelector('input:not([disabled]),button:not([disabled])');
      if (first) setTimeout(() => first.focus(), 80);
    }
    // Step-specific setup
    if (n === 4) wizBuildReview();
    if (n === 5) wizBuildSnippet();
  }

  window.wizGo = function(n) { wizShowStep(n); };

  // ── Step 2: Bridge test ───────────────────────────────────────────────────
  window.wizTestBridge = async function() {
    const btn  = document.getElementById('wiz-test-bridge-btn');
    const hint = document.getElementById('bridge-hint');
    const smtpRow = document.getElementById('smtp-row');
    const imapRow = document.getElementById('imap-row');
    const smtpSt  = document.getElementById('smtp-conn-status');
    const imapSt  = document.getElementById('imap-conn-status');
    const nextBtn = document.getElementById('wiz-bridge-next');

    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Testing…';
    smtpSt.className = 'conn-row-status idle'; smtpSt.textContent = 'Checking…';
    imapSt.className = 'conn-row-status idle'; imapSt.textContent = 'Checking…';
    smtpRow.className = 'conn-row'; imapRow.className = 'conn-row';

    // Save cert path
    W.certPath = document.getElementById('wiz-cert-path').value.trim();

    try {
      const r = await fetch('/api/test-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF },
        body: JSON.stringify({
          smtpHost: W.smtpHost, smtpPort: W.smtpPort,
          imapHost: W.imapHost, imapPort: W.imapPort,
        }),
      });
      const d = await r.json();
      smtpSt.textContent = d.smtp ? '✅ Reachable' : '❌ Unreachable';
      smtpSt.className   = 'conn-row-status ' + (d.smtp ? 'ok' : 'fail');
      imapSt.textContent = d.imap ? '✅ Reachable' : '❌ Unreachable';
      imapSt.className   = 'conn-row-status ' + (d.imap ? 'ok' : 'fail');
      smtpRow.className  = 'conn-row ' + (d.smtp ? 'ok' : 'fail');
      imapRow.className  = 'conn-row ' + (d.imap ? 'ok' : 'fail');
      const allOk = d.smtp && d.imap;
      hint.style.display = allOk ? 'none' : '';
      W.bridgeTested = allOk;
      nextBtn.disabled = !allOk;
      if (allOk) nextBtn.classList.add('btn-success');
    } catch(e) {
      smtpSt.textContent = imapSt.textContent = 'Error';
      smtpSt.className = imapSt.className = 'conn-row-status fail';
      hint.style.display = '';
    } finally {
      btn.disabled = false; btn.textContent = 'Test Connection';
    }
  };

  // ── Step 3: Credential save ───────────────────────────────────────────────
  window.wizSaveCreds = async function() {
    const username = document.getElementById('wiz-username').value.trim();
    const password = document.getElementById('wiz-password').value;
    const smtpToken = document.getElementById('wiz-smtp-token').value;
    const debug     = document.getElementById('wiz-debug').checked;

    let valid = true;
    if (!username) {
      setFieldError('wiz-username', 'err-wiz-username', true);
      valid = false;
    }
    if (!password) {
      setFieldError('wiz-password', 'err-wiz-password', true);
      valid = false;
    }
    if (!valid) return;

    const btn = document.getElementById('wiz-save-creds-btn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Saving…';

    try {
      const r = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF },
        body: JSON.stringify({
          connection: {
            username,
            password,
            smtpHost: W.smtpHost, smtpPort: W.smtpPort,
            imapHost: W.imapHost, imapPort: W.imapPort,
            bridgeCertPath: W.certPath,
            smtpToken,
            debug,
          },
        }),
      });
      if (!r.ok) throw new Error(await r.text());
      W.username = username;
      W.debug    = debug;
      W.credsSaved = true;
      wizShowStep(3);
    } catch(e) {
      toast('Could not save credentials: ' + e.message, 'err');
    } finally {
      btn.disabled = false; btn.textContent = 'Save & Continue →';
    }
  };

  window.wizClearError = function(id) {
    const inp = document.getElementById(id);
    const errId = 'err-' + id;
    setFieldError(id, errId, false);
  };

  function setFieldError(inputId, errId, show) {
    const inp = document.getElementById(inputId);
    const err = document.getElementById(errId);
    if (inp) inp.classList.toggle('invalid', show);
    if (err) err.style.display = show ? 'block' : 'none';
  }

  // ── Step 4: Preset save ───────────────────────────────────────────────────
  window.wizSavePreset = async function() {
    const radio = document.querySelector('input[name="wiz-preset"]:checked');
    const preset = radio ? radio.value : 'read_only';
    W.preset = preset;

    const btn = document.getElementById('wiz-apply-preset-btn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Applying…';

    try {
      const r = await fetch('/api/preset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF },
        body: JSON.stringify({ preset }),
      });
      if (!r.ok) throw new Error('Save failed');
      W.presetSaved = true;
      wizShowStep(4);
    } catch(e) {
      toast('Could not apply preset: ' + e.message, 'err');
    } finally {
      btn.disabled = false; btn.textContent = 'Apply & Continue →';
    }
  };

  // ── Step 5: Review ────────────────────────────────────────────────────────
  function wizBuildReview() {
    const radio  = document.querySelector('input[name="wiz-preset"]:checked');
    const preset = radio ? radio.value : W.preset;
    const username = document.getElementById('wiz-username')?.value.trim() || W.username || '—';
    const connLabel = W.smtpHost === 'localhost'
      ? 'Proton Bridge (localhost:' + W.smtpPort + ' / ' + W.imapPort + ')'
      : 'Direct (smtp.protonmail.ch:' + W.smtpPort + ')';

    document.getElementById('review-connection').textContent = connLabel;
    document.getElementById('review-account').textContent    = username;
    document.getElementById('review-preset').textContent     = formatPreset(preset);
    document.getElementById('review-storage').textContent    = 'Config file (mode 0600)';
  }

  function formatPreset(p) {
    return { full:'Full Access', read_only:'Read-Only', supervised:'Supervised',
             send_only:'Send-Only', custom:'Custom' }[p] || p;
  }

  // ── Step 5: Final save ────────────────────────────────────────────────────
  window.wizFinalSave = async function() {
    const btn = document.getElementById('wiz-final-save-btn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Saving…';
    try {
      // Config was already saved in steps 3 & 4.
      // Just advance to Done.
      toast('Configuration saved.', 'ok');
      wizShowStep(5);
    } catch(e) {
      toast('Save failed: ' + e.message, 'err');
    } finally {
      btn.disabled = false; btn.textContent = 'Save Configuration';
    }
  };

  // ── Step 6: Done ──────────────────────────────────────────────────────────
  function wizBuildSnippet() {
    const username = document.getElementById('wiz-username')?.value.trim()
      || W.username || 'you@proton.me';
    const snippet = {
      mcpServers: {
        protonmail: {
          command: 'npx',
          args: ['-y', 'protonmail-mcp-server'],
          env: {
            PROTONMAIL_USERNAME: username,
            PROTONMAIL_PASSWORD: '(your-bridge-password)',
            PROTONMAIL_SMTP_HOST: W.smtpHost,
            PROTONMAIL_SMTP_PORT: String(W.smtpPort),
            PROTONMAIL_IMAP_HOST: W.imapHost,
            PROTONMAIL_IMAP_PORT: String(W.imapPort),
            ...(W.certPath ? { PROTONMAIL_BRIDGE_CERT: W.certPath } : {}),
          },
        },
      },
    };
    document.getElementById('wiz-snippet').textContent = JSON.stringify(snippet, null, 2);
  }

  window.wizCopySnippet = function() {
    const text = document.getElementById('wiz-snippet').textContent;
    navigator.clipboard.writeText(text).then(() => toast('Copied!', 'ok'));
  };

  // ── Shared: show/hide password ────────────────────────────────────────────
  window.togglePw = function(id, btn) {
    const inp = document.getElementById(id);
    if (!inp) return;
    const show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    btn.textContent = show ? '🙈' : '👁';
    btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  };

  // ══ SETTINGS TAB LOGIC ════════════════════════════════════════════════════

  function populateSetup(c) {
    if (!c) return;
    const cn = c.connection || {};
    set('username',    cn.username || '');
    set('smtp-host',   cn.smtpHost || 'localhost');
    set('smtp-port',   cn.smtpPort || 1025);
    set('imap-host',   cn.imapHost || 'localhost');
    set('imap-port',   cn.imapPort || 1143);
    set('bridge-cert', cn.bridgeCertPath || '');
    document.getElementById('debug-mode').checked = !!cn.debug;
    const isDirect = (cn.smtpHost || '').includes('protonmail');
    setMode(isDirect ? 'direct' : 'bridge');
    updateTlsLabel();
  }

  window.setMode = function(mode) {
    const isBridge = mode === 'bridge';
    document.getElementById('mode-bridge').className = 'mode-btn' + (isBridge ? ' active' : '');
    document.getElementById('mode-direct').className = 'mode-btn' + (!isBridge ? ' active' : '');
    document.getElementById('setup-smtp-token-field').style.display = isBridge ? 'none' : '';
    if (isBridge) {
      set('smtp-host', 'localhost'); set('smtp-port', 1025);
      set('imap-host', 'localhost'); set('imap-port', 1143);
    } else {
      set('smtp-host', 'smtp.protonmail.ch'); set('smtp-port', 587);
    }
    updateTlsLabel();
  };

  function updateTlsLabel() {
    const port = parseInt(get('smtp-port'), 10);
    document.getElementById('smtp-tls').value =
      port === 465 ? 'SSL/TLS (port 465)' :
      port === 587 ? 'STARTTLS (port 587)' :
      'None / Bridge';
  }
  document.addEventListener('input', e => {
    if (e.target.id === 'smtp-port') updateTlsLabel();
  });

  window.saveSetup = async function() {
    const btn = document.getElementById('save-btn');
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Saving…';
    try {
      const body = {
        connection: {
          username:       get('username'),
          password:       get('password'),
          smtpHost:       get('smtp-host'),
          smtpPort:       parseInt(get('smtp-port'), 10),
          imapHost:       get('imap-host'),
          imapPort:       parseInt(get('imap-port'), 10),
          smtpToken:      get('smtp-token'),
          bridgeCertPath: get('bridge-cert'),
          debug:          document.getElementById('debug-mode').checked,
        },
      };
      const r = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(await r.text());
      toast('Configuration saved.', 'ok');
      await refresh();
    } catch(e) {
      toast('Save failed: ' + e.message, 'err');
    } finally {
      btn.disabled = false; btn.textContent = 'Save Configuration';
    }
  };

  window.testConnections = async function() {
    const btn = document.getElementById('test-btn');
    const res = document.getElementById('test-result');
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
    res.textContent = 'Testing…';
    try {
      const r = await fetch('/api/test-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF },
        body: JSON.stringify({
          smtpHost: get('smtp-host'), smtpPort: parseInt(get('smtp-port'), 10),
          imapHost: get('imap-host'), imapPort: parseInt(get('imap-port'), 10),
        }),
      });
      const data = await r.json();
      res.textContent = (data.smtp ? '✅ SMTP' : '❌ SMTP') + '  ' + (data.imap ? '✅ IMAP' : '❌ IMAP');
      res.style.color = (data.smtp && data.imap) ? 'var(--success)' : 'var(--danger)';
    } catch(e) {
      res.textContent = 'Error: ' + e.message;
      res.style.color = 'var(--danger)';
    } finally {
      btn.disabled = false; btn.textContent = 'Test Connections';
    }
  };

  // ── Permissions tab ───────────────────────────────────────────────────────
  function buildCategoryUI() {
    const container = document.getElementById('categories');
    if (!container) return;
    for (const [catKey, cat] of Object.entries(CATEGORIES)) {
      const el = document.createElement('div');
      el.className = 'category';
      el.innerHTML =
        '<div class="category-header" onclick="toggleCategory(this)">' +
          '<span class="caret">▶</span>' +
          '<div class="category-info">' +
            '<div class="name">' + escHtml(cat.label) + '</div>' +
            '<div class="desc">' + escHtml(cat.description) + '</div>' +
          '</div>' +
          '<span class="risk-badge risk-' + escHtml(cat.risk) + '">' + escHtml(cat.risk) + '</span>' +
          '<label class="toggle-wrap" onclick="event.stopPropagation()">' +
            '<span class="toggle"><input type="checkbox" id="cat-' + escHtml(catKey) + '" ' +
              'onchange="toggleCategory_all(\\'' + escHtml(catKey) + '\\',this.checked)"><span class="slider"></span></span>' +
            '<span style="font-size:12px;color:var(--muted)">All</span>' +
          '</label>' +
        '</div>' +
        '<div class="category-body" id="body-' + escHtml(catKey) + '">' +
          cat.tools.map(t => toolRow(t)).join('') +
        '</div>';
      container.appendChild(el);
    }
  }

  function toolRow(tool) {
    const label = tool.replace(/_/g,'  ').replace(/\\b\\w/g, c => c.toUpperCase());
    return '<div class="tool-row">' +
      '<span class="tool-name">' + escHtml(tool) + '</span>' +
      '<span style="font-size:12px;color:var(--muted);flex:1">' + escHtml(label) + '</span>' +
      '<div class="rate-wrap">' +
        '<label>Limit/hr</label>' +
        '<input class="rate-input" type="number" min="1" max="9999" placeholder="∞" ' +
          'id="rate-' + escHtml(tool) + '" title="Max calls per hour (blank = unlimited)">' +
      '</div>' +
      '<label class="toggle-wrap">' +
        '<span class="toggle"><input type="checkbox" id="tool-' + escHtml(tool) + '" ' +
          'onchange="onToolToggle(\\'' + escHtml(tool) + '\\',this.checked)"><span class="slider"></span></span>' +
      '</label>' +
    '</div>';
  }

  function populatePermissions(c) {
    if (!c) return;
    const perms = c.permissions || {};
    const tools = perms.tools || {};
    document.querySelectorAll('.preset-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.preset === perms.preset);
    });
    if (perms.preset === 'custom') {
      document.getElementById('custom-preset-btn').style.display = '';
    }
    for (const tool of ALL_TOOLS) {
      const perm  = tools[tool] || { enabled: true, rateLimit: null };
      const cbEl  = document.getElementById('tool-' + tool);
      const rateEl= document.getElementById('rate-' + tool);
      if (cbEl)   { cbEl.checked = perm.enabled !== false; toolEnabled[tool] = cbEl.checked; }
      if (rateEl) { rateEl.value = perm.rateLimit != null ? perm.rateLimit : ''; rateEl.disabled = !perm.enabled; toolRate[tool] = perm.rateLimit; }
    }
    for (const catKey of Object.keys(CATEGORIES)) { updateCategoryToggle(catKey); }
  }

  window.onToolToggle = function(tool, enabled) {
    toolEnabled[tool] = enabled;
    const rateEl = document.getElementById('rate-' + tool);
    if (rateEl) rateEl.disabled = !enabled;
    for (const [catKey, cat] of Object.entries(CATEGORIES)) {
      if (cat.tools.includes(tool)) { updateCategoryToggle(catKey); break; }
    }
    markCustomPreset();
  };

  window.toggleCategory_all = function(catKey, checked) {
    const cat = CATEGORIES[catKey];
    for (const tool of cat.tools) {
      const el = document.getElementById('tool-' + tool);
      if (el) { el.checked = checked; toolEnabled[tool] = checked; }
      const re = document.getElementById('rate-' + tool);
      if (re) re.disabled = !checked;
    }
    markCustomPreset();
  };

  window.toggleCategory = function(header) {
    header.classList.toggle('open');
    header.nextElementSibling.classList.toggle('open');
  };

  function updateCategoryToggle(catKey) {
    const cat = CATEGORIES[catKey];
    const allEnabled = cat.tools.every(t => {
      const el = document.getElementById('tool-' + t);
      return el ? el.checked : true;
    });
    const catEl = document.getElementById('cat-' + catKey);
    if (catEl) catEl.checked = allEnabled;
  }

  window.applyPreset = async function(preset) {
    const r = await fetch('/api/preset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF },
      body: JSON.stringify({ preset }),
    });
    if (!r.ok) { toast('Failed to apply preset', 'err'); return; }
    await refresh();
    document.getElementById('custom-preset-btn').style.display = 'none';
    toast('Preset "' + preset + '" applied.', 'ok');
  };

  function markCustomPreset() {
    document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
    const btn = document.getElementById('custom-preset-btn');
    btn.style.display = ''; btn.classList.add('active');
  }

  window.savePermissions = async function() {
    const tools = {};
    for (const tool of ALL_TOOLS) {
      const cbEl  = document.getElementById('tool-' + tool);
      const rateEl= document.getElementById('rate-' + tool);
      const enabled  = cbEl ? cbEl.checked : true;
      const rateVal  = rateEl && rateEl.value.trim() !== '' ? parseInt(rateEl.value, 10) : null;
      tools[tool] = { enabled, rateLimit: rateVal && rateVal > 0 ? rateVal : null };
    }
    let preset = 'custom';
    document.querySelectorAll('.preset-btn').forEach(b => {
      if (b.classList.contains('active') && b.dataset.preset !== 'custom') preset = b.dataset.preset;
    });
    const r = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF },
      body: JSON.stringify({ permissions: { preset, tools } }),
    });
    if (r.ok) { toast('Permissions saved. Changes take effect within 15 s.', 'ok'); await refresh(); }
    else       { toast('Save failed.', 'err'); }
  };

  // ── Status tab ────────────────────────────────────────────────────────────
  function populateStatus(c) {
    if (!c) return;
    const perms = c.permissions || {};
    const tools = perms.tools || {};
    document.getElementById('info-config-exists').textContent = 'Yes';
    document.getElementById('info-preset').textContent = perms.preset || '—';
    const disabled = ALL_TOOLS.filter(t => tools[t] && !tools[t].enabled);
    document.getElementById('info-disabled').textContent = disabled.length ? disabled.join(', ') : 'None';
    const limited = ALL_TOOLS.filter(t => tools[t] && tools[t].rateLimit != null);
    document.getElementById('info-rate-limited').textContent =
      limited.length ? limited.map(t => t + ' (' + tools[t].rateLimit + '/hr)').join(', ') : 'None';
    buildClaudeSnippet(c.connection || {});
  }

  function buildClaudeSnippet(cn) {
    const snippet = {
      protonmail: {
        command: 'node',
        args: ['/path/to/protonmail-mcp-server/dist/index.js'],
        env: {
          PROTONMAIL_USERNAME: cn.username || 'your@proton.me',
          PROTONMAIL_PASSWORD: '(your Bridge password)',
          PROTONMAIL_SMTP_HOST: cn.smtpHost || 'localhost',
          PROTONMAIL_SMTP_PORT: String(cn.smtpPort || 1025),
          PROTONMAIL_IMAP_HOST: cn.imapHost || 'localhost',
          PROTONMAIL_IMAP_PORT: String(cn.imapPort || 1143),
          ...(cn.bridgeCertPath ? { PROTONMAIL_BRIDGE_CERT: cn.bridgeCertPath } : {}),
          ...(cn.smtpToken      ? { PROTONMAIL_SMTP_TOKEN:  '(your SMTP token)' } : {}),
        },
      },
    };
    document.getElementById('claude-snippet').textContent = JSON.stringify(snippet, null, 2);
  }

  window.copySnippet = function() {
    const text = document.getElementById('claude-snippet').textContent;
    navigator.clipboard.writeText(text).then(() => toast('Copied to clipboard.', 'ok'));
  };

  window.runStatusCheck = async function() {
    const btn     = document.getElementById('status-check-btn');
    const res     = document.getElementById('status-check-result');
    const results = document.getElementById('connectivity-results');
    btn.disabled = true; btn.innerHTML = '<span class="spinner-dark"></span>';
    res.textContent = 'Checking…'; results.style.display = 'none';
    try {
      const c = (cfg && cfg.connection) || {};
      const r = await fetch('/api/test-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF },
        body: JSON.stringify({
          smtpHost: c.smtpHost || 'localhost', smtpPort: c.smtpPort || 1025,
          imapHost: c.imapHost || 'localhost', imapPort: c.imapPort || 1143,
        }),
      });
      const data = await r.json();
      document.getElementById('smtp-check-status').textContent = data.smtp ? '✅ Reachable' : '❌ Unreachable';
      document.getElementById('smtp-check-status').style.color = data.smtp ? 'var(--success)' : 'var(--danger)';
      document.getElementById('imap-check-status').textContent = data.imap ? '✅ Reachable' : '❌ Unreachable';
      document.getElementById('imap-check-status').style.color = data.imap ? 'var(--success)' : 'var(--danger)';
      results.style.display = ''; res.textContent = '';
    } catch(e) {
      res.textContent = 'Error: ' + e.message;
    } finally {
      btn.disabled = false; btn.textContent = 'Check Now';
    }
  };

  window.resetConfig = async function() {
    if (!confirm('Reset the config file to defaults? Current settings will be lost.')) return;
    const r = await fetch('/api/reset', { method: 'POST', headers: { 'X-CSRF-Token': CSRF } });
    if (r.ok) { toast('Config reset.', 'ok'); await refresh(); }
    else       { toast('Reset failed.', 'err'); }
  };

  // ── Escalation management ─────────────────────────────────────────────────
  async function loadEscalations() {
    try {
      const r = await fetch('/api/escalations', { headers: { 'X-CSRF-Token': CSRF } });
      const data = await r.json();
      renderEscalations(data.pending || []);
    } catch {}
  }

  async function loadAuditLog() {
    try {
      const r = await fetch('/api/audit', { headers: { 'X-CSRF-Token': CSRF } });
      const data = await r.json();
      renderAuditLog(data.entries || []);
    } catch {}
  }

  function renderEscalations(list) {
    const banner = document.getElementById('escalation-banner');
    const cards  = document.getElementById('escalation-cards');
    if (!list.length) { banner.style.display = 'none'; cards.innerHTML = ''; return; }
    banner.style.display = '';
    cards.innerHTML = list.map(e => {
      const newTools = e.newTools || [];
      const toolHtml = newTools.length
        ? '<div class="tool-chips">' + newTools.map(t => '<span class="tool-chip-new">' + escHtml(t) + '</span>').join('') + '</div>'
        : '<span style="color:var(--muted);font-size:12px">Rate-limit relaxation only — no new tool types.</span>';
      const riskClass = { read_only:'safe', send_only:'moderate', supervised:'moderate', full:'high' }[e.targetPreset] || 'moderate';
      return '<div class="escalation-card-body">' +
        '<div class="escalation-meta">Challenge ID: <code>' + escHtml(e.id) + '</code> &nbsp;·&nbsp; ' +
        'Requested: ' + new Date(e.requestedAt).toLocaleString() + '</div>' +
        '<div class="escalation-field"><label>Agent\\'s reason</label>' +
          '<div class="escalation-reason">' + escHtml(e.reason) + '</div></div>' +
        '<div class="escalation-field"><label>Privilege change</label>' +
          '<div class="escalation-preset-row">' +
            '<span class="preset-badge safe">' + escHtml(e.currentPreset) + '</span>' +
            '<span style="color:var(--muted)">→</span>' +
            '<span class="preset-badge ' + escHtml(riskClass) + '">' + escHtml(e.targetPreset) + '</span>' +
          '</div></div>' +
        '<div class="escalation-field"><label>New tools (' + newTools.length + ')</label>' + toolHtml + '</div>' +
        '<div class="escalation-confirm-wrap">' +
          '<label>Type APPROVE to enable the button</label>' +
          '<input class="escalation-confirm-input" type="text" id="conf-' + escHtml(e.id) + '" ' +
            'placeholder="APPROVE" autocomplete="off" spellcheck="false" ' +
            'oninput="onConfirmInput(\\'' + escHtml(e.id) + '\\')">' +
        '</div>' +
        '<div class="escalation-actions">' +
          '<button class="btn btn-deny" onclick="denyEscalation(\\'' + escHtml(e.id) + '\\')">✗ Deny</button>' +
          '<button class="btn btn-approve" id="approve-' + escHtml(e.id) + '" disabled ' +
            'onclick="approveEscalation(\\'' + escHtml(e.id) + '\\')">✓ Approve</button>' +
          '<span class="escalation-countdown" id="cd-' + escHtml(e.id) + '">' +
            formatCountdown(e.expiresAt) + '</span>' +
        '</div></div>';
    }).join('<hr style="border-color:var(--border);margin:0">');
    for (const e of list) { startCountdown(e.id, e.expiresAt); }
  }

  function renderAuditLog(entries) {
    const tbody = document.getElementById('audit-log-body');
    if (!tbody) return;
    if (!entries.length) {
      tbody.innerHTML = '<tr><td colspan="6" style="color:var(--muted);padding:12px 10px">No escalation events recorded yet.</td></tr>';
      return;
    }
    tbody.innerHTML = entries.map(e => {
      const cls = 'audit-event-' + escHtml(e.event);
      return '<tr>' +
        '<td>' + new Date(e.time).toLocaleString() + '</td>' +
        '<td class="' + cls + '">' + escHtml(e.event) + '</td>' +
        '<td>' + escHtml(e.fromPreset) + '</td>' +
        '<td>' + escHtml(e.toPreset) + '</td>' +
        '<td>' + escHtml(e.via || '—') + '</td>' +
        '<td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" ' +
          'title="' + escHtml(e.reason || '') + '">' + escHtml((e.reason || '—').slice(0,60)) + '</td>' +
      '</tr>';
    }).join('');
  }

  function formatCountdown(expiresAt) {
    const secs = Math.max(0, Math.round((new Date(expiresAt).getTime() - Date.now()) / 1000));
    return 'Expires in ' + Math.floor(secs/60) + ':' + String(secs%60).padStart(2,'0');
  }

  const countdownIntervals = {};
  function startCountdown(id, expiresAt) {
    if (countdownIntervals[id]) clearInterval(countdownIntervals[id]);
    countdownIntervals[id] = setInterval(() => {
      const el = document.getElementById('cd-' + id);
      if (!el) { clearInterval(countdownIntervals[id]); return; }
      const secs = Math.max(0, Math.round((new Date(expiresAt).getTime() - Date.now()) / 1000));
      el.textContent = 'Expires in ' + Math.floor(secs/60) + ':' + String(secs%60).padStart(2,'0');
      el.classList.toggle('urgent', secs < 60);
      if (secs === 0) { clearInterval(countdownIntervals[id]); loadEscalations(); }
    }, 1000);
  }

  window.onConfirmInput = function(id) {
    const input = document.getElementById('conf-' + id);
    const btn   = document.getElementById('approve-' + id);
    if (input && btn) btn.disabled = input.value !== 'APPROVE';
  };

  window.approveEscalation = async function(id) {
    const input = document.getElementById('conf-' + id);
    if (!input || input.value !== 'APPROVE') return;
    try {
      const r = await fetch('/api/escalations/' + id + '/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF },
        body: JSON.stringify({ confirm: 'APPROVE' }),
      });
      const d = await r.json();
      if (r.ok) {
        toast('Escalation approved. New preset: ' + d.preset + '. Takes effect within 15 s.', 'ok');
        await loadEscalations(); await loadAuditLog(); await refresh();
      } else {
        toast('Error: ' + (d.error || 'Unknown error'), 'err');
      }
    } catch(e) {
      toast('Network error: ' + e.message, 'err');
    }
  };

  window.denyEscalation = async function(id) {
    try {
      const r = await fetch('/api/escalations/' + id + '/deny', {
        method: 'POST', headers: { 'X-CSRF-Token': CSRF },
      });
      if (r.ok) {
        toast('Escalation denied.', 'ok');
        await loadEscalations(); await loadAuditLog();
      } else {
        const d = await r.json();
        toast('Error: ' + (d.error || 'Unknown error'), 'err');
      }
    } catch(e) {
      toast('Network error: ' + e.message, 'err');
    }
  };

  // ── Utilities ─────────────────────────────────────────────────────────────
  function get(id) { return document.getElementById(id)?.value ?? ''; }
  function set(id, v) { const el = document.getElementById(id); if (el) el.value = v; }

  function escHtml(s) {
    return String(s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  let toastTimer;
  function toast(msg, type) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = 'show ' + (type || '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = ''; }, 3500);
  }

})();
</script>
</body>
</html>`;
}

// ─── HTTP Server ───────────────────────────────────────────────────────────────

export interface ServerSecurityOptions {
  /** Port the server will listen on (needed for Origin validation). */
  port:        number;
  /** True when binding to 0.0.0.0 (LAN mode). */
  lan:         boolean;
  /** Access token required for every request in LAN mode. */
  accessToken: AccessToken | null;
  /**
   * Actual URI scheme the server is reachable on.
   * "https" when a self-signed cert was successfully generated; "http" otherwise.
   * Passed to isValidOrigin so browsers in TLS mode are accepted.
   */
  scheme:      "http" | "https";
}

export function createSettingsServer(secOpts: ServerSecurityOptions): http.Server {
  const { port, lan, accessToken, scheme } = secOpts;
  const configPath = getConfigPath();

  // ── Per-instance security objects ────────────────────────────────────────
  // CSRF: 32-byte random token embedded in HTML, required on all mutations.
  const csrfToken = randomBytes(32).toString("hex");

  // Rate limiters — keyed by client IP
  const generalLimiter    = new RateLimiter(GENERAL_RATE_LIMIT,    60_000); // 120/min
  const escalationLimiter = new RateLimiter(ESCALATION_RATE_LIMIT, 60_000); // 20/min

  function requireCsrf(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    const provided = req.headers["x-csrf-token"];
    // Use constant-time comparison to prevent timing-based brute-force of the
    // CSRF token.  `timingSafeEqual` requires equal-length buffers; a length
    // mismatch is itself a definitive rejection and reveals no secret bits.
    const valid =
      typeof provided === "string" &&
      provided.length === csrfToken.length &&
      timingSafeEqual(Buffer.from(provided, "utf8"), Buffer.from(csrfToken, "utf8"));
    if (valid) return true;
    json(res, 403, { error: "Missing or invalid CSRF token. Load the settings page in a browser first." });
    return false;
  }

  function requireOrigin(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    if (isValidOrigin(req, port, lan, scheme)) return true;
    json(res, 403, { error: "Origin not permitted." });
    return false;
  }

  // ── Request handler ───────────────────────────────────────────────────────
  const handler: http.RequestListener = async (req, res) => {
    const url    = new URL(req.url ?? "/", `http://localhost`);
    const path   = url.pathname;
    const method = req.method ?? "GET";
    const ip     = clientIP(req);

    // ── Security headers ────────────────────────────────────────────────────
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options",        "DENY");
    res.setHeader("Referrer-Policy",        "no-referrer");
    res.setHeader("Cache-Control",          "no-store");
    // Never use ACAO: * — a wildcard allows any page on the network to make
    // credentialed cross-origin requests and read the responses, defeating the
    // origin-check and access-token gates in LAN mode.  Instead reflect the
    // request Origin only if it passes the isValidOrigin() check; otherwise
    // fall back to the expected localhost origin so the CORS policy stays tight.
    {
      const reqOrigin = req.headers["origin"] as string | undefined;
      const allowedOrigin =
        reqOrigin && isValidOrigin(req, port, lan, scheme)
          ? reqOrigin
          : `${scheme}://localhost:${port}`;
      res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
      // Vary: Origin so caches do not serve the wrong ACAO value to other origins.
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Strict-Transport-Security",    "max-age=31536000");

    // ── CORS preflight ──────────────────────────────────────────────────────
    if (method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-CSRF-Token, X-Access-Token");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.writeHead(204); res.end();
      return;
    }

    // ── LAN access token ────────────────────────────────────────────────────
    // In LAN mode every request must carry the access token so that other
    // devices on the network cannot read config or approve escalations.
    if (lan && accessToken && path !== "/") {
      if (!hasValidAccessToken(req, url, accessToken)) {
        json(res, 401, { error: "Access denied. Include the X-Access-Token header or ?token= query param." });
        return;
      }
    }

    // ── General rate limiting ───────────────────────────────────────────────
    if (!generalLimiter.check(ip)) {
      json(res, 429, { error: "Too many requests. Please slow down." });
      return;
    }

    try {
      // ── Serve UI ────────────────────────────────────────────────────────
      if (method === "GET" && path === "/") {
        const html = buildHtml(configPath, csrfToken);
        res.writeHead(200, {
          "Content-Type":             "text/html; charset=utf-8",
          "Content-Security-Policy":  "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
          "X-Content-Type-Options":   "nosniff",
          "X-Frame-Options":          "DENY",
          "Referrer-Policy":          "no-referrer",
          "Cache-Control":            "no-store, no-cache, must-revalidate",
        });
        res.end(html);
        return;
      }

      // ── GET /api/status ───────────────────────────────────────────────────
      if (method === "GET" && path === "/api/status") {
        json(res, 200, { hasConfig: configExists() });
        return;
      }

      // ── GET /api/config ───────────────────────────────────────────────────
      if (method === "GET" && path === "/api/config") {
        const cfg = loadConfig() ?? defaultConfig();
        json(res, 200, safeConfig(cfg));
        return;
      }

      // ── POST /api/config ──────────────────────────────────────────────────
      if (method === "POST" && path === "/api/config") {
        if (!requireCsrf(req, res)) return;
        let body: any;
        try { body = JSON.parse(await readBodySafe(req)); } catch { json(res, 400, { error: "Request body must be valid JSON." }); return; }
        const current = loadConfig() ?? defaultConfig();

        // Merge connection settings — never overwrite password with placeholder/empty
        if (body.connection) {
          const c = body.connection;

          // Validate port values: must be integers in 1–65535.
          // Reject rather than silently clamp so the user sees an error.
          const validPort = (v: unknown): v is number =>
            typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 65535;
          if (c.smtpPort !== undefined && c.smtpPort !== null && !validPort(c.smtpPort)) {
            json(res, 400, { error: `Invalid smtpPort: must be an integer between 1 and 65535.` }); return;
          }
          if (c.imapPort !== undefined && c.imapPort !== null && !validPort(c.imapPort)) {
            json(res, 400, { error: `Invalid imapPort: must be an integer between 1 and 65535.` }); return;
          }

          // Validate hostnames: must be non-empty strings, max 253 chars, no control
          // characters, no whitespace.  This prevents log injection and CRLF smuggling
          // via a crafted hostname stored in the config file.
          const validHost = (h: unknown): h is string =>
            typeof h === "string" && h.length > 0 && h.length <= 253 &&
            !/[\x00-\x1f\x7f\s]/.test(h);
          if (c.smtpHost !== undefined && c.smtpHost !== null && !validHost(c.smtpHost)) {
            json(res, 400, { error: "Invalid smtpHost: must be a non-empty string with no control characters (max 253 chars)." }); return;
          }
          if (c.imapHost !== undefined && c.imapHost !== null && !validHost(c.imapHost)) {
            json(res, 400, { error: "Invalid imapHost: must be a non-empty string with no control characters (max 253 chars)." }); return;
          }

          current.connection = {
            ...current.connection,
            smtpHost:       validHost(c.smtpHost) ? c.smtpHost : current.connection.smtpHost,
            smtpPort:       c.smtpPort       ?? current.connection.smtpPort,
            imapHost:       validHost(c.imapHost) ? c.imapHost : current.connection.imapHost,
            imapPort:       c.imapPort       ?? current.connection.imapPort,
            username:       typeof c.username === "string" ? c.username : current.connection.username,
            bridgeCertPath: typeof c.bridgeCertPath === "string" ? c.bridgeCertPath : current.connection.bridgeCertPath,
            debug:          typeof c.debug === "boolean" ? c.debug : current.connection.debug,
            // Only overwrite credentials if a non-empty, non-placeholder value was sent
            ...(c.password  && c.password !== "••••••••"  ? { password:  c.password  } : {}),
            ...(c.smtpToken && c.smtpToken !== "••••••••" ? { smtpToken: c.smtpToken } : {}),
          };
        }

        // Merge permissions
        if (body.permissions) {
          current.permissions = {
            preset: body.permissions.preset ?? current.permissions.preset,
            tools:  { ...current.permissions.tools, ...(body.permissions.tools ?? {}) },
          };
        }

        // Try to store credentials in OS keychain; fall back to config file
        const credStorage = await saveConfigWithCredentials(current);
        json(res, 200, { ok: true, credentialStorage: credStorage });
        return;
      }

      // ── POST /api/preset ──────────────────────────────────────────────────
      if (method === "POST" && path === "/api/preset") {
        if (!requireCsrf(req, res)) return;
        let _presetBody: { preset: string };
        try { _presetBody = JSON.parse(await readBodySafe(req)); } catch { json(res, 400, { error: "Request body must be valid JSON." }); return; }
        const { preset } = _presetBody;
        const validPresets = ["full", "read_only", "supervised", "send_only", "custom"];
        if (!validPresets.includes(preset)) {
          json(res, 400, { error: "Invalid preset" });
          return;
        }
        const current = loadConfig() ?? defaultConfig();
        current.permissions = buildPermissions(preset as PermissionPreset);
        saveConfig(current);
        json(res, 200, { ok: true });
        return;
      }

      // ── POST /api/test-connection ─────────────────────────────────────────
      // Requires CSRF to prevent cross-site abuse, even though this endpoint
      // is read-only (it does open TCP connections, which is a side-effect).
      // Host allow-list blocks SSRF probing of internal/cloud-metadata services.
      if (method === "POST" && path === "/api/test-connection") {
        if (!requireCsrf(req, res)) return;
        let body: any;
        try { body = JSON.parse(await readBodySafe(req)); } catch { json(res, 400, { error: "Request body must be valid JSON." }); return; }
        const { smtpHost, smtpPort, imapHost, imapPort } = body;

        // Port validation
        const validPort = (v: unknown): v is number =>
          typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 65535;
        if (!validPort(smtpPort) || !validPort(imapPort)) {
          json(res, 400, { error: "Ports must be integers between 1 and 65535." }); return;
        }

        // Host allow-list: only localhost and private-LAN addresses may be tested.
        // This prevents SSRF probing of cloud-metadata endpoints (169.254.169.254),
        // internal services, or arbitrary internet hosts.
        const ALLOWED_HOST_RE =
          /^(?:localhost|127\.0\.0\.1|::1|(?:192\.168|10)\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/;
        if (typeof smtpHost !== "string" || !ALLOWED_HOST_RE.test(smtpHost)) {
          json(res, 400, { error: "smtpHost must be localhost or a private LAN address." }); return;
        }
        if (typeof imapHost !== "string" || !ALLOWED_HOST_RE.test(imapHost)) {
          json(res, 400, { error: "imapHost must be localhost or a private LAN address." }); return;
        }

        const [smtp, imap] = await Promise.all([
          tcpCheck(smtpHost, smtpPort),
          tcpCheck(imapHost, imapPort),
        ]);
        json(res, 200, { smtp, imap });
        return;
      }

      // ── POST /api/reset ───────────────────────────────────────────────────
      if (method === "POST" && path === "/api/reset") {
        if (!requireCsrf(req, res)) return;
        saveConfig(defaultConfig());
        json(res, 200, { ok: true });
        return;
      }

      // ── GET /api/escalations ──────────────────────────────────────────────
      // Returns current pending escalations for display in the browser UI.
      // Read-only — no CSRF needed for reads.
      if (method === "GET" && path === "/api/escalations") {
        json(res, 200, { pending: getPendingEscalations() });
        return;
      }

      // ── GET /api/audit ────────────────────────────────────────────────────
      if (method === "GET" && path === "/api/audit") {
        json(res, 200, { entries: getAuditLog(100) });
        return;
      }

      // ── POST /api/escalations/:id/approve ────────────────────────────────
      // Four-layer gate:
      //   1. Escalation-specific rate limit (20/min per IP)
      //   2. Valid CSRF token   — requires loading the HTML page first
      //   3. Valid Origin header — defence-in-depth alongside CSRF
      //   4. Typed confirmation  — body.confirm must equal "APPROVE" exactly
      if (method === "POST" && /^\/api\/escalations\/[0-9a-f]{32}\/approve$/.test(path)) {
        if (!escalationLimiter.check(`${ip}:approve`)) {
          json(res, 429, { error: "Too many approval attempts." }); return;
        }
        if (!requireCsrf(req, res))   return;
        if (!requireOrigin(req, res)) return;

        const id = path.split("/")[3];
        // Re-validate the ID format before using it (path regex already covers this,
        // but defence-in-depth: never trust data derived from user input).
        if (!isValidChallengeId(id)) {
          json(res, 400, { error: "Invalid challenge ID format." }); return;
        }

        let body: any;
        try { body = JSON.parse(await readBodySafe(req)); } catch { json(res, 400, { error: "Request body must be valid JSON." }); return; }

        // Server-side enforcement — JS client validation is not reliable.
        if (body.confirm !== "APPROVE") {
          json(res, 400, { error: "Confirmation text must be exactly 'APPROVE' (case-sensitive)." });
          return;
        }

        const result = approveEscalation(id, "browser_ui");
        if (!result.ok) {
          json(res, 400, { error: result.error });
          return;
        }

        const cfg = loadConfig() ?? defaultConfig();
        cfg.permissions = buildPermissions(result.targetPreset);
        saveConfig(cfg);

        json(res, 200, { ok: true, preset: result.targetPreset });
        return;
      }

      // ── POST /api/escalations/:id/deny ───────────────────────────────────
      if (method === "POST" && /^\/api\/escalations\/[0-9a-f]{32}\/deny$/.test(path)) {
        if (!escalationLimiter.check(`${ip}:deny`)) {
          json(res, 429, { error: "Too many denial attempts." }); return;
        }
        if (!requireCsrf(req, res))   return;
        if (!requireOrigin(req, res)) return;

        const id = path.split("/")[3];
        if (!isValidChallengeId(id)) {
          json(res, 400, { error: "Invalid challenge ID format." }); return;
        }

        const result = denyEscalation(id, "browser_ui");
        if (!result.ok) { json(res, 400, { error: result.error }); return; }
        json(res, 200, { ok: true });
        return;
      }

      json(res, 404, { error: "Not found" });
    } catch (err: any) {
      // Never reflect raw error messages to callers (information disclosure).
      const isOversize = (err as any)?.code === "TOO_LARGE";
      const isTimeout  = (err as any)?.code === "TIMEOUT";
      const status = isOversize || isTimeout ? 400 : 500;
      const msg    = isOversize ? "Request body too large."
                   : isTimeout  ? "Request timed out."
                   : "Internal server error.";
      json(res, status, { error: msg });
    }
  };

  const server = http.createServer(handler);

  // ── Server-level DoS mitigations ───────────────────────────────────────────
  // headersTimeout: abort if the client hasn't finished sending HTTP headers
  // within 10 s (defeats Slow Loris header-starvation attacks).
  server.headersTimeout  = 10_000;
  // requestTimeout: abort the entire request after 30 s.
  server.requestTimeout  = 30_000;
  // Hard cap on simultaneous connections.
  server.maxConnections  = 50;

  return server;
}

/**
 * Start the settings HTTP(S) server.
 *
 * Local mode  (default): binds to 127.0.0.1 over plain HTTP.
 *             Only the local machine can reach it; no token required.
 *
 * LAN mode (--lan flag): binds to 0.0.0.0.
 *             • Attempts to generate a self-signed TLS cert via openssl.
 *               If successful, starts an HTTPS server and prints the cert
 *               fingerprint so the user can verify it in the browser.
 *             • Generates a 256-bit single-use access token displayed in the
 *               terminal; every non-root request must carry it via
 *               X-Access-Token header or ?token= query param.
 *             • Falls back to plain HTTP + token if openssl is absent.
 *             Use only on trusted local networks.
 *
 * @param port  TCP port to listen on (default 8765)
 * @param lan   Enable LAN mode (bind 0.0.0.0 + token + optional TLS)
 */
export async function startSettingsServer(
  port = 8765,
  lan  = false,
): Promise<{ scheme: "http" | "https" }> {
  const bindHost    = lan ? "0.0.0.0" : "127.0.0.1";
  const lanIP       = lan ? getPrimaryLanIP() : "";
  const accessToken = lan ? generateAccessToken() : null;
  let   tls: TlsCredentials | null = null;

  if (lan) {
    process.stdout.write("  Generating TLS certificate for LAN mode… ");
    tls = tryGenerateSelfSignedCert();
    process.stdout.write(tls ? "done.\n" : "openssl not found — using HTTP + access token.\n");
  }

  const scheme: "http" | "https" = tls ? "https" : "http";
  const secOpts: ServerSecurityOptions = { port, lan, accessToken, scheme };
  const appHandler = createSettingsServer(secOpts);

  // Wrap in HTTPS if we have a cert; otherwise use the plain HTTP server.
  // Extract the request listener from appHandler so https.createServer can
  // accept it — both http.Server and https.Server share net.Server.listen().
  type AnyServer = { headersTimeout?: number; requestTimeout?: number; maxConnections?: number;
                     on(e: string, l: (...a: unknown[]) => unknown): unknown;
                     listen(port: number, host: string, cb: () => void): unknown; };
  let server: AnyServer;

  if (tls) {
    const reqListener: http.RequestListener = (req, res) => {
      appHandler.emit("request", req, res);
    };
    const httpsServer = https.createServer({ key: tls.key, cert: tls.cert }, reqListener);
    // Mirror the DOS guards onto the HTTPS wrapper
    httpsServer.headersTimeout = 10_000;
    httpsServer.requestTimeout = 30_000;
    (httpsServer as unknown as { maxConnections: number }).maxConnections = 50;
    server = httpsServer as unknown as AnyServer;
  } else {
    server = appHandler as unknown as AnyServer;
  }

  await new Promise<void>((resolve, reject) => {
    server.on("error", reject as (...a: unknown[]) => unknown);
    server.listen(port, bindHost, () => resolve());
  });

  // ── Startup banner ────────────────────────────────────────────────────────
  const localUrl  = `${scheme}://localhost:${port}`;
  const lanUrl    = lan && lanIP ? `${scheme}://${lanIP}:${port}` : null;
  const tokenUrl  = lanUrl && accessToken
    ? `${lanUrl}?token=${accessToken.value}`
    : null;
  const w = 52; // banner inner width

  const line  = (s: string) => console.log(`  │ ${s.padEnd(w)} │`);
  const blank = ()           => console.log(`  │ ${" ".repeat(w)} │`);
  const rule  = (ch: string) => console.log(`  ├${"─".repeat(w + 2)}┤`);
  void rule; // used below

  console.log("");
  console.log(`  ┌${"─".repeat(w + 2)}┐`);
  line("ProtonMail MCP — Settings UI");
  blank();
  line(`Local:   ${localUrl}`);

  if (lanUrl) {
    blank();
    line(`Network: ${lanUrl}`);
    if (tokenUrl) {
      line(`(with token) ${tokenUrl.slice(0, w - 13)}`);
    }
    line("↑ Open on phone/tablet to approve escalations");
  }

  blank();
  line(`Config:  ${getConfigPath().slice(0, w - 9)}`);
  blank();

  if (accessToken) {
    console.log(`  ├${"─".repeat(w + 2)}┤`);
    line("ACCESS TOKEN (share only with trusted devices):");
    line(`  Fingerprint: ${accessToken.fingerprint}`);
    line("  Full token shown once — copy it now:");
    // Show full token split for readability
    const tok = accessToken.value;
    line(`  ${tok.slice(0, 32)}`);
    line(`  ${tok.slice(32)}`);
    blank();
  }

  if (tls) {
    console.log(`  ├${"─".repeat(w + 2)}┤`);
    line("TLS CERTIFICATE FINGERPRINT (SHA-256):");
    // Split 95-char fingerprint across two lines
    const fp = tls.fingerprint;
    const mid = Math.ceil(fp.length / 2);
    line(`  ${fp.slice(0, mid)}`);
    line(`  ${fp.slice(mid)}`);
    line("Verify this in your browser before trusting the page.");
    blank();
  }

  console.log(`  ├${"─".repeat(w + 2)}┤`);
  line("Press Ctrl+C to stop.");
  console.log(`  └${"─".repeat(w + 2)}┘`);
  console.log("");

  if (lan && !tls) {
    console.log("  ⚠  WARNING: LAN mode is running over plain HTTP.");
    console.log("     Traffic is NOT encrypted. Use --lan only on a");
    console.log("     trusted private network, or install openssl to");
    console.log("     enable automatic TLS.\n");
  }

  return { scheme };
}
