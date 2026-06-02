/**
 * Daemon-aware client setup: when the config has remoteMode (a shared HTTP
 * daemon), the write-claude-code / write-claude-desktop routes must NOT write a
 * stdio entry (it would collide with the daemon's per-account singleton). A
 * stdio request is coerced to http. Separate file so loadConfig's module cache
 * starts fresh with remoteMode:true on disk.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import http from "node:http";
import { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_HOME = mkdtempSync(join(tmpdir(), "mp-ccdaemon-"));

vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  return { ...actual, homedir: () => TMP_HOME, default: { ...actual, homedir: () => TMP_HOME } };
});

let createSettingsServer: typeof import("./server.js").createSettingsServer;

beforeAll(async () => {
  // remoteMode on → daemon model. Written before the server (and any loadConfig) runs.
  writeFileSync(join(TMP_HOME, ".mailpouch.json"), JSON.stringify({
    configVersion: 3,
    connection: { remoteMode: true, remoteOauthEnabled: true, remoteHost: "127.0.0.1", remotePort: 8788, remotePath: "/mcp" },
  }), "utf8");
  ({ createSettingsServer } = await import("./server.js"));
});

afterAll(() => rmSync(TMP_HOME, { recursive: true, force: true }));

interface Resp { status: number; body: string; }

function listen(srv: http.Server): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) =>
    srv.listen(0, "127.0.0.1", () => resolve({ port: (srv.address() as AddressInfo).port, close: () => srv.close() })));
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

describe("daemon-aware client setup (remoteMode on)", () => {
  it("coerces a stdio request to http for Claude Code (no colliding stdio entry)", async () => {
    writeFileSync(join(TMP_HOME, ".claude.json"), JSON.stringify({ mcpServers: {} }), "utf8");
    const srv = createSettingsServer({ port: 8765, lan: false, accessToken: null, scheme: "http" });
    const { port, close } = await listen(srv);
    try {
      const token = await csrfFrom(port);
      const res = await request(port, "POST", "/api/write-claude-code",
        { "x-csrf-token": token, origin: `http://127.0.0.1:${port}`, "content-type": "application/json" },
        JSON.stringify({ transport: "stdio" }));
      const parsed = JSON.parse(res.body);
      expect(parsed.ok).toBe(true);
      expect(parsed.coercedToHttp).toBe(true);
      expect(parsed.transport).toBe("http");
      const entry = JSON.parse(readFileSync(join(TMP_HOME, ".claude.json"), "utf8")).mcpServers.mailpouch;
      expect(entry.type).toBe("http");
      expect(entry.url).toMatch(/\/mcp$/);
    } finally { close(); }
  });

  it("writes an http entry for Claude Desktop too (never a colliding stdio entry)", async () => {
    // Linux Claude Desktop path under the mocked home.
    const cdDir = join(TMP_HOME, ".config", "Claude");
    rmSync(cdDir, { recursive: true, force: true });
    const { mkdirSync } = await import("node:fs");
    mkdirSync(cdDir, { recursive: true });
    writeFileSync(join(cdDir, "claude_desktop_config.json"), JSON.stringify({ mcpServers: {} }), "utf8");
    const srv = createSettingsServer({ port: 8765, lan: false, accessToken: null, scheme: "http" });
    const { port, close } = await listen(srv);
    try {
      const token = await csrfFrom(port);
      const res = await request(port, "POST", "/api/write-claude-desktop",
        { "x-csrf-token": token, origin: `http://127.0.0.1:${port}`, "content-type": "application/json" }, "{}");
      const parsed = JSON.parse(res.body);
      expect(parsed.ok).toBe(true);
      const entry = JSON.parse(readFileSync(join(cdDir, "claude_desktop_config.json"), "utf8")).mcpServers.mailpouch;
      expect(entry.type).toBe("http");
    } finally { close(); }
  });
});
