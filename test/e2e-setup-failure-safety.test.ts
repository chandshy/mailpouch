import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Bridge E2E setup-failure safety", () => {
  it("journals the encrypted clone before publication and retires only after the baseline manifest", () => {
    const source = readFileSync(new URL("./e2e/mcp-client.ts", import.meta.url), "utf8");
    const journalCreate = source.indexOf("bridgeSetupJournal = createBridgeSetupJournal({");
    const clonePublish = source.indexOf("writePrivateJsonExclusive(configPath, raw);", journalCreate);
    const manifestPublish = source.indexOf("imap.persistSafetyBaseline", clonePublish);
    const journalRetire = source.indexOf("retireBridgeSetupJournal({", manifestPublish);

    expect(journalCreate).toBeGreaterThan(-1);
    expect(clonePublish).toBeGreaterThan(journalCreate);
    expect(manifestPublish).toBeGreaterThan(clonePublish);
    expect(journalRetire).toBeGreaterThan(manifestPublish);
  });

  it("rolls setup artifacts back clone-first and keeps recovery rerunnable through journal retirement", () => {
    const harness = readFileSync(new URL("./e2e/mcp-client.ts", import.meta.url), "utf8");
    const clonePublish = harness.indexOf("writePrivateJsonExclusive(configPath, raw);");
    const setupCatch = harness.indexOf("} catch (error) {", clonePublish);
    const rollbackClone = harness.indexOf("retireBridgeRecoveryConfig(configPath", setupCatch);
    const rollbackJournal = harness.indexOf("retireBridgeSetupJournal({", rollbackClone);
    expect(rollbackClone).toBeGreaterThan(setupCatch);
    expect(rollbackJournal).toBeGreaterThan(rollbackClone);

    const cleanup = readFileSync(new URL("./e2e/support/cleanup-bridge.mjs", import.meta.url), "utf8");
    const terminalJournal = cleanup.indexOf("retireBridgeSetupJournal({");
    const terminalClone = cleanup.indexOf("retireExactRecoveryClone();", terminalJournal);
    const terminalManifest = cleanup.indexOf('durableUnlink(manifestPath, "ownership manifest")', terminalClone);
    expect(terminalClone).toBeGreaterThan(terminalJournal);
    expect(terminalManifest).toBeGreaterThan(terminalClone);
  });

  it("audits the baseline but never enters destructive scratch cleanup before the harness returns", () => {
    const source = readFileSync(new URL("./e2e/mcp-client.ts", import.meta.url), "utf8");
    const catchStart = source.indexOf("} catch (error) {\n    const cleanupErrors: string[] = [];");
    const catchEnd = source.indexOf("\n    const original =", catchStart);

    expect(catchStart).toBeGreaterThan(-1);
    expect(catchEnd).toBeGreaterThan(catchStart);
    const setupFailureBranch = source.slice(catchStart, catchEnd);
    expect(setupFailureBranch).toContain("verifySafetySnapshot");
    expect(setupFailureBranch).not.toContain("scratch.cleanup");
  });
});
