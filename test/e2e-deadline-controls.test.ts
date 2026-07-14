import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFailClosedSetupAbort,
  raceWithDeadline,
  runDeadlinePhase,
} from "./e2e/support/deadline-race.mjs";
import { beginFailClosedDeadline } from "./e2e/support/fail-closed-deadline.mjs";

describe("Bridge E2E fail-closed deadline controls", () => {
  afterEach(() => vi.useRealTimers());

  it("rejects at the deadline when abort does not settle the operation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T00:00:00Z"));
    let rejectUnderlying: ((error: Error) => void) | undefined;
    const close = vi.fn();
    const operation = raceWithDeadline(
      () => new Promise<never>((_resolve, reject) => { rejectUnderlying = reject; }),
      {
        deadline: Date.now() + 25,
        label: "never-settling cleanup operation",
        onDeadline: close,
      },
    );
    const assertion = expect(operation).rejects.toMatchObject({
      code: "MAILPOUCH_E2E_CLEANUP_TIMEOUT",
    });

    await vi.advanceTimersByTimeAsync(25);
    await assertion;
    expect(close).toHaveBeenCalledOnce();

    // A losing operation may reject after the caller has already returned.
    // raceWithDeadline observes that rejection so it cannot become unhandled.
    rejectUnderlying?.(new Error("late transport rejection"));
    await Promise.resolve();
  });

  it("does not start an operation when its absolute deadline already passed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T00:00:00Z"));
    const operation = vi.fn();
    const close = vi.fn();

    await expect(raceWithDeadline(operation, {
      deadline: Date.now(),
      label: "expired cleanup operation",
      onDeadline: close,
    })).rejects.toMatchObject({ code: "MAILPOUCH_E2E_CLEANUP_TIMEOUT" });

    expect(operation).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes a never-settling standalone IMAP connect at the setup deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T00:00:00Z"));
    const client = {
      connect: vi.fn(() => new Promise<void>(() => undefined)),
      close: vi.fn(),
    };
    const transitions: Array<{
      label: string;
      state: string;
      at: number;
      deadline: number;
      elapsedMs: number;
    }> = [];
    const connecting = runDeadlinePhase(
      () => client.connect(),
      {
        deadline: Date.now() + 25,
        label: "IMAP connection and authentication setup",
        onDeadline: () => client.close(),
        onTransition: (transition) => transitions.push(transition),
      },
    );
    const assertion = expect(connecting).rejects.toMatchObject({
      code: "MAILPOUCH_E2E_CLEANUP_TIMEOUT",
    });

    await vi.advanceTimersByTimeAsync(25);
    await assertion;

    expect(client.connect).toHaveBeenCalledOnce();
    expect(client.close).toHaveBeenCalledOnce();
    expect(transitions.map(({ state }) => state)).toEqual(["started", "failed"]);
    expect(transitions[0]).toMatchObject({
      label: "IMAP connection and authentication setup",
      at: Date.parse("2026-07-13T00:00:00Z"),
      deadline: Date.parse("2026-07-13T00:00:00.025Z"),
      elapsedMs: 0,
    });
    expect(transitions[1]?.elapsedMs).toBe(25);
    expect(transitions.some((transition) => "error" in transition)).toBe(false);
  });

  it("closes both in-process setup transports when MCP initialization never settles", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T00:00:00Z"));
    const imap = { abortCleanupSession: vi.fn() };
    const mcp = {
      connect: vi.fn(() => new Promise<void>(() => undefined)),
      close: vi.fn(() => new Promise<void>(() => undefined)),
    };
    const transport = { close: vi.fn(() => new Promise<void>(() => undefined)) };
    const abortSetup = createFailClosedSetupAbort({
      abortImap: (reason) => imap.abortCleanupSession(reason),
      closeClient: () => mcp.close(),
      closeTransport: () => transport.close(),
    });
    const connecting = (async () => {
      try {
        return await runDeadlinePhase(
          () => mcp.connect(),
          {
            deadline: Date.now() + 25,
            label: "MCP child connection and initialization",
            onDeadline: () => abortSetup("setup deadline"),
          },
        );
      } catch (error) {
        // Mirrors startE2E's setup-failure branch: never await an already
        // initiated close after a deadline abort.
        if (!abortSetup.aborted) await mcp.close();
        throw error;
      }
    })();
    const assertion = expect(connecting).rejects.toMatchObject({
      code: "MAILPOUCH_E2E_CLEANUP_TIMEOUT",
    });

    await vi.advanceTimersByTimeAsync(25);
    await assertion;
    abortSetup("duplicate timeout");

    expect(abortSetup.aborted).toBe(true);
    expect(imap.abortCleanupSession).toHaveBeenCalledWith("setup deadline");
    expect(mcp.close).toHaveBeenCalledOnce();
    expect(transport.close).toHaveBeenCalledOnce();
  });

  it("lets the deadline win when an operation reports success at the boundary", async () => {
    vi.useFakeTimers();
    const startedAt = new Date("2026-07-13T00:00:00Z");
    vi.setSystemTime(startedAt);
    const close = vi.fn();

    const operation = raceWithDeadline(async () => {
      vi.setSystemTime(startedAt.getTime() + 25);
      return "too late";
    }, {
      deadline: startedAt.getTime() + 25,
      label: "boundary cleanup operation",
      onDeadline: close,
    });

    await expect(operation).rejects.toMatchObject({ code: "MAILPOUCH_E2E_CLEANUP_TIMEOUT" });
    expect(close).toHaveBeenCalledOnce();
  });

  it("forces process termination even when connection close throws", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T00:00:00Z"));
    const report = vi.fn();
    const terminate = vi.fn();
    const guard = beginFailClosedDeadline({
      deadline: Date.now() + 25,
      label: "standalone cleanup process",
      closeConnection: () => { throw new Error("already broken"); },
      report,
      terminate,
    });

    await vi.advanceTimersByTimeAsync(25);

    expect(guard.expired).toBe(true);
    expect(report).toHaveBeenCalledWith(expect.stringMatching(/manifest retained/i));
    expect(terminate).toHaveBeenCalledWith(1);
  });

  it("cancels the process watchdog after verified completion", async () => {
    vi.useFakeTimers();
    const terminate = vi.fn();
    const guard = beginFailClosedDeadline({
      deadline: Date.now() + 25,
      label: "standalone cleanup process",
      closeConnection: vi.fn(),
      report: vi.fn(),
      terminate,
    });
    guard.clear();

    await vi.advanceTimersByTimeAsync(30);

    expect(guard.expired).toBe(false);
    expect(terminate).not.toHaveBeenCalled();
  });

  it("synchronously expires a due watchdog before success can disarm it", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T00:00:00Z"));
    const terminate = vi.fn();
    const guard = beginFailClosedDeadline({
      deadline: Date.now() + 25,
      label: "standalone cleanup process",
      closeConnection: vi.fn(),
      report: vi.fn(),
      terminate,
    });
    vi.setSystemTime(Date.now() + 25);

    expect(guard.expireIfDue()).toBe(true);
    guard.clear();

    expect(guard.expired).toBe(true);
    expect(terminate).toHaveBeenCalledWith(1);
  });
});
