# mailpouch — Help Guide

Practical how-tos for every feature. For API reference see [README_FIRST_AI.md](README_FIRST_AI.md); for security architecture see [SECURITY.md](SECURITY.md).

---

## Table of Contents

1. [Quick Start](#1-quick-start)
2. [Connection Setup](#2-connection-setup)
3. [Permission Presets](#3-permission-presets)
4. [Optional Integrations](#4-optional-integrations)
5. [Desktop Notifications](#5-desktop-notifications)
6. [Full-Text Search](#6-full-text-search)
7. [Drafts, Scheduling & Reminders](#7-drafts-scheduling--reminders)
8. [Labels & Folders](#8-labels--folders)
9. [Analytics & Contacts](#9-analytics--contacts)
10. [Per-Agent Grants](#10-per-agent-grants)
11. [Escalation Requests](#11-escalation-requests)
12. [Multi-Account](#12-multi-account)
13. [Remote / HTTP Mode](#13-remote--http-mode)
14. [Response Limits](#14-response-limits)
15. [Troubleshooting](#15-troubleshooting)

---

## 1. Quick Start

```bash
npx -y mailpouch-settings      # opens the settings UI in your browser (no install needed)
```

**Three things you need before Claude can read your mail:**

1. **Proton Bridge running** — [download here](https://proton.me/mail/bridge). Bridge must be open and logged in.
2. **Bridge password** — found in Bridge → Settings → IMAP/SMTP → Password. Not your Proton login password.
3. **Bridge TLS cert** — export from Bridge → Settings → Export TLS certificates → save `cert.pem` somewhere.

Fill these in on the Setup tab, click **Save Configuration**, then **Test Connections**. Green means ready.

Prefer the command line? `npx -y mailpouch setup --username you@proton.me --password-stdin` writes the same config, and `npx -y mailpouch doctor` verifies it.

### CLI commands

Run any of these as `npx -y mailpouch <command>` — the `npx -y` form works even when the global `mailpouch` bin isn't on your `PATH`, and these commands **print and exit** (they never start a server):

| Command | What it does |
|---|---|
| `mailpouch --help` / `-h` | List all commands + flags; prints the config and log file paths |
| `mailpouch status [--json]` | Is mailpouch running (PID, ports), connection state, approved-agent counts, Bridge reachability — read-only |
| `mailpouch doctor [--json]` | Diagnose the install/connection and print the next step (exit 0 when ready) |
| `mailpouch setup …` | Configure Bridge credentials non-interactively |
| `mailpouch agent <issue\|list\|revoke>` | Manage headless service accounts |
| `mailpouch daemon [--host H] [--port P]` | Run the shared HTTP daemon (forces HTTP transport) |

Running `mailpouch` with **no command** starts the MCP server on stdio — that's what an MCP client (e.g. Claude Desktop) spawns; you don't run it by hand. An unrecognized command prints an error and exits rather than starting a server.

**Wire up Claude Desktop** — this form works whether or not mailpouch is globally installed:

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

(If you ran `npm install -g mailpouch`, you can use `"command": "mailpouch"` with no args instead. The Status tab's MCP Config Snippet generates the right form for your machine.)

---

## 2. Connection Setup

Open **Settings → Setup tab**.

### Bridge mode (default — most users)

| Field | Where to find it |
|---|---|
| SMTP host / port | `127.0.0.1` / `1025` (Bridge defaults) |
| IMAP host / port | `127.0.0.1` / `1143` (Bridge defaults) |
| Username | Your full Proton address (e.g. `you@proton.me`) |
| Bridge password | Bridge → Settings → IMAP/SMTP → Password |
| TLS cert | Bridge → Settings → Export TLS certificates → `cert.pem` |

**TLS mode**: match what Bridge reports — STARTTLS (default) or SSL/TLS.

**Allow insecure connection**: only enable if you cannot export the TLS cert. Removes local MITM protection.

**Auto-start Bridge**: mailpouch will launch Bridge if it isn't reachable when the MCP server starts.

### Direct SMTP mode (paid Proton plans only)

Bypasses Bridge entirely for sending. Requires an SMTP token from Proton Mail web app → Settings → IMAP/SMTP → SMTP tokens.

- SMTP host: `smtp.protonmail.ch`, port `587`
- IMAP still goes through Bridge

---

## 3. Permission Presets

Open **Settings → Permissions tab**.

Every tool call is blocked unless the active preset allows it. Change the preset any time — takes effect within 15 seconds, no restart needed.

| Preset | Reading | Sending | Actions | Deletion |
|---|---|---|---|---|
| **Read-Only** *(default)* | Unlimited | Blocked | Blocked | Blocked |
| **Send-Only** | Unlimited | ≤50/hr | Blocked | Blocked |
| **Supervised** | Unlimited | ≤200/hr | High limits | ≤20/hr |
| **Full Access** | Unlimited | Unlimited | Unlimited | Unlimited |
| **Custom** | Per-tool | Per-tool | Per-tool | Per-tool |

**Send-Only** also disables folder writes, bulk ops, and all email actions. `sync_emails` and `get_contacts` remain available for composing context.

**Supervised** caps: sending 200/hr, `schedule_email` 100/hr, bulk actions 100/hr, deletion 20/hr, folder delete 20/hr, folder create/rename 100/hr, server lifecycle 5/hr. Reading has no limits.

**Custom**: toggle each tool on/off individually and set per-tool rate limits (with optional `/hr` or `/day` window) using the tool table below the preset buttons.

### Require destructive confirmation

On by default. Every `delete_email`, `bulk_delete*`, `delete_folder`, `move_to_trash`, `move_to_spam`, `alias_delete`, `pass_get`, `shutdown_server`, and `restart_server` call must carry `{ confirmed: true }`. MCP-elicitation-capable clients prompt you inline before the call executes; others require the agent to explicitly confirm.

---

## 4. Optional Integrations

Open **Settings → Setup tab → Optional Integrations** (at the bottom).

### SimpleLogin (alias management)

Enables the `alias_*` tools (list, create, toggle, delete, activity log).

1. Go to [app.simplelogin.io](https://app.simplelogin.io) → Settings → API Keys → Create
2. Paste the key into **API Key** and click Save
3. Leave **Base URL** blank unless you self-host SimpleLogin

Rate limits under Supervised: create ≤50/hr, toggle ≤100/hr, delete ≤20/hr.

### Proton Pass (credential retrieval)

Enables the `pass_list`, `pass_search`, `pass_get` tools. Returns credential summaries and (on confirmed calls) secret values from your Pass vaults.

**Requirements:**
- `pass-cli` must be installed: [github.com/protonpass/pass-cli](https://github.com/protonpass/pass-cli)
- A Personal Access Token from Proton Pass web app → Settings → Developer → Personal Access Tokens

Steps:
1. Install `pass-cli` and verify with `pass-cli --version`
2. Generate a PAT in the Proton Pass web app
3. Paste it into **Personal Access Token** in Settings and click Save
4. If `pass-cli` is not on your PATH, fill in the full path in **pass-cli path**

`pass_get` returns decrypted secrets and requires `{ confirmed: true }` on every call.

---

## 5. Desktop Notifications

Open **Settings → Setup tab** → toggle **Desktop notifications for agent permission requests**.

When enabled (default), mailpouch fires a native OS notification whenever an agent submits a permission escalation request. The notification title is the agent's client ID; the body summarises the requested preset.

Platforms: `osascript` (macOS), `notify-send` (Linux), `powershell.exe` (Windows). No extra dependencies.

Disable if you prefer to poll the **Agents tab** manually, or if you're running headless.

### Surface security messages (debug)

A second toggle, **Surface security messages** (off by default), controls the *informational* security toasts:

- post-decision grant changes — agent **approved / denied / revoked / expired**, and
- a per-action notification for each non-read-only tool mailpouch runs (send, move, delete, …).

By default these are routed to the **debug log** only, so your desktop isn't peppered with "token revoked" / per-action toasts. Turn the toggle on (or set `surfaceSecurityNotifications: true` in `~/.mailpouch.json`) to surface them as toasts while debugging what an agent is doing. The **"agent awaiting approval"** prompt is never affected by this toggle — it always shows so the approval gate keeps working. Read-only tool calls and failed/no-op actions never notify.

---

## 6. Full-Text Search

`fts_search` queries a local BM25-ranked FTS5 index over your synced mail — phrase matching, boolean operators, column filters, prefix search. Nothing leaves your machine.

**First use**: the index is built lazily. On a fresh install call `fts_rebuild` once (or ask Claude to rebuild it). Large mailboxes can take a minute.

```
fts_search("project deadline", folder: "INBOX", limit: 20)
fts_search('"exact phrase" AND budget', sinceEpoch: 1735689600)
fts_search('from:alice subject:invoice')
```

**`fts_status`** — shows index size, last rebuild time, and document count.

**`fts_rebuild`** — drops and rebuilds the index from the current IMAP cache. Call after bulk imports or if search results feel stale.

The index is stored at `~/.mailpouch-fts.db` (SQLite, mode 0600).

---

## 7. Drafts, Scheduling & Reminders

### Saving drafts

`save_draft` writes to your Bridge Drafts folder without sending. Drafts survive server restarts.

### Scheduling

`schedule_email` stores the message locally with a `send_at` ISO timestamp. The server checks every minute and sends via Bridge SMTP when the time arrives.

- `list_scheduled_emails` — see pending queue
- `cancel_scheduled_email` — remove by ID
- `list_proton_scheduled` — lists emails already scheduled natively on Proton's servers (read-only view)

### Follow-up reminders

`remind_if_no_reply` attaches a reminder to an outbound email. If no reply arrives before the deadline, the reminder fires:

```
remind_if_no_reply(email_id: "...", after_days: 3, note: "Follow up on contract")
```

- `check_reminders` — manually check which reminders are due (also runs automatically on the minute tick)
- `list_pending_reminders` — see all active reminders
- `cancel_reminder` — remove a reminder by ID

### MCP Prompts

mailpouch ships built-in MCP prompts that guide Claude through common workflows:

- **`draft_in_my_voice`** — Draft an email in your own voice by sampling your recent sent mail for tone. Args: `recipient` (required), `intent` (required), `sampleCount` (optional, default 5, max 20).

---

## 8. Labels & Folders

### Labels (Proton Mail tags)

Proton Mail uses labels rather than IMAP folders for organisation. All label operations are mapped to IMAP keywords/flags.

- `list_labels` — all labels in your account
- `get_emails_by_label` — fetch emails with a given label
- `move_to_label` / `bulk_move_to_label` — apply a label to one or many emails
- `remove_label` / `bulk_remove_label` — remove a label (note: pass the UID inside `Labels/{name}`, not the original INBOX UID — label folders have their own UID space)

> **Cross-folder UIDs:** IMAP UIDs are folder-scoped. When mutating (move, mark-read, star, delete, label) a message that lives in a folder other than INBOX, pass `sourceFolder` (e.g. `Folders/Work` or `Labels/Foo`) so mailpouch locks the right mailbox. Without it, the cache may resolve the UID to the wrong folder and the operation can silently no-op.

### Folders

Standard IMAP folder operations:
- `get_folders` / `sync_folders` — list and sync folder tree
- `create_folder` — new IMAP folder
- `rename_folder` — rename (moves all messages)
- `delete_folder` — delete and expunge (irreversible — requires `confirmed: true`)

---

## 9. Analytics & Contacts

These tools work on locally-cached data and are always available in Read-Only and up.

- **`get_email_stats`** — message counts, read ratio, top senders for a date range
- **`get_email_analytics`** — deeper breakdown: volume by day/week, domain distribution, response time stats
- **`get_volume_trends`** — rolling volume over configurable windows (day/week/month)
- **`get_contacts`** — sorted contact list with recency weighting, organisation inference, and optional name extraction

**`get_correspondence_profile`** — full relationship summary for an email address: message history, response patterns, common subjects, org inference.

---

## 10. Per-Agent Grants

Open **Settings → Agents tab**.

When an agent first connects via HTTP transport, it appears here as a pending approval. You can:

- **Approve** with a preset (read_only / supervised / full)
- Set an **expiry** (default 24h; max 7d)
- Pin to a specific **folder allowlist** (e.g. `INBOX,Sent` — agent cannot see other folders)
- Pin to an **IP address** (rejects connections from other IPs)
- Set **per-tool rate overrides** (tighter than the preset)
- Bind to a specific **account** in a multi-account setup

**Revoke** at any time — takes effect on the next tool call.

Agents connecting over stdio always use the global preset; grants only apply to HTTP transport clients.

---

## 11. Escalation Requests

An agent can call `request_permission_escalation` to ask for a higher preset. This fires:
1. A pending escalation entry in the **Agents tab**
2. A desktop notification (if enabled)
3. A one-time challenge token (5-minute expiry)

You approve or deny in the Agents tab by clicking **Approve** (requires typing "APPROVE") or **Deny**. Approval is one-time-use — it does not permanently change the preset.

Rate limit: max 5 escalation requests per hour, max 1 pending at a time per client.

Escalation events are logged to `~/.mailpouch.audit.jsonl`.

---

## 12. Multi-Account

Open **Settings → Accounts tab**.

Add multiple Proton accounts (or plain IMAP providers). Each account has its own Bridge credentials.

- Set one as **active** — that's what all tools use by default
- Agents can **pin** to a specific account via per-agent grants
- Tools accept an optional `account_id` argument to route to a non-active account

Hot-swapping the active account requires a server restart.

---

## 13. Remote / HTTP Mode

By default mailpouch uses stdio (for Claude Desktop). To expose it over HTTP for remote MCP clients, edit `~/.mailpouch.json` directly. Remote mode is **OAuth-only** — every agent authenticates as its own client (there is no shared bearer token):

```json
{
  "remoteMode": "http",
  "remoteHost": "0.0.0.0",
  "remotePort": 8788,
  "remoteOauthEnabled": true,
  "remoteTlsCertPath": "/path/to/cert.pem",
  "remoteTlsKeyPath": "/path/to/key.pem"
}
```

- **Interactive agents** self-register over OAuth and you **Approve/Deny** them in the Agents tab (automatic consent — no password).
- **Headless agents** (cron, CI, scheduled) use a pre-approved **service account** and the `client_credentials` grant:

  ```bash
  mailpouch agent issue --name nightly-cron --preset read_only
  # prints client_id + client_secret once; log in via POST /oauth/token grant_type=client_credentials
  ```

Remote mode keys are **not** in the browser UI by design — secrets shouldn't live in web forms (but the "+ Service account" button in the Agents tab issues client_credentials credentials).

### Connecting a client (Claude Code, Claude Desktop, …)

The Setup tab's **Connect a client** section (and the install wizard's final step) write the MCP entry for you — pick the transport, then click **Write to Claude Code** (`~/.claude.json`) or **Write to Claude Desktop**:

- **stdio** — the client spawns its own mailpouch. The entry sets `MAILPOUCH_FORCE_STDIO=1` so it speaks stdio even if your config has `remoteMode: true`. Don't run it alongside the shared HTTP daemon for the same Proton account (they'd fight over the one IMAP connection).
- **HTTP** — the client connects to the shared daemon at `/mcp`; it does an OAuth login and you Approve it once in the Agents tab. Needs remote mode + OAuth enabled and the daemon running.

You can also just copy the snippet shown and paste it into any MCP host's `mcpServers`.

### Run as a shared daemon (use several apps at once)

mailpouch keeps **one mailbox connection per account**, so you can't run two separate copies for the same account at the same time (the second quits). To use mailpouch from several apps together — for example **Claude Code and Claude cowork**, or scheduled/headless agents — run one shared daemon and point everything at it:

```bash
mailpouch daemon          # starts the shared connection (you start it; it isn't an autostart)
```

Leave it running (e.g. in a tmux or login session). Then:
- **Apps like Claude Code / Claude Desktop** connect to it and you approve each once in the Agents tab.
- **Headless or cowork hosts** use a per-host login: `mailpouch agent issue --name <host> --preset <preset>` (gives a client_id + secret).

Everything shares the one connection — nothing fights over the mailbox.

While the shared mailpouch is running, the "Connect an app" chooser only offers the shared option (the per-computer one is turned off, because it would conflict). Adding or replacing a headless login takes effect right away — no restart. Revoking one removes its login for good; to bring it back, issue a new one.

See [README.md — Remote HTTP Mode](README.md#remote-http-mode) for the full guide.

---

## 14. Response Limits

Open **Settings → Status tab → Response Limits** (or scroll to the bottom of any tab that shows the limits card).

| Setting | Default | Purpose |
|---|---|---|
| Max response bytes | 900 KB | Hard cap before Claude's 1 MB limit |
| Max email body chars | 500 000 | Truncates long HTML/plain bodies |
| Max email list results | 50 | Caps `get_emails` page size |
| Max attachment bytes | 600 KB | Caps `download_attachment` |

Raise these if Claude says responses are being truncated; lower them if tool calls are slow on large mailboxes.

---

## 15. Troubleshooting

### "Bridge not reachable" / connection refused

1. Open Proton Bridge and confirm it's running and logged in
2. Check Bridge → Settings → IMAP/SMTP — verify the ports match your config
3. Click **Test Connections** in Settings → Setup
4. If you changed the Bridge cert, re-export and update the cert path

### "TLS certificate error" / DEPTH_ZERO_SELF_SIGNED_CERT

1. Export Bridge cert: Bridge → Settings → Export TLS certificates
2. Fill in the **TLS cert path** field in Settings → Setup
3. If using Split mode, export both certs

Or enable **Allow insecure connection** as a temporary workaround (removes TLS validation — localhost only).

### Tools returning "Blocked: ..."

The active permission preset doesn't allow that tool. Either:
- Switch to a more permissive preset in Settings → Permissions
- Enable the specific tool in Custom preset
- If you're an agent: call `request_permission_escalation` and wait for the human to approve

### "Proton Pass is not configured"

1. Install pass-cli: [github.com/protonpass/pass-cli](https://github.com/protonpass/pass-cli)
2. Add your PAT in Settings → Setup → Optional Integrations → Proton Pass
3. If pass-cli isn't on PATH, fill in the **pass-cli path** field

### "SimpleLogin API key not set"

Add your API key in Settings → Setup → Optional Integrations → SimpleLogin.

### FTS search returns nothing

Run `fts_rebuild` to build/refresh the index. Check `fts_status` to confirm the index has entries.

### Debug logs

Enable **Debug logging** in Settings → Setup, then check Settings → Logs tab for detailed output. Logs are also written to `~/.mailpouch.log`.

### Config file location

```
~/.mailpouch.json         main config
~/.mailpouch.audit.jsonl  escalation audit log
~/.mailpouch-agent-audit.jsonl  per-agent gated tool-call audit log
~/.mailpouch-fts.db       FTS index (SQLite)
~/.mailpouch-pass-audit.jsonl  Pass access audit log
```

---

*For the full MCP tool API reference, see [README_FIRST_AI.md](README_FIRST_AI.md).*
*For security architecture details, see [SECURITY.md](SECURITY.md).*
*For Proton Bridge internals, see [docs/proton-bridge-overview.md](docs/proton-bridge-overview.md).*
