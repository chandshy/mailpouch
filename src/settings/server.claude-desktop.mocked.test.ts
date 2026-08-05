/**
 * UI-009: POST /api/write-claude-desktop must not silently clobber an existing
 * claude_desktop_config.json that it cannot parse. Mocks os.homedir() so the
 * platform config path resolves into a throwaway temp dir.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import http from "node:http";
import { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_HOME = mkdtempSync(join(tmpdir(), "mp-cdtest-"));

vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  return { ...actual, homedir: () => TMP_HOME, default: { ...actual, homedir: () => TMP_HOME } };
});

// Linux/darwin path layout; on win32 the route uses %APPDATA% instead.
const cfgDir =
  process.platform === "darwin"
    ? join(TMP_HOME, "Library", "Application Support", "Claude")
    : join(TMP_HOME, ".config", "Claude");
const cfgPath = join(cfgDir, "claude_desktop_config.json");

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

describe("UI-009: write-claude-desktop refuses to clobber unparseable config", () => {
  if (process.platform === "win32") {
    it.skip("homedir-based path test skipped on win32", () => {});
    return;
  }

  it("bails (ok:false) and leaves the original file intact", async () => {
    mkdirSync(cfgDir, { recursive: true });
    const original = "// a comment json5-ish\n{ not: valid json }";
    writeFileSync(cfgPath, original, "utf8");

    const srv = createSettingsServer({ port: 8765, lan: false, accessToken: null, scheme: "http" });
    const { port, close } = await listen(srv);
    try {
      const token = await csrfFrom(port);
      const res = await request(
        port,
        "POST",
        "/api/write-claude-desktop",
        { "x-csrf-token": token, origin: `http://127.0.0.1:${port}`, "content-type": "application/json" },
        "{}",
      );
      const parsed = JSON.parse(res.body);
      expect(parsed.ok).toBe(false);
      expect(String(parsed.error)).toMatch(/parsed/i);
      // The on-disk file must be byte-for-byte unchanged.
      expect(readFileSync(cfgPath, "utf8")).toBe(original);
    } finally {
      close();
    }
  });

  it("writes the mailpouch entry into a valid existing config", async () => {
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(cfgPath, JSON.stringify({ mcpServers: { other: { command: "x" } } }), "utf8");

    const srv = createSettingsServer({ port: 8765, lan: false, accessToken: null, scheme: "http" });
    const { port, close } = await listen(srv);
    try {
      const token = await csrfFrom(port);
      const res = await request(
        port,
        "POST",
        "/api/write-claude-desktop",
        { "x-csrf-token": token, origin: `http://127.0.0.1:${port}`, "content-type": "application/json" },
        "{}",
      );
      expect(JSON.parse(res.body).ok).toBe(true);
      const after = JSON.parse(readFileSync(cfgPath, "utf8"));
      expect(after.mcpServers.other).toBeDefined();
      expect(after.mcpServers.mailpouch).toBeDefined();
    } finally {
      close();
    }
  });

  // The file we rewrite belongs to Claude Desktop, not to us, and it commonly
  // holds API keys for OTHER MCP servers. renameSync replaces the inode, so a
  // temp file written at the umask default silently widens a hardened 0600
  // config to 0644 — handing a third party's secrets to every local account.
  it("does not widen the permissions of an existing 0600 config", async () => {
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(cfgPath, JSON.stringify({ mcpServers: { other: { command: "x" } } }), "utf8");
    chmodSync(cfgPath, 0o600);
    expect(statSync(cfgPath).mode & 0o777).toBe(0o600);

    const srv = createSettingsServer({ port: 8765, lan: false, accessToken: null, scheme: "http" });
    const { port, close } = await listen(srv);
    try {
      const token = await csrfFrom(port);
      const res = await request(
        port,
        "POST",
        "/api/write-claude-desktop",
        { "x-csrf-token": token, origin: `http://127.0.0.1:${port}`, "content-type": "application/json" },
        "{}",
      );
      expect(JSON.parse(res.body).ok).toBe(true);
      // The write must have happened...
      expect(JSON.parse(readFileSync(cfgPath, "utf8")).mcpServers.mailpouch).toBeDefined();
      // ...without loosening the mode.
      expect(statSync(cfgPath).mode & 0o777).toBe(0o600);
    } finally {
      close();
    }
  });
});
