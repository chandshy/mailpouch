# mailpouch — Operator Help

Use this guide for setup and recovery. See [README.md](README.md) for the product
overview, [README_FIRST_AI.md](README_FIRST_AI.md) for agent behavior, and
[SECURITY.md](SECURITY.md) for the security model.

## Quick diagnostics

```bash
npx -y mailpouch status
npx -y mailpouch doctor
npx -y mailpouch-settings
```

`status` reports the running process, settings URL, connection state, pending
agents, and Bridge reachability. `doctor` diagnoses installation and connection
problems and prints the next action. `mailpouch-settings` opens the standalone
settings UI.

Other useful commands:

| Command | Purpose |
|---|---|
| `mailpouch --help` | Show commands, flags, and config/log paths |
| `mailpouch setup …` | Configure Bridge credentials non-interactively |
| `mailpouch agent issue/list/revoke/prune` | Manage headless service accounts |
| `mailpouch daemon [--host H] [--port P]` | Run the shared OAuth HTTP daemon |

Running `mailpouch` with no command starts the stdio MCP server. An MCP client
normally launches that process; do not run it manually.

## Initial setup

You need Proton Bridge running and signed in. Use the Bridge-generated password,
not the Proton account password. Bridge defaults are:

| Service | Host | Port |
|---|---|---|
| IMAP | `127.0.0.1` | `1143` |
| SMTP | `127.0.0.1` | `1025` |

Export Bridge's TLS certificate and select it in Settings → Setup. Enabling
**Allow insecure connection** disables local certificate verification and
should be a temporary localhost-only fallback.

For non-interactive setup:

```bash
npx -y mailpouch setup --username you@proton.me --password-stdin
npx -y mailpouch doctor
```

Typical stdio client entry:

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

Restart the MCP client after changing its configuration.

## Permissions and agent approval

The default preset is Read-Only. Send-Only adds bounded sending and scheduling;
Supervised enables all categories with rate limits; Full removes rate limits;
Custom controls tools individually.

New interactive clients appear in Settings → Agents. Approve the exact pending
client and choose its preset, expiry, account, and optional folder/IP limits.
Revocation takes effect on the next tool call.

Headless clients should use a service account:

```bash
mailpouch agent issue --name nightly-cron --preset read_only
```

The command prints the client secret once. Store it securely. Do not put it in
source control, logs, documentation, or chat.

Destructive calls are confirmation-gated. Emptying Trash and deleting a folder
are irreversible. Runtime tool annotations and schemas identify calls requiring
`confirmed: true`.

## Shared HTTP daemon

Use one shared daemon when several applications need the same mailbox:

```bash
mailpouch daemon
```

Enable `connection.remoteMode` and `remoteOauthEnabled` in
`~/.mailpouch.json`. HTTP clients connect to `/mcp` and authenticate as
distinct OAuth clients. Interactive clients require approval; service accounts
use `client_credentials`. Shared bearer authentication is not supported.

Do not run multiple MailPouch processes against the same account. They compete
for the mailbox connection and the singleton guard rejects the duplicate.

## Optional integrations

SimpleLogin alias tools require an API key from SimpleLogin settings. Proton
Pass tools require `pass-cli` plus a Proton Pass personal access token.
Configure both in Settings → Setup → Optional Integrations. Secret-returning
Pass calls require confirmation.

Desktop approval notifications are enabled from Settings → Setup. On unsupported
or headless desktops, approval falls back to the browser Agents page. The
separate **Surface security messages** toggle controls informational action and
grant-state notifications, not pending approval prompts.

## Local search and response limits

`fts_search` uses the local SQLite FTS index. Run `fts_rebuild` after first
setup, bulk imports, or stale results; use `fts_status` to inspect it.

Response limits are on Settings → Status. Defaults protect MCP hosts from very
large responses:

| Setting | Default |
|---|---|
| Maximum response | 900 KB |
| Email body | 500,000 characters |
| Email list | 50 items |
| Attachment response | 600 KB |

## Troubleshooting

### Bridge is unreachable

1. Open Bridge and confirm it is signed in.
2. Compare Bridge's IMAP/SMTP ports with Settings → Setup.
3. Run `mailpouch doctor`.
4. Test the connections in Settings.

### TLS certificate or `DEPTH_ZERO_SELF_SIGNED_CERT`

Re-export Bridge's certificate and update the configured path. Ensure the TLS
mode matches Bridge. Use insecure mode only as a temporary localhost fallback.

### Authentication failed

Use the password shown by Bridge under IMAP/SMTP settings. The Proton login
password will not work. Save again, then test the connections.

### Client is pending or tools are blocked

Open Settings → Agents and approve the exact pending client. A blocked tool may
also be disabled by the active preset or rate limit. Change policy or approve an
escalation; repeatedly retrying does not bypass it.

### Tool list is shorter than expected

SimpleLogin and Proton Pass tools are advertised only when configured. Restart
the MCP client after enabling an integration so it refreshes `tools/list`.

### Remote client receives 401

Confirm the daemon is running, OAuth is enabled, and the client completed OAuth
registration or has valid service-account credentials. Legacy bearer/admin
credentials are ignored and scrubbed from config/keychain storage at startup.

### Search returns nothing

Run `fts_rebuild`, then inspect `fts_status`. Search only covers mail already
synced into the local cache.

### Debug logs

Enable Debug logging in Settings → Setup, then use the Logs tab or inspect
`~/.mailpouch.log`. Never paste logs publicly without checking for mailbox
metadata.

## Local files

| Path | Purpose |
|---|---|
| `~/.mailpouch.json` | Main configuration |
| `~/.mailpouch.log` | Runtime log |
| `~/.mailpouch.audit.jsonl` | Escalation audit |
| `~/.mailpouch-agent-audit.jsonl` | Per-agent gated tool-call audit |
| `~/.mailpouch-pass-audit.jsonl` | Proton Pass access audit |
| `~/.mailpouch-fts.db` | Local FTS index |
