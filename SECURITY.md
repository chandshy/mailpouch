# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 3.x.x   | :white_check_mark: |
| 2.x.x   | :white_check_mark: (security fixes only) |
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

The server implements a 10-layer defense-in-depth security model:

### 1. Permission Gate
- Every tool call checked against `~/.mailpouch.json` (refreshed every 15s)
- 4 presets: read_only (default), supervised, send_only, full
- Per-tool enable/disable and rate limiting

### 2. Rate Limiting
- Sliding-window rate limits enforced per tool
- Supervised preset: deletion capped at 5/hr, sending at 20/hr
- Rate-limiter buckets capped at 10k entries (memory safety)

### 3. Human-Gated Escalation
- Two-channel design: agent requests via MCP, human approves via separate UI
- One-time use challenges with 5-minute expiry
- Max 5 requests/hr, max 1 pending at a time
- Human must type "APPROVE" before confirmation button activates

### 4. Audit Trail
- Append-only log at `~/.mailpouch.audit.jsonl`
- Records all escalation requests, approvals, and denials

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
- Preset and tool names validated on load
- No unknown keys allowed (defense-in-depth)

### 9. Memory Safety
- Email cache capped at 500 entries AND 50 MB (dual eviction policy; whichever limit is reached first triggers FIFO eviction)
- Analytics cache collapses concurrent fetches into a single in-flight IMAP round-trip (no stampede)
- Rate-limiter buckets capped at 10k entries
- Safe request body reader (64 KiB limit, 15 s timeout)

### 10. Network Security
- Settings UI binds to localhost only (127.0.0.1:8765)
- Proton Bridge connections default to localhost
- Self-signed certificate handling for Bridge TLS (configurable via the settings UI: Setup → Bridge TLS Certificate)

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
- The server accepts self-signed certificates for localhost only when no cert is configured

### Access Control
- Config file at `~/.mailpouch.json` is written with mode 0600
- Start with **read_only** preset and escalate only as needed
- Use **supervised** preset for day-to-day agent use (rate-limited writes)
- Reserve **full** preset for trusted, supervised workflows

### Data Protection
- Email data is **cached in memory** only (cleared on restart, capped at 500 entries per fetch)
- **Scheduled emails** are persisted to `~/.mailpouch-scheduled.json` (mode 0600, atomic writes) so they survive restarts. This file contains email metadata (recipients, subject, body) — protect it accordingly.
- No persistent storage of email content beyond the scheduled email queue
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

---

Thank you for helping keep mailpouch secure!
