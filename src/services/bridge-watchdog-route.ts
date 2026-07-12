/**
 * The Bridge watchdog has to distinguish a meaningful active-account change
 * from a routine registry rebuild. Settings saves rebuild the AccountManager
 * even for unrelated fields, and resetting the watchdog in that case would
 * erase its bounded restart-attempt state.
 *
 * This module deliberately keeps the route comparison pure and free of timers
 * so the lifecycle policy can be regression-tested without booting index.ts.
 */

import type { AccountSpec } from "../accounts/types.js";

/** Immutable subset of an active account that affects Bridge recovery. */
export interface BridgeWatchdogRoute {
  /** Runtime service identity; replacement must invalidate an in-flight tick. */
  service: object;
  accountId: string;
  bridgePath?: string;
  smtpHost: string;
  smtpPort: number;
  imapHost: string;
  imapPort: number;
  username: string;
  password: string;
  smtpToken?: string;
  bridgeCertPath?: string;
  allowInsecureBridge: boolean;
  tlsMode: "starttls" | "ssl";
}

/**
 * Create a recovery route only for an account which has opted into Bridge
 * auto-start. Display metadata and connection-status timestamps are excluded:
 * they must not reset a watchdog that has intentionally given up.
 */
export function bridgeWatchdogRouteForAccount(
  service: object,
  spec: AccountSpec,
): BridgeWatchdogRoute | null {
  if (!spec.autoStartBridge) return null;
  return {
    service,
    accountId: spec.id,
    bridgePath: spec.bridgePath,
    smtpHost: spec.smtpHost,
    smtpPort: spec.smtpPort,
    imapHost: spec.imapHost,
    imapPort: spec.imapPort,
    username: spec.username,
    password: spec.password,
    smtpToken: spec.smtpToken,
    bridgeCertPath: spec.bridgeCertPath,
    allowInsecureBridge: !!spec.allowInsecureBridge,
    tlsMode: spec.tlsMode ?? "starttls",
  };
}

/** Whether two active-account recovery routes are operationally identical. */
export function sameBridgeWatchdogRoute(
  left: BridgeWatchdogRoute | null,
  right: BridgeWatchdogRoute | null,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.service === right.service
    && left.accountId === right.accountId
    && left.bridgePath === right.bridgePath
    && left.smtpHost === right.smtpHost
    && left.smtpPort === right.smtpPort
    && left.imapHost === right.imapHost
    && left.imapPort === right.imapPort
    && left.username === right.username
    && left.password === right.password
    && left.smtpToken === right.smtpToken
    && left.bridgeCertPath === right.bridgeCertPath
    && left.allowInsecureBridge === right.allowInsecureBridge
    && left.tlsMode === right.tlsMode;
}

/**
 * Keeps the last reconciled route even after the timer has exhausted retries.
 * An identical rebuild is therefore a no-op; a real account/configuration
 * change replaces the route and lets the caller start a fresh watchdog.
 */
export class BridgeWatchdogRouteTracker {
  private route: BridgeWatchdogRoute | null = null;

  /** Store `next`, returning true only when recovery behavior must change. */
  reconcile(next: BridgeWatchdogRoute | null): boolean {
    if (sameBridgeWatchdogRoute(this.route, next)) return false;
    this.route = next;
    return true;
  }

  /** Verify an in-flight tick still belongs to the last reconciled route. */
  matches(current: BridgeWatchdogRoute | null): boolean {
    return sameBridgeWatchdogRoute(this.route, current);
  }
}
