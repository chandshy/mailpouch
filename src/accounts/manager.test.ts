/**
 * Tests for AccountManager. We mock the registry + services so the tests
 * stay focused on the manager's responsibilities (map lifecycle, active
 * switch events, closeAll), without reaching for real IMAP/SMTP.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AccountSpec, AccountRegistry } from "./types.js";

// Mock the registry so we can hand-craft the account list per-test.
const mockRegistry: { value: AccountRegistry } = {
  value: { accounts: [], activeAccountId: "" },
};
const readRegistryWithSecretsMock = vi.fn(async (): Promise<AccountRegistry> => mockRegistry.value);
const mailboxKeychainCredentialsAreQuarantinedMock = vi.fn(() => false);
vi.mock("./registry.js", () => ({
  readRegistry: () => mockRegistry.value,
  readRegistryWithSecrets: () => readRegistryWithSecretsMock(),
  mailboxKeychainCredentialsAreQuarantined: () => mailboxKeychainCredentialsAreQuarantinedMock(),
}));

// Mock the services so they don't open real sockets. We use `class` stubs
// rather than vi.fn().mockImplementation because the manager uses `new`
// syntax — classes are constructable, mockImplementation-fns are not.
const smtpCloseMock = vi.fn().mockResolvedValue(undefined);
const smtpReinit = vi.fn();
const smtpWipeCredentials = vi.fn();
vi.mock("../services/smtp-service.js", () => {
  class SMTPService {
    config: unknown = null;
    close = smtpCloseMock;
    reinitialize = smtpReinit;
    wipeCredentials = smtpWipeCredentials;
  }
  return { SMTPService };
});

const imapDisconnect = vi.fn().mockResolvedValue(undefined);
const imapConnect = vi.fn().mockResolvedValue(undefined);
const imapStartIdle = vi.fn().mockResolvedValue(undefined);
const imapStopIdle = vi.fn();
const imapWipeCache = vi.fn();
vi.mock("../services/simple-imap-service.js", () => {
  class SimpleIMAPService {
    disconnect = imapDisconnect;
    connect = imapConnect;
    startIdle = imapStartIdle;
    stopIdle = imapStopIdle;
    wipeCache = imapWipeCache;
  }
  return { SimpleIMAPService };
});

// The notifications module emits events; stub it so tests don't spy on
// unrelated subscribers.
vi.mock("../agents/notifications.js", () => ({
  notifications: { emit: vi.fn(), on: vi.fn(), off: vi.fn() },
}));

import { AccountManager, registerAccountManager, getAccountManager } from "./manager.js";

function mkSpec(id: string, overrides: Partial<AccountSpec> = {}): AccountSpec {
  return {
    id, name: `acct ${id}`, providerType: "imap",
    smtpHost: "s", smtpPort: 587, imapHost: "i", imapPort: 993,
    username: `${id}@x`, password: "pw",
    ...overrides,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("AccountManager", () => {
  beforeEach(() => {
    mockRegistry.value = { accounts: [], activeAccountId: "" };
    readRegistryWithSecretsMock.mockReset();
    readRegistryWithSecretsMock.mockImplementation(async () => mockRegistry.value);
    mailboxKeychainCredentialsAreQuarantinedMock.mockReset();
    mailboxKeychainCredentialsAreQuarantinedMock.mockReturnValue(false);
    smtpCloseMock.mockReset();
    smtpCloseMock.mockResolvedValue(undefined);
    smtpReinit.mockReset();
    smtpWipeCredentials.mockReset();
    imapDisconnect.mockReset();
    imapDisconnect.mockResolvedValue(undefined);
    imapConnect.mockReset();
    imapConnect.mockResolvedValue(undefined);
    imapStartIdle.mockReset();
    imapStartIdle.mockResolvedValue(undefined);
    imapStopIdle.mockReset();
    imapWipeCache.mockReset();
  });

  it("builds one service pair per registered account", () => {
    mockRegistry.value = {
      accounts: [mkSpec("a"), mkSpec("b")],
      activeAccountId: "a",
    };
    const mgr = new AccountManager();
    expect(mgr.list()).toHaveLength(2);
    expect(mgr.activeAccountId()).toBe("a");
  });

  it("getActive returns the services for the registry's active id", () => {
    mockRegistry.value = {
      accounts: [mkSpec("a"), mkSpec("b")],
      activeAccountId: "b",
    };
    const mgr = new AccountManager();
    expect(mgr.getActive().spec.id).toBe("b");
  });

  it("falls back to the first account when the registry points at an unknown id", () => {
    mockRegistry.value = {
      accounts: [mkSpec("a"), mkSpec("b")],
      activeAccountId: "nonexistent",
    };
    const mgr = new AccountManager();
    expect(mgr.activeAccountId()).toBe("a");
  });

  it("setActive flips the pointer and emits active-changed", async () => {
    mockRegistry.value = {
      accounts: [mkSpec("a"), mkSpec("b")],
      activeAccountId: "a",
    };
    const mgr = new AccountManager();
    const changes: Array<{ prev: string; next: string }> = [];
    mgr.on("active-changed", ev => changes.push({ prev: ev.prev, next: ev.next }));
    await mgr.setActive("b");
    expect(mgr.activeAccountId()).toBe("b");
    expect(changes).toEqual([{ prev: "a", next: "b" }]);
  });

  it("rebuildFromRegistryAsync emits when persisted activation changes before setActive", async () => {
    mockRegistry.value = {
      accounts: [mkSpec("a"), mkSpec("b")],
      activeAccountId: "a",
    };
    const mgr = new AccountManager();
    const changes: Array<{ prev: string; next: string }> = [];
    mgr.on("active-changed", ev => changes.push({ prev: ev.prev, next: ev.next }));

    // This is the settings endpoint sequence: persistence selects b before
    // the manager rebuilds its registry view. The later setActive(b) is a
    // no-op, so rebuild itself must emit the one rebinding event.
    mockRegistry.value = {
      accounts: [mkSpec("a"), mkSpec("b")],
      activeAccountId: "b",
    };
    await mgr.rebuildFromRegistryAsync();
    await mgr.setActive("b");

    expect(mgr.activeAccountId()).toBe("b");
    expect(changes).toEqual([{ prev: "a", next: "b" }]);
  });

  it("setActive is a no-op when the target is already active (no event)", async () => {
    mockRegistry.value = {
      accounts: [mkSpec("a")],
      activeAccountId: "a",
    };
    const mgr = new AccountManager();
    const spy = vi.fn();
    mgr.on("active-changed", spy);
    await mgr.setActive("a");
    expect(spy).not.toHaveBeenCalled();
  });

  it("setActive rejects an unknown account id", async () => {
    mockRegistry.value = {
      accounts: [mkSpec("a")],
      activeAccountId: "a",
    };
    const mgr = new AccountManager();
    await expect(mgr.setActive("bogus")).rejects.toThrow(/Unknown account id/);
  });

  it("getForAccount returns per-account services; unknown ids throw", () => {
    mockRegistry.value = {
      accounts: [mkSpec("a"), mkSpec("b")],
      activeAccountId: "a",
    };
    const mgr = new AccountManager();
    expect(mgr.getForAccount("b").spec.id).toBe("b");
    expect(() => mgr.getForAccount("z")).toThrow(/Unknown account id/);
  });

  it("rebuildFromRegistry adds new accounts and tears down removed ones", async () => {
    mockRegistry.value = {
      accounts: [mkSpec("a"), mkSpec("b")],
      activeAccountId: "a",
    };
    const mgr = new AccountManager();
    const removed = mgr.getForAccount("b");
    expect(mgr.list()).toHaveLength(2);

    // "Remove" b from the registry, add c.
    mockRegistry.value = {
      accounts: [mkSpec("a"), mkSpec("c")],
      activeAccountId: "a",
    };
    mgr.rebuildFromRegistry();
    expect(mgr.list()).toHaveLength(2);
    expect(mgr.list().map(s => s.spec.id).sort()).toEqual(["a", "c"]);
    expect(smtpCloseMock).toHaveBeenCalled();
    expect(imapDisconnect).toHaveBeenCalled();
    expect(imapStopIdle).toHaveBeenCalled();
    expect(imapWipeCache).toHaveBeenCalled();
    expect(smtpWipeCredentials).toHaveBeenCalled();
    expect(removed.spec).toMatchObject({ username: "", password: "", smtpHost: "", imapHost: "" });
  });

  it("rebuildFromRegistry patches non-identity fields without service churn", () => {
    mockRegistry.value = {
      accounts: [mkSpec("a", { name: "Old display name" })],
      activeAccountId: "a",
    };
    const mgr = new AccountManager();
    const originalServices = mgr.getForAccount("a");

    // A display-name edit is not a mailbox identity change.
    mockRegistry.value = {
      accounts: [mkSpec("a", { name: "New display name" })],
      activeAccountId: "a",
    };
    mgr.rebuildFromRegistry();
    const afterServices = mgr.getForAccount("a");
    expect(afterServices).toBe(originalServices);        // same instance
    expect(afterServices.spec.name).toBe("New display name"); // updated spec
    expect(smtpReinit).not.toHaveBeenCalled();
  });

  it("replaces services and reports a same-ID mailbox identity change", () => {
    const originalInput = mkSpec("a", { username: "old@x", password: "old-secret", smtpToken: "old-token" });
    mockRegistry.value = {
      accounts: [originalInput],
      activeAccountId: "a",
    };
    const mgr = new AccountManager();
    const original = mgr.getForAccount("a");
    const replaced = vi.fn();
    const rebuilt = vi.fn();
    mgr.on("account-services-replaced", replaced);
    mgr.on("accounts-rebuilt", rebuilt);

    mockRegistry.value = {
      accounts: [mkSpec("a", { username: "new@x" })],
      activeAccountId: "a",
    };
    mgr.rebuildFromRegistry();

    expect(mgr.getForAccount("a")).not.toBe(original);
    expect(replaced).toHaveBeenCalledWith(expect.objectContaining({ accountId: "a" }));
    expect(rebuilt).toHaveBeenCalledWith(expect.objectContaining({ identityChangedAccountIds: ["a"] }));
    expect(smtpCloseMock).toHaveBeenCalledWith();
    expect(imapDisconnect).toHaveBeenCalledWith();
    expect(imapStopIdle).toHaveBeenCalledWith();
    expect(imapWipeCache).toHaveBeenCalledWith();
    expect(smtpWipeCredentials).toHaveBeenCalledWith();
    expect(original.spec).toMatchObject({ username: "", password: "", smtpToken: undefined, smtpHost: "", imapHost: "" });
    // The manager must wipe its own runtime clone, never mutate the registry
    // object that may still be owned by a settings/config caller.
    expect(originalInput).toMatchObject({ username: "old@x", password: "old-secret", smtpToken: "old-token" });
  });

  it("closeAll fully retires every account's services", async () => {
    mockRegistry.value = {
      accounts: [mkSpec("a"), mkSpec("b")],
      activeAccountId: "a",
    };
    const mgr = new AccountManager();
    const services = mgr.list();
    await mgr.closeAll();
    expect(smtpCloseMock).toHaveBeenCalledTimes(2);
    expect(imapDisconnect).toHaveBeenCalledTimes(2);
    expect(imapStopIdle).toHaveBeenCalledTimes(2);
    expect(imapWipeCache).toHaveBeenCalledTimes(2);
    expect(smtpWipeCredentials).toHaveBeenCalledTimes(2);
    expect(services.map(s => s.spec.password)).toEqual(["", ""]);
  });

  it("wipeAll synchronously scrubs live services for a last-resort exit", () => {
    mockRegistry.value = {
      accounts: [mkSpec("a"), mkSpec("b")],
      activeAccountId: "a",
    };
    const mgr = new AccountManager();
    const services = mgr.list();

    mgr.wipeAll();

    expect(imapStopIdle).toHaveBeenCalledTimes(2);
    expect(imapWipeCache).toHaveBeenCalledTimes(2);
    expect(smtpWipeCredentials).toHaveBeenCalledTimes(2);
    expect(services.map(s => s.spec.password)).toEqual(["", ""]);
  });

  it("closeAll still completes when an in-flight connect rejects", async () => {
    mockRegistry.value = {
      accounts: [mkSpec("a")],
      activeAccountId: "a",
    };
    const mgr = new AccountManager();
    const failingConnect = deferred<void>();
    imapConnect.mockImplementationOnce(() => failingConnect.promise);

    const connect = mgr.connectAccount("a");
    await vi.waitFor(() => expect(imapConnect).toHaveBeenCalledTimes(1));
    const shutdown = mgr.closeAll();
    failingConnect.reject(new Error("bridge down"));

    await expect(connect).rejects.toThrow("bridge down");
    await expect(shutdown).resolves.toBeUndefined();
    expect(imapWipeCache).toHaveBeenCalled();
    expect(smtpWipeCredentials).toHaveBeenCalled();
  });

  it("connectAll opens IMAP for every account and reports per-account results", async () => {
    mockRegistry.value = {
      accounts: [mkSpec("a"), mkSpec("b")],
      activeAccountId: "a",
    };
    const mgr = new AccountManager();
    const results = await mgr.connectAll();
    expect(imapConnect).toHaveBeenCalledTimes(2);
    expect(results).toEqual([
      { id: "a", ok: true },
      { id: "b", ok: true },
    ]);
  });

  it("connectAll reports per-account failures without stopping the loop", async () => {
    mockRegistry.value = {
      accounts: [mkSpec("a"), mkSpec("b")],
      activeAccountId: "a",
    };
    const mgr = new AccountManager();
    imapConnect
      .mockRejectedValueOnce(new Error("bridge down"))
      .mockResolvedValueOnce(undefined);
    const results = await mgr.connectAll();
    expect(results[0]).toEqual({ id: "a", ok: false, error: "bridge down" });
    expect(results[1]).toEqual({ id: "b", ok: true });
  });

  it("async registry rebuild applies credentials only to their matching account", async () => {
    mockRegistry.value = {
      accounts: [mkSpec("a", { password: "old-a" }), mkSpec("b", { password: "b-secret" })],
      activeAccountId: "a",
    };
    const mgr = new AccountManager();
    mockRegistry.value = {
      accounts: [mkSpec("a", { password: "new-a", smtpToken: "new-token" }), mkSpec("b", { password: "b-secret" })],
      activeAccountId: "a",
    };
    await mgr.rebuildFromRegistryAsync();

    expect(mgr.getForAccount("a").spec).toMatchObject({ password: "new-a", smtpToken: "new-token" });
    expect(mgr.getForAccount("b").spec.password).toBe("b-secret");
    expect(smtpReinit).toHaveBeenCalledTimes(1);
  });

  it("keeps keychain hydration suspended after an incomplete credential reset", async () => {
    mockRegistry.value = {
      accounts: [mkSpec("primary", { password: "old-live-password", smtpToken: "old-live-token" })],
      activeAccountId: "primary",
    };
    const mgr = new AccountManager();

    // Simulate an async keychain read that began just before reset and would
    // otherwise restore an undeleted primary credential after the default
    // registry has been applied.
    const staleKeychainRead = deferred<AccountRegistry>();
    readRegistryWithSecretsMock.mockImplementationOnce(() => staleKeychainRead.promise);
    const inFlightRebuild = mgr.rebuildFromRegistryAsync();
    await vi.waitFor(() => expect(readRegistryWithSecretsMock).toHaveBeenCalledTimes(1));

    // resetConfiguration() has persisted defaults, but OS-keychain cleanup
    // reported failure. The manager must use the unhydrated view immediately.
    mockRegistry.value = {
      accounts: [mkSpec("primary", { password: "", smtpToken: undefined })],
      activeAccountId: "primary",
    };
    mgr.rebuildFromRegistryWithoutKeychain();
    expect(mgr.getActive().spec).toMatchObject({ password: "", smtpToken: undefined });

    staleKeychainRead.resolve({
      accounts: [mkSpec("primary", { password: "stale-keychain-password", smtpToken: "stale-keychain-token" })],
      activeAccountId: "primary",
    });
    await inFlightRebuild;
    expect(mgr.getActive().spec).toMatchObject({ password: "", smtpToken: undefined });

    // The suspension is process-lifetime: a later settings-triggered async
    // rebuild must not even consult the keychain until the process restarts.
    await mgr.rebuildFromRegistryAsync();
    expect(readRegistryWithSecretsMock).toHaveBeenCalledTimes(1);
    expect(mgr.getActive().spec).toMatchObject({ password: "", smtpToken: undefined });
  });

  it("honors the persisted mailbox-keychain quarantine after a restart", async () => {
    // Unlike rebuildFromRegistryWithoutKeychain(), this models a newly started
    // manager: it has no process-local suspension yet, so only the durable
    // reset marker can stop stale keychain hydration.
    mockRegistry.value = {
      accounts: [mkSpec("primary", { password: "", smtpToken: undefined })],
      activeAccountId: "primary",
    };
    mailboxKeychainCredentialsAreQuarantinedMock.mockReturnValue(true);
    readRegistryWithSecretsMock.mockResolvedValue({
      accounts: [mkSpec("primary", { password: "stale-keychain-password", smtpToken: "stale-keychain-token" })],
      activeAccountId: "primary",
    });

    const mgr = new AccountManager();
    await mgr.rebuildFromRegistryAsync();

    expect(readRegistryWithSecretsMock).not.toHaveBeenCalled();
    expect(mgr.getActive().spec).toMatchObject({ password: "", smtpToken: undefined });
  });

  it("serializes async rebuilds and discards an older keychain snapshot", async () => {
    mockRegistry.value = {
      accounts: [mkSpec("a", { username: "initial@x" })],
      activeAccountId: "a",
    };
    const mgr = new AccountManager();
    const staleRead = deferred<AccountRegistry>();
    const latestRead = deferred<AccountRegistry>();
    readRegistryWithSecretsMock
      .mockImplementationOnce(() => staleRead.promise)
      .mockImplementationOnce(() => latestRead.promise);

    const staleRebuild = mgr.rebuildFromRegistryAsync();
    await vi.waitFor(() => expect(readRegistryWithSecretsMock).toHaveBeenCalledTimes(1));

    // The second settings save arrives while the first keychain read is still
    // pending. Its state must be the only one allowed to update the map.
    const latestRebuild = mgr.rebuildFromRegistryAsync();
    staleRead.resolve({
      accounts: [mkSpec("a", { username: "stale@x" })],
      activeAccountId: "a",
    });
    await vi.waitFor(() => expect(readRegistryWithSecretsMock).toHaveBeenCalledTimes(2));
    latestRead.resolve({
      accounts: [mkSpec("a", { username: "latest@x" }), mkSpec("b")],
      activeAccountId: "b",
    });

    await Promise.all([staleRebuild, latestRebuild]);
    expect(mgr.activeAccountId()).toBe("b");
    expect(mgr.list().map(s => s.spec.id).sort()).toEqual(["a", "b"]);
    expect(mgr.getForAccount("a").spec.username).toBe("latest@x");
  });

  it("serializes connects and prevents a retired service from starting IDLE", async () => {
    mockRegistry.value = {
      accounts: [mkSpec("a", { username: "old@x", password: "old-password" })],
      activeAccountId: "a",
    };
    const mgr = new AccountManager();
    const oldServices = mgr.getForAccount("a");
    const firstConnect = deferred<void>();
    imapConnect
      .mockImplementationOnce(() => firstConnect.promise)
      .mockResolvedValueOnce(undefined);

    const staleConnect = mgr.connectAccount("a");
    await vi.waitFor(() => expect(imapConnect).toHaveBeenCalledTimes(1));

    mockRegistry.value = {
      accounts: [mkSpec("a", { username: "new@x", password: "new-password" })],
      activeAccountId: "a",
    };
    mgr.rebuildFromRegistry();
    const currentConnect = mgr.connectAccount("a");
    // The current connection waits for the old one to be cleaned up first.
    expect(imapConnect).toHaveBeenCalledTimes(1);

    firstConnect.resolve(undefined);
    await Promise.all([staleConnect, currentConnect]);

    expect(imapConnect).toHaveBeenNthCalledWith(1, "i", 993, "old@x", "old-password", undefined, false, false);
    expect(imapConnect).toHaveBeenNthCalledWith(2, "i", 993, "new@x", "new-password", undefined, false, false);
    expect(imapStartIdle).toHaveBeenCalledTimes(1);
    expect(oldServices.spec.password).toBe("");
  });

  it("reconnects with new credentials when a same-service spec update races a connect", async () => {
    mockRegistry.value = {
      accounts: [mkSpec("a", { password: "old-password" })],
      activeAccountId: "a",
    };
    const mgr = new AccountManager();
    const services = mgr.getForAccount("a");
    const firstConnect = deferred<void>();
    imapConnect
      .mockImplementationOnce(() => firstConnect.promise)
      .mockResolvedValueOnce(undefined);

    const staleConnect = mgr.connectAccount("a");
    await vi.waitFor(() => expect(imapConnect).toHaveBeenCalledTimes(1));

    mockRegistry.value = {
      accounts: [mkSpec("a", { password: "new-password" })],
      activeAccountId: "a",
    };
    mgr.rebuildFromRegistry();
    const currentConnect = mgr.connectAccount("a");
    firstConnect.resolve(undefined);
    await Promise.all([staleConnect, currentConnect]);

    expect(mgr.getForAccount("a")).toBe(services);
    expect(imapConnect).toHaveBeenNthCalledWith(2, "i", 993, "a@x", "new-password", undefined, false, false);
    expect(imapStartIdle).toHaveBeenCalledTimes(1);
    expect(imapWipeCache).toHaveBeenCalled();
  });
});

describe("registerAccountManager / getAccountManager", () => {
  afterEach(() => { registerAccountManager(null as unknown as AccountManager); });

  it("round-trips the singleton", () => {
    mockRegistry.value = { accounts: [mkSpec("a")], activeAccountId: "a" };
    const mgr = new AccountManager();
    registerAccountManager(mgr);
    expect(getAccountManager()).toBe(mgr);
  });

  it("returns null when nothing is registered", () => {
    registerAccountManager(null as unknown as AccountManager);
    expect(getAccountManager()).toBeNull();
  });
});
