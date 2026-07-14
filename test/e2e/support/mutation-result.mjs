export class MutationOutcomeUnknownError extends Error {
  constructor(label) {
    super(`${label} did not return an explicit success result; connection closed and recovery state retained`);
    this.name = "MutationOutcomeUnknownError";
    this.code = "MAILPOUCH_E2E_MUTATION_OUTCOME_UNKNOWN";
  }
}

/** ImapFlow returns false/undefined for several command failures instead of
 * throwing. Treat that outcome as ambiguous and stop before another mutation. */
export function requireMutationResult(result, label) {
  if (result === false || result === undefined || result === null) {
    throw new MutationOutcomeUnknownError(label);
  }
  return result;
}

export function isFatalCleanupError(error) {
  return error?.code === "MAILPOUCH_E2E_CLEANUP_TIMEOUT"
    || error?.code === "MAILPOUCH_E2E_MUTATION_OUTCOME_UNKNOWN";
}
