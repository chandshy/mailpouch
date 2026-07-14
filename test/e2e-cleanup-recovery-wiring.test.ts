import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./e2e/mcp-client.ts", import.meta.url), "utf8");

describe("Bridge E2E cleanup recovery wiring", () => {
  it("checks retained recoverable runs before config cloning or live mailbox IO", () => {
    const start = source.indexOf("export async function startE2E");
    const lease = source.indexOf("acquireBridgeRunLease", start);
    const barrier = source.indexOf("assertNoRetainedBridgeRecoveryRuns", start);
    const sourceConfig = source.indexOf("const sourcePath = bridgeAuthorityConfigPath!", start);
    const fixtureConnect = source.indexOf("fixture IMAP connection and authentication", start);

    expect(start).toBeGreaterThan(-1);
    expect(lease).toBeGreaterThan(start);
    expect(barrier).toBeGreaterThan(lease);
    expect(barrier).toBeLessThan(sourceConfig);
    expect(barrier).toBeLessThan(fixtureConnect);
  });

  it("stops the MCP child and poisoned fixture before its one standalone attempt", () => {
    const closeStart = source.indexOf("const close = async (): Promise<void> =>");
    const closeEnd = source.indexOf("\n  const scratchPath", closeStart);
    const close = source.slice(closeStart, closeEnd);
    const stopMcp = close.indexOf("await shutdownMcpBounded");
    const cleanup = close.indexOf("await scratch.cleanup");
    const coordinator = close.indexOf("await coordinateStandaloneBridgeRecovery");
    const standalone = close.indexOf("recover: () => recoverBridgeRunStandalone");

    expect(stopMcp).toBeGreaterThan(-1);
    expect(cleanup).toBeGreaterThan(stopMcp);
    expect(coordinator).toBeGreaterThan(cleanup);
    expect(standalone).toBeGreaterThan(coordinator);
    expect(close).toContain("closePoisonedFixture: closeFixture");
    expect(close).toContain("if (safetySnapshot && shutdown.stopped && recoveryChildTerminationConfirmed");
  });
});
