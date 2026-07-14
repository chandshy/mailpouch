import { describe, expect, it, vi } from "vitest";
import {
  ACCOUNT_MAIL_MUTATION_TOOLS,
  MailboxMutationDeadlineError,
  runAccountMailMutation,
  withBackgroundAccountMailMutation,
  withMailboxMutationDeadline,
} from "./mailbox-mutation-deadline.js";
import { SimpleIMAPService } from "./simple-imap-service.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("mailbox mutation request deadline", () => {
  it("honors client cancellation and prevents a late mutation after preflight", async () => {
    const controller = new AbortController();
    const preflight = deferred();
    const entered = deferred();
    const mutate = vi.fn();
    const closeTransport = vi.fn();
    const scope = {};

    const running = withMailboxMutationDeadline({
      tool: "move_email",
      signal: controller.signal,
      deadlineAt: Date.now() + 10_000,
      transports: [{ scope, abort: closeTransport }],
    }, async () => {
      entered.resolve();
      await preflight.promise;
      await runAccountMailMutation(scope, async () => { mutate(); });
    });

    await entered.promise;
    controller.abort();
    const error = await running.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MailboxMutationDeadlineError);
    expect((error as MailboxMutationDeadlineError).outcomeUnknown).toBe(false);
    expect((error as Error).message).toMatch(/no account mail command was dispatched/i);
    expect(closeTransport).not.toHaveBeenCalled();

    preflight.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mutate).not.toHaveBeenCalled();
  });

  it("reports outcome unknown and closes the transport after wire dispatch", async () => {
    const controller = new AbortController();
    const wireReply = deferred();
    const dispatched = deferred();
    const closeTransport = vi.fn();
    const scope = {};

    const running = withMailboxMutationDeadline({
      tool: "delete_email",
      signal: controller.signal,
      deadlineAt: Date.now() + 10_000,
      transports: [{ scope, abort: closeTransport }],
    }, async () => {
      await runAccountMailMutation(scope, async () => {
        dispatched.resolve();
        await wireReply.promise;
      });
    });

    await dispatched.promise;
    controller.abort();
    const error = await running.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MailboxMutationDeadlineError);
    expect((error as MailboxMutationDeadlineError).outcomeUnknown).toBe(true);
    expect((error as Error).message).toMatch(/outcome is unknown/i);
    expect(closeTransport).toHaveBeenCalledTimes(1);
    wireReply.resolve();
  });

  it("enforces the absolute server deadline without changing global socket policy", async () => {
    const closeTransport = vi.fn();
    const controller = new AbortController();
    const never = deferred();
    const scope = {};

    const running = withMailboxMutationDeadline({
      tool: "star_email",
      signal: controller.signal,
      deadlineAt: Date.now() + 20,
      transports: [{ scope, abort: closeTransport }],
    }, async () => {
      await runAccountMailMutation(scope, () => never.promise);
    });

    const error = await running.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MailboxMutationDeadlineError);
    expect((error as Error).message).toMatch(/server deadline/i);
    expect(closeTransport).toHaveBeenCalledTimes(1);
    never.resolve();
  });

  it("does not close a transport when the mutation completes in budget", async () => {
    const closeTransport = vi.fn();
    const scope = {};
    const result = await withMailboxMutationDeadline({
      tool: "mark_email_read",
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 10_000,
      transports: [{ scope, abort: closeTransport }],
    }, async () => {
      return runAccountMailMutation(scope, async () => "ok");
    });

    expect(result).toBe("ok");
    expect(closeTransport).not.toHaveBeenCalled();
  });

  it("checks the deadline adjacent to the real IMAP write after a delayed preflight", async () => {
    const controller = new AbortController();
    const preflight = deferred();
    const entered = deferred();
    const messageFlagsAdd = vi.fn().mockResolvedValue(true);
    const release = vi.fn();
    const client = {
      mailbox: { path: "INBOX", uidValidity: 1n },
      getMailboxLock: vi.fn().mockResolvedValue({ release }),
      fetch: async function* () {
        entered.resolve();
        await preflight.promise;
        yield { uid: 42 };
      },
      messageFlagsAdd,
      messageFlagsRemove: vi.fn(),
    };
    const service = new SimpleIMAPService();
    (service as unknown as { client: unknown }).client = client;
    (service as unknown as { isConnected: boolean }).isConnected = true;
    const closeTransport = vi.fn();

    const running = withMailboxMutationDeadline({
      tool: "mark_answered",
      signal: controller.signal,
      deadlineAt: Date.now() + 10_000,
      transports: [{ scope: service, abort: closeTransport }],
    }, () => service.setFlag("42", "\\Answered", true, "INBOX"));

    await entered.promise;
    controller.abort();
    await expect(running).rejects.toBeInstanceOf(MailboxMutationDeadlineError);
    preflight.resolve();
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
    expect(messageFlagsAdd).not.toHaveBeenCalled();
    expect(closeTransport).not.toHaveBeenCalled();
  });

  it("hard-closes only the primary command client, leaving IDLE untouched", () => {
    const primary = { close: vi.fn() };
    const idle = { close: vi.fn() };
    const service = new SimpleIMAPService();
    (service as unknown as { client: unknown }).client = primary;
    (service as unknown as { idleClient: unknown }).idleClient = idle;
    (service as unknown as { isConnected: boolean }).isConnected = true;

    service.abortPrimaryMutationTransport("test deadline");

    expect(primary.close).toHaveBeenCalledTimes(1);
    expect(idle.close).not.toHaveBeenCalled();
    expect(service.isActive()).toBe(false);
    expect((service as unknown as { idleClient: unknown }).idleClient).toBe(idle);
  });

  it("marks every concurrent caller outcome-unknown before closing its shared transport", async () => {
    const scope = {};
    const firstController = new AbortController();
    const secondController = new AbortController();
    const firstReply = deferred();
    const secondReply = deferred();
    const firstDispatched = deferred();
    const secondDispatched = deferred();
    const closeTransport = vi.fn();
    const run = (
      tool: string,
      signal: AbortSignal,
      dispatched: ReturnType<typeof deferred>,
      reply: ReturnType<typeof deferred>,
    ) => withMailboxMutationDeadline({
      tool,
      signal,
      deadlineAt: Date.now() + 10_000,
      transports: [{ scope, abort: closeTransport }],
    }, async () => {
      await runAccountMailMutation(scope, async () => {
        dispatched.resolve();
        await reply.promise;
      });
    });

    const first = run("move_email", firstController.signal, firstDispatched, firstReply);
    const second = run("delete_email", secondController.signal, secondDispatched, secondReply);
    await Promise.all([firstDispatched.promise, secondDispatched.promise]);
    firstController.abort();

    const [firstError, secondError] = await Promise.all([
      first.catch((error: unknown) => error),
      second.catch((error: unknown) => error),
    ]);
    expect(firstError).toBeInstanceOf(MailboxMutationDeadlineError);
    expect(secondError).toBeInstanceOf(MailboxMutationDeadlineError);
    expect((firstError as MailboxMutationDeadlineError).outcomeUnknown).toBe(true);
    expect((secondError as MailboxMutationDeadlineError).outcomeUnknown).toBe(true);
    expect((secondError as Error).message).toMatch(/shared transport cancellation/i);
    expect(closeTransport).toHaveBeenCalledTimes(1);
    firstReply.resolve();
    secondReply.resolve();
  });

  it("marks a concurrent background mutation outcome-unknown before an interactive abort closes its transport", async () => {
    const scope = {};
    const controller = new AbortController();
    const interactiveReply = deferred();
    const backgroundReply = deferred();
    const interactiveDispatched = deferred();
    const backgroundDispatched = deferred();
    const closeTransport = vi.fn();
    const transport = { scope, abort: closeTransport };

    const background = withBackgroundAccountMailMutation({
      tool: "scheduled_email:test-id",
      transports: [transport],
    }, () => runAccountMailMutation(scope, async () => {
      backgroundDispatched.resolve();
      await backgroundReply.promise;
    }));
    const interactive = withMailboxMutationDeadline({
      tool: "send_email",
      signal: controller.signal,
      deadlineAt: Date.now() + 10_000,
      transports: [transport],
    }, () => runAccountMailMutation(scope, async () => {
      interactiveDispatched.resolve();
      await interactiveReply.promise;
    }));

    await Promise.all([backgroundDispatched.promise, interactiveDispatched.promise]);
    controller.abort();

    const [interactiveError, backgroundError] = await Promise.all([
      interactive.catch((error: unknown) => error),
      background.catch((error: unknown) => error),
    ]);
    expect(interactiveError).toBeInstanceOf(MailboxMutationDeadlineError);
    expect(backgroundError).toBeInstanceOf(MailboxMutationDeadlineError);
    expect((backgroundError as MailboxMutationDeadlineError).outcomeUnknown).toBe(true);
    expect((backgroundError as Error).message).toMatch(/shared transport cancellation/i);
    expect(closeTransport).toHaveBeenCalledTimes(1);
    interactiveReply.resolve();
    backgroundReply.resolve();
  });

  it("does not tear down an inactive SMTP scope or cancel an SMTP-only peer", async () => {
    const imapScope = {};
    const smtpScope = {};
    const closeImap = vi.fn();
    const closeSmtp = vi.fn();
    const rootController = new AbortController();
    const peerController = new AbortController();
    const smtpController = new AbortController();
    const rootReply = deferred();
    const imapPeerReply = deferred();
    const smtpReply = deferred();
    const rootDispatched = deferred();
    const imapPeerDispatched = deferred();
    const smtpDispatched = deferred();
    const transports = [
      { scope: imapScope, abort: closeImap },
      { scope: smtpScope, abort: closeSmtp },
    ];
    const run = (
      tool: string,
      signal: AbortSignal,
      scope: object,
      dispatched: ReturnType<typeof deferred>,
      reply: ReturnType<typeof deferred>,
    ) => withMailboxMutationDeadline({
      tool,
      signal,
      deadlineAt: Date.now() + 10_000,
      transports,
    }, () => runAccountMailMutation(scope, async () => {
      dispatched.resolve();
      await reply.promise;
      return `${tool}-ok`;
    }));

    const root = run("reply_to_email", rootController.signal, imapScope, rootDispatched, rootReply);
    const imapPeer = run("move_email", peerController.signal, imapScope, imapPeerDispatched, imapPeerReply);
    const smtpPeer = run("send_email", smtpController.signal, smtpScope, smtpDispatched, smtpReply);
    await Promise.all([rootDispatched.promise, imapPeerDispatched.promise, smtpDispatched.promise]);

    rootController.abort();
    const [rootError, peerError] = await Promise.all([
      root.catch((error: unknown) => error),
      imapPeer.catch((error: unknown) => error),
    ]);
    expect(rootError).toBeInstanceOf(MailboxMutationDeadlineError);
    expect(peerError).toBeInstanceOf(MailboxMutationDeadlineError);
    expect(closeImap).toHaveBeenCalledTimes(1);
    expect(closeSmtp).not.toHaveBeenCalled();

    smtpReply.resolve();
    await expect(smtpPeer).resolves.toBe("send_email-ok");
    rootReply.resolve();
    imapPeerReply.resolve();
  });

  it("retains outcome-unknown after a completed wire mutation without closing an inactive scope", async () => {
    const scope = {};
    const closeTransport = vi.fn();
    const controller = new AbortController();
    const dispatchedAndCompleted = deferred();
    const laterHandlerWork = deferred();

    const running = withMailboxMutationDeadline({
      tool: "move_email",
      signal: controller.signal,
      deadlineAt: Date.now() + 10_000,
      transports: [{ scope, abort: closeTransport }],
    }, async () => {
      await runAccountMailMutation(scope, async () => undefined);
      dispatchedAndCompleted.resolve();
      await laterHandlerWork.promise;
    });

    await dispatchedAndCompleted.promise;
    controller.abort();
    const error = await running.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MailboxMutationDeadlineError);
    expect((error as MailboxMutationDeadlineError).outcomeUnknown).toBe(true);
    expect(closeTransport).not.toHaveBeenCalled();
    laterHandlerWork.resolve();
  });

  it("does not invoke an operation or transport abort when entry is already aborted", async () => {
    const scope = {};
    const controller = new AbortController();
    controller.abort();
    const operation = vi.fn(async () => undefined);
    const closeTransport = vi.fn();

    const error = await withMailboxMutationDeadline({
      tool: "delete_email",
      signal: controller.signal,
      deadlineAt: Date.now() + 10_000,
      transports: [{ scope, abort: closeTransport }],
    }, operation).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MailboxMutationDeadlineError);
    expect((error as MailboxMutationDeadlineError).outcomeUnknown).toBe(false);
    expect(operation).not.toHaveBeenCalled();
    expect(closeTransport).not.toHaveBeenCalled();
  });

  it("does not invoke an operation or transport abort when entry is already expired", async () => {
    const scope = {};
    const operation = vi.fn(async () => undefined);
    const closeTransport = vi.fn();

    const error = await withMailboxMutationDeadline({
      tool: "delete_email",
      signal: new AbortController().signal,
      deadlineAt: Date.now() - 1,
      transports: [{ scope, abort: closeTransport }],
    }, operation).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MailboxMutationDeadlineError);
    expect((error as MailboxMutationDeadlineError).outcomeUnknown).toBe(false);
    expect(operation).not.toHaveBeenCalled();
    expect(closeTransport).not.toHaveBeenCalled();
  });

  it("coalesces concurrent mutation reconnect preflights after a hard abort", async () => {
    const service = new SimpleIMAPService();
    const oldClient = { close: vi.fn() };
    (service as unknown as { client: unknown }).client = oldClient;
    (service as unknown as { isConnected: boolean }).isConnected = true;
    service.abortPrimaryMutationTransport("test cancellation");

    const reconnect = deferred();
    const ensureConnection = vi.spyOn(
      service as unknown as { ensureConnection: () => Promise<void> },
      "ensureConnection",
    ).mockImplementation(async () => reconnect.promise);

    const first = service.ensureMutationConnection();
    const second = service.ensureMutationConnection();
    expect(ensureConnection).toHaveBeenCalledTimes(1);
    (service as unknown as { client: unknown }).client = {};
    (service as unknown as { isConnected: boolean }).isConnected = true;
    reconnect.resolve();
    await Promise.all([first, second]);
  });

  it("rejects a coalesced reconnect that resolves without installing a current client and allows a fresh retry", async () => {
    const service = new SimpleIMAPService();
    const ensureConnection = vi.spyOn(
      service as unknown as { ensureConnection: () => Promise<void> },
      "ensureConnection",
    ).mockResolvedValue(undefined);

    const first = service.ensureMutationConnection();
    const second = service.ensureMutationConnection();
    await expect(first).rejects.toThrow(/IMAP connection is unavailable/i);
    await expect(second).rejects.toThrow(/IMAP connection is unavailable/i);
    expect(ensureConnection).toHaveBeenCalledTimes(1);

    await expect(service.ensureMutationConnection()).rejects.toThrow(/IMAP connection is unavailable/i);
    expect(ensureConnection).toHaveBeenCalledTimes(2);
  });

  it("throws actionable guidance instead of reporting success while disconnected", async () => {
    const service = new SimpleIMAPService();
    await expect(service.markEmailRead("42", true, "INBOX")).rejects.toThrow(
      /IMAP connection is unavailable.*Proton Bridge/is,
    );
  });

  it("covers direct sends and mixed reply/forward operations with the same deadline", () => {
    for (const tool of [
      "send_email",
      "send_test_email",
      "reply_to_email",
      "forward_email",
      "save_draft",
      "move_email",
      "delete_email",
    ]) {
      expect(ACCOUNT_MAIL_MUTATION_TOOLS.has(tool), tool).toBe(true);
    }
  });
});
