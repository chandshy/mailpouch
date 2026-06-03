import { describe, it, expect, afterEach } from "vitest";
import { ServiceAccountStore } from "./service-account-store.js";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import { rmSync, existsSync, readFileSync, statSync } from "fs";

const paths: string[] = [];
function newPath(): string {
  const p = join(tmpdir(), `mp-sa-store-${randomBytes(6).toString("hex")}.json`);
  paths.push(p);
  return p;
}

afterEach(() => {
  while (paths.length) {
    const p = paths.pop();
    if (p) { try { rmSync(p, { force: true }); } catch { /* ignore */ } }
  }
});

describe("ServiceAccountStore", () => {
  it("issues an account with a pmc_ id and a one-time secret", () => {
    const store = new ServiceAccountStore(newPath());
    const { account, clientSecret } = store.issue({ name: "cron", preset: "read_only" });
    expect(account.clientId).toMatch(/^pmc_[a-f0-9]{32}$/);
    expect(clientSecret.length).toBeGreaterThanOrEqual(32);
    expect(account.clientName).toBe("cron");
    expect(account.preset).toBe("read_only");
  });

  it("never persists the plaintext secret — only a salted hash", () => {
    const path = newPath();
    const store = new ServiceAccountStore(path);
    const { account, clientSecret } = store.issue({ name: "x", preset: "full" });
    const onDisk = readFileSync(path, "utf-8");
    expect(onDisk).not.toContain(clientSecret);
    expect(onDisk).toContain(account.clientId);
    // The stored record carries a hash + salt, not the secret.
    const stored = store.get(account.clientId)!;
    expect(stored.secretHash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.secretSalt).toMatch(/^[a-f0-9]{32}$/);
    expect((stored as unknown as Record<string, unknown>).clientSecret).toBeUndefined();
  });

  it("verifies the correct secret and rejects a wrong one (and unknown id)", () => {
    const store = new ServiceAccountStore(newPath());
    const { account, clientSecret } = store.issue({ name: "v", preset: "full" });
    expect(store.verify(account.clientId, clientSecret)).not.toBeNull();
    expect(store.verify(account.clientId, clientSecret + "x")).toBeNull();
    expect(store.verify("pmc_unknown", clientSecret)).toBeNull();
  });

  it("verify() reflects accounts issued/revoked by another process (reload from disk)", () => {
    // `a` simulates the `mailpouch agent` CLI; `b` simulates the long-lived
    // daemon that loaded the store at startup (when it was empty).
    const path = newPath();
    const b = new ServiceAccountStore(path);
    expect(b.list()).toHaveLength(0);
    const a = new ServiceAccountStore(path);
    const { account, clientSecret } = a.issue({ name: "live", preset: "full" });
    // b never saw the issue in-memory, but verify() reloads from disk → live.
    expect(b.verify(account.clientId, clientSecret)).not.toBeNull();
    // Revoke via a; b.verify() must now deny (reload sees the deletion) — no restart.
    a.revoke(account.clientId);
    expect(b.verify(account.clientId, clientSecret)).toBeNull();
  });

  it("persists across instances (a cron agent survives a restart)", () => {
    const path = newPath();
    const a = new ServiceAccountStore(path);
    const { account, clientSecret } = a.issue({ name: "persist", preset: "supervised" });
    // Fresh instance over the same file — verify still works.
    const b = new ServiceAccountStore(path);
    expect(b.verify(account.clientId, clientSecret)).not.toBeNull();
    expect(b.list()).toHaveLength(1);
  });

  it("stores conditions and revokes accounts", () => {
    const path = newPath();
    const store = new ServiceAccountStore(path);
    const { account } = store.issue({
      name: "conds",
      preset: "read_only",
      conditions: { folderAllowlist: ["INBOX"], expiresAt: "2030-01-01T00:00:00.000Z" },
    });
    expect(store.get(account.clientId)?.conditions?.folderAllowlist).toEqual(["INBOX"]);
    expect(store.revoke(account.clientId)).toBe(true);
    expect(store.get(account.clientId)).toBeUndefined();
    expect(store.revoke(account.clientId)).toBe(false);
    // A fresh instance also sees the deletion.
    expect(new ServiceAccountStore(path).list()).toHaveLength(0);
  });

  // Windows has no POSIX mode bits (fs reports 0o666 regardless), so this
  // owner-only assertion only applies off-Windows — matching config-lock.test.
  it.runIf(process.platform !== "win32")("writes the store file at mode 0600", () => {
    const path = newPath();
    const store = new ServiceAccountStore(path);
    store.issue({ name: "perm", preset: "full" });
    expect(existsSync(path)).toBe(true);
    // (st_mode & 0o777) should be 0o600.
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
