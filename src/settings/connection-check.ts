// Shared connection check used by BOTH the browser settings UI
// (/api/test-connection) and the terminal UI (tui.ts).
//
// Why this exists: the old checks only did a TCP port probe (`tcpCheck`), so a
// Bridge that accepts the socket but rejects AUTH (e.g. a 454 throttle, or
// wrong Bridge password) was still reported as "✅ Reachable" — a false green.
// This module distinguishes:
//   • reachable      — the TCP port answered
//   • authenticated  — STARTTLS + LOGIN/AUTH actually succeeded (null = not
//                      attempted: unreachable, or no credentials configured)
// so the UI can never show a working/green state while auth is failing.

import { Socket } from "net";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { buildBridgeTlsConfig } from "../services/bridge-tls.js";
import { loadConfig, loadCredentialsFromKeychain } from "../config/loader.js";
import { sanitizeText } from "./security.js";

export interface ProtocolCheck {
  /** The TCP port accepted a connection. */
  reachable: boolean;
  /** STARTTLS + AUTH succeeded. null = not attempted (unreachable, or no creds). */
  authenticated: boolean | null;
  /** Short human-readable failure reason when authenticated === false. */
  error: string | null;
}

export interface ConnectionCheckResult { smtp: ProtocolCheck; imap: ProtocolCheck; }

const DEFAULT_TIMEOUT_MS = 8000;

const isLocalhost = (host: string): boolean =>
  host === "localhost" || host === "127.0.0.1" || host === "::1";

/**
 * SSRF guard, co-located with the network sink: a connection probe may only
 * target localhost or an RFC1918 private-LAN address — never a public host, a
 * resolvable name, or the link-local cloud-metadata range (169.254/16). Mirrors
 * the request-boundary allow-list in server.ts, but enforced HERE at the socket
 * so the sink is safe regardless of which caller reaches it (defense in depth;
 * also the barrier the SSRF taint analysis needs — js/request-forgery).
 */
const PROBE_HOST_ALLOWLIST =
  /^(?:localhost|127\.0\.0\.1|::1|192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/;
export function isAllowedProbeHost(host: unknown): host is string {
  return typeof host === "string" && PROBE_HOST_ALLOWLIST.test(host);
}

/** TCP-only reachability — the port answered a connect(). Refuses any host that
 *  is not localhost / private-LAN (SSRF guard) before opening the socket. */
export function tcpReachable(host: string, port: number, timeoutMs = 5000): Promise<boolean> {
  return new Promise((resolve) => {
    if (!isAllowedProbeHost(host)) { resolve(false); return; }
    const safeHost = host;
    const socket = new Socket();
    socket.setTimeout(timeoutMs);
    socket.on("connect", () => { socket.destroy(); resolve(true); });
    socket.on("error", () => resolve(false));
    socket.on("timeout", () => { socket.destroy(); resolve(false); });
    socket.connect(port, safeHost);
  });
}

/** Build TLS options matching the real services' Bridge handling (shared with
 *  the IMAP service connect()/IDLE via bridge-tls.ts). Throws when a cert is
 *  required (localhost, not insecure) but can't be loaded — surfaced as an auth
 *  failure rather than a silent insecure downgrade. */
function bridgeTls(host: string, certPath: string, allowInsecure: boolean): Record<string, unknown> {
  return buildBridgeTlsConfig(host, certPath, allowInsecure).tlsOptions;
}

/** Condense a thrown SMTP/IMAP error into a short, user-facing reason. */
function shortError(e: unknown): string {
  const a = e as { responseCode?: number; response?: string; responseText?: string; message?: string };
  // `response` already includes the numeric code (e.g. "454 4.7.0 …"), so use
  // it verbatim rather than prefixing the code again.
  const raw = a?.response || a?.responseText
    || (a?.responseCode ? `${a.responseCode} ${a.message || ""}` : "")
    || a?.message || String(e);
  // sanitizeText strips C0/C1 controls including ESC (\x1b), so a hostile or
  // MITM'd server cannot smuggle terminal escape sequences out of an
  // auth-failure response. This string is rendered BOTH in the browser UI and
  // straight to stdout by the TUI, so it is scrubbed here at the boundary
  // where the untrusted bytes arrive rather than at each consumer.
  const m = sanitizeText(raw.toString().split("\n")[0], 1000).trim();
  return m.length > 140 ? m.slice(0, 137) + "…" : m;
}

/** Settle a promise OR give up after `ms`. imapflow/nodemailer don't reliably
 *  honor their own connect/socket timeouts when a server accepts the socket
 *  then stalls mid-AUTH (observed against Bridge during a 454), so this hard
 *  wall-clock cap guarantees the probe — and the UI's "Check Now" — returns. */
async function settleWithin<T>(p: Promise<T>, ms: number): Promise<{ state: "ok" } | { state: "err"; error: unknown } | { state: "timeout" }> {
  p.catch(() => { /* avoid unhandledRejection if it rejects after we time out */ });
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<{ state: "timeout" }>((resolve) => { timer = setTimeout(() => resolve({ state: "timeout" }), ms); });
  const result = await Promise.race([
    p.then(() => ({ state: "ok" as const })).catch((error) => ({ state: "err" as const, error })),
    timeout,
  ]);
  clearTimeout(timer!);
  return result;
}

export async function probeImap(
  host: string, port: number, user: string, pass: string,
  certPath: string, allowInsecure: boolean, timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ProtocolCheck> {
  if (!isAllowedProbeHost(host)) return { reachable: false, authenticated: null, error: "host not permitted (must be localhost or private LAN)" };
  const reachable = await tcpReachable(host, port, Math.min(5000, timeoutMs));
  if (!reachable) return { reachable: false, authenticated: null, error: null };
  if (!user || !pass) return { reachable: true, authenticated: null, error: "no credentials configured" };
  let tls: Record<string, unknown>;
  try { tls = bridgeTls(host, certPath, allowInsecure); }
  catch (e) { return { reachable: true, authenticated: false, error: shortError(e) }; }
  const client = new ImapFlow({
    host, port, secure: !isLocalhost(host), auth: { user, pass }, tls,
    logger: false, disableAutoIdle: true,
    connectionTimeout: timeoutMs, greetingTimeout: timeoutMs, socketTimeout: timeoutMs,
  } as ConstructorParameters<typeof ImapFlow>[0]);
  const closeClient = () => { try { (client as unknown as { close?: () => void }).close?.(); } catch { /* ignore */ } };
  const outcome = await settleWithin(client.connect(), timeoutMs);
  if (outcome.state === "timeout") {
    closeClient();
    return { reachable: true, authenticated: false, error: `auth timed out after ${Math.round(timeoutMs / 1000)}s` };
  }
  if (outcome.state === "err") {
    closeClient();
    return { reachable: true, authenticated: false, error: shortError(outcome.error) };
  }
  try { await client.logout(); } catch { closeClient(); }
  return { reachable: true, authenticated: true, error: null };
}

export async function probeSmtp(
  host: string, port: number, user: string, pass: string,
  certPath: string, allowInsecure: boolean, timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ProtocolCheck> {
  if (!isAllowedProbeHost(host)) return { reachable: false, authenticated: null, error: "host not permitted (must be localhost or private LAN)" };
  const reachable = await tcpReachable(host, port, Math.min(5000, timeoutMs));
  if (!reachable) return { reachable: false, authenticated: null, error: null };
  if (!user || !pass) return { reachable: true, authenticated: null, error: "no credentials configured" };
  let tls: Record<string, unknown>;
  try { tls = bridgeTls(host, certPath, allowInsecure); }
  catch (e) { return { reachable: true, authenticated: false, error: shortError(e) }; }
  const transport = nodemailer.createTransport({
    host, port, secure: false, requireTLS: isLocalhost(host),
    auth: { user, pass }, tls,
    connectionTimeout: timeoutMs, greetingTimeout: timeoutMs, socketTimeout: timeoutMs,
  });
  try {
    const outcome = await settleWithin(transport.verify(), timeoutMs);
    if (outcome.state === "timeout") return { reachable: true, authenticated: false, error: `auth timed out after ${Math.round(timeoutMs / 1000)}s` };
    if (outcome.state === "err") return { reachable: true, authenticated: false, error: shortError(outcome.error) };
    return { reachable: true, authenticated: true, error: null };
  } finally { try { transport.close(); } catch { /* ignore */ } }
}

/** Run both probes. Host/port default to the saved config; credentials + TLS
 *  always come from the saved config/keychain (the form never carries the
 *  password). Pass overrides to test edited-but-unsaved host/port values. */
export async function checkConnections(opts?: {
  smtpHost?: string; smtpPort?: number; imapHost?: string; imapPort?: number;
}): Promise<ConnectionCheckResult> {
  const cn = loadConfig()?.connection ?? ({} as Record<string, unknown>);
  let pass = (cn.password as string) || "";
  try {
    const kc = await loadCredentialsFromKeychain();
    if (kc && kc.storage !== "decrypt-failed" && kc.password) pass = kc.password;
  } catch { /* fall back to config-file value */ }

  const user = (cn.username as string) || "";
  const certPath = (cn.bridgeCertPath as string) || "";
  const allowInsecure = (cn.allowInsecureBridge as boolean) ?? false;
  const smtpHost = opts?.smtpHost ?? (cn.smtpHost as string) ?? "localhost";
  const smtpPort = opts?.smtpPort ?? (cn.smtpPort as number) ?? 1025;
  const imapHost = opts?.imapHost ?? (cn.imapHost as string) ?? "localhost";
  const imapPort = opts?.imapPort ?? (cn.imapPort as number) ?? 1143;

  const [smtp, imap] = await Promise.all([
    probeSmtp(smtpHost, smtpPort, user, pass, certPath, allowInsecure),
    probeImap(imapHost, imapPort, user, pass, certPath, allowInsecure),
  ]);
  return { smtp, imap };
}
