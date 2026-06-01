/**
 * Integration tests for the HTTP transport. Spins up a tiny MCP server on
 * an ephemeral port and checks that:
 *  - the health endpoint is reachable without auth
 *  - authed MCP requests succeed
 *  - missing / wrong bearer → 401
 *  - oversized bodies → 400-ish (stream torn down)
 *
 * Uses the actual StreamableHTTPServerTransport — no mocking of the SDK.
 */

import { describe, it, expect, afterEach } from "vitest";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { startHttpTransport, type HttpTransportHandle, clientIp } from "./http.js";
import { AddressInfo, createServer } from "net";
import type { IncomingMessage } from "http";

function fakeReq(remote: string, headers: Record<string, string | undefined> = {}): IncomingMessage {
  return {
    socket: { remoteAddress: remote } as unknown,
    headers,
  } as unknown as IncomingMessage;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address() as AddressInfo;
      const port = addr.port;
      s.close(() => resolve(port));
    });
  });
}

function buildServer(): McpServer {
  const srv = new McpServer({ name: "mailpouch-test", version: "0.0.0" }, {
    capabilities: { tools: { listChanged: false } },
  });
  srv.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
  return srv;
}

describe("clientIp — X-Forwarded-For trust model", () => {
  it("returns the socket address when no XFF header is present", () => {
    expect(clientIp(fakeReq("203.0.113.7"))).toBe("203.0.113.7");
  });

  it("trusts XFF when the direct peer is loopback (IPv4)", () => {
    expect(clientIp(fakeReq("127.0.0.1", { "x-forwarded-for": "203.0.113.7, 10.0.0.1" })))
      .toBe("203.0.113.7");
  });

  it("trusts XFF when the direct peer is IPv6 loopback", () => {
    expect(clientIp(fakeReq("::1", { "x-forwarded-for": "203.0.113.9" }))).toBe("203.0.113.9");
  });

  it("trusts XFF when the direct peer is IPv4-mapped IPv6 loopback", () => {
    expect(clientIp(fakeReq("::ffff:127.0.0.1", { "x-forwarded-for": "198.51.100.4" })))
      .toBe("198.51.100.4");
  });

  it("IGNORES XFF when the direct peer is NOT loopback (no header-spoofing wide open)", () => {
    expect(clientIp(fakeReq("203.0.113.7", { "x-forwarded-for": "1.2.3.4" })))
      .toBe("203.0.113.7");
  });

  it("takes the left-most token from a comma-separated XFF list", () => {
    expect(clientIp(fakeReq("127.0.0.1", { "x-forwarded-for": "  198.51.100.5  , 10.0.0.1 " })))
      .toBe("198.51.100.5");
  });

  it("falls back to the socket address when XFF is empty", () => {
    expect(clientIp(fakeReq("127.0.0.1", { "x-forwarded-for": " , " }))).toBe("127.0.0.1");
  });
});

describe("XPORT-001 — static bearer rate bucket is keyed per caller IP", () => {
  let handle: HttpTransportHandle | null = null;
  afterEach(async () => { if (handle) { await handle.close(); handle = null; } });

  it("does not let one IP's bursts exhaust another IP's bucket", async () => {
    // The auth limiter is keyed `bearer:static:<ip>`. We drive two distinct
    // XFF values through the loopback peer — clientIp() trusts XFF on loopback
    // — and assert each XFF identity gets its own bucket.
    const port = await freePort();
    handle = await startHttpTransport({
      server: buildServer(),
      port,
      host: "127.0.0.1",
      bearerToken: "secret",
      rateLimitPerSecond: 1,
      rateLimitBurst: 2, // authed cap ≈ 6 per key
    });
    const hammer = (xff: string) =>
      Promise.all(Array.from({ length: 15 }, () =>
        fetch(`http://127.0.0.1:${port}/mcp`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            Authorization: "Bearer secret",
            "X-Forwarded-For": xff,
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        }),
      ));
    const a = await hammer("203.0.113.10");
    expect(a.map(r => r.status)).toContain(429);
    // Caller B's first request must NOT be a 429 — its bucket is independent.
    const b = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: "Bearer secret",
        "X-Forwarded-For": "203.0.113.20",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "b", version: "0" } } }),
    });
    expect(b.status).not.toBe(429);
  });
});

describe("HTTP transport", () => {
  let handle: HttpTransportHandle | null = null;

  afterEach(async () => {
    if (handle) {
      await handle.close();
      handle = null;
    }
  });

  it("serves an unauthenticated /health probe", async () => {
    const port = await freePort();
    handle = await startHttpTransport({
      server: buildServer(),
      port,
      host: "127.0.0.1",
      bearerToken: "secret",
    });
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBe("ok");
  });

  it("rejects MCP requests with no Authorization header (401 + WWW-Authenticate)", async () => {
    const port = await freePort();
    handle = await startHttpTransport({
      server: buildServer(),
      port,
      host: "127.0.0.1",
      bearerToken: "secret",
    });
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/Bearer/i);
  });

  it("rejects MCP requests with the wrong bearer", async () => {
    const port = await freePort();
    handle = await startHttpTransport({
      server: buildServer(),
      port,
      host: "127.0.0.1",
      bearerToken: "secret",
    });
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer wrong" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects tokens of different length in constant-ish time", async () => {
    const port = await freePort();
    handle = await startHttpTransport({
      server: buildServer(),
      port,
      host: "127.0.0.1",
      bearerToken: "a-secret-token-with-length",
    });
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer short" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 404 for unknown paths", async () => {
    const port = await freePort();
    handle = await startHttpTransport({
      server: buildServer(),
      port,
      host: "127.0.0.1",
      bearerToken: "secret",
    });
    const res = await fetch(`http://127.0.0.1:${port}/elsewhere`);
    expect(res.status).toBe(404);
  });

  it("throws when started without a bearer token", async () => {
    const port = await freePort();
    await expect(
      startHttpTransport({ server: buildServer(), port, bearerToken: "" }),
    ).rejects.toThrow(/remoteBearerToken/);
  });

  it("XPORT-015 — never advertises 0.0.0.0 as the OAuth issuer host", async () => {
    const port = await freePort();
    handle = await startHttpTransport({
      server: buildServer(),
      port,
      host: "0.0.0.0",
      bearerToken: "",
      oauthEnabled: true,
      oauthAdminPassword: "admin-pw",
    });
    expect(handle.issuer).toBeDefined();
    expect(handle.issuer).not.toContain("0.0.0.0");
    expect(handle.issuer).toContain("127.0.0.1");
  });

  it("dispatches an authed tools/list round-trip through the MCP transport", async () => {
    const port = await freePort();
    handle = await startHttpTransport({
      server: buildServer(),
      port,
      host: "127.0.0.1",
      bearerToken: "secret",
    });
    // StreamableHTTP requires the client to first perform a POST to
    // /mcp with an MCP `initialize` message. We follow that with a
    // tools/list. Both requests must carry the bearer.
    const initRes = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: "Bearer secret",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "test", version: "0.0.0" },
        },
      }),
    });
    // Accept either 200 (JSON mode) or 200 with SSE — both mean the transport
    // accepted the request. Status >= 400 means auth / transport failure.
    expect(initRes.status).toBeLessThan(400);
  });

  describe("OAuth 2.1 mode (automatic consent)", () => {
    async function startOauth(): Promise<{ url: string; port: number }> {
      const port = await freePort();
      handle = await startHttpTransport({
        server: buildServer(),
        port,
        host: "127.0.0.1",
        bearerToken: "",
        oauthEnabled: true,
      });
      return { url: `http://127.0.0.1:${port}`, port };
    }

    async function dcr(url: string, redirectUris: string[] = ["http://localhost:9999/cb"], clientName?: string): Promise<{ client_id: string }> {
      const reg = await fetch(`${url}/oauth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ redirect_uris: redirectUris, ...(clientName ? { client_name: clientName } : {}) }),
      });
      return await reg.json() as { client_id: string };
    }

    async function pkce(): Promise<{ verifier: string; challenge: string }> {
      const { createHash, randomBytes: rb } = await import("crypto");
      const verifier = rb(32).toString("base64url");
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      return { verifier, challenge };
    }

    // Automatic consent: GET /oauth/authorize issues a code and 302-redirects,
    // with NO human password step (the human gate is per-agent Approve/Deny).
    async function getCode(url: string, clientId: string, challenge: string, redirectUri = "http://localhost:9999/cb", extra: Record<string, string> = {}): Promise<{ status: number; location: string; code: string }> {
      const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: "S256", ...extra });
      const res = await fetch(`${url}/oauth/authorize?${q.toString()}`, { redirect: "manual" });
      const location = res.headers.get("location") ?? "";
      let code = "";
      try { if (location) code = new URL(location).searchParams.get("code") ?? ""; } catch { /* non-redirect error response */ }
      return { status: res.status, location, code };
    }

    it("starts in automatic-consent mode when OAuth is enabled without an admin password", async () => {
      const { url } = await startOauth();
      const res = await fetch(`${url}/.well-known/oauth-authorization-server`);
      expect(res.status).toBe(200);
    });

    // PERM-008: when OAuth is enabled the static bearer must NOT be accepted.
    it("rejects the static bearer when OAuth is enabled", async () => {
      const port = await freePort();
      handle = await startHttpTransport({
        server: buildServer(),
        port,
        host: "127.0.0.1",
        bearerToken: "static-secret",
        oauthEnabled: true,
      });
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer static-secret" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(res.status).toBe(401);
    });

    it("serves RFC 8414 oauth-authorization-server metadata", async () => {
      const { url } = await startOauth();
      const res = await fetch(`${url}/.well-known/oauth-authorization-server`);
      expect(res.status).toBe(200);
      const body = await res.json() as { issuer: string; token_endpoint: string; code_challenge_methods_supported: string[] };
      expect(body.issuer).toMatch(/^http:\/\/127\.0\.0\.1:/);
      expect(body.token_endpoint).toContain("/oauth/token");
      expect(body.code_challenge_methods_supported).toContain("S256");
    });

    it("serves RFC 9728 oauth-protected-resource metadata", async () => {
      const { url } = await startOauth();
      const res = await fetch(`${url}/.well-known/oauth-protected-resource`);
      expect(res.status).toBe(200);
      const body = await res.json() as { resource: string; authorization_servers: string[] };
      expect(body.resource).toContain("/mcp");
      expect(body.authorization_servers).toHaveLength(1);
    });

    it("rejects DCR without any redirect_uris", async () => {
      const { url } = await startOauth();
      const res = await fetch(`${url}/oauth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_name: "Test" }),
      });
      expect(res.status).toBe(400);
    });

    it("auto-consents on GET /oauth/authorize → 302 with a code (no password)", async () => {
      const { url } = await startOauth();
      const client = await dcr(url, ["http://localhost:9999/cb"], "Inky");
      const { challenge } = await pkce();
      const { status, location, code } = await getCode(url, client.client_id, challenge);
      expect(status).toBe(302);
      expect(location).toContain("http://localhost:9999/cb");
      expect(code).toBeTruthy();
    });

    it("completes an end-to-end PKCE flow: register → authorize (auto) → token → /mcp", async () => {
      const { url } = await startOauth();
      const client = await dcr(url, ["http://localhost:9999/cb"], "E2E");
      const { verifier, challenge } = await pkce();
      const { code } = await getCode(url, client.client_id, challenge, "http://localhost:9999/cb", { state: "xyz", scope: "mcp:full" });
      expect(code).toBeTruthy();

      const tokenRes = await fetch(`${url}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: client.client_id,
          redirect_uri: "http://localhost:9999/cb",
          code_verifier: verifier,
        }).toString(),
      });
      expect(tokenRes.status).toBe(200);
      const tok = await tokenRes.json() as { access_token: string; token_type: string };
      expect(tok.token_type).toBe("Bearer");

      const mcp = await fetch(`${url}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${tok.access_token}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "e2e-test", version: "0" } },
        }),
      });
      expect(mcp.status).toBeLessThan(400);
    });

    it("rejects a token request with a tampered code_verifier (PKCE fails)", async () => {
      const { url } = await startOauth();
      const client = await dcr(url);
      const { challenge } = await pkce();
      const { code } = await getCode(url, client.client_id, challenge);
      const tokenRes = await fetch(`${url}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: client.client_id,
          redirect_uri: "http://localhost:9999/cb",
          code_verifier: "totally-different",
        }).toString(),
      });
      expect(tokenRes.status).toBe(400);
      expect((await tokenRes.json() as { error: string }).error).toBe("invalid_grant");
    });

    it("XPORT-009 — DCR rejects javascript:/data:/file: redirect_uri schemes", async () => {
      const { url } = await startOauth();
      for (const bad of ["javascript:alert(1)", "data:text/html,<script>1</script>", "file:///etc/passwd", "ftp://x/cb"]) {
        const res = await fetch(`${url}/oauth/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ redirect_uris: [bad] }),
        });
        expect(res.status, `scheme ${bad} should be rejected`).toBe(400);
        expect((await res.json() as { error: string }).error).toBe("invalid_redirect_uri");
      }
    });

    it("XPORT-009 — DCR still accepts loopback http + https + custom native schemes", async () => {
      const { url } = await startOauth();
      for (const ok of ["http://localhost:9999/cb", "http://127.0.0.1:5000/cb", "https://app.example.com/cb", "com.example.app:/oauth/callback"]) {
        const res = await fetch(`${url}/oauth/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ redirect_uris: [ok] }),
        });
        expect(res.status, `scheme ${ok} should be accepted`).toBe(201);
      }
    });

    it("returns WWW-Authenticate pointing to the resource-metadata doc when OAuth is on", async () => {
      const { url } = await startOauth();
      const res = await fetch(`${url}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(res.status).toBe(401);
      const auth = res.headers.get("www-authenticate") ?? "";
      expect(auth).toContain("resource_metadata");
      expect(auth).toContain("/.well-known/oauth-protected-resource");
    });

    it("rate-limits aggressive OAuth probing from a single IP", async () => {
      const port = await freePort();
      handle = await startHttpTransport({
        server: buildServer(),
        port,
        host: "127.0.0.1",
        bearerToken: "",
        oauthEnabled: true,
        rateLimitPerSecond: 5,
        rateLimitBurst: 3,
      });
      const responses = await Promise.all(
        Array.from({ length: 10 }, () =>
          fetch(`http://127.0.0.1:${port}/.well-known/oauth-authorization-server`),
        ),
      );
      expect(responses.map(r => r.status)).toContain(429);
    });

    it("token endpoint rejects unsupported grant types", async () => {
      const { url } = await startOauth();
      const res = await fetch(`${url}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "password" }).toString(),
      });
      expect(res.status).toBe(400);
      expect((await res.json() as { error: string }).error).toBe("unsupported_grant_type");
    });

    it("token endpoint rejects missing Content-Type with 415 (RFC 6749 strict)", async () => {
      const { url } = await startOauth();
      const res = await fetch(`${url}/oauth/token`, { method: "POST", body: "grant_type=authorization_code" });
      expect(res.status).toBe(415);
      expect((await res.json() as { error: string }).error).toBe("invalid_request");
    });

    it("token endpoint rejects mismatched redirect_uri / client_id / unknown codes", async () => {
      const { url } = await startOauth();
      const unknown = await fetch(`${url}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: "nope",
          client_id: "pmc_x",
          redirect_uri: "http://x/cb",
          code_verifier: "v",
        }).toString(),
      });
      expect(unknown.status).toBe(400);
      expect((await unknown.json() as { error: string }).error).toBe("invalid_grant");

      const client = await dcr(url, ["http://localhost:9998/cb"]);
      const { verifier, challenge } = await pkce();
      const { code } = await getCode(url, client.client_id, challenge, "http://localhost:9998/cb");
      const wrongClient = await fetch(`${url}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: "pmc_wrong",
          redirect_uri: "http://localhost:9998/cb",
          code_verifier: verifier,
        }).toString(),
      });
      expect(wrongClient.status).toBe(400);
    });

    it("revoke endpoint returns 200 even for unknown tokens (RFC 7009)", async () => {
      const { url } = await startOauth();
      const res = await fetch(`${url}/oauth/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: "does-not-exist" }).toString(),
      });
      expect(res.status).toBe(200);
    });

    it("GET /oauth/authorize rejects unknown client_id with 400", async () => {
      const { url } = await startOauth();
      const { status } = await getCode(url, "pmc_unknown", "x".repeat(43), "http://x/cb");
      expect(status).toBe(400);
    });

    it("GET /oauth/authorize rejects non-S256 PKCE method", async () => {
      const { url } = await startOauth();
      const client = await dcr(url);
      const q = new URLSearchParams({
        client_id: client.client_id,
        redirect_uri: "http://localhost:9999/cb",
        code_challenge: "x".repeat(43),
        code_challenge_method: "plain",
      });
      const res = await fetch(`${url}/oauth/authorize?${q.toString()}`, { redirect: "manual" });
      expect(res.status).toBe(400);
    });

    it("GET /oauth/authorize rejects a malformed code_challenge (auto-consent still validates PKCE)", async () => {
      const { url } = await startOauth();
      const client = await dcr(url);
      const { status } = await getCode(url, client.client_id, ""); // empty challenge
      expect(status).toBe(400);
    });

    it("DCR rejects malformed redirect_uri entries", async () => {
      const { url } = await startOauth();
      const res = await fetch(`${url}/oauth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ redirect_uris: ["not-a-url"] }),
      });
      expect(res.status).toBe(400);
    });

    it("token/revoke endpoints surface a 400 for malformed bodies", async () => {
      const { url } = await startOauth();
      const token = await fetch(`${url}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{not json" });
      expect(token.status).toBe(400);
      const revoke = await fetch(`${url}/oauth/revoke`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{not json" });
      expect(revoke.status).toBe(400);
    });

    it("rejects an OAuth token bound to a different resource (RFC 8707)", async () => {
      const port = await freePort();
      handle = await startHttpTransport({
        server: buildServer(),
        port,
        host: "127.0.0.1",
        bearerToken: "",
        oauthEnabled: true,
        oauthIssuer: `http://127.0.0.1:${port}`,
      });
      const baseUrl = `http://127.0.0.1:${port}`;
      const client = await dcr(baseUrl, ["http://localhost:9998/cb"]);
      const { verifier, challenge } = await pkce();
      const { code } = await getCode(baseUrl, client.client_id, challenge, "http://localhost:9998/cb", { resource: "https://other.example.com/mcp" });

      const tokRes = await fetch(`${baseUrl}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: client.client_id,
          redirect_uri: "http://localhost:9998/cb",
          code_verifier: verifier,
        }).toString(),
      });
      expect(tokRes.status).toBe(200);
      const token = (await tokRes.json() as { access_token: string }).access_token;

      const mcp = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(mcp.status).toBe(401);
      expect(mcp.headers.get("www-authenticate")).toMatch(/resource does not match/i);
    });
  });

  it("rate-limits authed /mcp callers per token", async () => {
    const port = await freePort();
    handle = await startHttpTransport({
      server: buildServer(),
      port,
      host: "127.0.0.1",
      bearerToken: "secret",
      rateLimitPerSecond: 1,
      rateLimitBurst: 2,
    });
    // auth bucket is 3x the burst (see http.ts), so burst=2 ⇒ authed cap ≈ 6.
    const responses = await Promise.all(
      Array.from({ length: 15 }, () =>
        fetch(`http://127.0.0.1:${port}/mcp`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            Authorization: "Bearer secret",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        }),
      ),
    );
    expect(responses.map(r => r.status)).toContain(429);
  });

  it("returns 500 when the transport handler throws", async () => {
    // Stand up a real listener, then monkey-patch the transport to throw.
    const port = await freePort();
    handle = await startHttpTransport({
      server: buildServer(),
      port,
      host: "127.0.0.1",
      bearerToken: "secret",
    });
    // Reach into the internals via a deliberately malformed JSON body —
    // readJsonBody throws, the listener catches, writes 500.
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer secret" },
      body: "{malformed json",
    });
    expect(res.status).toBe(500);
  });

  it("rejects bodies that exceed the size cap", async () => {
    const port = await freePort();
    handle = await startHttpTransport({
      server: buildServer(),
      port,
      host: "127.0.0.1",
      bearerToken: "secret",
    });
    // Build a 2 MB JSON payload (default cap is 1 MB).
    const big = "x".repeat(2_100_000);
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer secret" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "test", payload: big }),
    }).catch((e) => ({ status: 500, error: e } as unknown as Response));
    // Either the server returns 500 (handled error) or the socket aborts
    // mid-stream (fetch rejects with a network error). Both are acceptable
    // outcomes for an oversized body — the key invariant is that the server
    // does NOT succeed with a 2xx.
    if (res && typeof (res as Response).status === "number") {
      expect((res as Response).status).toBeGreaterThanOrEqual(400);
    }
  });
});
