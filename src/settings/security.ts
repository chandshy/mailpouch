/**
 * Security utilities for the pm-bridge-mcp Settings Server
 *
 * Covers:
 *   • Per-IP rate limiting (sliding window, in-memory)
 *   • Safe request body reading (size cap + timeout)
 *   • Origin / Referer validation (defence-in-depth)
 *   • LAN access token (256-bit, single-use per server instance)
 *   • Self-signed TLS certificate generation via system openssl
 *   • Constant-time token comparison to prevent timing attacks
 *   • Input sanitisation helpers shared with the escalation module
 *
 * None of this requires third-party packages — only Node.js built-ins.
 */

import http from "http";
import { spawnSync } from "child_process";
import { mkdtempSync, readFileSync, existsSync } from "fs";
import { tmpdir, networkInterfaces } from "os";
import { join } from "path";
import { randomBytes, createHash, timingSafeEqual } from "crypto";

// ─── Constants ─────────────────────────────────────────────────────────────────

/** Max POST body size: 64 KiB.  Rejects bodies that could exhaust heap. */
export const MAX_BODY_BYTES = 65_536;

/** Abort reading body after this many ms (Slow Loris / slow POST). */
export const BODY_TIMEOUT_MS = 15_000;

/** Per-IP request rate: general endpoints (req / window). */
export const GENERAL_RATE_LIMIT    = 120; // per minute

/** Per-IP request rate: mutating escalation endpoints. */
export const ESCALATION_RATE_LIMIT = 20;  // per minute

/** Per-IP request rate: any request when serving over LAN. */
export const LAN_RATE_LIMIT        = 200; // per minute (slightly tighter)

// ─── Rate Limiter ──────────────────────────────────────────────────────────────

/** Maximum number of distinct keys the rate-limiter will track simultaneously.
 *  Prevents unbounded Map growth between eviction sweeps when an attacker
 *  rotates source IPs or uses many unique composite keys.  When the cap is
 *  reached the stalest bucket (the first key in insertion order, since V8 Maps
 *  preserve insertion order) is dropped to make room for the new key.
 */
const MAX_RATE_LIMIT_BUCKETS = 10_000;

/**
 * Sliding-window in-memory rate limiter.
 *
 * Keyed by any string (typically the client IP address + optional route tag).
 * Stale buckets are evicted every `windowMs` to prevent unbounded memory growth.
 * A hard cap of MAX_RATE_LIMIT_BUCKETS distinct keys is enforced per instance.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, number[]>();
  private readonly cleanup: ReturnType<typeof setInterval>;

  constructor(
    private readonly maxRequests: number,
    private readonly windowMs:    number,
  ) {
    // Evict stale entries on a 5-minute timer; unref so it does not
    // prevent the process from exiting.
    this.cleanup = setInterval(() => this.evict(), 5 * 60 * 1000);
    this.cleanup.unref();
  }

  /**
   * Consume one slot for `key`.
   * Returns true if the request is allowed; false if the limit is exceeded.
   */
  check(key: string): boolean {
    const now         = Date.now();
    const windowStart = now - this.windowMs;

    let times = this.buckets.get(key) ?? [];
    times = times.filter(t => t > windowStart);

    if (times.length >= this.maxRequests) {
      this.buckets.set(key, times); // write back evicted slice
      return false;
    }

    times.push(now);

    // Enforce the per-instance key cap before inserting a brand-new key.
    // Run eviction first to clear stale buckets, then check the cap.
    if (!this.buckets.has(key)) {
      if (this.buckets.size >= MAX_RATE_LIMIT_BUCKETS) {
        this.evict();
      }
      if (this.buckets.size >= MAX_RATE_LIMIT_BUCKETS) {
        const oldestKey = this.buckets.keys().next().value;
        if (oldestKey !== undefined) this.buckets.delete(oldestKey);
      }
    }

    this.buckets.set(key, times);
    return true;
  }

  /** Current slot count for a key (does not consume a slot). */
  count(key: string): number {
    const windowStart = Date.now() - this.windowMs;
    return (this.buckets.get(key) ?? []).filter(t => t > windowStart).length;
  }

  dispose(): void { clearInterval(this.cleanup); }

  private evict(): void {
    const threshold = Date.now() - this.windowMs;
    for (const [key, times] of this.buckets) {
      if (times.every(t => t <= threshold)) this.buckets.delete(key);
    }
  }
}

// ─── Safe body reader ──────────────────────────────────────────────────────────

/**
 * Reads an HTTP request body with strict guards:
 *   • Aborts and destroys the socket if the body exceeds `maxBytes`.
 *   • Aborts after `timeoutMs` with no data (Slow Loris / slow-POST).
 *
 * Callers should still validate/sanitise the returned string.
 */
export function readBodySafe(
  req: http.IncomingMessage,
  maxBytes  = MAX_BODY_BYTES,
  timeoutMs = BODY_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    const timer = setTimeout(() => {
      req.destroy();
      reject(Object.assign(new Error("Request body timeout"), { code: "TIMEOUT" }));
    }, timeoutMs);

    const onData = (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        clearTimeout(timer);
        req.destroy();
        reject(Object.assign(
          new Error(`Request body too large (max ${maxBytes} bytes)`),
          { code: "TOO_LARGE" },
        ));
        return;
      }
      chunks.push(chunk);
    };

    req.on("data",  onData);
    req.on("end",   () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString("utf-8")); });
    req.on("error", (err) => { clearTimeout(timer); reject(err); });
  });
}

// ─── Origin / Referer validation ───────────────────────────────────────────────

/**
 * Returns true if the request's `Origin` or `Referer` header is consistent
 * with the settings server itself.
 *
 * This is defence-in-depth alongside CSRF tokens — neither alone is
 * sufficient, together they raise the bar significantly.
 *
 * Requests with no Origin/Referer are allowed (some legitimate browser
 * environments omit them); the CSRF check is the authoritative gate.
 *
 * @param scheme  "http" or "https" — the actual scheme the server is using.
 *                This is required to accept the correct origin in TLS mode,
 *                where browsers send `https://` rather than `http://` origins.
 */
export function isValidOrigin(
  req:    http.IncomingMessage,
  port:   number,
  lan:    boolean,
  scheme: "http" | "https" = "http",
): boolean {
  const origin  = req.headers["origin"]  as string | undefined;
  const referer = req.headers["referer"] as string | undefined;
  const header  = origin ?? referer;

  if (!header) return true; // absent → defer to CSRF

  // Build the set of permitted origin prefixes for this server instance.
  // Always include both http:// and https:// for localhost to handle
  // environments where the scheme differs from what we expected.
  const valid: string[] = [
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
    `https://localhost:${port}`,
    `https://127.0.0.1:${port}`,
  ];

  if (lan) {
    const lanIP = getPrimaryLanIP();
    if (lanIP) {
      valid.push(`http://${lanIP}:${port}`);
      valid.push(`https://${lanIP}:${port}`);
    }
    // Accept RFC-1918 ranges in LAN mode; include both schemes.
    // Use a regex to avoid prefix spoofing (e.g. "http://192.168.evil.com").
    // Each alternative must produce exactly 3 octets so that the outer
    // `\.\d{1,3}` brings the total to 4, matching real IPv4 RFC-1918 addresses:
    //   192.168.X   → 192.168.X.Y  (4 octets ✓)
    //   10.X.Y      → 10.X.Y.Z     (4 octets ✓)   ← was 10.X (3 octets ✗)
    //   172.[16-31].X → 172.Z.X.Y  (4 octets ✓)
    const RFC1918_RE =
      /^https?:\/\/(?:192\.168\.\d{1,3}|10\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3})\.\d{1,3}(?::\d+)?(?:\/|$)/;
    if (RFC1918_RE.test(header)) return true;
  }

  // Use exact match (for Origin headers, which carry no path) or require a
  // "/" separator (for Referer headers, which include a path).  A bare
  // startsWith("http://localhost:3000") would incorrectly accept
  // "http://localhost:30001/..." due to the numeric prefix overlap.
  return valid.some(v => header === v || header.startsWith(v + "/"));
}

// ─── LAN access token ──────────────────────────────────────────────────────────

export interface AccessToken {
  /** Raw token (64 hex chars = 256-bit random). */
  value:       string;
  /** Truncated SHA-256 of value — safe to display publicly. */
  fingerprint: string;
}

/** Generate a fresh 256-bit access token for LAN mode. */
export function generateAccessToken(): AccessToken {
  const value       = randomBytes(32).toString("hex");
  const fingerprint = createHash("sha256")
    .update(value)
    .digest("hex")
    .slice(0, 16)
    .toUpperCase()
    .replace(/(.{4})/g, "$1-")
    .slice(0, -1); // format: ABCD-EFGH-IJKL-MNOP
  return { value, fingerprint };
}

/**
 * Check whether an incoming request carries the valid access token.
 * Uses `timingSafeEqual` to prevent timing-based enumeration.
 *
 * Checks (in order):
 *   1. `X-Access-Token` header   — preferred (not in URL logs)
 *   2. `?token=` query parameter — for direct mobile URL access
 */
export function hasValidAccessToken(
  req:   http.IncomingMessage,
  url:   URL,
  token: AccessToken,
): boolean {
  const expected = Buffer.from(token.value, "utf-8");

  const tryCompare = (candidate: string | undefined): boolean => {
    if (!candidate) return false;
    if (candidate.length !== token.value.length) return false;
    try {
      return timingSafeEqual(Buffer.from(candidate, "utf-8"), expected);
    } catch {
      return false;
    }
  };

  return (
    tryCompare(req.headers["x-access-token"] as string | undefined) ||
    tryCompare(url.searchParams.get("token") ?? undefined)
  );
}

// ─── TLS certificate generation ───────────────────────────────────────────────

export interface TlsCredentials {
  key:         Buffer;
  cert:        Buffer;
  /** Human-readable SHA-256 fingerprint for display in the terminal. */
  fingerprint: string;
}

/**
 * Attempt to generate a self-signed TLS certificate via the system `openssl`
 * binary.  Returns `null` if openssl is unavailable or fails.
 *
 * The cert is written to a temporary directory and loaded into memory;
 * the files are left on disk in `/tmp` and will be cleaned by the OS.
 *
 * The resulting credentials are suitable for `https.createServer()`.
 */
export function tryGenerateSelfSignedCert(): TlsCredentials | null {
  try {
    const dir      = mkdtempSync(join(tmpdir(), "protonmcp-tls-"));
    const keyFile  = join(dir, "key.pem");
    const certFile = join(dir, "cert.pem");

    const result = spawnSync(
      "openssl",
      [
        "req", "-x509",
        "-newkey", "rsa:2048",
        "-keyout", keyFile,
        "-out",    certFile,
        "-days",   "365",
        "-nodes",
        "-batch",
        "-subj",   "/CN=pm-bridge-mcp Settings/O=Local/C=US",
      ],
      { stdio: "pipe", timeout: 30_000 },
    );

    if (result.status !== 0 || !existsSync(certFile)) return null;

    const key  = readFileSync(keyFile);
    const cert = readFileSync(certFile);

    // Compute SHA-256 fingerprint from cert DER bytes
    const pemBody = cert.toString("utf-8")
      .replace(/-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\s/g, "");
    const der         = Buffer.from(pemBody, "base64");
    const fingerprint = createHash("sha256")
      .update(der)
      .digest("hex")
      .match(/.{2}/g)!
      .join(":")
      .toUpperCase();

    return { key, cert, fingerprint };
  } catch {
    return null;
  }
}

// ─── Input sanitisers ─────────────────────────────────────────────────────────

/** Hex challenge IDs are exactly 32 chars (128-bit randomBytes). */
const CHALLENGE_ID_RE = /^[0-9a-f]{32}$/;

export function isValidChallengeId(id: unknown): id is string {
  return typeof id === "string" && CHALLENGE_ID_RE.test(id);
}

/** Strip C0/C1 control characters (except tab/LF/CR) and NUL. */
const CONTROL_CHARS_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\x80-\x9f]/g;

export function sanitizeText(text: unknown, maxLen = 500): string {
  if (typeof text !== "string") return "";
  return text.replace(CONTROL_CHARS_RE, "").slice(0, maxLen).trim();
}

/**
 * Presets an agent is allowed to request escalation to.
 * Intentionally excludes "read_only" (you can't escalate downward) and
 * "custom" (custom presets are human-configured, not agent-requested).
 */
const VALID_ESCALATION_TARGETS = new Set(["send_only", "supervised", "full"]);

export function isValidEscalationTarget(preset: unknown): preset is string {
  return typeof preset === "string" && VALID_ESCALATION_TARGETS.has(preset);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Get the machine's primary non-loopback IPv4 address. */
export function getPrimaryLanIP(): string {
  try {
    for (const ifaces of Object.values(networkInterfaces())) {
      for (const iface of ifaces ?? []) {
        if (iface.family === "IPv4" && !iface.internal) return iface.address;
      }
    }
  } catch { /* ignore */ }
  return "";
}

/**
 * Extract the remote IP from a Node.js HTTP request, preferring
 * socket.remoteAddress over any forwarded headers (we do not sit behind
 * a proxy so forwarded headers should never be trusted here).
 */
export function clientIP(req: http.IncomingMessage): string {
  return req.socket?.remoteAddress ?? "unknown";
}
