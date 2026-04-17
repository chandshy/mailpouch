/**
 * OAuth 2.1 authorization-server HTTP handlers for pm-bridge-mcp.
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
 * paste the admin password (the same value as remoteBearerToken — the
 * intent is to prove physical presence, not to model a full user base).
 *
 * Rate-limited through the shared TokenBucketLimiter (per client IP).
 */

import type { IncomingMessage, ServerResponse } from "http";
import { createHash, timingSafeEqual } from "crypto";
import { OAuthStore } from "./oauth-store.js";
import { TokenBucketLimiter } from "./rate-limit.js";
import { logger } from "../utils/logger.js";

const SCOPES = ["mcp:full"] as const;

export interface OAuthEndpointsConfig {
  /** Externally-visible base URL of the server, e.g. https://mcp.example.com. */
  issuer: string;
  /** Absolute URL for the /mcp endpoint — used in oauth-protected-resource. */
  resource: string;
  /** Admin password that gates the consent screen. */
  adminPassword: string;
}

/** Read entire request body as a string, parse as JSON or form-urlencoded. */
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
        const ctype = String(req.headers["content-type"] ?? "");
        if (ctype.includes("application/json")) {
          resolve(JSON.parse(raw) as Record<string, string>);
        } else if (ctype.includes("application/x-www-form-urlencoded")) {
          const params = new URLSearchParams(raw);
          const out: Record<string, string> = {};
          for (const [k, v] of params) out[k] = v;
          resolve(out);
        } else {
          // Best-effort: accept JSON even when Content-Type is missing (MCP clients sometimes omit it).
          resolve(JSON.parse(raw) as Record<string, string>);
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
  const a = Buffer.from(computed, "utf-8");
  const b = Buffer.from(challenge, "utf-8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Compare two strings in constant time, safe against length-leak. */
function safeEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  const aa = Buffer.from(a, "utf-8");
  const bb = Buffer.from(b, "utf-8");
  if (aa.length !== bb.length) {
    const pad = Buffer.alloc(bb.length);
    try { timingSafeEqual(pad, bb); } catch { /* ignore */ }
    return false;
  }
  return timingSafeEqual(aa, bb);
}

/** Client IP extraction — trust X-Forwarded-For only when the caller is loopback. */
function clientIp(req: IncomingMessage): string {
  const remote = req.socket.remoteAddress ?? "0.0.0.0";
  // Don't let arbitrary X-Forwarded-For headers bypass the rate limit.
  return remote;
}

export interface OAuthHandlerResult {
  /** True when the handler has already written a response. */
  handled: boolean;
}

export class OAuthHandlers {
  private readonly store: OAuthStore;
  private readonly cfg: OAuthEndpointsConfig;
  private readonly limiter: TokenBucketLimiter;
  private readonly onClientRegistered?: (c: { client_id: string; client_name?: string }) => void;

  constructor(
    store: OAuthStore,
    cfg: OAuthEndpointsConfig,
    limiter: TokenBucketLimiter,
    onClientRegistered?: (c: { client_id: string; client_name?: string }) => void,
  ) {
    this.store = store;
    this.cfg = cfg;
    this.limiter = limiter;
    this.onClientRegistered = onClientRegistered;
    if (!cfg.adminPassword) throw new Error("OAuth admin password is required");
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
      resource_name: "pm-bridge-mcp",
    });
    return { handled: true };
  }

  /** RFC 7591 Dynamic Client Registration. Public, no secret issued. */
  private async handleRegister(req: IncomingMessage, res: ServerResponse): Promise<OAuthHandlerResult> {
    let body: Record<string, unknown>;
    try { body = (await readBody(req)) as Record<string, unknown>; }
    catch { error(res, 400, "invalid_request", "Could not parse registration body."); return { handled: true }; }

    const uris = Array.isArray(body.redirect_uris) ? (body.redirect_uris as string[]) : [];
    if (uris.length === 0) { error(res, 400, "invalid_redirect_uri", "At least one redirect_uri is required."); return { handled: true }; }
    for (const u of uris) {
      try { new URL(u); } catch {
        error(res, 400, "invalid_redirect_uri", `redirect_uri ${u} is not a valid URL.`);
        return { handled: true };
      }
    }

    const client = this.store.registerClient({
      client_name: typeof body.client_name === "string" ? body.client_name : undefined,
      redirect_uris: uris,
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",      // Public client — PKCE is mandatory anyway
      scope: SCOPES.join(" "),
    });

    // Fire-and-forget: let the transport create the pending AgentGrant so
    // the user can approve in the settings UI. Handler errors are swallowed
    // — DCR itself succeeded and the caller should still get their client_id.
    try { this.onClientRegistered?.({ client_id: client.client_id, client_name: client.client_name }); }
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
    if (!codeChallenge || codeChallenge.length < 43) { error(res, 400, "invalid_request", "code_challenge missing or too short."); return { handled: true }; }

    const html = this.consentPage({
      clientId,
      clientName: client.client_name ?? "(unnamed client)",
      redirectUri,
      codeChallenge,
      state,
      resource,
      scope,
    });
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(html);
    return { handled: true };
  }

  /** Consent form POST — validates admin password, mints code, 302s back to redirect_uri. */
  private async handleAuthorizePost(req: IncomingMessage, res: ServerResponse): Promise<OAuthHandlerResult> {
    let body: Record<string, string>;
    try { body = await readBody(req); }
    catch { error(res, 400, "invalid_request", "Could not parse form body."); return { handled: true }; }

    if (!safeEqual(body.admin_password ?? "", this.cfg.adminPassword)) {
      error(res, 403, "access_denied", "Incorrect admin password.");
      return { handled: true };
    }

    const client = this.store.getClient(body.client_id ?? "");
    if (!client) { error(res, 400, "invalid_client", "Unknown client_id."); return { handled: true }; }
    const redirectUri = body.redirect_uri ?? "";
    if (!client.redirect_uris.includes(redirectUri)) { error(res, 400, "invalid_redirect_uri"); return { handled: true }; }

    const rec = this.store.issueAuthCode({
      clientId: client.client_id,
      redirectUri,
      codeChallenge: body.code_challenge ?? "",
      codeChallengeMethod: "S256",
      scopes: (body.scope ?? SCOPES.join(" ")).split(/\s+/).filter(Boolean),
      resource: body.resource || undefined,
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
    catch { error(res, 400, "invalid_request", "Could not parse token body."); return { handled: true }; }

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

    const auth = this.store.consumeAuthCode(code);
    if (!auth) { error(res, 400, "invalid_grant", "Unknown or expired authorization code."); return { handled: true }; }
    if (auth.clientId !== clientId) { error(res, 400, "invalid_grant", "client_id does not match the issued code."); return { handled: true }; }
    if (auth.redirectUri !== redirectUri) { error(res, 400, "invalid_grant", "redirect_uri does not match the issued code."); return { handled: true }; }
    if (!verifyPkceS256(verifier, auth.codeChallenge)) { error(res, 400, "invalid_grant", "PKCE verification failed."); return { handled: true }; }
    // Resource Indicators (RFC 8707): if the request included `resource`, it
    // must match the one from authorize; if neither set one, we accept it.
    if (resource && auth.resource && resource !== auth.resource) {
      error(res, 400, "invalid_target", "resource does not match the authorization request.");
      return { handled: true };
    }

    const issued = this.store.issueToken({
      clientId: auth.clientId,
      scopes: auth.scopes,
      resource: auth.resource ?? resource,
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
    catch { error(res, 400, "invalid_request"); return { handled: true }; }
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
  }): string {
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action 'self'">
    <title>pm-bridge-mcp — authorize</title>
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
      <h1>Authorize pm-bridge-mcp</h1>
      <p>An MCP client is requesting access to your Proton Mail via this server.</p>
      <dl>
        <dt>Client</dt><dd>${esc(ctx.clientName)} (${esc(ctx.clientId)})</dd>
        <dt>Will redirect to</dt><dd>${esc(ctx.redirectUri)}</dd>
        <dt>Scopes</dt><dd>${esc(ctx.scope)}</dd>
        ${ctx.resource ? `<dt>Resource</dt><dd>${esc(ctx.resource)}</dd>` : ""}
      </dl>
      <form method="POST" action="/oauth/authorize">
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
