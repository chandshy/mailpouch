export class MutationOutcomeUnknownError extends Error {
  code: "MAILPOUCH_E2E_MUTATION_OUTCOME_UNKNOWN";
}
export function requireMutationResult<T>(result: T | false | null | undefined, label: string): T;
export function isFatalCleanupError(error: unknown): boolean;
