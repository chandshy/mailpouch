# Proton Mail SMTP & IMAP Configuration Reference

**Sources:**
- https://proton.me/support/smtp-submission
- https://proton.me/support/imap-smtp-and-pop3-setup
- https://proton.me/support/comprehensive-guide-to-bridge-settings
**Retrieved:** 2026-03-17

---

## Two Distinct Connection Modes

This project supports **both** connection paths. They have very different security and auth requirements.

---

## Path 1: Proton Bridge (localhost) — Default

For reading mail and sending via Bridge. Requires **Proton Bridge desktop app** running.

| Setting | IMAP | SMTP |
|---|---|---|
| Host | `127.0.0.1` | `127.0.0.1` |
| Port | `1143` | `1025` |
| Encryption | STARTTLS | STARTTLS |
| Auth | Bridge password | Bridge password |
| TLS cert | Self-signed (export from Bridge) | Self-signed (export from Bridge) |

**Security note:** Bridge's self-signed cert should be **explicitly trusted** by the client, not bypassed with `rejectUnauthorized: false`. Export the cert from Bridge → Settings → Export TLS certificates.

---

## Path 2: Direct SMTP Submission (smtp.protonmail.ch) — Sending Only

For sending only, without Bridge. Requires a **paid Proton Mail plan with a custom domain**.

| Setting | Value |
|---|---|
| Host | `smtp.protonmail.ch` |
| Port | `587` |
| Encryption | STARTTLS (SSL on 465 is acceptable fallback) |
| Auth method | PLAIN or LOGIN |
| Username | Custom domain email address |
| Password | **SMTP token** (not the account password) |

### SMTP Token Generation
Settings → All Settings → IMAP/SMTP → SMTP tokens → Generate token
**Tokens are shown only once.** Each application/device should use its own token.

**Important restrictions:**
- Only available on **paid plans**
- Only works with **custom domain addresses** (not @proton.me)
- Emails sent this way are **not end-to-end encrypted** (but have zero-access encryption at rest)
- No documented rate limits or message size limits from Proton

---

## Bridge Connection Modes (SSL vs STARTTLS)

Bridge supports both modes via its settings. The defaults:
- STARTTLS on port 1143 (IMAP) / 1025 (SMTP)
- SSL on port 993 (IMAP) / 465 (SMTP) if configured

The Bridge setting to switch: **Bridge Settings → Connection method → STARTTLS / SSL**

---

## Configuration for This Project

Connection settings and credentials are stored in `~/.pm-bridge-mcp.json` (mode 0600).
**No environment variables are used for credentials** — this prevents accidental exposure to
other processes and shell history. Run `npm run settings` to open the settings UI and configure.

```json
{
  "configVersion": 1,
  "connection": {
    "smtpHost": "127.0.0.1",
    "smtpPort": 1025,
    "imapHost": "127.0.0.1",
    "imapPort": 1143,
    "username": "your@proton.me",
    "password": "<Bridge password>",
    "smtpToken": "",
    "bridgeCertPath": "/path/to/exported/cert.pem",
    "tlsMode": "starttls",
    "debug": false
  }
}
```

**Field notes:**
- `password` — Bridge password (from Bridge app), **not** your Proton account password. Credentials are migrated to the OS keychain on first run when available.
- `smtpToken` — only for direct `smtp.protonmail.ch` submission (paid plans with custom domain). Leave empty for Bridge connections.
- `bridgeCertPath` — path to the TLS certificate exported from Bridge → Settings → Export TLS certificates. Leave empty to skip cert validation (not recommended).
- `tlsMode` — `"starttls"` (default, correct for Bridge on ports 1025/1143) or `"ssl"` (implicit TLS, for ports 465/993 if Bridge is configured for SSL mode).

The config file path can be overridden with the `PM_BRIDGE_MCP_CONFIG` environment variable (must point to a path within the home directory). The legacy `PROTONMAIL_MCP_CONFIG` name is still accepted for one release.
