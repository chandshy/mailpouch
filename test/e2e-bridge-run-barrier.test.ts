import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertNoRetainedBridgeRecoveryRuns,
  retainedBridgeRecoveryRuns,
  retainedBridgeSetupRuns,
  retainedBridgeUnjournaledClones,
} from "./e2e/support/bridge-run-barrier.js";
import { bridgeMailboxScopeKeyFromConfig } from "./e2e/support/bridge-authority-root.mjs";
import {
  createBridgeSetupJournal,
  retireBridgeSetupJournal,
} from "./e2e/support/bridge-setup-journal.mjs";
import { ownershipManifestPath } from "./e2e/support/ownership-manifest.js";

const TOKEN_A = "mpE2E-00000000-0000-4000-8000-000000000001";
const TOKEN_B = "mpE2E-00000000-0000-4000-8000-000000000002";
const TOKEN_C = "mpE2E-00000000-0000-4000-8000-000000000003";

const roots: string[] = [];

function tempRoots(): { manifestRoot: string; recoveryConfigRoot: string } {
  const root = mkdtempSync(join(tmpdir(), "mailpouch-bridge-barrier-"));
  roots.push(root);
  const manifestRoot = join(root, "manifests");
  const recoveryConfigRoot = join(root, "home");
  mkdirSync(manifestRoot);
  mkdirSync(recoveryConfigRoot);
  return { manifestRoot, recoveryConfigRoot };
}

function manifestPath(manifestRoot: string, token: string): string {
  return join(manifestRoot, `bridge-run-${token}.json`);
}

function configPath(recoveryConfigRoot: string, token: string): string {
  return join(recoveryConfigRoot, `.mailpouch-e2e-bridge-${token}.json`);
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Bridge retained-run preflight barrier", () => {
  it("allows a missing manifest directory", () => {
    const root = mkdtempSync(join(tmpdir(), "mailpouch-bridge-barrier-missing-"));
    roots.push(root);
    const options = {
      manifestRoot: join(root, "absent"),
      recoveryConfigRoot: join(root, "home"),
    };

    expect(retainedBridgeRecoveryRuns(options)).toEqual([]);
    expect(() => assertNoRetainedBridgeRecoveryRuns(options)).not.toThrow();
  });

  it("blocks an exact same-token manifest and retained recovery config pair", () => {
    const options = tempRoots();
    writeFileSync(manifestPath(options.manifestRoot, TOKEN_A), "not valid JSON");
    writeFileSync(configPath(options.recoveryConfigRoot, TOKEN_A), "{}");

    expect(retainedBridgeRecoveryRuns(options)).toEqual([{
      token: TOKEN_A,
      manifestPath: manifestPath(options.manifestRoot, TOKEN_A),
      recoveryConfigPath: configPath(options.recoveryConfigRoot, TOKEN_A),
    }]);
    expect(() => assertNoRetainedBridgeRecoveryRuns(options)).toThrow(
      new RegExp(`refused before live mailbox baseline capture.*${TOKEN_A}.*cleanup`, "i"),
    );
  });

  it("blocks a crash-published encrypted clone before an ownership manifest exists", () => {
    const options = tempRoots();
    const recoveryConfigPath = configPath(options.recoveryConfigRoot, TOKEN_A);
    const journal = createBridgeSetupJournal({
      scopeRoot: options.manifestRoot,
      token: TOKEN_A,
      recoveryConfigPath,
    });
    writeFileSync(recoveryConfigPath, "encrypted credential clone", { mode: 0o600 });

    expect(retainedBridgeSetupRuns(options)).toEqual([{
      token: TOKEN_A,
      journalPath: journal.path,
      recoveryConfigPath,
      recoveryConfigPresent: true,
    }]);
    expect(() => assertNoRetainedBridgeRecoveryRuns(options)).toThrow(
      new RegExp(`interrupted setup journal.*${TOKEN_A}.*encrypted clone`, "i"),
    );
  });

  it("keeps a journal-only interrupted publication visible until exact retirement", () => {
    const options = tempRoots();
    const recoveryConfigPath = configPath(options.recoveryConfigRoot, TOKEN_A);
    const journal = createBridgeSetupJournal({
      scopeRoot: options.manifestRoot,
      token: TOKEN_A,
      recoveryConfigPath,
    });

    expect(retainedBridgeSetupRuns(options)).toEqual([{
      token: TOKEN_A,
      journalPath: journal.path,
      recoveryConfigPath,
      recoveryConfigPresent: false,
    }]);
    expect(() => assertNoRetainedBridgeRecoveryRuns(options)).toThrow(/interrupted setup journal/i);

    expect(retireBridgeSetupJournal({
      scopeRoot: options.manifestRoot,
      token: TOKEN_A,
      recoveryConfigPath,
      journalId: journal.journalId,
    })).toBe(true);
    expect(existsSync(journal.path)).toBe(false);
    expect(retainedBridgeSetupRuns(options)).toEqual([]);
  });

  it("fails closed on malformed or replaced setup-journal authority", () => {
    const options = tempRoots();
    const recoveryConfigPath = configPath(options.recoveryConfigRoot, TOKEN_A);
    const journal = createBridgeSetupJournal({
      scopeRoot: options.manifestRoot,
      token: TOKEN_A,
      recoveryConfigPath,
    });
    const durable = JSON.parse(readFileSync(journal.path, "utf8")) as Record<string, unknown>;
    writeFileSync(journal.path, JSON.stringify({ ...durable, token: TOKEN_B }), { mode: 0o600 });

    expect(() => retainedBridgeSetupRuns(options)).toThrow(/invalid authority fields/i);
    expect(() => assertNoRetainedBridgeRecoveryRuns(options)).toThrow(/invalid authority fields/i);
    expect(() => retireBridgeSetupJournal({
      scopeRoot: options.manifestRoot,
      token: TOKEN_A,
      recoveryConfigPath,
      journalId: journal.journalId,
    })).toThrow(/invalid authority fields/i);
  });

  it("ignores legacy unjournaled orphans without a selected mailbox identity and inexact filenames", () => {
    const options = tempRoots();
    writeFileSync(manifestPath(options.manifestRoot, TOKEN_A), "{}");
    writeFileSync(configPath(options.recoveryConfigRoot, TOKEN_B), "{}");
    writeFileSync(join(options.manifestRoot, `bridge-run-${TOKEN_B}.json.tmp`), "{}");
    writeFileSync(join(options.manifestRoot, "bridge-run-not-a-run-token.json"), "{}");
    writeFileSync(join(options.recoveryConfigRoot, `.mailpouch-e2e-bridge-${TOKEN_A}.json.bak`), "{}");

    expect(retainedBridgeRecoveryRuns(options)).toEqual([]);
    expect(() => assertNoRetainedBridgeRecoveryRuns(options)).not.toThrow();
  });

  it("blocks same-mailbox and unverifiable pre-journal clones but ignores proven unrelated ones", () => {
    const options = tempRoots();
    const selected = {
      connection: { imapHost: "localhost", imapPort: 1143, username: "owner@proton.test" },
    };
    const unrelated = {
      connection: { imapHost: "localhost", imapPort: 1143, username: "other@proton.test" },
    };
    const scopedOptions = {
      ...options,
      mailboxScopeKey: bridgeMailboxScopeKeyFromConfig(selected),
    };
    writeFileSync(configPath(options.recoveryConfigRoot, TOKEN_A), JSON.stringify(selected), { mode: 0o600 });
    writeFileSync(configPath(options.recoveryConfigRoot, TOKEN_B), JSON.stringify(unrelated), { mode: 0o600 });
    writeFileSync(configPath(options.recoveryConfigRoot, TOKEN_C), "not-json", { mode: 0o600 });
    const legacyPath = join(
      options.recoveryConfigRoot,
      ".mailpouch-e2e-bridge-1780000000000-abcdef1234.json",
    );
    writeFileSync(legacyPath, JSON.stringify(selected), { mode: 0o600 });

    expect(retainedBridgeUnjournaledClones(scopedOptions)).toEqual([
      {
        identifier: "legacy-1780000000000-abcdef1234",
        recoveryConfigPath: legacyPath,
        format: "legacy-timestamp",
        mailboxIdentity: "matching",
      },
      {
        identifier: TOKEN_A,
        token: TOKEN_A,
        recoveryConfigPath: configPath(options.recoveryConfigRoot, TOKEN_A),
        format: "token",
        mailboxIdentity: "matching",
      },
      expect.objectContaining({
        identifier: TOKEN_C,
        token: TOKEN_C,
        recoveryConfigPath: configPath(options.recoveryConfigRoot, TOKEN_C),
        format: "token",
        mailboxIdentity: "unverifiable",
      }),
    ]);
    expect(() => assertNoRetainedBridgeRecoveryRuns(scopedOptions)).toThrow(
      /3 pre-journal encrypted recovery clone\(s\).*manual triage.*never auto-deleted/i,
    );
  });

  it("reports multiple retained pairs in deterministic token order", () => {
    const options = tempRoots();
    for (const token of [TOKEN_B, TOKEN_A]) {
      writeFileSync(manifestPath(options.manifestRoot, token), "{}");
      writeFileSync(configPath(options.recoveryConfigRoot, token), "{}");
    }

    const runs = retainedBridgeRecoveryRuns(options);
    expect(runs.map((run) => run.token)).toEqual([TOKEN_A, TOKEN_B]);
    expect(() => assertNoRetainedBridgeRecoveryRuns(options)).toThrow(/2 retained ownership recovery run\(s\)/i);
  });

  it("does not let inherited current-token or recovery-peer env values bypass a retained pair", () => {
    const options = tempRoots();
    writeFileSync(manifestPath(options.manifestRoot, TOKEN_A), "{}");
    writeFileSync(configPath(options.recoveryConfigRoot, TOKEN_A), "{}");
    vi.stubEnv("MAILPOUCH_E2E_RUN_TOKEN", TOKEN_A);
    vi.stubEnv("MAILPOUCH_E2E_RECOVERY_PEER_TOKENS", TOKEN_A);

    expect(() => assertNoRetainedBridgeRecoveryRuns(options)).toThrow(new RegExp(TOKEN_A));
  });

  it("fails closed when a matching recovery config cannot be inspected", () => {
    const options = tempRoots();
    writeFileSync(manifestPath(options.manifestRoot, TOKEN_A), "{}");
    // A regular file used as the configured root makes stat(root/child) fail
    // with ENOTDIR on every supported Node filesystem. Only ENOENT is allowed
    // to mean that the exact retained config is absent.
    rmSync(options.recoveryConfigRoot, { recursive: true });
    writeFileSync(options.recoveryConfigRoot, "not a directory");

    expect(() => retainedBridgeRecoveryRuns(options)).toThrow(
      /could not inspect retained recovery config/i,
    );
    expect(() => assertNoRetainedBridgeRecoveryRuns(options)).toThrow(
      /could not inspect retained recovery config/i,
    );
  });

  it("finds retained recovery authority from another worktree cwd", () => {
    const root = mkdtempSync(join(tmpdir(), "mailpouch-bridge-barrier-cross-cwd-"));
    roots.push(root);
    const homeRoot = join(root, "home");
    const sourceConfigPath = join(root, "operator-config.json");
    const worktreeA = join(root, "checkout-a");
    const worktreeB = join(root, "checkout-b");
    mkdirSync(homeRoot);
    mkdirSync(worktreeA);
    mkdirSync(worktreeB);
    writeFileSync(sourceConfigPath, JSON.stringify({
      connection: { imapHost: "localhost", imapPort: 1143, username: "owner@proton.test" },
    }), { mode: 0o600 });
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(worktreeA);
    const manifestPath = ownershipManifestPath(TOKEN_A, {
      authorityConfigPath: sourceConfigPath,
      homeRoot,
    });
    writeFileSync(manifestPath, "{}", { mode: 0o600 });
    writeFileSync(configPath(homeRoot, TOKEN_A), "{}", { mode: 0o600 });

    cwd.mockReturnValue(worktreeB);

    expect(retainedBridgeRecoveryRuns({
      authorityConfigPath: sourceConfigPath,
      homeRoot,
      recoveryConfigRoot: homeRoot,
    })).toEqual([{
      token: TOKEN_A,
      manifestPath,
      recoveryConfigPath: configPath(homeRoot, TOKEN_A),
    }]);
  });
});
