// Shared TLS options for Proton Bridge local connections (SMTP + IMAP).
//
// Node 25 rejects IP literals (e.g. "127.0.0.1") as the TLS servername before
// checkServerIdentity can run. Using "localhost" keeps SNI legal. The pinned
// Bridge CA cert is the trust anchor; checkServerIdentity is bypassed because
// Bridge exports certs with CN=127.0.0.1, which would not match "localhost".

import { readFileSync, statSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import { logger } from "../utils/logger.js";

/** SHA-256 hashes of pinned Bridge certs, keyed by absolute path.
 *  The first time we read a cert we remember its hash; subsequent reads must
 *  produce the same bytes or we refuse the connection. Closes the TOCTOU
 *  window where an attacker with write access to the cert path could swap it
 *  between the bridge cert export (verified by the user out-of-band) and a
 *  later TLS connect. */
const pinnedCertHashes = new Map<string, string>();

export function buildBridgeTlsOptions(cert: Buffer): Record<string, unknown> {
  return {
    ca: [cert],
    minVersion: "TLSv1.2",
    servername: "localhost",
    checkServerIdentity: () => undefined,
  };
}

/** Read the Bridge CA cert at `certPath`, verifying it matches the hash we
 *  pinned on first read. Throws if the bytes have changed since startup. */
export function readPinnedBridgeCert(certPath: string): Buffer {
  const buf = readFileSync(certPath);
  const hash = createHash("sha256").update(buf).digest("hex");
  const existing = pinnedCertHashes.get(certPath);
  if (existing === undefined) {
    pinnedCertHashes.set(certPath, hash);
    return buf;
  }
  if (existing !== hash) {
    logger.error(
      `Bridge CA cert at ${certPath} changed since startup (hash ${existing.slice(0, 16)}… → ${hash.slice(0, 16)}…). Refusing connection — the pinned trust anchor must remain stable for the life of the process.`,
      "BridgeTLS",
    );
    throw new Error(`Bridge cert pin violation: ${certPath} hash changed since startup`);
  }
  return buf;
}

export interface BridgeTlsConfig {
  /** TLS options to hand to imapflow / nodemailer. */
  tlsOptions: Record<string, unknown>;
  /** True when certificate validation was disabled (insecure fallback). */
  insecure: boolean;
  /** Messages for the caller to emit with its own logger + context. */
  logs: Array<{ level: "info" | "warn"; msg: string }>;
}

/**
 * Resolve TLS options for a Proton Bridge connection from (host, cert path,
 * allow-insecure) — the single decision both the IMAP service `connect()` and
 * the settings connection-check need:
 *  - non-localhost          → standard validation (minVersion TLSv1.2);
 *  - localhost + cert       → pin the cert (buildBridgeTlsOptions);
 *  - localhost + cert fails  → throw UNLESS allowInsecure (then validation off);
 *  - localhost + no cert     → throw UNLESS allowInsecure (then validation off).
 * `insecure` reports whether validation was disabled; `logs` are returned (not
 * emitted) so the caller controls the logger/context. fs access (statSync for
 * dir→cert.pem resolution, readFileSync via readPinnedBridgeCert) keeps the
 * cert-pin TOCTOU protection.
 */
export function buildBridgeTlsConfig(
  host: string,
  bridgeCertPath: string | undefined,
  allowInsecure: boolean,
): BridgeTlsConfig {
  const isLocalhost = host === "localhost" || host === "127.0.0.1" || host === "::1";
  const logs: BridgeTlsConfig["logs"] = [];
  const insecureOpts = { rejectUnauthorized: false, minVersion: "TLSv1.2" };

  if (!isLocalhost) {
    return { tlsOptions: { minVersion: "TLSv1.2" }, insecure: false, logs };
  }

  if (bridgeCertPath) {
    let resolved = bridgeCertPath;
    try {
      if (statSync(bridgeCertPath).isDirectory()) {
        resolved = join(bridgeCertPath, "cert.pem");
        logs.push({ level: "info", msg: `Directory given for cert path — resolved to ${resolved}` });
      }
    } catch { /* stat failed — let readPinnedBridgeCert produce the real error */ }
    try {
      const tlsOptions = buildBridgeTlsOptions(readPinnedBridgeCert(resolved));
      logs.push({ level: "info", msg: `Using exported Bridge certificate for TLS trust (${resolved})` });
      return { tlsOptions, insecure: false, logs };
    } catch (err) {
      if (!allowInsecure) {
        throw new Error(
          `Bridge cert at "${resolved}" could not be loaded and allowInsecureBridge is not set. ` +
          `Fix the cert path in Settings → Connection, or set allowInsecureBridge: true ` +
          `(or MAILPOUCH_INSECURE_BRIDGE=1) to opt into the legacy insecure behavior. ` +
          `Underlying error: ${(err as Error).message}`,
        );
      }
      logs.push({
        level: "warn",
        msg: `Failed to load Bridge cert at "${resolved}" — running with TLS validation DISABLED (allowInsecureBridge is set). ` +
          `Export a fresh cert from Bridge → Help → Export TLS Certificate and update Settings → Connection to re-secure.`,
      });
      return { tlsOptions: insecureOpts, insecure: true, logs };
    }
  }

  if (!allowInsecure) {
    throw new Error(
      "No Bridge certificate configured. Export the cert from Bridge → Help → Export TLS Certificate " +
      "and set 'bridgeCertPath' in Settings → Connection. To opt into the legacy behavior (TLS validation " +
      "disabled for localhost), set allowInsecureBridge: true or launch with MAILPOUCH_INSECURE_BRIDGE=1.",
    );
  }
  logs.push({
    level: "warn",
    msg: "No Bridge certificate configured and allowInsecureBridge is set — TLS certificate validation DISABLED for localhost. " +
      "Export the cert from Bridge → Help → Export TLS Certificate and clear the insecure flag to re-secure.",
  });
  return { tlsOptions: insecureOpts, insecure: true, logs };
}

/** Reset the pinned-hash table. Test-only. */
export function _resetBridgeCertPinsForTests(): void {
  pinnedCertHashes.clear();
}
