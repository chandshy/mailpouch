export class DeadlineExceededError extends Error {
  readonly code: "MAILPOUCH_E2E_CLEANUP_TIMEOUT";
  constructor(label: string);
}

export interface DeadlineRaceOptions {
  deadline: number;
  label: string;
  onDeadline(): void;
}

export function raceWithDeadline<T>(
  operation: () => T | Promise<T>,
  options: DeadlineRaceOptions,
): Promise<T>;

export interface DeadlinePhaseTransition {
  label: string;
  state: "started" | "completed" | "failed";
  at: number;
  deadline: number;
  elapsedMs: number;
}

export interface DeadlinePhaseOptions extends DeadlineRaceOptions {
  onTransition?(transition: DeadlinePhaseTransition): void;
}

export function runDeadlinePhase<T>(
  operation: () => T | Promise<T>,
  options: DeadlinePhaseOptions,
): Promise<T>;

export interface FailClosedSetupAbortOptions {
  abortImap?(reason: string): void;
  closeClient?(): void | Promise<void>;
  closeTransport?(): void | Promise<void>;
}

export interface FailClosedSetupAbort {
  (reason: string): void;
  readonly aborted: boolean;
}

export function createFailClosedSetupAbort(
  options: FailClosedSetupAbortOptions,
): FailClosedSetupAbort;
