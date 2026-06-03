/**
 * POST /api/write-claude-code merges a mailpouch entry into ~/.claude.json for
 * the requested transport (stdio | http), preserves other mcpServers, and
 * refuses to clobber an unparseable file. Mocks os.homedir() so ~/.claude.json
 * resolves into a throwaway temp dir.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import http from "node:http";
import { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_HOME = mkdtempSync(join(tmpdir(), "mp-cctest-"));

vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  return { ...actual, homedir: () => TMP_HOME, default: { ...actual, homedir: () => TMP_HOME } };
});

const cfgPath = join(TMP_HOME, ".claude.json");

let createSettingsServer: typeof import("./server.js").createSettingsServer;

beforeAll(async () => {
  ({ createSettingsServer } = await import("./server.js"));
});

afterAll(() => rmSync(TMP_HOME, { recursive: true, force: true }));

interface Resp { status: number; body: string; }

function listen(srv: http.Server): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) =>
    srv.listen(0, "127.0.0.1", () =>
      resolve({ port: (srv.address() as AddressInfo).port, close: () => srv.close() }),
    ),
  );
}

function request(port: number, method: string, path: string, headers: Record<string, string>, body?: string): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function csrfFrom(port: number): Promise<string> {
  const res = await request(port, "GET", "/", {});
  return /<meta name="csrf-token" content="([^"]+)">/.exec(res.body)![1];
}

function writeClaudeCode(port: number, token: string, body: string): Promise<Resp> {
  return request(
    port,
    "POST",
    "/api/write-claude-code",
    { "x-csrf-token": token, origin: `http://127.0.0.1:${port}`, "content-type": "application/json" },
    body,
  );
}

describe("POST /api/write-claude-code", () => {
  it("writes a stdio entry (with MAILPOUCH_FORCE_STDIO) and preserves other servers", async () => {
    writeFileSync(cfgPath, JSON.stringify({ mcpServers: { other: { command: "x" } } }), "utf8");
    const srv = createSettingsServer({ port: 8765, lan: false, accessToken: null, scheme: "http" });
    const { port, close } = await listen(srv);
    try {
      const token = await csrfFrom(port);
      const res = await writeClaudeCode(port, token, JSON.stringify({ transport: "stdio" }));
      const parsed = JSON.parse(res.body);
      expect(parsed.ok).toBe(true);
      expect(parsed.transport).toBe("stdio");
      const after = JSON.parse(readFileSync(cfgPath, "utf8"));
      expect(after.mcpServers.other).toBeDefined();              // preserved
      expect(after.mcpServers.mailpouch.type).toBe("stdio");
      expect(after.mcpServers.mailpouch.env.MAILPOUCH_FORCE_STDIO).toBe("1");
    } finally {
      close();
    }
  });

  it("defaults to a stdio entry when no transport is given", async () => {
    writeFileSync(cfgPath, JSON.stringify({ mcpServers: {} }), "utf8");
    const srv = createSettingsServer({ port: 8765, lan: false, accessToken: null, scheme: "http" });
    const { port, close } = await listen(srv);
    try {
      const token = await csrfFrom(port);
      const res = await writeClaudeCode(port, token, "{}");
      expect(JSON.parse(res.body).transport).toBe("stdio");
      expect(JSON.parse(readFileSync(cfgPath, "utf8")).mcpServers.mailpouch.type).toBe("stdio");
    } finally {
      close();
    }
  });

  it("writes an http entry pointing at the /mcp endpoint", async () => {
    writeFileSync(cfgPath, JSON.stringify({ mcpServers: {} }), "utf8");
    const srv = createSettingsServer({ port: 8765, lan: false, accessToken: null, scheme: "http" });
    const { port, close } = await listen(srv);
    try {
      const token = await csrfFrom(port);
      const res = await writeClaudeCode(port, token, JSON.stringify({ transport: "http" }));
      const parsed = JSON.parse(res.body);
      expect(parsed.ok).toBe(true);
      expect(parsed.transport).toBe("http");
      const entry = JSON.parse(readFileSync(cfgPath, "utf8")).mcpServers.mailpouch;
      expect(entry.type).toBe("http");
      expect(entry.url).toMatch(/\/mcp$/);
    } finally {
      close();
    }
  });

  it("refuses to clobber an unparseable ~/.claude.json", async () => {
    const original = "{ not: valid json }";
    writeFileSync(cfgPath, original, "utf8");
    const srv = createSettingsServer({ port: 8765, lan: false, accessToken: null, scheme: "http" });
    const { port, close } = await listen(srv);
    try {
      const token = await csrfFrom(port);
      const res = await writeClaudeCode(port, token, JSON.stringify({ transport: "stdio" }));
      const parsed = JSON.parse(res.body);
      expect(parsed.ok).toBe(false);
      expect(String(parsed.error)).toMatch(/parsed/i);
      expect(readFileSync(cfgPath, "utf8")).toBe(original);      // untouched
    } finally {
      close();
    }
  });

  it("GET /api/claude-code-status reports the config path", async () => {
    writeFileSync(cfgPath, JSON.stringify({ mcpServers: {} }), "utf8");
    const srv = createSettingsServer({ port: 8765, lan: false, accessToken: null, scheme: "http" });
    const { port, close } = await listen(srv);
    try {
      const res = await request(port, "GET", "/api/claude-code-status", {});
      const parsed = JSON.parse(res.body);
      expect(parsed.found).toBe(true);
      expect(parsed.configPath).toBe(cfgPath);
    } finally {
      close();
    }
  });
});
