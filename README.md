# mailpouch

`mailpouch` is an MCP server that gives AI agents a typed, permission-gated, audit-logged tool surface over private-mail providers — Proton Mail (via Proton Bridge) and plain IMAP today, with Tuta and Mailfence on the roadmap.

The pitch in one line: if you picked Proton Mail because you didn't want a third party reading your inbox, you don't suddenly want to hand a chatbot OAuth access to that same inbox so it can triage on your behalf. The usual "connect your email" integrations route everything through someone else's servers and ask for blanket scopes. Hand-rolled IMAP inside the agent is worse — no permission boundary, no audit trail, and the model holds your credentials in its context window. Neither option respects why you chose the provider in the first place.

`mailpouch` runs locally and speaks to Proton Bridge over a TLS socket on your own machine; nothing leaves the box unless you asked it to. Sixty-nine tools across reading, sending, drafts, folders, search, analytics, aliases, Proton Pass, and system control, tiered into `core` / `extended` / `complete` so an agent that only reads doesn't burn context on Bridge lifecycle tools it will never call. Every connecting client gets its own grant with folder allowlists, IP pins, per-tool rate caps, expiry, and account binding — all hashed-args in the audit log, never the values. Delete, trash, spam, and alias removal round-trip through MCP elicitation for human confirmation before they execute. That last part sounds like theatre until you watch an agent try to empty a folder and get blocked mid-call.

It is real because the primitives are real: OAuth 2.1 with PKCE S256, RFC 7591 dynamic client registration, RFC 8707 resource indicators, RFC 9728 protected-resource metadata, or a static bearer token if you'd rather. Credentials live in the OS keychain. A local FTS5 index with BM25 ranking handles phrase, boolean, prefix, and column-filter queries so your search terms never leave your laptop. Desktop notifications use native `osascript` / `notify-send` / `powershell.exe` with no added dependency; webhook dispatch auto-detects CloudEvents 1.0, Slack, or Discord, signs with HMAC, and retries with eight-attempt exponential backoff. So how do you point it at your Bridge install and wire up a client?

[![CI](https://github.com/chandshy/mailpouch/actions/workflows/ci.yml/badge.svg)](https://github.com/chandshy/mailpouch/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/badge/npm-v2.2.0-blue.svg)](https://www.npmjs.com/package/mailpouch)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)
[![MCP SDK](https://img.shields.io/badge/MCP%20SDK-1.29+-green.svg)](https://github.com/modelcontextprotocol/sdk)
[![Tests](https://img.shields.io/badge/tests-1%2C525%20passing-brightgreen.svg)](#development)

**Read, compose, and manage your encrypted Proton Mail inbox from any AI assistant — over stdio or remote HTTP — with human-controlled permissions.**

---

## ⚠ Proton Terms of Service Notice

This is an **unofficial third-party tool** that connects to Proton Mail through Proton Bridge's local IMAP/SMTP surface. It is **not affiliated with, endorsed by, or authored by Proton AG**.

Proton's Terms of Service ([proton.me/legal/terms](https://proton.me/legal/terms)) §2.10 prohibits "accessing the Services through automated means (including but not limited to bots, scripts, or similar technologies)". The textual reading covers agentic / scripted workloads against Bridge even though Bridge itself is a sanctioned surface.

This server is designed to keep access **user-initiated**, not autonomous:

- Default permission preset is `read_only`. Sending, deletion, and folder mutation require explicit user opt-in via the settings UI.
- Destructive tools (delete / move-to-trash / move-to-spam / `alias_delete` / `pass_get`) require explicit confirmation. With MCP elicitation-capable clients, the server prompts the user out-of-band before executing; non-elicitation clients must pass `{ confirmed: true }`.
- Elevated permissions require out-of-band human approval (settings UI button or terminal), not an agent-only grant.
- The settings UI shows a first-run ToS acknowledgement the user must click through before credentials are accepted.

You remain the operator of your Proton account. Running this server against your own account is your decision to make under Proton's ToS; the authors disclaim responsibility for ToS compliance on your behalf.

---

## What It Does

Proton Mail encrypts your email end-to-end, which means no third-party API can read it. [Proton Bridge](https://proton.me/mail/bridge) solves this by decrypting email locally. This MCP server connects to Bridge and gives Claude (or any MCP host) structured, permission-gated access to your inbox.

Your emails are decrypted on your own machine by Proton Bridge. This server never persists email content — everything stays in memory and is cleared on restart. You control exactly what the AI can do through a preset permission system with human-gated escalation for anything sensitive.

---

## Key Features

- **67 tools** across 11 categories — reading, search, analytics, sending, drafts, scheduling, follow-up reminders, folder management, bulk actions, deletion, Bridge/server lifecycle, plus optional companion services (SimpleLogin aliases, Proton Pass, local FTS5 search). See [`src/config/schema.ts`](src/config/schema.ts) (`ALL_TOOLS`, `TOOL_CATEGORIES`) for the canonical inventory.
- **Two transports** — stdio (default, Claude Desktop) and HTTP (remote / self-host). HTTP supports a static bearer **and/or** OAuth 2.1 with PKCE-S256, RFC 7591 Dynamic Client Registration, RFC 8414 authorization-server metadata, and RFC 9728 protected-resource metadata. Per-caller token-bucket rate limiting on every endpoint.
- **Progressive tool tiering** — `core` / `extended` / `complete` controls how many tools land in the client's `ListTools` response, so context isn't burned on tools you don't use. Configurable via `toolTier` or `MAILPOUCH_TIER`.
- **Destructive-tool confirmation** — uses MCP elicitation when the client supports it (Claude Desktop, Cline) so the user sees a prompt before any delete / trash / spam / `alias_delete` / `pass_get` runs. Falls back to a required `{ confirmed: true }` argument for clients without elicitation.
- **5 permission presets** — read-only by default; write access requires explicit opt-in. Per-tool overrides and rate limits via the **Custom** preset.
- **Human-gated escalation** — agents request elevated permissions, you approve via browser UI or terminal; the agent cannot approve its own requests.
- **Browser-based settings UI** at `localhost:8765` — auto-starts with the daemon; setup wizard, live connection test, per-tool toggles, escalation approval panel, OAuth admin password.
- **System tray icon** — always visible; toggle the settings UI on/off or quit from the tray without touching the terminal.
- **5 MCP prompts** — triage inbox, compose reply, daily briefing, find subscriptions, thread summary.
- **MCP Resources** — individual emails and folders addressable via `email://` and `folder://` URIs.
- **Scheduled email delivery** — queue emails for future sending; survives server restarts. Plus `remind_if_no_reply` for outbound follow-ups gated on inbox replies.
- **Optional companion services** — SimpleLogin alias management (6 tools, requires API key), Proton Pass via pass-cli (3 tools, requires PAT), local FTS5 full-text index (3 tools, requires `better-sqlite3`).
- **TLS-strict by default** — refuses to connect to localhost Bridge without a pinned cert, requires Bridge ≥ `3.22.0`, exponential backoff on SMTP abuse-signal responses.
- **Multi-account** — configure more than one Proton / IMAP account; hot-swap the active account from the Settings UI with no server restart. Tools accept an optional `account_id` argument to route a single call to a specific account. See [`src/accounts/`](src/accounts/).
- **Per-agent grants** — each MCP client (identified by its OAuth `client_id`) is gated by its own approvable grant, with optional folder allowlists, IP pins, per-tool rate caps, expiry, and account binding. Separate from the global preset and the escalation flow. See [`src/agents/`](src/agents/).
- **Live notifications** — desktop toasts (no extra deps) and outbound webhooks (CloudEvents / Slack / Discord, HMAC-signed, retried) fire on grant-state changes. See [`src/notifications/`](src/notifications/).
- **1,525 tests passing** (Vitest); zero `any` type annotations in production source.

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
npm install -g github:chandshy/mailpouch
```

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
| `pass-cli` (Proton's Go CLI) | `pass_list` / `pass_search` / `pass_get` | See [`pass-cli`](https://github.com/ProtonMail/pass-cli); set a Pass PAT in the settings UI |
| SimpleLogin API key | `alias_*` tools | Generate at [app.simplelogin.io](https://app.simplelogin.io/dashboard/api_key); paste in settings UI |

Tools in unconfigured groups return a clean configuration error rather than failing silently.

---

## Setup Wizard

Run the settings server to complete first-time setup:

```bash
npx mailpouch-settings
# Then open http://localhost:8765
```

The **6-step wizard** walks you through everything automatically:

1. **Welcome** — overview, ToS acknowledgement, and prerequisites checklist
2. **Bridge health check** — live TCP test to ports 1025 and 1143; blocks progress until Bridge is reachable
3. **Credentials** — your Proton Mail address and Bridge password (Bridge app → Settings → IMAP/SMTP → Password — this is **not** your Proton login password)
4. **Permission preset** — choose what the AI is allowed to do (see table below)
5. **Review** — confirm your settings before saving
6. **Done** — displays the exact JSON snippet to paste into your MCP client config; optionally writes it for you automatically

Settings are saved to `~/.mailpouch.json` with mode `0600` (owner read/write only). Bridge passwords, OAuth admin passwords, and Pass PATs prefer the OS keychain when available.

---

## Claude Desktop Configuration (stdio)

**Use the settings wizard to get the correct snippet for your machine.** The final step of the wizard (or the Status tab → MCP Config Snippet) generates and copies the exact JSON to use — the path to the installed package differs per machine and OS.

The config file locations are:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux:** `~/.config/Claude/claude_desktop_config.json`

The generated entry looks like this (your path will differ):

```json
{
  "mcpServers": {
    "mailpouch": {
      "command": "node",
      "args": ["/path/to/node_modules/mailpouch/dist/index.js"]
    }
  }
}
```

The wizard can also write this entry to your client config automatically — click **Write to Claude Desktop** on the Done step. Restart the client after saving.

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
- `AccountManager` keeps one `{ imap, smtp, spec }` triple per configured account. Saving a new active selection emits an `active-changed` event and the module-level service references hot-swap — no restart required.
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
    "remoteBearerToken": "<long-random-string>",
    "remoteTlsCertPath": "/path/to/cert.pem",
    "remoteTlsKeyPath":  "/path/to/key.pem",
    "remoteOauthEnabled": true,
    "remoteOauthAdminPassword": "<consent-password>",
    "remoteOauthIssuer": "https://mcp.example.com",
    "remoteRateLimitPerSecond": 20,
    "remoteRateLimitBurst": 40
  }
}
```

**Auth modes** (mix freely on the same listener):

- **Static bearer** — programmatic clients send `Authorization: Bearer <token>`. Constant-time comparison.
- **OAuth 2.1 + PKCE-S256** — MCP hosts self-register via `POST /oauth/register` (RFC 7591), discover endpoints via `GET /.well-known/oauth-authorization-server` (RFC 8414) and `GET /.well-known/oauth-protected-resource` (RFC 9728), then run a PKCE consent flow gated on the admin password. Refresh and revocation supported.

**Rate limiting** — token-bucket per caller (per IP for unauthed paths, per token key for `/mcp`). A compromised token can't DoS Bridge.

**TLS** — provide `remoteTlsCertPath` + `remoteTlsKeyPath` for HTTPS. Required for any non-loopback exposure.

A static-bearer client config looks like:

```json
{
  "mcpServers": {
    "mailpouch-remote": {
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

### Environment variables

Configuration is stored in `~/.mailpouch.json` and managed via the settings UI — not environment variables. The following env vars are available for advanced/optional overrides:

| Variable | Default | Description |
|---|---|---|
| `MAILPOUCH_CONFIG` | `~/.mailpouch.json` | Override config file path |
| `MAILPOUCH_SCHEDULER_STORE` | `~/.mailpouch-scheduled.json` | Scheduled email persistence file |
| `MAILPOUCH_LOG_FILE` | `~/.mailpouch.log` | Override log file path |
| `MAILPOUCH_PENDING` | `~/.mailpouch.pending.json` | Override pending escalations file path |
| `MAILPOUCH_AUDIT` | `~/.mailpouch.audit.jsonl` | Override escalation audit log path |
| `MAILPOUCH_INSECURE_BRIDGE` | unset | Per-launch opt-in to localhost Bridge without a pinned cert |
| `MAILPOUCH_TIER` | `complete` | Tool-tier override: `core` / `extended` / `complete` |
| `PORT` | `8765` | Override settings UI HTTP server port |

---

## Available Tools

**67 tools across 11 categories.** This README lists categories and counts; see [`src/config/schema.ts`](src/config/schema.ts) (`ALL_TOOLS` and `TOOL_CATEGORIES`) for the canonical, machine-checkable inventory.

| Category | Tools | Default tier | Risk | Permission required |
|---|---:|---|---|---|
| Reading | 12 | `core` | safe | always available |
| Sending | 4 | `core` | moderate | `supervised`, `send_only`, `full` |
| Analytics | 4 | `core` | safe | always available |
| System | 4 | `core` | safe | always available |
| Drafts & Scheduling | 9 | `extended` | moderate | `supervised`, `send_only`, `full` |
| Folder Management | 5 | `extended` | moderate | `supervised`, `full` |
| Email Actions | 14 | `extended` | moderate | `supervised`, `full` |
| SimpleLogin Aliases *(optional)* | 6 | `extended` | moderate | enabled when API key present |
| Proton Pass *(optional)* | 3 | `extended` | moderate | enabled when PAT + `pass-cli` present |
| Deletion | 3 | `complete` | destructive | `full` (capped at 5/hr in `supervised`) |
| Bridge & Server Control | 3 | `complete` | destructive | mixed; `start_bridge` always available |

Plus **2 always-available escalation tools** (`request_permission_escalation`, `check_escalation_status`) outside the category registry.

### Notable tools worth calling out

- **Reading** includes `get_thread`, `get_correspondence_profile`, and the `fts_*` family (local SQLite FTS5 index — much faster than IMAP search for repeat queries).
- **Drafts & Scheduling** includes `remind_if_no_reply` (queue an outbound, fire a follow-up reminder if no reply lands within N days), `list_pending_reminders`, `cancel_reminder`, `check_reminders`. JSONL persistence so reminders survive restarts.
- **Bridge & Server Control** — if `autoStartBridge` is enabled, the server launches Bridge automatically on startup and runs a 30 s watchdog that attempts up to 3 restarts on outage. `shutdown_server` and `restart_server` are capped at 2/hr in `supervised`.

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

---

## Permission Presets

| Preset | What's allowed | Best for |
|---|---|---|
| **Read-Only** *(default)* | Read, search, analytics, connection status, logs, Bridge start | Starting out; untrusted or new agents |
| **Supervised** | All tools; deletion 5/hr, sending 20/hr, bulk actions 10/hr, server lifecycle 2/hr; read-heavy tools rate-limited (`get_emails` 60/hr, `search_emails` 30/hr, `get_email_by_id` 200/hr) | Day-to-day agentic use |
| **Send-Only** | Reading + sending + drafts + scheduling + connection status + logs + Bridge start; no deletion, no folder writes, no server lifecycle | Agents that only need to compose and send |
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
- Approve from another device: `npx mailpouch-settings --lan`

---

## Settings UI

The settings UI starts automatically on `http://localhost:8765` whenever your MCP client runs the server. A system tray icon (purple envelope) appears in your taskbar — right-click it to open the UI, disable it temporarily, or quit.

To run the settings UI standalone (useful for initial setup, headless / SSH systems, or a dedicated remote-mode host):

```bash
npx mailpouch-settings           # auto-detects display; opens browser if available
npx mailpouch-settings --port 9000   # custom port (default: 8765)
npx mailpouch-settings --lan         # bind to 0.0.0.0 (approve from phone/other device)
npx mailpouch-settings --browser     # force browser UI even if no display detected
npx mailpouch-settings --tui         # force interactive terminal UI
npx mailpouch-settings --plain       # plain readline menus (no ANSI colors/escapes)
npx mailpouch-settings --no-open     # start server but don't auto-open browser
```

Tabs:

- **Setup** — credentials, SMTP/IMAP hosts and ports, Bridge TLS certificate, remote/HTTP mode, OAuth admin password, SimpleLogin / Pass tokens, debug mode
- **Permissions** — preset selector, per-tool enable/rate-limit toggles, tool-tier (`core` / `extended` / `complete`), destructive-confirm toggle
- **Status** — server info, MCP config snippet, live connectivity check, escalation audit log, config reset

Pending escalation requests appear as a full-page banner above the tabs. A **Logs** tab appears automatically when debug mode is enabled. Changes propagate to the running MCP server within 15 s — no restart required.

---

## Security

This server gives AI agents *controlled* access to sensitive email data. The security model has these layers:

| Layer | Mechanism |
|---|---|
| Permission gate | Every tool call checked against `~/.mailpouch.json` (refreshed every 15 s) |
| Tool tiering | `core` / `extended` / `complete` controls the `ListTools` surface — agents can't call what they can't see |
| Rate limiting | Per-tool sliding-window limits in-process; per-caller token-bucket on the HTTP transport |
| Destructive confirmation | MCP elicitation prompt (or required `{ confirmed: true }`) on delete / trash / spam / `alias_delete` / `pass_get` |
| Escalation gate | Privilege increases require explicit human approval via a separate channel |
| Audit log | Append-only log of all escalation events at `~/.mailpouch.audit.jsonl` |
| OAuth 2.1 + PKCE-S256 | Spec-compliant DCR + consent flow gated on admin password (HTTP transport) |
| CSRF protection | All mutating settings API calls require a session token (timing-safe comparison) |
| Origin validation | Settings server validates `Origin`/`Referer` headers; rejects unknown origins |
| Input validation | Email addresses, folder names, attachment sizes, hostnames, label names |
| Injection prevention | CRLF stripped from all SMTP headers, subjects, filenames, custom headers |
| TLS-strict Bridge | Refuses to connect to localhost Bridge without a pinned cert by default |
| Bridge version floor | Warns when Bridge < `3.22.0` (FIDO2 + 50 MB import cap hardening) |
| SMTP backoff | Exponential backoff on abuse-signal SMTP responses (4xx 421/450/451 throttle codes) |
| Config file isolation | Mode `0600`; preset and tool names validated on load; config schema versioned |
| Memory safety | Email cache capped at 500 entries / 50 MB; rate-limiter buckets capped at 10,000 keys |
| Keychain storage | OS keychain preferred for Bridge password, OAuth admin password, Pass PAT |

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

The global permission preset gates *what tools exist*; an **agent grant** gates *which MCP client gets to use them*. When an MCP host completes OAuth Dynamic Client Registration, mailpouch creates a `pending` grant keyed by the new `client_id`. Nothing that client calls will succeed until you approve it.

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

Approve, deny, revoke, and "approve-with-conditions" all live in the **Agents** tab of the settings UI. The tab streams live updates over SSE from `GET /api/notifications` — new pending grants surface without a reload.

Every gated tool call writes one row to an append-only JSONL audit log at `~/.mailpouch-agent-audit.jsonl` (mode `0600`). Rows carry a truncated sha256 `argHash` — **never argument values, never response bodies** — so "same call repeated" patterns are observable without creating a parallel on-disk copy of your email. The log rotates at 10 MB and keeps 3 gzipped generations.

Caller identity propagates through the dispatcher via `AsyncLocalStorage` (see [`src/agents/caller-context.ts`](src/agents/caller-context.ts)); stdio callers (default Claude Desktop) have no context and bypass the grant gate as the local trusted caller.

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

- Check your **tool tier** under Permissions. `core` exposes ~24 tools; `extended` adds drafts, folders, actions, aliases, Pass; `complete` (default) exposes everything.
- Optional companion tools (`alias_*`, `pass_*`, `fts_*`) only appear when their dependency / token is configured.

### Remote / HTTP client returns 401

- Verify the `Authorization: Bearer <token>` header matches `remoteBearerToken`.
- For OAuth clients, check that `/oauth/register` succeeded and the access token has not been revoked or expired.
- The `WWW-Authenticate` header on the 401 response carries the failure reason per RFC 6750.

### Claude Desktop doesn't show mailpouch tools

- Confirm the `mcpServers` block is valid JSON (no trailing commas).
- Fully quit and reopen Claude Desktop.
- Check MCP logs: **Help → Show Logs**.
- Verify the server starts manually: `npx mailpouch` — it should stay running silently.

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
npm run test           # run test suite (Vitest, 1,525 tests)
npm run test:coverage  # coverage report
npm run lint           # TypeScript type check (tsc --noEmit)
npm run settings       # start standalone settings UI (after build)
```

### Project structure

```
src/
  index.ts                    # Unified daemon: MCP server (67 tools, resources, prompts) + settings + tray
  settings-main.ts            # Standalone settings UI CLI (for headless/SSH environments)
  tray.ts                     # System tray icon (systray2)
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
