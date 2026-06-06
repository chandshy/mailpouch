import { describe, it, expect } from "vitest";
import {
  shouldSurfaceGrantToast,
  shouldSurfaceActionToast,
  INFORMATIONAL_GRANT_EVENTS,
  type GrantEventKind,
} from "./security-gate.js";

describe("shouldSurfaceGrantToast", () => {
  it("always surfaces grant-created (the approval gate), regardless of the debug toggle", () => {
    expect(shouldSurfaceGrantToast("grant-created", {})).toBe(true);
    expect(shouldSurfaceGrantToast("grant-created", { surfaceSecurityNotifications: false })).toBe(true);
  });

  it("suppresses informational events by default (debug-log only)", () => {
    for (const kind of INFORMATIONAL_GRANT_EVENTS) {
      expect(shouldSurfaceGrantToast(kind, {})).toBe(false);
    }
  });

  it("surfaces informational events when the debug toggle is on", () => {
    for (const kind of INFORMATIONAL_GRANT_EVENTS) {
      expect(shouldSurfaceGrantToast(kind, { surfaceSecurityNotifications: true })).toBe(true);
    }
  });

  it("the master switch (desktopNotificationsEnabled:false) silences everything, even grant-created", () => {
    const off = { desktopNotificationsEnabled: false, surfaceSecurityNotifications: true };
    expect(shouldSurfaceGrantToast("grant-created", off)).toBe(false);
    expect(shouldSurfaceGrantToast("grant-revoked", off)).toBe(false);
  });

  it("token-revoked specifically: silent by default, shown with the toggle", () => {
    expect(shouldSurfaceGrantToast("grant-revoked", {})).toBe(false);
    expect(shouldSurfaceGrantToast("grant-revoked", { surfaceSecurityNotifications: true })).toBe(true);
  });
});

describe("shouldSurfaceActionToast", () => {
  const on = { surfaceSecurityNotifications: true };

  it("never toasts read-only actions", () => {
    expect(shouldSurfaceActionToast({ isReadOnly: true, isError: false, cfg: on })).toBe(false);
  });

  it("never toasts errored/no-op actions", () => {
    expect(shouldSurfaceActionToast({ isReadOnly: false, isError: true, cfg: on })).toBe(false);
  });

  it("does not toast a successful mutating action when the toggle is off", () => {
    expect(shouldSurfaceActionToast({ isReadOnly: false, isError: false, cfg: {} })).toBe(false);
  });

  it("toasts a successful mutating action only when the toggle is on", () => {
    expect(shouldSurfaceActionToast({ isReadOnly: false, isError: false, cfg: on })).toBe(true);
  });

  it("the master switch overrides the toggle", () => {
    expect(shouldSurfaceActionToast({
      isReadOnly: false, isError: false,
      cfg: { surfaceSecurityNotifications: true, desktopNotificationsEnabled: false },
    })).toBe(false);
  });
});

// Guard: the informational set must never include grant-created (would break the gate).
describe("INFORMATIONAL_GRANT_EVENTS", () => {
  it("excludes grant-created", () => {
    expect(INFORMATIONAL_GRANT_EVENTS.has("grant-created" as GrantEventKind)).toBe(false);
  });
});
