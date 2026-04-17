# ProtonMail Agentic MCP

[![CI](https://github.com/chandshy/protonmail-agentic-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/chandshy/protonmail-agentic-mcp/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/badge/npm-v2.0.4-blue.svg)](https://www.npmjs.com/package/protonmail-agentic-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)
[![MCP SDK](https://img.shields.io/badge/MCP%20SDK-1.27+-green.svg)](https://github.com/modelcontextprotocol/sdk)
[![Tests](https://img.shields.io/badge/tests-1%2C251%20passing-brightgreen.svg)](#development)

**Read, compose, and manage your encrypted ProtonMail inbox from any AI assistant — with human-controlled permissions.**

---

## What It Does

ProtonMail encrypts your email end-to-end, which means no third-party API can read it. [Proton Bridge](https://proton.me/mail/bridge) solves this by decrypting email locally. This MCP server connects to Bridge and gives Claude (or any MCP host) structured, permission-gated access to your inbox.

Your emails are decrypted on your own machine by Proton Bridge. This server never stores email content — everything stays in memory and is cleared on restart. You control exactly what the AI can do through a preset permission system with human-gated escalation for anything sensitive.

---

## Key Features

- **51 tools** covering reading, search, analytics, sending, scheduling, drafts, folders, labels, bulk operations, and Bridge/server lifecycle control (49 permission-managed + 2 always-available escalation tools)
- **5 permission presets** — read-only by default; write access requires explicit opt-in
- **Human-gated escalation** — agents request elevated permissions, you approve via browser UI or terminal; the agent cannot approve its own requests
- **Browser-based settings UI** at `localhost:8765` — auto-starts with the daemon; setup wizard, live connection test, per-tool toggles, escalation approval panel
- **System tray icon** — always visible; toggle the settings UI on/off or quit from the tray without touching the terminal
- **5 MCP prompts** — triage inbox, compose reply, daily briefing, find subscriptions, thread summary
- **MCP Resources** — individual emails and folders addressable via `email://` and `folder://` URIs
- **Scheduled email delivery** — queue emails for future sending, survives server restarts
- **10-layer security model** — CSRF protection, origin validation, CRLF injection prevention, path traversal guards, rate limiting, audit log
- **1,251 tests passing** — comprehensive unit coverage (96% line coverage, 95% branch coverage) including all security validation paths
- **Zero `any` type annotations** in production TypeScript source

---

## Quick Start

Ask Claude things like:

```
"Summarize everything from my boss this week"
"Find emails about my Acme invoice and draft a reply"
"Move all order confirmations to my Shopping folder"
"What's my average email response time this month?"
"Schedule a follow-up email to alice@example.com for next Monday at 9am"
```

With read-only permissions (the default), Claude can read, search, and analyse your inbox but cannot send, move, delete, or change anything.

---

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| **Node.js** | >= 20.0.0 | Check with `node --version` · [nodejs.org](https://nodejs.org) |
| **npm** | >= 9.0.0 | Bundled with Node.js |
| **Proton Bridge** | Latest | Must be running and signed in · [proton.me/mail/bridge](https://proton.me/mail/bridge) |
| **ProtonMail account** | Any plan | Free accounts supported |
| **Claude Desktop** | Latest | Or any MCP-compatible host · [claude.ai/download](https://claude.ai/download) |

Supported on macOS, Windows, and Linux.

### Proton Bridge ports

Bridge listens locally on:

| Protocol | Host | Port |
|---|---|---|
| SMTP (sending) | `127.0.0.1` | `1025` |
| IMAP (reading) | `127.0.0.1` | `1143` |

> Use `127.0.0.1`, not `localhost`. On some systems `localhost` resolves to `::1` (IPv6), which Bridge does not listen on.

---

## Installation

### Option A — npm (recommended)

```bash
npm install -g github:chandshy/protonmail-agentic-mcp
```

### Option B — From source

```bash
git clone https://github.com/chandshy/protonmail-agentic-mcp.git
cd protonmail-agentic-mcp
npm install
npm run build
```

---

## Setup Wizard

Run the settings server to complete first-time setup:

```bash
npx protonmail-agentic-mcp-settings
# Then open http://localhost:8765
```

The **6-step wizard** walks you through everything automatically:

1. **Welcome** — overview and prerequisites checklist
2. **Bridge health check** — live TCP test to ports 1025 and 1143; blocks progress until Bridge is reachable
3. **Credentials** — your ProtonMail address and Bridge password (found in Bridge app under Settings → IMAP/SMTP → Password — this is **not** your ProtonMail login password)
4. **Permission preset** — choose what the AI is allowed to do (see table below)
5. **Review** — confirm your settings before saving
6. **Done** — displays the exact JSON snippet to paste into your Claude Desktop config; optionally writes it for you automatically

Settings are saved to `~/.protonmail-mcp.json` with mode `0600` (owner read/write only).

---

## Claude Desktop Configuration

**Use the settings wizard to get the correct snippet for your machine.** The final step of the wizard (or the Status tab → MCP Config Snippet) generates and copies the exact JSON to use — the path to the installed package differs per machine and OS, so a static snippet here would be wrong.

The config file locations are:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux:** `~/.config/Claude/claude_desktop_config.json`

The generated entry looks like this (your path will differ):

```json
{
  "mcpServers": {
    "protonmail": {
      "command": "node",
      "args": ["/path/to/node_modules/protonmail-agentic-mcp/dist/index.js"]
    }
  }
}
```

The wizard can also write this entry to your Claude Desktop config automatically — click **Write to Claude Desktop** on the Done step. Restart Claude Desktop after saving.

### Environment variables

Configuration (credentials, SMTP/IMAP hosts, etc.) is stored in `~/.protonmail-mcp.json` and managed via the settings UI — not environment variables. The following env vars are available for advanced/optional overrides:

| Variable | Default | Description |
|---|---|---|
| `PROTONMAIL_MCP_CONFIG` | `~/.protonmail-mcp.json` | Override config file path |
| `PROTONMAIL_SCHEDULER_STORE` | `~/.protonmail-mcp-scheduled.json` | Scheduled email persistence file |
| `PROTONMAIL_LOG_FILE` | `~/.protonmail-mcp.log` | Override log file path |
| `PROTONMAIL_MCP_PENDING` | `~/.protonmail-mcp.pending.json` | Override pending escalations file path |
| `PROTONMAIL_MCP_AUDIT` | `~/.protonmail-mcp.audit.jsonl` | Override escalation audit log path |
| `PORT` | `8765` | Override settings UI HTTP server port |

---

## Available Tools

51 tools across 9 categories.

### Reading — always available

| Tool | Description |
|---|---|
| `get_emails` | Fetch emails from any folder with cursor-based pagination |
| `get_email_by_id` | Fetch a single email with full body and headers |
| `search_emails` | Search by subject, sender, body, date range, read status, attachments; pass `folders: ["*"]` to search all folders |
| `get_folders` | List all folders with message and unread counts |
| `get_unread_count` | Fast per-folder unread count — call before `get_emails` to avoid unnecessary fetches |
| `list_labels` | List all ProtonMail labels with message counts |
| `get_emails_by_label` | Fetch emails from a specific label folder with cursor pagination |
| `download_attachment` | Download attachment content as base64 (use the index from `get_email_by_id`) |

### Analytics — always available

| Tool | Description |
|---|---|
| `get_email_stats` | Total, unread, sent, starred counts and cache status |
| `get_email_analytics` | Full analytics: top senders, volume trends, response time stats |
| `get_contacts` | Contact interaction frequency (received from / sent to) |
| `get_volume_trends` | Email volume by day of week and hour of day |

### System — always available

| Tool | Description |
|---|---|
| `get_connection_status` | SMTP/IMAP health including live NOOP probe (`imap.healthy`), `insecureTls` flags, config path, and current preset |
| `get_logs` | Recent server log entries for debugging |
| `sync_emails` | Refresh the email cache from IMAP (configurable limit, default 100) |
| `clear_cache` | Clear the in-memory email and analytics cache |

### Sending — requires `supervised`, `send_only`, or `full`

| Tool | Description |
|---|---|
| `send_email` | Send email with HTML/text body, attachments, CC, BCC, reply-to |
| `send_test_email` | Send a test email to verify SMTP connectivity |
| `reply_to_email` | Reply with correct `In-Reply-To` and `References` headers for proper threading |
| `forward_email` | Forward an email to new recipients with an optional prepended message |

### Drafts & Scheduling — requires `supervised`, `send_only`, or `full`

| Tool | Description |
|---|---|
| `save_draft` | Save an email as a draft via IMAP APPEND to the Drafts folder |
| `schedule_email` | Queue an email for delivery at a future time (ISO 8601, 60 s – 30 days out); survives server restarts |
| `list_scheduled_emails` | List all MCP-scheduled emails with status and retry count |
| `list_proton_scheduled` | List emails natively scheduled via the Proton Mail app (reads the "All Scheduled" IMAP folder) |
| `cancel_scheduled_email` | Cancel a pending scheduled email before it sends |

### Actions — requires `supervised` or `full`

| Tool | Description |
|---|---|
| `mark_email_read` | Mark one email read or unread |
| `star_email` | Star or unstar an email |
| `move_email` | Move an email to any folder |
| `archive_email` | Move an email to the Archive folder |
| `move_to_trash` | Move an email to Trash |
| `move_to_spam` | Move an email to Spam |
| `move_to_folder` | Move an email to a custom folder (`Folders/<name>`) |
| `move_to_label` | Apply a ProtonMail label to an email (`Labels/<name>`) |
| `remove_label` | Remove a label and move the email back to INBOX (or a specified folder) |
| `bulk_mark_read` | Mark up to 200 emails read/unread |
| `bulk_star` | Star/unstar up to 200 emails |
| `bulk_move_emails` | Move up to 200 emails to a folder |
| `bulk_move_to_label` | Apply a label to up to 200 emails |
| `bulk_remove_label` | Remove a label from up to 200 emails |

### Folders — requires `supervised` or `full`

| Tool | Description |
|---|---|
| `sync_folders` | Refresh the folder list from IMAP |
| `create_folder` | Create a new folder or label |
| `rename_folder` | Rename an existing folder |
| `delete_folder` | Delete a folder (must be empty first) |

### Deletion — requires `full` (capped at 5/hr under `supervised`)

| Tool | Description |
|---|---|
| `delete_email` | Permanently delete an email |
| `bulk_delete_emails` | Permanently delete up to 200 emails |
| `bulk_delete` | Alias for `bulk_delete_emails` |

### Bridge & Server Control

| Tool | Description | Permission |
|---|---|---|
| `start_bridge` | Launch Proton Mail Bridge if it is not running; waits up to 15 s for SMTP/IMAP ports to become reachable | Always available |
| `shutdown_server` | Gracefully shut down the MCP server — terminates Bridge, disconnects IMAP/SMTP, scrubs credentials from memory | `supervised` or `full` (capped at 2/hr in supervised) |
| `restart_server` | Terminate Bridge, shut down the current process, and spawn a fresh MCP server process; Bridge is re-launched automatically if `autoStartBridge` is enabled | `supervised` or `full` (capped at 2/hr in supervised) |

> **Auto-start & watchdog:** If `autoStartBridge` is enabled in settings, the server launches Bridge automatically on startup and runs a background watchdog every 30 s that will attempt up to 3 restarts if Bridge becomes unreachable.

### Escalation — always available

| Tool | Description |
|---|---|
| `request_permission_escalation` | Ask the human to grant a higher permission preset temporarily |
| `check_escalation_status` | Poll the status of a pending escalation challenge |

---

## MCP Prompts

Pre-built prompt templates for common tasks:

| Prompt | Description | Arguments |
|---|---|---|
| `triage_inbox` | Review unread emails, assess urgency, and suggest actions (reply / archive / delete / snooze) | `limit` (default 20), `focus` (sender or topic to prioritize) |
| `compose_reply` | Draft a contextual reply to an email thread | `emailId` (required), `intent` |
| `daily_briefing` | Summarize today's inbox: unread count, key senders, action items, deadline mentions | — |
| `find_subscriptions` | Identify mailing lists and newsletters, and offer to archive or unsubscribe | `folder` (default: INBOX) |
| `thread_summary` | Fetch all messages in a thread and produce a concise summary with open action items | `emailId` (required) |

---

## Permission Presets

| Preset | What's allowed | Best for |
|---|---|---|
| **Read-Only** *(default)* | Read, search, analytics, connection status, logs, Bridge start | Starting out; untrusted or new agents |
| **Supervised** | All tools; deletion 5/hr, sending 20/hr, bulk actions 10/hr, server lifecycle 2/hr; read-heavy tools also rate-limited (`get_emails` 60/hr, `search_emails` 30/hr, `get_email_by_id` 200/hr) | Day-to-day agentic use |
| **Send-Only** | Reading + sending + drafts + scheduling + `get_folders` + `get_connection_status` + `get_logs` + Bridge start; no deletion, no folder writes, no server lifecycle | Agents that only need to compose and send |
| **Full Access** | All tools, no rate limits | Trusted workflows where you review actions |
| **Custom** | User-defined per-tool toggles and rate limits (set via the Permissions tab) | Advanced: fine-grained control beyond the 4 presets |

Change the preset at any time from the **Permissions** tab in the settings UI.

---

## Human-Gated Escalation

The escalation system lets an agent request broader permissions without permanently changing your settings.

**How it works:**

1. The agent calls `request_permission_escalation` with a reason and the target preset it needs.
2. A challenge appears as a banner in the Settings UI (above the tabs) and is also printed to the terminal.
3. You review the request, type `APPROVE` in the confirmation field, and click Approve (or Deny).
4. The agent polls with `check_escalation_status` and proceeds once approved.
5. After 5 minutes, permissions revert automatically.

**Security properties:**
- The agent requests via MCP (unattended process); approval can only happen via browser or terminal — channels the agent cannot write to
- You must type `APPROVE` before the button activates — no accidental clicks
- CSRF-protected: the approval API requires a session token embedded only in the rendered HTML page
- Rate-limited: max 5 escalation requests per hour, max 1 pending at a time
- Audit trail: every request, approval, and denial is appended to `~/.protonmail-mcp.audit.jsonl`
- Approve from another device: `npx protonmail-agentic-mcp-settings --lan`

---

## Settings UI

The settings UI starts automatically on `http://localhost:8765` whenever Claude Desktop runs the MCP server. A system tray icon (purple envelope) appears in your taskbar — right-click it to open the UI, disable it temporarily, or quit.

To run the settings UI standalone (useful for initial setup before Claude Desktop is configured, or on headless/SSH systems):

```bash
npx protonmail-agentic-mcp-settings           # auto-detects display; opens browser if available
npx protonmail-agentic-mcp-settings --port 9000   # custom port (default: 8765)
npx protonmail-agentic-mcp-settings --lan         # bind to 0.0.0.0 (approve from phone/other device)
npx protonmail-agentic-mcp-settings --browser     # force browser UI even if no display detected
npx protonmail-agentic-mcp-settings --tui         # force interactive terminal UI
npx protonmail-agentic-mcp-settings --plain       # plain readline menus (no ANSI colors/escapes)
npx protonmail-agentic-mcp-settings --no-open     # start server but don't auto-open browser
```

The port can also be overridden with the `PORT` environment variable, or saved persistently via the settings UI itself.

Three tabs:

- **Setup** — credentials, SMTP/IMAP hosts and ports, Bridge TLS certificate, debug mode
- **Permissions** — preset selector and per-tool enable/rate-limit toggles
- **Status** — server info, Claude Desktop config snippet, live connectivity check, escalation audit log, config reset

Pending escalation requests appear as a full-page banner above the tabs — no separate tab needed. A **Logs** tab also appears automatically when debug mode is enabled.

Changes take effect in the running MCP server within 15 seconds — no restart required.

---

## Security

This server gives AI agents *controlled* access to sensitive email data. The security model has 10 layers:

| Layer | Mechanism |
|---|---|
| Permission gate | Every tool call checked against `~/.protonmail-mcp.json` (refreshed every 15 s) |
| Rate limiting | Per-tool sliding-window rate limits enforced in the MCP server process |
| Escalation gate | Privilege increases require explicit human approval via a separate channel |
| Audit log | Append-only log of all escalation events at `~/.protonmail-mcp.audit.jsonl` |
| CSRF protection | All mutating settings API calls require a session token (timing-safe comparison) |
| Origin validation | Settings server validates `Origin`/`Referer` headers; rejects unknown origins |
| Input validation | All inputs validated: email addresses, folder names, attachment sizes, hostnames |
| Injection prevention | CRLF stripped from all SMTP headers, subjects, filenames, and custom header values |
| Config file isolation | Config written atomically at mode `0600`; preset and tool names validated on load |
| Memory safety | Email cache capped at 500 entries and 50 MB; rate-limiter buckets capped at 10,000 keys |

**What agents cannot do:**
- Approve their own escalation requests
- Bypass the permission gate (it runs in the MCP server process, not the agent)
- Read or modify `~/.protonmail-mcp.json` directly (not an exposed tool)
- Erase the audit log
- Inject headers into outgoing email via crafted subjects, filenames, or custom headers

**Credentials:** Stored in `~/.protonmail-mcp.json` with `0600` permissions. Never commit this file. The settings UI never displays or transmits your Bridge password.

---

## Troubleshooting

### "Connection refused" on Bridge ports

- Confirm Proton Bridge is **running and signed in**.
- Use `127.0.0.1` instead of `localhost` in all host fields.
- Verify ports are listening: `lsof -i :1025 -i :1143` (macOS/Linux) or `netstat -ano | findstr "1025\|1143"` (Windows).
- Some VPNs block localhost port binding — try disabling the VPN.

### "Authentication failed" or IMAP login error

- Use the **Bridge password**, not your ProtonMail login password.
- Find it in the Bridge app: **Settings → IMAP/SMTP → Password** (a long random string).
- If you recently reinstalled Bridge, it generates a new password — update it in the settings UI.

### "Tool blocked by permission policy"

- Open the settings UI → **Permissions** tab and switch to **Supervised** or **Full Access**.
- Per-tool toggles let you enable individual tools without changing the overall preset.
- The agent can call `request_permission_escalation` for temporary access.

### "Certificate error" or TLS handshake failure

- Export the Bridge TLS certificate: Bridge app → **Settings → Export TLS certificates**.
- Set the path in the settings UI under **Setup → Bridge TLS Certificate**.

> If no Bridge TLS certificate is configured, TLS certificate validation is **disabled** for the localhost Bridge connection. The server logs a warning and `get_connection_status` reports `insecureTls: true` for the affected service.

### Claude Desktop doesn't show ProtonMail tools

- Confirm the `mcpServers` block is valid JSON (no trailing commas).
- Fully quit and reopen Claude Desktop.
- Check MCP logs: **Help → Show Logs**.
- Verify the server starts manually: `npx protonmail-agentic-mcp` — it should stay running silently.

### Analytics show zero or empty data

- Run `sync_emails` in Claude first to populate the cache.
- Response time stats only appear when sent emails have `In-Reply-To` headers matching inbox messages.

---

## Development

```bash
git clone https://github.com/chandshy/protonmail-agentic-mcp.git
cd protonmail-agentic-mcp
npm install

npm run build          # compile TypeScript to dist/
npm run dev            # watch mode (recompiles on save)
npm run test           # run test suite (Vitest, 1,198 tests)
npm run test:coverage  # coverage report
npm run lint           # TypeScript type check (tsc --noEmit)
npm run settings       # start standalone settings UI (after build)
```

### Project structure

```
src/
  index.ts                    # Unified daemon: MCP server (51 tools, resources, prompts) + settings HTTP server + system tray
  settings-main.ts            # Standalone settings UI CLI (for headless/SSH environments)
  tray.ts                     # System tray icon (systray2)
  config/
    schema.ts                 # Config types, tool names, category definitions
    loader.ts                 # Config file load/save, preset builder
  permissions/
    manager.ts                # Per-tool permission checks and rate limiting
    escalation.ts             # Human-gated escalation challenge system
  security/
    keychain.ts               # OS keychain integration (@napi-rs/keyring)
    memory.ts                 # Credential wipe helpers
  services/
    smtp-service.ts           # Email sending via Nodemailer
    simple-imap-service.ts    # Email reading via ImapFlow
    analytics-service.ts      # Email analytics computation
    scheduler.ts              # Scheduled email delivery
  settings/
    server.ts                 # Browser-based settings UI server
    security.ts               # Rate limiting, CSRF, origin validation, TLS
    tui.ts                    # Terminal UI for settings
  utils/
    helpers.ts                # ID generation, email validation, log sanitisation
    logger.ts                 # Structured log store
    tracer.ts                 # Lightweight request tracing
  types/
    index.ts                  # Shared TypeScript types
```

---

## Acknowledgements

This project is built on the foundation originally created by **[Hawk94](https://github.com/Hawk94)**, whose initial IMAP/SMTP integration, tool architecture, and test setup made this project possible. The original work was published as [barhatch/protonmail-mcp-server](https://github.com/barhatch/protonmail-mcp-server).

---

## License

MIT — see [LICENSE](LICENSE)

---

*Unofficial third-party server. Not affiliated with or endorsed by Proton AG.*

[GitHub](https://github.com/chandshy/protonmail-agentic-mcp) · [npm](https://www.npmjs.com/package/protonmail-agentic-mcp) · [Issues](https://github.com/chandshy/protonmail-agentic-mcp/issues) · [Model Context Protocol](https://modelcontextprotocol.io)
