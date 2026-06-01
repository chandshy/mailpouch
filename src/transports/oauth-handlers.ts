/**
 * OAuth 2.1 authorization-server HTTP handlers for mailpouch.
 *
 * Implements the surface required by the 2025-11-25 MCP spec for an
 * authenticated remote deployment:
 *
 *   GET  /.well-known/oauth-authorization-server  — RFC 8414 metadata
 *   GET  /.well-known/oauth-protected-resource    — RFC 9728 metadata
 *   POST /oauth/register                          — RFC 7591 DCR
 *   GET  /oauth/authorize                         — consent page
 *   POST /oauth/authorize                         — consent submission
 *   POST /oauth/token                             — code exchange (PKCE)
 *   POST /oauth/revoke                            — token revocation
 *
 * The "consent page" is a single minimal HTML form that asks the user to
 * paste the admin password — a value distinct from remoteBearerToken,
 * configured separately as remoteOauthAdminPassword. The intent is to
 * prove physical presence, not to model a full user base. Do NOT reuse
 * the bearer token here: a single shared secret across both auth modes
 * means compromise of one path compromises both.
 *
 * Rate-limited through the shared TokenBucketLimiter (per client IP).
 */

import type { IncomingMessage, ServerResponse } from "http";
import { createHash, createHmac, randomBytes } from "crypto";
import { OAuthStore } from "./oauth-store.js";
import { TokenBucketLimiter } from "./rate-limit.js";
import { clientIp } from "./http.js";
import { logger } from "../utils/logger.js";
import { constantTimeEqual } from "../utils/crypto.js";

const SCOPES = ["mcp:full"] as const;

/** XPORT-002 max client_name length on the DCR registration record. */
const DCR_CLIENT_NAME_MAX = 100;

/** RFC 7636 §4.2 code_challenge shape — base64url, 43–128 chars. */
const CODE_CHALLENGE_RE = /^[A-Za-z0-9_\-.~]{43,128}$/;

/** XPORT-016: printable-ASCII guard for the OAuth `state` parameter. */
const STATE_PRINTABLE_RE = /^[\x20-\x7E]*$/;

/**
 * XPORT-017: RFC 8707 resource indicators must be an absolute http(s) URI. An
 * empty / malformed value was previously normalised to `undefined`, which made
 * the per-token resource binding a no-op (the verifier short-circuits when
 * `rec.resource` is falsy), so a token issued without `resource` could be
 * replayed against any MCP endpoint on the same host. Returns the parsed
 * absolute URL string, or null when absent/invalid.
 */
function normalizeResource(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * XPORT-009: redirect_uri scheme allowlist. The DCR endpoint is public, so a
 * `new URL(u)` parse alone accepts `javascript:`, `data:`, `file:` and any
 * custom scheme; those then land in a 302 `Location:` after consent. We permit
 * exactly the OAuth 2.1 native-apps BCP set:
 *   - https (any host)
 *   - http ONLY for loopback (localhost / 127.0.0.1 / ::1) — RFC 8252 §7.3
 *   - a custom (reverse-DNS) private-use scheme for native apps, RFC 8252 §7.1
 * Everything else (javascript:/data:/file:/ftp:/…) is rejected.
 */
function isAllowedRedirectUri(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol === "https:") return true;
  if (u.protocol === "http:") {
    const h = u.hostname.toLowerCase();
    return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]";
  }
  // Private-use / custom native-app scheme (e.g. "com.example.app:/cb").
  // Reject the dangerous well-knowns explicitly; require a reverse-DNS-style
  // scheme containing a dot so a bare "evil:" can't slip through.
  const scheme = u.protocol.replace(/:$/, "");
  if (scheme === "javascript" || scheme === "data" || scheme === "file" || scheme === "blob" || scheme === "vbscript") return false;
  return /^[a-z][a-z0-9+.-]*\.[a-z][a-z0-9+.-]*$/.test(scheme);
}

/**
 * Strip control characters / ANSI escapes and length-cap a DCR-supplied
 * client_name (XPORT-002 from the 2026-05-28 audit). Exported for tests
 * — production callers go through `handleRegister` which uses it inline.
 * Returns undefined for empty/missing input so the consent page falls
 * back to "(unnamed client)" rather than rendering an empty string.
 */
export function sanitizeDcrClientName(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  // Order matters: try the ANSI escape sequence first so a leading `\x1b`
  // followed by `[NN m`-style payload consumes the whole sequence. The
  // bare control-char class catches the rest (NUL, BEL, DEL, lone ESC).
  const cleaned = raw
    .replace(/\x1b\[[0-9;]*[a-zA-Z]|[\x00-\x1f\x7f]/g, "")
    .trim()
    .slice(0, DCR_CLIENT_NAME_MAX);
  return cleaned || undefined;
}

export interface OAuthEndpointsConfig {
  /** Externally-visible base URL of the server, e.g. https://mcp.example.com. */
  issuer: string;
  /** Absolute URL for the /mcp endpoint — used in oauth-protected-resource. */
  resource: string;
  /** Admin password that gates the consent screen. */
  adminPassword: string;
}

/** Read entire request body as a string, parse as JSON or form-urlencoded. */
/**
 * Parse an OAuth endpoint body according to RFC 6749 / 7591 / 7009 —
 * which means *either* form-encoded *or* JSON, never guess. A missing
 * Content-Type is an RFC violation; we reject with an `Error("unsupported_media_type")`
 * that the caller maps to HTTP 415. This replaces an earlier best-effort
 * fallback that was too permissive for a standards-compliance gate.
 */
async function readBody(req: IncomingMessage, maxBytes = 65_536): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", c => {
      size += c.length;
      if (size > maxBytes) { req.destroy(); reject(new Error("body_too_large")); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      if (chunks.length === 0) { resolve({}); return; }
      try {
        const raw = Buffer.concat(chunks).toString("utf-8");
        const ctype = String(req.headers["content-type"] ?? "").toLowerCase();
        if (ctype.includes("application/json")) {
          resolve(JSON.parse(raw) as Record<string, string>);
        } else if (ctype.includes("application/x-www-form-urlencoded")) {
          const params = new URLSearchParams(raw);
          const out: Record<string, string> = {};
          for (const [k, v] of params) out[k] = v;
          resolve(out);
        } else {
          reject(new Error("unsupported_media_type"));
        }
      } catch (err) { reject(err); }
    });
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function error(res: ServerResponse, status: number, error: string, description?: string): void {
  json(res, status, { error, ...(description ? { error_description: description } : {}) });
}

/** PKCE S256 verification: base64url(sha256(verifier)) must equal challenge. */
function verifyPkceS256(verifier: string, challenge: string): boolean {
  const computed = createHash("sha256").update(verifier, "utf-8").digest("base64url");
  return constantTimeEqual(computed, challenge);
}

// Constant-time string compare imported from ../utils/crypto.
const safeEqual = constantTimeEqual;

export interface OAuthHandlerResult {
  /** True when the handler has already written a response. */
  handled: boolean;
}

export class OAuthHandlers {
  private readonly store: OAuthStore;
  private readonly cfg: OAuthEndpointsConfig;
  private readonly limiter: TokenBucketLimiter;
  private readonly onClientRegistered?: (c: { client_id: string; client_name?: string; ip?: string }) => void;
  /** Extracts the caller IP from a request (injected to avoid importing http.ts
   *  here, which would create an import cycle). */
  private readonly ipExtractor?: (req: IncomingMessage) => string;
  /**
   * XPORT-008: per-process secret used to HMAC the consent CSRF token. The
   * token has no server-side state — it is `HMAC(client_id)` minted by the GET
   * consent page and required (constant-time compared) on the POST. A
   * cross-site form on attacker.local cannot read the GET response to learn the
   * token, so it cannot forge a valid submission even if it knows the password.
   */
  private readonly csrfSecret = randomBytes(32);

  constructor(
    store: OAuthStore,
    cfg: OAuthEndpointsConfig,
    limiter: TokenBucketLimiter,
    onClientRegistered?: (c: { client_id: string; client_name?: string; ip?: string }) => void,
    ipExtractor?: (req: IncomingMessage) => string,
  ) {
    this.store = store;
    this.cfg = cfg;
    this.limiter = limiter;
    this.onClientRegistered = onClientRegistered;
    this.ipExtractor = ipExtractor;
    if (!cfg.adminPassword) throw new Error("OAuth admin password is required");
  }

  /** XPORT-008: mint a CSRF token bound to the client_id of this consent flow. */
  private mintCsrfToken(clientId: string): string {
    return createHmac("sha256", this.csrfSecret).update(clientId).digest("base64url");
  }

  /** XPORT-008: constant-time verify a CSRF token against the expected client_id. */
  private verifyCsrfToken(token: string, clientId: string): boolean {
    return constantTimeEqual(token, this.mintCsrfToken(clientId));
  }

  /**
   * XPORT-008: reject state-changing POSTs whose Origin is cross-site. The
   * consent form is same-origin (`form-action 'self'`); a present Origin that
   * doesn't match the issuer means a cross-site submission. A missing Origin is
   * allowed through (some same-origin form posts omit it) — the CSRF token is
   * the primary defence; the Origin check is belt-and-suspenders.
   */
  private originAllowed(req: IncomingMessage): boolean {
    const origin = req.headers["origin"];
    if (!origin || typeof origin !== "string") return true;
    return origin === this.cfg.issuer;
  }

  /**
   * Dispatch an HTTP request to the right OAuth endpoint. Returns
   * `{ handled: true }` when we owned the response; false lets the caller
   * fall through to the MCP endpoint.
   */
  async dispatch(req: IncomingMessage, res: ServerResponse, url: URL): Promise<OAuthHandlerResult> {
    // Rate-limit every OAuth touchpoint per client IP. Generous bucket —
    // MCP hosts do bursty probing on connect.
    const ip = clientIp(req);
    if (!this.limiter.take(`oauth:${ip}`)) {
      error(res, 429, "rate_limited", "Too many OAuth requests from this client.");
      return { handled: true };
    }

    const path = url.pathname;
    try {
      if (req.method === "GET"  && path === "/.well-known/oauth-authorization-server") return await this.serveAuthServerMetadata(res);
      if (req.method === "GET"  && path === "/.well-known/oauth-protected-resource")  return await this.serveProtectedResourceMetadata(res);
      if (req.method === "POST" && path === "/oauth/register")   return await this.handleRegister(req, res);
      if (req.method === "GET"  && path === "/oauth/authorize")  return await this.handleAuthorizeGet(req, res, url);
      if (req.method === "POST" && path === "/oauth/authorize")  return await this.handleAuthorizePost(req, res);
      if (req.method === "POST" && path === "/oauth/token")      return await this.handleToken(req, res);
      if (req.method === "POST" && path === "/oauth/revoke")     return await this.handleRevoke(req, res);
    } catch (err: unknown) {
      logger.error(`OAuth handler failed for ${req.method} ${path}`, "OAuth", err);
      if (!res.headersSent) error(res, 500, "server_error");
      return { handled: true };
    }
    return { handled: false };
  }

  /** RFC 8414 §3 — Authorization Server Metadata. */
  private async serveAuthServerMetadata(res: ServerResponse): Promise<OAuthHandlerResult> {
    json(res, 200, {
      issuer: this.cfg.issuer,
      authorization_endpoint: `${this.cfg.issuer}/oauth/authorize`,
      token_endpoint: `${this.cfg.issuer}/oauth/token`,
      registration_endpoint: `${this.cfg.issuer}/oauth/register`,
      revocation_endpoint: `${this.cfg.issuer}/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: SCOPES,
    });
    return { handled: true };
  }

  /** RFC 9728 — Protected Resource Metadata. */
  private async serveProtectedResourceMetadata(res: ServerResponse): Promise<OAuthHandlerResult> {
    json(res, 200, {
      resource: this.cfg.resource,
      authorization_servers: [this.cfg.issuer],
      scopes_supported: SCOPES,
      bearer_methods_supported: ["header"],
      resource_name: "mailpouch",
    });
    return { handled: true };
  }

  /** RFC 7591 Dynamic Client Registration. Public, no secret issued. */
  private async handleRegister(req: IncomingMessage, res: ServerResponse): Promise<OAuthHandlerResult> {
    let body: Record<string, unknown>;
    try { body = (await readBody(req)) as Record<string, unknown>; }
    catch (err) {
      const msg = (err as Error).message;
      if (msg === "unsupported_media_type") { error(res, 415, "invalid_request", "Content-Type must be application/json or application/x-www-form-urlencoded."); return { handled: true }; }
      error(res, 400, "invalid_request", "Could not parse registration body."); return { handled: true };
    }

    const uris = Array.isArray(body.redirect_uris) ? (body.redirect_uris as string[]) : [];
    if (uris.length === 0) { error(res, 400, "invalid_redirect_uri", "At least one redirect_uri is required."); return { handled: true }; }
    for (const u of uris) {
      // XPORT-009: parse AND scheme-allowlist. `new URL` alone accepts
      // javascript:/data:/file: and arbitrary schemes that would later be
      // emitted in a 302 Location after consent.
      if (typeof u !== "string" || !isAllowedRedirectUri(u)) {
        error(res, 400, "invalid_redirect_uri", `redirect_uri ${u} uses an unsupported scheme. Allowed: https, http loopback, or a custom native-app scheme.`);
        return { handled: true };
      }
    }

    // XPORT-002 (audit 2026-05-28): the DCR endpoint is public and
    // unauthenticated, so client_name is fully attacker-controlled. An
    // attacker who can reach the OAuth endpoints (the whole point of
    // remote mode) registers a client called "Claude Desktop" or
    // "mailpouch internal" and a redirect_uri of "https://attacker..." —
    // the consent screen then renders that familiar name and a human
    // admin types the admin password. Length-cap + strip control chars
    // at registration; the consent page additionally shows an
    // "Untrusted client" badge for every DCR-registered name.
    const sanitizedName = sanitizeDcrClientName(
      typeof body.client_name === "string" ? body.client_name : undefined,
    );
    const client = this.store.registerClient({
      client_name: sanitizedName,
      redirect_uris: uris,
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",      // Public client — PKCE is mandatory anyway
      scope: SCOPES.join(" "),
    });

    // Fire-and-forget: let the transport create the pending AgentGrant so
    // the user can approve in the settings UI. Handler errors are swallowed
    // — DCR itself succeeded and the caller should still get their client_id.
    try {
      const ip = this.ipExtractor?.(req);
      this.onClientRegistered?.({ client_id: client.client_id, client_name: client.client_name, ip });
    }
    catch (hookErr) { logger.warn("onClientRegistered hook threw (non-fatal)", "OAuth", hookErr); }

    json(res, 201, client);
    return { handled: true };
  }

  /** Consent page — returns a small HTML form rather than a redirect. */
  private async handleAuthorizeGet(req: IncomingMessage, res: ServerResponse, url: URL): Promise<OAuthHandlerResult> {
    const params = url.searchParams;
    const clientId = params.get("client_id") ?? "";
    const redirectUri = params.get("redirect_uri") ?? "";
    const codeChallenge = params.get("code_challenge") ?? "";
    const method = params.get("code_challenge_method") ?? "";
    const state = params.get("state") ?? "";
    const resource = params.get("resource") ?? "";
    const scope = params.get("scope") ?? SCOPES.join(" ");

    const client = this.store.getClient(clientId);
    if (!client) { error(res, 400, "invalid_client", "Unknown client_id. Register first at /oauth/register."); return { handled: true }; }
    if (!redirectUri || !client.redirect_uris.includes(redirectUri)) {
      error(res, 400, "invalid_redirect_uri", "redirect_uri does not match a registered URI.");
      return { handled: true };
    }
    if (method !== "S256") { error(res, 400, "invalid_request", "PKCE S256 is required."); return { handled: true }; }
    if (state.length > 500) { error(res, 400, "invalid_request", "state parameter exceeds 500 chars."); return { handled: true }; }
    // XPORT-016: reject control / non-ASCII characters in `state`. It is echoed
    // back in the redirect and into whatever the client uses to look it up; a
    // CRLF / NUL-laced value has no legitimate use.
    if (!STATE_PRINTABLE_RE.test(state)) { error(res, 400, "invalid_request", "state contains non-printable characters."); return { handled: true }; }
    // RFC 7636 §4.2: code_challenge is base64url(SHA256(verifier)), which is
    // exactly 43 chars of URL-safe alphabet. Reject anything longer or with
    // non-base64url characters.
    if (!CODE_CHALLENGE_RE.test(codeChallenge)) {
      error(res, 400, "invalid_request", "code_challenge must be 43–128 chars of base64url alphabet.");
      return { handled: true };
    }

    // XPORT-002: every DCR-registered client is, by definition, untrusted
    // until an admin has reviewed it. Mark on the consent payload so the
    // page can render a visible badge. Token-endpoint-auth-method "none"
    // is the canonical signal — pre-trusted clients (none today, but
    // future-proofing) would auth differently.
    const isUntrustedDcrClient = client.token_endpoint_auth_method === "none";
    const html = this.consentPage({
      clientId,
      clientName: client.client_name ?? "(unnamed client)",
      redirectUri,
      codeChallenge,
      state,
      resource,
      scope,
      isUntrustedDcrClient,
      csrfToken: this.mintCsrfToken(clientId),
    });
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    // XPORT-003: clickjacking protection on the consent screen. `frame-ancestors`
    // is honoured only when CSP arrives as an HTTP header (it is ignored in a
    // `<meta http-equiv>` tag), so we send the policy as a real response header
    // here; X-Frame-Options: DENY covers legacy browsers that predate CSP2.
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
    );
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.end(html);
    return { handled: true };
  }

  /** Consent form POST — validates admin password, mints code, 302s back to redirect_uri. */
  private async handleAuthorizePost(req: IncomingMessage, res: ServerResponse): Promise<OAuthHandlerResult> {
    let body: Record<string, string>;
    try { body = await readBody(req); }
    catch (err) {
      const msg = (err as Error).message;
      if (msg === "unsupported_media_type") { error(res, 415, "invalid_request", "Content-Type must be application/x-www-form-urlencoded."); return { handled: true }; }
      error(res, 400, "invalid_request", "Could not parse form body."); return { handled: true };
    }

    // XPORT-008: reject cross-site submissions and forged posts before the
    // password is even examined. The CSRF token is bound to client_id and was
    // minted by the GET consent page; a cross-site context cannot read it.
    const clientId = body.client_id ?? "";
    if (!this.originAllowed(req)) {
      error(res, 403, "access_denied", "Cross-site form submission rejected.");
      return { handled: true };
    }
    if (!this.verifyCsrfToken(body.csrf_token ?? "", clientId)) {
      error(res, 403, "access_denied", "Missing or invalid CSRF token. Reload the consent page.");
      return { handled: true };
    }

    if (!safeEqual(body.admin_password ?? "", this.cfg.adminPassword)) {
      error(res, 403, "access_denied", "Incorrect admin password.");
      return { handled: true };
    }

    const client = this.store.getClient(clientId);
    if (!client) { error(res, 400, "invalid_client", "Unknown client_id."); return { handled: true }; }
    const redirectUri = body.redirect_uri ?? "";
    if (!client.redirect_uris.includes(redirectUri)) { error(res, 400, "invalid_redirect_uri"); return { handled: true }; }

    // XPORT-007: re-run the same format checks the GET handler enforced. A
    // direct POST (bypassing the consent GET) must not be able to mint a code
    // with an empty/malformed/plain challenge or an oversized state.
    const method = body.code_challenge_method ?? "S256";
    if (method !== "S256") { error(res, 400, "invalid_request", "PKCE S256 is required."); return { handled: true }; }
    const codeChallenge = body.code_challenge ?? "";
    if (!CODE_CHALLENGE_RE.test(codeChallenge)) {
      error(res, 400, "invalid_request", "code_challenge must be 43–128 chars of base64url alphabet.");
      return { handled: true };
    }
    if (body.state && body.state.length > 500) { error(res, 400, "invalid_request", "state parameter exceeds 500 chars."); return { handled: true }; }
    if (body.state && !STATE_PRINTABLE_RE.test(body.state)) { error(res, 400, "invalid_request", "state contains non-printable characters."); return { handled: true }; }

    // XPORT-017: bind every issued code to a resource. A caller-supplied
    // `resource` must be a valid absolute http(s) URI; an absent / malformed
    // one defaults to this server's canonical resource so the per-token check
    // is never silently skipped.
    let resource: string;
    if (body.resource) {
      const parsed = normalizeResource(body.resource);
      if (!parsed) { error(res, 400, "invalid_target", "resource must be an absolute http(s) URI."); return { handled: true }; }
      resource = parsed;
    } else {
      resource = this.cfg.resource;
    }

    const rec = this.store.issueAuthCode({
      clientId: client.client_id,
      redirectUri,
      codeChallenge,
      codeChallengeMethod: "S256",
      scopes: (body.scope ?? SCOPES.join(" ")).split(/\s+/).filter(Boolean),
      resource,
      state: body.state,
    });

    const redirect = new URL(redirectUri);
    redirect.searchParams.set("code", rec.code);
    if (rec.state) redirect.searchParams.set("state", rec.state);
    res.statusCode = 302;
    res.setHeader("Location", redirect.toString());
    res.setHeader("Cache-Control", "no-store");
    res.end();
    return { handled: true };
  }

  /** Token endpoint — exchanges auth code for access token under PKCE. */
  private async handleToken(req: IncomingMessage, res: ServerResponse): Promise<OAuthHandlerResult> {
    let body: Record<string, string>;
    try { body = await readBody(req); }
    catch (err) {
      const msg = (err as Error).message;
      if (msg === "unsupported_media_type") { error(res, 415, "invalid_request", "Token endpoint requires Content-Type: application/x-www-form-urlencoded (RFC 6749)."); return { handled: true }; }
      error(res, 400, "invalid_request", "Could not parse token body."); return { handled: true };
    }

    const grantType = body.grant_type ?? "";
    if (grantType !== "authorization_code") {
      error(res, 400, "unsupported_grant_type", `Only authorization_code is supported; got ${grantType}.`);
      return { handled: true };
    }

    const code = body.code ?? "";
    const verifier = body.code_verifier ?? "";
    const clientId = body.client_id ?? "";
    const redirectUri = body.redirect_uri ?? "";
    const resource = body.resource || undefined;

    // Validate verifier shape per RFC 7636 §4.1 before hashing — rejects
    // 1-char verifiers and other malformed input that would otherwise
    // produce a valid SHA256 against a precomputed challenge.
    if (!/^[A-Za-z0-9_\-.~]{43,128}$/.test(verifier)) {
      error(res, 400, "invalid_grant", "Invalid authorization code.");
      return { handled: true };
    }
    const auth = this.store.consumeAuthCode(code);
    // Collapse all code-validation failures into a single opaque error so an
    // attacker can't distinguish "unknown code" from "wrong client" from
    // "wrong redirect_uri" from "PKCE failed" via error-string enumeration.
    if (!auth
      || auth.clientId !== clientId
      || auth.redirectUri !== redirectUri
      || !verifyPkceS256(verifier, auth.codeChallenge)) {
      error(res, 400, "invalid_grant", "Invalid authorization code.");
      return { handled: true };
    }
    // Resource Indicators (RFC 8707): if the request included `resource`, it
    // must match the one bound at authorize time.
    // XPORT-004: collapse the mismatch into the same opaque `invalid_grant` the
    // code/client/redirect/PKCE failures above use. Returning the distinguishable
    // `invalid_target` only after the code+PKCE validated made it a
    // confirmed-good-code oracle (an attacker learned the code was valid up to
    // that point).
    if (resource && auth.resource && resource !== auth.resource) {
      error(res, 400, "invalid_grant", "Invalid authorization code.");
      return { handled: true };
    }

    const issued = this.store.issueToken({
      clientId: auth.clientId,
      scopes: auth.scopes,
      resource: auth.resource ?? resource,
      issuedFromIp: clientIp(req),
    });

    json(res, 200, {
      access_token: issued.token,
      token_type: "Bearer",
      expires_in: Math.floor((issued.expiresAt - Date.now()) / 1000),
      scope: issued.scopes.join(" "),
    });
    return { handled: true };
  }

  private async handleRevoke(req: IncomingMessage, res: ServerResponse): Promise<OAuthHandlerResult> {
    let body: Record<string, string>;
    try { body = await readBody(req); }
    catch (err) {
      const msg = (err as Error).message;
      if (msg === "unsupported_media_type") { error(res, 415, "invalid_request", "Revocation endpoint requires application/x-www-form-urlencoded (RFC 7009)."); return { handled: true }; }
      error(res, 400, "invalid_request"); return { handled: true };
    }
    const token = body.token ?? "";
    // RFC 7009: respond 200 regardless of whether the token existed.
    this.store.revokeToken(token);
    res.statusCode = 200;
    res.end();
    return { handled: true };
  }

  /** Simple consent HTML with CSP to block script injection via reflected params. */
  private consentPage(ctx: {
    clientId: string;
    clientName: string;
    redirectUri: string;
    codeChallenge: string;
    state: string;
    resource: string;
    scope: string;
    isUntrustedDcrClient?: boolean;
    csrfToken: string;
  }): string {
    // Strict 5-replacement HTML escape — handles both attribute-context
    // and body-text contexts safely. The previous 3-replacement form
    // missed `>` and `'` which is fine for attribute values quoted with
    // `"`, but our DD/DT body cells render text directly. Audit-aligned
    // with `escHtml` used in src/settings/shell.ts.
    const esc = (s: string) => s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'">
    <title>mailpouch — authorize</title>
    <style>
      body { font-family: system-ui, sans-serif; background: #111; color: #eee; margin: 0; padding: 40px; }
      .card { max-width: 480px; margin: 0 auto; background: #1b1b1e; padding: 24px; border-radius: 12px; }
      h1 { font-size: 18px; margin: 0 0 12px; }
      p { font-size: 14px; line-height: 1.45; color: #bbb; }
      dl { font-size: 13px; color: #888; }
      dt { margin-top: 10px; }
      dd { margin: 0 0 0 0; color: #ccc; font-family: ui-monospace, monospace; word-break: break-all; }
      label { display: block; font-size: 13px; margin-top: 16px; }
      input[type=password] { width: 100%; padding: 8px 10px; margin-top: 6px; background: #222; color: #eee; border: 1px solid #444; border-radius: 6px; box-sizing: border-box; }
      button { margin-top: 16px; background: #6D4AFF; color: white; border: 0; padding: 10px 18px; border-radius: 6px; cursor: pointer; font-size: 14px; }
      button.ghost { background: transparent; color: #888; margin-left: 8px; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Authorize mailpouch</h1>
      <p>An MCP client is requesting access to your Proton Mail via this server.</p>${ctx.isUntrustedDcrClient ? `
      <p style="background:#5a1d1d; color:#ffd8d8; padding:10px 12px; border-radius:6px; font-size:13px; line-height:1.4;">
        <strong>⚠ Untrusted client.</strong> This client registered itself via the public
        <code>/oauth/register</code> endpoint and chose its own display name. Treat the
        name shown below as attacker-controlled. Verify the redirect URI matches a host
        you trust before entering the admin password.
      </p>` : ""}
      <dl>
        <dt>Client</dt><dd>${esc(ctx.clientName)} (${esc(ctx.clientId)})</dd>
        <dt>Will redirect to</dt><dd>${esc(ctx.redirectUri)}</dd>
        <dt>Scopes</dt><dd>${esc(ctx.scope)}</dd>
        ${ctx.resource ? `<dt>Resource</dt><dd>${esc(ctx.resource)}</dd>` : ""}
      </dl>
      <form method="POST" action="/oauth/authorize">
        <input type="hidden" name="csrf_token" value="${esc(ctx.csrfToken)}">
        <input type="hidden" name="client_id" value="${esc(ctx.clientId)}">
        <input type="hidden" name="redirect_uri" value="${esc(ctx.redirectUri)}">
        <input type="hidden" name="code_challenge" value="${esc(ctx.codeChallenge)}">
        <input type="hidden" name="state" value="${esc(ctx.state)}">
        <input type="hidden" name="resource" value="${esc(ctx.resource)}">
        <input type="hidden" name="scope" value="${esc(ctx.scope)}">
        <label>
          Admin password
          <input type="password" name="admin_password" autofocus required>
        </label>
        <button type="submit">Approve</button>
      </form>
    </div>
  </body>
</html>`;
  }
}
