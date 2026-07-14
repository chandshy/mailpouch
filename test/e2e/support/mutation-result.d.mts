export class MutationOutcomeUnknownError extends Error {
  code: "MAILPOUCH_E2E_MUTATION_OUTCOME_UNKNOWN";
}
export class MutationRefusedError extends Error {
  code: "MAILPOUCH_E2E_MUTATION_REFUSED";
}
export function requireMutationResult<T>(
  result: T | false | null | undefined,
  label: string,
  options?: { connectionUsable?: boolean },
): T;
export function isFatalCleanupError(error: unknown): boolean;
