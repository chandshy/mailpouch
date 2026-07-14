import { AsyncLocalStorage } from "node:async_hooks";

export const E2E_MAILBOX_IDENTITY_ARG = "__mailpouchE2EExpectedMailbox";

const RUN_TOKEN_RE = /^mpE2E-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UID_RE = /^[1-9][0-9]{0,9}$/;
const UINT32_MAX = 0xffff_ffffn;

function isUint32(value: unknown): value is string {
  if (typeof value !== "string" || !UID_RE.test(value)) return false;
  try {
    return BigInt(value) <= UINT32_MAX;
  } catch {
    return false;
  }
}

function isAllowedOwnedSourcePath(folder: string, token: string): boolean {
  // The live harness may append a uniquely-owned test message to INBOX and
  // mutate only that exact UID. No other pre-existing/system mailbox is
  // eligible; all other writable sources must be token-namespaced scratch.
  if (folder === "INBOX") return true;
  return new RegExp(
    `^(?:Folders|Labels)/${token}(?:-[A-Za-z0-9][A-Za-z0-9._-]*| spaced [1-9][0-9]*)$`,
  ).test(folder);
}

export interface E2EMailboxIdentityExpectation {
  token: string;
  folder: string;
  uidValidity: string;
  uids: string[];
}

const expectations = new AsyncLocalStorage<E2EMailboxIdentityExpectation | undefined>();

function enabled(env: NodeJS.ProcessEnv): boolean {
  return env.MAILPOUCH_E2E_CONFIG_ONLY_CREDENTIALS === "1"
    && RUN_TOKEN_RE.test(env.MAILPOUCH_E2E_RUN_TOKEN ?? "");
}

/** A UID-scoped MOVE/DELETE is only actually UID-scoped when the selected
 * live server negotiated UIDPLUS. Without it, ImapFlow may fall back to a
 * plain EXPUNGE (or COPY + delete), which could affect unrelated messages
 * that were already marked \Deleted. Keep this guard inert outside the
 * tightly-scoped live Bridge E2E child. */
export function assertE2EUidPlusCapability(
  capabilities: { has(capability: string): boolean } | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!enabled(env)) return;
  if (!capabilities?.has("UIDPLUS")) {
    throw new Error(
      "Bridge E2E destructive mutation refused: IMAP server did not negotiate UIDPLUS",
    );
  }
}

function parseExpectation(
  args: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): E2EMailboxIdentityExpectation | undefined {
  const raw = args[E2E_MAILBOX_IDENTITY_ARG];
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Invalid internal Bridge E2E mailbox identity proof");
  }
  const value = raw as Record<string, unknown>;
  const token = value.token;
  const folder = value.folder;
  const uidValidity = value.uidValidity;
  const uids = value.uids;
  if (typeof token !== "string" || token !== env.MAILPOUCH_E2E_RUN_TOKEN
    || typeof folder !== "string" || !isAllowedOwnedSourcePath(folder, token)
    || !isUint32(uidValidity)
    || !Array.isArray(uids) || uids.length === 0
    || uids.some((uid) => !isUint32(uid))) {
    throw new Error("Invalid internal Bridge E2E mailbox identity proof");
  }
  const uniqueUids = [...new Set(uids as string[])];
  if (uniqueUids.length !== uids.length) {
    throw new Error("Invalid duplicate UID in internal Bridge E2E mailbox identity proof");
  }
  return { token, folder, uidValidity, uids: uniqueUids };
}

/** Bind a hidden harness proof to exactly one async MCP dispatch. Normal
 * production processes never enable this context. */
export function withE2EMailboxIdentity<T>(
  args: Record<string, unknown>,
  operation: () => T | Promise<T>,
  env: NodeJS.ProcessEnv = process.env,
): T | Promise<T> {
  if (!enabled(env)) return operation();
  return expectations.run(parseExpectation(args, env), operation);
}

/** Fail closed inside the child IMAP lock immediately before a live E2E
 * mutation. UID + UIDVALIDITY identifies the exact message because IMAP UIDs
 * are never reused within one mailbox identity. */
export function assertE2EMailboxIdentity(
  folder: string,
  uids: string[],
  mailbox: false | { uidValidity?: bigint | number | string } | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!enabled(env)) return;
  const expected = expectations.getStore();
  if (!expected) {
    throw new Error("Bridge E2E message mutation refused: mailbox identity proof is missing");
  }
  const actualUidValidity = mailbox && typeof mailbox === "object"
    && mailbox.uidValidity !== undefined
    ? String(mailbox.uidValidity)
    : undefined;
  if (folder !== expected.folder || actualUidValidity !== expected.uidValidity) {
    throw new Error(`Bridge E2E message mutation refused: mailbox identity changed for ${folder}`);
  }
  const expectedUids = new Set(expected.uids);
  if (uids.length === 0 || uids.some((uid) => !expectedUids.has(uid))) {
    throw new Error("Bridge E2E message mutation refused: UID operand was not pre-authorized");
  }
}
