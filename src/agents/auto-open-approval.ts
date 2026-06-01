/**
 * Pure decision for whether a newly-registered agent should auto-open the
 * Settings UI approval window. Kept side-effect-free so the gating (config
 * flag, display present, UI up, burst throttle) is unit-testable; the caller
 * (src/index.ts) supplies the live state and performs the openBrowser().
 */

export interface AutoOpenApprovalInput {
  /** config.autoOpenApprovalWindow !== false */
  enabled: boolean;
  /** A screen is present (no point opening a browser on a headless host). */
  hasDisplay: boolean;
  /** Our settings UI is actually bound. */
  settingsEnabled: boolean;
  /** Base settings URL (empty when the UI isn't up). */
  settingsUrl: string;
  /** Current epoch ms. */
  nowMs: number;
  /** Epoch ms the window was last auto-opened (0 if never). */
  lastOpenedAtMs: number;
  /** Min gap between auto-opens, so a registration burst opens at most one tab. */
  throttleMs?: number;
}

export const AUTO_OPEN_THROTTLE_MS = 10_000;

export function shouldAutoOpenApproval(i: AutoOpenApprovalInput): boolean {
  if (!i.enabled) return false;
  if (!i.hasDisplay) return false;
  if (!i.settingsEnabled || !i.settingsUrl) return false;
  const throttle = i.throttleMs ?? AUTO_OPEN_THROTTLE_MS;
  if (i.lastOpenedAtMs > 0 && i.nowMs - i.lastOpenedAtMs < throttle) return false;
  return true;
}
