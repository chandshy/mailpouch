/**
 * In-memory stores for the OAuth 2.1 authorization server.
 *
 * All state is process-local — matching mailpouch's single-user design.
 * A restart drops outstanding auth codes (short TTL anyway) and tokens
 * (requiring clients to re-auth); registered DCR clients are re-provisioned
 * on demand because MCP hosts will call the register endpoint again.
 *
 * Rationale for not persisting to disk:
 *   - Keeps the attack surface small (no on-disk tokens to leak).
 *   - Tokens in this deployment are long-lived enough for an interactive
 *     session but re-issue is cheap.
 *   - Persistence is a follow-up PR when we tackle multi-instance or
 *     survivable restarts.
 */

import { randomBytes, randomUUID } from "crypto";

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
  private tokens = new Map<string, IssuedToken>();

  /** Drop the oldest entry from a Map (relies on Map's insertion-order iteration). */
  private evictOldest<K, V>(m: Map<K, V>): void {
    const first = m.keys().next();
    if (!first.done) m.delete(first.value);
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

  issueToken(args: { clientId: string; scopes: string[]; resource?: string }): IssuedToken {
    const token = randomBytes(32).toString("base64url");
    const rec: IssuedToken = {
      token,
      clientId: args.clientId,
      scopes: args.scopes,
      resource: args.resource,
      expiresAt: Date.now() + OAUTH_ACCESS_TOKEN_TTL_MS,
    };
    if (this.tokens.size >= OAUTH_MAX_TOKENS) this.evictOldest(this.tokens);
    this.tokens.set(token, rec);
    return rec;
  }

  verifyToken(token: string): IssuedToken | null {
    const rec = this.tokens.get(token);
    if (!rec) return null;
    if (Date.now() > rec.expiresAt) {
      this.tokens.delete(token);
      return null;
    }
    return rec;
  }

  revokeToken(token: string): boolean {
    return this.tokens.delete(token);
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
        tokens++;
      }
    }
    return { codes, tokens };
  }

  stats(): { clients: number; codes: number; tokens: number } {
    return { clients: this.clients.size, codes: this.codes.size, tokens: this.tokens.size };
  }
}
