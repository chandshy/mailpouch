/**
 * Pure decision logic for the "Surface security messages" debug aid.
 *
 * mailpouch fires desktop toasts for two kinds of security-relevant events:
 *   1. agent grant-lifecycle transitions (created/approved/denied/revoked/expired)
 *   2. each non-read-only tool action it performs (send, move, delete, …)
 *
 * By default these are noise, so they go to the DEBUG log only. When the
 * operator enables `surfaceSecurityNotifications`, they surface as toasts to
 * help debug what an agent is doing. The single exception is `grant-created`
 * ("agent awaiting approval") — that's the actionable human gate, so it always
 * surfaces (subject only to the desktopNotificationsEnabled master switch).
 *
 * Kept dependency-free and pure so the gating is unit-tested directly; index.ts
 * does the actual logging/notifying.
 */

export type GrantEventKind =
  | "grant-created"
  | "grant-approved"
  | "grant-denied"
  | "grant-revoked"
  | "grant-expired";

export interface SecurityNotifyConfig {
  /** Master switch for all desktop notifications (default on). */
  desktopNotificationsEnabled?: boolean;
  /** Debug aid: surface informational security/action toasts (default off). */
  surfaceSecurityNotifications?: boolean;
}

/** Post-decision grant events — informational, gated behind the debug toggle. */
export const INFORMATIONAL_GRANT_EVENTS: ReadonlySet<GrantEventKind> = new Set<GrantEventKind>([
  "grant-approved",
  "grant-denied",
  "grant-revoked",
  "grant-expired",
]);

/**
 * Should a grant-lifecycle event pop a desktop toast?
 * `grant-created` always does (the approval gate); the informational events
 * only when `surfaceSecurityNotifications` is on. Both honor the master switch.
 */
export function shouldSurfaceGrantToast(kind: GrantEventKind, cfg: SecurityNotifyConfig): boolean {
  if (cfg.desktopNotificationsEnabled === false) return false;
  if (kind === "grant-created") return true;
  return cfg.surfaceSecurityNotifications === true;
}

/**
 * Should a completed tool call pop a per-action toast?
 * Only a successful, non-read-only action, only when the debug toggle is on and
 * the master switch isn't off. (Read-only tools and errored/no-op calls never
 * toast — they'd be pure noise.)
 */
export function shouldSurfaceActionToast(opts: {
  isReadOnly: boolean;
  isError: boolean;
  cfg: SecurityNotifyConfig;
}): boolean {
  if (opts.isError || opts.isReadOnly) return false;
  return opts.cfg.surfaceSecurityNotifications === true && opts.cfg.desktopNotificationsEnabled !== false;
}
