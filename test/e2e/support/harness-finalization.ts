export type HarnessFinalizationMode = "greenmail" | "bridge";

export function shouldCommitBridgeOwnership(options: {
  mode: HarnessFinalizationMode;
  hasScratch: boolean;
  scratchVerified: boolean;
  baselineVerified: boolean;
  hasTeardownFailure: boolean;
}): boolean {
  return options.mode === "bridge"
    && options.hasScratch
    && options.scratchVerified
    && options.baselineVerified
    && !options.hasTeardownFailure;
}

export interface HarnessArtifactPolicy {
  recoveryRetained: boolean;
  removeTempConfig: boolean;
  removeRuntimeState: boolean;
  releaseRunLease: boolean;
}

/** Commit a verified live run in credential-safe order. The encrypted clone
 * is retired first; only then may the ownership manifest disappear. A crash
 * can therefore leave at worst a credential-free orphan manifest, never an
 * untracked mailbox credential clone. */
export function commitVerifiedBridgeArtifacts(options: {
  retireRecoveryConfig(): void;
  completeOwnership(): void;
}): void {
  options.retireRecoveryConfig();
  options.completeOwnership();
}

/** Decide terminal artifact state without performing filesystem operations. */
export function harnessArtifactPolicy(options: {
  mode: HarnessFinalizationMode;
  isTempConfig: boolean;
  ownershipRunActive: boolean;
  mcpStopped: boolean;
}): HarnessArtifactPolicy {
  const recoveryRetained = options.mode === "bridge" && options.ownershipRunActive;
  return {
    recoveryRetained,
    removeTempConfig: options.isTempConfig && options.mcpStopped && !recoveryRetained,
    removeRuntimeState: options.mcpStopped,
    releaseRunLease: options.mcpStopped,
  };
}
