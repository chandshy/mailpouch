import { describe, expect, it } from "vitest";

import type { AccountSpec } from "../accounts/types.js";
import {
  BridgeWatchdogRouteTracker,
  bridgeWatchdogRouteForAccount,
} from "./bridge-watchdog-route.js";

function account(overrides: Partial<AccountSpec> = {}): AccountSpec {
  return {
    id: "primary",
    name: "Primary",
    providerType: "proton-bridge",
    smtpHost: "127.0.0.1",
    smtpPort: 1025,
    imapHost: "127.0.0.1",
    imapPort: 1143,
    username: "mail@example.test",
    password: "bridge-password",
    autoStartBridge: true,
    ...overrides,
  };
}

describe("BridgeWatchdogRouteTracker", () => {
  it("does not re-arm an exhausted watchdog for an unrelated active-account rebuild", () => {
    const tracker = new BridgeWatchdogRouteTracker();
    const service = {};
    const initial = bridgeWatchdogRouteForAccount(service, account());

    // Initial enable starts the watchdog. If it later exhausts its attempts,
    // the route remains recorded. A normal /api/config save rebuilds the same
    // active service/spec and must not be treated as a fresh recovery route.
    expect(tracker.reconcile(initial)).toBe(true);
    expect(tracker.reconcile(bridgeWatchdogRouteForAccount(service, account({
      name: "Renamed account",
      lastCheckedAt: "2026-07-11T00:00:00.000Z",
      lastCheckResult: "ok",
    })))).toBe(false);
  });

  it("reconciles for an account switch, disable, or recovery-relevant edit", () => {
    const tracker = new BridgeWatchdogRouteTracker();
    const firstService = {};
    const secondService = {};

    expect(tracker.reconcile(bridgeWatchdogRouteForAccount(firstService, account()))).toBe(true);
    expect(tracker.reconcile(bridgeWatchdogRouteForAccount(secondService, account({ id: "second" })))).toBe(true);
    expect(tracker.reconcile(bridgeWatchdogRouteForAccount(secondService, account({
      id: "second",
      autoStartBridge: false,
    })))).toBe(true);
    expect(tracker.reconcile(bridgeWatchdogRouteForAccount(secondService, account({
      id: "second",
      bridgePath: "/opt/proton-bridge",
    })))).toBe(true);
  });
});
