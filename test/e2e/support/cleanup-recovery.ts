import type { ScratchCleanupReport } from "./scratch.js";

export type CleanupRecoveryMode = "greenmail" | "bridge";

export function shouldAttemptStandaloneBridgeRecovery(
  mode: CleanupRecoveryMode,
  report: Pick<ScratchCleanupReport, "fatalErrorCode">,
  hasPriorTeardownFailure: boolean,
): boolean {
  return mode === "bridge"
    && !hasPriorTeardownFailure
    && (report.fatalErrorCode === "MAILPOUCH_E2E_MUTATION_OUTCOME_UNKNOWN"
      || report.fatalErrorCode === "MAILPOUCH_E2E_ALL_MAIL_RESCUE_REQUIRED");
}

export type CleanupRecoveryOutcome<T> =
  | { attempted: false; recovered: false; fixtureClosed: boolean }
  | { attempted: true; recovered: true; fixtureClosed: true; result: T }
  | { attempted: true; recovered: false; fixtureClosed: true; error: unknown };

/**
 * Coordinate the only automatic live-mail recovery transition.
 *
 * Fatal cleanup makes the current IMAP fixture unusable. It is closed first
 * for timeouts, ambiguous mutations, and the deliberate All Mail handoff.
 * Only a recoverable fatal state may make one fresh-process attempt, and only
 * when teardown was otherwise clean.
 */
export async function coordinateStandaloneBridgeRecovery<T>(options: {
  mode: CleanupRecoveryMode;
  report: Pick<ScratchCleanupReport, "fatalErrorCode">;
  hasPriorTeardownFailure: boolean;
  closePoisonedFixture: () => Promise<boolean>;
  recover: () => Promise<T>;
}): Promise<CleanupRecoveryOutcome<T>> {
  const fatal = options.report.fatalErrorCode !== undefined;
  if (!fatal) return { attempted: false, recovered: false, fixtureClosed: false };

  const fixtureClosed = await options.closePoisonedFixture();
  if (!fixtureClosed || !shouldAttemptStandaloneBridgeRecovery(
    options.mode,
    options.report,
    options.hasPriorTeardownFailure,
  )) {
    return { attempted: false, recovered: false, fixtureClosed };
  }

  try {
    const result = await options.recover();
    return { attempted: true, recovered: true, fixtureClosed: true, result };
  } catch (error) {
    return { attempted: true, recovered: false, fixtureClosed: true, error };
  }
}
