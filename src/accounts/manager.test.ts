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
vi.mock("./registry.js", () => ({
  readRegistry: () => mockRegistry.value,
}));

// Mock the services so they don't open real sockets. We use `class` stubs
// rather than vi.fn().mockImplementation because the manager uses `new`
// syntax — classes are constructable, mockImplementation-fns are not.
const smtpCloseMock = vi.fn().mockResolvedValue(undefined);
const smtpReinit = vi.fn();
vi.mock("../services/smtp-service.js", () => {
  class SMTPService {
    config: unknown = null;
    close = smtpCloseMock;
    reinitialize = smtpReinit;
  }
  return { SMTPService };
});

const imapDisconnect = vi.fn().mockResolvedValue(undefined);
const imapConnect = vi.fn().mockResolvedValue(undefined);
vi.mock("../services/simple-imap-service.js", () => {
  class SimpleIMAPService {
    disconnect = imapDisconnect;
    connect = imapConnect;
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

describe("AccountManager", () => {
  beforeEach(() => {
    mockRegistry.value = { accounts: [], activeAccountId: "" };
    smtpCloseMock.mockClear();
    imapDisconnect.mockClear();
    imapConnect.mockClear();
    smtpReinit.mockClear();
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
  });

  it("rebuildFromRegistry patches existing services when the spec changes (no churn)", () => {
    mockRegistry.value = {
      accounts: [mkSpec("a", { username: "old@x" })],
      activeAccountId: "a",
    };
    const mgr = new AccountManager();
    const originalServices = mgr.getForAccount("a");

    // Change the username; rebuild should NOT recreate the service instances.
    mockRegistry.value = {
      accounts: [mkSpec("a", { username: "new@x" })],
      activeAccountId: "a",
    };
    mgr.rebuildFromRegistry();
    const afterServices = mgr.getForAccount("a");
    expect(afterServices).toBe(originalServices);        // same instance
    expect(afterServices.spec.username).toBe("new@x");    // updated spec
    expect(smtpReinit).toHaveBeenCalled();
  });

  it("closeAll tears down every account's services", async () => {
    mockRegistry.value = {
      accounts: [mkSpec("a"), mkSpec("b")],
      activeAccountId: "a",
    };
    const mgr = new AccountManager();
    await mgr.closeAll();
    expect(smtpCloseMock).toHaveBeenCalledTimes(2);
    expect(imapDisconnect).toHaveBeenCalledTimes(2);
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

  it("applyKeychainCredentials fills empty passwords on every account and reinits SMTP", () => {
    mockRegistry.value = {
      accounts: [mkSpec("a", { password: "" }), mkSpec("b", { password: "" })],
      activeAccountId: "a",
    };
    const mgr = new AccountManager();
    smtpReinit.mockClear();

    mgr.applyKeychainCredentials("kc-password", "kc-token");

    const list = mgr.list();
    expect(list[0].spec.password).toBe("kc-password");
    expect(list[1].spec.password).toBe("kc-password");
    expect(list[0].spec.smtpToken).toBe("kc-token");
    expect(list[1].spec.smtpToken).toBe("kc-token");
    expect(smtpReinit).toHaveBeenCalledTimes(2);
  });

  it("applyKeychainCredentials replaces rotated passwords but never blanks a good one", () => {
    mockRegistry.value = {
      accounts: [mkSpec("a", { password: "old-pw" })],
      activeAccountId: "a",
    };
    const mgr = new AccountManager();
    smtpReinit.mockClear();

    // Rotation case: new password differs → replace
    mgr.applyKeychainCredentials("new-pw");
    expect(mgr.list()[0].spec.password).toBe("new-pw");
    expect(smtpReinit).toHaveBeenCalledTimes(1);

    // Empty-string case: must NOT nuke the live credential
    smtpReinit.mockClear();
    mgr.applyKeychainCredentials("");
    expect(mgr.list()[0].spec.password).toBe("new-pw");
    expect(smtpReinit).toHaveBeenCalledTimes(0);
  });

  it("applyKeychainCredentials is a no-op when both inputs are empty", () => {
    mockRegistry.value = {
      accounts: [mkSpec("a")],
      activeAccountId: "a",
    };
    const mgr = new AccountManager();
    smtpReinit.mockClear();
    mgr.applyKeychainCredentials("", undefined);
    expect(smtpReinit).toHaveBeenCalledTimes(0);
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
