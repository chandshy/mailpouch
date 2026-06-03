import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { OAuthStore, OAUTH_CODE_TTL_MS, OAUTH_ACCESS_TOKEN_TTL_MS } from "./oauth-store.js";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

describe("OAuthStore", () => {
  let store: OAuthStore;

  beforeEach(() => {
    store = new OAuthStore();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("client registration", () => {
    it("registers a client with a generated ID and issued-at timestamp", () => {
      const c = store.registerClient({
        client_name: "Claude Desktop",
        redirect_uris: ["http://localhost:53134/callback"],
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      });
      expect(c.client_id).toMatch(/^pmc_[0-9a-f]{32}$/);
      expect(c.client_id_issued_at).toBeGreaterThan(0);
      expect(c.client_name).toBe("Claude Desktop");
    });

    it("getClient returns the registered record and undefined for unknown IDs", () => {
      const c = store.registerClient({
        redirect_uris: ["http://localhost/cb"],
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      });
      expect(store.getClient(c.client_id)?.client_id).toBe(c.client_id);
      expect(store.getClient("pmc_unknown")).toBeUndefined();
    });
  });

  describe("authorization codes", () => {
    it("issues a single-use code that consumeAuthCode redeems exactly once", () => {
      const issued = store.issueAuthCode({
        clientId: "c1",
        redirectUri: "http://localhost/cb",
        codeChallenge: "challenge",
        codeChallengeMethod: "S256",
        scopes: ["mcp:full"],
      });
      expect(issued.code).toBeTruthy();

      const first = store.consumeAuthCode(issued.code);
      expect(first?.clientId).toBe("c1");

      const second = store.consumeAuthCode(issued.code);
      expect(second).toBeNull();
    });

    it("rejects an expired code (still deletes it)", () => {
      // TEST-016: advance virtual time instead of poking the record's createdAt.
      vi.useFakeTimers();
      const issued = store.issueAuthCode({
        clientId: "c1",
        redirectUri: "http://localhost/cb",
        codeChallenge: "x",
        codeChallengeMethod: "S256",
        scopes: [],
      });
      vi.advanceTimersByTime(OAUTH_CODE_TTL_MS + 1);
      expect(store.consumeAuthCode(issued.code)).toBeNull();
    });

    it("consumeAuthCode returns null for unknown codes", () => {
      expect(store.consumeAuthCode("nope")).toBeNull();
    });
  });

  describe("access tokens", () => {
    it("issues a token that verifyToken resolves", () => {
      const t = store.issueToken({ clientId: "c1", scopes: ["mcp:full"] });
      expect(t.expiresAt - Date.now()).toBeCloseTo(OAUTH_ACCESS_TOKEN_TTL_MS, -3);

      const v = store.verifyToken(t.token);
      expect(v?.clientId).toBe("c1");
    });

    it("verifyToken returns null for unknown or expired tokens", () => {
      expect(store.verifyToken("unknown")).toBeNull();
      // TEST-016: drive expiry through virtual time, not an internal poke.
      vi.useFakeTimers();
      const t = store.issueToken({ clientId: "c1", scopes: [] });
      vi.advanceTimersByTime(OAUTH_ACCESS_TOKEN_TTL_MS + 1);
      expect(store.verifyToken(t.token)).toBeNull();
    });

    it("revokeToken removes a live token", () => {
      const t = store.issueToken({ clientId: "c1", scopes: [] });
      expect(store.revokeToken(t.token)).toBe(true);
      expect(store.verifyToken(t.token)).toBeNull();
      expect(store.revokeToken(t.token)).toBe(false);
    });

    it("records the resource binding when provided", () => {
      const t = store.issueToken({ clientId: "c1", scopes: [], resource: "https://x.example.com/mcp" });
      expect(store.verifyToken(t.token)?.resource).toBe("https://x.example.com/mcp");
    });

    it("XPORT-005 — the raw token is not used as an internal Map key", () => {
      const t = store.issueToken({ clientId: "c1", scopes: [] });
      // Reach into the private map: the key must be the sha256 hash, never the
      // raw bearer the caller presents.
      const keys = [...(store as unknown as { tokens: Map<string, unknown> }).tokens.keys()];
      expect(keys).toHaveLength(1);
      expect(keys[0]).not.toBe(t.token);
      expect(keys[0]).toMatch(/^[0-9a-f]{64}$/);
      // Lookup still resolves via the raw token.
      expect(store.verifyToken(t.token)?.clientId).toBe("c1");
    });

    it("XPORT-013 — revokeTokensForClient leaves the reverse index consistent", () => {
      store.issueToken({ clientId: "cA", scopes: [] });
      store.issueToken({ clientId: "cA", scopes: [] });
      store.issueToken({ clientId: "cB", scopes: [] });
      const n = store.revokeTokensForClient("cA");
      expect(n).toBe(2);
      // The remaining token map size must equal what verifyToken can reach.
      expect(store.stats().tokens).toBe(1);
    });
  });

  describe("sweep / stats", () => {
    it("sweep() removes expired codes and tokens, leaves live ones alone", () => {
      // TEST-016: issue the "dead" token in the past via fake timers, then
      // sweep at the real-ish now so only it has expired.
      vi.useFakeTimers();
      const dead = store.issueToken({ clientId: "c1", scopes: [] });
      vi.advanceTimersByTime(OAUTH_ACCESS_TOKEN_TTL_MS + 1_000);
      const live = store.issueToken({ clientId: "c1", scopes: [] });
      const swept = store.sweep();
      expect(swept.tokens).toBe(1);
      expect(store.verifyToken(live.token)).not.toBeNull();
      expect(store.verifyToken(dead.token)).toBeNull();
    });

    it("stats reports current counts", () => {
      store.registerClient({ redirect_uris: ["http://x/cb"], grant_types: ["authorization_code"], response_types: ["code"], token_endpoint_auth_method: "none" });
      store.issueToken({ clientId: "c", scopes: [] });
      store.issueAuthCode({ clientId: "c", redirectUri: "http://x/cb", codeChallenge: "x", codeChallengeMethod: "S256", scopes: [] });
      const s = store.stats();
      expect(s).toEqual({ clients: 1, codes: 1, tokens: 1 });
    });
  });

  describe("absolute caps (DoS resistance)", () => {
    it("evicts the oldest token when the cap is reached", async () => {
      const { OAUTH_MAX_TOKENS } = await import("./oauth-store.js");
      const first = store.issueToken({ clientId: "c1", scopes: [] });
      // Fill to exactly the cap, then add one more → first should be gone.
      for (let i = 0; i < OAUTH_MAX_TOKENS; i++) {
        store.issueToken({ clientId: `c${i + 2}`, scopes: [] });
      }
      expect(store.verifyToken(first.token)).toBeNull();
      expect(store.stats().tokens).toBeLessThanOrEqual(OAUTH_MAX_TOKENS);
    });

    it("evicts the oldest code when the cap is reached", async () => {
      const { OAUTH_MAX_CODES } = await import("./oauth-store.js");
      const first = store.issueAuthCode({ clientId: "c", redirectUri: "http://x/cb", codeChallenge: "x", codeChallengeMethod: "S256", scopes: [] });
      for (let i = 0; i < OAUTH_MAX_CODES; i++) {
        store.issueAuthCode({ clientId: "c", redirectUri: "http://x/cb", codeChallenge: "x", codeChallengeMethod: "S256", scopes: [] });
      }
      expect(store.consumeAuthCode(first.code)).toBeNull();
      expect(store.stats().codes).toBeLessThanOrEqual(OAUTH_MAX_CODES);
    });
  });

  describe("token persistence (#7 — survive daemon restart)", () => {
    let dir: string; let path: string;
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "mp-oauth-")); path = join(dir, "tokens.json"); });
    afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

    it("a token issued by one store is valid in a fresh store loaded from disk", () => {
      const a = new OAuthStore(path);
      const t = a.issueToken({ clientId: "pmc_x", scopes: ["mcp"] });
      // New process / daemon restart:
      const b = new OAuthStore(path);
      const rec = b.verifyToken(t.token);
      expect(rec).not.toBeNull();
      expect(rec!.clientId).toBe("pmc_x");
    });

    it("never writes the raw bearer to disk (hashes only)", () => {
      const a = new OAuthStore(path);
      const t = a.issueToken({ clientId: "pmc_y", scopes: ["mcp"] });
      expect(existsSync(path)).toBe(true);
      const onDisk = readFileSync(path, "utf-8");
      expect(onDisk).not.toContain(t.token); // raw token must not be persisted
    });

    it("does not resurrect expired tokens on load", () => {
      const a = new OAuthStore(path);
      const t = a.issueToken({ clientId: "pmc_z", scopes: ["mcp"] });
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + OAUTH_ACCESS_TOKEN_TTL_MS + 1000);
      const b = new OAuthStore(path);
      expect(b.verifyToken(t.token)).toBeNull();
      vi.useRealTimers();
    });

    it("revocation is persisted (revoked token stays invalid after restart)", () => {
      const a = new OAuthStore(path);
      const t = a.issueToken({ clientId: "pmc_r", scopes: ["mcp"] });
      a.revokeToken(t.token);
      const b = new OAuthStore(path);
      expect(b.verifyToken(t.token)).toBeNull();
    });
  });

});
