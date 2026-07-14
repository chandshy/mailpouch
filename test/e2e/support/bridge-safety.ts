/**
 * Fail-closed policy for live Proton Bridge E2E calls.
 *
 * The Bridge lane runs against an operator mailbox. Read-only tools may inspect
 * that mailbox, but every server-side message mutation must prove that all
 * source UIDs belong to this run. Live mailbox create/rename/delete is refused:
 * IMAP has no atomic delete-if-empty primitive, so even a positively-created
 * folder cannot be removed without racing a foreign delivery.
 */

import { canonicalToolName } from "../../../src/config/schema.js";
import { E2E_MAILBOX_IDENTITY_ARG } from "../../../src/config/e2e-mailbox-identity.js";
import { allToolDefs } from "../../../src/tools/registry.js";
import { assertScratch, isScratchPath } from "./scratch.js";

export interface BridgeOwnershipProbe {
  isOwnedMessage(folder: string, uid: number, token: string): Promise<boolean>;
  proveOwnedMutation(
    folder: string,
    uids: number[],
    token: string,
  ): Promise<
    | { ok: true; uidValidity: string }
    | { ok: false; reason: "mailbox-identity" }
    | { ok: false; reason: "unowned"; uid: number }
  >;
  uidExists(folder: string, uid: number): Promise<boolean>;
  listUids(folder: string): Promise<number[]>;
  countMessages(folder: string): Promise<number>;
  isAllMailMailbox(folder: string): Promise<boolean>;
  isCreatedMailbox(folder: string, token: string): Promise<boolean>;
  draftsMailbox(): Promise<string | null>;
}

export interface BridgeSafetyContext {
  token: string;
  accountEmail: string;
  imap: BridgeOwnershipProbe;
}

export type BridgePostcondition =
  | { kind: "adopt-draft"; folder: string; expectedSubject: string }
  | { kind: "adopt-sent"; expectedSubject: string; expectedBodyToken?: string };

const READ_ONLY_TOOLS = new Set(
  allToolDefs()
    .filter((def) => def.annotations?.readOnlyHint === true)
    .map((def) => def.name),
);

/** Local cache/index refreshes do not change server-side mailbox state. */
const SAFE_LOCAL_MUTATIONS = new Set([
  "clear_cache",
  "fts_rebuild",
  "sync_emails",
  "sync_folders",
]);

const SINGLE_SOURCE_FOLDER = new Set([
  "archive_email",
  "delete_email",
  "mark_answered",
  "mark_email_read",
  "mark_forwarded",
  "move_to_spam",
  "move_to_trash",
  "star_email",
]);

const BULK_SOURCE_FOLDER = new Set([
  "bulk_delete_emails",
  "bulk_mark_read",
  "bulk_star",
]);

/** Existing system mailboxes which may contain exact run-owned source UIDs.
 * Keep this deliberately narrow. Moving/flagging a positively-owned INBOX UID
 * does not make any pre-existing message an operand. */
const SAFE_SYSTEM_MUTATION_SOURCES = new Set(["INBOX"]);

/** Existing destinations which accept exact run-owned messages without
 * mutating any message already present there. */
const SAFE_SYSTEM_MOVE_TARGETS = new Set(["Archive"]);

function requiredString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw refused(`requires a non-empty string argument '${name}'`);
  }
  return value.trim();
}

function numericUid(value: unknown, name: string): number {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw refused(`requires '${name}' to be a numeric IMAP UID string`);
  }
  const uid = Number(value);
  if (!Number.isSafeInteger(uid) || uid < 1 || uid > 0xffff_ffff) {
    throw refused(`requires '${name}' to be an IMAP UID in the uint32 range`);
  }
  return uid;
}

function numericUids(value: unknown, name = "emailIds"): number[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw refused(`requires a non-empty '${name}' array`);
  }
  return value.map((item, index) => numericUid(item, `${name}[${index}]`));
}

function sourceFolder(args: Record<string, unknown>, field = "sourceFolder"): string {
  const value = args[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw refused(`requires an explicit non-empty '${field}' for every live message mutation`);
  }
  return value.trim();
}

async function stableMutationSource(
  ctx: BridgeSafetyContext,
  args: Record<string, unknown>,
  field = "sourceFolder",
): Promise<string> {
  const folder = sourceFolder(args, field);
  if (await ctx.imap.isAllMailMailbox(folder)) {
    throw refused(
      `cannot mutate '${folder}' because Proton Bridge can remap All Mail UIDs without changing UIDVALIDITY`,
    );
  }
  if (!isScratchPath(folder, ctx.token) && !SAFE_SYSTEM_MUTATION_SOURCES.has(folder)) {
    throw refused(
      `live message mutations require INBOX or an exclusive scratch source owned by run ${ctx.token}; received '${folder}'`,
    );
  }
  return folder;
}

async function requireSafeMoveTarget(
  ctx: BridgeSafetyContext,
  folder: string,
): Promise<void> {
  if (SAFE_SYSTEM_MOVE_TARGETS.has(folder)) return;
  await requireCreatedScratch(ctx, folder, "move target");
}

async function requireCreatedScratch(
  ctx: BridgeSafetyContext,
  folder: string,
  role: string,
): Promise<void> {
  assertScratch(folder, ctx.token);
  if (!await ctx.imap.isCreatedMailbox(folder, ctx.token)) {
    throw refused(`${role} '${folder}' has no current identity-bound mailbox-creation proof for this run`);
  }
}

function assertSelfRecipient(args: Record<string, unknown>, accountEmail: string): void {
  const to = requiredString(args, "to").toLowerCase();
  if (to !== accountEmail.trim().toLowerCase()) {
    throw refused(`may send only to the configured Bridge account (${accountEmail})`);
  }
  for (const field of ["cc", "bcc"] as const) {
    if (typeof args[field] === "string" && args[field].trim() !== "") {
      throw refused(`does not allow '${field}' recipients in the live Bridge lane`);
    }
  }
  if (typeof args.replyTo === "string" && args.replyTo.trim().toLowerCase() !== accountEmail.trim().toLowerCase()) {
    throw refused("requires replyTo to be the configured Bridge account");
  }
}

function assertTokenText(value: unknown, field: string, token: string): string {
  if (typeof value !== "string" || !value.includes(token)) {
    throw refused(`requires '${field}' to contain the current run token '${token}'`);
  }
  return value;
}

function scratchLabel(args: Record<string, unknown>, token: string): { label: string; folder: string } {
  const label = requiredString(args, "label");
  const folder = `Labels/${label}`;
  assertScratch(folder, token);
  return { label, folder };
}

async function assertOwnedOperands(
  ctx: BridgeSafetyContext,
  folder: string,
  uids: number[],
): Promise<string> {
  const proof = await ctx.imap.proveOwnedMutation(folder, uids, ctx.token);
  if (proof.ok) return proof.uidValidity;
  if (proof.reason === "mailbox-identity") {
    throw refused(`scratch source '${folder}' has no positive mailbox-creation proof for its current identity`);
  }
  throw refused(`UID ${proof.uid} in '${folder}' is not owned by run ${ctx.token}`);
}

async function assertOwnedOne(
  ctx: BridgeSafetyContext,
  args: Record<string, unknown>,
  folder: string,
  field = "emailId",
): Promise<void> {
  const uids = [numericUid(args[field], field)];
  const uidValidity = await assertOwnedOperands(ctx, folder, uids);
  args[E2E_MAILBOX_IDENTITY_ARG] = {
    token: ctx.token,
    folder,
    uidValidity,
    uids: uids.map(String),
  };
}

async function assertOwnedMany(
  ctx: BridgeSafetyContext,
  args: Record<string, unknown>,
  folder: string,
): Promise<void> {
  const uids = numericUids(args.emailIds);
  const uidValidity = await assertOwnedOperands(ctx, folder, uids);
  args[E2E_MAILBOX_IDENTITY_ARG] = {
    token: ctx.token,
    folder,
    uidValidity,
    uids: uids.map(String),
  };
}

/**
 * Validate one live-Bridge call before it reaches the MCP transport.
 * Returns a postcondition when a successful call creates a system-folder
 * message which must be adopted into cleanup ownership.
 */
export async function guardBridgeCall(
  rawName: string,
  args: Record<string, unknown>,
  ctx: BridgeSafetyContext,
): Promise<BridgePostcondition | undefined> {
  const name = canonicalToolName(rawName);

  if (READ_ONLY_TOOLS.has(name) || SAFE_LOCAL_MUTATIONS.has(name)) return undefined;

  if (SINGLE_SOURCE_FOLDER.has(name)) {
    await assertOwnedOne(ctx, args, await stableMutationSource(ctx, args));
    return undefined;
  }
  if (BULK_SOURCE_FOLDER.has(name)) {
    await assertOwnedMany(ctx, args, await stableMutationSource(ctx, args));
    return undefined;
  }

  switch (name) {
    case "move_email": {
      const folder = await stableMutationSource(ctx, args);
      await requireSafeMoveTarget(ctx, requiredString(args, "targetFolder"));
      await assertOwnedOne(ctx, args, folder);
      return undefined;
    }
    case "move_to_folder": {
      const folder = await stableMutationSource(ctx, args);
      await requireCreatedScratch(ctx, `Folders/${requiredString(args, "folder")}`, "move target");
      await assertOwnedOne(ctx, args, folder);
      return undefined;
    }
    case "bulk_move_emails": {
      const folder = await stableMutationSource(ctx, args);
      await requireSafeMoveTarget(ctx, requiredString(args, "targetFolder"));
      await assertOwnedMany(ctx, args, folder);
      return undefined;
    }
    case "move_to_label": {
      const folder = await stableMutationSource(ctx, args);
      const target = scratchLabel(args, ctx.token);
      await requireCreatedScratch(ctx, target.folder, "label target");
      await assertOwnedOne(ctx, args, folder);
      return undefined;
    }
    case "bulk_move_to_label": {
      const folder = await stableMutationSource(ctx, args);
      const target = scratchLabel(args, ctx.token);
      await requireCreatedScratch(ctx, target.folder, "label target");
      await assertOwnedMany(ctx, args, folder);
      return undefined;
    }
    case "remove_label": {
      const { folder } = scratchLabel(args, ctx.token);
      await requireCreatedScratch(ctx, folder, "label source");
      await assertOwnedOne(ctx, args, folder);
      return undefined;
    }
    case "bulk_remove_label": {
      const { folder } = scratchLabel(args, ctx.token);
      await requireCreatedScratch(ctx, folder, "label source");
      await assertOwnedMany(ctx, args, folder);
      return undefined;
    }
    case "create_folder":
      assertScratch(requiredString(args, "folderName"), ctx.token);
      throw refused("create_folder is disabled against a live mailbox because its folder cannot later be deleted atomically");
    case "delete_folder": {
      const folder = requiredString(args, "folderName");
      assertScratch(folder, ctx.token);
      throw refused("delete_folder is disabled against a live mailbox because IMAP has no atomic delete-if-empty operation");
    }
    case "rename_folder": {
      const oldName = requiredString(args, "oldName");
      assertScratch(oldName, ctx.token);
      assertScratch(requiredString(args, "newName"), ctx.token);
      throw refused("rename_folder is disabled against a live mailbox because contents can change after the safety proof");
    }
    case "save_draft": {
      assertSelfRecipient(args, ctx.accountEmail);
      const expectedSubject = assertTokenText(args.subject, "subject", ctx.token);
      const folder = await ctx.imap.draftsMailbox();
      if (!folder) throw refused("save_draft could not resolve an existing Drafts mailbox before dispatch");
      return { kind: "adopt-draft", folder, expectedSubject };
    }
    case "send_email": {
      assertSelfRecipient(args, ctx.accountEmail);
      const expectedSubject = assertTokenText(args.subject, "subject", ctx.token);
      return { kind: "adopt-sent", expectedSubject };
    }
    case "send_test_email": {
      assertSelfRecipient(args, ctx.accountEmail);
      // Validate that the caller's full custom body contains this run token,
      // but persist/search only the exact token as the durable body proof.
      // This keeps the manifest grammar narrow while allowing descriptive
      // probe text around the token.
      assertTokenText(args.customMessage, "customMessage", ctx.token);
      return {
        kind: "adopt-sent",
        expectedSubject: "Test Email from mailpouch",
        expectedBodyToken: ctx.token,
      };
    }
    case "forward_email":
      // Its subject is derived after fetching the original. The harness cannot
      // know the exact result subject before dispatch, so safe adoption cannot
      // be established without a richer fixture API.
      throw refused("forward_email cannot predeclare the exact tokenized sent subject");
    case "reply_to_email":
      // The destination is derived from the original From header. Ownership of
      // the source alone cannot prove that destination is the configured self
      // address, so fail closed until the fixture exposes a verified sender.
      throw refused("reply_to_email cannot prove its derived recipient is the configured self address");
    case "empty_trash":
      throw refused("empty_trash is never permitted against a live Bridge mailbox");
    default:
      throw refused(`tool '${rawName}' is not classified as safe for live Bridge E2E`);
  }
}

/** Mutable registry tools which are not deliberately classified above. */
export function unclassifiedBridgeMutationTools(): string[] {
  const classified = new Set([
    ...SAFE_LOCAL_MUTATIONS,
    ...SINGLE_SOURCE_FOLDER,
    ...BULK_SOURCE_FOLDER,
    "move_email",
    "move_to_folder",
    "bulk_move_emails",
    "move_to_label",
    "bulk_move_to_label",
    "remove_label",
    "bulk_remove_label",
    "create_folder",
    "delete_folder",
    "rename_folder",
    "save_draft",
    "send_email",
    "send_test_email",
    "forward_email",
    "reply_to_email",
    "empty_trash",
  ]);
  return allToolDefs()
    .filter((def) => def.annotations?.readOnlyHint !== true && !classified.has(def.name))
    .map((def) => def.name)
    .sort();
}

function refused(reason: string): Error {
  return new Error(`Bridge E2E safety guard refused: ${reason}.`);
}
