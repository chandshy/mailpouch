import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import * as actualFs from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireBridgeRunLease } from "./e2e/support/bridge-run-lease.js";
import { resolveBridgeAuthorityScope } from "./e2e/support/bridge-authority-root.mjs";

interface FakeMessage {
  uid: number;
  messageId?: string;
  subject: string;
  runHeader?: string | null;
  runHeaders?: string[];
  source?: string;
  flags?: string[];
}

interface PendingSentProof {
  id: string;
  kind: "pending-sent";
  subject: string;
  bodyToken?: string;
}

interface ManifestOverrides {
  pending?: PendingSentProof[];
  proofs?: Array<{
    kind: "message-id";
    messageId: string;
    subject: string;
    bodyToken?: string;
  }>;
  headerMessageIds?: string[];
  baselineMessages?: Array<{
    uid: number;
    flags: string[];
    messageIdHash?: string;
  }>;
  allMailBaselineMessages?: Array<{
    uid: number;
    flags: string[];
    messageIdHash?: string;
  }>;
  cleanup?: {
    allMailRescue: "create-pending" | "copy-pending" | "payload-observed" | "complete";
    rescueRearmConsumedHashes?: string[];
  };
}

const imap = vi.hoisted(() => ({
  token: "",
  connectCalls: 0,
  uidPlusChecks: 0,
  uidPlusAvailableThroughCheck: Number.POSITIVE_INFINITY,
  lockGeneration: 0,
  rejectMove: false,
  ambiguousMoveResults: 0,
  ambiguousCopyResults: 0,
  ambiguousCreateResults: 0,
  nextAllMailRemovalDelayConnections: 0,
  pendingAllMailRemovals: [] as Array<{ messageIds: string[]; remainingConnections: number }>,
  retainRescueSourceAssociation: false,
  closeCalls: 0,
  nextClientId: 0,
  listClientIds: [] as number[],
  lockEvents: [] as Array<{ clientId: number; path: string }>,
  mutationClientIds: [] as number[],
  extraMailboxes: [] as Array<{ path: string; uidValidity: bigint }>,
  folderDeletes: [] as Array<{ path: string; lockHeld: boolean }>,
  mailboxCreates: [] as Array<{ path: string; clientId: number }>,
  deleteOperands: [] as Array<{ path: string; uids: number[] }>,
  messages: {} as Record<string, FakeMessage[]>,
  mutations: [] as Array<{
    kind: "copy" | "move" | "delete";
    path: string;
    proofUnderSameLock: boolean;
    destination?: string;
    uids?: number[];
  }>,
  onConnect: undefined as undefined | (() => void),
  beforeMutation: undefined as undefined | (() => void),
}));

const setupJournal = vi.hoisted(() => ({ failRetirement: false }));

vi.mock("./e2e/support/bridge-setup-journal.mjs", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    retireBridgeSetupJournal: (...args: unknown[]) => {
      if (setupJournal.failRetirement) throw new Error("injected setup journal retirement failure");
      return actual.retireBridgeSetupJournal(...args);
    },
  };
});

vi.mock("imapflow", () => ({
  ImapFlow: class FakeImapFlow {
    private readonly clientId = ++imap.nextClientId;
    mailbox: { path: string; exists: number; uidValidity: bigint } | undefined;
    capabilities = {
      has: (capability: string) => {
        if (capability.toUpperCase() === "UIDPLUS") {
          imap.uidPlusChecks += 1;
          return imap.uidPlusChecks <= imap.uidPlusAvailableThroughCheck;
        }
        return capability.toUpperCase() === "MOVE";
      },
    };
    private lockedPath: string | undefined;
    private activeLockGeneration = 0;
    private proofLockGeneration = 0;

    async connect() {
      imap.connectCalls += 1;
      for (const pending of imap.pendingAllMailRemovals) pending.remainingConnections -= 1;
      const ready = imap.pendingAllMailRemovals.filter((pending) => pending.remainingConnections <= 0);
      imap.pendingAllMailRemovals = imap.pendingAllMailRemovals
        .filter((pending) => pending.remainingConnections > 0);
      for (const pending of ready) {
        const removedIds = new Set(pending.messageIds);
        imap.messages["All Mail"] = (imap.messages["All Mail"] ?? []).filter(
          (message) => !removedIds.has(message.messageId ?? ""),
        );
      }
      imap.onConnect?.();
    }

    close() {
      imap.closeCalls += 1;
    }

    async list() {
      imap.listClientIds.push(this.clientId);
      return [
        { path: "INBOX", flags: new Set<string>(), specialUse: undefined },
        { path: "Trash", flags: new Set<string>(), specialUse: "\\Trash" },
        { path: "All Mail", flags: new Set<string>(), specialUse: "\\All" },
        ...imap.extraMailboxes.map(({ path }) => ({
          path,
          flags: new Set<string>(),
          specialUse: undefined,
        })),
      ];
    }

    async getMailboxLock(path: string) {
      imap.lockEvents.push({ clientId: this.clientId, path });
      this.lockedPath = path;
      this.activeLockGeneration = ++imap.lockGeneration;
      this.mailbox = {
        path,
        exists: imap.messages[path]?.length ?? 0,
        uidValidity: imap.extraMailboxes.find((mailbox) => mailbox.path === path)?.uidValidity ?? 1n,
      };
      return {
        release: () => {
          this.lockedPath = undefined;
        },
      };
    }

    async search() {
      return (imap.messages[this.lockedPath ?? ""] ?? []).map(({ uid }) => uid);
    }

    fetch(uids: number[] | string) {
      const path = this.lockedPath;
      const generation = this.activeLockGeneration;
      const requested = new Set(Array.isArray(uids) ? uids : []);
      const messages = (imap.messages[path ?? ""] ?? [])
        .filter(({ uid }) => uids === "1:*" || requested.has(uid));
      const self = this;
      return (async function* () {
        for (const item of messages) {
          self.proofLockGeneration = generation;
          const runHeader = item.runHeader === undefined ? imap.token : item.runHeader;
          const runHeaders = item.runHeaders
            ?? (runHeader === null ? [] : [runHeader]);
          yield {
            uid: item.uid,
            envelope: { messageId: item.messageId, subject: item.subject },
            headers: Buffer.from(
              (item.messageId ? `Message-ID: <${item.messageId}>\r\n` : "") +
              `Subject: ${item.subject}\r\n` +
              runHeaders.map((value) => `X-MailPouch-E2E-Run: ${value}\r\n`).join(""),
            ),
            flags: new Set(item.flags ?? []),
            source: item.source ? Buffer.from(item.source) : undefined,
          };
        }
      })();
    }

    async messageMove(uids: number[], trash: string) {
      const source = this.lockedPath ?? "";
      imap.beforeMutation?.();
      imap.mutations.push({
        kind: "move",
        path: source,
        proofUnderSameLock: this.proofLockGeneration === this.activeLockGeneration,
      });
      imap.mutationClientIds.push(this.clientId);
      if (imap.rejectMove) throw new Error("server rejected MOVE after dispatch");
      const uid = uids[0]!;
      const sourceMessages = imap.messages[source] ?? [];
      const message = sourceMessages.find((entry) => entry.uid === uid)!;
      if (!(imap.retainRescueSourceAssociation && source.endsWith("-cleanup-rescue"))) {
        imap.messages[source] = sourceMessages.filter((entry) => entry.uid !== uid);
      }
      const destinationUid = 8;
      imap.messages[trash] = [...(imap.messages[trash] ?? []), { ...message, uid: destinationUid }];
      if (this.mailbox) this.mailbox.exists = imap.messages[source].length;
      if (imap.ambiguousMoveResults > 0) {
        imap.ambiguousMoveResults -= 1;
        return undefined;
      }
      return { uidValidity: 1n, uidMap: new Map([[uid, destinationUid]]) };
    }

    async messageCopy(uids: number[], destination: string) {
      const source = this.lockedPath ?? "";
      imap.beforeMutation?.();
      imap.mutations.push({
        kind: "copy",
        path: source,
        destination,
        uids: [...uids],
        proofUnderSameLock: this.proofLockGeneration === this.activeLockGeneration,
      });
      imap.mutationClientIds.push(this.clientId);
      const uid = uids[0]!;
      const message = (imap.messages[source] ?? []).find((entry) => entry.uid === uid)!;
      const destinationUid = Math.max(0, ...(imap.messages[destination] ?? []).map((entry) => entry.uid)) + 1;
      imap.messages[destination] = [
        ...(imap.messages[destination] ?? []),
        { ...message, uid: destinationUid },
      ];
      if (imap.ambiguousCopyResults > 0) {
        imap.ambiguousCopyResults -= 1;
        return undefined;
      }
      const destinationValidity = imap.extraMailboxes
        .find((mailbox) => mailbox.path === destination)?.uidValidity ?? 1n;
      return { uidValidity: destinationValidity, uidMap: new Map([[uid, destinationUid]]) };
    }

    async messageDelete(uids: number[]) {
      const path = this.lockedPath ?? "";
      imap.beforeMutation?.();
      imap.deleteOperands.push({ path, uids: [...uids] });
      imap.mutations.push({
        kind: "delete",
        path,
        proofUnderSameLock: this.proofLockGeneration === this.activeLockGeneration,
      });
      imap.mutationClientIds.push(this.clientId);
      const removed = new Set(uids);
      const removedMessages = (imap.messages[path] ?? []).filter(({ uid }) => removed.has(uid));
      imap.messages[path] = (imap.messages[path] ?? []).filter(({ uid }) => !removed.has(uid));
      if (path === "Trash") {
        const messageIds = removedMessages
          .map((message) => message.messageId)
          .filter((messageId): messageId is string => Boolean(messageId));
        if (imap.nextAllMailRemovalDelayConnections > 0) {
          imap.pendingAllMailRemovals.push({
            messageIds,
            remainingConnections: imap.nextAllMailRemovalDelayConnections,
          });
          imap.nextAllMailRemovalDelayConnections = 0;
        } else {
          const removedIds = new Set(messageIds);
          imap.messages["All Mail"] = (imap.messages["All Mail"] ?? []).filter(
            (message) => !removedIds.has(message.messageId ?? ""),
          );
        }
      }
      if (this.mailbox) this.mailbox.exists = imap.messages[path].length;
      return true;
    }

    async mailboxCreate(path: string) {
      imap.mailboxCreates.push({ path, clientId: this.clientId });
      if (imap.extraMailboxes.some((mailbox) => mailbox.path === path)) {
        return { path, created: false };
      }
      const uidValidity = BigInt(100 + imap.extraMailboxes.length);
      imap.extraMailboxes.push({ path, uidValidity });
      imap.messages[path] = [];
      if (imap.ambiguousCreateResults > 0) {
        imap.ambiguousCreateResults -= 1;
        return undefined;
      }
      return { path, created: true };
    }

    async mailboxClose() {
      this.mailbox = undefined;
    }

    async mailboxDelete(path: string) {
      imap.folderDeletes.push({ path, lockHeld: this.lockedPath === path });
      imap.extraMailboxes = imap.extraMailboxes.filter((mailbox) => mailbox.path !== path);
      this.mailbox = undefined;
      return { path };
    }
  },
}));

const roots: string[] = [];
const ORIGINAL_HOME = process.env.HOME;

function writeHarness(
  root: string,
  token: string,
  createdMailboxes: Array<{ path: string; uidValidity: string }> = [],
  overrides: ManifestOverrides = {},
) {
  const authorityConfigPath = join(root, "operator-config.json");
  const configPath = join(root, `.mailpouch-e2e-bridge-${token}.json`);
  const config = JSON.stringify({
    connection: {
      imapHost: "127.0.0.1",
      imapPort: 1143,
      username: "owner@example.test",
      password: "test-only-password",
      allowInsecureBridge: true,
    },
  });
  writeFileSync(authorityConfigPath, config, { mode: 0o600 });
  writeFileSync(configPath, config, { mode: 0o600 });
  process.env.HOME = root;
  process.env.MAILPOUCH_E2E_AUTHORITY_CONFIG = authorityConfigPath;
  const authority = resolveBridgeAuthorityScope({
    authorityConfigPath,
    homeRoot: root,
  });
  const manifestPath = join(authority.scopeRoot, `bridge-run-${token}.json`);
  writeFileSync(manifestPath, JSON.stringify({
    version: 2,
    token,
    pending: overrides.pending ?? [],
    proofs: overrides.proofs ?? [],
    headerMessageIds: overrides.headerMessageIds ?? [],
    createdMailboxes,
    baseline: {
      algorithm: "sha256",
      mailboxPaths: ["INBOX", "Trash", "All Mail"],
      mailboxes: [
        { path: "INBOX", uidValidity: "1", messages: overrides.baselineMessages ?? [] },
        { path: "Trash", uidValidity: "1", messages: [] },
        { path: "All Mail", uidValidity: "1", messages: overrides.allMailBaselineMessages ?? [] },
      ],
    },
    ...(overrides.cleanup ? { cleanup: overrides.cleanup } : {}),
  }));
  return { authorityConfigPath, configPath, manifestPath };
}

function prepareImap(token: string) {
  imap.token = token;
  imap.connectCalls = 0;
  imap.uidPlusChecks = 0;
  imap.uidPlusAvailableThroughCheck = Number.POSITIVE_INFINITY;
  imap.lockGeneration = 0;
  imap.rejectMove = false;
  imap.ambiguousMoveResults = 0;
  imap.ambiguousCopyResults = 0;
  imap.ambiguousCreateResults = 0;
  imap.nextAllMailRemovalDelayConnections = 0;
  imap.pendingAllMailRemovals = [];
  imap.retainRescueSourceAssociation = false;
  imap.closeCalls = 0;
  imap.nextClientId = 0;
  imap.listClientIds = [];
  imap.lockEvents = [];
  imap.mutationClientIds = [];
  imap.extraMailboxes = [];
  imap.folderDeletes = [];
  imap.mailboxCreates = [];
  imap.deleteOperands = [];
  imap.mutations = [];
  imap.onConnect = undefined;
  imap.beforeMutation = undefined;
  imap.messages = {
    INBOX: [{ uid: 7, messageId: "owned@example.test", subject: `${token} owned` }],
    Trash: [],
    "All Mail": [],
  };
}

function messageIdHash(messageId: string): string {
  return createHash("sha256").update(messageId, "utf8").digest("hex");
}

function rescueRearmHash(token: string, nonce: string): string {
  return createHash("sha256")
    .update(`mailpouch-e2e-rescue-rearm-v1\0${token}\0${nonce}`, "utf8")
    .digest("hex");
}

afterEach(() => {
  setupJournal.failRetirement = false;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetModules();
  delete process.env.MAILPOUCH_E2E_BRIDGE_CONFIG;
  delete process.env.MAILPOUCH_E2E_AUTHORITY_CONFIG;
  delete process.env.MAILPOUCH_E2E_LEASE_OWNER_TOKEN;
  delete process.env.MAILPOUCH_E2E_RUN_TOKEN;
  delete process.env.MAILPOUCH_E2E_RECOVERY_PEER_TOKENS;
  delete process.env.MAILPOUCH_E2E_RECOVERY_APPEND_HASHES;
  delete process.env.MAILPOUCH_E2E_REARM_RESCUE_COPY;
  delete process.env.MAILPOUCH_E2E_REARM_RESCUE_COPY_NONCE;
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("standalone Bridge cleanup safety", () => {
  it("deletes exact-owned Starred projections without dispatching MOVE", async () => {
    const token = "mpE2E-01010101-aaaa-4bbb-8ccc-111111111111";
    const root = mkdtempSync(join(tmpdir(), "mailpouch-standalone-starred-projection-"));
    roots.push(root);
    const { configPath, manifestPath } = writeHarness(root, token);
    prepareImap(token);
    imap.messages.INBOX = [];
    imap.extraMailboxes = [{ path: "Starred", uidValidity: 9n }];
    imap.messages.Starred = [{
      uid: 41,
      messageId: "starred-owned@example.test",
      subject: `${token} starred projection`,
    }];
    process.env.MAILPOUCH_E2E_BRIDGE_CONFIG = configPath;
    process.env.MAILPOUCH_E2E_RUN_TOKEN = token;
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`unexpected process.exit(${code})`);
    }) as never);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await import("./e2e/support/cleanup-bridge.mjs");

    expect(exit).not.toHaveBeenCalled();
    expect(imap.mutations).toContainEqual(expect.objectContaining({
      kind: "delete",
      path: "Starred",
      proofUnderSameLock: true,
    }));
    expect(imap.mutations).not.toContainEqual(expect.objectContaining({
      kind: "move",
      path: "Starred",
    }));
    expect(imap.messages.Starred).toEqual([]);
    expect(existsSync(manifestPath)).toBe(false);
    expect(existsSync(configPath)).toBe(false);
  }, 10_000);

  it("keeps the exact clone and manifest when setup-journal retirement fails", async () => {
    const token = "mpE2E-02020202-1111-4222-8333-444444444444";
    const root = mkdtempSync(join(tmpdir(), "mailpouch-standalone-journal-retire-"));
    roots.push(root);
    const { configPath, manifestPath } = writeHarness(root, token);
    prepareImap(token);
    imap.messages.INBOX = [];
    setupJournal.failRetirement = true;
    process.env.MAILPOUCH_E2E_BRIDGE_CONFIG = configPath;
    process.env.MAILPOUCH_E2E_RUN_TOKEN = token;
    vi.spyOn(process, "cwd").mockReturnValue(root);
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(import("./e2e/support/cleanup-bridge.mjs"))
      .rejects.toThrow(/process\.exit\(1\)/);

    expect(existsSync(configPath)).toBe(true);
    expect(existsSync(manifestPath)).toBe(true);
    expect(imap.mutations).toEqual([]);
  }, 10_000);

  it("atomically holds the shared run lease for an entire manual cleanup", async () => {
    const token = "mpE2E-03030303-1111-4222-8333-444444444444";
    const root = mkdtempSync(join(tmpdir(), "mailpouch-standalone-manual-lease-"));
    roots.push(root);
    const { authorityConfigPath, configPath, manifestPath } = writeHarness(root, token);
    prepareImap(token);
    process.env.MAILPOUCH_E2E_BRIDGE_CONFIG = configPath;
    process.env.MAILPOUCH_E2E_RUN_TOKEN = token;
    let contenderRefused = false;
    imap.onConnect = () => {
      try {
        const contender = acquireBridgeRunLease({
          authorityConfigPath,
          homeRoot: root,
          pid: 4343,
        });
        contender.release();
      } catch (error) {
        contenderRefused = /run lease already exists/i.test(String(error));
      }
    };
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`unexpected process.exit(${code})`);
    }) as never);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await import("./e2e/support/cleanup-bridge.mjs");

    expect(exit).not.toHaveBeenCalled();
    expect(contenderRefused).toBe(true);
    expect(existsSync(manifestPath)).toBe(false);
    expect(existsSync(configPath)).toBe(false);
    expect(existsSync(authorityConfigPath)).toBe(true);
    const next = acquireBridgeRunLease({
      authorityConfigPath,
      homeRoot: root,
      pid: 4444,
    });
    next.release();
  }, 10_000);

  it("refuses to report success when its manual cleanup lease was not released", async () => {
    vi.useFakeTimers();
    const token = "mpE2E-03030303-aaaa-4bbb-8ccc-444444444444";
    const root = mkdtempSync(join(tmpdir(), "mailpouch-standalone-retained-lease-"));
    roots.push(root);
    const { authorityConfigPath, configPath, manifestPath } = writeHarness(root, token);
    const authority = resolveBridgeAuthorityScope({ authorityConfigPath, homeRoot: root });
    const replacementOwner = {
      version: 1,
      pid: 9898,
      token: "replacement-owner-token-9898",
      createdAt: new Date().toISOString(),
    };
    prepareImap(token);
    let replaced = false;
    imap.onConnect = () => {
      if (replaced) return;
      replaced = true;
      writeFileSync(authority.leasePath, `${JSON.stringify(replacementOwner)}\n`, "utf8");
    };
    process.env.MAILPOUCH_E2E_BRIDGE_CONFIG = configPath;
    process.env.MAILPOUCH_E2E_RUN_TOKEN = token;
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    const errorOutput = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logOutput = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const assertion = expect(import("./e2e/support/cleanup-bridge.mjs"))
      .rejects.toThrow(/process\.exit\(1\)/);
    await vi.advanceTimersByTimeAsync(10_001);
    await assertion;

    expect(exit).toHaveBeenCalledWith(1);
    expect(errorOutput).toHaveBeenCalledWith(expect.stringMatching(/manual cleanup lease remains/i));
    expect(logOutput).not.toHaveBeenCalledWith(expect.stringMatching(/completed and verified/i));
    expect(JSON.parse(readFileSync(authority.leasePath, "utf8"))).toEqual(replacementOwner);
    expect(existsSync(configPath)).toBe(false);
    expect(existsSync(manifestPath)).toBe(false);
  }, 10_000);

  it("retains recovery authority and sends no mutation without UIDPLUS", async () => {
    const token = "mpE2E-04040404-1111-4222-8333-444444444444";
    const root = mkdtempSync(join(tmpdir(), "mailpouch-standalone-no-uidplus-"));
    roots.push(root);
    const { authorityConfigPath, configPath, manifestPath } = writeHarness(root, token);
    prepareImap(token);
    imap.uidPlusAvailableThroughCheck = 0;
    process.env.MAILPOUCH_E2E_BRIDGE_CONFIG = configPath;
    process.env.MAILPOUCH_E2E_RUN_TOKEN = token;
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    const errorOutput = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(import("./e2e/support/cleanup-bridge.mjs"))
      .rejects.toThrow(/process\.exit\(1\)/);

    expect(errorOutput).toHaveBeenCalledWith(expect.stringMatching(/UIDPLUS/i));
    expect(imap.connectCalls).toBe(1);
    expect(imap.mutations).toEqual([]);
    expect(existsSync(manifestPath)).toBe(true);
    const next = acquireBridgeRunLease({
      authorityConfigPath,
      homeRoot: root,
      pid: 4545,
    });
    next.release();
  });

  it("rechecks UIDPLUS immediately before dispatching an owned-message mutation", async () => {
    const token = "mpE2E-05050505-1111-4222-8333-444444444444";
    const root = mkdtempSync(join(tmpdir(), "mailpouch-standalone-lost-uidplus-"));
    roots.push(root);
    const { authorityConfigPath, configPath, manifestPath } = writeHarness(root, token);
    prepareImap(token);
    // Authentication succeeds with UIDPLUS, then the capability disappears
    // before the first exact-owned MOVE can reach the wire.
    imap.uidPlusAvailableThroughCheck = 1;
    process.env.MAILPOUCH_E2E_BRIDGE_CONFIG = configPath;
    process.env.MAILPOUCH_E2E_RUN_TOKEN = token;
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    const errorOutput = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(import("./e2e/support/cleanup-bridge.mjs"))
      .rejects.toThrow(/process\.exit\(1\)/);

    expect(errorOutput).toHaveBeenCalledWith(expect.stringMatching(/UIDPLUS/i));
    expect(imap.uidPlusChecks).toBeGreaterThanOrEqual(2);
    expect(imap.mutations).toEqual([]);
    expect(existsSync(manifestPath)).toBe(true);
  });

  it("revalidates UIDPLUS after every fresh-session reconnect", async () => {
    const token = "mpE2E-06060606-1111-4222-8333-444444444444";
    const root = mkdtempSync(join(tmpdir(), "mailpouch-standalone-reconnect-uidplus-"));
    roots.push(root);
    const { configPath, manifestPath } = writeHarness(root, token);
    prepareImap(token);
    imap.messages.INBOX = [];
    imap.uidPlusAvailableThroughCheck = 1;
    process.env.MAILPOUCH_E2E_BRIDGE_CONFIG = configPath;
    process.env.MAILPOUCH_E2E_RUN_TOKEN = token;
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    const errorOutput = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(import("./e2e/support/cleanup-bridge.mjs"))
      .rejects.toThrow(/process\.exit\(1\)/);

    expect(errorOutput).toHaveBeenCalledWith(expect.stringMatching(/reauthentication.*UIDPLUS/i));
    expect(imap.connectCalls).toBe(2);
    expect(imap.uidPlusChecks).toBe(2);
    expect(imap.mutations).toEqual([]);
    expect(existsSync(manifestPath)).toBe(true);
  }, 10_000);

  it("refuses manual cleanup while a live harness lease has no exact handoff", async () => {
    const token = "mpE2E-01010101-1111-4222-8333-444444444444";
    const root = mkdtempSync(join(tmpdir(), "mailpouch-standalone-live-lease-"));
    roots.push(root);
    const { authorityConfigPath, configPath, manifestPath } = writeHarness(root, token);
    prepareImap(token);
    process.env.MAILPOUCH_E2E_BRIDGE_CONFIG = configPath;
    process.env.MAILPOUCH_E2E_RUN_TOKEN = token;
    const lease = acquireBridgeRunLease({
      authorityConfigPath,
      homeRoot: root,
      pid: 4242,
    });
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    const errorOutput = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await expect(import("./e2e/support/cleanup-bridge.mjs"))
        .rejects.toThrow(/process\.exit\(1\)/);
      expect(errorOutput).toHaveBeenCalledWith(expect.stringMatching(/live harness lease.*owner-token handoff/i));
      expect(imap.connectCalls).toBe(0);
      expect(imap.mutations).toEqual([]);
      expect(existsSync(manifestPath)).toBe(true);
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      lease.release();
    }
  });

  it("refuses a valid-looking but non-owner cleanup handoff token", async () => {
    const token = "mpE2E-09090909-1111-4222-8333-444444444444";
    const root = mkdtempSync(join(tmpdir(), "mailpouch-standalone-wrong-handoff-"));
    roots.push(root);
    const { authorityConfigPath, configPath, manifestPath } = writeHarness(root, token);
    prepareImap(token);
    process.env.MAILPOUCH_E2E_BRIDGE_CONFIG = configPath;
    process.env.MAILPOUCH_E2E_RUN_TOKEN = token;
    const lease = acquireBridgeRunLease({
      authorityConfigPath,
      homeRoot: root,
      pid: 4242,
    });
    process.env.MAILPOUCH_E2E_LEASE_OWNER_TOKEN = "99999999-9999-4999-8999-999999999999";
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    const errorOutput = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await expect(import("./e2e/support/cleanup-bridge.mjs"))
        .rejects.toThrow(/process\.exit\(1\)/);
      expect(errorOutput).toHaveBeenCalledWith(expect.stringMatching(/exact owner-token handoff/i));
      expect(imap.connectCalls).toBe(0);
      expect(imap.mutations).toEqual([]);
      expect(existsSync(manifestPath)).toBe(true);
      expect(existsSync(lease.path)).toBe(true);
    } finally {
      lease.release();
    }
  });

  it("refuses the source profile and never treats it as a disposable recovery clone", async () => {
    const token = "mpE2E-07070707-1111-4222-8333-444444444444";
    const root = mkdtempSync(join(tmpdir(), "mailpouch-standalone-source-config-"));
    roots.push(root);
    const { authorityConfigPath, configPath, manifestPath } = writeHarness(root, token);
    prepareImap(token);
    process.env.MAILPOUCH_E2E_BRIDGE_CONFIG = authorityConfigPath;
    process.env.MAILPOUCH_E2E_RUN_TOKEN = token;
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    const errorOutput = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(import("./e2e/support/cleanup-bridge.mjs"))
      .rejects.toThrow(/process\.exit\(1\)/);

    expect(errorOutput).toHaveBeenCalledWith(expect.stringMatching(/exact token-bound recovery clone/i));
    expect(imap.connectCalls).toBe(0);
    expect(imap.mutations).toEqual([]);
    expect(existsSync(authorityConfigPath)).toBe(true);
    expect(existsSync(configPath)).toBe(true);
    expect(existsSync(manifestPath)).toBe(true);
  });

  it("refuses an exact-name recovery path which is a symlink to the source profile", async () => {
    const token = "mpE2E-08080808-1111-4222-8333-444444444444";
    const root = mkdtempSync(join(tmpdir(), "mailpouch-standalone-clone-symlink-"));
    roots.push(root);
    const { authorityConfigPath, configPath, manifestPath } = writeHarness(root, token);
    unlinkSync(configPath);
    symlinkSync(authorityConfigPath, configPath);
    prepareImap(token);
    process.env.MAILPOUCH_E2E_BRIDGE_CONFIG = configPath;
    process.env.MAILPOUCH_E2E_RUN_TOKEN = token;
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    const errorOutput = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(import("./e2e/support/cleanup-bridge.mjs"))
      .rejects.toThrow(/process\.exit\(1\)/);

    expect(errorOutput).toHaveBeenCalledWith(expect.stringMatching(/non-symlink/i));
    expect(imap.connectCalls).toBe(0);
    expect(imap.mutations).toEqual([]);
    expect(existsSync(authorityConfigPath)).toBe(true);
    expect(existsSync(configPath)).toBe(true);
    expect(existsSync(manifestPath)).toBe(true);
  });

  it("never unlinks a clone-path substitute exchanged after final validation", async () => {
    const token = "mpE2E-10101010-1111-4222-8333-444444444444";
    const root = mkdtempSync(join(tmpdir(), "mailpouch-standalone-clone-exchange-"));
    roots.push(root);
    const { configPath, manifestPath } = writeHarness(root, token);
    const originalAside = join(root, "validated-clone-aside.json");
    const substituteSource = join(root, "clone-substitute-source.json");
    const substituteContents = "sentinel substitute which must never be unlinked";
    writeFileSync(substituteSource, substituteContents, { mode: 0o600 });
    prepareImap(token);
    process.env.MAILPOUCH_E2E_BRIDGE_CONFIG = configPath;
    process.env.MAILPOUCH_E2E_RUN_TOKEN = token;
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    const errorOutput = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    let cloneReads = 0;
    vi.doMock("node:fs", () => {
      return {
        ...actualFs,
        readFileSync(path: Parameters<typeof readFileSync>[0], options?: unknown) {
          const value = actualFs.readFileSync(path, options as never);
          if (String(path) === configPath) {
            cloneReads += 1;
            if (cloneReads === 2) {
              actualFs.renameSync(configPath, originalAside);
              actualFs.renameSync(substituteSource, configPath);
            }
          }
          return value;
        },
      };
    });

    try {
      await expect(import("./e2e/support/cleanup-bridge.mjs"))
        .rejects.toThrow(/process\.exit\(1\)/);
    } finally {
      vi.doUnmock("node:fs");
    }

    const retainedFiles = readdirSync(root, { recursive: true })
      .map((entry) => join(root, String(entry)))
      .filter((path) => {
        try { return readFileSync(path, "utf8") === substituteContents; }
        catch { return false; }
      });
    expect(cloneReads).toBe(2);
    expect(errorOutput).toHaveBeenCalledWith(expect.stringMatching(/refusing to retire|substitute|identity/i));
    expect(readFileSync(originalAside, "utf8")).toContain("owner@example.test");
    expect(retainedFiles).toHaveLength(1);
    expect(existsSync(manifestPath)).toBe(true);
  }, 15_000);

  it("accepts only the live harness lease's exact owner-token handoff", async () => {
    const token = "mpE2E-02020202-1111-4222-8333-444444444444";
    const root = mkdtempSync(join(tmpdir(), "mailpouch-standalone-lease-handoff-"));
    roots.push(root);
    const { authorityConfigPath, configPath, manifestPath } = writeHarness(root, token);
    prepareImap(token);
    process.env.MAILPOUCH_E2E_BRIDGE_CONFIG = configPath;
    process.env.MAILPOUCH_E2E_RUN_TOKEN = token;
    const lease = acquireBridgeRunLease({
      authorityConfigPath,
      homeRoot: root,
      pid: 4242,
    });
    process.env.MAILPOUCH_E2E_LEASE_OWNER_TOKEN = lease.ownerToken;
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`unexpected process.exit(${code})`);
    }) as never);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      await import("./e2e/support/cleanup-bridge.mjs");
      expect(exit).not.toHaveBeenCalled();
      expect(imap.connectCalls).toBeGreaterThan(0);
      expect(existsSync(manifestPath)).toBe(false);
      expect(existsSync(configPath)).toBe(false);
      expect(existsSync(authorityConfigPath)).toBe(true);
      // The child receives delegated authority; the parent remains the lease
      // owner through its final config/runtime commit.
      expect(existsSync(lease.path)).toBe(true);
    } finally {
      lease.release();
    }
  }, 10_000);

  it("exempts a missing baseline message only from a peer finalized Message-ID proof", async () => {
    const token = "mpE2E-aaaaaaaa-1111-4222-8333-444444444444";
    const peerToken = "mpE2E-bbbbbbbb-5555-4666-8777-888888888888";
    const peerMessageId = "peer-finalized@example.test";
    const root = mkdtempSync(join(tmpdir(), "mailpouch-standalone-peer-proof-"));
    roots.push(root);
    writeHarness(root, peerToken, [], {
      proofs: [{
        kind: "message-id",
        messageId: peerMessageId,
        subject: `${peerToken} finalized`,
      }],
    });
    const { configPath, manifestPath } = writeHarness(root, token, [], {
      baselineMessages: [{ uid: 41, flags: [], messageIdHash: messageIdHash(peerMessageId) }],
    });
    prepareImap(token);
    imap.messages.INBOX = [];
    process.env.MAILPOUCH_E2E_BRIDGE_CONFIG = configPath;
    process.env.MAILPOUCH_E2E_RUN_TOKEN = token;
    process.env.MAILPOUCH_E2E_RECOVERY_PEER_TOKENS = peerToken;
    vi.spyOn(process, "cwd").mockReturnValue(root);
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`unexpected process.exit(${code})`);
    }) as never);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await import("./e2e/support/cleanup-bridge.mjs");

    expect(exit).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`applied 1 peer baseline exemption.*${peerToken}`, "i")),
    );
    expect(existsSync(manifestPath)).toBe(false);
  }, 10_000);

  it("uses each peer finalized proof at most once per mailbox path", async () => {
    vi.useFakeTimers();
    const token = "mpE2E-aaaabbbb-1111-4222-8333-444444444444";
    const peerToken = "mpE2E-bbbbcccc-5555-4666-8777-888888888888";
    const peerMessageId = "peer-duplicate@example.test";
    const hash = messageIdHash(peerMessageId);
    const root = mkdtempSync(join(tmpdir(), "mailpouch-standalone-peer-duplicate-"));
    roots.push(root);
    writeHarness(root, peerToken, [], {
      proofs: [{
        kind: "message-id",
        messageId: peerMessageId,
        subject: `${peerToken} finalized`,
      }],
    });
    const { configPath, manifestPath } = writeHarness(root, token, [], {
      baselineMessages: [
        { uid: 51, flags: [], messageIdHash: hash },
        { uid: 52, flags: [], messageIdHash: hash },
      ],
    });
    prepareImap(token);
    imap.messages.INBOX = [];
    process.env.MAILPOUCH_E2E_BRIDGE_CONFIG = configPath;
    process.env.MAILPOUCH_E2E_RUN_TOKEN = token;
    process.env.MAILPOUCH_E2E_RECOVERY_PEER_TOKENS = peerToken;
    vi.spyOn(process, "cwd").mockReturnValue(root);
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const assertion = expect(import("./e2e/support/cleanup-bridge.mjs"))
      .rejects.toThrow(/process\.exit\(1\)/);
    await vi.advanceTimersByTimeAsync(2_001);
    await assertion;

    expect(warning).toHaveBeenCalledWith(expect.stringMatching(/applied 1 peer baseline exemption/i));
    expect(existsSync(manifestPath)).toBe(true);
  });

  it("exempts one truly missing baseline projection only from exact append-origin evidence", async () => {
    const token = "mpE2E-cccccccc-1111-4222-8333-444444444444";
    const peerToken = "mpE2E-dddddddd-5555-4666-8777-888888888888";
    const peerMessageId = "peer-appended@example.test";
    const root = mkdtempSync(join(tmpdir(), "mailpouch-standalone-peer-append-"));
    roots.push(root);
    writeHarness(root, peerToken, [], {
      headerMessageIds: [peerMessageId],
      baselineMessages: [],
    });
    const { configPath, manifestPath } = writeHarness(root, token, [], {
      baselineMessages: [{ uid: 42, flags: [], messageIdHash: messageIdHash(peerMessageId) }],
    });
    prepareImap(token);
    imap.messages.INBOX = [];
    process.env.MAILPOUCH_E2E_BRIDGE_CONFIG = configPath;
    process.env.MAILPOUCH_E2E_RUN_TOKEN = token;
    process.env.MAILPOUCH_E2E_RECOVERY_PEER_TOKENS = peerToken;
    process.env.MAILPOUCH_E2E_RECOVERY_APPEND_HASHES =
      `${peerToken}:${messageIdHash(peerMessageId)}`;
    vi.spyOn(process, "cwd").mockReturnValue(root);
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`unexpected process.exit(${code})`);
    }) as never);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await import("./e2e/support/cleanup-bridge.mjs");

    expect(exit).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`explicit append-origin evidence.*${peerToken}`, "i")),
    );
    expect(existsSync(manifestPath)).toBe(false);
  }, 10_000);

  it("does not elevate peer header hints without an exact append-hash opt-in", async () => {
    vi.useFakeTimers();
    const token = "mpE2E-11111111-1111-4111-8111-111111111111";
    const peerToken = "mpE2E-22222222-2222-4222-8222-222222222222";
    const peerMessageId = "peer-hint-only@example.test";
    const root = mkdtempSync(join(tmpdir(), "mailpouch-standalone-peer-hint-only-"));
    roots.push(root);
    writeHarness(root, peerToken, [], { headerMessageIds: [peerMessageId] });
    const { configPath, manifestPath } = writeHarness(root, token, [], {
      baselineMessages: [{ uid: 42, flags: [], messageIdHash: messageIdHash(peerMessageId) }],
    });
    prepareImap(token);
    imap.messages.INBOX = [];
    process.env.MAILPOUCH_E2E_BRIDGE_CONFIG = configPath;
    process.env.MAILPOUCH_E2E_RUN_TOKEN = token;
    process.env.MAILPOUCH_E2E_RECOVERY_PEER_TOKENS = peerToken;
    vi.spyOn(process, "cwd").mockReturnValue(root);
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const assertion = expect(import("./e2e/support/cleanup-bridge.mjs"))
      .rejects.toThrow(/process\.exit\(1\)/);
    await vi.advanceTimersByTimeAsync(2_001);
    await assertion;

    expect(warning).not.toHaveBeenCalledWith(expect.stringMatching(/peer baseline exemption/i));
    expect(existsSync(manifestPath)).toBe(true);
  });

  it.each([
    {
      name: "concrete flag drift",
      actual: (messageId: string): FakeMessage => ({
        uid: 42,
        messageId,
        subject: "pre-existing",
        runHeader: null,
        flags: ["\\Seen"],
      }),
    },
    {
      name: "concrete Message-ID replacement",
      actual: (_messageId: string, peerToken: string): FakeMessage => ({
        uid: 42,
        messageId: "replacement@example.test",
        subject: "pre-existing",
        runHeader: peerToken,
      }),
    },
  ])("never uses append-origin evidence for $name", async ({ actual }) => {
    vi.useFakeTimers();
    const token = "mpE2E-33333333-3333-4333-8333-333333333333";
    const peerToken = "mpE2E-44444444-4444-4444-8444-444444444444";
    const peerMessageId = "peer-changed@example.test";
    const hash = messageIdHash(peerMessageId);
    const root = mkdtempSync(join(tmpdir(), "mailpouch-standalone-peer-changed-"));
    roots.push(root);
    writeHarness(root, peerToken, [], { headerMessageIds: [peerMessageId] });
    const { configPath, manifestPath } = writeHarness(root, token, [], {
      baselineMessages: [{ uid: 42, flags: [], messageIdHash: hash }],
    });
    prepareImap(token);
    imap.messages.INBOX = [actual(peerMessageId, peerToken)];
    process.env.MAILPOUCH_E2E_BRIDGE_CONFIG = configPath;
    process.env.MAILPOUCH_E2E_RUN_TOKEN = token;
    process.env.MAILPOUCH_E2E_RECOVERY_PEER_TOKENS = peerToken;
    process.env.MAILPOUCH_E2E_RECOVERY_APPEND_HASHES = `${peerToken}:${hash}`;
    vi.spyOn(process, "cwd").mockReturnValue(root);
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const assertion = expect(import("./e2e/support/cleanup-bridge.mjs"))
      .rejects.toThrow(/process\.exit\(1\)/);
    await vi.advanceTimersByTimeAsync(2_001);
    await assertion;

    expect(warning).not.toHaveBeenCalledWith(expect.stringMatching(/peer baseline exemption/i));
    expect(existsSync(manifestPath)).toBe(true);
  });

  it("accepts concrete flag-only drift with the exact live peer header", async () => {
    const token = "mpE2E-45454545-4545-4545-8545-454545454545";
    const peerToken = "mpE2E-56565656-5656-4656-8656-565656565656";
    const peerMessageId = "peer-live-concrete@example.test";
    const hash = messageIdHash(peerMessageId);
    const root = mkdtempSync(join(tmpdir(), "mailpouch-standalone-peer-live-concrete-"));
    roots.push(root);
    writeHarness(root, peerToken, [], { headerMessageIds: [peerMessageId] });
    const { configPath, manifestPath } = writeHarness(root, token, [], {
      baselineMessages: [{ uid: 42, flags: [], messageIdHash: hash }],
    });
    prepareImap(token);
    imap.messages.INBOX = [{
      uid: 42,
      messageId: peerMessageId,
      subject: "peer fixture",
      runHeader: peerToken,
      flags: ["\\Seen"],
    }];
    process.env.MAILPOUCH_E2E_BRIDGE_CONFIG = configPath;
    process.env.MAILPOUCH_E2E_RUN_TOKEN = token;
    process.env.MAILPOUCH_E2E_RECOVERY_PEER_TOKENS = peerToken;
    process.env.MAILPOUCH_E2E_RECOVERY_APPEND_HASHES = `${peerToken}:${hash}`;
    vi.spyOn(process, "cwd").mockReturnValue(root);
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`unexpected process.exit(${code})`);
    }) as never);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await import("./e2e/support/cleanup-bridge.mjs");

    expect(exit).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`exact live peer headers.*${peerToken}`, "i")),
    );
    expect(imap.mutations).toEqual([]);
    expect(existsSync(manifestPath)).toBe(false);
  }, 10_000);

  it("accepts one unique virtual flag-only projection with the exact live peer header", async () => {
    const token = "mpE2E-67676767-6767-4767-8767-676767676767";
    const peerToken = "mpE2E-78787878-7878-4878-8878-787878787878";
    const peerMessageId = "peer-live-virtual@example.test";
    const hash = messageIdHash(peerMessageId);
    const root = mkdtempSync(join(tmpdir(), "mailpouch-standalone-peer-live-virtual-"));
    roots.push(root);
    writeHarness(root, peerToken, [], { headerMessageIds: [peerMessageId] });
    const { configPath, manifestPath } = writeHarness(root, token, [], {
      allMailBaselineMessages: [{ uid: 52, flags: [], messageIdHash: hash }],
    });
    prepareImap(token);
    imap.messages.INBOX = [];
    imap.messages["All Mail"] = [{
      uid: 99,
      messageId: peerMessageId,
      subject: "peer fixture",
      runHeader: peerToken,
      flags: ["\\Seen"],
    }];
    process.env.MAILPOUCH_E2E_BRIDGE_CONFIG = configPath;
    process.env.MAILPOUCH_E2E_RUN_TOKEN = token;
    process.env.MAILPOUCH_E2E_RECOVERY_PEER_TOKENS = peerToken;
    process.env.MAILPOUCH_E2E_RECOVERY_APPEND_HASHES = `${peerToken}:${hash}`;
    vi.spyOn(process, "cwd").mockReturnValue(root);
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`unexpected process.exit(${code})`);
    }) as never);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await import("./e2e/support/cleanup-bridge.mjs");

    expect(exit).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith(expect.stringMatching(/exact live peer headers/i));
    expect(imap.mutations).toEqual([]);
    expect(existsSync(manifestPath)).toBe(false);
  }, 10_000);

  it("does not classify a concrete UID as disappeared when the same Message-ID moved to another UID", async () => {
    vi.useFakeTimers();
    const token = "mpE2E-89898989-8989-4989-8989-898989898989";
    const peerToken = "mpE2E-90909090-9090-4090-8090-909090909090";
    const peerMessageId = "peer-displaced-uid@example.test";
    const hash = messageIdHash(peerMessageId);
    const root = mkdtempSync(join(tmpdir(), "mailpouch-standalone-peer-displaced-"));
    roots.push(root);
    writeHarness(root, peerToken, [], { headerMessageIds: [peerMessageId] });
    const { configPath, manifestPath } = writeHarness(root, token, [], {
      baselineMessages: [{ uid: 42, flags: [], messageIdHash: hash }],
    });
    prepareImap(token);
    imap.messages.INBOX = [{
      uid: 43,
      messageId: peerMessageId,
      subject: "peer fixture",
      runHeader: peerToken,
    }];
    process.env.MAILPOUCH_E2E_BRIDGE_CONFIG = configPath;
    process.env.MAILPOUCH_E2E_RUN_TOKEN = token;
    process.env.MAILPOUCH_E2E_RECOVERY_PEER_TOKENS = peerToken;
    process.env.MAILPOUCH_E2E_RECOVERY_APPEND_HASHES = `${peerToken}:${hash}`;
    vi.spyOn(process, "cwd").mockReturnValue(root);
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const assertion = expect(import("./e2e/support/cleanup-bridge.mjs"))
      .rejects.toThrow(/process\.exit\(1\)/);
    await vi.advanceTimersByTimeAsync(2_001);
    await assertion;

    expect(warning).not.toHaveBeenCalledWith(expect.stringMatching(/peer baseline exemption/i));
    expect(imap.mutations).toEqual([]);
    expect(existsSync(manifestPath)).toBe(true);
  });

  it.each(["current candidates", "baseline records"])(
    "refuses ambiguous virtual flag drift with duplicate %s",
    async (duplicateKind) => {
      vi.useFakeTimers();
      const token = "mpE2E-91919191-9191-4191-8191-919191919191";
      const peerToken = "mpE2E-92929292-9292-4292-8292-929292929292";
      const peerMessageId = "peer-virtual-duplicate@example.test";
      const hash = messageIdHash(peerMessageId);
      const root = mkdtempSync(join(tmpdir(), "mailpouch-standalone-peer-virtual-duplicate-"));
      roots.push(root);
      writeHarness(root, peerToken, [], { headerMessageIds: [peerMessageId] });
      const baseline = duplicateKind === "baseline records"
        ? [
            { uid: 52, flags: [], messageIdHash: hash },
            { uid: 53, flags: [], messageIdHash: hash },
          ]
        : [{ uid: 52, flags: [], messageIdHash: hash }];
      const { configPath, manifestPath } = writeHarness(root, token, [], {
        allMailBaselineMessages: baseline,
      });
      prepareImap(token);
      imap.messages.INBOX = [];
      imap.messages["All Mail"] = [
        {
          uid: 99,
          messageId: peerMessageId,
          subject: "peer fixture",
          runHeader: peerToken,
          flags: ["\\Seen"],
        },
        ...(duplicateKind === "current candidates"
          ? [{
              uid: 100,
              messageId: peerMessageId,
              subject: "peer fixture duplicate",
              runHeader: peerToken,
              flags: ["\\Seen"],
            }]
          : []),
      ];
      process.env.MAILPOUCH_E2E_BRIDGE_CONFIG = configPath;
      process.env.MAILPOUCH_E2E_RUN_TOKEN = token;
      process.env.MAILPOUCH_E2E_RECOVERY_PEER_TOKENS = peerToken;
      process.env.MAILPOUCH_E2E_RECOVERY_APPEND_HASHES = `${peerToken}:${hash}`;
      vi.spyOn(process, "cwd").mockReturnValue(root);
      vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
        throw new Error(`process.exit(${code})`);
      }) as never);
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      const assertion = expect(import("./e2e/support/cleanup-bridge.mjs"))
        .rejects.toThrow(/process\.exit\(1\)/);
      await vi.advanceTimersByTimeAsync(2_001);
      await assertion;

      expect(warning).not.toHaveBeenCalledWith(expect.stringMatching(/peer baseline exemption/i));
      expect(existsSync(manifestPath)).toBe(true);
    },
  );

  it.each(["missing", "wrong", "duplicate"])(
    "does not exempt virtual flag drift with a %s peer ownership header",
    async (headerMode) => {
    vi.useFakeTimers();
    const token = "mpE2E-55555555-5555-4555-8555-555555555555";
    const peerToken = "mpE2E-66666666-6666-4666-8666-666666666666";
    const peerMessageId = "peer-virtual-flags@example.test";
    const hash = messageIdHash(peerMessageId);
    const root = mkdtempSync(join(tmpdir(), "mailpouch-standalone-peer-virtual-flags-"));
    roots.push(root);
    writeHarness(root, peerToken, [], { headerMessageIds: [peerMessageId] });
    const { configPath, manifestPath } = writeHarness(root, token, [], {
      allMailBaselineMessages: [{ uid: 52, flags: [], messageIdHash: hash }],
    });
    prepareImap(token);
    imap.messages.INBOX = [];
    const headerFields = headerMode === "wrong"
      ? { runHeader: "mpE2E-ffffffff-ffff-4fff-8fff-ffffffffffff" }
      : headerMode === "duplicate"
        ? { runHeader: null, runHeaders: [peerToken, peerToken] }
        : { runHeader: null };
    imap.messages["All Mail"] = [{
      uid: 99,
      messageId: peerMessageId,
      subject: "pre-existing",
      ...headerFields,
      flags: ["\\Seen"],
    }];
    process.env.MAILPOUCH_E2E_BRIDGE_CONFIG = configPath;
    process.env.MAILPOUCH_E2E_RUN_TOKEN = token;
    process.env.MAILPOUCH_E2E_RECOVERY_PEER_TOKENS = peerToken;
    process.env.MAILPOUCH_E2E_RECOVERY_APPEND_HASHES = `${peerToken}:${hash}`;
    vi.spyOn(process, "cwd").mockReturnValue(root);
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const assertion = expect(import("./e2e/support/cleanup-bridge.mjs"))
      .rejects.toThrow(/process\.exit\(1\)/);
    await vi.advanceTimersByTimeAsync(2_001);
    await assertion;

    expect(warning).not.toHaveBeenCalledWith(expect.stringMatching(/peer baseline exemption/i));
    expect(existsSync(manifestPath)).toBe(true);
    },
  );

  it("uses append-origin evidence at most once per hash and mailbox", async () => {
    vi.useFakeTimers();
    const token = "mpE2E-77777777-7777-4777-8777-777777777777";
    const peerToken = "mpE2E-88888888-8888-4888-8888-888888888888";
    const peerMessageId = "peer-append-duplicate@example.test";
    const hash = messageIdHash(peerMessageId);
    const root = mkdtempSync(join(tmpdir(), "mailpouch-standalone-peer-append-duplicate-"));
    roots.push(root);
    writeHarness(root, peerToken, [], { headerMessageIds: [peerMessageId] });
    const { configPath, manifestPath } = writeHarness(root, token, [], {
      baselineMessages: [
        { uid: 71, flags: [], messageIdHash: hash },
        { uid: 72, flags: [], messageIdHash: hash },
      ],
    });
    prepareImap(token);
    imap.messages.INBOX = [];
    process.env.MAILPOUCH_E2E_BRIDGE_CONFIG = configPath;
    process.env.MAILPOUCH_E2E_RUN_TOKEN = token;
    process.env.MAILPOUCH_E2E_RECOVERY_PEER_TOKENS = peerToken;
    process.env.MAILPOUCH_E2E_RECOVERY_APPEND_HASHES = `${peerToken}:${hash}`;
    vi.spyOn(process, "cwd").mockReturnValue(root);
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const assertion = expect(import("./e2e/support/cleanup-bridge.mjs"))
      .rejects.toThrow(/process\.exit\(1\)/);
    await vi.advanceTimersByTimeAsync(2_001);
    await assertion;

    expect(warning).toHaveBeenCalledWith(expect.stringMatching(/applied 1 peer baseline exemption/i));
    expect(existsSync(manifestPath)).toBe(true);
  });

  it.each(["malformed", "unmatched", "irrelevant", "not-supplied", "duplicate"])(
    "refuses a %s append-origin allowlist entry before connecting",
    async (kind) => {
      const token = "mpE2E-99999999-9999-4999-8999-999999999999";
      const peerToken = "mpE2E-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const otherToken = "mpE2E-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      const peerMessageId = "peer-explicit-entry@example.test";
      const peerHash = messageIdHash(peerMessageId);
      const otherHash = messageIdHash("not-a-peer-hint@example.test");
      const root = mkdtempSync(join(tmpdir(), "mailpouch-standalone-peer-entry-"));
      roots.push(root);
      writeHarness(root, peerToken, [], { headerMessageIds: [peerMessageId] });
      const activeHash = kind === "unmatched" || kind === "irrelevant" ? otherHash : peerHash;
      const { configPath, manifestPath } = writeHarness(root, token, [], {
        baselineMessages: [{ uid: 81, flags: [], messageIdHash: activeHash }],
      });
      prepareImap(token);
      process.env.MAILPOUCH_E2E_BRIDGE_CONFIG = configPath;
      process.env.MAILPOUCH_E2E_RUN_TOKEN = token;
      process.env.MAILPOUCH_E2E_RECOVERY_PEER_TOKENS = peerToken;
      process.env.MAILPOUCH_E2E_RECOVERY_APPEND_HASHES = kind === "malformed"
        ? "not-valid"
        : kind === "unmatched"
          ? `${peerToken}:${otherHash}`
          : kind === "irrelevant"
            ? `${peerToken}:${peerHash}`
          : kind === "not-supplied"
            ? `${otherToken}:${peerHash}`
            : `${peerToken}:${peerHash},${peerToken}:${peerHash}`;
      vi.spyOn(process, "cwd").mockReturnValue(root);
      vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
        throw new Error(`process.exit(${code})`);
      }) as never);
      vi.spyOn(console, "error").mockImplementation(() => undefined);

      await expect(import("./e2e/support/cleanup-bridge.mjs"))
        .rejects.toThrow(/process\.exit\(1\)/);

      expect(imap.connectCalls).toBe(0);
      expect(imap.mutations).toEqual([]);
      expect(existsSync(manifestPath)).toBe(true);
    },
  );

  it("refuses an append-origin hash with ambiguous peer hint owners", async () => {
    const token = "mpE2E-cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const peerToken = "mpE2E-dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const otherToken = "mpE2E-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const peerMessageId = "ambiguous-peer-hint@example.test";
    const hash = messageIdHash(peerMessageId);
    const root = mkdtempSync(join(tmpdir(), "mailpouch-standalone-peer-ambiguous-"));
    roots.push(root);
    writeHarness(root, peerToken, [], { headerMessageIds: [peerMessageId] });
    writeHarness(root, otherToken, [], { headerMessageIds: [peerMessageId] });
    const { configPath, manifestPath } = writeHarness(root, token, [], {
      baselineMessages: [{ uid: 82, flags: [], messageIdHash: hash }],
    });
    prepareImap(token);
    process.env.MAILPOUCH_E2E_BRIDGE_CONFIG = configPath;
    process.env.MAILPOUCH_E2E_RUN_TOKEN = token;
    process.env.MAILPOUCH_E2E_RECOVERY_PEER_TOKENS = `${peerToken},${otherToken}`;
    process.env.MAILPOUCH_E2E_RECOVERY_APPEND_HASHES = `${peerToken}:${hash}`;
    vi.spyOn(process, "cwd").mockReturnValue(root);
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(import("./e2e/support/cleanup-bridge.mjs"))
      .rejects.toThrow(/process\.exit\(1\)/);

    expect(imap.connectCalls).toBe(0);
    expect(imap.mutations).toEqual([]);
    expect(existsSync(manifestPath)).toBe(true);
  });

  it("never uses peer append hints for destructive message discovery", async () => {
    const token = "mpE2E-12121212-1212-4212-8212-121212121212";
    const peerToken = "mpE2E-34343434-3434-4434-8434-343434343434";
    const peerMessageId = "peer-not-active-ownership@example.test";
    const root = mkdtempSync(join(tmpdir(), "mailpouch-standalone-peer-discovery-"));
    roots.push(root);
    writeHarness(root, peerToken, [], { headerMessageIds: [peerMessageId] });
    const { configPath, manifestPath } = writeHarness(root, token, [], {
      baselineMessages: [{ uid: 42, flags: [], messageIdHash: messageIdHash(peerMessageId) }],
    });
    prepareImap(token);
    imap.messages.INBOX = [{
      uid: 42,
      messageId: peerMessageId,
      subject: `${peerToken} belongs to peer`,
      runHeader: peerToken,
    }];
    process.env.MAILPOUCH_E2E_BRIDGE_CONFIG = configPath;
    process.env.MAILPOUCH_E2E_RUN_TOKEN = token;
    process.env.MAILPOUCH_E2E_RECOVERY_PEER_TOKENS = peerToken;
    process.env.MAILPOUCH_E2E_RECOVERY_APPEND_HASHES =
      `${peerToken}:${messageIdHash(peerMessageId)}`;
    vi.spyOn(process, "cwd").mockReturnValue(root);
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`unexpected process.exit(${code})`);
    }) as never);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await import("./e2e/support/cleanup-bridge.mjs");

    expect(exit).not.toHaveBeenCalled();
    expect(imap.mutations).toEqual([]);
    expect(existsSync(manifestPath)).toBe(false);
  }, 10_000);

  it("refuses append-origin authority when the hint hash existed in the peer baseline", async () => {
    vi.useFakeTimers();
    const token = "mpE2E-ccccdddd-1111-4222-8333-444444444444";
    const peerToken = "mpE2E-ddddeeee-5555-4666-8777-888888888888";
    const peerMessageId = "peer-preexisting@example.test";
    const hash = messageIdHash(peerMessageId);
    const root = mkdtempSync(join(tmpdir(), "mailpouch-standalone-peer-preexisting-"));
    roots.push(root);
    writeHarness(root, peerToken, [], {
      headerMessageIds: [peerMessageId],
      baselineMessages: [{ uid: 12, flags: [], messageIdHash: hash }],
    });
    const { configPath, manifestPath } = writeHarness(root, token, [], {
      baselineMessages: [{ uid: 42, flags: [], messageIdHash: hash }],
    });
    prepareImap(token);
    imap.messages.INBOX = [];
    process.env.MAILPOUCH_E2E_BRIDGE_CONFIG = configPath;
    process.env.MAILPOUCH_E2E_RUN_TOKEN = token;
    process.env.MAILPOUCH_E2E_RECOVERY_PEER_TOKENS = peerToken;
    process.env.MAILPOUCH_E2E_RECOVERY_APPEND_HASHES = `${peerToken}:${hash}`;
    vi.spyOn(process, "cwd").mockReturnValue(root);
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const assertion = expect(import("./e2e/support/cleanup-bridge.mjs"))
      .rejects.toThrow(/process\.exit\(1\)/);
    await vi.advanceTimersByTimeAsync(2_001);
    await assertion;

    expect(warning).not.toHaveBeenCalledWith(expect.stringMatching(/peer baseline exemption/i));
    expect(existsSync(manifestPath)).toBe(true);
  });

  it.each([
    {
      name: "pending ownership proof",
      peer: (peerToken: string): ManifestOverrides => ({
        pending: [{
          id: "pending-12345678-1234-4abc-8def-1234567890ab",
          kind: "pending-sent",
          subject: `${peerToken} pending`,
        }],
        proofs: [],
      }),
    },
  ])("does not exempt a missing baseline message from a peer $name", async ({ peer }) => {
    vi.useFakeTimers();
    const token = "mpE2E-cccccccc-1111-4222-8333-444444444444";
    const peerToken = "mpE2E-dddddddd-5555-4666-8777-888888888888";
    const peerMessageId = "peer-unfinalized@example.test";
    const root = mkdtempSync(join(tmpdir(), "mailpouch-standalone-peer-unfinalized-"));
    roots.push(root);
    writeHarness(root, peerToken, [], peer(peerToken, peerMessageId));
    const { configPath, manifestPath } = writeHarness(root, token, [], {
      baselineMessages: [{ uid: 42, flags: [], messageIdHash: messageIdHash(peerMessageId) }],
    });
    prepareImap(token);
    imap.messages.INBOX = [];
    process.env.MAILPOUCH_E2E_BRIDGE_CONFIG = configPath;
    process.env.MAILPOUCH_E2E_RUN_TOKEN = token;
    process.env.MAILPOUCH_E2E_RECOVERY_PEER_TOKENS = peerToken;
    vi.spyOn(process, "cwd").mockReturnValue(root);
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const assertion = expect(import("./e2e/support/cleanup-bridge.mjs"))
      .rejects.toThrow(/process\.exit\(1\)/);
    await vi.advanceTimersByTimeAsync(2_001);
    await assertion;

    expect(warning).not.toHaveBeenCalledWith(expect.stringMatching(/peer baseline exemption/i));
    expect(existsSync(manifestPath)).toBe(true);
  });

  it("does not exempt a baseline record without a Message-ID hash", async () => {
    vi.useFakeTimers();
    const token = "mpE2E-eeeeeeee-1111-4222-8333-444444444444";
    const peerToken = "mpE2E-ffffffff-5555-4666-8777-888888888888";
    const root = mkdtempSync(join(tmpdir(), "mailpouch-standalone-peer-no-hash-"));
    roots.push(root);
    writeHarness(root, peerToken, [], {
      proofs: [{
        kind: "message-id",
        messageId: "peer-has-proof@example.test",
        subject: `${peerToken} finalized`,
      }],
    });
    const { configPath, manifestPath } = writeHarness(root, token, [], {
      baselineMessages: [{ uid: 43, flags: [] }],
    });
    prepareImap(token);
    imap.messages.INBOX = [];
    process.env.MAILPOUCH_E2E_BRIDGE_CONFIG = configPath;
    process.env.MAILPOUCH_E2E_RUN_TOKEN = token;
    process.env.MAILPOUCH_E2E_RECOVERY_PEER_TOKENS = peerToken;
    vi.spyOn(process, "cwd").mockReturnValue(root);
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const assertion = expect(import("./e2e/support/cleanup-bridge.mjs"))
      .rejects.toThrow(/process\.exit\(1\)/);
    await vi.advanceTimersByTimeAsync(2_001);
    await assertion;

    expect(existsSync(manifestPath)).toBe(true);
  });

  it.each([
    { name: "missing", writePeer: false },
    { name: "malformed", writePeer: true },
  ])("refuses $name recovery peer authority before connecting", async ({ writePeer }) => {
    const token = "mpE2E-01234567-89ab-4cde-8fab-0123456789ab";
    const peerToken = "mpE2E-76543210-ba98-4fed-8cba-ba9876543210";
    const root = mkdtempSync(join(tmpdir(), "mailpouch-standalone-peer-invalid-"));
    roots.push(root);
    if (writePeer) {
      const { manifestPath: peerManifestPath } = writeHarness(root, peerToken, [], {
        proofs: [{
          kind: "message-id",
          messageId: "peer-malformed@example.test",
          subject: `${peerToken} initially valid`,
        }],
      });
      const malformed = JSON.parse(readFileSync(peerManifestPath, "utf8"));
      malformed.proofs[0].subject = "not constrained to its run";
      writeFileSync(peerManifestPath, JSON.stringify(malformed));
    }
    const { configPath, manifestPath } = writeHarness(root, token);
    prepareImap(token);
    process.env.MAILPOUCH_E2E_BRIDGE_CONFIG = configPath;
    process.env.MAILPOUCH_E2E_RUN_TOKEN = token;
    process.env.MAILPOUCH_E2E_RECOVERY_PEER_TOKENS = peerToken;
    vi.spyOn(process, "cwd").mockReturnValue(root);
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    const errorOutput = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(import("./e2e/support/cleanup-bridge.mjs"))
      .rejects.toThrow(/process\.exit\(1\)/);

    expect(errorOutput).toHaveBeenCalledWith(expect.stringMatching(/invalid recovery peer authority/i));
    expect(imap.mutations).toEqual([]);
    expect(existsSync(manifestPath)).toBe(true);
  });

  it("keeps exact proof and each UID mutation under one mailbox lock", async () => {
    const token = "mpE2E-12345678-1234-4abc-8def-1234567890ab";
    const root = mkdtempSync(join(tmpdir(), "mailpouch-standalone-cleanup-"));
    roots.push(root);
    const { configPath, manifestPath } = writeHarness(root, token);
    prepareImap(token);
    process.env.MAILPOUCH_E2E_BRIDGE_CONFIG = configPath;
    process.env.MAILPOUCH_E2E_RUN_TOKEN = token;
    vi.spyOn(process, "cwd").mockReturnValue(root);
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`unexpected process.exit(${code})`);
    }) as never);
    vi.spyOn(console, "log").mockImplementation(() => {
      throw new Error("stdout closed after terminal commit");
    });

    await import("./e2e/support/cleanup-bridge.mjs");

    expect(exit).not.toHaveBeenCalled();
    expect(imap.mutations).toEqual([
      { kind: "move", path: "INBOX", proofUnderSameLock: true },
      { kind: "delete", path: "Trash", proofUnderSameLock: true },
    ]);
    expect(new Set(imap.mutationClientIds).size).toBe(imap.mutations.length);
    expect(imap.mutations.every(({ path }) => path !== "All Mail")).toBe(true);
    expect(existsSync(manifestPath)).toBe(false);
  }, 10_000);

  it("rescues three All Mail-only records as sequential singleton COPY cycles and retains the rescue", async () => {
    vi.useFakeTimers();
    const token = "mpE2E-31415926-5358-4979-8323-846264338327";
    const rescue = `Folders/${token}-cleanup-rescue`;
    const root = mkdtempSync(join(tmpdir(), "mailpouch-standalone-all-mail-rescue-"));
    roots.push(root);
    // No cleanup field is the current idle manifest shape.
    const { configPath, manifestPath } = writeHarness(root, token);
    prepareImap(token);
    imap.messages.INBOX = [];
    imap.messages["All Mail"] = [1, 2, 3].map((uid) => ({
      uid,
      messageId: `all-mail-owned-${uid}@example.test`,
      subject: `${token} All Mail residue ${uid}`,
    }));
    // Proton's virtual All Mail projection can retain the just-deleted record
    // across multiple fresh sessions. The next COPY must wait for the exact
    // owned count to decrease instead of copying that stale UID again.
    imap.nextAllMailRemovalDelayConnections = 3;
    let manifestAtFirstCopy: Record<string, unknown> | undefined;
    const durableRescuePhases = new Set<string>();
    imap.onConnect = () => {
      if (!existsSync(manifestPath)) return;
      const phase = JSON.parse(readFileSync(manifestPath, "utf8")).cleanup?.allMailRescue;
      if (typeof phase === "string") durableRescuePhases.add(phase);
    };
    imap.beforeMutation = () => {
      if (!manifestAtFirstCopy) manifestAtFirstCopy = JSON.parse(readFileSync(manifestPath, "utf8"));
    };
    process.env.MAILPOUCH_E2E_BRIDGE_CONFIG = configPath;
    process.env.MAILPOUCH_E2E_RUN_TOKEN = token;
    vi.spyOn(process, "cwd").mockReturnValue(root);
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`unexpected process.exit(${code})`);
    }) as never);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const completed = import("./e2e/support/cleanup-bridge.mjs");
    await vi.advanceTimersByTimeAsync(29_999);
    expect(imap.mutations.filter((mutation) => mutation.kind === "copy")).toEqual([]);
    await vi.advanceTimersByTimeAsync(50_002);
    await completed;

    expect(exit).not.toHaveBeenCalled();
    expect(imap.mailboxCreates).toHaveLength(1);
    expect(imap.mailboxCreates[0]!.path).toBe(rescue);
    const copies = imap.mutations.filter((mutation) => mutation.kind === "copy");
    expect(copies).toHaveLength(3);
    expect(copies.map((copy) => copy.uids)).toEqual([[1], [2], [3]]);
    expect(copies.every((copy) => (
      copy.path === "All Mail"
      && copy.destination === rescue
      && copy.uids?.length === 1
      && copy.proofUnderSameLock
    ))).toBe(true);
    expect(imap.mutations.map(({ kind, path }) => ({ kind, path }))).toEqual([
      { kind: "copy", path: "All Mail" },
      { kind: "move", path: rescue },
      { kind: "delete", path: "Trash" },
      { kind: "copy", path: "All Mail" },
      { kind: "move", path: rescue },
      { kind: "delete", path: "Trash" },
      { kind: "copy", path: "All Mail" },
      { kind: "move", path: rescue },
      { kind: "delete", path: "Trash" },
    ]);
    expect(new Set(imap.mutationClientIds).size).toBe(imap.mutationClientIds.length);
    expect(imap.mailboxCreates[0]!.clientId).not.toBe(
      imap.mutationClientIds[imap.mutations.findIndex((mutation) => mutation.kind === "copy")],
    );
    expect(manifestAtFirstCopy).toEqual(expect.objectContaining({
      cleanup: { allMailRescue: "copy-pending" },
      createdMailboxes: [{ path: rescue, uidValidity: "100" }],
    }));
    expect(durableRescuePhases).toEqual(new Set([
      "create-pending",
      "copy-pending",
      "payload-observed",
      "complete",
    ]));
    expect(imap.mutations
      .filter((mutation) => mutation.kind !== "copy")
      .every((mutation) => mutation.path !== "All Mail")).toBe(true);
    expect(imap.folderDeletes).toEqual([]);
    expect(imap.extraMailboxes).toContainEqual({ path: rescue, uidValidity: 100n });
    expect(warning).toHaveBeenCalledWith(expect.stringMatching(/retained.*manual deletion/i));
    expect(existsSync(manifestPath)).toBe(false);
  }, 10_000);

  it("restarts the full All Mail stability window after an intervening concrete mutation", async () => {
    vi.useFakeTimers();
    const token = "mpE2E-42424242-4242-4242-8242-424242424242";
    const root = mkdtempSync(join(tmpdir(), "mailpouch-standalone-rescue-stability-reset-"));
    roots.push(root);
    const { configPath, manifestPath } = writeHarness(root, token);
    prepareImap(token);
    imap.messages.INBOX = [];
    imap.messages["All Mail"] = [{
      uid: 31,
      messageId: "stable-after-mutation@example.test",
      subject: `${token} delayed All Mail residue`,
    }];
    const startedAt = Date.now();
    let injectedAt: number | undefined;
    let copiedAt: number | undefined;
    imap.onConnect = () => {
      if (injectedAt === undefined && Date.now() - startedAt >= 25_000) {
        injectedAt = Date.now();
        imap.messages.INBOX = [{
          uid: 44,
          messageId: "intervening-concrete@example.test",
          subject: `${token} intervening concrete residue`,
        }];
      }
    };
    imap.beforeMutation = () => {
      if (imap.lockEvents.at(-1)?.path === "All Mail" && copiedAt === undefined) {
        copiedAt = Date.now();
      }
    };
    process.env.MAILPOUCH_E2E_BRIDGE_CONFIG = configPath;
    process.env.MAILPOUCH_E2E_RUN_TOKEN = token;
    vi.spyOn(process, "cwd").mockReturnValue(root);
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`unexpected process.exit(${code})`);
    }) as never);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const completed = import("./e2e/support/cleanup-bridge.mjs");
    await vi.advanceTimersByTimeAsync(54_999);
    expect(injectedAt).toBeDefined();
    expect(copiedAt).toBeUndefined();
    await vi.advanceTimersByTimeAsync(45_002);
    await completed;

    expect(exit).not.toHaveBeenCalled();
    expect(copiedAt).toBeDefined();
    expect(copiedAt! - injectedAt!).toBeGreaterThanOrEqual(30_000);
    expect(imap.mutations.filter((mutation) => mutation.kind === "copy")).toHaveLength(1);
    expect(imap.mutations
      .filter((mutation) => mutation.kind !== "copy")
      .every((mutation) => mutation.path !== "All Mail")).toBe(true);
    expect(existsSync(manifestPath)).toBe(false);
  }, 10_000);

  it("durably distinguishes an ambiguous rescue CREATE before any COPY", async () => {
    vi.useFakeTimers();
    const token = "mpE2E-51515151-5151-4151-8151-515151515151";
    const rescue = `Folders/${token}-cleanup-rescue`;
    const root = mkdtempSync(join(tmpdir(), "mailpouch-standalone-rescue-create-ambiguous-"));
    roots.push(root);
    const { configPath, manifestPath } = writeHarness(root, token);
    prepareImap(token);
    imap.messages.INBOX = [];
    imap.messages["All Mail"] = [{
      uid: 61,
      messageId: "ambiguous-create@example.test",
      subject: `${token} ambiguous rescue CREATE`,
    }];
    imap.ambiguousCreateResults = 1;
    process.env.MAILPOUCH_E2E_BRIDGE_CONFIG = configPath;
    process.env.MAILPOUCH_E2E_RUN_TOKEN = token;
    vi.spyOn(process, "cwd").mockReturnValue(root);
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const assertion = expect(import("./e2e/support/cleanup-bridge.mjs"))
      .rejects.toThrow(/process\.exit\(1\)/);
    await vi.waitFor(() => expect(imap.connectCalls).toBeGreaterThan(0));
    await vi.advanceTimersByTimeAsync(182_001);
    await assertion;

    const retained = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(retained.cleanup).toEqual({ allMailRescue: "create-pending" });
    expect(retained.createdMailboxes).toEqual([]);
    expect(imap.extraMailboxes).toContainEqual({ path: rescue, uidValidity: 100n });
    expect(imap.mailboxCreates).toHaveLength(1);
    expect(imap.mutations.filter((mutation) => mutation.kind === "copy")).toEqual([]);
  }, 10_000);

  it("promotes a proven create-pending rescue without replaying CREATE or COPY", async () => {
    vi.useFakeTimers();
    const token = "mpE2E-52525252-5252-4252-8252-525252525252";
    const rescue = `Folders/${token}-cleanup-rescue`;
    const root = mkdtempSync(join(tmpdir(), "mailpouch-standalone-rescue-create-proof-crash-"));
    roots.push(root);
    const { configPath, manifestPath } = writeHarness(root, token, [{
      path: rescue,
      uidValidity: "100",
    }], {
      cleanup: { allMailRescue: "create-pending" },
    });
    prepareImap(token);
    imap.messages.INBOX = [];
    imap.messages["All Mail"] = [{
      uid: 66,
      messageId: "proven-create-pending@example.test",
      subject: `${token} proven CREATE crash window`,
    }];
    imap.extraMailboxes = [{ path: rescue, uidValidity: 100n }];
    imap.messages[rescue] = [];
    process.env.MAILPOUCH_E2E_BRIDGE_CONFIG = configPath;
    process.env.MAILPOUCH_E2E_RUN_TOKEN = token;
    vi.spyOn(process, "cwd").mockReturnValue(root);
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const assertion = expect(import("./e2e/support/cleanup-bridge.mjs"))
      .rejects.toThrow(/process\.exit\(1\)/);
    await vi.waitFor(() => expect(imap.connectCalls).toBeGreaterThan(0));
    await vi.advanceTimersByTimeAsync(182_001);
    await assertion;

    const retained = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(retained.cleanup).toEqual({ allMailRescue: "copy-pending" });
    expect(retained.createdMailboxes).toEqual([{ path: rescue, uidValidity: "100" }]);
    expect(imap.mailboxCreates).toEqual([]);
    expect(imap.mutations.filter((mutation) => mutation.kind === "copy")).toEqual([]);
  }, 10_000);

  it("adopts an ambiguously-created empty rescue only with a fresh nonce", async () => {
    vi.useFakeTimers();
    const token = "mpE2E-61616161-6161-4161-8161-616161616161";
    const nonce = "12".repeat(32);
    const rescue = `Folders/${token}-cleanup-rescue`;
    const root = mkdtempSync(join(tmpdir(), "mailpouch-standalone-rescue-create-adopt-"));
    roots.push(root);
    const { configPath, manifestPath } = writeHarness(root, token, [], {
      cleanup: { allMailRescue: "create-pending" },
    });
    prepareImap(token);
    imap.messages.INBOX = [];
    imap.messages["All Mail"] = [{
      uid: 71,
      messageId: "adopt-create@example.test",
      subject: `${token} adopt ambiguous rescue CREATE`,
    }];
    imap.extraMailboxes = [{ path: rescue, uidValidity: 100n }];
    imap.messages[rescue] = [];
    let manifestAtCopy: Record<string, unknown> | undefined;
    imap.beforeMutation = () => {
      if (imap.lockEvents.at(-1)?.path === "All Mail" && existsSync(manifestPath)) {
        manifestAtCopy = JSON.parse(readFileSync(manifestPath, "utf8"));
      }
    };
    process.env.MAILPOUCH_E2E_BRIDGE_CONFIG = configPath;
    process.env.MAILPOUCH_E2E_RUN_TOKEN = token;
    process.env.MAILPOUCH_E2E_REARM_RESCUE_COPY = token;
    process.env.MAILPOUCH_E2E_REARM_RESCUE_COPY_NONCE = nonce;
    vi.spyOn(process, "cwd").mockReturnValue(root);
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`unexpected process.exit(${code})`);
    }) as never);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const completed = import("./e2e/support/cleanup-bridge.mjs");
    await vi.advanceTimersByTimeAsync(25_001);
    await completed;

    expect(exit).not.toHaveBeenCalled();
    expect(imap.mailboxCreates).toEqual([]);
    expect(imap.mutations.filter((mutation) => mutation.kind === "copy")).toHaveLength(1);
    expect(manifestAtCopy).toEqual(expect.objectContaining({
      createdMailboxes: [{ path: rescue, uidValidity: "100" }],
      cleanup: {
        allMailRescue: "copy-pending",
        rescueRearmConsumedHashes: [rescueRearmHash(token, nonce)],
      },
    }));
    expect(existsSync(manifestPath)).toBe(false);
  }, 10_000);

  it("retries an unapplied ambiguous rescue CREATE only with a fresh nonce", async () => {
    vi.useFakeTimers();
    const token = "mpE2E-71717171-7171-4171-8171-717171717171";
    const nonce = "34".repeat(32);
    const rescue = `Folders/${token}-cleanup-rescue`;
    const root = mkdtempSync(join(tmpdir(), "mailpouch-standalone-rescue-create-retry-"));
    roots.push(root);
    const { configPath, manifestPath } = writeHarness(root, token, [], {
      cleanup: { allMailRescue: "create-pending" },
    });
    prepareImap(token);
    imap.messages.INBOX = [];
    imap.messages["All Mail"] = [{
      uid: 81,
      messageId: "retry-create@example.test",
      subject: `${token} retry ambiguous rescue CREATE`,
    }];
    process.env.MAILPOUCH_E2E_BRIDGE_CONFIG = configPath;
    process.env.MAILPOUCH_E2E_RUN_TOKEN = token;
    process.env.MAILPOUCH_E2E_REARM_RESCUE_COPY = token;
    process.env.MAILPOUCH_E2E_REARM_RESCUE_COPY_NONCE = nonce;
    vi.spyOn(process, "cwd").mockReturnValue(root);
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`unexpected process.exit(${code})`);
    }) as never);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const completed = import("./e2e/support/cleanup-bridge.mjs");
    await vi.advanceTimersByTimeAsync(25_001);
    await completed;

    expect(exit).not.toHaveBeenCalled();
    expect(imap.mailboxCreates).toHaveLength(1);
    expect(imap.mailboxCreates[0]!.path).toBe(rescue);
    expect(imap.mutations.filter((mutation) => mutation.kind === "copy")).toHaveLength(1);
    expect(imap.mutations
      .filter((mutation) => mutation.kind !== "copy")
      .every((mutation) => mutation.path !== "All Mail")).toBe(true);
    expect(existsSync(manifestPath)).toBe(false);
  }, 10_000);

  it("rediscovers an initially ambiguous applied COPY without replaying it", async () => {
    vi.useFakeTimers();
    const token = "mpE2E-22360679-7749-4978-8964-091736687312";
    const rescue = `Folders/${token}-cleanup-rescue`;
    const root = mkdtempSync(join(tmpdir(), "mailpouch-standalone-rescue-ambiguous-initial-"));
    roots.push(root);
    const { configPath, manifestPath } = writeHarness(root, token);
    prepareImap(token);
    imap.messages.INBOX = [];
    imap.messages["All Mail"] = [{
      uid: 31,
      messageId: "ambiguous-initial@example.test",
      subject: `${token} ambiguous initial COPY`,
    }];
    imap.ambiguousCopyResults = 1;
    process.env.MAILPOUCH_E2E_BRIDGE_CONFIG = configPath;
    process.env.MAILPOUCH_E2E_RUN_TOKEN = token;
    vi.spyOn(process, "cwd").mockReturnValue(root);
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`unexpected process.exit(${code})`);
    }) as never);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const completed = import("./e2e/support/cleanup-bridge.mjs");
    await vi.advanceTimersByTimeAsync(60_001);
    await completed;

    expect(exit).not.toHaveBeenCalled();
    expect(imap.mutations.filter((mutation) => mutation.kind === "copy")).toHaveLength(1);
    expect(imap.mutations.map(({ kind, path }) => ({ kind, path }))).toEqual([
      { kind: "copy", path: "All Mail" },
      { kind: "move", path: rescue },
      { kind: "delete", path: "Trash" },
    ]);
    expect(existsSync(manifestPath)).toBe(false);
  }, 10_000);

  it("rediscovers an ambiguous later-cycle COPY without reconstructing replay authority", async () => {
    vi.useFakeTimers();
    const token = "mpE2E-24494897-4278-4178-8920-154599145532";
    const root = mkdtempSync(join(tmpdir(), "mailpouch-standalone-rescue-ambiguous-later-"));
    roots.push(root);
    const { configPath, manifestPath } = writeHarness(root, token);
    prepareImap(token);
    imap.messages.INBOX = [];
    imap.messages["All Mail"] = [1, 2].map((uid) => ({
      uid,
      messageId: `ambiguous-later-${uid}@example.test`,
      subject: `${token} ambiguous later COPY ${uid}`,
    }));
    let armedSecondCopy = false;
    imap.beforeMutation = () => {
      const copiesSoFar = imap.mutations.filter((mutation) => mutation.kind === "copy").length;
      if (!armedSecondCopy && copiesSoFar === 1) {
        armedSecondCopy = true;
        imap.ambiguousCopyResults = 1;
      }
    };
    process.env.MAILPOUCH_E2E_BRIDGE_CONFIG = configPath;
    process.env.MAILPOUCH_E2E_RUN_TOKEN = token;
    vi.spyOn(process, "cwd").mockReturnValue(root);
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`unexpected process.exit(${code})`);
    }) as never);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const completed = import("./e2e/support/cleanup-bridge.mjs");
    await vi.advanceTimersByTimeAsync(70_001);
    await completed;

    expect(exit).not.toHaveBeenCalled();
    expect(armedSecondCopy).toBe(true);
    expect(imap.mutations.filter((mutation) => mutation.kind === "copy")).toHaveLength(2);
    expect(imap.mutations.filter((mutation) => mutation.kind === "move")).toHaveLength(2);
    expect(imap.mutations.filter((mutation) => mutation.kind === "delete" && mutation.path === "Trash"))
      .toHaveLength(2);
    expect(existsSync(manifestPath)).toBe(false);
  }, 10_000);

  it("permits one exact-token operator rearm after two fresh empty rescue proofs", async () => {
    vi.useFakeTimers();
    const token = "mpE2E-16180339-8874-4989-8848-204586834365";
    const rescue = `Folders/${token}-cleanup-rescue`;
    const root = mkdtempSync(join(tmpdir(), "mailpouch-standalone-rescue-rearm-"));
    roots.push(root);
    const { configPath, manifestPath } = writeHarness(
      root,
      token,
      [{ path: rescue, uidValidity: "100" }],
      { cleanup: { allMailRescue: "payload-observed" } },
    );
    prepareImap(token);
    imap.messages.INBOX = [];
    imap.messages["All Mail"] = [{
      uid: 41,
      messageId: "operator-rearm@example.test",
      subject: `${token} operator rearm`,
    }];
    imap.extraMailboxes = [{ path: rescue, uidValidity: 100n }];
    imap.messages[rescue] = [];
    imap.ambiguousCopyResults = 1;
    const nonce = "ab".repeat(32);
    let manifestAtCopy: ManifestOverrides["cleanup"] | undefined;
    imap.beforeMutation = () => {
      const lastLock = imap.lockEvents.at(-1);
      if (lastLock?.path === "All Mail" && existsSync(manifestPath)) {
        manifestAtCopy = JSON.parse(readFileSync(manifestPath, "utf8")).cleanup;
      }
    };
    process.env.MAILPOUCH_E2E_BRIDGE_CONFIG = configPath;
    process.env.MAILPOUCH_E2E_RUN_TOKEN = token;
    process.env.MAILPOUCH_E2E_REARM_RESCUE_COPY = token;
    process.env.MAILPOUCH_E2E_REARM_RESCUE_COPY_NONCE = nonce;
    vi.spyOn(process, "cwd").mockReturnValue(root);
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`unexpected process.exit(${code})`);
    }) as never);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const completed = import("./e2e/support/cleanup-bridge.mjs");
    await vi.advanceTimersByTimeAsync(20_001);
    await completed;

    expect(exit).not.toHaveBeenCalled();
    expect(imap.mutations.filter((mutation) => mutation.kind === "copy")).toHaveLength(1);
    const copyClientId = imap.mutationClientIds[0]!;
    const preCopyRescueClients = new Set(imap.lockEvents
      .filter((event) => event.path === rescue && event.clientId < copyClientId)
      .map((event) => event.clientId));
    expect(preCopyRescueClients.size).toBeGreaterThanOrEqual(2);
    expect(manifestAtCopy).toEqual({
      allMailRescue: "payload-observed",
      rescueRearmConsumedHashes: [rescueRearmHash(token, nonce)],
    });
    expect(imap.mutations.map(({ kind, path }) => ({ kind, path }))).toEqual([
      { kind: "copy", path: "All Mail" },
      { kind: "move", path: rescue },
      { kind: "delete", path: "Trash" },
    ]);
    expect(imap.folderDeletes).toEqual([]);
    expect(existsSync(manifestPath)).toBe(false);
  }, 10_000);

  it.each([
    {
      name: "nonmatching token",
      cleanup: { allMailRescue: "payload-observed" as const },
      rearm: "mpE2E-27182818-2845-4904-8523-536028747135",
    },
    {
      name: "missing durable phase",
      cleanup: undefined,
      rearm: "self",
    },
  ])("rejects rescue COPY rearm with $name before connecting", async ({ cleanup, rearm }) => {
    const token = "mpE2E-14142135-6237-4095-8488-016887242097";
    const rescue = `Folders/${token}-cleanup-rescue`;
    const root = mkdtempSync(join(tmpdir(), "mailpouch-standalone-rescue-rearm-refusal-"));
    roots.push(root);
    const { configPath, manifestPath } = writeHarness(
      root,
      token,
      [{ path: rescue, uidValidity: "100" }],
      { cleanup },
    );
    prepareImap(token);
    imap.messages.INBOX = [];
    imap.messages["All Mail"] = [{
      uid: 51,
      messageId: "rearm-refusal@example.test",
      subject: `${token} rearm refusal`,
    }];
    imap.extraMailboxes = [{ path: rescue, uidValidity: 100n }];
    imap.messages[rescue] = [];
    process.env.MAILPOUCH_E2E_BRIDGE_CONFIG = configPath;
    process.env.MAILPOUCH_E2E_RUN_TOKEN = token;
    process.env.MAILPOUCH_E2E_REARM_RESCUE_COPY = rearm === "self" ? token : rearm;
    process.env.MAILPOUCH_E2E_REARM_RESCUE_COPY_NONCE = "cd".repeat(32);
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    const errorOutput = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(import("./e2e/support/cleanup-bridge.mjs"))
      .rejects.toThrow(/process\.exit\(1\)/);

    expect(errorOutput).toHaveBeenCalledWith(expect.stringMatching(/rearm/i));
    expect(imap.connectCalls).toBe(0);
    expect(imap.mutations).toEqual([]);
    expect(existsSync(manifestPath)).toBe(true);
  });

  it("rejects replay of an already-consumed rescue COPY rearm before connecting", async () => {
    const token = "mpE2E-27182818-2845-4904-8523-536028747135";
    const nonce = "ef".repeat(32);
    const rescue = `Folders/${token}-cleanup-rescue`;
    const root = mkdtempSync(join(tmpdir(), "mailpouch-standalone-rescue-rearm-replay-"));
    roots.push(root);
    const { configPath, manifestPath } = writeHarness(
      root,
      token,
      [{ path: rescue, uidValidity: "100" }],
      {
        cleanup: {
          allMailRescue: "payload-observed",
          rescueRearmConsumedHashes: [rescueRearmHash(token, nonce)],
        },
      },
    );
    prepareImap(token);
    process.env.MAILPOUCH_E2E_BRIDGE_CONFIG = configPath;
    process.env.MAILPOUCH_E2E_RUN_TOKEN = token;
    process.env.MAILPOUCH_E2E_REARM_RESCUE_COPY = token;
    process.env.MAILPOUCH_E2E_REARM_RESCUE_COPY_NONCE = nonce;
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    const errorOutput = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(import("./e2e/support/cleanup-bridge.mjs"))
      .rejects.toThrow(/process\.exit\(1\)/);

    expect(errorOutput).toHaveBeenCalledWith(expect.stringMatching(/already consumed/i));
    expect(imap.connectCalls).toBe(0);
    expect(imap.mutations).toEqual([]);
    expect(existsSync(manifestPath)).toBe(true);
  });

  it("reconciles a retained rescue source only after its exact Trash checkpoint", async () => {
    vi.useFakeTimers();
    const token = "mpE2E-26457513-1106-4590-8737-183244237119";
    const rescue = `Folders/${token}-cleanup-rescue`;
    const root = mkdtempSync(join(tmpdir(), "mailpouch-standalone-rescue-retained-source-"));
    roots.push(root);
    const { configPath, manifestPath } = writeHarness(root, token);
    prepareImap(token);
    imap.messages.INBOX = [];
    imap.messages["All Mail"] = [{
      uid: 51,
      messageId: "retained-rescue-source@example.test",
      subject: `${token} retained rescue source`,
    }];
    imap.retainRescueSourceAssociation = true;
    process.env.MAILPOUCH_E2E_BRIDGE_CONFIG = configPath;
    process.env.MAILPOUCH_E2E_RUN_TOKEN = token;
    vi.spyOn(process, "cwd").mockReturnValue(root);
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`unexpected process.exit(${code})`);
    }) as never);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const completed = import("./e2e/support/cleanup-bridge.mjs");
    await vi.advanceTimersByTimeAsync(60_001);
    await completed;

    expect(exit).not.toHaveBeenCalled();
    const rescueMove = imap.mutations.findIndex((mutation) => (
      mutation.kind === "move" && mutation.path === rescue
    ));
    const trashDelete = imap.mutations.findIndex((mutation, index) => (
      index > rescueMove && mutation.kind === "delete" && mutation.path === "Trash"
    ));
    const rescueDelete = imap.mutations.findIndex((mutation, index) => (
      index > trashDelete && mutation.kind === "delete" && mutation.path === rescue
    ));
    expect(rescueMove).toBeGreaterThanOrEqual(0);
    expect(trashDelete).toBeGreaterThan(rescueMove);
    expect(rescueDelete).toBeGreaterThan(trashDelete);
    expect(imap.mutations.filter((mutation) => mutation.kind === "copy")).toHaveLength(1);
    expect(existsSync(manifestPath)).toBe(false);
  }, 10_000);

  it("does not reconstruct next-COPY permission after a payload-observed restart", async () => {
    vi.useFakeTimers();
    const token = "mpE2E-27182818-2845-4904-8523-536028747135";
    const rescue = `Folders/${token}-cleanup-rescue`;
    const root = mkdtempSync(join(tmpdir(), "mailpouch-standalone-rescue-restart-"));
    roots.push(root);
    const { configPath, manifestPath } = writeHarness(root, token, [{
      path: rescue,
      uidValidity: "100",
    }], {
      cleanup: { allMailRescue: "payload-observed" },
    });
    prepareImap(token);
    imap.messages.INBOX = [];
    imap.messages["All Mail"] = [{
      uid: 41,
      messageId: "restart-owned@example.test",
      subject: `${token} restart residue`,
    }];
    imap.extraMailboxes = [{ path: rescue, uidValidity: 100n }];
    imap.messages[rescue] = [];
    process.env.MAILPOUCH_E2E_BRIDGE_CONFIG = configPath;
    process.env.MAILPOUCH_E2E_RUN_TOKEN = token;
    vi.spyOn(process, "cwd").mockReturnValue(root);
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const assertion = expect(import("./e2e/support/cleanup-bridge.mjs"))
      .rejects.toThrow(/process\.exit\(1\)/);
    await vi.advanceTimersByTimeAsync(182_001);
    await assertion;

    expect(imap.mailboxCreates).toEqual([]);
    expect(imap.mutations.filter((mutation) => mutation.kind === "copy")).toEqual([]);
    expect(imap.mutations.every((mutation) => mutation.path !== "All Mail")).toBe(true);
    expect(existsSync(manifestPath)).toBe(true);
  }, 10_000);

  it("retains recovery authority while a copy-pending rescue has no terminal observation", async () => {
    vi.useFakeTimers();
    const token = "mpE2E-17320508-0756-4887-8293-527446341505";
    const root = mkdtempSync(join(tmpdir(), "mailpouch-standalone-rescue-pending-empty-"));
    roots.push(root);
    const { configPath, manifestPath } = writeHarness(root, token, [], {
      cleanup: { allMailRescue: "copy-pending" },
    });
    prepareImap(token);
    imap.messages.INBOX = [];
    imap.messages["All Mail"] = [];
    process.env.MAILPOUCH_E2E_BRIDGE_CONFIG = configPath;
    process.env.MAILPOUCH_E2E_RUN_TOKEN = token;
    vi.spyOn(process, "cwd").mockReturnValue(root);
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const assertion = expect(import("./e2e/support/cleanup-bridge.mjs"))
      .rejects.toThrow(/process\.exit\(1\)/);
    await vi.advanceTimersByTimeAsync(182_001);
    await assertion;

    expect(imap.mailboxCreates).toEqual([]);
    expect(imap.mutations).toEqual([]);
    expect(existsSync(configPath)).toBe(true);
    expect(existsSync(manifestPath)).toBe(true);
  }, 10_000);

  it("waits for the exact rescue Trash checkpoint instead of accepting an unrelated owned purge", async () => {
    vi.useFakeTimers();
    const token = "mpE2E-14142135-6237-4095-8048-801688724209";
    const rescue = `Folders/${token}-cleanup-rescue`;
    const root = mkdtempSync(join(tmpdir(), "mailpouch-standalone-rescue-trash-proof-"));
    roots.push(root);
    const { configPath, manifestPath } = writeHarness(root, token);
    prepareImap(token);
    imap.messages.INBOX = [];
    imap.messages["All Mail"] = [{
      uid: 7,
      messageId: "checkpoint-owned@example.test",
      subject: `${token} checkpoint residue`,
    }];
    let injectedUnrelatedTrash = false;
    imap.onConnect = () => {
      const rescueMoveObserved = imap.mutations.some((mutation) => (
        mutation.kind === "move" && mutation.path === rescue
      ));
      if (rescueMoveObserved && !injectedUnrelatedTrash) {
        injectedUnrelatedTrash = true;
        imap.messages.Trash = [{
          uid: 1,
          messageId: "unrelated-owned-trash@example.test",
          subject: `${token} unrelated Trash residue`,
        }, ...(imap.messages.Trash ?? [])];
      }
    };
    process.env.MAILPOUCH_E2E_BRIDGE_CONFIG = configPath;
    process.env.MAILPOUCH_E2E_RUN_TOKEN = token;
    vi.spyOn(process, "cwd").mockReturnValue(root);
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`unexpected process.exit(${code})`);
    }) as never);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const completed = import("./e2e/support/cleanup-bridge.mjs");
    await vi.advanceTimersByTimeAsync(60_001);
    await completed;

    expect(exit).not.toHaveBeenCalled();
    expect(imap.deleteOperands.filter((operand) => operand.path === "Trash").slice(0, 2)).toEqual([
      { path: "Trash", uids: [1] },
      { path: "Trash", uids: [8] },
    ]);
    const firstTrashDelete = imap.mutations.findIndex((mutation) => mutation.kind === "delete");
    const rescueSourceDelete = imap.mutations.findIndex((mutation, index) => (
      index > firstTrashDelete && mutation.kind === "delete" && mutation.path === rescue
    ));
    expect(rescueSourceDelete).toBe(-1);
    expect(imap.mutations.filter((mutation) => mutation.kind === "copy")).toHaveLength(1);
    expect(existsSync(manifestPath)).toBe(false);
  }, 10_000);

  it("fails closed without mutation when the rescue mailbox contains foreign mail", async () => {
    const token = "mpE2E-16180339-8874-4989-8482-045868343656";
    const rescue = `Folders/${token}-cleanup-rescue`;
    const root = mkdtempSync(join(tmpdir(), "mailpouch-standalone-rescue-foreign-"));
    roots.push(root);
    const { configPath, manifestPath } = writeHarness(root, token, [{
      path: rescue,
      uidValidity: "100",
    }], {
      cleanup: { allMailRescue: "copy-pending" },
    });
    prepareImap(token);
    imap.messages.INBOX = [];
    imap.extraMailboxes = [{ path: rescue, uidValidity: 100n }];
    imap.messages[rescue] = [
      { uid: 1, messageId: "rescue-owned@example.test", subject: `${token} rescue owned` },
      { uid: 2, messageId: "foreign@example.test", subject: "foreign", runHeader: null },
    ];
    process.env.MAILPOUCH_E2E_BRIDGE_CONFIG = configPath;
    process.env.MAILPOUCH_E2E_RUN_TOKEN = token;
    vi.spyOn(process, "cwd").mockReturnValue(root);
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    const errorOutput = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(import("./e2e/support/cleanup-bridge.mjs"))
      .rejects.toThrow(/process\.exit\(1\)/);

    expect(errorOutput).toHaveBeenCalledWith(expect.stringMatching(/non-owned mail/i));
    expect(imap.mutations).toEqual([]);
    expect(imap.folderDeletes).toEqual([]);
    expect(existsSync(manifestPath)).toBe(true);
  });

  it("skips mutation-round audits and performs two fresh authoritative audits before success", async () => {
    vi.useFakeTimers();
    const token = "mpE2E-22345678-1234-4abc-8def-1234567890ab";
    const root = mkdtempSync(join(tmpdir(), "mailpouch-standalone-audit-rounds-"));
    roots.push(root);
    const { configPath, manifestPath } = writeHarness(root, token);
    prepareImap(token);
    imap.extraMailboxes = [
      { path: "A very long ordinary mailbox", uidValidity: 2n },
      { path: "Important", uidValidity: 3n },
    ];
    imap.messages["A very long ordinary mailbox"] = [];
    imap.messages.Important = [];
    process.env.MAILPOUCH_E2E_BRIDGE_CONFIG = configPath;
    process.env.MAILPOUCH_E2E_RUN_TOKEN = token;
    vi.spyOn(process, "cwd").mockReturnValue(root);
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`unexpected process.exit(${code})`);
    }) as never);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const completed = import("./e2e/support/cleanup-bridge.mjs");
    await vi.advanceTimersByTimeAsync(4_001);
    await completed;

    expect(exit).not.toHaveBeenCalled();
    const listCounts = new Map<number, number>();
    for (const clientId of imap.listClientIds) {
      listCounts.set(clientId, (listCounts.get(clientId) ?? 0) + 1);
    }
    const mutationClients = new Set(imap.mutationClientIds);
    expect([...mutationClients].map((clientId) => listCounts.get(clientId))).toEqual([1, 1]);
    expect([...listCounts.values()].filter((count) => count === 3)).toHaveLength(2);

    const firstMutationClient = imap.mutationClientIds[0]!;
    expect(imap.lockEvents
      .filter(({ clientId }) => clientId === firstMutationClient)
      .map(({ path }) => path)).toEqual(["Trash", "INBOX"]);
    const trashMutationClient = imap.mutationClientIds[1]!;
    expect(imap.lockEvents
      .filter(({ clientId }) => clientId === trashMutationClient)
      .map(({ path }) => path)).toEqual(["Trash"]);
    expect(imap.lockEvents.some(({ clientId, path }) => (
      clientId > trashMutationClient && path === "INBOX"
    ))).toBe(true);
    expect(existsSync(manifestPath)).toBe(false);
  }, 10_000);

  it("durably promotes a headerless pending artifact before mutation and completes after its grace", async () => {
    vi.useFakeTimers();
    const token = "mpE2E-11111111-2222-4333-8444-555555555555";
    const subject = `${token} pending send`;
    const pending = {
      id: "pending-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      kind: "pending-sent" as const,
      subject,
    };
    const rescue = `Folders/${token}-cleanup-rescue`;
    const root = mkdtempSync(join(tmpdir(), "mailpouch-standalone-promotion-"));
    roots.push(root);
    const { configPath, manifestPath } = writeHarness(root, token, [{
      path: rescue,
      uidValidity: "100",
    }], {
      pending: [pending],
      cleanup: { allMailRescue: "payload-observed" },
    });
    prepareImap(token);
    imap.messages.INBOX = [];
    imap.extraMailboxes = [{ path: rescue, uidValidity: 100n }];
    imap.messages[rescue] = [];
    const startedAt = Date.now();
    let phaseBeforeDelayedDelivery: string | undefined;
    let delayedDeliveryInjected = false;
    imap.onConnect = () => {
      if (!delayedDeliveryInjected && Date.now() - startedAt >= 10_000) {
        delayedDeliveryInjected = true;
        phaseBeforeDelayedDelivery = JSON.parse(readFileSync(manifestPath, "utf8")).cleanup?.allMailRescue;
        imap.messages.INBOX = [{
          uid: 7,
          messageId: "pending-owned@example.test",
          subject,
          runHeader: null,
        }];
      }
    };
    let manifestAtFirstMutation: {
      pending: unknown[];
      proofs: unknown[];
    } | undefined;
    imap.beforeMutation = () => {
      if (manifestAtFirstMutation) return;
      manifestAtFirstMutation = JSON.parse(readFileSync(manifestPath, "utf8"));
    };
    process.env.MAILPOUCH_E2E_BRIDGE_CONFIG = configPath;
    process.env.MAILPOUCH_E2E_RUN_TOKEN = token;
    vi.spyOn(process, "cwd").mockReturnValue(root);
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`unexpected process.exit(${code})`);
    }) as never);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const completed = import("./e2e/support/cleanup-bridge.mjs");
    await vi.advanceTimersByTimeAsync(182_001);
    await completed;

    expect(exit).not.toHaveBeenCalled();
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(180_000);
    expect(phaseBeforeDelayedDelivery).toBe("payload-observed");
    expect(manifestAtFirstMutation).toEqual(expect.objectContaining({
      pending: [],
      proofs: [{
        kind: "message-id",
        messageId: "pending-owned@example.test",
        subject,
      }],
    }));
    expect(imap.mutations[0]).toEqual({
      kind: "move",
      path: "INBOX",
      proofUnderSameLock: true,
    });
    expect(existsSync(manifestPath)).toBe(false);
  }, 10_000);

  it("does not consume pending authority from an exact-header seed and retains recovery state", async () => {
    vi.useFakeTimers();
    const token = "mpE2E-66666666-7777-4888-9999-aaaaaaaaaaaa";
    const subject = `${token} exact-header seed`;
    const pending = {
      id: "pending-bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
      kind: "pending-sent" as const,
      subject,
    };
    const root = mkdtempSync(join(tmpdir(), "mailpouch-standalone-pending-retained-"));
    roots.push(root);
    const { configPath, manifestPath } = writeHarness(root, token, [], {
      pending: [pending],
    });
    prepareImap(token);
    imap.messages.INBOX = [{
      uid: 7,
      messageId: "header-seed@example.test",
      subject,
      // The exact run header independently authorizes cleanup, but must not be
      // mistaken for the response-lost send represented by the pending proof.
      runHeader: token,
    }];
    process.env.MAILPOUCH_E2E_BRIDGE_CONFIG = configPath;
    process.env.MAILPOUCH_E2E_RUN_TOKEN = token;
    vi.spyOn(process, "cwd").mockReturnValue(root);
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const assertion = expect(import("./e2e/support/cleanup-bridge.mjs"))
      .rejects.toThrow(/process\.exit\(1\)/);
    await vi.advanceTimersByTimeAsync(182_001);
    await assertion;

    const retained = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(retained.pending).toEqual([pending]);
    expect(retained.proofs).toEqual([]);
    expect(imap.mutations.map(({ kind }) => kind)).toEqual(["move", "delete"]);
    expect(existsSync(manifestPath)).toBe(true);
  }, 10_000);

  it("re-discovers an ambiguous applied mutation only after opening a fresh session", async () => {
    vi.useFakeTimers();
    const token = "mpE2E-13572468-2468-4ace-8bdf-135724681357";
    const root = mkdtempSync(join(tmpdir(), "mailpouch-standalone-ambiguous-"));
    roots.push(root);
    const { configPath, manifestPath } = writeHarness(root, token);
    prepareImap(token);
    // Model Bridge applying MOVE but returning no explicit result. The first
    // session is poisoned; the next session must independently discover the
    // message in Trash and finish exact cleanup.
    imap.ambiguousMoveResults = 1;
    process.env.MAILPOUCH_E2E_BRIDGE_CONFIG = configPath;
    process.env.MAILPOUCH_E2E_RUN_TOKEN = token;
    vi.spyOn(process, "cwd").mockReturnValue(root);
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`unexpected process.exit(${code})`);
    }) as never);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const completed = import("./e2e/support/cleanup-bridge.mjs");
    await vi.advanceTimersByTimeAsync(4_001);
    await completed;

    expect(exit).not.toHaveBeenCalled();
    expect(imap.connectCalls).toBeGreaterThanOrEqual(2);
    expect(imap.closeCalls).toBeGreaterThan(0);
    expect(imap.mutations.map(({ kind }) => kind)).toEqual(["move", "delete"]);
    expect(existsSync(manifestPath)).toBe(false);
  }, 10_000);

  it("closes and retains recovery authority after bounded fresh-session retries", async () => {
    vi.useFakeTimers();
    const token = "mpE2E-87654321-4321-4cba-9fed-ba0987654321";
    const root = mkdtempSync(join(tmpdir(), "mailpouch-standalone-rejection-"));
    roots.push(root);
    const { configPath, manifestPath } = writeHarness(root, token);
    prepareImap(token);
    imap.rejectMove = true;
    process.env.MAILPOUCH_E2E_BRIDGE_CONFIG = configPath;
    process.env.MAILPOUCH_E2E_RUN_TOKEN = token;
    vi.spyOn(process, "cwd").mockReturnValue(root);
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    const errorOutput = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const assertion = expect(import("./e2e/support/cleanup-bridge.mjs"))
      .rejects.toThrow(/process\.exit\(1\)/);
    await vi.advanceTimersByTimeAsync(9_001);
    await assertion;

    expect(errorOutput).toHaveBeenCalledWith(expect.stringMatching(
      /did not return an explicit success result.*recovery state retained/i,
    ));
    expect(imap.closeCalls).toBeGreaterThan(0);
    expect(existsSync(manifestPath)).toBe(true);
  });

  it("never deletes a recreated run path whose UIDVALIDITY differs from its creation proof", async () => {
    vi.useFakeTimers();
    const token = "mpE2E-fedcba98-7654-4321-8abc-def012345678";
    const scratch = `Folders/${token}-recreated`;
    const root = mkdtempSync(join(tmpdir(), "mailpouch-standalone-recreated-"));
    roots.push(root);
    const { configPath, manifestPath } = writeHarness(root, token, [{
      path: scratch,
      uidValidity: "2",
    }]);
    prepareImap(token);
    imap.messages.INBOX = [];
    imap.messages[scratch] = [];
    // The original run-created mailbox had UIDVALIDITY 2. This is a different,
    // later mailbox that reused only the path spelling.
    imap.extraMailboxes = [{ path: scratch, uidValidity: 3n }];
    process.env.MAILPOUCH_E2E_BRIDGE_CONFIG = configPath;
    process.env.MAILPOUCH_E2E_RUN_TOKEN = token;
    vi.spyOn(process, "cwd").mockReturnValue(root);
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const assertion = expect(import("./e2e/support/cleanup-bridge.mjs"))
      .rejects.toThrow(/process\.exit\(1\)/);
    await vi.advanceTimersByTimeAsync(180_001);
    await assertion;

    expect(imap.folderDeletes).toEqual([]);
    expect(existsSync(manifestPath)).toBe(true);
  }, 10_000);

  it("retains a repeatedly-proven empty created folder without dispatching mailbox DELETE", async () => {
    vi.useFakeTimers();
    const token = "mpE2E-abcdef01-2345-4678-9abc-def012345678";
    const scratch = `Folders/${token}-created`;
    const root = mkdtempSync(join(tmpdir(), "mailpouch-standalone-created-"));
    roots.push(root);
    const { configPath, manifestPath } = writeHarness(root, token, [{
      path: scratch,
      uidValidity: "2",
    }]);
    prepareImap(token);
    imap.messages.INBOX = [];
    imap.messages[scratch] = [];
    imap.extraMailboxes = [{ path: scratch, uidValidity: 2n }];
    process.env.MAILPOUCH_E2E_BRIDGE_CONFIG = configPath;
    process.env.MAILPOUCH_E2E_RUN_TOKEN = token;
    vi.spyOn(process, "cwd").mockReturnValue(root);
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`unexpected process.exit(${code})`);
    }) as never);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const completed = import("./e2e/support/cleanup-bridge.mjs");
    await vi.advanceTimersByTimeAsync(2_001);
    await completed;

    expect(exit).not.toHaveBeenCalled();
    expect(imap.folderDeletes).toEqual([]);
    expect(imap.extraMailboxes).toEqual([{ path: scratch, uidValidity: 2n }]);
    expect(warning).toHaveBeenCalledWith(expect.stringMatching(
      new RegExp(`retained.*manual deletion.*${token}`, "i"),
    ));
    expect(existsSync(manifestPath)).toBe(false);
  });
});
