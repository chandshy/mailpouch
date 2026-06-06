import { describe, it, expect, afterEach } from "vitest";
import { runStatusCli } from "./status-cli.js";
import { invalidateConfigCache } from "../config/loader.js";
import type { SetupStatusResult } from "../diagnostics/setup-status.js";
import { homedir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";

// Isolate from the real ~/.mailpouch.json (loadConfig is called directly).
const prev = process.env.MAILPOUCH_CONFIG;
function isolateConfig(): void {
  process.env.MAILPOUCH_CONFIG = join(homedir(), `.mailpouch-status-test-${randomBytes(6).toString("hex")}.json`);
  invalidateConfigCache();
}
afterEach(() => {
  if (prev === undefined) delete process.env.MAILPOUCH_CONFIG;
  else process.env.MAILPOUCH_CONFIG = prev;
  invalidateConfigCache();
});

function diag(overrides: Partial<SetupStatusResult> = {}): SetupStatusResult {
  return {
    state: "ready", configured: true, bridgeReachable: true,
    configExists: true, configPath: "/home/u/.mailpouch.json",
    username: "me@proton.me", credentialStorage: "keychain",
    imap: { host: "127.0.0.1", port: 1143, reachable: true },
    smtp: { host: "127.0.0.1", port: 1025, reachable: true },
    insecureTls: false, grantStatus: null, nextStep: "ok", summary: "ok",
    ...overrides,
  };
}

function harness(opts: {
  pid?: number | null;
  payload?: Record<string, unknown> | null;
  diag?: SetupStatusResult;
  counts?: { pending: number; active: number };
}) {
  const out: string[] = [];
  const err: string[] = [];
  const deps = {
    out: (l: string) => out.push(l),
    err: (l: string) => err.push(l),
    readPid: () => opts.pid ?? null,
    probe: async () => opts.payload ?? null,
    gather: async () => opts.diag ?? diag(),
    grantCounts: () => opts.counts ?? { pending: 0, active: 0 },
  };
  return { out, err, deps };
}

describe("mailpouch status CLI", () => {
  it("reports a RUNNING, connected instance from the live /api/status payload (exit 0)", async () => {
    isolateConfig();
    const h = harness({
      pid: 4242,
      payload: { hasConfig: true, version: "3.0.76", connected: true, account: "me@proton.me", pendingCount: 1, activeCount: 3 },
    });
    const code = await runStatusCli([], h.deps);
    expect(code).toBe(0);
    const text = h.out.join("\n");
    expect(text).toMatch(/RUNNING \(pid 4242\)/);
    expect(text).toMatch(/connected/);
    expect(text).toMatch(/3 active, 1 pending/);
  });

  it("reports NOT RUNNING and falls back to persisted grant counts", async () => {
    isolateConfig();
    const h = harness({ pid: null, payload: null, diag: diag({ state: "ready" }), counts: { pending: 2, active: 0 } });
    const code = await runStatusCli([], h.deps);
    expect(code).toBe(0); // diagnosis ready → 0 even when no instance is up
    const text = h.out.join("\n");
    expect(text).toMatch(/NOT RUNNING/);
    expect(text).toMatch(/0 active, 2 pending/);
  });

  it("exits 1 when not running and the install isn't ready", async () => {
    isolateConfig();
    const h = harness({ pid: null, payload: null, diag: diag({ state: "unconfigured" }) });
    const code = await runStatusCli([], h.deps);
    expect(code).toBe(1);
    expect(h.out.join("\n")).toMatch(/mailpouch doctor/);
  });

  it("--json emits a parseable structured result", async () => {
    isolateConfig();
    const h = harness({ pid: 99, payload: { hasConfig: true, connected: true, pendingCount: 0, activeCount: 1 } });
    const code = await runStatusCli(["--json"], h.deps);
    expect(code).toBe(0);
    const parsed = JSON.parse(h.out.join("\n"));
    expect(parsed.running).toBe(true);
    expect(parsed.instance.pid).toBe(99);
    expect(parsed.agents).toEqual({ pending: 0, active: 1 });
    expect(parsed.diagnosis.state).toBe("ready");
  });

  it("rejects unknown arguments with exit code 2", async () => {
    isolateConfig();
    const h = harness({});
    const code = await runStatusCli(["--bogus"], h.deps);
    expect(code).toBe(2);
    expect(h.err.join("\n")).toMatch(/unknown argument/);
  });

  it("a live lock PID alone (UI not answering) still reports RUNNING", async () => {
    isolateConfig();
    const h = harness({ pid: 555, payload: null, diag: diag() });
    const code = await runStatusCli([], h.deps);
    expect(h.out.join("\n")).toMatch(/RUNNING \(pid 555\)/);
    expect(h.out.join("\n")).toMatch(/settings UI not answering/);
    expect(code).toBe(0); // diagnosis ready
  });
});
