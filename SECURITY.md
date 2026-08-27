# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 4.x.x   | :white_check_mark: |
| 1.x.x   | :x:                |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

If you discover a security vulnerability, please send an email to **chandshy@gmail.com** with:

1. **Description** of the vulnerability
2. **Steps to reproduce** the issue
3. **Potential impact** of the vulnerability
4. **Suggested fix** (if you have one)

### What to Expect

- **Acknowledgment**: You will receive a response within 48 hours
- **Updates**: Regular updates on the progress of fixing the vulnerability
- **Credit**: You will be credited for the discovery (unless you prefer to remain anonymous)
- **Timeline**: We aim to patch critical vulnerabilities within 7 days

## Security Architecture (v2.1+)

The server implements an 11-layer defense-in-depth security model:

### 1. Permission Gate
- Every tool call checked against `~/.mailpouch.json` (refreshed every 15s)
- 5 presets: read_only (default), send_only, supervised, full, custom
- Per-tool enable/disable and rate limiting

### 2. Rate Limiting
- Sliding-window rate limits enforced per tool
- Supervised preset: reading unlimited; sending ≤200/hr, bulk ≤100/hr, deletion ≤20/hr, server lifecycle ≤5/hr
- Rate-limiter buckets capped at 10k entries (memory safety)

### 3. Human-Gated Escalation
- Two-channel design: agent requests via MCP, human approves via separate UI
- One-time use challenges with 5-minute expiry
- Max 5 requests/hr, max 1 pending at a time
- Human must type "APPROVE" before confirmation button activates

### 4. Audit Trail
- Append-only log at `~/.mailpouch.audit.jsonl`
- Records all escalation requests, approvals, and denials
- A separate per-agent log at `~/.mailpouch-agent-audit.jsonl` (mode 0600) records one row per gated tool call with the agent's `clientId`, the tool, a truncated `argHash` (never argument values or response bodies), outcome, and duration; rotates at 10 MB keeping 3 gzipped generations

### 5. CSRF Protection
- All mutating settings API calls require X-CSRF-Token header
- Timing-safe token comparison

### 6. Origin Validation
- Settings server checks Origin/Referer headers on all requests

### 7. Input Validation
- Email addresses, folder names, attachment sizes, hostnames validated
- CRLF injection prevention in SMTP headers, subjects, filenames

### 8. Config File Isolation
- Atomic writes with mode 0600
- Preset and tool names are validated on load; connection values are merged with defaults and unrecognized connection fields are not used

### 9. Memory Safety
- Email cache capped at 500 entries AND 50 MB (dual eviction policy; whichever limit is reached first triggers FIFO eviction)
- Analytics cache collapses concurrent fetches into a single in-flight IMAP round-trip (no stampede)
- Rate-limiter buckets capped at 10k entries
- Safe request body reader (64 KiB limit, 15 s timeout)

### 10. Network Security
- Settings UI binds to localhost only (127.0.0.1:8766)
- Proton Bridge connections default to localhost
- Self-signed certificate handling for Bridge TLS (configurable via the settings UI: Setup → Bridge TLS Certificate)

### 11. Remote Agent Authentication (HTTP transport)
- **OAuth 2.1 only — every agent authenticates as its own client. There is no shared bearer token.** The legacy static bearer was removed because it authenticated as one shared identity that bypassed the per-agent grant store and the audit log; remote mode now refuses to start without `remoteOauthEnabled`.
- **Interactive agents**: RFC 7591 Dynamic Client Registration + `authorization_code` + PKCE S256 + RFC 8707 resource indicators + RFC 9728 protected-resource metadata. Consent is automatic; the only human gate is per-agent **Approve/Deny** in the Agents tab. An issued token is inert until the operator approves the grant; a pending request expires after 5 minutes.
- **Headless agents** (cron, CI, scheduled): the OAuth `client_credentials` grant with a per-agent `client_id` + `client_secret`. The credential ("service account") is provisioned out-of-band — `mailpouch agent issue` or the Agents-tab "+ Service account" button — and pre-approved at issuance. Secrets are persisted to `~/.mailpouch-service-accounts.json` (mode 0600) as a **salted SHA-256 only**; the plaintext is shown once and never stored. Verification is constant-time.
- **Local stdio agents are gated too** (`gateLocalAgents`, default on): they register and must be approved like any remote agent.
- A verified token always resolves to a real, per-agent `client_id`, so every call is independently gated by `GrantManager` (preset, expiry, folder allowlist, IP pins, per-tool caps), attributed in the audit log, and revocable — revoking a grant invalidates the agent's outstanding access tokens immediately.
- Access tokens are stored only as `sha256(token)` (never plaintext), bound to their issuing IP, and per-token rate-limited; `/oauth/*` and `/.well-known/*` are rate-limited per IP.

## Security Best Practices

When using this MCP server:

### Credential Management
- **Never commit** credentials to version control
- **OS keychain is the default credential store** — Bridge passwords and SMTP tokens live under the `mailpouch` service, keyed per account (`bridge-password:<acct-id>` / `smtp-token:<acct-id>`). The single-account legacy key names (`bridge-password` / `smtp-token`, no suffix) are still honored for back-compat on pre-v3 installs.
- `~/.mailpouch.json` (mode 0600) holds only non-secret config. The `credentialStorage: "keychain"` marker signals that secrets are keychain-backed; the `password` and `smtpToken` fields are always blanked on disk when the keychain is reachable.
- Credentials are never read from environment variables or `.env` files
- Use **Proton Bridge passwords**, not your main Proton Mail password
- Rotate credentials regularly via the settings UI — saves route straight to the keychain and the running MCP picks up the rotation without a restart

### Network Security
- Use **localhost (127.0.0.1)** for Proton Bridge connections
- Export and configure the **Bridge TLS certificate** for production use
- Localhost Bridge connections fail closed when no pinned certificate can be loaded for new/current configurations; explicitly enable **Allow insecure Bridge connection** (or `MAILPOUCH_INSECURE_BRIDGE=1`) to disable certificate validation for that launch. A legacy `configVersion: 1` file with no certificate and no explicit `allowInsecureBridge` is grandfathered into insecure mode by the loader for compatibility; an explicit flag or certificate prevents that exception.

### Access Control
- Config file at `~/.mailpouch.json` is written with mode 0600
- Start with **read_only** preset and escalate only as needed
- Use **supervised** preset for day-to-day agent use (rate-limited writes)
- Reserve **full** preset for trusted, supervised workflows
- **Issue one service account per headless agent, not one shared credential.** A single shared `client_id`/`client_secret` recreates the "one secret unlocks everything" problem the per-agent model exists to prevent. Scope each to the minimum preset (and folder allowlist / expiry where useful) with `mailpouch agent issue`, and revoke unused ones (`mailpouch agent revoke <client_id>`).
- Treat a `client_secret` like a password: it is shown once at issuance, stored only as a salted hash, and cannot be recovered — re-issue if lost.

### Data Protection
- Email data is **cached in memory** only (cleared on restart, capped at 500 entries per fetch)
- **Scheduled emails** are persisted to `~/.mailpouch-scheduled.json` (mode 0600, atomic writes) so they survive restarts. This file contains email metadata (recipients, subject, body) — protect it accordingly.
- The optional FTS5 index uses `~/.mailpouch-fts.db` (or `MAILPOUCH_FTS_DB`) as its base/legacy path and stores live account indexes under the derived private `<base-name>.accounts/<account-hash>.db` locations. It persists indexed subject and body content; entries remain until removed or the index is rebuilt/cleared. Protect or delete the configured store according to your retention needs.
- Logs are sanitized (no full email bodies)
- Audit log contains escalation metadata only (no email content)

## Disclosure Policy

- **Private Disclosure**: Security issues are handled privately until fixed
- **Public Disclosure**: After a fix is released, we will publish details with appropriate credit
- **CVE Assignment**: For critical vulnerabilities, we will work to get a CVE assigned

## Security Updates

Security patches will be released as:
- **Patch version** for minor security fixes (2.0.x)
- **Minor version** for moderate security fixes (2.x.0)
- **Major version** if breaking changes are required for security

## Audit Trail

| Date       | Version | Issue                          | Severity | Status   |
|------------|---------|--------------------------------|----------|----------|
| 2026-03-17 | 2.0.0   | Security hardening (25 findings from 3 audit loops) | Various  | Resolved |
| 2026-03-18 | 2.1.0+  | 48-cycle autonomous audit: input validation, type safety, injection prevention, CSRF, path traversal, rate limiting across all 48 tool handlers | Various  | Resolved |
| 2026-04-20 | 3.0.0   | Per-account Bridge passwords wrote plaintext to `~/.mailpouch.json` via Accounts-tab CRUD paths (create / update / setActive / delete all funnelled through `writeRegistry` → `saveConfig` with no keychain routing). Legacy Setup-tab path was correctly encrypted. | High | Resolved via [PR #93](https://github.com/chandshy/mailpouch/pull/93) — writeRegistry now saves secrets to keychain under per-account keys, scrubs on-disk JSON, and refreshes the running AccountManager on every save |
| 2026-06-02 | 3.0.72  | The shared static bearer authenticated as one identity (`bearer:static`) that bypassed the per-agent grant store and the audit log — a leaked token meant unattributed, ungated, unrevocable full access. | High | Resolved — static bearer removed; remote mode is OAuth-only. Interactive agents use authorization_code + per-agent Approve/Deny; headless agents use the `client_credentials` grant with pre-approved per-agent service accounts. Every call now resolves to a gated, audited, revocable identity. |

---

Thank you for helping keep mailpouch secure!
