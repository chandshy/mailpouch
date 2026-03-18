# Proton Bridge — Technical Overview

## What Proton Bridge Is

Proton Bridge is a desktop application that acts as a local email proxy between standard email clients (which use IMAP/SMTP) and the Proton Mail backend (which uses end-to-end encryption via its proprietary API). Without Bridge, Proton Mail's encryption model is incompatible with standard email clients; Bridge handles the cryptographic layer transparently.

When Bridge starts, it:
1. Authenticates to the Proton Mail API using the Secure Remote Password (SRP) protocol
2. Downloads and decrypts the user's PGP private keys into memory
3. Starts a local IMAP server (default port 1143) for email reading
4. Starts a local SMTP server (default port 1025) for email sending
5. Serves a GUI (or headless CLI on Linux) for management

All IMAP/SMTP traffic stays on the loopback interface (127.0.0.1). Messages are decrypted on-demand when fetched via IMAP; messages sent via SMTP are encrypted before leaving the device. PGP private keys are never written to disk — they live in Bridge's memory only.

## Supported Protocols

| Protocol | Supported | Notes |
|----------|-----------|-------|
| IMAP4rev1 | Yes | Default port 1143; STARTTLS by default; switchable to implicit TLS (SSL) |
| SMTP | Yes | Default port 1025; STARTTLS by default; switchable to implicit TLS (SSL) |
| POP3 | No | Explicitly unsupported. Proton recommends using Bridge's IMAP instead. |

## Default Ports

| Service | Default Port | Protocol |
|---------|-------------|----------|
| IMAP | 1143 | IMAP4rev1 with STARTTLS (or SSL depending on setting) |
| SMTP | 1025 | SMTP with STARTTLS (or SSL depending on setting) |

These ports were chosen to avoid conflicts with standard IMAP (143) and SMTP (25/587) ports, which typically require root/admin privileges. If another application already uses these ports, Bridge can be configured to use alternative ports (e.g. 1144, 1026) via Settings → Advanced settings → Default ports.

## Architecture

```
Email Client (Thunderbird, MCP server, etc.)
    |
    | IMAP (port 1143) / SMTP (port 1025)
    | TLS with self-signed certificate
    |
Proton Bridge (local daemon, 127.0.0.1)
    |
    | HTTPS + Proton API
    | TLS with certificate pinning
    |
Proton Mail Servers (api.protonmail.ch)
```

Bridge communicates upstream via HTTPS with certificate pinning — it will refuse to connect if an untrusted intermediary is detected (MITM protection). Locally it presents a self-signed TLS certificate that it generates on first run.

The internal implementation (open source at https://github.com/ProtonMail/proton-bridge) uses:
- **Go** for the core IMAP/SMTP server logic
- **Gluon** library for the IMAP server implementation
- **SQLite** (via Gluon) for per-address local message metadata and UID mappings
- **gopenpgp** for on-demand PGP decryption of fetched messages
- **gRPC** for communication between the bridge daemon and its GUI

## Authentication Methods

### Bridge Password
The primary authentication method for local IMAP/SMTP connections. This is a randomly generated password that Bridge creates and stores in the OS keychain. It is completely separate from the user's Proton Mail login password and never leaves the user's machine. This is the password to use in the MCP server's `password` config field.

### SMTP Token (Direct Submission)
An alternative for SMTP-only use cases (bypasses Bridge entirely). Available to paid Proton Mail users with custom domain addresses. Generated in Proton Mail web interface under Settings → All settings → IMAP/SMTP → SMTP tokens. Uses the direct Proton SMTP relay at `smtp.protonmail.ch:587`. This is NOT the same as the Bridge password and is used only when connecting directly to Proton's servers rather than to a local Bridge instance.

### Proton Login Password
Never used for IMAP/SMTP authentication. Proton explicitly states: "Your Proton Mail login or mailbox passwords will not work with SMTP, and you should never use them with third-party clients."

## TLS Modes

Bridge supports two TLS modes, switchable in its settings:

**STARTTLS (default)**
- Connection starts unencrypted, then upgrades to TLS via the STARTTLS command
- Used on ports 1025 (SMTP) and 1143 (IMAP) by default
- Nodemailer: `secure: false`, `requireTLS: true`
- imapflow: `secure: false`

**Implicit TLS (SSL)**
- Connection is TLS from the first byte
- Used when the setting is switched to "SSL" in Bridge
- Typically uses different ports when in SSL mode (the ports can be reconfigured)
- Nodemailer: `secure: true`
- imapflow: `secure: true`

## TLS Certificate

Bridge generates a self-signed TLS certificate on first run. Because this is self-signed and not issued by a public CA, email clients and Node.js HTTPS/TLS libraries will reject it by default with a certificate validation error.

Options for handling this:
1. **Export and trust the certificate** (recommended): Settings → Advanced settings → Export TLS certificates saves `cert.pem` and `key.pem` to a chosen directory. Load `cert.pem` as a trusted CA in Node.js via `tls: { ca: [certContents] }`.
2. **Disable certificate validation** (insecure fallback): `tls: { rejectUnauthorized: false }`. Acceptable only on localhost since the traffic never leaves the machine, but it removes protection against local MITM attacks.

On macOS, installing the certificate in the system keychain is recommended. On Linux, the certificate can be installed system-wide with `sudo trust anchor --store ~/.config/protonmail/bridge/cert.pem` (on systems supporting this command).

## Combined Mode vs Split Mode

### Combined Mode (default)
All addresses on the Proton account share a single IMAP mailbox. All email for all addresses (primary + aliases) appears in the same Inbox, Sent, etc. A single IMAP login credential grants access to all addresses. Sending can use different From addresses but they share the same IMAP account.

### Split Mode
Each address gets its own IMAP account with separate credentials and separate mailbox folders. Must be configured per-address in Bridge. Required for Outlook users who need to send from multiple distinct addresses.

The MCP server currently uses a single credential set, which corresponds to combined mode.

## Supported Client Configurations

Officially tested clients:
- Mozilla Thunderbird
- Microsoft Outlook (Windows, macOS)
- Apple Mail

Any client supporting IMAP4rev1 and SMTP with STARTTLS or SSL will work. The key requirement is accepting the self-signed certificate (either by trusting it or disabling validation).

## Credential Storage Architecture

Bridge stores credentials in the OS keychain:
- **Windows**: Windows Credentials Manager
- **macOS**: macOS Keychain
- **Linux**: `secret-service` freedesktop.org API (Gnome Keyring recommended; `pass` also supported)

The Bridge password (for local IMAP/SMTP) and refresh tokens are stored in the keychain. PGP private keys exist in memory only and are re-derived from the server on each Bridge startup.

## Platform-Specific Config Directories

| Platform | Path |
|----------|------|
| Windows | `%APPDATA%\protonmail\bridge-v3` |
| macOS | `~/Library/Application Support/protonmail/bridge-v3` |
| Linux | `~/.config/protonmail/bridge-v3` (or `$XDG_CONFIG_HOME/protonmail/bridge-v3`) |

## Key Operational Characteristics

- Bridge must be running for IMAP/SMTP to function; there is no "standalone" IMAP mode
- Initial sync can take a long time on large mailboxes (Bridge downloads and indexes all messages)
- Subsequent starts are fast because messages are cached locally in the Gluon SQLite database
- Bridge polls the Proton API every ~20 seconds for new events (it does NOT implement IMAP IDLE server-push natively — see IMAP docs)
- Bridge requires a paid Proton Mail subscription; free accounts cannot use Bridge

## Sources

- https://proton.me/support/port-already-occupied-error
- https://proton.me/support/comprehensive-guide-to-bridge-settings
- https://proton.me/support/bridge-ssl-connection-issue
- https://proton.me/blog/bridge-security-model
- https://github.com/ProtonMail/proton-bridge
- https://deepwiki.com/ProtonMail/proton-bridge/1-overview
- https://proton.me/support/difference-combined-addresses-mode-split-addresses-mode
