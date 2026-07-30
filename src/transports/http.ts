/**
 * HTTP transport for mailpouch (remote / self-host mode).
 *
 * Spec reference: https://modelcontextprotocol.io/specification/2025-11-25
 *
 * Auth is OAuth 2.1 only — there is no shared static bearer. Every caller
 * authenticates as its OWN client, so a token always maps to a specific,
 * gated, revocable agent identity (per-agent grant + audit). Two grant types
 * share the one listener:
 *
 *   1. **authorization_code + PKCE** — interactive agents. RFC 7591 Dynamic
 *      Client Registration + RFC 8414 / 9728 metadata + PKCE S256 + RFC 8707
 *      resource indicators. Consent is automatic; the only human gate is the
 *      per-agent Approve/Deny in the Agents tab (no admin password). The token
 *      is inert until the operator approves the grant.
 *
 *   2. **client_credentials** — headless / unattended agents (cron, CI). The
 *      operator issues a service account out-of-band (`mailpouch agent issue`
 *      or the Settings UI); the agent logs in with its own client_id +
 *      client_secret. The grant is pre-approved at issuance, so no interactive
 *      consent is needed, yet GrantManager still gates every tool call.
 *
 * Every unauthenticated path is rate-limited per IP. The authed /mcp
 * endpoint is rate-limited per token key so a compromised token can't
 * DoS Bridge.
 *
 * Requests without a valid credential get 401 with a `WWW-Authenticate`
 * header per RFC 6750.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { createServer as createSecureServer } from "https";
import { readFileSync } from "fs";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createHash, randomUUID } from "crypto";
import type { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { logger } from "../utils/logger.js";
import { OAuthStore } from "./oauth-store.js";
import { OAuthHandlers } from "./oauth-handlers.js";
import { TokenBucketLimiter } from "./rate-limit.js";
import { grantHasExpired, isServiceAccountGrant, type AgentGrantStore } from "../agents/grant-store.js";
import type { ServiceAccountStore } from "../agents/service-account-store.js";
import { notifications } from "../agents/notifications.js";
import { runWithCaller } from "../agents/caller-context.js";

export interface HttpTransportOptions {
  /** MCP server instance to wire the transport into (fallback for single-session use). */
  server: McpServer;
  /**
   * Factory that builds a fresh MCP server with all handlers registered. The
   * MCP SDK binds one Server to one transport, so each client session needs its
   * own Server. When provided, a new Server + transport pair is created per
   * session (keyed by Mcp-Session-Id). When omitted, falls back to a single
   * shared `server` (only safe for one session at a time).
   */
  createServer?: () => McpServer;
  /** Bind host. Default 127.0.0.1 (localhost-only). Use 0.0.0.0 for LAN exposure. */
  host?: string;
  /** Port to listen on. */
  port: number;
  /** Path where the MCP endpoint lives. Default /mcp. */
  path?: string;
  /** Optional TLS cert/key paths for HTTPS. If omitted, serves over plain HTTP. */
  tlsCertPath?: string;
  tlsKeyPath?: string;
  /** Enable OAuth 2.1 authorization-server endpoints alongside the static bearer. */
  oauthEnabled?: boolean;
  /** Externally-visible issuer URL. When omitted we derive it from the bind host/port. */
  oauthIssuer?: string;
  /** Requests per second per client for rate limiting (default 20). */
  rateLimitPerSecond?: number;
  /** Burst size (default 40). */
  rateLimitBurst?: number;
  /**
   * Optional grant store to wire into DCR + authed tool calls. When set,
   * each new DCR client gets a pending AgentGrant, and the caller-context
   * dispatched to the MCP handler carries the client_id so the tool
   * dispatcher can consult per-agent permissions. When omitted, the
   * transport behaves as before (bearer-only, no per-agent gating).
   */
  agentGrants?: AgentGrantStore;
  /**
   * Persisted service accounts (client_credentials grant). When set, each is
   * registered into the OAuth client table (for name display) and the token
   * endpoint accepts the client_credentials grant verified against this store.
   * Their matching active AgentGrant is ensured by the caller at startup.
   */
  serviceAccounts?: ServiceAccountStore;
  /**
   * Optional path for persisting issued OAuth access-token hashes so they
   * survive a daemon restart (field finding #7). Only hashes + metadata are
   * written (0600) — never raw bearers. When omitted, tokens are in-memory only.
   */
  oauthTokensPath?: string;
}

export interface HttpTransportHandle {
  /** URL of the MCP endpoint (http[s]://host:port/mcp). */
  url: string;
  /** OAuth issuer URL, present when OAuth is enabled. */
  issuer?: string;
  /** Stop accepting new connections and close existing ones. */
  close: () => Promise<void>;
}

function extractBearer(req: IncomingMessage): string | null {
  const raw = req.headers["authorization"];
  if (!raw || typeof raw !== "string") return null;
  // XPORT-014: match RFC 6750 §2.1 exactly — one SP between "Bearer" and the
  // token, optional trailing whitespace. The earlier `\s+` + `trimEnd()` form
  // accepted tabs/multiple spaces between the scheme and token but rejected a
  // trailing space, an inconsistency that masked malformed clients.
  const m = /^Bearer ([^\s]+)\s*$/i.exec(raw);
  return m ? m[1] : null;
}

/**
 * XPORT-011: defence-in-depth security headers, mirroring the set the settings
 * server applies. Applied on every transport response so a JSON / 401 / 404
 * body can't be sniffed, framed, or cached by an intermediary.
 */
function setSecurityHeaders(res: ServerResponse): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
}

async function readJsonBody(req: IncomingMessage, maxBytes = 1_048_576): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error(`Request body exceeds ${maxBytes} bytes`));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (chunks.length === 0) { resolve(null); return; }
      try {
        const text = Buffer.concat(chunks).toString("utf-8");
        resolve(text ? JSON.parse(text) : null);
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

/**
 * Return the caller IP. Trusts `X-Forwarded-For` ONLY when the direct
 * peer is loopback — matches the comment in oauth-handlers.ts and makes
 * the `ipPins` grant condition usable behind a local reverse proxy
 * (Caddy, nginx, Cloudflare Tunnel).
 *
 * XFF is comma-separated "claimed-hop, …, peer-seen-by-proxy". With exactly
 * one trusted local proxy, only the right-most token was appended/observed by
 * that proxy; every token to its left may have arrived from the client. Taking
 * the left-most value would let a remote caller spoof an IP-pinned grant.
 * When parsing fails or the direct peer is not loopback, fall back to the
 * socket address — never fail open to an attacker-controlled header.
 */
export function clientIp(req: IncomingMessage): string {
  const direct = req.socket.remoteAddress ?? "0.0.0.0";
  // Only the exact loopback addresses qualify — earlier code accepted any
  // 127.x.x.x or any ::ffff:127.x.x.x form, which on dual-stack/containerized
  // setups let an attacker reaching the host from a non-loopback IPv6 address
  // spoof X-Forwarded-For. Reject any IPv4-mapped-loopback variant other than
  // ::ffff:127.0.0.1.
  const isLoopback =
    direct === "127.0.0.1" ||
    direct === "::1" ||
    direct === "::ffff:127.0.0.1";
  if (!isLoopback) return direct;
  const h = req.headers["x-forwarded-for"];
  if (!h) return direct;
  const tokens = (Array.isArray(h) ? h : [h])
    .flatMap(raw => raw.split(","))
    .map(token => token.trim())
    .filter(token => token.length > 0);
  return tokens[tokens.length - 1] ?? direct;
}

/**
 * Start the HTTP MCP server. Resolves to a handle you can close on shutdown.
 */
export async function startHttpTransport(opts: HttpTransportOptions): Promise<HttpTransportHandle> {
  const host = opts.host ?? "127.0.0.1";
  const path = opts.path ?? "/mcp";

  // OAuth is mandatory in remote mode: every caller must authenticate as its
  // own client (authorization_code for interactive agents, client_credentials
  // for service accounts) so it is independently gated, audited, and revocable.
  // The legacy shared static bearer — which bypassed all of that — is gone.
  if (!opts.oauthEnabled) {
    throw new Error("HTTP transport requires OAuth (remoteOauthEnabled). The static bearer was removed — every agent must authenticate as its own client. Issue a service account with `mailpouch agent issue` for headless/programmatic use.");
  }

  // One transport per client session (keyed by Mcp-Session-Id). The MCP SDK
  // binds one Server to one transport, so each session also gets its own Server
  // via opts.createServer. A new session is created when an unsessioned POST
  // carries an `initialize` request; subsequent requests route by session id.
  //
  // XPORT-016: the session id is a routing handle, NOT a credential. Every entry
  // records the OAuth client_id that opened it so a session can only ever be
  // driven by its owner. Without that binding any *other* authenticated agent
  // could present a peer's Mcp-Session-Id and attach to its transport — reading
  // the peer's server→client SSE stream on GET, or tearing the session down on
  // DELETE. The MCP security model is explicit that possession of a state handle
  // must not be treated as authentication.
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; owner: string }>();

  // Rate limiters — one bucket per client IP for unauthed endpoints; one
  // bucket per token (sha256-fingerprint) for authed /mcp calls.
  const unauthLimiter = new TokenBucketLimiter({
    capacity: opts.rateLimitBurst ?? 40,
    refillPerSecond: opts.rateLimitPerSecond ?? 20,
  });
  const authLimiter = new TokenBucketLimiter({
    capacity: (opts.rateLimitBurst ?? 40) * 3,          // authed calls get a bigger bucket
    refillPerSecond: (opts.rateLimitPerSecond ?? 20) * 3,
  });

  // OAuth state (only populated when enabled).
  const scheme = opts.tlsCertPath && opts.tlsKeyPath ? "https" : "http";

  // XPORT-015: serving auth (static bearer or OAuth tokens) over plain HTTP on
  // a non-loopback bind sends credentials across the wire in cleartext. We
  // don't hard-refuse (some operators front the listener with a TLS-terminating
  // proxy and bind 0.0.0.0 behind it), but we log a loud warning so an
  // unintentional public-cleartext deployment is obvious in the logs.
  const isLoopbackBind = host === "127.0.0.1" || host === "::1" || host === "localhost";
  if (scheme === "http" && !isLoopbackBind) {
    logger.warn(
      `Serving authentication over PLAIN HTTP on a non-loopback bind (${host}:${opts.port}). ` +
      `Bearer tokens and OAuth access tokens will cross the network in cleartext. ` +
      `Configure remoteTlsCertPath/remoteTlsKeyPath, bind to 127.0.0.1, or front the ` +
      `listener with a TLS-terminating reverse proxy.`,
      "HttpTransport",
    );
  }

  // XPORT-015: 0.0.0.0 is a wildcard bind address, not a routable host — it must
  // never appear in the RFC 8414 issuer / RFC 9728 resource metadata or every
  // well-behaved MCP host's discovery breaks. When no explicit issuer is set and
  // we'd otherwise derive 0.0.0.0, substitute loopback for the advertised URL.
  const issuerHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const derivedIssuer = `${scheme}://${issuerHost}:${opts.port}`;
  const issuer = opts.oauthIssuer ?? derivedIssuer;

  // XPORT-012: validate the OAuth-without-password misconfiguration BEFORE we
  // subscribe to the notifications bus. The earlier ordering registered the
  // grant-change listener and then threw, orphaning the subscription handle
  // (the caller never received `unsubGrantChanges` to clean it up).
  if (opts.oauthEnabled) {
    // OAuth is always automatic-consent: agents authenticate fully automatically
    // (DCR + PKCE) and the per-agent grant Approve/Deny is the only human gate.
    logger.info(
      "OAuth enabled (automatic consent): agents self-register and obtain a token automatically; each is inert until you Approve it in the Agents tab, and a pending request expires after 5 minutes.",
      "HTTPTransport",
    );
  }

  const oauthStore = new OAuthStore(opts.oauthTokensPath);
  // Register persisted service accounts as client_credentials clients so their
  // token-authenticated calls resolve to a human-readable client_name. Identity
  // is still the service-account store; this is display + metadata only.
  if (opts.serviceAccounts) {
    const now = Math.floor(Date.now() / 1000);
    for (const acct of opts.serviceAccounts.list()) {
      oauthStore.registerServiceClient({
        client_id: acct.clientId,
        client_id_issued_at: now,
        client_name: acct.clientName,
        redirect_uris: [],
        grant_types: ["client_credentials"],
        response_types: [],
        token_endpoint_auth_method: "client_secret_basic",
      });
    }
  }
  // Invalidate outstanding access tokens immediately when a grant transitions
  // out of "active". Without this, a revoked agent's existing token stayed
  // valid up to OAUTH_ACCESS_TOKEN_TTL_MS (24 h).
  const unsubGrantChanges = notifications.subscribe((ev) => {
    if (ev.kind === "grant-revoked" || ev.kind === "grant-denied" || ev.kind === "grant-expired") {
      const n = oauthStore.revokeTokensForClient(ev.grant.clientId);
      if (n > 0) logger.info(`Revoked ${n} OAuth token(s) for client ${ev.grant.clientId} after ${ev.kind}`, "HTTPTransport");
    }
  });
  const oauthHandlers = opts.oauthEnabled
    ? new OAuthHandlers(
        oauthStore,
        { issuer, resource: `${issuer}${path}` },
        unauthLimiter,
        opts.agentGrants
          ? (c) => opts.agentGrants!.createPending({ clientId: c.client_id, clientName: c.client_name ?? "", registeredFromIp: c.ip })
          : undefined,
        clientIp,
        opts.serviceAccounts
          ? (clientId, secret) => {
              // verify() reloads from disk, so an account issued/re-issued by a
              // separate `mailpouch agent` process is honored without a restart.
              const acct = opts.serviceAccounts!.verify(clientId, secret);
              if (!acct) return false;
              // (Re)activate the grant live in the running daemon's store so a
              // freshly-issued — or previously-revoked-then-re-issued — service
              // account works immediately, no restart. Idempotent.
              opts.agentGrants?.ensureActiveServiceGrant({
                clientId: acct.clientId,
                clientName: acct.clientName,
                preset: acct.preset,
                conditions: acct.conditions,
              });
              return true;
            }
          : undefined,
      )
    : null;

  const sweep = setInterval(() => {
    oauthStore.sweep();
    unauthLimiter.sweep();
    authLimiter.sweep();
  }, 60_000).unref();

  const listener = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", `${scheme}://${host}:${opts.port}`);
    // XPORT-011: every response carries the defence-in-depth header set.
    setSecurityHeaders(res);

    // Unauthenticated endpoints — all rate-limited per client IP.
    if (req.method === "GET" && url.pathname === "/health") {
      if (!unauthLimiter.take(`ip:${clientIp(req)}`)) {
        res.statusCode = 429; res.end(JSON.stringify({ error: "rate_limited" })); return;
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      // XPORT-010: the health probe is unauthenticated, so it must not leak
      // deployment fingerprint (transport flavour, whether OAuth/DCR is open).
      // Return the liveness signal only.
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    // OAuth endpoints — delegated to OAuthHandlers when enabled.
    if (oauthHandlers && (url.pathname.startsWith("/oauth/") || url.pathname.startsWith("/.well-known/"))) {
      const result = await oauthHandlers.dispatch(req, res, url);
      if (result.handled) return;
    }

    if (url.pathname !== path) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }

    const token = extractBearer(req);
    const caller = clientIp(req);
    let tokenKey: string | null = null;
    let ok = false;
    let callerClientId = "";
    let callerClientName = "";

    // Every caller authenticates as its own OAuth client — there is no shared
    // static-bearer bypass. Interactive agents obtain a token via
    // authorization_code + PKCE (gated by per-agent Approve/Deny); headless
    // agents via client_credentials (a pre-approved service account). A verified
    // token always resolves to a real client_id that GrantManager gates and the
    // audit log attributes.
    if (token && oauthHandlers) {
      const rec = oauthStore.verifyToken(token);
      if (rec) {
        // A bearer token is only a credential; its grant remains the live
        // authorization source. Read a fresh durable snapshot on EVERY HTTP
        // request so an external Settings/CLI process can revoke access
        // without relying on this daemon receiving an in-process event. Do
        // this before resource/IP checks too, so a definitively inactive grant
        // invalidates all cached bearers regardless of request shape.
        if (opts.agentGrants) {
          const grantSnapshot = opts.agentGrants.getAuthorizationSnapshot(rec.clientId);
          if (grantSnapshot.kind === "unavailable") {
            // A corrupt/unreadable grants file must fail closed, but it may be
            // transient (atomic rename, disk issue). Preserve the cached token
            // so recovery does not force an unnecessary OAuth re-auth.
            logger.warn(`Grant snapshot unavailable for OAuth client ${rec.clientId}; rejecting bearer without revoking it`, "HTTPTransport");
            res.statusCode = 401;
            res.setHeader("WWW-Authenticate", 'Bearer realm="mailpouch", error="invalid_token"');
            res.end(JSON.stringify({ error: "invalid_token" }));
            return;
          }

          const grant = grantSnapshot.kind === "present" ? grantSnapshot.grant : undefined;
          // Primary grant state is independently authoritative. Resolve it
          // first so a corrupt service-account file can never postpone token
          // purging for an already-revoked/expired/missing grant.
          let definitelyInactive = !grant
            || grant.status === "revoked"
            || grant.status === "expired"
            || (grant.status !== "pending" && grantHasExpired(grant));
          if (!definitelyInactive && grant && isServiceAccountGrant(grant)) {
            // A client_credentials grant has a second durable authority: its
            // credential record. A cross-file revoke can delete that record
            // before the companion AgentGrant write completes, so consult it
            // directly rather than trusting the active grant alone.
            if (!opts.serviceAccounts) {
              definitelyInactive = true;
            } else {
              const serviceSnapshot = opts.serviceAccounts.getAuthorizationSnapshot(rec.clientId);
              if (serviceSnapshot.kind === "unavailable") {
                // Same recoverability rule as grant storage: reject while the
                // credential source is unreadable, but do not make a transient
                // filesystem failure revoke a bearer permanently.
                logger.warn(`Service-account snapshot unavailable for OAuth client ${rec.clientId}; rejecting bearer without revoking it`, "HTTPTransport");
                res.statusCode = 401;
                res.setHeader("WWW-Authenticate", 'Bearer realm="mailpouch", error="invalid_token"');
                res.end(JSON.stringify({ error: "invalid_token" }));
                return;
              }
              definitelyInactive = serviceSnapshot.kind === "missing";
            }
          }
          // Pending bearers deliberately survive: they must reach the MCP
          // grant gate, which reports the actionable pending-approval state.
          // Missing/revoked/expired grants are definitive and invalidate every
          // cached token for this client immediately.
          if (definitelyInactive) {
            if (grant && grant.status === "active" && grantHasExpired(grant)) {
              // Best-effort status materialization; rejection + token revocation
              // do not depend on this write succeeding.
              try { opts.agentGrants.markExpired(grant.clientId); } catch { /* fail closed below */ }
            }
            const n = oauthStore.revokeTokensForClient(rec.clientId);
            if (n > 0) logger.info(`Revoked ${n} OAuth token(s) for inactive grant ${rec.clientId}`, "HTTPTransport");
            res.statusCode = 401;
            res.setHeader("WWW-Authenticate", 'Bearer realm="mailpouch", error="invalid_token"');
            res.end(JSON.stringify({ error: "invalid_token" }));
            return;
          }
        }
        // Resource Indicators: if the token was bound to a resource, it
        // must match this endpoint's URL.
        const expectedResource = `${issuer}${path}`;
        if (rec.resource && rec.resource !== expectedResource) {
          res.statusCode = 401;
          res.setHeader("WWW-Authenticate", `Bearer realm="mailpouch", error="invalid_token", error_description="token resource does not match endpoint"`);
          res.end(JSON.stringify({ error: "invalid_token" }));
          return;
        }
        // IP pinning at the token layer: if the token recorded its issuing
        // IP, the request must come from the same IP. Closes the "issue from
        // loopback, replay from remote" vector even when no per-agent grant
        // has ipPins set.
        if (rec.issuedFromIp && rec.issuedFromIp !== caller) {
          res.statusCode = 401;
          res.setHeader("WWW-Authenticate", `Bearer realm="mailpouch", error="invalid_token", error_description="token issued for a different client IP"`);
          res.end(JSON.stringify({ error: "invalid_token" }));
          return;
        }

        ok = true;
        tokenKey = `oauth:${rec.clientId}`;
        callerClientId = rec.clientId;
        // Human-readable client name from the registered client record (DCR for
        // interactive agents, service-account registration for headless ones);
        // fall back to the opaque client_id.
        callerClientName = oauthStore.getClient(rec.clientId)?.client_name ?? rec.clientId;
      }
    }

    if (!ok || !tokenKey) {
      res.statusCode = 401;
      res.setHeader("WWW-Authenticate",
        oauthHandlers
          ? `Bearer realm="mailpouch", resource_metadata="${issuer}/.well-known/oauth-protected-resource"`
          : 'Bearer realm="mailpouch"',
      );
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "invalid_token" }));
      return;
    }

    if (!authLimiter.take(tokenKey)) {
      res.statusCode = 429;
      res.end(JSON.stringify({ error: "rate_limited" }));
      return;
    }

    try {
      const body = req.method === "GET" ? undefined : await readJsonBody(req);

      // Route to the per-session transport. Existing session → reuse it.
      const sessionId = req.headers["mcp-session-id"];
      const sid = Array.isArray(sessionId) ? sessionId[0] : sessionId;
      const entry = sid ? sessions.get(sid) : undefined;
      // XPORT-016: a session belongs to the client that opened it. Another
      // agent's token is a valid credential but not a claim on this session, so
      // treat a foreign session id as if it did not exist — that both refuses
      // the request and avoids confirming to a prober that the id is live.
      let transport: StreamableHTTPServerTransport | undefined =
        entry && entry.owner === callerClientId ? entry.transport : undefined;
      if (entry && entry.owner !== callerClientId) {
        // Log a short digest, never the id itself: a live session id is a
        // routing secret, and an attacker probing ids would otherwise turn the
        // log file into a dump of valid ones. The digest is enough to correlate
        // repeated probes against the same session.
        const sidDigest = createHash("sha256").update(sid!).digest("hex").slice(0, 12);
        logger.warn(
          `Rejected session ${sidDigest} presented by ${callerClientId}: owned by a different OAuth client`,
          "HTTPTransport",
        );
      }

      if (!transport) {
        // No existing session. Only an `initialize` POST may open one.
        if (req.method === "POST" && isInitializeRequest(body)) {
          const owner = callerClientId;
          const created = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (newId) => { sessions.set(newId, { transport: created, owner }); },
          });
          created.onclose = () => { if (created.sessionId) sessions.delete(created.sessionId); };
          const mcp = opts.createServer ? opts.createServer() : opts.server;
          await mcp.connect(created);
          transport = created;
        } else {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Bad Request: no valid session ID (send an initialize request first)" },
            id: null,
          }));
          return;
        }
      }

      // Wrap the dispatcher in an async-local caller context so the tool
      // layer can identify the agent without threading it through every
      // function signature. callerClientId is always a real OAuth client_id
      // (no shared-bearer identity), so the gate and audit attribute every
      // call to a specific, revocable agent.
      await runWithCaller(
        {
          clientId: callerClientId,
          clientName: callerClientName,
          ip: caller,
        },
        async () => { await transport!.handleRequest(req, res, body); },
      );
    } catch (err: unknown) {
      logger.error("HTTP transport request failed", "HttpTransport", err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "internal_error" }));
      }
    }
  };

  const server = opts.tlsCertPath && opts.tlsKeyPath
    ? createSecureServer(
        { cert: readFileSync(opts.tlsCertPath), key: readFileSync(opts.tlsKeyPath) },
        listener,
      )
    : createServer(listener);

  await new Promise<void>((resolve, reject) => {
    const onErr = (err: Error) => { server.off("listening", onOk); reject(err); };
    const onOk = () => { server.off("error", onErr); resolve(); };
    server.once("error", onErr);
    server.once("listening", onOk);
    server.listen(opts.port, host);
  });

  const url = `${scheme}://${host}:${opts.port}${path}`;
  logger.info(
    `MCP HTTP transport listening at ${url}${oauthHandlers ? ` (OAuth enabled, issuer ${issuer})` : ""}`,
    "HttpTransport",
  );

  return {
    url,
    issuer: oauthHandlers ? issuer : undefined,
    close: async () => {
      clearInterval(sweep);
      unsubGrantChanges();
      for (const { transport } of sessions.values()) {
        try { await transport.close(); } catch { /* best effort */ }
      }
      sessions.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
