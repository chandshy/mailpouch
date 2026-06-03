import { describe, it, expect } from "vitest";
import { shouldAutoOpenApproval, AUTO_OPEN_THROTTLE_MS } from "./auto-open-approval.js";

const base = {
  enabled: true,
  hasDisplay: true,
  settingsEnabled: true,
  settingsUrl: "http://localhost:8766",
  nowMs: 1_000_000,
  lastOpenedAtMs: 0,
};

describe("shouldAutoOpenApproval", () => {
  it("opens when enabled, display present, UI up, and not throttled", () => {
    expect(shouldAutoOpenApproval(base)).toBe(true);
  });

  it("does not open when the feature flag is off", () => {
    expect(shouldAutoOpenApproval({ ...base, enabled: false })).toBe(false);
  });

  it("does not open on a headless host (no display)", () => {
    expect(shouldAutoOpenApproval({ ...base, hasDisplay: false })).toBe(false);
  });

  it("does not open when the settings UI isn't bound", () => {
    expect(shouldAutoOpenApproval({ ...base, settingsEnabled: false })).toBe(false);
    expect(shouldAutoOpenApproval({ ...base, settingsUrl: "" })).toBe(false);
  });

  it("throttles a burst — suppresses a second open within the window", () => {
    const lastOpenedAtMs = base.nowMs - (AUTO_OPEN_THROTTLE_MS - 1);
    expect(shouldAutoOpenApproval({ ...base, lastOpenedAtMs })).toBe(false);
  });

  it("opens again once the throttle window has elapsed", () => {
    const lastOpenedAtMs = base.nowMs - (AUTO_OPEN_THROTTLE_MS + 1);
    expect(shouldAutoOpenApproval({ ...base, lastOpenedAtMs })).toBe(true);
  });
});
