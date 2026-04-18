# Proton Mail Bridge — Security Model Reference

**Source:** https://proton.me/blog/bridge-security-model
**Retrieved:** 2026-03-17

---

## Architecture Overview

Proton Mail Bridge is a desktop app that runs locally, connects to Proton's servers via TLS, decrypts emails locally, then re-serves them to the local email client over localhost (127.0.0.1). Decrypted messages and PGP keys exist **in memory only** — never written to disk.

---

## Authentication

| Mechanism | Detail |
|---|---|
| Protocol | Secure Remote Password (SRP) — password never leaves the machine |
| Access tokens | Short-lived, stored in **device memory only** |
| Refresh tokens | Stored in OS keychain (Windows Credential Manager / macOS Keychain / Linux pass/gnome-keyring) |
| Mailbox password | Hashed + salted, stored in OS keychain |
| Bridge password | Stored in OS keychain |

Bridge generates a **unique Bridge password** for email client access. This is different from the Proton Mail account password and is the `password` field in `~/.mailpouch.json`.

---

## TLS & Certificate Handling for Localhost

Bridge exposes IMAP and SMTP servers exclusively on the loopback interface (127.0.0.1). Because these are localhost-only, Bridge **cannot obtain a CA-signed certificate** and instead generates a **self-signed TLS certificate** at first setup.

### Official Guidance (Critical for this project)

> "The correct approach is **importing/trusting the exported certificate**, not disabling validation."

Proton's docs explicitly recommend:
1. Export the Bridge TLS certificate via: Bridge Settings → Export TLS certificates
2. Import/trust it in the consuming application

Setting `rejectUnauthorized: false` disables TLS validation entirely and is **not** Proton's recommended approach — even for localhost — because a compromised local process could MITM the connection.

### Cert Export Path (Bridge Settings)
Bridge Settings → **Export TLS certificates** (saves cert + private key to user-chosen location)

---

## Bridge → Proton Server Connection

- Uses **TLS certificate public key pinning** to Proton's servers
- If an untrusted public key is received, Bridge warns the user and refuses to connect
- Protects against MITM even from malicious CA-signed certs

---

## Security Assumptions & Limitations

- Assumes the **user's device is free of malware** (keyloggers, memory scanners, etc.)
- Cannot protect against a compromised OS or root-level attacker
- Installer must be downloaded securely and OS signature verified

---

## Bridge v3 Release History — Security-Relevant Changes

| Version | Date | Change |
|---|---|---|
| v3.22.0 | 2026-02-11 | Added FIDO2 hardware key support for 2FA |
| v3.21.2 | 2025-07-21 | **Improved security by not allowing potentially invalid certificates to be accepted** |
| v3.16.0 | 2025-01-13 | Added IMAP AUTHENTICATE PLAIN support |
| v3.11.0 | 2024-05-13 | Auto-install Bridge cert on macOS for Outlook |
| v3.0.17 | 2023-02-22 | Fixed golang.org/x/crypto vulnerabilities; extended encrypted-at-rest coverage |
