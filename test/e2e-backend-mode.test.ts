import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bridgeConfigAvailable,
  scenarioImapFacade,
  startE2E,
  type E2EImapFacade,
} from "./e2e/mcp-client.js";
import { ImapFixtures } from "./e2e/fixtures/imap-fixtures.js";
import {
  bridgeModeRequested,
  requestedE2EBackend,
  resolveE2EBackend,
} from "./e2e/support/backend.js";

describe("E2E backend selection", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each(["greenmail", "bridge"] as const)("accepts the explicit %s backend", (backend) => {
    expect(requestedE2EBackend({ MAILPOUCH_E2E_BACKEND: backend })).toBe(backend);
  });

  it("refuses a missing or invalid command selection", () => {
    expect(() => requestedE2EBackend({})).toThrow(/not set/i);
    expect(() => requestedE2EBackend({ MAILPOUCH_E2E_BACKEND: "auto" })).toThrow(/invalid/i);
  });

  it("does not infer Bridge mode from an inherited Bridge config", () => {
    const env = {
      MAILPOUCH_E2E_BACKEND: "greenmail",
      MAILPOUCH_E2E_BRIDGE_CONFIG: "/home/operator/.mailpouch.json",
    };
    expect(requestedE2EBackend(env)).toBe("greenmail");
    expect(bridgeModeRequested(env)).toBe(false);
  });

  it("does not let a programmatic mode override conflict with the command", () => {
    expect(() => resolveE2EBackend("greenmail", { MAILPOUCH_E2E_BACKEND: "bridge" }))
      .toThrow(/requested "greenmail".*selected "bridge"/i);
    expect(resolveE2EBackend("bridge", {})).toBe("bridge");
  });

  it("keeps Bridge predicates enabled but fails the harness when its config is missing", async () => {
    vi.stubEnv("MAILPOUCH_E2E_BACKEND", "bridge");
    vi.stubEnv("MAILPOUCH_E2E_BRIDGE_CONFIG", "/definitely-not-present/mailpouch-bridge.json");

    expect(bridgeConfigAvailable()).toBe(true);
    await expect(startE2E()).rejects.toThrow(/Bridge config not found/);
  });

  it("fails startE2E instead of defaulting to Greenmail when no backend was selected", async () => {
    vi.stubEnv("MAILPOUCH_E2E_BACKEND", "");
    vi.stubEnv("MAILPOUCH_E2E_BRIDGE_CONFIG", "/home/operator/.mailpouch.json");

    await expect(startE2E()).rejects.toThrow(/MAILPOUCH_E2E_BACKEND is not set/i);
  });

  it("pins every public E2E npm command to its intended backend", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["test:e2e:local"]).toContain("MAILPOUCH_E2E_BACKEND=greenmail vitest");
    expect(pkg.scripts["test:e2e:local:keep"]).toContain("MAILPOUCH_E2E_BACKEND=greenmail vitest");
    expect(pkg.scripts["test:e2e:bridge"]).toMatch(/^MAILPOUCH_E2E_BACKEND=bridge vitest/);
    expect(pkg.scripts["test:e2e:bridge:safe"]).toMatch(/^MAILPOUCH_E2E_BACKEND=bridge /);
    expect(pkg.scripts["test:e2e:bridge:cleanup"]).toMatch(/^MAILPOUCH_E2E_BACKEND=bridge /);
  });

  it("never starts the disposable Greenmail backend from a Bridge scenario", () => {
    const dockerScenarioSetups = [
      ["analytics.e2e.test.ts", "restart"],
      ["drafts.e2e.test.ts", "restart"],
      ["reading.e2e.test.ts", "restart"],
      ["search.e2e.test.ts", "restart"],
      ["sending.e2e.test.ts", "restart"],
      ["smoke.e2e.test.ts", "up"],
      ["system.e2e.test.ts", "restart"],
    ] as const;

    for (const [file, operation] of dockerScenarioSetups) {
      const source = readFileSync(new URL(`./e2e/scenarios/${file}`, import.meta.url), "utf8");
      expect(source).toContain(
        `if (!bridgeConfigAvailable()) await docker.${operation}();`,
      );
    }
  });

  it("exposes and binds the bounded scenario IMAP facade", async () => {
    const fixture = new ImapFixtures({
      host: "127.0.0.1",
      port: 3143,
      user: "fixture",
      pass: "fixture",
    });
    const searchSubjects = vi.spyOn(fixture, "searchSubjects")
      .mockResolvedValue(new Map([["one", [7]]]));
    const getFlagsForUids = vi.spyOn(fixture, "getFlagsForUids")
      .mockResolvedValue(new Map([[7, ["\\Seen"]]]));
    const facade = scenarioImapFacade(fixture) as Record<string, unknown>;

    expect(Object.isFrozen(facade)).toBe(true);
    expect(facade).toHaveProperty("appendSeed");
    expect(facade).toHaveProperty("listUids");
    await expect((facade.searchSubjects as E2EImapFacade["searchSubjects"])("INBOX", ["one"]))
      .resolves.toEqual(new Map([["one", [7]]]));
    await expect((facade.getFlagsForUids as E2EImapFacade["getFlagsForUids"])("INBOX", [7]))
      .resolves.toEqual(new Map([[7, ["\\Seen"]]]));
    expect(searchSubjects).toHaveBeenCalledWith("INBOX", ["one"]);
    expect(getFlagsForUids).toHaveBeenCalledWith("INBOX", [7]);
    for (const escapeHatch of [
      "appendEmail",
      "deleteMailbox",
      "wipe",
      "completeOwnershipRun",
      "persistSafetyBaseline",
    ]) {
      expect(facade).not.toHaveProperty(escapeHatch);
    }
  });
});
