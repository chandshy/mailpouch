import { describe, expect, it, vi } from "vitest";
import {
  coordinateStandaloneBridgeRecovery,
  shouldAttemptStandaloneBridgeRecovery,
} from "./e2e/support/cleanup-recovery.js";

const AMBIGUOUS = {
  fatalErrorCode: "MAILPOUCH_E2E_MUTATION_OUTCOME_UNKNOWN" as const,
};
const TIMEOUT = {
  fatalErrorCode: "MAILPOUCH_E2E_CLEANUP_TIMEOUT" as const,
};
const ALL_MAIL_RESCUE = {
  fatalErrorCode: "MAILPOUCH_E2E_ALL_MAIL_RESCUE_REQUIRED" as const,
};

describe("Bridge E2E cleanup recovery coordinator", () => {
  it("allows only a recoverable Bridge fatal state after an otherwise clean teardown", () => {
    expect(shouldAttemptStandaloneBridgeRecovery("bridge", AMBIGUOUS, false)).toBe(true);
    expect(shouldAttemptStandaloneBridgeRecovery("bridge", ALL_MAIL_RESCUE, false)).toBe(true);
    expect(shouldAttemptStandaloneBridgeRecovery("greenmail", AMBIGUOUS, false)).toBe(false);
    expect(shouldAttemptStandaloneBridgeRecovery("greenmail", ALL_MAIL_RESCUE, false)).toBe(false);
    expect(shouldAttemptStandaloneBridgeRecovery("bridge", TIMEOUT, false)).toBe(false);
    expect(shouldAttemptStandaloneBridgeRecovery("bridge", {}, false)).toBe(false);
    expect(shouldAttemptStandaloneBridgeRecovery("bridge", AMBIGUOUS, true)).toBe(false);
    expect(shouldAttemptStandaloneBridgeRecovery("bridge", ALL_MAIL_RESCUE, true)).toBe(false);
  });

  it("closes the in-process fixture before the deliberate All Mail handoff", async () => {
    const events: string[] = [];
    const outcome = await coordinateStandaloneBridgeRecovery({
      mode: "bridge",
      report: ALL_MAIL_RESCUE,
      hasPriorTeardownFailure: false,
      closePoisonedFixture: async () => { events.push("close"); return true; },
      recover: async () => { events.push("recover"); return "recovered"; },
    });

    expect(events).toEqual(["close", "recover"]);
    expect(outcome).toEqual({
      attempted: true,
      recovered: true,
      fixtureClosed: true,
      result: "recovered",
    });
  });

  it("closes the poisoned fixture before exactly one successful recovery attempt", async () => {
    const events: string[] = [];
    const close = vi.fn(async () => { events.push("close"); return true; });
    const recover = vi.fn(async () => { events.push("recover"); return { stdout: "ok" }; });

    await expect(coordinateStandaloneBridgeRecovery({
      mode: "bridge",
      report: AMBIGUOUS,
      hasPriorTeardownFailure: false,
      closePoisonedFixture: close,
      recover,
    })).resolves.toEqual({
      attempted: true,
      recovered: true,
      fixtureClosed: true,
      result: { stdout: "ok" },
    });
    expect(events).toEqual(["close", "recover"]);
    expect(close).toHaveBeenCalledOnce();
    expect(recover).toHaveBeenCalledOnce();
  });

  it("returns the one recovery failure without retrying", async () => {
    const failure = new Error("child retained manifest");
    const recover = vi.fn(async () => { throw failure; });

    await expect(coordinateStandaloneBridgeRecovery({
      mode: "bridge",
      report: AMBIGUOUS,
      hasPriorTeardownFailure: false,
      closePoisonedFixture: async () => true,
      recover,
    })).resolves.toEqual({
      attempted: true,
      recovered: false,
      fixtureClosed: true,
      error: failure,
    });
    expect(recover).toHaveBeenCalledOnce();
  });

  it.each([
    ["timeout", "bridge" as const, TIMEOUT, false, true],
    ["prior failure", "bridge" as const, AMBIGUOUS, true, true],
    ["Greenmail", "greenmail" as const, AMBIGUOUS, false, true],
    ["failed fixture close", "bridge" as const, AMBIGUOUS, false, false],
  ])("closes fatal state but does not recover for %s", async (
    _name,
    mode,
    report,
    hasPriorTeardownFailure,
    fixtureCloseResult,
  ) => {
    const close = vi.fn(async () => fixtureCloseResult);
    const recover = vi.fn(async () => undefined);
    const outcome = await coordinateStandaloneBridgeRecovery({
      mode,
      report,
      hasPriorTeardownFailure,
      closePoisonedFixture: close,
      recover,
    });

    expect(outcome).toEqual({
      attempted: false,
      recovered: false,
      fixtureClosed: fixtureCloseResult,
    });
    expect(close).toHaveBeenCalledOnce();
    expect(recover).not.toHaveBeenCalled();
  });

  it("does nothing for an ordinary nonfatal cleanup failure", async () => {
    const close = vi.fn(async () => true);
    const recover = vi.fn(async () => undefined);
    await expect(coordinateStandaloneBridgeRecovery({
      mode: "bridge",
      report: {},
      hasPriorTeardownFailure: false,
      closePoisonedFixture: close,
      recover,
    })).resolves.toEqual({ attempted: false, recovered: false, fixtureClosed: false });
    expect(close).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();
  });
});
