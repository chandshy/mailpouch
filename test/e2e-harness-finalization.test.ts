import { describe, expect, it, vi } from "vitest";
import {
  commitVerifiedBridgeArtifacts,
  harnessArtifactPolicy,
  shouldCommitBridgeOwnership,
} from "./e2e/support/harness-finalization.js";

describe("E2E harness terminal artifact policy", () => {
  it("retires the encrypted clone before removing recovery ownership authority", () => {
    const events: string[] = [];
    commitVerifiedBridgeArtifacts({
      retireRecoveryConfig: () => { events.push("config"); },
      completeOwnership: () => { events.push("manifest"); },
    });
    expect(events).toEqual(["config", "manifest"]);
  });

  it("retains the manifest when encrypted-clone retirement fails", () => {
    const completeOwnership = vi.fn();
    expect(() => commitVerifiedBridgeArtifacts({
      retireRecoveryConfig: () => { throw new Error("fsync failed"); },
      completeOwnership,
    })).toThrow(/fsync failed/);
    expect(completeOwnership).not.toHaveBeenCalled();
  });

  it("commits ownership only after cleanup and baseline verification with no prior failure", () => {
    expect(shouldCommitBridgeOwnership({
      mode: "bridge",
      hasScratch: true,
      scratchVerified: true,
      baselineVerified: true,
      hasTeardownFailure: false,
    })).toBe(true);

    for (const override of [
      { mode: "greenmail" as const },
      { hasScratch: false },
      { scratchVerified: false },
      { baselineVerified: false },
      { hasTeardownFailure: true },
    ]) {
      expect(shouldCommitBridgeOwnership({
        mode: "bridge",
        hasScratch: true,
        scratchVerified: true,
        baselineVerified: true,
        hasTeardownFailure: false,
        ...override,
      })).toBe(false);
    }
  });

  it("removes verified-run artifacts only after the ownership commit", () => {
    expect(harnessArtifactPolicy({
      mode: "bridge",
      isTempConfig: true,
      ownershipRunActive: false,
      mcpStopped: true,
    })).toEqual({
      recoveryRetained: false,
      removeTempConfig: true,
      removeRuntimeState: true,
      releaseRunLease: true,
    });
  });

  it("retains the manifest/config pair after cleanup recovery failure but releases a stopped child lease", () => {
    expect(harnessArtifactPolicy({
      mode: "bridge",
      isTempConfig: true,
      ownershipRunActive: true,
      mcpStopped: true,
    })).toEqual({
      recoveryRetained: true,
      removeTempConfig: false,
      removeRuntimeState: true,
      releaseRunLease: true,
    });
  });

  it("retains config, runtime state, and lease when child shutdown is unconfirmed", () => {
    expect(harnessArtifactPolicy({
      mode: "bridge",
      isTempConfig: true,
      ownershipRunActive: true,
      mcpStopped: false,
    })).toEqual({
      recoveryRetained: true,
      removeTempConfig: false,
      removeRuntimeState: false,
      releaseRunLease: false,
    });
  });
});
