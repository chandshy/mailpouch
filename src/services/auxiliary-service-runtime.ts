/**
 * Bridge between the settings HTTP server and the process-owned auxiliary
 * integrations (SimpleLogin and Proton Pass).
 *
 * The settings server is also used as a standalone process, so it must not
 * import index.ts or construct service instances itself.  The MCP runtime
 * registers a refresh callback when it is present; standalone settings saves
 * still persist safely and receive `false` so callers can request a restart.
 */

export type AuxiliaryServiceRefresher = () => Promise<void> | void;
export type AuxiliaryServiceDisabler = () => Promise<void> | void;

let refresher: AuxiliaryServiceRefresher | null = null;
let disabler: AuxiliaryServiceDisabler | null = null;

/** Register (or clear) the in-process refresh owned by the MCP runtime. */
export function registerAuxiliaryServiceRefresher(next: AuxiliaryServiceRefresher | null): void {
  refresher = next;
}

/** Register (or clear) the in-process fail-closed reset hook. */
export function registerAuxiliaryServiceDisabler(next: AuxiliaryServiceDisabler | null): void {
  disabler = next;
}

/**
 * Refresh live auxiliary integrations after their persisted configuration
 * changes. Returns false when this settings server has no MCP runtime to
 * update (the standalone `mailpouch-settings` case).
 */
export async function refreshAuxiliaryServices(): Promise<boolean> {
  if (!refresher) return false;
  await refresher();
  return true;
}

/**
 * Force-disable live auxiliary integrations after a configuration reset.
 *
 * This intentionally does not read persisted configuration or the OS
 * keychain: reset cleanup can fail, and rehydrating a stale key in that state
 * would leave a supposedly-reset integration usable in the current process.
 */
export async function disableAuxiliaryServices(): Promise<boolean> {
  if (!disabler) return false;
  await disabler();
  return true;
}
