export class DeadlineExceededError extends Error {
  constructor(label) {
    super(`${label} absolute deadline exceeded; live connection aborted and recovery manifest retained`);
    this.name = "DeadlineExceededError";
    this.code = "MAILPOUCH_E2E_CLEANUP_TIMEOUT";
  }
}

/**
 * Race an operation against an absolute deadline without trusting cancellation
 * to settle the operation's Promise. The losing operation is converted to a
 * fulfilled outcome, so a later rejection can never become unhandled.
 */
export async function raceWithDeadline(operation, { deadline, label, onDeadline }) {
  if (!Number.isFinite(deadline)) throw new Error("Deadline must be finite");
  let expired = false;
  const expire = () => {
    if (expired) return;
    expired = true;
    try {
      onDeadline();
    } catch {
      // Deadline failure remains authoritative if close itself throws.
    }
  };
  if (Date.now() >= deadline) {
    expire();
    throw new DeadlineExceededError(label);
  }

  const observedOperation = Promise.resolve()
    .then(() => {
      if (Date.now() >= deadline) {
        expire();
        throw new DeadlineExceededError(label);
      }
      return operation();
    })
    .then(
      (value) => ({ kind: "value", value }),
      (error) => ({ kind: "error", error }),
    );
  let timer;
  const deadlineOutcome = new Promise((resolve) => {
    const expireOutcome = () => {
      expire();
      resolve({ kind: "deadline" });
    };
    const remaining = deadline - Date.now();
    if (remaining <= 0) expireOutcome();
    else timer = setTimeout(expireOutcome, remaining);
  });

  const outcome = await Promise.race([observedOperation, deadlineOutcome]);
  if (timer) clearTimeout(timer);
  if (outcome.kind === "deadline" || Date.now() >= deadline) {
    expire();
    throw new DeadlineExceededError(label);
  }
  if (outcome.kind === "error") throw outcome.error;
  return outcome.value;
}

/**
 * Add safe phase lifecycle telemetry around the hard deadline race. Transition
 * records contain only the caller-owned phase label and wall-clock timing; no
 * credentials, mailbox data, or operation errors are exposed to the reporter.
 */
export async function runDeadlinePhase(operation, {
  deadline,
  label,
  onDeadline,
  onTransition,
}) {
  const startedAt = Date.now();
  const emit = (state) => {
    try {
      const at = Date.now();
      onTransition?.({
        label,
        state,
        at,
        deadline,
        elapsedMs: at - startedAt,
      });
    } catch {
      // Diagnostics must never change cleanup control flow.
    }
  };
  emit("started");
  try {
    const result = await raceWithDeadline(operation, { deadline, label, onDeadline });
    emit("completed");
    return result;
  } catch (error) {
    emit("failed");
    throw error;
  }
}

/** Build one idempotent setup abort which independently closes every owned
 * transport and observes asynchronous close failures. */
export function createFailClosedSetupAbort({ abortImap, closeClient, closeTransport }) {
  let aborted = false;
  const abort = (reason) => {
    if (aborted) return;
    aborted = true;
    try {
      abortImap?.(reason);
    } catch {
      // Continue closing the remaining transports.
    }
    for (const close of [closeClient, closeTransport]) {
      if (!close) continue;
      try {
        void Promise.resolve(close()).catch(() => undefined);
      } catch {
        // The deadline race remains authoritative if close itself throws.
      }
    }
  };
  Object.defineProperty(abort, "aborted", {
    enumerable: true,
    get: () => aborted,
  });
  return abort;
}
