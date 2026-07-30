# mailpouch

`mailpouch` is an MCP server that gives AI agents a typed, permission-gated, audit-logged tool surface over private-mail providers — Proton Mail (via Proton Bridge) and plain IMAP.

The pitch in one line: if you picked Proton Mail because you didn't want a third party reading your inbox, you don't suddenly want to hand a chatbot OAuth access to that same inbox so it can triage on your behalf. The usual "connect your email" integrations route everything through someone else's servers and ask for blanket scopes. Hand-rolled IMAP inside the agent is worse — no permission boundary, no audit trail, and the model holds your credentials in its context window. Neither option respects why you chose the provider in the first place.

`mailpouch` runs locally and speaks to Proton Bridge over a TLS socket on your own machine; nothing leaves the box unless you asked it to. Up to 86 tools (83 canonical plus 3 meta-tools) cover reading, sending, drafts, folders, search, analytics, optional aliases and Proton Pass, plus system control. Tool tiers and capability-aware listing keep unconfigured companion tools out of an agent's context. Every connecting client gets its own grant with folder allowlists, IP pins, per-tool rate caps, expiry, and account binding — all hashed-args in the audit log, never the values. Delete, trash, spam, alias removal, and sensitive Pass retrieval round-trip through MCP elicitation for human confirmation before they execute.

It is real because the primitives are real: OAuth 2.1 with PKCE S256, RFC 7591 dynamic client registration, RFC 8707 resource indicators, RFC 9728 protected-resource metadata, and an OAuth `client_credentials` grant so headless agents authenticate too — every agent gets its own gated, revocable identity. Credentials live in the OS keychain. A local FTS5 index with BM25 ranking handles phrase, boolean, prefix, and column-filter queries so your search terms never leave your laptop. Desktop notifications use native `osascript` / `notify-send` / `powershell.exe` with no added dependency; webhook dispatch auto-detects CloudEvents 1.0, Slack, or Discord, signs with HMAC, and retries with eight-attempt exponential backoff. So how do you point it at your Bridge install and wire up a client?

[![CI](https://github.com/chandshy/mailpouch/actions/workflows/ci.yml/badge.svg)](https://github.com/chandshy/mailpouch/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/badge/npm-v3.2.1-blue.svg)](https://www.npmjs.com/package/mailpouch)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0-blue.svg)](https://www.typescriptlang.org/)
[![MCP SDK](https://img.shields.io/badge/MCP%20SDK-1.29+-green.svg)](https://github.com/modelcontextprotocol/sdk)
[![Tests](https://img.shields.io/badge/tests-Vitest-brightgreen.svg)](#development)

**Read, compose, and manage your encrypted Proton Mail inbox from any AI assistant — over stdio or remote HTTP — with human-controlled permissions.**

---

## ⚠ Proton Terms of Service Notice

This is an **unofficial third-party tool** that connects to Proton Mail through Proton Bridge's local IMAP/SMTP surface. It is **not affiliated with, endorsed by, or authored by Proton AG**.

Proton's Terms of Service ([proton.me/legal/terms](https://proton.me/legal/terms)) §2.10 prohibits "accessing the Services through automated means (including but not limited to bots, scripts, or similar technologies)". The textual reading covers agentic / scripted workloads against Bridge even though Bridge itself is a sanctioned surface.

This server is designed to keep access **user-initiated**, not autonomous:

- Default permission preset is `read_only`. Sending, deletion, and folder mutation require explicit user opt-in via the settings UI.
- Destructive tools (delete / empty_trash / move-to-trash / move-to-spam / alias deletion / sensitive Pass retrieval) require explicit confirmation. With MCP elicitation-capable clients, the server prompts the user out-of-band before executing; non-elicitation clients must pass `{ confirmed: true }`.
- Elevated permissions require out-of-band human approval (settings UI button or terminal), not an agent-only grant.
- The settings UI shows a first-run ToS acknowledgement the user must click through before credentials are accepted.

You remain the operator of your Proton account. Running this server against your own account is your decision to make under Proton's ToS; the authors disclaim responsibility for ToS compliance on your behalf.

---

## What It Does

Proton Mail encrypts your email end-to-end, which means no third-party API can read it. [Proton Bridge](https://proton.me/mail/bridge) solves this by decrypting email locally. This MCP server connects to Bridge and gives Claude (or any MCP host) structured, permission-gated access to your inbox.

Your emails are decrypted on your own machine by Proton Bridge. This server never persists email content — everything stays in memory and is cleared on restart. You control exactly what the AI can do through a preset permission system with human-gated escalation for anything sensitive.

---

## Quick Start (zero to running)

Prereq: [Proton Bridge](https://proton.me/mail/bridge) installed, running, and signed in.

1. **Add the MCP server to your client.** This one form works whether or not mailpouch is globally installed:

   ```json
   { "mcpServers": { "mailpouch": { "command": "npx", "args": ["-y", "mailpouch"] } } }
   ```

2. **Configure Bridge credentials** — either path writes `~/.mailpouch.json` (+ OS keychain):
   - Interactive wizard: `npx -y mailpouch-settings`
   - Non-interactive (scriptable / agent-driven): `npx -y mailpouch setup --username you@proton.me --password-stdin`
     (paste the Proton **Bridge** password — Bridge → Settings → IMAP/SMTP → Password — **not** your Proton login password)

3. **Verify:** `npx -y mailpouch doctor` — prints the exact next step until it reports `ready`. (Agents can call the always-available `setup_status` tool for the same diagnosis.)

4. **Approve the agent.** On first connect, every client is gated behind a one-time human Approve/Deny — open the settings UI (`http://localhost:8766/#/agents`) and click Approve. This is expected, not an error.

That's it. The sections below cover everything in depth.

---

## Key Features

- **Up to 86 tools** — 83 canonical tools across 11 categories plus 3 always-available meta-tools (`setup_status`, `request_permission_escalation`, `check_escalation_status`). SimpleLogin and Proton Pass groups are listed only when configured. See [`src/config/schema.ts`](src/config/schema.ts) for the canonical inventory.
- **Two transports** — stdio (default, Claude Desktop) and HTTP (remote / self-host). HTTP is OAuth-only: `authorization_code` + PKCE-S256 for interactive agents and `client_credentials` for headless service accounts, with RFC 7591 Dynamic Client Registration, RFC 8414 authorization-server metadata, and RFC 9728 protected-resource metadata. Per-caller token-bucket rate limiting on every endpoint.
- **Progressive tool tiering** — `core` / `extended` / `complete` controls how many tools land in the client's `ListTools` response, so context isn't burned on tools you don't use. Configurable via `toolTier` or `MAILPOUCH_TIER`.
- **Destructive-tool confirmation** — uses MCP elicitation when the client supports it (Claude Desktop, Cline) so the user sees a prompt before delete, trash, spam, alias deletion, server lifecycle, or sensitive Pass retrieval. Falls back to a required `{ confirmed: true }` argument for clients without elicitation.
- **5 permission presets** — read-only by default; write access requires explicit opt-in. Per-tool overrides and rate limits via the **Custom** preset.
- **Human-gated escalation** — agents request elevated permissions, you approve via browser UI or terminal; the agent cannot approve its own requests.
- **Browser-based settings UI** at `localhost:8766` — auto-starts with the daemon; setup wizard, live connection test, per-tool toggles, escalation approval panel, per-agent Approve/Deny.
- **Native system tray icon** — always visible, clickable menu opens the settings UI or quits. Rendered via a bundled Rust (napi-rs) binding around the `tauri-apps/tray-icon` crate — the same one Tauri ships in production — so the tray behaves correctly on modern GNOME (where the legacy Go-binary library shows a generic placeholder), NSStatusBar on macOS, and Shell_NotifyIcon on Windows. Prebuilts for linux-x64/arm64, darwin-arm64, win32-x64/arm64 ship inside the main package; darwin-x64 (Intel Mac) falls back to the legacy Go backend cleanly.
- **6 MCP prompts** — triage inbox, compose reply, daily briefing, find subscriptions, thread summary, draft in my voice.
- **MCP Resources** — individual emails and folders addressable via `email://` and `folder://` URIs.
- **Scheduled email delivery** — queue emails for future sending; survives server restarts. Plus `remind_if_no_reply` for outbound follow-ups gated on inbox replies.
- **Optional companion services** — SimpleLogin alias management (16 tools, requires API key) and Proton Pass via pass-cli (4 tools, requires PAT) are omitted from `ListTools` until configured; local FTS5 full-text index remains available when `better-sqlite3` is installed.
- **TLS-strict by default** — refuses to connect to localhost Bridge without a pinned cert, requires Bridge ≥ `3.22.0`, exponential backoff on SMTP abuse-signal responses.
- **Multi-account** — configure more than one Proton / IMAP account; a running daemon hot-swaps the active account, while standalone settings and failed live rebinds explicitly request a restart. Tools accept an optional `account_id` argument to route a single call to a specific account. See [`src/accounts/`](src/accounts/).
- **Per-agent grants** — each MCP client (identified by its OAuth `client_id`) is gated by its own approvable grant, with optional folder allowlists, IP pins, per-tool rate caps, expiry, and account binding. Separate from the global preset and the escalation flow. See [`src/agents/`](src/agents/).
- **Live notifications** — desktop toasts (no extra deps) and outbound webhooks (CloudEvents / Slack / Discord, HMAC-signed, retried) fire on grant-state changes. See [`src/notifications/`](src/notifications/).
- **Strict TypeScript and a comprehensive Vitest suite**; unused locals and parameters are compiler errors.

**Documentation:** [HELP.md](HELP.md) (task-oriented how-tos) · [README_FIRST_AI.md](README_FIRST_AI.md) (agent API reference) · [docs/index.md](docs/index.md) (full index)

---

## Quick Start

Ask Claude things like:

```
"Summarize everything from my boss this week"
"Find emails about my Acme invoice and draft a reply"
"Move all order confirmations to my Shopping folder"
"What's my average email response time this month?"
"Schedule a follow-up email to alice@example.com for next Monday at 9am"
"Remind me if there's no reply within 3 business days"
```

With read-only permissions (the default), Claude can read, search, and analyse your inbox but cannot send, move, delete, or change anything.

---

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| **Node.js** | >= 20.0.0 | Check with `node --version` · [nodejs.org](https://nodejs.org) |
| **npm** | >= 9.0.0 | Bundled with Node.js |
| **Proton Bridge** | >= 3.22.0 | Must be running and signed in · [proton.me/mail/bridge](https://proton.me/mail/bridge) |
| **Proton Mail account** | **Paid plan** | Bridge requires a paid Proton plan (Mail Plus, Unlimited, etc.) |
| **MCP client** | Latest | Claude Desktop, Cline, or any MCP-compatible host · [claude.ai/download](https://claude.ai/download) |

Supported on macOS, Windows, and Linux.

### Linux runtime libraries

The native tray binding dynamically links against two GTK system
libraries that are **preinstalled on every modern desktop Linux
distribution** (Ubuntu ≥ 18.04, Fedora ≥ 34, Mint, Pop!_OS, Arch,
etc.). No manual install is needed on a normal desktop system —
just a note for server / container / minimal-WM deployments:

| Runtime library | Package name |
|---|---|
| `libgtk-3.so.0` | `libgtk-3-0` (Debian/Ubuntu) · `gtk3` (Fedora/Arch) |
| `libayatana-appindicator3.so.1` | `libayatana-appindicator3-1` (Debian/Ubuntu) · `libayatana-appindicator-gtk3` (Fedora) |

If both are missing (headless server, container, SSH-only host),
mailpouch's tray startup logs a skip reason and continues without
the icon — the MCP server itself runs unaffected. macOS and
Windows ship their native equivalents as part of the OS.

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
npm install -g mailpouch
```

Or skip the install entirely — `npx -y mailpouch` runs the latest published version on demand, which is exactly what the canonical MCP client config below uses.

### Option B — From source

```bash
git clone https://github.com/chandshy/mailpouch.git
cd mailpouch
npm install
npm run build
```

### Optional companions

Install only if you plan to use the corresponding tool group:

| Optional dep | Enables | Install |
|---|---|---|
| `better-sqlite3` | `fts_search` / `fts_rebuild` / `fts_status` (local FTS5 index) | `npm install better-sqlite3` |
| `pass-cli` (Proton's Go CLI) | `pass_list` / `pass_search` / `pass_get` / `pass_totp` | See [`pass-cli`](https://github.com/ProtonMail/pass-cli); set a Pass PAT in the settings UI |
| SimpleLogin API key | `alias_*` tools | Generate at [app.simplelogin.io](https://app.simplelogin.io/dashboard/api_key); paste in settings UI |

Tools in unconfigured groups return a clean configuration error rather than failing silently.

---

## Setup Wizard

Run the settings server to complete first-time setup:

```bash
npx -y mailpouch-settings
# Then open http://localhost:8766
```

The **6-step wizard** walks you through everything automatically:

1. **Welcome** — overview, ToS acknowledgement, and prerequisites checklist
2. **Bridge health check** — live TCP test to ports 1025 and 1143; blocks progress until Bridge is reachable
3. **Account** — your Proton Mail address and Bridge password (Bridge app → Settings → IMAP/SMTP → Password — this is **not** your Proton login password)
4. **Permission preset** — choose what the AI is allowed to do (see table below)
5. **Review** — confirm your settings before saving
6. **Done** — displays the exact JSON snippet to paste into your MCP client config; optionally writes it for you automatically

Settings are saved to `~/.mailpouch.json` with mode `0600` (owner read/write only). The Bridge password and SMTP token prefer the OS keychain when available.

### Non-interactive setup (agents / CI)

When a browser/TUI wizard isn't an option, configure credentials from the command line — it writes the same `~/.mailpouch.json` (+ keychain) the wizard does:

```bash
# password from stdin (keeps the secret out of the process list)
printf '%s' "$BRIDGE_PASSWORD" | npx -y mailpouch setup --username you@proton.me --password-stdin

# or from a file, or inline; optional non-default ports / cert
npx -y mailpouch setup --username you@proton.me --password-file ./bridge.pw \
  [--imap-host 127.0.0.1 --imap-port 1143 --smtp-host 127.0.0.1 --smtp-port 1025] \
  [--bridge-cert /path/cert.pem | --insecure]
```

Then check the install end-to-end:

```bash
npx -y mailpouch doctor          # human-readable diagnosis + next step; exit 0 when ready
npx -y mailpouch doctor --json   # structured output for scripts
npx -y mailpouch status          # is it running? ports, connection, approved agents (read-only)
npx -y mailpouch --help          # all commands + flags + the config/log paths
```

`doctor` reports the same state machine the always-available `setup_status` MCP tool returns: `unconfigured` → `bridge-unreachable` → `pending-approval` → `ready`, each with the exact action to advance. These commands **print and exit** — they never start a server, so they're safe to run alongside a live daemon. (Running `mailpouch` with no command starts the MCP stdio server, which is what your MCP client spawns.)

---

## Claude Desktop Configuration (stdio)

The config file locations are:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux:** `~/.config/Claude/claude_desktop_config.json`

**Canonical entry — works whether or not mailpouch is globally installed:**

```json
{
  "mcpServers": {
    "mailpouch": {
      "command": "npx",
      "args": ["-y", "mailpouch"]
    }
  }
}
```

This is the same JSON shown in `llms.txt` and `README_FIRST_AI.md` — use it everywhere. If you installed globally (`npm install -g mailpouch`) you may instead use `"command": "mailpouch"` with no args. Restart the client after saving.

<details>
<summary>Running from a source checkout (Option B)</summary>

If you cloned the repo instead of installing from npm, point the client at the built entry file directly (your path will differ):

```json
{
  "mcpServers": {
    "mailpouch": {
      "command": "node",
      "args": ["/path/to/mailpouch/dist/index.js"]
    }
  }
}
```

</details>

The settings wizard can also write the entry to your client config automatically — click **Write to Claude Desktop** on the Done step.

---

## Multi-Account

More than one mail account can be configured in the same server — handy for juggling a personal Proton address, a work Proton address, and a generic IMAP account from a single MCP client.

The config file grows two fields alongside the existing `connection` block:

```json
{
  "accounts": [
    { "id": "primary", "name": "Personal", "providerType": "proton-bridge",
      "smtpHost": "127.0.0.1", "smtpPort": 1025,
      "imapHost": "127.0.0.1", "imapPort": 1143,
      "username": "me@proton.me", "password": "<bridge-pw>" },
    { "id": "acct-7b1c", "name": "Work", "providerType": "imap", "...": "..." }
  ],
  "activeAccountId": "primary"
}
```

- The **Accounts** tab in the settings UI handles add / edit / activate / delete. The server refuses to delete the last remaining account.
- `AccountManager` keeps one `{ imap, smtp, spec }` triple per configured account. In a running daemon, saving a new active selection emits an `active-changed` event that rebinds active-account services and clears prior-account caches. Standalone settings (or a failed live rebind) reports that a restart is required.
- Tools accept an optional `account_id` argument. When omitted, the call runs against `activeAccountId`; when present, the dispatcher routes to the named account. Agent grants can pin a client to a single `accountId` via `conditions`.
- Legacy single-account configs are migrated lazily: the first load with `accounts: []` lifts the top-level `connection` fields into a `primary` account. No manual migration step.

Canonical code: [`src/accounts/registry.ts`](src/accounts/registry.ts), [`src/accounts/manager.ts`](src/accounts/manager.ts), [`src/accounts/types.ts`](src/accounts/types.ts).

---

## Remote / HTTP Transport

For headless boxes, phones, or sharing one Bridge across multiple devices, switch to HTTP transport. The same binary listens on a port instead of stdio.

Enable it via the Setup tab → **Remote (HTTP) mode**, or by setting these in `~/.mailpouch.json`:

```json
{
  "connection": {
    "remoteMode": true,
    "remoteHost": "127.0.0.1",
    "remotePort": 8788,
    "remotePath": "/mcp",
    "remoteTlsCertPath": "/path/to/cert.pem",
    "remoteTlsKeyPath":  "/path/to/key.pem",
    "remoteOauthEnabled": true,
    "remoteOauthIssuer": "https://mcp.example.com",
    "remoteRateLimitPerSecond": 20,
    "remoteRateLimitBurst": 40
  }
}
```

**Auth is OAuth-only — every agent authenticates as its own client.** There is no shared bearer token (it was removed because it bypassed per-agent gating and audit). A verified token always maps to a specific, gated, revocable agent identity. `remoteMode` refuses to start without `remoteOauthEnabled`. Two grant types share the one listener:

- **`authorization_code` + PKCE-S256 (interactive agents)** — MCP hosts self-register via `POST /oauth/register` (RFC 7591), discover endpoints via `GET /.well-known/oauth-authorization-server` (RFC 8414) and `GET /.well-known/oauth-protected-resource` (RFC 9728), then complete a PKCE flow with **automatic consent** (no admin password — `GET /oauth/authorize` issues a code immediately). The human gate is the per-agent **Approve/Deny** in the Agents tab: the issued token is inert until you approve the agent, and a pending request expires after 5 minutes.
- **`client_credentials` (headless / service accounts)** — cron, CI, and scheduled agents that can't do interactive consent. Issue a **service account** out-of-band, then log in with its `client_id` + `client_secret`:

  ```bash
  mailpouch agent issue --name nightly-triage --preset read_only
  # → prints client_id + client_secret ONCE; the matching grant is pre-approved (active).
  # also: mailpouch agent list   /   mailpouch agent revoke <client_id>
  # (or use the "+ Service account" button in the Agents tab)

  curl -s -u "$CLIENT_ID:$CLIENT_SECRET" \
       -d grant_type=client_credentials https://mcp.example.com/oauth/token
  # → { "access_token": "…", "token_type": "Bearer", "expires_in": 86400 }
  ```

**Rate limiting** — token-bucket per caller (per IP for unauthed paths, per token key for `/mcp`). A compromised token can't DoS Bridge.

**TLS** — provide `remoteTlsCertPath` + `remoteTlsKeyPath` for HTTPS. Required for any non-loopback exposure.

A remote client config (after obtaining an access token via either grant) looks like:

```json
{
  "mcpServers": {
    "mailpouch-remote": {
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer <access_token>" }
    }
  }
}
```

**Connecting a client (stdio or HTTP).** The Settings UI (Setup tab → *Connect a client*) and the first-run wizard both let you choose how an MCP client connects and write the entry for you:

- **Write to Claude Code** merges a `mailpouch` entry into `~/.claude.json` under `mcpServers` (and **Write to Claude Desktop** does the same for `claude_desktop_config.json`).
- **stdio** — the client spawns its own mailpouch. The written entry sets `MAILPOUCH_FORCE_STDIO=1` so it speaks stdio even when your config has `remoteMode: true`. Don't run a stdio client alongside the shared HTTP daemon against the same Proton account — they'd contend for the one IMAP connection.
- **HTTP** — the client connects to the shared daemon at `/mcp` (needs `remoteMode` + `remoteOauthEnabled` and the daemon running). The client performs an OAuth login and you Approve it once in the Agents tab.

**Running mailpouch as a shared daemon (multiple apps at once).** mailpouch holds **one IMAP connection per account** (a singleton lock), so two stdio instances for the same account can't run at the same time — the second exits. To use several clients together (e.g. Claude Code **and** Claude cowork, or headless agents), run **one** HTTP daemon and point every client at it:

```bash
mailpouch daemon              # starts the shared HTTP daemon (forces HTTP; requires remoteOauthEnabled)
# optional: mailpouch daemon --host 0.0.0.0 --port 8788
```

`mailpouch daemon` is **user-started** (run it in a tmux / login session or your own supervisor) — it is not an autostart. Then:
- **Interactive apps** (Claude Code, Claude Desktop) connect over HTTP and you Approve each once in the Agents tab.
- **Headless / cowork hosts** authenticate with a per-host **service account** (`mailpouch agent issue --name <host> --preset <preset>`) over the `client_credentials` grant.

All clients share the daemon's single IMAP connection — no singleton conflict, and each is independently gated, audited, and revocable.

While the daemon is running, the Settings "Connect an app" chooser **only offers HTTP** — the per-computer (stdio) option is disabled, because a stdio entry would spawn a second instance that collides with the daemon and fail to start. Issuing or re-issuing a service account (`mailpouch agent issue`) takes effect **immediately** — the running daemon picks it up on the next login, no restart. Revoking a service account (in the Agents tab) deletes its credential, so it stays revoked across restarts; to re-enable, re-issue it.

### Environment variables

Configuration is stored in `~/.mailpouch.json` and managed via the settings UI — not environment variables. The following env vars are available for advanced/optional overrides:

| Variable | Default | Description |
|---|---|---|
| `MAILPOUCH_CONFIG` | `~/.mailpouch.json` | Override config file path |
| `MAILPOUCH_SCHEDULER_STORE` | `~/.mailpouch-scheduled.json` | Scheduled email persistence file |
| `MAILPOUCH_LOG_FILE` | `~/.mailpouch.log` | Override log file path |
| `MAILPOUCH_PENDING` | `~/.mailpouch.pending.json` | Override pending escalations file path |
| `MAILPOUCH_AUDIT` | `~/.mailpouch.audit.jsonl` | Override escalation audit log path |
| `MAILPOUCH_REMINDERS` | `~/.mailpouch-reminders.json` | Override reminder persistence file path |
| `MAILPOUCH_PASS_AUDIT` | `~/.mailpouch-pass-audit.jsonl` | Override Proton Pass access audit log path |
| `MAILPOUCH_FTS_DB` | `~/.mailpouch-fts.db` | Override full-text-search index database path |
| `MAILPOUCH_AGENTS` | `~/.mailpouch-agents.json` | Override per-agent grant store path |
| `MAILPOUCH_SERVICE_ACCOUNTS` | `~/.mailpouch-service-accounts.json` | Override service-account (client_credentials) store path |
| `MAILPOUCH_AGENT_AUDIT` | `~/.mailpouch-agent-audit.jsonl` | Override per-agent tool-call audit log path |
| `MAILPOUCH_MACHINE_SECRET` | derived from host | Override the machine-binding secret used to encrypt at-rest credentials |
| `MAILPOUCH_FORCE_STDIO` | unset | Force stdio for this spawn even if the config has `remoteMode: true`. Set on a stdio MCP-client entry (e.g. Claude Code) so it speaks stdio instead of starting the HTTP server. |
| `MAILPOUCH_INSECURE_BRIDGE` | unset | Per-launch opt-in to localhost Bridge without a pinned cert |
| `MAILPOUCH_TIER` | `complete` | Tool-tier override: `core` (30 tools), `extended` (80), or `complete` (up to 86, depending on optional integrations) |
| `PORT` | `8766` | Override settings UI HTTP server port |

---

## Available Tools

**83 canonical tools across 11 categories, plus 3 always-available meta-tools.** Optional companion groups are listed only when configured; see [`src/config/schema.ts`](src/config/schema.ts) for the machine-checkable inventory.

| Category | Tools | Default tier | Risk | Permission required |
|---|---:|---|---|---|
| Reading | 14 | `core` | safe | always available |
| Sending | 4 | `core` | moderate | `supervised`, `send_only`, `full` |
| Analytics | 4 | `core` | safe | always available |
| System | 5 | `core` | safe | always available |
| Drafts & Scheduling | 9 | `extended` | moderate | `supervised`, `send_only`, `full` |
| Folder Management | 5 | `extended` | moderate | `supervised`, `full` |
| Email Actions | 16 | `extended` | moderate | `supervised`, `full` |
| SimpleLogin Aliases *(optional)* | 16 | `extended` | moderate | listed when API key is present |
| Proton Pass *(optional)* | 4 | `extended` | moderate | listed when a PAT is present; calls require `pass-cli` |
| Deletion | 3 | `complete` | destructive | `full` (capped at 20/hr in `supervised`) |
| Bridge & Server Control | 3 | `complete` | destructive | mixed; `start_bridge` always available |

Plus **3 always-available meta-tools**: `setup_status`, `request_permission_escalation`, and `check_escalation_status`.

### Notable tools worth calling out

- **Reading** includes `get_thread`, `get_correspondence_profile`, and the `fts_*` family (local SQLite FTS5 index — much faster than IMAP search for repeat queries).
- **Drafts & Scheduling** includes `remind_if_no_reply` (queue an outbound, fire a follow-up reminder if no reply lands within N days), `list_pending_reminders`, `cancel_reminder`, `check_reminders`. JSONL persistence so reminders survive restarts.
- **Bridge & Server Control** — if `autoStartBridge` is enabled, the server launches Bridge automatically on startup and runs a 30 s watchdog that attempts up to 3 restarts on outage. `shutdown_server` and `restart_server` are capped at 5/hr in `supervised`.

---

## MCP Prompts

Pre-built prompt templates for common tasks:

| Prompt | Description | Arguments |
|---|---|---|
| `triage_inbox` | Review unread emails, assess urgency, suggest actions | `limit` (default 20), `focus` |
| `compose_reply` | Draft a contextual reply to an email thread | `emailId` (required), `intent` |
| `daily_briefing` | Summarize today's inbox: unread, key senders, action items | — |
| `find_subscriptions` | Identify mailing lists / newsletters; offer to archive or unsubscribe | `folder` (default: INBOX) |
| `thread_summary` | Fetch all messages in a thread; produce a concise summary with open action items | `emailId` (required) |
| `draft_in_my_voice` | Draft a new email to a specific recipient in the user's own voice, using a handful of recent sent emails as tone samples. Infers style (formality, greeting/sign-off habits, typical length) from the samples. | `recipient` (required), `intent` (required), `sampleCount` (optional, default 5, max 20) |

---

## Permission Presets

| Preset | What's allowed | Best for |
|---|---|---|
| **Read-Only** *(default)* | Read, search, analytics, connection status, logs, Bridge start | Starting out; untrusted or new agents |
| **Supervised** | All tools enabled; reading unlimited; sending 200/hr, schedule 100/hr, bulk actions 100/hr; deletion 20/hr; folder delete 20/hr; server lifecycle 5/hr | Day-to-day agentic use |
| **Send-Only** | Reading unlimited; send/forward/schedule 50/hr, remind_if_no_reply 100/hr; actions, deletion, folder writes, and bulk ops disabled | Agents that only need to compose and send |
| **Full Access** | All tools, no rate limits | Trusted workflows where you review actions |
| **Custom** | User-defined per-tool toggles and rate limits (set via the Permissions tab) | Fine-grained control beyond the 4 presets |

Change the preset at any time from the **Permissions** tab in the settings UI; changes take effect within 15 s without restart.

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

- The agent requests via MCP; approval can only happen via browser or terminal — channels the agent cannot write to
- You must type `APPROVE` before the button activates — no accidental clicks
- CSRF-protected: the approval API requires a session token embedded only in the rendered HTML page
- Rate-limited: max 5 escalation requests per hour, max 1 pending at a time
- Audit trail: every request, approval, and denial is appended to `~/.mailpouch.audit.jsonl`
- Approve from another device: `npx -y mailpouch-settings --lan`

---

## Settings UI

The settings UI starts automatically on `http://localhost:8766` whenever your MCP client runs the server. A system tray icon (purple envelope) appears in your taskbar — right-click it to open the UI, disable it temporarily, or quit.

To run the settings UI standalone (useful for initial setup, headless / SSH systems, or a dedicated remote-mode host):

```bash
npx -y mailpouch-settings           # auto-detects display; opens browser if available
npx -y mailpouch-settings --port 9000   # custom port (default: 8766)
npx -y mailpouch-settings --lan         # bind to 0.0.0.0 (approve from phone/other device)
npx -y mailpouch-settings --browser     # force browser UI even if no display detected
npx -y mailpouch-settings --tui         # force interactive terminal UI
npx -y mailpouch-settings --plain       # plain readline menus (no ANSI colors/escapes)
npx -y mailpouch-settings --no-open     # start server but don't auto-open browser
```

The same standalone behaviour is available from the main binary via `mailpouch --settings-only`: it starts only the settings UI + tray (no MCP transport, no Bridge connect) and stays running until you quit it from the tray or with Ctrl-C. Unlike a bare `mailpouch`, it is safe to launch detached (autostart / `nohup` / a wrapper) — it does not tie its lifetime to stdin.

Tabs:

- **Setup** — credentials, SMTP/IMAP hosts and ports, Bridge TLS certificate, Optional Integrations (SimpleLogin API key, Proton Pass PAT + CLI path), debug mode, auto-start Bridge, insecure-connection toggle, destructive-confirm toggle, desktop notifications toggle, auto-open approval window toggle, settings port
- **Accounts** — per-account Bridge credentials; live active-account switching with an explicit restart fallback
- **Permissions** — preset selector, per-tool enable/rate-limit toggles, tool-tier (`core` / `extended` / `complete`), destructive-confirm toggle
- **Agents** — per-client (OAuth `client_id`) approvable grants with folder allowlists, IP pins, per-tool rate caps, expiry, and account binding
- **Status** — server info, MCP config snippet, live connectivity check, escalation audit log, config reset

Pending escalation requests appear as a full-page banner above the tabs. A **Logs** tab appears automatically when debug mode is enabled. Most settings changes propagate to the running MCP server within 15 s; active-account switching explicitly reports when a restart is required.

---

## Security

This server gives AI agents *controlled* access to sensitive email data. The security model has these layers:

| Layer | Mechanism |
|---|---|
| Permission gate | Every tool call checked against `~/.mailpouch.json` (refreshed every 15 s) |
| Tool tiering | `core` / `extended` / `complete` controls the `ListTools` surface and context budget; permission gates remain the enforcement boundary |
| Rate limiting | Per-tool sliding-window limits in-process; per-caller token-bucket on the HTTP transport |
| Destructive confirmation | MCP elicitation prompt (or required `{ confirmed: true }`) on delete / trash / spam, SimpleLogin deletion, server lifecycle, and sensitive Pass retrieval |
| Escalation gate | Privilege increases require explicit human approval via a separate channel |
| Audit log | Append-only log of all escalation events at `~/.mailpouch.audit.jsonl` |
| OAuth 2.1 + PKCE-S256 | Spec-compliant DCR + automatic consent; per-agent Approve/Deny is the human gate (HTTP transport) |
| CSRF protection | All mutating settings API calls require a session token (timing-safe comparison) |
| Origin validation | Settings server validates `Origin`/`Referer` headers; rejects unknown origins |
| Input validation | Email addresses, folder names, attachment sizes, hostnames, label names |
| Injection prevention | CRLF stripped from all SMTP headers, subjects, filenames, custom headers |
| TLS-strict Bridge | Refuses to connect to localhost Bridge without a pinned cert by default |
| Bridge version floor | Warns when Bridge < `3.22.0` (FIDO2 + 50 MB import cap hardening) |
| SMTP backoff | Exponential backoff on abuse-signal SMTP responses (4xx 421/450/454 throttle codes) |
| Config file isolation | Mode `0600`; preset and tool names validated on load; config schema versioned |
| Memory safety | Email cache capped at 500 entries / 50 MB; rate-limiter buckets evicted when idle (fully refilled) |
| Keychain storage | OS keychain preferred for Bridge password and SMTP token |

**What agents cannot do:**
- Approve their own escalation requests
- Bypass the permission gate (it runs in the server process, not the agent)
- Read or modify `~/.mailpouch.json` directly (not an exposed tool)
- Erase the audit log
- Inject headers into outgoing email via crafted subjects, filenames, or custom headers
- Execute destructive tools without surfacing the intent to the user

**Credentials:** Stored in `~/.mailpouch.json` with `0600` permissions (or in the OS keychain). Never commit this file. The settings UI never displays or transmits high-value secrets after they are first saved.

---

## Agent Grants

The global permission preset gates *what actions are allowed*; the selected tool tier controls what is advertised; and an **agent grant** gates which MCP client may use that allowed surface. **Every agent — local and remote — registers and must be approved.** A remote MCP host completes OAuth Dynamic Client Registration and mailpouch creates a `pending` grant keyed by its `client_id`; a **local stdio client** (e.g. Claude Desktop) is registered at the MCP handshake, keyed by its self-reported client name (`stdio:<hash>`) and shown with a 🖥 local marker. Nothing that client calls will succeed until you approve it; approve once and a local client is remembered across relaunches. To restore the legacy "local client is auto-trusted" behavior, set `gateLocalAgents: false` (or `MAILPOUCH_TRUST_LOCAL=1`).

Grant lifecycle: `pending` → `active` → `revoked` | `expired`. Each grant carries:

| Field | Purpose |
|---|---|
| `preset` | Effective preset for this agent; intersected with the global preset (grants can never widen the ceiling) |
| `toolOverrides` | Per-tool allow/deny that trumps the preset, still bounded by the global config |
| `conditions.expiresAt` | ISO-8601 auto-expiry; checked at call time |
| `conditions.folderAllowlist` | Restrict which IMAP folders the agent may touch |
| `conditions.ipPins` | Allowed remote IPs (OAuth/bearer path only) |
| `conditions.maxCallsPerHourByTool` | Per-tool hourly rate cap |
| `conditions.accountId` | Bind the agent to a single multi-account id |

Approve, deny, revoke, and "approve-with-conditions" all live in the **Agents** tab of the settings UI. The tab streams live updates over SSE from `GET /api/notifications` — new pending grants surface without a reload. When a new agent registers, mailpouch also **auto-opens this tab in your browser** (and fires a desktop notification + tray badge) so you can approve or deny the connection right away; the pending card shows the agent's name, registering IP, and time. The agent's tool calls stay blocked until you approve. When a new agent connects, mailpouch pops a **native Approve/Deny dialog right on the screen where it runs** (zenity/osascript/PowerShell) so you can decide without opening the tab — Approve grants your global preset, Deny revokes it (`nativeApprovalDialog`, default on). If no dialog tool is available (headless), it falls back to **auto-opening this Agents tab** in your browser (`autoOpenApprovalWindow`, default on) plus a desktop notification + tray badge. Once connected, the card also shows the agent's **MCP handshake connection info** — its self-reported client name + version, the transport, and a last-connected timestamp — captured at `initialize` (display-only; the agent's identity is its server-issued OAuth `client_id`, not the self-reported name).

> **Every agent authenticates as its own client — there is no shared bearer.** The static bearer was removed because it had no per-agent identity (one secret, no gating, no audit). Remote mode requires OAuth (`connection.remoteMode: true` + `remoteOauthEnabled: true`). Interactive agents register and you **Approve/Deny** them here (automatic consent — no human password; a pending request expires after 5 minutes). Headless agents (cron, CI) use a pre-approved **service account** (`mailpouch agent issue …` or the "+ Service account" button) and the `client_credentials` grant. `remoteBearerToken` and `remoteOauthAdminPassword` are deprecated and ignored.

Every gated tool call writes one row to an append-only JSONL audit log at `~/.mailpouch-agent-audit.jsonl` (mode `0600`). Rows carry a truncated sha256 `argHash` — **never argument values, never response bodies** — so "same call repeated" patterns are observable without creating a parallel on-disk copy of your email. The log rotates at 10 MB and keeps 3 gzipped generations.

Caller identity propagates through the dispatcher via `AsyncLocalStorage` (see [`src/agents/caller-context.ts`](src/agents/caller-context.ts)); the caller's `clientId` is always a real per-agent identity (`pmc_…` for OAuth clients and service accounts, `stdio:…` for local stdio agents). Local stdio agents are gated too (`gateLocalAgents`, default on) — they register and must be approved like any other agent.

Canonical code: [`src/agents/grant-store.ts`](src/agents/grant-store.ts), [`grant-manager.ts`](src/agents/grant-manager.ts), [`audit.ts`](src/agents/audit.ts), [`caller-context.ts`](src/agents/caller-context.ts), [`notifications.ts`](src/agents/notifications.ts), [`registry.ts`](src/agents/registry.ts).

---

## Notification Channels

Grant-state transitions (`grant-created` / `-approved` / `-denied` / `-revoked` / `-expired`) fan out through an in-process `NotificationBroker` to two optional channels:

- **Desktop toasts** — platform-native, no extra dependency. macOS shells to `osascript`, Linux to `notify-send` (libnotify), Windows to `powershell.exe` driving the WinRT toast API. Fire-and-forget; missing tooling degrades to a debug log.
- **Outbound webhooks** — `WebhookDispatcher` POSTs a JSON body to each configured endpoint. Format defaults to **CloudEvents 1.0**; URLs on `hooks.slack.com` auto-select the Slack shape and `discord.com` / `discordapp.com` auto-select the Discord shape (explicit `format: "raw"` is also available). When an endpoint has a secret configured, every body is HMAC-signed as `X-Mailpouch-Signature-256: sha256=<hex>` (GitHub-webhook convention). Delivery retries up to 8 times with exponential backoff (1 / 2 / 4 / 8 / 16 / 32 / 64 / 128 s) plus ±20 % jitter; 4xx responses other than 408 and 429 stop retries immediately.

Canonical code: [`src/notifications/desktop.ts`](src/notifications/desktop.ts), [`src/notifications/webhooks.ts`](src/notifications/webhooks.ts).

---

## Troubleshooting

### "Connection refused" on Bridge ports

- Confirm Proton Bridge is **running and signed in**.
- Use `127.0.0.1` instead of `localhost` in all host fields.
- Verify ports are listening: `lsof -i :1025 -i :1143` (macOS/Linux) or `netstat -ano | findstr "1025\|1143"` (Windows).
- Some VPNs block localhost port binding — try disabling the VPN.

### "Authentication failed" or IMAP login error

- Use the **Bridge password**, not your Proton Mail login password.
- Find it in the Bridge app: **Settings → IMAP/SMTP → Password** (a long random string).
- If you recently reinstalled Bridge, it generates a new password — update it in the settings UI.

### "Tool blocked by permission policy"

- Open the settings UI → **Permissions** tab and switch to **Supervised** or **Full Access**.
- Per-tool toggles let you enable individual tools without changing the overall preset.
- The agent can call `request_permission_escalation` for temporary access.

### "Certificate error" or TLS handshake failure

- Export the Bridge TLS certificate: Bridge app → **Settings → Export TLS certificates**.
- Set the path in the settings UI under **Setup → Bridge TLS Certificate**.

> The server refuses to connect to a localhost Bridge without a pinned TLS certificate — this matches Proton Bridge's own v3.21.2+ hardening. If you cannot provide a cert, set **Allow insecure Bridge connection** under Setup (or launch with `MAILPOUCH_INSECURE_BRIDGE=1`) to opt back into the legacy behavior. Configs that predate this change are grandfathered into the legacy mode with a startup warning until the opt-in is set explicitly.

### Bridge version warning on startup

- The server issues an IMAP `ID` request after connect and warns when Bridge is older than **3.22.0** (the minimum supported). Upgrade from the Bridge app → **Check for updates**.

### Tool list looks short / missing tools

- Check your **tool tier** under Permissions. `core` exposes 30 tools; `extended` exposes 80; `complete` exposes up to 86, with unconfigured SimpleLogin and Pass tools omitted.
- SimpleLogin and Proton Pass tools (`alias_*`, `pass_*`) appear once their API key or PAT is configured. The `fts_*` tools remain listed and require `better-sqlite3` when called.

### Remote / HTTP client returns 401

- The `Authorization: Bearer <token>` header must carry an **OAuth access token**, not a pre-shared secret — the static bearer was removed. For interactive clients, check that `/oauth/register` succeeded, the agent is **approved** in the Agents tab, and the token has not been revoked or expired.
- For headless clients, confirm the service account exists (`mailpouch agent list`) and that `POST /oauth/token` with `grant_type=client_credentials` returned an `access_token`. A 401 `invalid_client` means the `client_id`/`client_secret` pair is wrong.
- The `WWW-Authenticate` header on the 401 response carries the failure reason per RFC 6750.

### Claude Desktop doesn't show mailpouch tools

- Confirm the `mcpServers` block is valid JSON (no trailing commas).
- Fully quit and reopen Claude Desktop.
- Check MCP logs: **Help → Show Logs**.
- Verify the server starts manually: `npx -y mailpouch` — it should stay running silently.

### Analytics show zero or empty data

- Run `sync_emails` first to populate the cache.
- Response time stats only appear when sent emails have `In-Reply-To` headers matching inbox messages.

---

## Development

```bash
git clone https://github.com/chandshy/mailpouch.git
cd mailpouch
npm install

npm run build          # compile TypeScript to dist/
npm run dev            # watch mode (recompiles on save)
npm run test           # run the Vitest suite
npm run test:coverage  # coverage report
npm run lint           # TypeScript type check (tsc --noEmit)
npm run settings       # start standalone settings UI (after build)
```

### Project structure

```
src/
  index.ts                    # Unified daemon: MCP server (up to 86 tools, resources, prompts) + settings + tray
  settings-main.ts            # Standalone settings UI CLI (for headless/SSH environments)
  # (Tray moved to native/tray/ — napi-rs binding around tauri-apps/tray-icon)
  config/
    schema.ts                 # Tool registry, categories, tiers, destructive set, response limits
    loader.ts                 # Config load/save, preset builder, keychain migration
  permissions/
    manager.ts                # Per-tool permission checks and rate limiting
    escalation.ts             # Human-gated escalation challenge system
  security/
    keychain.ts               # OS keychain integration (@napi-rs/keyring)
    memory.ts                 # Credential wipe helpers
  services/
    smtp-service.ts           # Email sending via Nodemailer (with abuse-signal backoff)
    simple-imap-service.ts    # Email reading via ImapFlow
    analytics-service.ts      # Email analytics computation
    scheduler.ts              # Scheduled email delivery (JSONL persistence)
    reminder-service.ts       # remind_if_no_reply queue
    fts-service.ts            # Local SQLite FTS5 index (optional better-sqlite3)
    simplelogin-service.ts    # SimpleLogin alias API client
    pass-service.ts           # Proton Pass via pass-cli subprocess
  settings/
    server.ts                 # Browser-based settings UI server
    security.ts               # CSRF, origin validation, TLS
    tui.ts                    # Terminal UI for settings
  transports/
    http.ts                   # HTTP transport (bearer + optional OAuth)
    oauth-handlers.ts         # /.well-known + /oauth/* (RFC 7591/8414/9728)
    oauth-store.ts            # Client / authorization-code / token store
    rate-limit.ts             # Token-bucket per-caller limiter
  utils/
    helpers.ts                # ID generation, email validation, log sanitisation
    logger.ts                 # Structured log store
    tracer.ts                 # Lightweight request tracing
    backoff.ts                # Exponential backoff helper
  types/
    index.ts                  # Shared TypeScript types
```

---

## Works Best With…

mailpouch is deliberately scoped to email. Chain it with these MCP servers to cover the rest of an agentic workflow:

| MCP server | Use with mailpouch |
|---|---|
| [`filesystem`](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem) (reference) | Save attachments to disk; read local files to attach to outgoing mail |
| [`fetch`](https://github.com/modelcontextprotocol/servers/tree/main/src/fetch) (reference) | Follow links the agent reads in an email without leaving the chat |
| [`Doist/todoist-mcp`](https://github.com/Doist/todoist-mcp) | Turn an email into a task; complete triage in one pass |
| [`linear-mcp`](https://github.com/jerhadf/linear-mcp-server) | File an issue from a bug-report email with full context |
| Obsidian-vault MCPs ([example](https://github.com/MarkusPfundstein/mcp-obsidian)) | Archive important threads to notes with linked metadata |

The project is intentionally Proton-focused; the positioning is "best email surface for your agent." Pair it with whichever non-email MCPs fit your workflow rather than waiting for this server to grow a second home.

---

## Acknowledgements

This project is built on the foundation originally created by **[Hawk94](https://github.com/Hawk94)**, whose initial IMAP/SMTP integration, tool architecture, and test setup made this project possible. The original work was published as [barhatch/protonmail-mcp-server](https://github.com/barhatch/protonmail-mcp-server).

---

## License

MIT — see [LICENSE](LICENSE)

---

*Unofficial third-party server. Not affiliated with or endorsed by Proton AG.*

[GitHub](https://github.com/chandshy/mailpouch) · [npm](https://www.npmjs.com/package/mailpouch) · [Issues](https://github.com/chandshy/mailpouch/issues) · [Model Context Protocol](https://modelcontextprotocol.io)
