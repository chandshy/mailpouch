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
import { ServiceAccountStore } from "../agents/service-account-store.js";
import { AgentGrantStore } from "../agents/grant-store.js";
import { AddressInfo, createServer } from "net";
import { tmpdir } from "os";
import { join } from "path";
import { createHash, randomBytes } from "crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import type { IncomingMessage } from "http";
import { writeOwnerOnlyJsonAtomically } from "../utils/atomic-json.js";

/** Temp service-account store files to clean up after the suite. */
const saStorePaths: string[] = [];
function newServiceAccountStore(): ServiceAccountStore {
  const p = join(tmpdir(), `mp-sa-test-${randomBytes(6).toString("hex")}.json`);
  saStorePaths.push(p);
  return new ServiceAccountStore(p);
}
function newServiceAccountStoreWithPath(): { serviceAccounts: ServiceAccountStore; path: string } {
  const p = join(tmpdir(), `mp-sa-test-${randomBytes(6).toString("hex")}.json`);
  saStorePaths.push(p);
  return { serviceAccounts: new ServiceAccountStore(p), path: p };
}
function newGrantStore(): AgentGrantStore {
  const p = join(tmpdir(), `mp-grants-test-${randomBytes(6).toString("hex")}.json`);
  saStorePaths.push(p);
  return new AgentGrantStore(p);
}
function newGrantStoreWithPath(): { grants: AgentGrantStore; path: string } {
  const p = join(tmpdir(), `mp-grants-test-${randomBytes(6).toString("hex")}.json`);
  saStorePaths.push(p);
  return { grants: new AgentGrantStore(p), path: p };
}
/** Fetch an access token via the client_credentials grant (HTTP Basic). */
async function clientCredentialsToken(url: string, clientId: string, secret: string): Promise<{ status: number; token: string }> {
  const res = await fetch(`${url}/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + Buffer.from(`${clientId}:${secret}`).toString("base64"),
    },
    body: "grant_type=client_credentials",
  });
  let token = "";
  try { token = ((await res.json()) as { access_token?: string }).access_token ?? ""; } catch { /* error body */ }
  return { status: res.status, token };
}

async function mcpInitialize(url: string, token: string): Promise<Response> {
  return fetch(`${url}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "test", version: "0" },
      },
    }),
  });
}

async function issuePendingInteractiveToken(url: string): Promise<{ clientId: string; token: string }> {
  const redirectUri = "http://localhost:9999/cb";
  const registered = await fetch(`${url}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirectUri], client_name: "pending HTTP test" }),
  });
  const { client_id: clientId } = await registered.json() as { client_id: string };
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorize = await fetch(`${url}/oauth/authorize?${new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString()}`, { redirect: "manual" });
  const code = new URL(authorize.headers.get("location") ?? redirectUri).searchParams.get("code") ?? "";
  const tokenResponse = await fetch(`${url}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }).toString(),
  });
  const { access_token: token } = await tokenResponse.json() as { access_token: string };
  return { clientId, token };
}

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

afterEach(() => {
  // Clean up any temp service-account stores created during a test.
  while (saStorePaths.length) {
    const p = saStorePaths.pop();
    if (!p) continue;
    for (const suffix of ["", ".quota.sqlite", ".quota.sqlite-wal", ".quota.sqlite-shm", ".quota.sqlite-journal"]) {
      try { rmSync(p + suffix, { recursive: suffix === "", force: true }); } catch { /* ignore */ }
    }
  }
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
      oauthEnabled: true,
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
      oauthEnabled: true,
    });
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/Bearer/i);
  });

  it("rejects MCP requests with a bearer that is not an issued OAuth token", async () => {
    const port = await freePort();
    handle = await startHttpTransport({
      server: buildServer(),
      port,
      host: "127.0.0.1",
      oauthEnabled: true,
    });
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer not-a-real-token" },
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
      oauthEnabled: true,
    });
    const res = await fetch(`http://127.0.0.1:${port}/elsewhere`);
    expect(res.status).toBe(404);
  });

  it("throws when started without OAuth (static bearer was removed)", async () => {
    const port = await freePort();
    await expect(
      startHttpTransport({ server: buildServer(), port, oauthEnabled: false }),
    ).rejects.toThrow(/OAuth|remoteOauthEnabled/);
  });

  it("XPORT-015 — never advertises 0.0.0.0 as the OAuth issuer host", async () => {
    const port = await freePort();
    handle = await startHttpTransport({
      server: buildServer(),
      port,
      host: "0.0.0.0",
      oauthEnabled: true,
    });
    expect(handle.issuer).toBeDefined();
    expect(handle.issuer).not.toContain("0.0.0.0");
    expect(handle.issuer).toContain("127.0.0.1");
  });

  it("dispatches an authed tools/list round-trip via a client_credentials token", async () => {
    const port = await freePort();
    const sa = newServiceAccountStore();
    const { account, clientSecret } = sa.issue({ name: "round-trip", preset: "full" });
    handle = await startHttpTransport({
      server: buildServer(),
      port,
      host: "127.0.0.1",
      oauthEnabled: true,
      serviceAccounts: sa,
    });
    const url = `http://127.0.0.1:${port}`;
    const { status, token } = await clientCredentialsToken(url, account.clientId, clientSecret);
    expect(status).toBe(200);
    expect(token).toBeTruthy();
    // StreamableHTTP requires the client to first POST an `initialize` message,
    // carrying the issued bearer.
    const initRes = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
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
    expect(initRes.status).toBeLessThan(400);
  });

  it("freshly rejects and revokes existing bearer tokens after an external grant revocation", async () => {
    const port = await freePort();
    const serviceAccounts = newServiceAccountStore();
    const { grants, path } = newGrantStoreWithPath();
    const { account, clientSecret } = serviceAccounts.issue({ name: "externally-revoked", preset: "full" });
    grants.ensureActiveServiceGrant({
      clientId: account.clientId,
      clientName: account.clientName,
      preset: account.preset,
      conditions: account.conditions,
    });
    handle = await startHttpTransport({
      server: buildServer(),
      port,
      host: "127.0.0.1",
      oauthEnabled: true,
      serviceAccounts,
      agentGrants: grants,
    });
    const url = `http://127.0.0.1:${port}`;
    const first = await clientCredentialsToken(url, account.clientId, clientSecret);
    const second = await clientCredentialsToken(url, account.clientId, clientSecret);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    // Simulate another process writing the authoritative grant file. This
    // intentionally emits no in-process notification, proving the bearer
    // gate's fresh snapshot instead of its existing notification fast path.
    const external = JSON.parse(readFileSync(path, "utf-8")) as { grants: Array<Record<string, unknown>> };
    const grant = external.grants.find(candidate => candidate.clientId === account.clientId)!;
    grant.status = "revoked";
    grant.revokedAt = new Date().toISOString();
    writeOwnerOnlyJsonAtomically(path, external);
    expect(grants.get(account.clientId)?.status).toBe("active");

    expect((await mcpInitialize(url, first.token)).status).toBe(401);
    // The first definitive revoked snapshot purges every cached bearer for
    // this client, not merely the token used in that request.
    expect((await mcpInitialize(url, second.token)).status).toBe(401);
  });

  it("freshly revokes orphaned service-account bearers after an external credential deletion", async () => {
    const port = await freePort();
    const { serviceAccounts, path: servicePath } = newServiceAccountStoreWithPath();
    const { grants } = newGrantStoreWithPath();
    const { account, clientSecret } = serviceAccounts.issue({ name: "externally-deleted-service-account", preset: "full" });
    grants.ensureActiveServiceGrant({
      clientId: account.clientId,
      clientName: account.clientName,
      preset: account.preset,
      conditions: account.conditions,
    });
    handle = await startHttpTransport({
      server: buildServer(), port, host: "127.0.0.1", oauthEnabled: true, serviceAccounts, agentGrants: grants,
    });
    const url = `http://127.0.0.1:${port}`;
    const first = await clientCredentialsToken(url, account.clientId, clientSecret);
    const second = await clientCredentialsToken(url, account.clientId, clientSecret);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(grants.getAuthorizationSnapshot(account.clientId)).toMatchObject({
      kind: "present", grant: { credentialKind: "service_account", status: "active" },
    });

    // Simulate an interrupted cross-file revoke: an external process removes
    // the credential but has not yet changed the matching active grant. No
    // AgentGrant notification is emitted and serviceAccounts.get() is stale.
    const savedServiceFile = JSON.parse(readFileSync(servicePath, "utf-8"));
    const external = JSON.parse(readFileSync(servicePath, "utf-8")) as { accounts: Array<Record<string, unknown>> };
    external.accounts = external.accounts.filter(entry => entry.clientId !== account.clientId);
    writeOwnerOnlyJsonAtomically(servicePath, external);
    expect(serviceAccounts.get(account.clientId)).toBeDefined();

    expect((await mcpInitialize(url, first.token)).status).toBe(401);
    // A definitive missing credential revokes every bearer for the client.
    expect((await mcpInitialize(url, second.token)).status).toBe(401);

    // Restore the credential file. The old bearer stays revoked, but a fresh
    // client_credentials exchange recovers normally once durable authority is
    // consistent again.
    writeOwnerOnlyJsonAtomically(servicePath, savedServiceFile);
    expect((await mcpInitialize(url, first.token)).status).toBe(401);
    const recovered = await clientCredentialsToken(url, account.clientId, clientSecret);
    expect(recovered.status).toBe(200);
    expect((await mcpInitialize(url, recovered.token)).status).toBeLessThan(400);
  });

  it("fails closed on an unavailable service-account source without purging its bearer", async () => {
    const port = await freePort();
    const { serviceAccounts, path: servicePath } = newServiceAccountStoreWithPath();
    const { grants } = newGrantStoreWithPath();
    const { account, clientSecret } = serviceAccounts.issue({ name: "transient-service-source", preset: "full" });
    grants.ensureActiveServiceGrant({
      clientId: account.clientId,
      clientName: account.clientName,
      preset: account.preset,
      conditions: account.conditions,
    });
    handle = await startHttpTransport({
      server: buildServer(), port, host: "127.0.0.1", oauthEnabled: true, serviceAccounts, agentGrants: grants,
    });
    const url = `http://127.0.0.1:${port}`;
    const issued = await clientCredentialsToken(url, account.clientId, clientSecret);
    expect(issued.status).toBe(200);
    const goodServiceFile = JSON.parse(readFileSync(servicePath, "utf-8"));

    writeFileSync(servicePath, "{ malformed", "utf-8");
    // The credential exchange itself must not mint a new bearer from its
    // stale in-memory map while the authoritative source is unavailable.
    expect((await clientCredentialsToken(url, account.clientId, clientSecret)).status).toBe(401);
    expect((await mcpInitialize(url, issued.token)).status).toBe(401);

    // This is not definitive revocation. Restoring the exact credential file
    // must make the same cached bearer usable again without a new OAuth flow.
    writeOwnerOnlyJsonAtomically(servicePath, goodServiceFile);
    expect((await mcpInitialize(url, issued.token)).status).toBeLessThan(400);
  });

  it("fails closed on corrupt or unreadable fresh grants without irreversibly purging the bearer", async () => {
    const port = await freePort();
    const serviceAccounts = newServiceAccountStore();
    const { grants, path } = newGrantStoreWithPath();
    const { account, clientSecret } = serviceAccounts.issue({ name: "transient-grant-file", preset: "full" });
    grants.ensureActiveServiceGrant({ clientId: account.clientId, clientName: account.clientName, preset: account.preset });
    handle = await startHttpTransport({
      server: buildServer(), port, host: "127.0.0.1", oauthEnabled: true, serviceAccounts, agentGrants: grants,
    });
    const url = `http://127.0.0.1:${port}`;
    const issued = await clientCredentialsToken(url, account.clientId, clientSecret);
    expect(issued.status).toBe(200);
    const goodGrantFile = JSON.parse(readFileSync(path, "utf-8"));

    writeFileSync(path, "{ malformed", "utf-8");
    expect((await mcpInitialize(url, issued.token)).status).toBe(401);

    // EISDIR represents the same security boundary as an unreadable file. It
    // must remain unavailable (not "missing"), or the transport would purge
    // a bearer based on a transient filesystem failure. A directory produces
    // a deterministic non-ENOENT read error without depending on chmod.
    rmSync(path, { force: true });
    mkdirSync(path, { mode: 0o700 });
    expect((await mcpInitialize(url, issued.token)).status).toBe(401);
    rmSync(path, { recursive: true, force: true });
    writeOwnerOnlyJsonAtomically(path, goodGrantFile);
    // Reuse the SAME token after both transient failures. A purge caused by
    // either malformed JSON or EISDIR would leave this request at 401.
    expect((await mcpInitialize(url, issued.token)).status).toBeLessThan(400);
  });

  it("preserves pending bearer behavior for the dispatcher to report approval status", async () => {
    const port = await freePort();
    const grants = newGrantStore();
    const { serviceAccounts, path: servicePath } = newServiceAccountStoreWithPath();
    handle = await startHttpTransport({
      server: buildServer(), port, host: "127.0.0.1", oauthEnabled: true, agentGrants: grants, serviceAccounts,
    });
    // A pending DCR grant is interactive, not credential-backed. Even a
    // transiently unreadable service-account store must not turn it into a
    // service grant or change the transport's pending behavior.
    writeFileSync(servicePath, "{ malformed", "utf-8");
    const url = `http://127.0.0.1:${port}`;
    const pending = await issuePendingInteractiveToken(url);
    expect(grants.getAuthorizationSnapshot(pending.clientId)).toMatchObject({
      kind: "present",
      grant: { status: "pending" },
    });
    // HTTP authenticates the bearer; the full MCP dispatcher owns the
    // user-facing pending-grant denial/audit when the real server is wired.
    expect((await mcpInitialize(url, pending.token)).status).toBeLessThan(400);
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

    // The shared static bearer was removed — an arbitrary pre-shared token is
    // never accepted; only OAuth-issued tokens authenticate.
    it("rejects an arbitrary (non-OAuth) bearer token", async () => {
      const port = await freePort();
      handle = await startHttpTransport({
        server: buildServer(),
        port,
        host: "127.0.0.1",
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
      const body = await res.json() as { issuer: string; token_endpoint: string; code_challenge_methods_supported: string[]; grant_types_supported: string[]; token_endpoint_auth_methods_supported: string[] };
      expect(body.issuer).toMatch(/^http:\/\/127\.0\.0\.1:/);
      expect(body.token_endpoint).toContain("/oauth/token");
      expect(body.code_challenge_methods_supported).toContain("S256");
      // Both grant types are advertised, plus the client_secret auth methods
      // the client_credentials flow needs.
      expect(body.grant_types_supported).toContain("authorization_code");
      expect(body.grant_types_supported).toContain("client_credentials");
      expect(body.token_endpoint_auth_methods_supported).toContain("client_secret_basic");
    });

    describe("client_credentials grant (service accounts)", () => {
      it("issues a token for a valid service account via HTTP Basic", async () => {
        const port = await freePort();
        const sa = newServiceAccountStore();
        const { account, clientSecret } = sa.issue({ name: "cc-ok", preset: "read_only" });
        handle = await startHttpTransport({ server: buildServer(), port, host: "127.0.0.1", oauthEnabled: true, serviceAccounts: sa });
        const { status, token } = await clientCredentialsToken(`http://127.0.0.1:${port}`, account.clientId, clientSecret);
        expect(status).toBe(200);
        expect(token).toBeTruthy();
      });

      it("issues a token when client_id/client_secret are in the form body", async () => {
        const port = await freePort();
        const sa = newServiceAccountStore();
        const { account, clientSecret } = sa.issue({ name: "cc-body", preset: "read_only" });
        handle = await startHttpTransport({ server: buildServer(), port, host: "127.0.0.1", oauthEnabled: true, serviceAccounts: sa });
        const res = await fetch(`http://127.0.0.1:${port}/oauth/token`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "client_credentials", client_id: account.clientId, client_secret: clientSecret }).toString(),
        });
        expect(res.status).toBe(200);
        expect(((await res.json()) as { access_token?: string }).access_token).toBeTruthy();
      });

      it("rejects a wrong secret with 401 invalid_client", async () => {
        const port = await freePort();
        const sa = newServiceAccountStore();
        const { account } = sa.issue({ name: "cc-bad", preset: "read_only" });
        handle = await startHttpTransport({ server: buildServer(), port, host: "127.0.0.1", oauthEnabled: true, serviceAccounts: sa });
        const { status } = await clientCredentialsToken(`http://127.0.0.1:${port}`, account.clientId, "wrong-secret");
        expect(status).toBe(401);
      });

      it("rejects an unknown client_id with 401 invalid_client", async () => {
        const port = await freePort();
        const sa = newServiceAccountStore();
        handle = await startHttpTransport({ server: buildServer(), port, host: "127.0.0.1", oauthEnabled: true, serviceAccounts: sa });
        const { status } = await clientCredentialsToken(`http://127.0.0.1:${port}`, "pmc_does_not_exist", "whatever");
        expect(status).toBe(401);
      });

      it("rejects client_credentials when no service accounts are wired", async () => {
        const { url } = await startOauth();
        const { status } = await clientCredentialsToken(url, "pmc_x", "y");
        expect(status).toBe(401);
      });

      it("re-activates a revoked service-account grant on login (live re-auth, no restart)", async () => {
        const port = await freePort();
        const sa = newServiceAccountStore();
        const grants = newGrantStore();
        const { account, clientSecret } = sa.issue({ name: "reauth", preset: "supervised" });
        // Simulate the account having been revoked while the daemon ran.
        grants.ensureActiveServiceGrant({ clientId: account.clientId, clientName: account.clientName, preset: account.preset });
        grants.revoke(account.clientId);
        expect(grants.get(account.clientId)?.status).toBe("revoked");
        handle = await startHttpTransport({ server: buildServer(), port, host: "127.0.0.1", oauthEnabled: true, serviceAccounts: sa, agentGrants: grants });
        const { status } = await clientCredentialsToken(`http://127.0.0.1:${port}`, account.clientId, clientSecret);
        expect(status).toBe(200);
        // A successful login re-activated the grant in the running store.
        expect(grants.get(account.clientId)?.status).toBe("active");
      });
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
    const sa = newServiceAccountStore();
    const { account, clientSecret } = sa.issue({ name: "rl", preset: "full" });
    handle = await startHttpTransport({
      server: buildServer(),
      port,
      host: "127.0.0.1",
      oauthEnabled: true,
      serviceAccounts: sa,
      rateLimitPerSecond: 1,
      rateLimitBurst: 2,
    });
    const url = `http://127.0.0.1:${port}`;
    const { token } = await clientCredentialsToken(url, account.clientId, clientSecret);
    // auth bucket is 3x the burst (see http.ts), so burst=2 ⇒ authed cap ≈ 6.
    const responses = await Promise.all(
      Array.from({ length: 15 }, () =>
        fetch(`${url}/mcp`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        }),
      ),
    );
    expect(responses.map(r => r.status)).toContain(429);
  });

  it("returns 500 when the transport handler throws", async () => {
    const port = await freePort();
    const sa = newServiceAccountStore();
    const { account, clientSecret } = sa.issue({ name: "err", preset: "full" });
    handle = await startHttpTransport({
      server: buildServer(),
      port,
      host: "127.0.0.1",
      oauthEnabled: true,
      serviceAccounts: sa,
    });
    const url = `http://127.0.0.1:${port}`;
    const { token } = await clientCredentialsToken(url, account.clientId, clientSecret);
    // A deliberately malformed JSON body — readJsonBody throws after auth, the
    // listener catches, writes 500.
    const res = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: "{malformed json",
    });
    expect(res.status).toBe(500);
  });

  it("rejects bodies that exceed the size cap", async () => {
    const port = await freePort();
    const sa = newServiceAccountStore();
    const { account, clientSecret } = sa.issue({ name: "big", preset: "full" });
    handle = await startHttpTransport({
      server: buildServer(),
      port,
      host: "127.0.0.1",
      oauthEnabled: true,
      serviceAccounts: sa,
    });
    const url = `http://127.0.0.1:${port}`;
    const { token } = await clientCredentialsToken(url, account.clientId, clientSecret);
    // Build a 2 MB JSON payload (default cap is 1 MB).
    const big = "x".repeat(2_100_000);
    const res = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
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
