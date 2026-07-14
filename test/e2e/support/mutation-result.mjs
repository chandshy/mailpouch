export class MutationOutcomeUnknownError extends Error {
  constructor(label) {
    super(`${label} did not return an explicit success result; connection closed and recovery state retained`);
    this.name = "MutationOutcomeUnknownError";
    this.code = "MAILPOUCH_E2E_MUTATION_OUTCOME_UNKNOWN";
  }
}

/** The server answered a single-UID mutation with a tagged NO while the
 * connection stayed usable: a definite, complete refusal — nothing was
 * applied. Proton refuses MOVE/DELETE on freshly-sent Sent messages until its
 * backend settles them, so callers retry inside their bounded convergence
 * rounds instead of poisoning the session. Only valid for single-UID operands
 * (BRIDGE_MUTATION_UID_BATCH_SIZE); a multi-UID NO could be a partial apply. */
export class MutationRefusedError extends Error {
  constructor(label) {
    super(`${label} was refused by the server (tagged NO; nothing was applied)`);
    this.name = "MutationRefusedError";
    this.code = "MAILPOUCH_E2E_MUTATION_REFUSED";
  }
}

/** ImapFlow returns false/undefined for several command failures instead of
 * throwing. `false` with the connection still usable is a tagged NO — a
 * definite single-UID no-op, surfaced as retryable. Every other non-result
 * (undefined preconditions, false after a dead socket) stays ambiguous and
 * stops the session before another mutation. */
export function requireMutationResult(result, label, options = {}) {
  if (result === false && options.connectionUsable === true) {
    throw new MutationRefusedError(label);
  }
  if (result === false || result === undefined || result === null) {
    throw new MutationOutcomeUnknownError(label);
  }
  return result;
}

export function isFatalCleanupError(error) {
  return error?.code === "MAILPOUCH_E2E_CLEANUP_TIMEOUT"
    || error?.code === "MAILPOUCH_E2E_MUTATION_OUTCOME_UNKNOWN";
}
