/** Shared live-Bridge E2E phase budgets. */
/** Credential hydration, full IMAP connect/auth, baseline capture, and MCP handshake. */
export const BRIDGE_SETUP_MS = 180_000;
/** Proton's All Mail union can take several minutes to reflect concrete-folder
 * deletions under real load (observed >6 min during release attestation).
 * Convergence exits early on two consecutive clean ownership scans, so a
 * generous ceiling costs nothing when the projection keeps up. */
export const BRIDGE_CLEANUP_SETTLE_MS = 600_000;
/** Require one unchanged exact Message-ID set across fresh Bridge sessions for
 * this long before the first All Mail rescue COPY. This lets delayed virtual
 * projections from concrete-folder cleanup disappear without creating an
 * ambiguous rescue cycle around an already-deleted record. */
export const BRIDGE_ALL_MAIL_RESCUE_STABILITY_MS = 30_000;
/** A self-addressed send must leave via Proton's SMTP, be processed server-side,
 * and return over IMAP before the assertion can see it. That round-trip is
 * bounded by Proton's load, not by mailpouch: at 30s it failed 2 of 6 identical
 * live runs on the same assertion while `send_email` reported success every
 * time, so the suite was measuring remote latency and reporting it as a product
 * defect — on a gate that blocks releases. Polling exits as soon as the message
 * lands, so a generous ceiling costs nothing on a healthy round-trip.
 * Greenmail is in-process and stays at its own tight budget. */
export const BRIDGE_DELIVERY_WAIT_MS = 120_000;
/** One ambiguous live mutation must fail well before the convergence phase.
 * Closing the socket prevents any later client-side command from dispatching;
 * the durable manifest makes the next explicit recovery attempt authoritative. */
export const BRIDGE_MUTATION_COMMAND_MS = 45_000;
/** Keep the MCP client's outer request deadline explicit. The production
 * request-scoped account-mutation deadline must fire first so a stalled command
 * returns an outcome-aware error instead of an SDK-side ambiguous timeout. */
export const BRIDGE_MCP_REQUEST_MS = 60_000;
/** Pending sends receive one delivery window plus one convergence window. */
export const BRIDGE_PENDING_CLEANUP_MAX_MS = BRIDGE_CLEANUP_SETTLE_MS * 2;
export const BRIDGE_BASELINE_VERIFY_MS = 180_000;
/** Graceful SDK close and forced stdio-transport fallback are independently
 * bounded so a wedged child cannot consume the ownership-cleanup budget. */
export const BRIDGE_MCP_CLIENT_CLOSE_MS = 15_000;
export const BRIDGE_MCP_TRANSPORT_CLOSE_MS = 15_000;
export const BRIDGE_MCP_SHUTDOWN_MS = BRIDGE_MCP_CLIENT_CLOSE_MS
  + BRIDGE_MCP_TRANSPORT_CLOSE_MS;
/** Fixture logout, file cleanup, kill grace, and timer scheduling margin. */
export const BRIDGE_TEARDOWN_CLOSE_MARGIN_MS = 30_000;
/** Final reporting, manifest finalization, and process exit. */
export const BRIDGE_STANDALONE_OVERHEAD_MS = 60_000;
/** Longest standalone recovery process, including a pending-delivery window. */
export const BRIDGE_STANDALONE_MAX_MS = BRIDGE_SETUP_MS
  + BRIDGE_PENDING_CLEANUP_MAX_MS
  + BRIDGE_BASELINE_VERIFY_MS
  + BRIDGE_STANDALONE_OVERHEAD_MS;
export function bridgeStandaloneProcessBudgetMs(hasPendingOwnership) {
  return BRIDGE_SETUP_MS
    + (hasPendingOwnership ? BRIDGE_PENDING_CLEANUP_MAX_MS : BRIDGE_CLEANUP_SETTLE_MS)
    + BRIDGE_BASELINE_VERIFY_MS
    + BRIDGE_STANDALONE_OVERHEAD_MS;
}
/** Let the standalone child's own fail-closed watchdog report first. The
 * parent timer starts before the new Node process has loaded its script, so an
 * equal deadline could otherwise kill a correctly self-terminating child. */
export const BRIDGE_STANDALONE_PARENT_MARGIN_MS = 10_000;
/** Worst-case afterAll path: an in-process pending-delivery convergence attempt
 * can end with an ambiguous mutation, after which one fresh standalone process
 * gets its complete fail-closed recovery budget. */
export const BRIDGE_AUTO_RECOVERY_MAX_MS = BRIDGE_PENDING_CLEANUP_MAX_MS
  + BRIDGE_STANDALONE_MAX_MS
  + BRIDGE_STANDALONE_PARENT_MARGIN_MS;
/** Must strictly exceed every inner fail-closed teardown/recovery budget. */
export const BRIDGE_HOOK_TIMEOUT_MS = BRIDGE_AUTO_RECOVERY_MAX_MS
  + BRIDGE_MCP_SHUTDOWN_MS
  + BRIDGE_TEARDOWN_CLOSE_MARGIN_MS;
