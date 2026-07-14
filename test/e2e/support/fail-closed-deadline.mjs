/**
 * Start a deadline which cannot merely reject a wrapper Promise and leave the
 * protected operation alive. Expiry first closes the live connection, reports
 * that recovery state was retained, and then invokes the supplied process
 * terminator. Callers inject the side effects so the contract is unit-testable.
 */
export function beginFailClosedDeadline({
  deadline,
  label,
  closeConnection,
  report,
  terminate,
}) {
  if (!Number.isFinite(deadline)) throw new Error("Fail-closed deadline must be finite");
  let expired = false;
  let cleared = false;
  let timer;
  const expire = () => {
    if (expired || cleared) return;
    expired = true;
    try {
      closeConnection();
    } catch {
      // Termination remains mandatory even if the transport is already torn down.
    }
    try {
      report(`${label} deadline exceeded; live connection aborted and recovery manifest retained`);
    } finally {
      terminate(1);
    }
  };
  const remaining = deadline - Date.now();
  if (remaining <= 0) expire();
  else timer = setTimeout(expire, remaining);
  return {
    deadline,
    label,
    expire,
    get expired() { return expired; },
    expireIfDue() {
      if (!expired && !cleared && Date.now() >= deadline) expire();
      return expired;
    },
    clear() {
      if (timer) clearTimeout(timer);
      timer = undefined;
      cleared = true;
    },
  };
}
