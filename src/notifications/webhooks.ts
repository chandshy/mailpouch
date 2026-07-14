/**
 * Outbound webhook deliverer.
 *
 * Fires on grant-state transitions (pending, approved, denied, revoked,
 * expired) to user-configured HTTP endpoints. Three delivery "formats":
 *
 *   "cloudevents" (default)  — CloudEvents 1.0 JSON envelope. The most
 *                              interoperable choice; consumed by Knative,
 *                              Azure Event Grid, and most event routers.
 *   "slack"                  — Slack incoming-webhook shape ({ text,
 *                              blocks? }). Auto-selected when the URL
 *                              matches hooks.slack.com.
 *   "discord"                — Discord webhook shape ({ content,
 *                              embeds? }). Auto-selected for
 *                              discord.com/api/webhooks URLs.
 *   "raw"                    — Send the raw grant JSON.
 *
 * Signing: every delivery carries an `X-Mailpouch-Signature-256` header
 * whose value is `sha256=<hex>` of HMAC(body, secret) — matches the
 * GitHub webhook convention. No signing happens when the endpoint has
 * no secret configured.
 *
 * Retries: exponential backoff (1 / 2 / 4 / 8 / 16 / 32 / 64 / 128 s)
 * with ±20 % jitter, max 8 attempts. After the final failure we log
 * at warn and drop — no DLQ yet.
 */

import { createHmac, randomBytes } from "crypto";
import { lookup as dnsLookup } from "dns/promises";
import { request as httpRequest, type ClientRequest, type RequestOptions } from "http";
import { request as httpsRequest } from "https";
import { isIP } from "net";
import { logger } from "../utils/logger.js";
import type { GrantChangedEvent } from "../agents/notifications.js";

/**
 * Reject URLs that would let an attacker-controlled (or mis-configured)
 * endpoint hit internal services — cloud metadata, loopback, private
 * ranges, link-local, IPv6 ULA. Admin can opt-in to private targets via
 * the `allowPrivateTargets` flag on the dispatcher (for self-hosted
 * routers like a local n8n or Home Assistant webhook).
 *
 * This exported URL-only check catches literals and special-use hostnames.
 * `WebhookDispatcher` also resolves DNS names immediately before every
 * outbound attempt, so a hostname cannot silently resolve to a private or
 * reserved address. Redirects are disabled rather than delegated to fetch.
 */
export function isPrivateWebhookTarget(rawUrl: string): boolean {
  const url = parseWebhookUrl(rawUrl);
  return !url || isPrivateWebhookHostname(url.hostname);
}

function parseWebhookUrl(rawUrl: string): URL | undefined {
  try {
    const url = new URL(rawUrl);
    // `allowPrivateTargets` is deliberately narrow: it permits private
    // network addresses, not non-HTTP schemes or URL credentials.
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

function normalizeHostname(hostname: string): string {
  let host = hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  return host.replace(/\.+$/, "");
}

function isPrivateWebhookHostname(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  if (!host) return true;
  // `.local` is mDNS and `home.arpa` is reserved for local home networks.
  if (host === "localhost" || host.endsWith(".localhost") ||
      host === "local" || host.endsWith(".local") ||
      host === "home.arpa" || host.endsWith(".home.arpa") ||
      host === "metadata.google.internal") return true;
  return isUnsafeIpAddress(host);
}

/** Whether an IP literal is non-public. DNS names are checked after resolution. */
function isUnsafeIpAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) return isUnsafeIpv4Address(address);
  if (kind === 6) return isUnsafeIpv6Address(address);
  return false;
}

function parseIpv4Bytes(address: string): number[] | undefined {
  const parts = address.split(".");
  if (parts.length !== 4) return undefined;
  const bytes = parts.map(part => {
    if (!/^\d+$/.test(part)) return Number.NaN;
    return Number(part);
  });
  return bytes.every(part => Number.isInteger(part) && part >= 0 && part <= 255) ? bytes : undefined;
}

function isUnsafeIpv4Address(address: string): boolean {
  const parts = parseIpv4Bytes(address);
  if (!parts) return true;
  const [a, b, c] = parts;
  // RFC 1918, carrier-grade NAT, loopback, link-local, unspecified,
  // multicast/reserved, documentation, benchmarking, and other special-use
  // ranges are never valid public webhook destinations.
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
    (a === 198 && ((b === 18 || b === 19) || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113);
}

/** Parse an IPv6 literal into 16 bytes, including IPv4-mapped spellings. */
function parseIpv6Bytes(address: string): number[] | undefined {
  let value = address.toLowerCase().replace(/%.*/, "");
  const ipv4Start = value.lastIndexOf(":");
  if (value.includes(".")) {
    if (ipv4Start < 0) return undefined;
    const ipv4 = parseIpv4Bytes(value.slice(ipv4Start + 1));
    if (!ipv4) return undefined;
    const high = ((ipv4[0] << 8) | ipv4[1]).toString(16);
    const low = ((ipv4[2] << 8) | ipv4[3]).toString(16);
    value = `${value.slice(0, ipv4Start + 1)}${high}:${low}`;
  }

  const compressed = value.split("::");
  if (compressed.length > 2) return undefined;
  const left = compressed[0] ? compressed[0].split(":") : [];
  const right = compressed.length === 2 && compressed[1] ? compressed[1].split(":") : [];
  if (left.length + right.length > 8 || (compressed.length === 1 && left.length !== 8)) return undefined;
  const groups = compressed.length === 2
    ? [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right]
    : left;
  if (groups.length !== 8 || groups.some(group => !/^[0-9a-f]{1,4}$/.test(group))) return undefined;
  return groups.flatMap(group => {
    const value = Number.parseInt(group, 16);
    return [value >> 8, value & 0xff];
  });
}

function isUnsafeIpv6Address(address: string): boolean {
  const bytes = parseIpv6Bytes(address);
  if (!bytes) return true;
  const startsWith = (...prefix: number[]) => prefix.every((byte, index) => bytes[index] === byte);
  const allZero = bytes.every(byte => byte === 0);
  if (allZero || (bytes.slice(0, 15).every(byte => byte === 0) && bytes[15] === 1)) return true;
  // IPv4-compatible / IPv4-mapped values can otherwise disguise a blocked
  // v4 address (for example ::ffff:7f00:1).
  if (bytes.slice(0, 12).every(byte => byte === 0)) return true;
  if (bytes.slice(0, 10).every(byte => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return isUnsafeIpv4Address(bytes.slice(12).join("."));
  }
  if (bytes[0] === 0xff || (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) ||
      (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0xc0) || (bytes[0] & 0xfe) === 0xfc) return true;
  // 2001:db8::/32 is documentation-only. For NAT64 and 6to4, inspect the
  // embedded IPv4 destination too instead of allowing it to bypass v4 rules.
  if (startsWith(0x20, 0x01, 0x0d, 0xb8)) return true;
  if (startsWith(0x00, 0x64, 0xff, 0x9b) && bytes.slice(4, 12).every(byte => byte === 0)) {
    return isUnsafeIpv4Address(bytes.slice(12).join("."));
  }
  if (startsWith(0x20, 0x02)) return isUnsafeIpv4Address(bytes.slice(2, 6).join("."));
  return false;
}

export type WebhookFormat = "cloudevents" | "slack" | "discord" | "raw";

export interface WebhookEndpoint {
  id: string;
  url: string;
  /** Optional HMAC secret. When present, signs every body. */
  secret?: string;
  format?: WebhookFormat;       // defaults to "cloudevents" or auto-detected
  enabled?: boolean;            // default true
  /** Which event kinds to deliver. Defaults to all grant events. */
  subscribe?: Array<"grant-created" | "grant-approved" | "grant-denied" | "grant-revoked" | "grant-expired">;
}

const DEFAULT_SUBSCRIBE: NonNullable<WebhookEndpoint["subscribe"]> = [
  "grant-created", "grant-approved", "grant-denied", "grant-revoked", "grant-expired",
];

const MAX_ATTEMPTS = 8;
/** ms. First value is the initial wait; doubled each retry. */
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 128_000;
/** Bound one network attempt so a stalled endpoint cannot tie up delivery indefinitely. */
const DEFAULT_ATTEMPT_TIMEOUT_MS = 10_000;

function jitter(base: number): number {
  // ±20 % jitter: multiplier in [0.8, 1.2].
  const mult = 0.8 + Math.random() * 0.4;
  return Math.min(Math.round(base * mult), MAX_DELAY_MS);
}

/** Auto-detect the best format from a URL when one isn't explicitly set. */
export function detectFormat(url: string): WebhookFormat {
  try {
    const u = new URL(url);
    if (u.hostname === "hooks.slack.com") return "slack";
    if (u.hostname === "discord.com" || u.hostname === "discordapp.com") return "discord";
  } catch { /* bad URL — caller will error on delivery */ }
  return "cloudevents";
}

/**
 * UI-017: a DCR client_name is attacker-controlled. When interpolated into a
 * Slack `text` or Discord `content` it can trigger a real `@here`/`@everyone`
 * ping or render a deceptive `<url|label>` link. Neutralise the platform
 * control sequences (`@`, `<`, `>`, backtick) so the name renders as inert
 * text. (The name is already stripped of control chars at DCR registration;
 * this guards the chat-mention vector specifically.)
 */
function neutralizeChatMentions(name: string): string {
  return name
    .replace(/@/g, "@​")   // break @here / @everyone / <@id> mentions
    .replace(/</g, "(")
    .replace(/>/g, ")")
    .replace(/`/g, "'");
}

/** Build the outgoing body for a given format + grant event. */
export function buildPayload(ev: GrantChangedEvent, format: WebhookFormat): Record<string, unknown> {
  const g = ev.grant;
  const action =
    ev.kind === "grant-created"  ? "requested access" :
    ev.kind === "grant-approved" ? "was approved" :
    ev.kind === "grant-denied"   ? "was denied" :
    ev.kind === "grant-revoked"  ? "was revoked" :
                                    "expired";
  const detail = `preset: ${g.preset} · status: ${g.status}` +
    (g.conditions?.expiresAt ? ` · expires ${g.conditions.expiresAt}` : "");

  if (format === "slack" || format === "discord") {
    const safeLine = `Agent '${neutralizeChatMentions(g.clientName)}' ${action}.`;
    return format === "slack"
      ? { text: `*mailpouch* — ${safeLine}\n${detail}` }
      : { content: `**mailpouch** — ${safeLine}\n${detail}` };
  }
  if (format === "raw") {
    return { kind: ev.kind, seq: ev.seq, grant: g };
  }
  // CloudEvents 1.0 envelope.
  return {
    specversion: "1.0",
    id: `mp-${randomBytes(8).toString("hex")}`,
    source: "mailpouch",
    type: `com.mailpouch.${ev.kind.replace("-", ".")}`,
    time: new Date().toISOString(),
    datacontenttype: "application/json",
    data: {
      clientId: g.clientId,
      clientName: g.clientName,
      status: g.status,
      preset: g.preset,
      conditions: g.conditions,
      totalCalls: g.totalCalls,
    },
  };
}

function sign(body: string, secret: string): string {
  const mac = createHmac("sha256", secret).update(body, "utf-8").digest("hex");
  return `sha256=${mac}`;
}

export interface DeliveryResult {
  endpointId: string;
  url: string;
  ok: boolean;
  status?: number;
  attempts: number;
  lastError?: string;
}

export interface ResolvedWebhookAddress {
  address: string;
  family: number;
}

/** Resolve all addresses for a webhook hostname immediately before delivery. */
export type WebhookHostnameResolver = (hostname: string) => Promise<ReadonlyArray<ResolvedWebhookAddress>>;

const resolveWebhookHostname: WebhookHostnameResolver = async hostname =>
  dnsLookup(hostname, { all: true, verbatim: true });

export interface WebhookDispatcherDeps {
  /** Override fetch for tests. */
  fetcher?: typeof globalThis.fetch;
  /** Override sleep for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Override hostname resolution for deterministic tests. */
  resolveHostname?: WebhookHostnameResolver;
  /** Per-attempt timeout in milliseconds. Defaults to 10 seconds. */
  attemptTimeoutMs?: number;
  /**
   * Permit webhooks to loopback / RFC-1918 / link-local / ULA targets.
   * Off by default — SSRF-style defense for cloud deployments. Enable
   * only for self-hosted routers (n8n on the LAN, local Home Assistant,
   * etc.). See `isPrivateWebhookTarget` for the full guard list.
   */
  allowPrivateTargets?: boolean;
}

export class WebhookDispatcher {
  private readonly fetcher?: typeof globalThis.fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly resolveHostname: WebhookHostnameResolver;
  private readonly allowPrivateTargets: boolean;
  private readonly attemptTimeoutMs: number;

  constructor(deps: WebhookDispatcherDeps = {}) {
    this.fetcher = deps.fetcher;
    this.sleep = deps.sleep ?? ((ms) => new Promise(r => setTimeout(r, ms)));
    this.resolveHostname = deps.resolveHostname ?? resolveWebhookHostname;
    this.allowPrivateTargets = !!deps.allowPrivateTargets;
    this.attemptTimeoutMs = Number.isFinite(deps.attemptTimeoutMs) && (deps.attemptTimeoutMs ?? 0) > 0
      ? Math.floor(deps.attemptTimeoutMs!)
      : DEFAULT_ATTEMPT_TIMEOUT_MS;
  }

  /** Race a non-abortable operation (such as DNS lookup) against a deadline. */
  private withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback();
      };
      const timer = setTimeout(() => settle(() => reject(new Error("attempt_timeout"))), timeoutMs);
      void operation.then(
        value => settle(() => resolve(value)),
        error => settle(() => reject(error)),
      );
    });
  }

  /**
   * Resolve a DNS hostname for every attempt and reject the entire endpoint
   * when any answer is private, special-use, or malformed. Choosing a public
   * answer from a mixed set would leave an SSRF path through DNS rotation.
   */
  private async resolveTarget(url: URL, timeoutMs: number): Promise<ResolvedWebhookAddress[]> {
    const hostname = normalizeHostname(url.hostname);
    const literalFamily = isIP(hostname);
    const records = literalFamily
      ? [{ address: hostname, family: literalFamily }]
      : await this.withTimeout(this.resolveHostname(hostname), timeoutMs);
    if (!records.length || records.some(record => {
      const family = isIP(record.address);
      return !family || record.family !== family;
    })) {
      throw new Error("target_resolution_failed");
    }
    if (!this.allowPrivateTargets && records.some(record => isUnsafeIpAddress(record.address))) {
      throw new Error("private_target_rejected");
    }
    return [...records];
  }

  /**
   * Test fetchers retain the existing seam. Production uses the pinned core
   * adapter below, which connects to the exact address returned by the check.
   */
  private async postWithFetchTimeout(
    url: string,
    headers: Record<string, string>,
    body: string,
    timeoutMs: number,
  ): Promise<Response> {
    if (!this.fetcher) throw new Error("fetcher_unavailable");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetcher(url, {
        method: "POST",
        headers,
        body,
        // Manual means the response status remains visible, so redirects can
        // be rejected rather than implicitly issuing a second request.
        redirect: "manual",
        signal: controller.signal,
      });
      // Test/custom fetch adapters receive the same bounded-response policy
      // as the core path: response content is never part of webhook delivery.
      void response.body?.cancel().catch(() => undefined);
      return response;
    } catch (err) {
      if (controller.signal.aborted) throw new Error("attempt_timeout");
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Post through Node core to the already-validated address. `hostname` is
   * deliberately the IP while Host/SNI retain the endpoint hostname, so DNS
   * cannot be rebound between the safety check and the TCP connection.
   */
  private postToPinnedAddress(
    url: URL,
    target: ResolvedWebhookAddress,
    headers: Record<string, string>,
    body: string,
    timeoutMs: number,
  ): Promise<Pick<Response, "status" | "ok">> {
    const hostname = normalizeHostname(url.hostname);
    const path = `${url.pathname || "/"}${url.search}`;
    const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
    const options: RequestOptions = {
      hostname: target.address,
      family: target.family as 4 | 6,
      port,
      path,
      method: "POST",
      // When connecting to an IP, Node would otherwise send that IP as Host.
      // Preserve the configured hostname so virtual-hosted endpoints work.
      headers: { ...headers, Host: url.host },
    };
    const isTls = url.protocol === "https:";
    if (isTls && !isIP(hostname)) {
      // Keep certificate validation and SNI bound to the configured hostname.
      Object.assign(options, { servername: hostname });
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (callback: () => void) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        callback();
      };
      const onResponse = (response: import("http").IncomingMessage) => {
        const status = response.statusCode ?? 0;
        // Never parse endpoint-controlled response bytes. Destroy the stream
        // at headers, giving response handling a zero-byte upper bound.
        response.on("error", () => undefined);
        response.destroy();
        settle(() => resolve({ status, ok: status >= 200 && status < 300 }));
      };
      const request: ClientRequest = isTls
        ? httpsRequest(options, onResponse)
        : httpRequest(options, onResponse);
      request.once("error", error => settle(() => reject(error)));
      timer = setTimeout(() => {
        const error = new Error("attempt_timeout");
        request.destroy(error);
        settle(() => reject(error));
      }, timeoutMs);
      request.end(body);
    });
  }

  /** Issue one no-follow, timed request through the test or pinned adapter. */
  private async postWithTimeout(
    url: URL,
    target: ResolvedWebhookAddress,
    headers: Record<string, string>,
    body: string,
    timeoutMs: number,
  ): Promise<Pick<Response, "status" | "ok">> {
    return this.fetcher
      ? this.postWithFetchTimeout(url.toString(), headers, body, timeoutMs)
      : this.postToPinnedAddress(url, target, headers, body, timeoutMs);
  }

  /**
   * Deliver one event to one endpoint with retry/backoff. Resolves with
   * the final DeliveryResult; never rejects (failures logged + returned).
   */
  async deliver(endpoint: WebhookEndpoint, ev: GrantChangedEvent): Promise<DeliveryResult> {
    const subscribe = endpoint.subscribe ?? DEFAULT_SUBSCRIBE;
    if (!subscribe.includes(ev.kind as typeof DEFAULT_SUBSCRIBE[number])) {
      return { endpointId: endpoint.id, url: endpoint.url, ok: true, attempts: 0, lastError: "skipped_by_subscription" };
    }
    const url = parseWebhookUrl(endpoint.url);
    if (!url) {
      const msg = "invalid_target_rejected";
      logger.warn(`Webhook ${endpoint.id} URL is not a credential-free HTTP(S) endpoint; rejecting`, "Webhooks");
      return { endpointId: endpoint.id, url: endpoint.url, ok: false, attempts: 0, lastError: msg };
    }
    // The private-target opt-in only relaxes private address checks. It never
    // allows another scheme, redirects, or credentials embedded in the URL.
    if (!this.allowPrivateTargets && isPrivateWebhookTarget(endpoint.url)) {
      const msg = "private_target_rejected";
      logger.warn(`Webhook ${endpoint.id} url targets a private/loopback/link-local address; rejecting`, "Webhooks");
      return { endpointId: endpoint.id, url: endpoint.url, ok: false, attempts: 0, lastError: msg };
    }
    const format = endpoint.format ?? detectFormat(endpoint.url);
    const payload = buildPayload(ev, format);
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(body)),
      "User-Agent": "mailpouch/1 (+https://github.com/chandshy/mailpouch)",
    };
    if (endpoint.secret) headers["X-Mailpouch-Signature-256"] = sign(body, endpoint.secret);

    let lastError = "";
    let status: number | undefined;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const deadline = Date.now() + this.attemptTimeoutMs;
        const remaining = () => {
          const timeoutMs = deadline - Date.now();
          if (timeoutMs <= 0) throw new Error("attempt_timeout");
          return timeoutMs;
        };
        const targets = await this.resolveTarget(url, remaining());
        // Cycle through validated answers between retries; each connection is
        // pinned to the chosen address rather than re-resolving its hostname.
        const target = targets[(attempt - 1) % targets.length];
        const res = await this.postWithTimeout(url, target, headers, body, remaining());
        status = res.status;
        if (res.status >= 300 && res.status < 400) {
          return { endpointId: endpoint.id, url: endpoint.url, ok: false, status, attempts: attempt, lastError: "redirect_rejected" };
        }
        if (res.ok) {
          return { endpointId: endpoint.id, url: endpoint.url, ok: true, status, attempts: attempt };
        }
        lastError = `HTTP ${res.status}`;
        // 4xx other than 408/429 is a permanent client error — stop retrying.
        if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
          return { endpointId: endpoint.id, url: endpoint.url, ok: false, status, attempts: attempt, lastError };
        }
      } catch (err) {
        lastError = (err as Error).message;
        if (lastError === "private_target_rejected") {
          logger.warn(`Webhook ${endpoint.id} hostname resolved to a private/reserved address; rejecting`, "Webhooks");
          return { endpointId: endpoint.id, url: endpoint.url, ok: false, attempts: attempt, lastError };
        }
      }
      if (attempt < MAX_ATTEMPTS) {
        const waitMs = jitter(Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS));
        await this.sleep(waitMs);
      }
    }
    logger.warn(`Webhook ${endpoint.id} exhausted ${MAX_ATTEMPTS} attempts: ${lastError}`, "Webhooks");
    return { endpointId: endpoint.id, url: endpoint.url, ok: false, status, attempts: MAX_ATTEMPTS, lastError };
  }

  /** Deliver to every enabled endpoint in parallel. Returns per-endpoint results. */
  async deliverAll(endpoints: WebhookEndpoint[], ev: GrantChangedEvent): Promise<DeliveryResult[]> {
    const active = endpoints.filter(e => e.enabled !== false);
    return Promise.all(active.map(e => this.deliver(e, ev)));
  }
}
