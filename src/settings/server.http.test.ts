/**
 * HTTP-level tests for the settings server request handler.
 *
 * Covers the v3.0.60 UI/CSP hardening batch:
 *   - UI-002: main UI CSP drops 'unsafe-inline' from script-src.
 *   - UI-003: /agent-setup CSP locks script-src to 'self' (no inline scripts).
 *   - UI-006: POST /api/shutdown routes through onShutdownRequested instead of
 *             calling process.exit directly (so tray cleanup runs).
 *   - UI-009: POST /api/write-claude-desktop bails on an unparseable existing
 *             config rather than clobbering it.
 *   - UI-011: POST /api/agents/:id/approve strips unknown / prototype-polluting
 *             condition + toolOverride keys.
 */

import { describe, it, expect, vi, afterAll } from "vitest";
import http from "node:http";
import { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSettingsServer } from "./server.js";
import { generateAccessToken } from "./security.js";
import { AgentGrantStore } from "../agents/grant-store.js";
import { AgentAuditLog } from "../agents/audit.js";
import { ServiceAccountStore } from "../agents/service-account-store.js";
import { registerAgentServices } from "../agents/registry.js";
import { readRegistry } from "../accounts/registry.js";

interface Resp { status: number; headers: http.IncomingHttpHeaders; body: string; }

function listen(handler: http.Server): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    handler.listen(0, "127.0.0.1", () => {
      const port = (handler.address() as AddressInfo).port;
      resolve({ port, close: () => handler.close() });
    });
  });
}

function request(
  port: number,
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: string } = {},
): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method, path, headers: opts.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function csrfFrom(port: number): Promise<string> {
  const res = await request(port, "GET", "/");
  const m = /<meta name="csrf-token" content="([^"]+)">/.exec(res.body);
  if (!m) throw new Error("no csrf token in shell HTML");
  return m[1];
}

describe("settings server CSP headers", () => {
  it("rejects a DNS-rebinding Host before returning shell or CSRF content", async () => {
    const srv = createSettingsServer({ port: 8765, lan: false, accessToken: null, scheme: "http" });
    const { port, close } = await listen(srv);
    try {
      const res = await request(port, "GET", "/", { headers: { host: `evil.example:${port}` } });
      expect(res.status).toBe(421);
      expect(res.body).toContain("Host not permitted");
      expect(res.body).not.toContain("csrf-token");
    } finally {
      close();
    }
  });

  it("UI-002: main UI script-src carries a nonce and no 'unsafe-inline'", async () => {
    const srv = createSettingsServer({ port: 8765, lan: false, accessToken: null, scheme: "http" });
    const { port, close } = await listen(srv);
    try {
      const res = await request(port, "GET", "/");
      const csp = String(res.headers["content-security-policy"]);
      expect(csp).toMatch(/script-src 'nonce-[^']+'/);
      expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    } finally {
      close();
    }
  });

  it("UI-003: /agent-setup locks script-src to 'self' and escapes interpolations", async () => {
    const srv = createSettingsServer({ port: 8765, lan: false, accessToken: null, scheme: "http" });
    const { port, close } = await listen(srv);
    try {
      const res = await request(port, "GET", "/agent-setup");
      const csp = String(res.headers["content-security-policy"]);
      expect(csp).toContain("script-src 'self'");
      expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
      // The page must not contain a raw <script> we forgot to remove.
      expect(res.body).not.toMatch(/<script\b/);
    } finally {
      close();
    }
  });
});

describe("settings server error disclosure", () => {
  it("does not return filesystem errors or stack details to API callers", async () => {
    const privatePath = mkdtempSync(join(tmpdir(), "mailpouch-log-directory-"));
    const previousLogPath = process.env.MAILPOUCH_LOG_FILE;
    process.env.MAILPOUCH_LOG_FILE = privatePath;
    const srv = createSettingsServer({ port: 8765, lan: false, accessToken: null, scheme: "http" });
    const { port, close } = await listen(srv);
    try {
      // Reading a directory as a log file fails with a platform-specific error
      // containing an internal path. The API must expose only a stable message.
      const res = await request(port, "GET", "/api/logs");
      expect(res.status).toBe(500);
      expect(JSON.parse(res.body)).toEqual({ error: "Could not read the log file." });
      expect(res.body).not.toContain(privatePath);
      expect(res.body).not.toMatch(/EISDIR|EPERM|at [A-Za-z].*\(/);
    } finally {
      close();
      if (previousLogPath === undefined) delete process.env.MAILPOUCH_LOG_FILE;
      else process.env.MAILPOUCH_LOG_FILE = previousLogPath;
      rmSync(privatePath, { recursive: true, force: true });
    }
  });
});

describe("LAN settings bootstrap session", () => {
  it("exchanges the query bearer for a clean, HttpOnly browser session that authorizes API calls", async () => {
    const accessToken = generateAccessToken();
    const srv = createSettingsServer({ port: 8765, lan: true, accessToken, scheme: "http" });
    const { port, close } = await listen(srv);
    try {
      // The shell and API remain inaccessible before a browser session exists.
      const deniedShell = await request(port, "GET", "/");
      expect(deniedShell.status).toBe(401);
      const deniedApi = await request(port, "GET", "/api/status");
      expect(deniedApi.status).toBe(401);
      expect(JSON.parse(deniedApi.body)).toMatchObject({ code: "lan_session_required" });

      // Browser bootstrap uses the unavoidable query token once, then the
      // server sends no HTML and redirects to a URL without the bearer.
      const bootstrap = await request(port, "GET", `/?token=${accessToken.value}`);
      expect(bootstrap.status).toBe(303);
      expect(bootstrap.headers.location).toBe("/");
      expect(bootstrap.body).not.toContain(accessToken.value);
      const setCookie = bootstrap.headers["set-cookie"];
      expect(setCookie).toHaveLength(1);
      const cookie = setCookie![0];
      expect(cookie).toMatch(/^mailpouch_settings_session=[A-Za-z0-9_-]{43};/);
      expect(cookie).toContain("Path=/");
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Strict");
      expect(cookie).not.toContain("Secure");
      expect(cookie).not.toContain(accessToken.value);
      const sessionCookie = cookie.split(";", 1)[0];

      // Relative browser fetches send this same-origin cookie automatically;
      // no JavaScript needs to retain or replay the original LAN bearer.
      const shell = await request(port, "GET", "/", { headers: { cookie: sessionCookie } });
      expect(shell.status).toBe(200);
      expect(shell.body).not.toContain(accessToken.value);
      const sessionApi = await request(port, "GET", "/api/status", { headers: { cookie: sessionCookie } });
      expect(sessionApi.status).toBe(200);

      // Query strings never authorize API calls, even after a valid bootstrap.
      const queryApi = await request(port, "GET", `/api/status?token=${accessToken.value}`);
      expect(queryApi.status).toBe(401);

      // Non-browser clients retain their supported header-auth path.
      const headerApi = await request(port, "GET", "/api/status", {
        headers: { "x-access-token": accessToken.value },
      });
      expect(headerApi.status).toBe(200);

      // Pasting the bootstrap URL again cannot put the bearer back in the page.
      const repeatedBootstrap = await request(port, "GET", `/?token=${accessToken.value}`, {
        headers: { cookie: sessionCookie },
      });
      expect(repeatedBootstrap.status).toBe(303);
      expect(repeatedBootstrap.headers.location).toBe("/");
      expect(repeatedBootstrap.headers["set-cookie"]).toBeUndefined();
    } finally {
      close();
    }
  });

  it("marks the exchanged cookie Secure when LAN settings are served over HTTPS", async () => {
    const accessToken = generateAccessToken();
    // The request handler is intentionally tested over HTTP here; `scheme`
    // controls the real deployment's cookie attributes while startSettingsServer
    // supplies the HTTPS wrapper in production.
    const srv = createSettingsServer({ port: 8765, lan: true, accessToken, scheme: "https" });
    const { port, close } = await listen(srv);
    try {
      const bootstrap = await request(port, "GET", `/?token=${accessToken.value}`);
      expect(bootstrap.status).toBe(303);
      expect(bootstrap.headers["set-cookie"]![0]).toContain("Secure");
    } finally {
      close();
    }
  });

  it("keeps local settings behavior cookie-free and unauthenticated", async () => {
    const srv = createSettingsServer({ port: 8765, lan: false, accessToken: null, scheme: "http" });
    const { port, close } = await listen(srv);
    try {
      expect((await request(port, "GET", "/")).status).toBe(200);
      expect((await request(port, "GET", "/api/status")).status).toBe(200);
    } finally {
      close();
    }
  });
});

describe("UI-011: approve endpoint validates conditions/toolOverrides", () => {
  const tmp = mkdtempSync(join(tmpdir(), "mp-grants-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it("rejects malformed or unknown conditions without widening the pending grant", async () => {
    const grants = new AgentGrantStore(join(tmp, "grants.json"));
    const audit = new AgentAuditLog({ path: join(tmp, "audit.jsonl") });
    registerAgentServices(grants, audit);
    grants.createPending({ clientId: "client_abc", clientName: "Test" });

    const srv = createSettingsServer({ port: 8765, lan: false, accessToken: null, scheme: "http" });
    const { port, close } = await listen(srv);
    try {
      const token = await csrfFrom(port);
      // Build the JSON by hand: `{ __proto__: ... }` in an object literal sets the
      // prototype (and JSON.stringify omits it), so it would never reach the wire.
      // A raw JSON string carries a literal enumerable "__proto__" key — what an
      // attacker actually sends, and what JSON.parse turns into an own property
      // the sanitizer must strip.
      const payload = '{"preset":"read_only",'
        + '"toolOverrides":{"get_emails":true,"bogus_tool":true,"__proto__":{"isAdmin":true}},'
        + '"conditions":{"folderAllowlist":["INBOX",123],'
        + '"maxCallsPerHourByTool":{"get_emails":0,"bulk_delete":1,"send_email":1.5,"get_unread_count":10001,"bogus_tool":3},'
        + '"evilKey":"x","__proto__":{"polluted":true}}}';
      const res = await request(port, "POST", "/api/agents/client_abc/approve", {
        headers: { "x-csrf-token": token, origin: `http://127.0.0.1:${port}`, "content-type": "application/json" },
        body: payload,
      });
      expect(res.status).toBe(400);

      // Object.prototype must not have been polluted.
      expect(({} as Record<string, unknown>).isAdmin).toBeUndefined();
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();

      const stored = grants.get("client_abc")!;
      expect(stored.status).toBe("pending");
      expect(stored.toolOverrides).toBeUndefined();
      expect(stored.conditions).toBeUndefined();
    } finally {
      close();
    }
  });

  it("preserves a valid per-tool cap when issuing a service account", async () => {
    const grants = new AgentGrantStore(join(tmp, "service-grants.json"));
    const audit = new AgentAuditLog({ path: join(tmp, "service-audit.jsonl") });
    const serviceAccounts = new ServiceAccountStore(join(tmp, "service-accounts.json"));
    registerAgentServices(grants, audit, serviceAccounts);

    const srv = createSettingsServer({ port: 8765, lan: false, accessToken: null, scheme: "http" });
    const { port, close } = await listen(srv);
    try {
      const token = await csrfFrom(port);
      const accountId = readRegistry().activeAccountId;
      const res = await request(port, "POST", "/api/agents/service-account", {
        headers: { "x-csrf-token": token, origin: `http://127.0.0.1:${port}`, "content-type": "application/json" },
        body: JSON.stringify({
          name: "capped cron",
          preset: "full",
          conditions: {
            accountId,
            maxCallsPerHourByTool: {
              bulk_delete: 2,
            },
          },
        }),
      });
      expect(res.status).toBe(201);
      const issued = JSON.parse(res.body) as { clientId: string };
      expect(serviceAccounts.get(issued.clientId)?.conditions?.maxCallsPerHourByTool).toEqual({
        bulk_delete_emails: 2,
      });
      expect(serviceAccounts.get(issued.clientId)?.conditions).toMatchObject({
        accountId,
        accountIdentity: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      // The active grant mirrored for token use carries exactly the same cap.
      expect(grants.get(issued.clientId)?.conditions?.maxCallsPerHourByTool).toEqual({
        bulk_delete_emails: 2,
      });
    } finally {
      close();
    }
  });

  it("binds an approved interactive grant to the configured mailbox identity", async () => {
    const grants = new AgentGrantStore(join(tmp, "identity-grants.json"));
    const audit = new AgentAuditLog({ path: join(tmp, "identity-audit.jsonl") });
    registerAgentServices(grants, audit);
    grants.createPending({ clientId: "client_identity", clientName: "Identity Test" });

    const srv = createSettingsServer({ port: 8765, lan: false, accessToken: null, scheme: "http" });
    const { port, close } = await listen(srv);
    try {
      const token = await csrfFrom(port);
      const accountId = readRegistry().activeAccountId;
      const res = await request(port, "POST", "/api/agents/client_identity/approve", {
        headers: { "x-csrf-token": token, origin: `http://127.0.0.1:${port}`, "content-type": "application/json" },
        body: JSON.stringify({ preset: "read_only", conditions: { accountId } }),
      });
      expect(res.status).toBe(200);
      expect(grants.get("client_identity")?.conditions).toMatchObject({
        accountId,
        accountIdentity: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
    } finally {
      close();
    }
  });

  it("does not issue a service credential when a requested restriction is malformed", async () => {
    const grants = new AgentGrantStore(join(tmp, "invalid-service-grants.json"));
    const audit = new AgentAuditLog({ path: join(tmp, "invalid-service-audit.jsonl") });
    const serviceAccounts = new ServiceAccountStore(join(tmp, "invalid-service-accounts.json"));
    registerAgentServices(grants, audit, serviceAccounts);

    const srv = createSettingsServer({ port: 8765, lan: false, accessToken: null, scheme: "http" });
    const { port, close } = await listen(srv);
    try {
      const token = await csrfFrom(port);
      const res = await request(port, "POST", "/api/agents/service-account", {
        headers: { "x-csrf-token": token, origin: `http://127.0.0.1:${port}`, "content-type": "application/json" },
        body: JSON.stringify({
          name: "must stay capped",
          preset: "full",
          conditions: { maxCallsPerHourByTool: { send_email: "1" } },
        }),
      });
      expect(res.status).toBe(400);
      expect(serviceAccounts.list()).toEqual([]);
      expect(grants.list()).toEqual([]);
    } finally {
      close();
    }
  });
});

describe("UI-006: POST /api/shutdown routes through onShutdownRequested", () => {
  it("invokes the callback instead of process.exit when one is wired", async () => {
    const onShutdownRequested = vi.fn();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const srv = createSettingsServer({ port: 8765, lan: false, accessToken: null, scheme: "http", onShutdownRequested });
    const { port, close } = await listen(srv);
    try {
      const token = await csrfFrom(port);
      const res = await request(port, "POST", "/api/shutdown", {
        headers: { "x-csrf-token": token, origin: `http://127.0.0.1:${port}` },
      });
      expect(res.status).toBe(200);
      // Handler flushes the response then fires the callback after ~300ms.
      await new Promise((r) => setTimeout(r, 500));
      expect(onShutdownRequested).toHaveBeenCalledTimes(1);
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
      close();
    }
  });
});
