# ProtonMail MCP Server

[![CI](https://github.com/chandshy/protonmail-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/chandshy/protonmail-mcp-server/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)
[![MCP SDK](https://img.shields.io/badge/MCP%20SDK-1.20+-green.svg)](https://github.com/modelcontextprotocol/sdk)

Give Claude AI — or any MCP-compatible AI agent — secure, controlled access to your ProtonMail inbox via [Proton Bridge](https://proton.me/mail/bridge).

**47 tools · MCP Resources · MCP Prompts · Permission presets · Per-tool rate limiting · Human-gated escalation · Browser-based settings UI**

---

## 1. What Is This and How Do You Use It?

This is a **Model Context Protocol (MCP) server** that bridges Claude Desktop (or any MCP host) with your ProtonMail account. It connects to Proton Bridge — the official desktop app that decrypts your end-to-end encrypted emails locally — and exposes a rich set of email tools to AI agents.

**Privacy note:** Your emails are decrypted locally by Proton Bridge. When Claude reads your emails through this server, the content is sent to Anthropic's API for processing. No email data is stored persistently by this server — it is cached in memory only and cleared on restart.

### What Claude can do with this server

| Ask Claude… | What happens |
|---|---|
| "Summarise everything from newsletter@example.com this week" | Searches INBOX, filters by sender, returns threaded summaries |
| "Find emails about my Acme invoice and draft a reply" | Searches by subject, fetches threads, opens a compose prompt |
| "What's my average email response time this month?" | Runs analytics across INBOX + Sent, computes hour deltas |
| "Move all order confirmations to the Shopping folder" | Bulk-moves matching emails (requires supervised/full permission) |
| "Who do I email most often?" | Returns contact frequency stats from your Sent folder |
| "Show me emails I haven't replied to in over 7 days" | Searches INBOX filtered by read/date status |
| "Create a folder for Project X and file these emails" | Creates folder, moves emails (requires supervised/full permission) |
| "Send a test email so I know everything is working" | Sends via Proton Bridge SMTP |

### Permission model

By default, when no config file exists, **only read-only tools are available**. AI agents can read, search, and analyse your email but cannot send, move, delete, tag, or change anything. You grant write access explicitly through the settings UI.

The server includes a **human-gated escalation system**: an agent can request a temporary permission upgrade, which you approve (or deny) in the browser UI or from a separate device. The agent cannot approve its own escalation requests.

---

## 2. What You Need

| Requirement | Version | Notes |
|---|---|---|
| **Node.js** | ≥ 20.0.0 | Check with `node --version` · [nodejs.org](https://nodejs.org) |
| **npm** | ≥ 9.0.0 | Bundled with Node.js |
| **Proton Bridge** | Latest | Must be running and signed in · [proton.me/mail/bridge](https://proton.me/mail/bridge) |
| **ProtonMail account** | Any plan | Free accounts work for reading; sending via Bridge requires the Bridge app (free) |
| **Claude Desktop** | Latest | Or any MCP-compatible host · [claude.ai/download](https://claude.ai/download) |

### Operating systems

macOS, Windows, and Linux are all supported.

### Proton Bridge ports

By default Bridge listens on:

| Protocol | Host | Port |
|---|---|---|
| SMTP (sending) | `127.0.0.1` | `1025` |
| IMAP (reading) | `127.0.0.1` | `1143` |

> **Use `127.0.0.1`, not `localhost`.** On some systems `localhost` resolves to `::1` (IPv6), which Bridge does not listen on, causing "connection refused" errors.

---

## 3. Installation

### Option A — npm (recommended)

```bash
npm install -g protonmail-mcp-server
```

### Option B — From source

```bash
git clone https://github.com/chandshy/protonmail-mcp-server.git
cd protonmail-mcp-server
npm install
npm run build
```

After installing, run the setup wizard:

```bash
npx protonmail-mcp-settings
# or, from source:
npm run settings
```

---

## 4. Setup Wizard

The settings UI includes a **5-step setup wizard** that opens automatically on first run (when no config file exists). It walks you through everything:

```bash
npx protonmail-mcp-settings
```

Then open **http://localhost:8765** in your browser.

### Step 1 — Welcome

Overview of what the server does, real use-case examples, and a prerequisites checklist (Proton Bridge, Node.js ≥20, Claude Desktop).

### Step 2 — Bridge health check

Runs a live TCP connection test to `localhost:1025` (SMTP) and `localhost:1143` (IMAP). If Bridge is not reachable it shows a direct link to download it. You cannot proceed until both ports respond.

### Step 3 — Account credentials

Enter your ProtonMail email address and your **Bridge password** (shown inside the Proton Bridge app under Settings → IMAP/SMTP → Password). This is **not** your ProtonMail login password.

The settings are saved to `~/.protonmail-mcp.json` (mode `0600` — readable only by you).

### Step 4 — Permission preset

Choose how much the AI is allowed to do:

| Preset | What's allowed | Best for |
|---|---|---|
| **Read-Only** *(default)* | Read, search, analytics, connection status | Starting out, untrusted agents |
| **Supervised** | All tools; deletion capped at 5/hr, sending at 20/hr, bulk actions at 10/hr | Day-to-day agentic use |
| **Send-Only** | Reading + sending only, no deletion or folder writes | Agents that only need to send |
| **Full Access** | All 47 tools, no rate limits | Trusted workflows where you review actions |

You can change this at any time from the **Permissions** tab.

### Step 5 — Done

Displays the exact JSON block to paste into your Claude Desktop config, with:

- Your email address pre-filled
- Platform-specific config file paths (macOS / Windows / Linux)
- Five starter prompts to test everything is working

---

## 5. Claude Desktop Configuration

Add this block to your Claude Desktop config file:

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
**Linux:** `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "protonmail": {
      "command": "npx",
      "args": ["-y", "protonmail-mcp-server"],
      "env": {
        "PROTONMAIL_USERNAME": "you@proton.me",
        "PROTONMAIL_PASSWORD": "your-bridge-password",
        "PROTONMAIL_SMTP_HOST": "127.0.0.1",
        "PROTONMAIL_SMTP_PORT": "1025",
        "PROTONMAIL_IMAP_HOST": "127.0.0.1",
        "PROTONMAIL_IMAP_PORT": "1143"
      }
    }
  }
}
```

> **Tip:** If you used the settings wizard, the snippet with your username is shown on the final step — just copy and paste it.

Restart Claude Desktop after saving the config.

### Environment variables reference

| Variable | Required | Default | Description |
|---|---|---|---|
| `PROTONMAIL_USERNAME` | Yes | — | Your ProtonMail email address |
| `PROTONMAIL_PASSWORD` | Yes | — | Bridge password (from Bridge app, not login) |
| `PROTONMAIL_SMTP_HOST` | No | `localhost` | SMTP host (use `127.0.0.1`) |
| `PROTONMAIL_SMTP_PORT` | No | `1025` | SMTP port |
| `PROTONMAIL_IMAP_HOST` | No | `localhost` | IMAP host (use `127.0.0.1`) |
| `PROTONMAIL_IMAP_PORT` | No | `1143` | IMAP port |
| `PROTONMAIL_BRIDGE_CERT` | No | — | Path to exported Bridge TLS `.crt` file |
| `PROTONMAIL_SMTP_TOKEN` | No | — | SMTP token (required for direct `smtp.protonmail.ch`, paid plans only) |
| `PROTONMAIL_MCP_CONFIG` | No | `~/.protonmail-mcp.json` | Override config file path |
| `PROTONMAIL_SCHEDULER_STORE` | No | `~/.protonmail-mcp-scheduled.json` | Path for scheduled email persistence file |

---

## 6. Testing That It Works

After restarting Claude Desktop, open a new conversation and try:

1. **"Check my ProtonMail connection status"** — should confirm IMAP and SMTP are connected.
2. **"List my ProtonMail folders"** — should return INBOX, Sent, Drafts, etc.
3. **"Show me my 5 most recent emails"** — fetches and summarises real emails.
4. **"Search for emails from [a known sender]"** — verifies search is working.
5. **"What are my email stats?"** — runs analytics; confirms Sent folder access.

If any of these fail, see the [Troubleshooting](#9-troubleshooting) section below.

---

## 7. Available Tools

### Reading (read-only — always available)

| Tool | Description |
|---|---|
| `get_emails` | Fetch emails from any folder with cursor pagination |
| `get_email_by_id` | Get a single email with full body and headers |
| `search_emails` | Search by subject, sender, body, date range, read status, attachments; supports `folders: ["*"]` to search all folders |
| `get_folders` | List all folders with message counts and unread counts |
| `get_unread_count` | Cheap per-folder unread count — call before `get_emails` to decide whether to fetch |
| `list_labels` | List all ProtonMail labels with message counts |
| `get_emails_by_label` | Fetch emails from a specific label folder with cursor pagination |
| `download_attachment` | Download attachment binary content as base64 (use attachment_index from `get_email_by_id`) |

### Analytics (read-only — always available)

| Tool | Description |
|---|---|
| `get_email_stats` | Total, unread, sent, starred counts and cache status |
| `get_email_analytics` | Full analytics: top senders, volume trends, response time stats |
| `get_contacts` | Contact interaction frequency (received from / sent to) |
| `get_volume_trends` | Email volume by day of week and hour of day |

### System (read-only — always available)

| Tool | Description |
|---|---|
| `get_connection_status` | SMTP/IMAP connection health; includes `imap.healthy` (live NOOP probe), `insecureTls` flags, config path, and settings status |
| `get_logs` | Recent server log entries for debugging |
| `sync_emails` | Manually refresh the email cache (configurable limit, default 100) |
| `clear_cache` | Clear the email and analytics cache |

### Sending (requires supervised, send_only, or full preset)

| Tool | Description |
|---|---|
| `send_email` | Send email with HTML/text body, attachments, CC, BCC, Reply-To |
| `send_test_email` | Send a test email to verify SMTP is working |
| `reply_to_email` | Reply to an email (sets In-Reply-To and References headers) |
| `forward_email` | Forward an email to a new recipient with optional message |

### Drafts & Scheduling (requires supervised, send_only, or full preset)

| Tool | Description |
|---|---|
| `save_draft` | Save an incomplete or complete email as a draft (IMAP APPEND to Drafts folder) |
| `schedule_email` | Queue an email for delivery at a future time (ISO 8601, 60s–30 days out) |
| `list_scheduled_emails` | List all scheduled emails (pending, sent, failed, cancelled) |
| `cancel_scheduled_email` | Cancel a pending scheduled email before it sends |

### Actions (requires supervised or full preset)

| Tool | Description |
|---|---|
| `mark_email_read` | Mark one email read or unread |
| `star_email` | Star or unstar an email |
| `move_email` | Move an email to a different folder |
| `archive_email` | Move an email to the Archive folder |
| `move_to_trash` | Move an email to the Trash folder |
| `move_to_spam` | Move an email to the Spam folder |
| `move_to_folder` | Move an email to a custom folder (`Folders/<name>`) |
| `move_to_label` | Apply a ProtonMail label to an email (`Labels/<name>`) |
| `remove_label` | Remove a label from an email (move back to INBOX or specified folder) |
| `bulk_mark_read` | Mark multiple emails read/unread |
| `bulk_star` | Star/unstar multiple emails |
| `bulk_move_emails` | Move multiple emails to a folder |
| `bulk_move_to_label` | Apply a label to multiple emails |
| `bulk_remove_label` | Remove a label from multiple emails |

### Folders (requires supervised or full preset)

| Tool | Description |
|---|---|
| `sync_folders` | Refresh folder list from IMAP |
| `create_folder` | Create a new folder or label |
| `rename_folder` | Rename an existing folder |

### Deletion (requires full preset, capped at 5/hr in supervised)

| Tool | Description |
|---|---|
| `delete_email` | Permanently delete an email |
| `delete_folder` | Delete a folder (must be empty) |
| `bulk_delete_emails` | Delete multiple emails permanently |
| `bulk_delete` | Alias for `bulk_delete_emails` |

### Escalation (always available)

| Tool | Description |
|---|---|
| `request_permission_escalation` | Ask the human to grant a higher permission preset temporarily |
| `check_escalation_status` | Poll the status of a pending escalation challenge |

### MCP Prompts

Pre-built prompt templates for common tasks:

- **`compose_reply`** — Draft a contextual reply to an email thread
- **`thread_summary`** — Summarise an email thread with action items
- **`find_subscriptions`** — Identify mailing lists and newsletters you're subscribed to

---

## 8. Permission Escalation

The escalation system lets an AI agent request broader permissions when it needs them, without permanently changing your permission settings.

### How it works

1. The agent calls `request_permission_escalation` with a reason and the target preset it needs (e.g. `"supervised"` to be able to send email).
2. A challenge appears in the **Settings UI** (`npx protonmail-mcp-settings`) under the Escalation tab — and is also printed to the terminal.
3. **You** review the request, type `APPROVE` in the confirmation field, and click Approve (or Deny).
4. The agent polls with `check_escalation_status` and proceeds once approved.
5. After the escalation period expires (5 minutes), permissions revert automatically.

### Security properties

- **Two separate channels**: the agent requests via MCP (unattended process), but approval can only happen via browser or terminal — channels the agent cannot write to.
- **Human confirmation required**: you must type the word `APPROVE` before the button activates — no accidental clicks.
- **CSRF-protected**: the approval API requires a token embedded only in the HTML page; raw HTTP requests cannot forge it.
- **Rate-limited**: max 5 escalation requests per hour, max 1 pending at a time.
- **Audit trail**: every request, approval, and denial is appended to `~/.protonmail-mcp.audit.jsonl`.
- **Third-device support**: start the settings server with `--lan` to approve from your phone or tablet.

---

## 9. Settings UI

Run the settings server at any time to change configuration:

```bash
npx protonmail-mcp-settings
# opens http://localhost:8765

# Custom port:
npx protonmail-mcp-settings --port 9000

# LAN mode (approve escalations from your phone):
npx protonmail-mcp-settings --lan
```

The settings UI has four tabs:

- **Setup** — Connection credentials, SMTP/IMAP hosts and ports, Bridge TLS certificate path, debug mode
- **Permissions** — Permission preset selector and per-tool enable/rate-limit toggles
- **Escalations** — Pending escalation requests from the AI agent (approve or deny here)
- **Status** — Server info, Claude Desktop JSON snippet, live connectivity check, audit log, config reset

Changes take effect in the running MCP server within 15 seconds — no restart required.

---

## 10. Security

This server is designed to give AI agents *controlled* access to sensitive email data. The security model includes:

### Defence-in-depth layers

| Layer | Mechanism |
|---|---|
| Permission gate | Every tool call checked against `~/.protonmail-mcp.json` (refreshed every 15 s) |
| Rate limiting | Per-tool rate limits enforced in the MCP server (not just the settings UI) |
| Escalation gate | Privilege increases require explicit human approval via a separate channel |
| Audit log | Immutable append-only log of all escalation events at `~/.protonmail-mcp.audit.jsonl` |
| CSRF protection | All mutating settings API calls require a session token (timing-safe comparison) |
| Origin validation | Settings server validates `Origin`/`Referer` headers; rejects unknown origins |
| Input validation | All user/agent inputs validated: email addresses, folder names, attachment sizes, hostnames |
| Injection prevention | CRLF stripped from all SMTP headers, subjects, filenames, custom header keys and values |
| Config file isolation | Config written atomically at mode `0600`; preset and tool names validated on load |
| Memory safety | Email cache capped at 500 entries; rate-limiter buckets capped at 10 000 keys |

### What agents cannot do

- Approve their own escalation requests
- Bypass the permission gate (it runs in the MCP server process, not the agent)
- Read or modify `~/.protonmail-mcp.json` directly (not an exposed MCP tool)
- Erase the audit log (no MCP tool exposes it as writable)
- Inject headers into outgoing email via crafted subjects, filenames, or custom headers

### Credentials storage

Credentials are saved to `~/.protonmail-mcp.json` with `0600` permissions (owner read/write only). Never commit this file. The settings UI will never display or transmit your Bridge password.

---

## 11. Troubleshooting

### "Connection refused" or Bridge ports not reachable

- Make sure Proton Bridge is **running and signed in** to your account.
- Use `127.0.0.1` instead of `localhost` in all host fields.
- Verify the ports are listening: `lsof -i :1025 -i :1143` (macOS/Linux) or `netstat -ano | findstr "1025\|1143"` (Windows).
- Some VPNs block localhost port binding — try disabling the VPN.

### "Authentication failed" or IMAP login error

- The password must be the **Bridge password**, not your ProtonMail account password.
- Find it in the Bridge app: **Settings → IMAP/SMTP → Password** (it is a long random string).
- If you recently reinstalled Bridge, it generates a new Bridge password — update it in the settings UI.

### "Tool blocked by permission policy"

- Open the settings UI and check the **Permissions** tab.
- The current preset is shown in the header. Switch to **Supervised** or **Full Access** for write tools.
- Individual tools can be re-enabled using the per-tool toggles.
- If an AI agent needs more access, it can call `request_permission_escalation` and you can approve from the **Escalations** tab.

### "Certificate error" or TLS handshake failure

- Export the Bridge TLS certificate: Bridge app → **Settings → Export TLS certificates**.
- Set the path in the settings UI under **Setup → Bridge TLS Certificate**, or set `PROTONMAIL_BRIDGE_CERT` env var.
- This enables proper TLS trust instead of skipping certificate validation.

> **Security note:** If `PROTONMAIL_BRIDGE_CERT` is not configured, TLS certificate validation is **disabled** for the localhost Bridge connection. The server logs an error and the `get_connection_status` tool will report `insecureTls: true` for the affected service. Configure the cert path to restore full TLS security.

### Claude Desktop doesn't show ProtonMail tools

- Confirm the `mcpServers` block is valid JSON (no trailing commas, correct braces).
- Fully restart Claude Desktop (Quit and reopen — not just a new window).
- Check Claude Desktop's MCP logs: **Help → Show Logs**.
- Verify the server starts manually: `npx protonmail-mcp-server` — it should output nothing and stay running.

### Analytics show zero or incorrect data

- Run **"Sync my emails"** in Claude first to populate the cache.
- Response time stats appear only when sent emails have `In-Reply-To` headers matching inbox emails.
- The Sent folder fetch may fail silently if Bridge doesn't expose it — check `get_connection_status`.

---

## 12. Development

```bash
git clone https://github.com/chandshy/protonmail-mcp-server.git
cd protonmail-mcp-server
npm install

npm run build          # compile TypeScript → dist/
npm run dev            # watch mode (recompiles on save)
npm run test           # run test suite (Vitest)
npm run test:coverage  # coverage report
npm run lint           # TypeScript type check
npm run settings       # start settings UI (after build)
```

### Project structure

```
src/
  index.ts                    # MCP server entry point (tools, resources, prompts)
  settings-main.ts            # Settings UI CLI entry point
  config/
    schema.ts                 # Config types, tool names, category definitions
    loader.ts                 # Config file load/save, preset builder
  permissions/
    manager.ts                # Per-tool permission checks and rate limiting
    escalation.ts             # Human-gated escalation challenge system
  services/
    smtp-service.ts           # Email sending via Nodemailer
    simple-imap-service.ts    # Email reading via ImapFlow
    analytics-service.ts      # Email analytics computation
  settings/
    server.ts                 # Browser-based settings UI server
    security.ts               # Rate limiting, CSRF, origin validation, TLS
  utils/
    helpers.ts                # ID generation, email validation, log sanitisation
    logger.ts                 # Structured log store
  types/
    index.ts                  # Shared TypeScript types
```

---

## License

MIT — see [LICENSE](LICENSE)

---

*Unofficial third-party server. Not affiliated with or endorsed by Proton AG.*

[GitHub](https://github.com/chandshy/protonmail-mcp-server) · [npm](https://www.npmjs.com/package/protonmail-mcp-server) · [Issues](https://github.com/chandshy/protonmail-mcp-server/issues) · [Model Context Protocol](https://modelcontextprotocol.io)
