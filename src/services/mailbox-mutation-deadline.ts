import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Keep the server-side mutation fence comfortably inside the MCP SDK's
 * 60-second default client request timeout. Reads retain ImapFlow's normal
 * timeout policy; only account-bound mailbox mutations use this deadline.
 */
export const MAILBOX_MUTATION_DEADLINE_MS = 50_000;

/** Tools whose handlers can issue an IMAP write on the routed account. */
export const MAILBOX_MUTATION_TOOLS: ReadonlySet<string> = new Set([
  "reply_to_email",
  "forward_email",
  "save_draft",
  "mark_email_read",
  "star_email",
  "mark_answered",
  "mark_forwarded",
  "move_email",
  "archive_email",
  "move_to_trash",
  "move_to_spam",
  "move_to_folder",
  "bulk_mark_read",
  "bulk_star",
  "bulk_move_emails",
  "move_to_label",
  "bulk_move_to_label",
  "remove_label",
  "bulk_remove_label",
  "delete_email",
  "bulk_delete",
  "bulk_delete_emails",
  "empty_trash",
  "create_folder",
  "delete_folder",
  "rename_folder",
]);

/** Immediate SMTP sends. Scheduled sends have their own background lifecycle. */
export const SMTP_MUTATION_TOOLS: ReadonlySet<string> = new Set([
  "send_email",
  "reply_to_email",
  "forward_email",
  "send_test_email",
]);

/** Every client-requested mail operation that can cross an account transport. */
export const ACCOUNT_MAIL_MUTATION_TOOLS: ReadonlySet<string> = new Set([
  ...MAILBOX_MUTATION_TOOLS,
  ...SMTP_MUTATION_TOOLS,
]);

type AbortKind = "client cancellation" | "server deadline" | "shared transport cancellation";

export class MailboxMutationDeadlineError extends Error {
  readonly code = "MAILPOUCH_MAILBOX_MUTATION_ABORTED";
  readonly outcomeUnknown: boolean;

  constructor(tool: string, kind: AbortKind, outcomeUnknown: boolean, transportError?: unknown) {
    const outcome = outcomeUnknown
      ? "An account mail command was already dispatched, so its outcome is unknown; inspect the mailbox before retrying."
      : "No account mail command was dispatched by this request. It is safe to retry after the connection recovers.";
    const transportDetail = transportError
      ? ` An account transport also failed to close cleanly: ${transportError instanceof Error ? transportError.message : String(transportError)}.`
      : "";
    super(`Account mail mutation '${tool}' stopped on ${kind}. ${outcome}${transportDetail}`);
    this.name = "MailboxMutationDeadlineError";
    this.outcomeUnknown = outcomeUnknown;
  }
}

interface MutationState {
  tool: string;
  signal: AbortSignal;
  deadlineAt: number;
  /** Sticky: once a wire command is attempted, a later timeout is ambiguous. */
  wireMutationDispatched: boolean;
  /** Transport descriptors allowed for this routed tool invocation. */
  transports: ReadonlyMap<object, () => void>;
  /** Per-request refcounts support nested/concurrent operations on one scope. */
  activeScopeCounts: Map<object, number>;
  abortPromise: Promise<never>;
  rejectAbort: (error: MailboxMutationDeadlineError) => void;
  abortError?: MailboxMutationDeadlineError;
  abort: (kind: AbortKind) => MailboxMutationDeadlineError;
}

const mutationContext = new AsyncLocalStorage<MutationState>();
const activeMutationsByTransport = new WeakMap<object, Set<MutationState>>();

export interface MailboxMutationDeadlineOptions {
  tool: string;
  signal: AbortSignal;
  /** Absolute wall-clock deadline captured when the MCP request arrived. */
  deadlineAt: number;
  /** Every shared routed transport this operation can write through. */
  transports: readonly AccountMutationTransport[];
}

/**
 * Background work has no MCP client signal or request deadline, but it can
 * still share a physical account transport with an interactive mutation. It
 * therefore needs the same transport membership and outcome-unknown fence.
 */
export interface BackgroundAccountMailMutationOptions {
  tool: string;
  transports: readonly AccountMutationTransport[];
}

export interface AccountMutationTransport {
  /** Shared service/transport identity used to find concurrent callers. */
  scope: object;
  /** Synchronously detach and hard-close this transport. */
  abort: () => void;
}

function assertMutationCanDispatch(state: MutationState): void {
  if (state.abortError) throw state.abortError;
  if (state.signal.aborted) throw state.abort("client cancellation");
  if (Date.now() >= state.deadlineAt) throw state.abort("server deadline");
}

function activateScope(state: MutationState, scope: object): void {
  if (!state.transports.has(scope)) {
    throw new Error(
      `Account mutation transport scope was not registered for tool '${state.tool}'`,
    );
  }
  const count = state.activeScopeCounts.get(scope) ?? 0;
  state.activeScopeCounts.set(scope, count + 1);
  if (count === 0) {
    let active = activeMutationsByTransport.get(scope);
    if (!active) {
      active = new Set();
      activeMutationsByTransport.set(scope, active);
    }
    active.add(state);
  }
}

function deactivateScope(state: MutationState, scope: object): void {
  const count = state.activeScopeCounts.get(scope);
  if (count === undefined) return;
  if (count > 1) {
    state.activeScopeCounts.set(scope, count - 1);
    return;
  }
  state.activeScopeCounts.delete(scope);
  const active = activeMutationsByTransport.get(scope);
  active?.delete(state);
  if (active?.size === 0) activeMutationsByTransport.delete(scope);
}

/**
 * Dispatch one account-bound wire mutation through `scope`.
 *
 * The scope is registered as active only for the lifetime of this promise.
 * This is intentionally narrower than the whole MCP handler: a reply handler,
 * for example, can read over IMAP and later send over SMTP without a timeout in
 * either phase needlessly tearing down the other transport. The sticky
 * dispatched bit remains set after a successful command so a later handler
 * timeout still tells the caller to inspect before retrying.
 */
export async function runAccountMailMutation<T>(
  scope: object,
  operation: () => Promise<T>,
): Promise<T> {
  const state = mutationContext.getStore();
  if (!state) return operation();

  assertMutationCanDispatch(state);
  activateScope(state, scope);
  state.wireMutationDispatched = true;

  let operationPromise: Promise<T>;
  try {
    operationPromise = Promise.resolve(operation());
  } catch (error) {
    deactivateScope(state, scope);
    throw error;
  }
  // The coordinator may reject first after hard-closing the shared transport.
  // Always observe a later transport rejection from the abandoned command.
  void operationPromise.catch(() => undefined);

  try {
    return await Promise.race([operationPromise, state.abortPromise]);
  } finally {
    deactivateScope(state, scope);
  }
}

/** IMAP-facing alias retained to make transport intent explicit at call sites. */
export const runMailboxMutation = runAccountMailMutation;

/**
 * A routed service owns one primary transport shared by concurrent requests.
 * Closing it for request A also makes request B's in-flight command ambiguous.
 * Discover the connected component first, reject every affected request with
 * outcome-aware semantics, and only then close each physical scope once. This
 * prevents a socket rejection from winning B's race as a misleading definite
 * failure (or, worse, B reporting success after its transport was poisoned).
 */
function abortMutationGroup(root: MutationState, rootKind: AbortKind): MailboxMutationDeadlineError {
  if (root.abortError) return root.abortError;

  const affected = new Set<MutationState>();
  const scopes = new Map<object, () => void>();
  const queue: MutationState[] = [root];
  while (queue.length > 0) {
    const state = queue.shift()!;
    if (affected.has(state)) continue;
    affected.add(state);
    for (const scope of state.activeScopeCounts.keys()) {
      const abort = state.transports.get(scope);
      if (abort && !scopes.has(scope)) scopes.set(scope, abort);
      for (const peer of activeMutationsByTransport.get(scope) ?? []) {
        if (!affected.has(peer)) queue.push(peer);
      }
    }
  }

  for (const state of affected) {
    if (state.abortError) continue;
    state.abortError = new MailboxMutationDeadlineError(
      state.tool,
      state === root ? rootKind : "shared transport cancellation",
      state.wireMutationDispatched,
    );
    state.rejectAbort(state.abortError);
  }

  const transportErrors: string[] = [];
  for (const abort of scopes.values()) {
    try { abort(); }
    catch (error) {
      transportErrors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (transportErrors.length > 0) {
    const detail = ` Account transport close failure(s): ${transportErrors.join("; ")}.`;
    for (const state of affected) {
      if (state.abortError) state.abortError.message += detail;
    }
  }
  return root.abortError!;
}

function createMutationState(
  tool: string,
  signal: AbortSignal,
  deadlineAt: number,
  transportOptions: readonly AccountMutationTransport[],
): MutationState {
  let rejectAbort!: (error: MailboxMutationDeadlineError) => void;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });

  const transports = new Map<object, () => void>();
  for (const transport of transportOptions) {
    transports.set(transport.scope, transport.abort);
  }

  const state: MutationState = {
    tool,
    signal,
    deadlineAt,
    wireMutationDispatched: false,
    transports,
    activeScopeCounts: new Map(),
    abortPromise,
    rejectAbort,
    abort: (kind) => abortMutationGroup(state, kind),
  };
  return state;
}

/**
 * Register a background account mutation with the shared-transport
 * coordinator. The operation has no request-owned cancellation deadline, but
 * if an interactive peer hard-closes the same transport this promise rejects
 * first with an outcome-aware MailboxMutationDeadlineError.
 */
export async function withBackgroundAccountMailMutation<T>(
  options: BackgroundAccountMailMutationOptions,
  operation: () => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const state = createMutationState(
    options.tool,
    controller.signal,
    Number.POSITIVE_INFINITY,
    options.transports,
  );
  const operationPromise = mutationContext.run(state, operation);
  void operationPromise.catch(() => undefined);
  return Promise.race([operationPromise, state.abortPromise]);
}

/**
 * Run one routed account mail mutation under client-cancellation and an
 * absolute deadline. The handler is raced so the MCP response does not wait
 * for a wedged transport promise. The abandoned async chain remains in this
 * AsyncLocalStorage context and cannot issue a later wire mutation.
 */
export async function withMailboxMutationDeadline<T>(
  options: MailboxMutationDeadlineOptions,
  operation: () => Promise<T>,
): Promise<T> {
  const state = createMutationState(
    options.tool,
    options.signal,
    options.deadlineAt,
    options.transports,
  );

  const onClientAbort = () => { state.abort("client cancellation"); };
  options.signal.addEventListener("abort", onClientAbort, { once: true });

  const remainingMs = options.deadlineAt - Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (remainingMs <= 0) {
    state.abort("server deadline");
  } else {
    timer = setTimeout(() => { state.abort("server deadline"); }, remainingMs);
    timer.unref?.();
  }

  const operationPromise = mutationContext.run(state, async () => {
    if (state.abortError) throw state.abortError;
    if (state.signal.aborted) throw state.abort("client cancellation");
    if (Date.now() >= state.deadlineAt) throw state.abort("server deadline");
    return operation();
  });
  // Promise.race installs handlers too, but this explicit rejection handler
  // documents and guarantees that a late failure from the abandoned operation
  // can never become an unhandled rejection.
  void operationPromise.catch(() => undefined);

  try {
    return await Promise.race([operationPromise, state.abortPromise]);
  } finally {
    if (timer) clearTimeout(timer);
    options.signal.removeEventListener("abort", onClientAbort);
  }
}
