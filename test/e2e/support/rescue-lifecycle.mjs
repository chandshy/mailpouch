/**
 * Pure lifecycle planner for the All Mail cleanup rescue mailbox.
 *
 * The durable phase bounds COPY to one attempt across process restarts. The
 * in-memory empty-proof count deliberately resets on restart so reporting a
 * retained empty rescue always requires two observations by this process.
 */

export const RESCUE_PHASES = Object.freeze([
  "idle",
  "create-pending",
  "copy-pending",
  "payload-observed",
  "complete",
]);

export function createRescueLifecycle(phase = "idle", options = {}) {
  if (!RESCUE_PHASES.includes(phase)) throw new Error(`Invalid All Mail rescue phase: ${phase}`);
  if (options.operatorRetryPermitted !== undefined
    && typeof options.operatorRetryPermitted !== "boolean") {
    throw new Error("Invalid All Mail rescue operator retry permission");
  }
  return {
    phase,
    consecutiveEmptyProofs: 0,
    // The All Mail projection can retain the just-deleted UID for several
    // fresh sessions. Remember the exact-owned count observed before COPY so
    // a later cycle cannot accidentally stage that stale projection again.
    // This proof is intentionally volatile: restart never reconstructs COPY
    // permission from a count which may no longer describe the mailbox.
    lastStagedAllMailOwned: undefined,
    lastStagedIdentity: undefined,
    // Initial COPY is separately armed only after the caller observes one
    // unchanged exact identity set across its configured fresh-session grace.
    initialStagePermitted: false,
    // Volatile by design. A restarted process must never infer permission to
    // replay COPY from the durable payload-observed phase alone.
    nextStagePermitted: false,
    // A late All Mail-only record can replace the just-removed projection
    // without changing the total owned count. Permit that same-cardinality
    // case only after fresh observations first prove zero occurrences of the
    // prior staged identity and then repeat one unchanged replacement set.
    // These proofs are intentionally volatile and disappear on restart.
    previousStageZeroConfirmed: false,
    stableNewIdentitySignature: undefined,
    stableNewIdentityProofs: 0,
    // A manual recovery may explicitly authorize one bounded retry after an
    // earlier ambiguous COPY. The planner still requires two fresh empty
    // rescue observations and consumes this permission before dispatch.
    operatorRetryPermitted: options.operatorRetryPermitted === true,
  };
}

export function permitInitialRescueStage(state) {
  if (state.phase !== "idle") {
    throw new Error(`Cannot permit initial All Mail rescue stage from phase ${state.phase}`);
  }
  state.initialStagePermitted = true;
}

/** Record that the exact rescue mailbox has a durable, UIDVALIDITY-bound
 * positive creation proof. COPY cannot be attempted before this transition. */
export function markRescueCreated(state) {
  if (state.phase !== "create-pending" && state.phase !== "idle") {
    throw new Error(`Cannot confirm All Mail rescue creation from phase ${state.phase}`);
  }
  state.phase = "copy-pending";
  state.consecutiveEmptyProofs = 0;
}

/**
 * Permit exactly one further singleton COPY in this process after the caller
 * explicitly confirmed the prior rescue MOVE, Trash purge, and a fresh empty
 * rescue/source observation. This permission is intentionally not persisted:
 * a crash before or during COPY leaves no replay authority after restart.
 */
export function permitNextRescueStage(state) {
  if (state.phase !== "payload-observed") {
    throw new Error(`Cannot permit another All Mail rescue stage from phase ${state.phase}`);
  }
  if (!Number.isSafeInteger(state.lastStagedAllMailOwned)
    || state.lastStagedAllMailOwned < 0
    || typeof state.lastStagedIdentity !== "string"
    || state.lastStagedIdentity.length === 0) {
    throw new Error("Cannot permit another All Mail rescue stage without a current stage identity");
  }
  state.nextStagePermitted = true;
  resetLateIdentityProof(state);
}

function resetLateIdentityProof(state) {
  state.previousStageZeroConfirmed = false;
  state.stableNewIdentitySignature = undefined;
  state.stableNewIdentityProofs = 0;
}

/**
 * Plan one reconciliation round without performing any IMAP mutation.
 * Callers must durably persist a changed phase before executing `stage` or
 * `drain`, and must call markRescueRetained only after the rescue and All Mail
 * are independently proven empty. Live cleanup never deletes the mailbox.
 */
export function planRescueRound(state, observation) {
  const {
    rescueExists,
    rescueOwned,
    rescueTotal,
    allMailOwned,
    allMailOwnedIdentities,
  } = observation;
  for (const [name, value] of Object.entries({ rescueOwned, rescueTotal, allMailOwned })) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${name} count: ${value}`);
  }
  if (typeof rescueExists !== "boolean") throw new Error("Invalid rescue mailbox existence observation");
  if (!rescueExists && (rescueOwned !== 0 || rescueTotal !== 0)) {
    throw new Error("Absent rescue mailbox cannot contain observed messages");
  }
  if (rescueExists && rescueOwned !== rescueTotal) {
    throw new Error("All Mail rescue contains non-owned mail; refusing rescue");
  }
  if (!Array.isArray(allMailOwnedIdentities)
    || allMailOwnedIdentities.length !== allMailOwned
    || allMailOwnedIdentities.some((identity) => typeof identity !== "string" || identity.length === 0)
    || new Set(allMailOwnedIdentities).size !== allMailOwnedIdentities.length) {
    throw new Error("All Mail rescue requires one unique stable identity for every owned source record");
  }
  const sortedAllMailIdentities = [...allMailOwnedIdentities].sort();

  const phaseBefore = state.phase;
  let action = "none";

  if (rescueExists) {
    state.initialStagePermitted = false;
    // The strict run namespace is durable evidence that an earlier cleanup may
    // have issued CREATE/COPY. Infer pending instead of replaying an ambiguous
    // operation after a restart.
    if (state.phase === "idle") state.phase = "create-pending";

    if (rescueOwned > 0) {
      state.consecutiveEmptyProofs = 0;
      state.nextStagePermitted = false;
      resetLateIdentityProof(state);
      state.operatorRetryPermitted = false;
      if (state.phase !== "complete") state.phase = "payload-observed";
      action = "drain";
    } else {
      state.consecutiveEmptyProofs += 1;
      const hasCurrentStageProof = state.nextStagePermitted
        && Number.isSafeInteger(state.lastStagedAllMailOwned)
        && typeof state.lastStagedIdentity === "string";
      const previousIdentityStillPresent = hasCurrentStageProof
        && sortedAllMailIdentities.includes(state.lastStagedIdentity);
      let stableSameCardinalityReplacement = false;
      if (!hasCurrentStageProof || previousIdentityStillPresent) {
        resetLateIdentityProof(state);
      } else {
        state.previousStageZeroConfirmed = true;
        if (allMailOwned === state.lastStagedAllMailOwned && allMailOwned > 0) {
          const signature = JSON.stringify(sortedAllMailIdentities);
          if (state.stableNewIdentitySignature === signature) {
            state.stableNewIdentityProofs += 1;
          } else {
            state.stableNewIdentitySignature = signature;
            state.stableNewIdentityProofs = 1;
          }
          stableSameCardinalityReplacement = state.previousStageZeroConfirmed
            && state.stableNewIdentityProofs >= 2;
        } else {
          state.stableNewIdentitySignature = undefined;
          state.stableNewIdentityProofs = 0;
        }
      }
      const projectionAdvanced = state.nextStagePermitted
        && Number.isSafeInteger(state.lastStagedAllMailOwned)
        && typeof state.lastStagedIdentity === "string"
        && allMailOwned < state.lastStagedAllMailOwned
        && !sortedAllMailIdentities.includes(state.lastStagedIdentity);
      const operatorRetryReady = state.operatorRetryPermitted
        && state.consecutiveEmptyProofs >= 2;
      const operatorPhasePermitsStage = operatorRetryReady
        && (state.phase === "create-pending" || state.phase === "complete");
      if ((state.phase === "copy-pending"
          || state.phase === "payload-observed"
          || operatorPhasePermitsStage)
        && (projectionAdvanced || stableSameCardinalityReplacement || operatorRetryReady)
        && allMailOwned > 0) {
        // Consume before dispatch. A rejected/ambiguous COPY is never retried
        // by this process without a new explicit operator authorization, and
        // restart reconstructs the state without either volatile permission.
        state.nextStagePermitted = false;
        resetLateIdentityProof(state);
        state.operatorRetryPermitted = false;
        state.consecutiveEmptyProofs = 0;
        state.lastStagedAllMailOwned = allMailOwned;
        state.lastStagedIdentity = sortedAllMailIdentities[0];
        action = "stage-existing";
      } else if (state.consecutiveEmptyProofs >= 2 && allMailOwned === 0) {
        action = "retain";
      }
    }
  } else {
    if (state.phase === "create-pending" && state.operatorRetryPermitted) {
      state.consecutiveEmptyProofs += 1;
    } else {
      state.consecutiveEmptyProofs = 0;
    }
    state.nextStagePermitted = false;
    resetLateIdentityProof(state);
    if (state.phase === "idle" && state.initialStagePermitted && allMailOwned > 0) {
      state.initialStagePermitted = false;
      state.phase = "create-pending";
      state.lastStagedAllMailOwned = allMailOwned;
      state.lastStagedIdentity = sortedAllMailIdentities[0];
      action = "stage";
    } else if (state.phase === "create-pending"
      && state.operatorRetryPermitted
      && state.consecutiveEmptyProofs >= 2
      && allMailOwned > 0) {
      state.operatorRetryPermitted = false;
      state.consecutiveEmptyProofs = 0;
      state.lastStagedAllMailOwned = allMailOwned;
      state.lastStagedIdentity = sortedAllMailIdentities[0];
      action = "retry-stage";
    }
    // Pending CREATE/COPY without explicit one-use operator authority is never
    // replayed. The final all-folder audit remains red if owned mail persists.
  }

  return { action, phaseChanged: state.phase !== phaseBefore };
}

export function markRescueRetained(state) {
  const changed = state.phase !== "complete";
  state.phase = "complete";
  state.consecutiveEmptyProofs = 0;
  state.lastStagedAllMailOwned = undefined;
  state.lastStagedIdentity = undefined;
  state.initialStagePermitted = false;
  state.nextStagePermitted = false;
  resetLateIdentityProof(state);
  state.operatorRetryPermitted = false;
  return changed;
}
