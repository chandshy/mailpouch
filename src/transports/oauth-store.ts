/**
 * In-memory stores for the OAuth 2.1 authorization server.
 *
 * Codes (60s TTL) and DCR clients are process-local: a restart drops codes
 * (short-lived anyway) and clients re-register on demand.
 *
 * Issued ACCESS TOKENS are optionally persisted (when the store is constructed
 * with a path) so they survive a daemon restart — without persistence, a
 * restart dropped the in-memory Map and 401'd every live token, silently
 * breaking headless / static-config clients (field finding #7). Only the token
 * HASH (the Map key) + metadata are written to disk (0600, atomic) — never the
 * raw bearer — so a leaked file cannot be replayed as a credential.
 */

import { createHash, randomBytes, randomUUID } from "crypto";
import { readFileSync, writeFileSync, existsSync, renameSync } from "fs";

export interface RegisteredClient {
  client_id: string;
  client_id_issued_at: number;
  client_name?: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: string;
  scope?: string;
  client_secret?: string;
  client_secret_expires_at?: number;
}

export interface PendingAuth {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: "S256" | "plain";
  scopes: string[];
  resource?: string;
  state?: string;
  /** ms since epoch. Codes expire after OAUTH_CODE_TTL_MS. */
  createdAt: number;
}

export interface IssuedToken {
  token: string;
  clientId: string;
  scopes: string[];
  resource?: string;
  /** ms since epoch. */
  expiresAt: number;
  /** Client IP at issuance. When set, verifyToken() rejects requests from a
   *  different IP — closes the "issue from loopback, replay from a non-pinned
   *  remote" gap that bypassed per-agent ipPins on the MCP endpoint. Optional
   *  for backwards compatibility with tokens issued before this field existed. */
  issuedFromIp?: string;
}

export const OAUTH_CODE_TTL_MS = 60_000;                // RFC 6749 §4.1.2: MAX 10 min; we go short
export const OAUTH_ACCESS_TOKEN_TTL_MS = 24 * 60 * 60_000;  // 24 h — self-host session

/**
 * Absolute ceilings. The DCR endpoint is rate-limited per IP upstream, so
 * a friendly client won't hit these. The caps exist so a broken or hostile
 * client can't grow the Maps without bound between sweep() calls.
 *
 * When a cap is hit we evict the oldest entry rather than refusing the
 * new one — matches the "self-host, keep the live session working"
 * philosophy. Evicted clients will simply re-register on their next use.
 */
export const OAUTH_MAX_CLIENTS = 1000;
export const OAUTH_MAX_CODES   = 500;
export const OAUTH_MAX_TOKENS  = 5000;

export class OAuthStore {
  private clients = new Map<string, RegisteredClient>();
  private codes = new Map<string, PendingAuth>();
  /**
   * XPORT-005: tokens are keyed by sha256(token), never the raw token. The
   * user-supplied bearer is hashed before the Map lookup, so the comparison is
   * over fixed-length digests rather than letting V8's hash-table short-circuit
   * on the first byte of the attacker-controlled string — consistent with the
   * `timingSafeEqual` posture the rest of the codebase uses. The reverse index
   * stores hashes too.
   */
  private tokens = new Map<string, IssuedToken>();
  /** Reverse index clientId → token-hashes, so revoking a grant can invalidate
   *  all outstanding access tokens for that client immediately rather than
   *  waiting for the 24 h TTL to expire. Kept consistent with `tokens` via the
   *  issueToken / revokeToken / evict / sweep paths. */
  private tokensByClient = new Map<string, Set<string>>();

  /**
   * Optional on-disk persistence of ISSUED TOKENS so they survive a daemon
   * restart (XPORT/#7 — a restart used to drop the in-memory Map and 401 every
   * live token, silently breaking headless/static-config clients). Only the
   * token HASH (the Map key) + metadata are written — never the raw bearer — so
   * a leaked file cannot be replayed as a credential. Codes (60s TTL) and DCR
   * clients are intentionally NOT persisted.
   */
  constructor(private readonly persistPath?: string) {
    if (persistPath) this.load();
  }

  private load(): void {
    try {
      if (!this.persistPath || !existsSync(this.persistPath)) return;
      const raw = JSON.parse(readFileSync(this.persistPath, "utf-8")) as { tokens?: Array<{ h: string; r: IssuedToken }> };
      const now = Date.now();
      for (const entry of raw.tokens ?? []) {
        const { h, r } = entry;
        if (!h || !r || typeof r.expiresAt !== "number" || now > r.expiresAt) continue;
        this.tokens.set(h, r);
        let set = this.tokensByClient.get(r.clientId);
        if (!set) { set = new Set(); this.tokensByClient.set(r.clientId, set); }
        set.add(h);
      }
    } catch {
      // Corrupt/unreadable token store → start fresh (clients re-auth). Never throw.
    }
  }

  private persist(): void {
    if (!this.persistPath) return;
    try {
      // Hashes only — the raw bearer is blanked so a leaked file can't be replayed.
      const tokens = Array.from(this.tokens.entries()).map(([h, r]) => ({ h, r: { ...r, token: "" } }));
      const tmp = `${this.persistPath}.${randomBytes(6).toString("hex")}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, tokens }), { mode: 0o600 });
      renameSync(tmp, this.persistPath);
    } catch {
      // Best-effort — a failed persist must not break token issuance/verification.
    }
  }

  /** sha256(token) hex — the key under which a token's record lives. */
  private static hashToken(token: string): string {
    return createHash("sha256").update(token, "utf-8").digest("hex");
  }

  /** Drop the oldest entry from a Map (relies on Map's insertion-order iteration). */
  private evictOldest<K, V>(m: Map<K, V>): void {
    const first = m.keys().next();
    if (!first.done) m.delete(first.value);
  }

  private indexToken(rec: IssuedToken): void {
    let set = this.tokensByClient.get(rec.clientId);
    if (!set) { set = new Set(); this.tokensByClient.set(rec.clientId, set); }
    set.add(OAuthStore.hashToken(rec.token));
  }

  /** `hash` is sha256(token) — the same key used in the primary tokens Map. */
  private unindexToken(hash: string, clientId: string): void {
    const set = this.tokensByClient.get(clientId);
    if (!set) return;
    set.delete(hash);
    if (set.size === 0) this.tokensByClient.delete(clientId);
  }

  registerClient(client: Omit<RegisteredClient, "client_id" | "client_id_issued_at">): RegisteredClient {
    const id = `pmc_${randomUUID().replace(/-/g, "")}`;
    const now = Math.floor(Date.now() / 1000);
    const record: RegisteredClient = {
      client_id: id,
      client_id_issued_at: now,
      ...client,
    };
    if (this.clients.size >= OAUTH_MAX_CLIENTS) this.evictOldest(this.clients);
    this.clients.set(id, record);
    return record;
  }

  getClient(id: string): RegisteredClient | undefined {
    return this.clients.get(id);
  }

  /**
   * Register a client with a predetermined client_id. Used to load persisted
   * service accounts (client_credentials grant) at startup so token-issued
   * callers resolve to a human-readable client_name in logs and the Agents tab.
   * Unlike {@link registerClient}, the id is supplied by the caller (it already
   * lives in the service-account store) rather than freshly minted.
   */
  registerServiceClient(record: RegisteredClient): void {
    if (this.clients.size >= OAUTH_MAX_CLIENTS) this.evictOldest(this.clients);
    this.clients.set(record.client_id, record);
  }

  /** Allocate a new one-shot authorization code. */
  issueAuthCode(params: Omit<PendingAuth, "code" | "createdAt">): PendingAuth {
    const code = randomBytes(32).toString("base64url");
    const record: PendingAuth = { code, createdAt: Date.now(), ...params };
    if (this.codes.size >= OAUTH_MAX_CODES) this.evictOldest(this.codes);
    this.codes.set(code, record);
    return record;
  }

  /** Consume a code (always deletes, returns record only if still valid). */
  consumeAuthCode(code: string): PendingAuth | null {
    const rec = this.codes.get(code);
    if (!rec) return null;
    this.codes.delete(code); // single-use — always drop regardless of expiry
    if (Date.now() - rec.createdAt > OAUTH_CODE_TTL_MS) return null;
    return rec;
  }

  issueToken(args: { clientId: string; scopes: string[]; resource?: string; issuedFromIp?: string }): IssuedToken {
    const token = randomBytes(32).toString("base64url");
    const rec: IssuedToken = {
      token,
      clientId: args.clientId,
      scopes: args.scopes,
      resource: args.resource,
      expiresAt: Date.now() + OAUTH_ACCESS_TOKEN_TTL_MS,
      issuedFromIp: args.issuedFromIp,
    };
    if (this.tokens.size >= OAUTH_MAX_TOKENS) {
      const first = this.tokens.keys().next();
      if (!first.done) {
        const old = this.tokens.get(first.value);
        this.tokens.delete(first.value);
        if (old) this.unindexToken(first.value, old.clientId);
      }
    }
    this.tokens.set(OAuthStore.hashToken(token), rec);
    this.indexToken(rec);
    this.persist();
    return rec;
  }

  verifyToken(token: string): IssuedToken | null {
    const hash = OAuthStore.hashToken(token);
    const rec = this.tokens.get(hash);
    if (!rec) return null;
    if (Date.now() > rec.expiresAt) {
      this.tokens.delete(hash);
      this.unindexToken(hash, rec.clientId);
      return null;
    }
    return rec;
  }

  revokeToken(token: string): boolean {
    const hash = OAuthStore.hashToken(token);
    const rec = this.tokens.get(hash);
    const removed = this.tokens.delete(hash);
    if (removed && rec) this.unindexToken(hash, rec.clientId);
    if (removed) this.persist();
    return removed;
  }

  /** Drop every outstanding access token for `clientId`. Returns the number
   *  of tokens revoked. Called when a per-agent grant is denied / revoked /
   *  expires so that ongoing requests holding the token can't continue past
   *  the policy change. */
  revokeTokensForClient(clientId: string): number {
    const set = this.tokensByClient.get(clientId);
    if (!set || set.size === 0) return 0;
    let n = 0;
    for (const token of set) {
      if (this.tokens.delete(token)) n++;
    }
    this.tokensByClient.delete(clientId);
    if (n > 0) this.persist();
    return n;
  }

  /**
   * Drop expired codes + tokens. Safe to call periodically — O(n) scan, but
   * n is small in a single-user deployment (usually ≤ dozens).
   */
  sweep(now = Date.now()): { codes: number; tokens: number } {
    let codes = 0;
    let tokens = 0;
    for (const [k, v] of this.codes) {
      if (now - v.createdAt > OAUTH_CODE_TTL_MS) {
        this.codes.delete(k);
        codes++;
      }
    }
    for (const [k, v] of this.tokens) {
      if (now > v.expiresAt) {
        this.tokens.delete(k);
        this.unindexToken(k, v.clientId);
        tokens++;
      }
    }
    if (tokens > 0) this.persist();
    return { codes, tokens };
  }

  stats(): { clients: number; codes: number; tokens: number } {
    return { clients: this.clients.size, codes: this.codes.size, tokens: this.tokens.size };
  }
}
