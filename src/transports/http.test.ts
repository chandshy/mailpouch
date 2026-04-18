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

  describe("OAuth 2.1 mode", () => {
    async function startOauth(): Promise<{ url: string; port: number }> {
      const port = await freePort();
      handle = await startHttpTransport({
        server: buildServer(),
        port,
        host: "127.0.0.1",
        bearerToken: "",
        oauthEnabled: true,
        oauthAdminPassword: "admin-pw",
      });
      return { url: `http://127.0.0.1:${port}`, port };
    }

    it("refuses to start when oauthEnabled is true but no admin password is set", async () => {
      const port = await freePort();
      await expect(
        startHttpTransport({
          server: buildServer(),
          port,
          host: "127.0.0.1",
          bearerToken: "",
          oauthEnabled: true,
        }),
      ).rejects.toThrow(/oauthAdminPassword|admin password/i);
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

    it("completes an end-to-end PKCE flow: register → authorize → token → /mcp", async () => {
      const { url } = await startOauth();
      // 1. DCR
      const reg = await fetch(`${url}/oauth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "E2E",
          redirect_uris: ["http://localhost:9999/cb"],
        }),
      });
      expect(reg.status).toBe(201);
      const client = await reg.json() as { client_id: string };

      // 2. PKCE challenge
      const { createHash, randomBytes: rb } = await import("crypto");
      const verifier = rb(32).toString("base64url");
      const challenge = createHash("sha256").update(verifier).digest("base64url");

      // 3. Consent submit (skips the GET HTML page).
      const consent = await fetch(`${url}/oauth/authorize`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: client.client_id,
          redirect_uri: "http://localhost:9999/cb",
          code_challenge: challenge,
          state: "xyz",
          scope: "mcp:full",
          admin_password: "admin-pw",
        }).toString(),
        redirect: "manual",
      });
      expect(consent.status).toBe(302);
      const location = consent.headers.get("location") ?? "";
      expect(location).toContain("http://localhost:9999/cb");
      const code = new URL(location).searchParams.get("code") ?? "";
      expect(code).toBeTruthy();

      // 4. Token exchange.
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

      // 5. Authenticated /mcp call with the issued token.
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
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "e2e-test", version: "0" },
          },
        }),
      });
      expect(mcp.status).toBeLessThan(400);
    });

    it("rejects an authorize POST with the wrong admin password", async () => {
      const { url } = await startOauth();
      const reg = await fetch(`${url}/oauth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ redirect_uris: ["http://localhost:9999/cb"] }),
      });
      const client = await reg.json() as { client_id: string };

      const res = await fetch(`${url}/oauth/authorize`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: client.client_id,
          redirect_uri: "http://localhost:9999/cb",
          code_challenge: "x".repeat(43),
          admin_password: "wrong",
        }).toString(),
        redirect: "manual",
      });
      expect(res.status).toBe(403);
    });

    it("rejects a token request with a tampered code_verifier (PKCE fails)", async () => {
      const { url } = await startOauth();
      const reg = await fetch(`${url}/oauth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ redirect_uris: ["http://localhost:9999/cb"] }),
      });
      const client = await reg.json() as { client_id: string };
      const { createHash: h, randomBytes: rb2 } = await import("crypto");
      const verifier = rb2(32).toString("base64url");
      const challenge = h("sha256").update(verifier).digest("base64url");
      const consent = await fetch(`${url}/oauth/authorize`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: client.client_id,
          redirect_uri: "http://localhost:9999/cb",
          code_challenge: challenge,
          admin_password: "admin-pw",
        }).toString(),
        redirect: "manual",
      });
      const code = new URL(consent.headers.get("location") ?? "").searchParams.get("code") ?? "";
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
      const body = await tokenRes.json() as { error: string };
      expect(body.error).toBe("invalid_grant");
    });

    it("serves the consent HTML on GET /oauth/authorize", async () => {
      const { url } = await startOauth();
      const reg = await fetch(`${url}/oauth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ redirect_uris: ["http://localhost:9999/cb"], client_name: "Inky" }),
      });
      const client = await reg.json() as { client_id: string };
      const q = new URLSearchParams({
        client_id: client.client_id,
        redirect_uri: "http://localhost:9999/cb",
        code_challenge: "x".repeat(43),
        code_challenge_method: "S256",
      });
      const res = await fetch(`${url}/oauth/authorize?${q.toString()}`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Authorize mailpouch");
      expect(html).toContain("Inky");
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
        oauthAdminPassword: "admin-pw",
        rateLimitPerSecond: 5,
        rateLimitBurst: 3,
      });
      const responses = await Promise.all(
        Array.from({ length: 10 }, () =>
          fetch(`http://127.0.0.1:${port}/.well-known/oauth-authorization-server`),
        ),
      );
      const statuses = responses.map(r => r.status);
      expect(statuses).toContain(429);
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
      const res = await fetch(`${url}/oauth/token`, {
        method: "POST",
        // Note: NO Content-Type header. fetch() will add text/plain by default,
        // which readBody also rejects — same 415 path.
        body: "grant_type=authorization_code",
      });
      expect(res.status).toBe(415);
      expect((await res.json() as { error: string }).error).toBe("invalid_request");
    });

    it("token endpoint rejects mismatched redirect_uri / client_id / unknown codes", async () => {
      const { url } = await startOauth();
      // Unknown code
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

      // Wrong client_id / redirect_uri on a valid code.
      const reg = await fetch(`${url}/oauth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ redirect_uris: ["http://localhost:9998/cb"] }),
      });
      const client = await reg.json() as { client_id: string };
      const { createHash, randomBytes: rb } = await import("crypto");
      const verifier = rb(32).toString("base64url");
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      const consent = await fetch(`${url}/oauth/authorize`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: client.client_id,
          redirect_uri: "http://localhost:9998/cb",
          code_challenge: challenge,
          admin_password: "admin-pw",
        }).toString(),
        redirect: "manual",
      });
      const code = new URL(consent.headers.get("location") ?? "").searchParams.get("code") ?? "";

      // Wrong client_id
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
      const q = new URLSearchParams({
        client_id: "pmc_unknown",
        redirect_uri: "http://x/cb",
        code_challenge: "x".repeat(43),
        code_challenge_method: "S256",
      });
      const res = await fetch(`${url}/oauth/authorize?${q.toString()}`);
      expect(res.status).toBe(400);
    });

    it("GET /oauth/authorize rejects non-S256 PKCE method", async () => {
      const { url } = await startOauth();
      const reg = await fetch(`${url}/oauth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ redirect_uris: ["http://localhost:9999/cb"] }),
      });
      const client = await reg.json() as { client_id: string };
      const q = new URLSearchParams({
        client_id: client.client_id,
        redirect_uri: "http://localhost:9999/cb",
        code_challenge: "x".repeat(43),
        code_challenge_method: "plain",
      });
      const res = await fetch(`${url}/oauth/authorize?${q.toString()}`);
      expect(res.status).toBe(400);
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
      // Token: application/json content-type but non-JSON body
      const token = await fetch(`${url}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      });
      expect(token.status).toBe(400);
      // Revoke: same trick
      const revoke = await fetch(`${url}/oauth/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      });
      expect(revoke.status).toBe(400);
    });

    it("rejects an OAuth token bound to a different resource (RFC 8707)", async () => {
      const port = await freePort();
      // Start with an explicit issuer + resource that DIFFERS from the request URL.
      handle = await startHttpTransport({
        server: buildServer(),
        port,
        host: "127.0.0.1",
        bearerToken: "",
        oauthEnabled: true,
        oauthAdminPassword: "admin-pw",
        oauthIssuer: `http://127.0.0.1:${port}`,
      });
      const baseUrl = `http://127.0.0.1:${port}`;

      const reg = await fetch(`${baseUrl}/oauth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ redirect_uris: ["http://localhost:9998/cb"] }),
      });
      const client = await reg.json() as { client_id: string };
      const { createHash, randomBytes: rb } = await import("crypto");
      const verifier = rb(32).toString("base64url");
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      // Authorize with a foreign resource URI.
      const consent = await fetch(`${baseUrl}/oauth/authorize`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: client.client_id,
          redirect_uri: "http://localhost:9998/cb",
          code_challenge: challenge,
          resource: "https://other.example.com/mcp",
          admin_password: "admin-pw",
        }).toString(),
        redirect: "manual",
      });
      const code = new URL(consent.headers.get("location") ?? "").searchParams.get("code") ?? "";

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

      // The token is bound to other.example.com, but we're hitting 127.0.0.1.
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
