import { describe, it, expect } from "vitest";
import { BackoffTracker, isTransientAbuseError } from "./backoff.js";

describe("isTransientAbuseError", () => {
  it("returns true for numeric SMTP 421 responseCode", () => {
    expect(isTransientAbuseError({ responseCode: 421, message: "Service not available" })).toBe(true);
  });

  it("returns true for numeric 450 and 454", () => {
    expect(isTransientAbuseError({ responseCode: 450 })).toBe(true);
    expect(isTransientAbuseError({ responseCode: 454 })).toBe(true);
  });

  it("returns true for a string code like '421'", () => {
    expect(isTransientAbuseError({ code: "421" })).toBe(true);
  });

  it("matches 4xx codes embedded in the error message", () => {
    expect(isTransientAbuseError(new Error("SMTP 421 4.7.0 too many connections"))).toBe(true);
  });

  it("matches Bridge-style abuse keywords in the message", () => {
    expect(isTransientAbuseError(new Error("connection closed: BYE anti-abuse"))).toBe(true);
    expect(isTransientAbuseError(new Error("human verification required"))).toBe(true);
    expect(isTransientAbuseError(new Error("Please try again later"))).toBe(true);
  });

  it("returns false for authoritative terminal errors", () => {
    expect(isTransientAbuseError(new Error("Invalid login: incorrect password"))).toBe(false);
    expect(isTransientAbuseError(new Error("ECONNREFUSED"))).toBe(false);
    expect(isTransientAbuseError({ responseCode: 550 })).toBe(false);
  });

  it("returns false for null/undefined", () => {
    expect(isTransientAbuseError(null)).toBe(false);
    expect(isTransientAbuseError(undefined)).toBe(false);
  });

  it("returns false for plain non-Error objects with no matching fields", () => {
    expect(isTransientAbuseError({ foo: "bar" })).toBe(false);
  });
});

describe("BackoffTracker", () => {
  function fixedClock(start: number) {
    let now = start;
    return {
      now: () => now,
      advance: (ms: number) => { now += ms; },
    };
  }

  it("starts in the unblocked state", () => {
    const bt = new BackoffTracker();
    expect(bt.isBlocked()).toBe(false);
    expect(bt.failureCount).toBe(0);
    expect(bt.delayUntilMs()).toBe(0);
  });

  it("increments the failure count and arms a window on 'abuse'", () => {
    const clock = fixedClock(1_000_000);
    const bt = new BackoffTracker(1000, 60_000, clock.now, () => 0.5);
    bt.record("abuse");
    expect(bt.failureCount).toBe(1);
    expect(bt.isBlocked()).toBe(true);
    // Base 1000ms * 2^0 = 1000ms, jittered by factor 1.0 (0.75 + 0.5*0.5 = 1.0)
    expect(bt.delayUntilMs()).toBe(1000);
  });

  it("grows the window exponentially across consecutive failures", () => {
    const clock = fixedClock(0);
    const bt = new BackoffTracker(1000, 60_000, clock.now, () => 0.5);
    bt.record("abuse"); // 1000
    bt.record("abuse"); // 2000
    bt.record("abuse"); // 4000
    expect(bt.failureCount).toBe(3);
    expect(bt.delayUntilMs()).toBe(4000);
  });

  it("caps the window at maxDelayMs", () => {
    const clock = fixedClock(0);
    const bt = new BackoffTracker(1000, 5000, clock.now, () => 0.5);
    for (let i = 0; i < 20; i++) bt.record("abuse");
    expect(bt.delayUntilMs()).toBe(5000);
  });

  it("clears everything on 'success'", () => {
    const bt = new BackoffTracker();
    bt.record("abuse");
    bt.record("success");
    expect(bt.failureCount).toBe(0);
    expect(bt.isBlocked()).toBe(false);
    expect(bt.delayUntilMs()).toBe(0);
  });

  it("ignores 'terminal' outcomes — they neither arm nor clear", () => {
    const bt = new BackoffTracker();
    bt.record("terminal");
    expect(bt.failureCount).toBe(0);
    expect(bt.isBlocked()).toBe(false);
  });

  it("un-blocks once the window elapses", () => {
    const clock = fixedClock(0);
    const bt = new BackoffTracker(1000, 60_000, clock.now, () => 0.5);
    bt.record("abuse");
    expect(bt.isBlocked()).toBe(true);
    clock.advance(2000);
    expect(bt.isBlocked()).toBe(false);
    expect(bt.delayUntilMs()).toBe(0);
  });

  it("reset() force-clears state from any point", () => {
    const bt = new BackoffTracker();
    bt.record("abuse");
    bt.record("abuse");
    bt.reset();
    expect(bt.failureCount).toBe(0);
    expect(bt.isBlocked()).toBe(false);
  });

  it("jitter produces a value within ±25% of the nominal delay", () => {
    const clock = fixedClock(0);
    const btLow = new BackoffTracker(1000, 60_000, clock.now, () => 0); // min jitter
    const btHigh = new BackoffTracker(1000, 60_000, clock.now, () => 1); // max jitter
    btLow.record("abuse");
    btHigh.record("abuse");
    expect(btLow.delayUntilMs()).toBe(750); // 1000 * 0.75
    expect(btHigh.delayUntilMs()).toBe(1250); // 1000 * 1.25
  });

  it("blockedUntilMs reports the absolute deadline timestamp", () => {
    const clock = fixedClock(1_000_000);
    const bt = new BackoffTracker(1000, 60_000, clock.now, () => 0.5);
    bt.record("abuse");
    expect(bt.blockedUntilMs).toBe(1_001_000);
  });
});
