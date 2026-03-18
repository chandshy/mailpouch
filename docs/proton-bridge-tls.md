# Proton Bridge — TLS Reference

## How Bridge TLS Works

Proton Bridge acts as a local TLS termination proxy. It presents a self-signed TLS certificate to email clients for the IMAP and SMTP connections on localhost. This certificate is generated automatically by Bridge on first run and is unique per Bridge installation.

Because the certificate is self-signed (not issued by a public Certificate Authority), email clients and Node.js TLS libraries will reject it by default unless the certificate is explicitly trusted or validation is disabled.

Bridge itself uses proper CA-signed certificates and certificate pinning for its outbound connections to Proton's servers (api.protonmail.ch). The self-signed cert only applies to the local IMAP/SMTP listener.

## Exporting the Certificate

### Via Bridge GUI

1. Open the Bridge application
2. Navigate to **Settings** (or Help menu depending on version) → **Advanced settings** → **Export TLS certificates**
   - Some versions: Settings → Help → Export TLS Certificate
3. Click **Export**
4. Choose a save location
5. Bridge saves two files:
   - `cert.pem` — the public certificate (X.509 in PEM format)
   - `key.pem` — the private key (PEM format)

### Via Bridge CLI (Linux/headless)

On Linux with headless Bridge:
```bash
bridge --cli
# then from the Bridge CLI prompt:
cert install    # installs to system trust store (macOS)
# OR
# export via the interactive menu
```

## cert.pem vs key.pem

| File | Contents | Used by |
|------|----------|---------|
| `cert.pem` | X.509 public certificate in PEM format | Email clients to verify the Bridge server's identity |
| `key.pem` | Private key corresponding to the certificate | Bridge itself only; do NOT share or use in client config |

**For the MCP server (and all IMAP/SMTP clients), only `cert.pem` is needed.** The private key (`key.pem`) stays with Bridge and should never be read by email clients.

Load `cert.pem` as a trusted CA certificate in Node.js:
```javascript
const bridgeCert = fs.readFileSync('/path/to/cert.pem');
// Use in TLS options:
tls: { ca: [bridgeCert], minVersion: 'TLSv1.2' }
```

## STARTTLS vs Implicit TLS Per Port

### Default Configuration (STARTTLS)

| Port | Service | TLS Mode |
|------|---------|----------|
| 1025 | SMTP | STARTTLS (connection starts plaintext, upgrades to TLS) |
| 1143 | IMAP | STARTTLS (connection starts plaintext, upgrades to TLS) |

STARTTLS means:
- The initial TCP connection is not encrypted
- Client sends `EHLO` (SMTP) or receives server greeting (IMAP) in cleartext
- Client issues `STARTTLS` (SMTP) or `STARTTLS` capability is advertised in IMAP
- TLS handshake occurs
- All subsequent communication (including authentication) is encrypted

### SSL / Implicit TLS Configuration

When Bridge is configured to use SSL:
| Port | Service | TLS Mode |
|------|---------|----------|
| 1025 | SMTP | Implicit TLS (TLS from first byte) |
| 1143 | IMAP | Implicit TLS (TLS from first byte) |

The ports remain the same by default; the protocol changes.

### Switching TLS Mode

In Bridge: **Settings → Connection settings → Change protocol** → Select STARTTLS or SSL

This change applies to both IMAP and SMTP simultaneously.

## Node.js TLS Configuration

### For STARTTLS (default)

**Nodemailer (SMTP):**
```javascript
nodemailer.createTransport({
  host: '127.0.0.1',
  port: 1025,
  secure: false,         // false = use STARTTLS, not implicit TLS
  requireTLS: true,      // reject connection if STARTTLS unavailable
  tls: {
    ca: [fs.readFileSync('/path/to/cert.pem')],
    minVersion: 'TLSv1.2',
  },
});
```

**imapflow (IMAP):**
```javascript
new ImapFlow({
  host: '127.0.0.1',
  port: 1143,
  secure: false,         // false = use STARTTLS
  tls: {
    ca: [fs.readFileSync('/path/to/cert.pem')],
    minVersion: 'TLSv1.2',
  },
});
```

### For Implicit TLS (SSL)

**Nodemailer (SMTP):**
```javascript
nodemailer.createTransport({
  host: '127.0.0.1',
  port: 1025,
  secure: true,          // true = implicit TLS from connection start
  tls: {
    ca: [fs.readFileSync('/path/to/cert.pem')],
    minVersion: 'TLSv1.2',
  },
});
```

**imapflow (IMAP):**
```javascript
new ImapFlow({
  host: '127.0.0.1',
  port: 1143,
  secure: true,          // true = implicit TLS
  tls: {
    ca: [fs.readFileSync('/path/to/cert.pem')],
    minVersion: 'TLSv1.2',
  },
});
```

## Certificate Path Resolution (MCP Server)

The MCP server (`src/services/simple-imap-service.ts` and `src/services/smtp-service.ts`) handles cert loading with this logic:

1. If `bridgeCertPath` is a directory, look for `cert.pem` inside it
2. If `bridgeCertPath` is a file, use it directly
3. If the file can be read, set `tls.ca = [certContent]` — proper trust without disabling validation
4. If the file cannot be read (stat error, file not found), log an error and fall back to `rejectUnauthorized: false`
5. If `bridgeCertPath` is empty/not configured, log a warning and use `rejectUnauthorized: false`

The `insecureTls` flag on both service instances is set to `true` when operating without certificate validation.

## Fallback: Disabling Certificate Validation

When the Bridge certificate is not configured, the MCP server uses:
```javascript
tls: { rejectUnauthorized: false, minVersion: 'TLSv1.2' }
```

This is acceptable in the following circumstances:
- All traffic stays on 127.0.0.1 (loopback, never leaves the machine)
- No other process on the machine is expected to intercept loopback traffic

It is NOT acceptable if:
- Bridge is running on a remote machine or in a Docker container reachable via a network interface
- The deployment environment is shared or untrusted

## Certificate Trust on Different Platforms

### Linux

Option 1 — System-wide trust (Fedora/RHEL/Arch):
```bash
sudo trust anchor --store /path/to/cert.pem
```

Option 2 — Ubuntu/Debian:
```bash
sudo cp /path/to/cert.pem /usr/local/share/ca-certificates/proton-bridge.crt
sudo update-ca-certificates
```

Option 3 — Node.js only (no system install needed):
Pass the cert via `tls.ca` option as shown above. This is the approach the MCP server uses and requires no elevated privileges.

### macOS

Option 1 — Bridge installs automatically in some versions:
```bash
# From Bridge CLI:
cert install
```

Option 2 — Manual keychain trust:
1. Double-click `cert.pem` to open Keychain Access
2. Find the certificate under "login" keychain
3. Right-click → Get Info → Trust → Set "Always Trust"

Option 3 — Node.js only:
Pass via `tls.ca` as above.

### Windows

Option 1 — Import to Windows Certificate Store:
1. Double-click `cert.pem`
2. Select "Install Certificate"
3. Choose "Local Machine" → "Trusted Root Certification Authorities"

Option 2 — Node.js only:
Pass via `tls.ca` as above. Note: Node.js on Windows does NOT automatically use the Windows certificate store (unlike browsers), so even if the cert is trusted system-wide, you still need to pass it via `tls.ca` for Node.js applications.

## Known TLS Issues

### 1. `hostname/IP does not match certificate's altnames`

**Error**: `Error: Hostname/IP does not match certificate's altnames: IP: 127.0.0.1 is not in the list`

**Cause**: The certificate was issued for a different hostname. This can occur when Bridge is running on a remote host (e.g., in Docker) and the client connects via a non-loopback IP.

**Fix**: The Bridge cert is issued for `127.0.0.1`. Connect via `127.0.0.1`, not a hostname. If running in Docker/remote, either use `rejectUnauthorized: false` or generate a new Bridge cert after configuring the correct hostname.

### 2. Certificate Expiry

Bridge certificates do not expire automatically in short periods, but if Bridge regenerates its certificate (e.g., after a reset), the old exported `cert.pem` will no longer be valid. You will need to re-export the certificate.

**Symptom**: `CERT_HAS_EXPIRED` or `certificate has expired` errors after Bridge update or reset.

### 3. macOS Certificate Warning on Install

macOS may show a warning when Bridge's certificate is being installed into the keychain. This is expected behavior — the certificate is legitimate but self-signed. Proton provides guidance at https://proton.me/support/macos-certificate-warning.

### 4. Bridge v3.21.2 Enhanced Validation

As of Bridge v3.21.2 (July 2025), Bridge enhanced security by preventing potentially invalid certificates from being accepted on the Bridge side. This affects what certificates Bridge will accept from upstream (Proton's own servers), not the client-facing self-signed certificate.

### 5. Node.js Does Not Use OS Certificate Store

Unlike browsers, Node.js maintains its own certificate bundle (`require('tls').rootCertificates`). Installing the Bridge cert into the OS trust store does NOT automatically make Node.js trust it. Always pass the cert explicitly via `tls.ca` in Node.js applications.

## TLS Configuration Summary for MCP Server

The MCP server's `bridgeCertPath` config option accepts:
- A path to the `cert.pem` file directly (e.g., `~/.config/protonmail/bridge/cert.pem`)
- A path to the directory containing `cert.pem` (the MCP server will append `/cert.pem` automatically)
- Empty string or omitted → falls back to `rejectUnauthorized: false` with a warning

The same certificate is used for both IMAP and SMTP connections.

## Sources

- https://proton.me/support/comprehensive-guide-to-bridge-settings
- https://proton.me/support/bridge-ssl-connection-issue
- https://proton.me/support/macos-certificate-warning
- https://proton.me/support/apple-mail-certificate
- https://proton.me/blog/bridge-security-model
- https://man.sr.ht/~rjarry/aerc/providers/protonmail.md
- https://forum.vivaldi.net/topic/73562/starttls-support-proton-bridge
- https://github.com/shenxn/protonmail-bridge-docker/issues/43
