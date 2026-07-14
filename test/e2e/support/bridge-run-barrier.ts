import { lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isRunToken } from "./scratch.js";
import {
  bridgeMailboxScopeKeyFromConfig,
  resolveBridgeAuthorityScope,
} from "./bridge-authority-root.mjs";
import { listBridgeSetupJournals } from "./bridge-setup-journal.mjs";

const MANIFEST_PREFIX = "bridge-run-";
const JSON_SUFFIX = ".json";

export interface BridgeRunBarrierOptions {
  /** Directory containing durable bridge-run-<token>.json manifests. */
  manifestRoot?: string;
  /** Directory containing credential-free bridge-setup-<token>.json journals.
   * Defaults to manifestRoot/the resolved authority scope. */
  setupJournalRoot?: string;
  /** Directory containing retained .mailpouch-e2e-bridge-<token>.json clones. */
  recoveryConfigRoot?: string;
  /** Canonical source profile used to derive the cross-worktree authority scope. */
  authorityConfigPath?: string;
  /** Opaque normalized endpoint/user identity shared by equivalent profiles. */
  mailboxScopeKey?: string;
  /** Test-only user-home override. */
  homeRoot?: string;
}

export interface RetainedBridgeRecoveryRun {
  token: string;
  manifestPath: string;
  recoveryConfigPath: string;
}

export interface RetainedBridgeSetupRun {
  token: string;
  journalPath: string;
  recoveryConfigPath: string;
  recoveryConfigPresent: boolean;
}

export interface RetainedBridgeUnjournaledClone {
  identifier: string;
  token?: string;
  recoveryConfigPath: string;
  format: "token" | "legacy-timestamp";
  mailboxIdentity: "matching" | "unverifiable";
  error?: string;
}

const RECOVERY_CLONE_RE = /^\.mailpouch-e2e-bridge-(mpE2E-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/;
// Released Bridge harnesses before ownership-scoped clones used
// `.mailpouch-e2e-bridge-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
// and could persist plaintext config credentials after a hard crash. The
// generic sibling grammar is also inventoried and then mailbox-filtered.
const LEGACY_RECOVERY_CLONE_RE = /^\.mailpouch-e2e-(?:bridge-)?([0-9]{13})-([a-z0-9]{6,16})\.json$/;

function manifestToken(name: string): string | undefined {
  if (!name.startsWith(MANIFEST_PREFIX) || !name.endsWith(JSON_SUFFIX)) return undefined;
  const token = name.slice(MANIFEST_PREFIX.length, -JSON_SUFFIX.length);
  return isRunToken(token) ? token : undefined;
}

function retainedConfigExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error(
      `Bridge E2E preflight could not inspect retained recovery config at ${path}`,
      { cause: error },
    );
  }
}

function resolvedAuthorityRoot(options: BridgeRunBarrierOptions): string {
  return resolve(
    options.manifestRoot ?? resolveBridgeAuthorityScope({
      authorityConfigPath: options.authorityConfigPath,
      mailboxScopeKey: options.mailboxScopeKey,
      homeRoot: options.homeRoot,
    }).scopeRoot,
  );
}

/**
 * Find interrupted live-Bridge runs which still retain both halves needed for
 * exact recovery: the ownership manifest and its same-token encrypted config
 * clone. A manifest without that exact config is legacy/orphan bookkeeping,
 * not evidence that a recoverable run is still active.
 *
 * Manifest contents are deliberately not parsed here. Presence of the exact
 * pair is enough to stop a new baseline; malformed recovery authority must be
 * diagnosed by the standalone cleanup command, not silently ignored.
 */
export function retainedBridgeRecoveryRuns(
  options: BridgeRunBarrierOptions = {},
): RetainedBridgeRecoveryRun[] {
  const manifestRoot = resolvedAuthorityRoot(options);
  const recoveryConfigRoot = resolve(
    options.recoveryConfigRoot ?? homedir(),
  );
  // A non-directory config root must fail closed. Windows stat reports ENOENT
  // (not ENOTDIR) for children of a regular file, which retainedConfigExists
  // would misread as "config absent", so prove the root is a directory first.
  try {
    if (!statSync(recoveryConfigRoot).isDirectory()) {
      throw new Error("not a directory");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(
        `Bridge E2E preflight could not inspect retained recovery config root at ${recoveryConfigRoot}`,
        { cause: error },
      );
    }
  }

  let names: string[];
  try {
    names = readdirSync(manifestRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(
      `Bridge E2E preflight could not inspect ownership manifests at ${manifestRoot}`,
      { cause: error },
    );
  }

  const runs: RetainedBridgeRecoveryRun[] = [];
  for (const name of names) {
    const token = manifestToken(name);
    if (!token) continue;
    const recoveryConfigPath = join(
      recoveryConfigRoot,
      `.mailpouch-e2e-bridge-${token}.json`,
    );
    if (!retainedConfigExists(recoveryConfigPath)) continue;
    runs.push({
      token,
      manifestPath: join(manifestRoot, name),
      recoveryConfigPath,
    });
  }

  return runs.sort((left, right) => left.token.localeCompare(right.token));
}

/**
 * Find setup attempts whose credential-free journal was not retired. The
 * journal is published before the encrypted clone, so even a hard crash before
 * baseline/manifest creation remains discoverable. A journal without a clone
 * still blocks: only the exact setup owner/recovery path may decide that the
 * interrupted publication is safe to retire.
 */
export function retainedBridgeSetupRuns(
  options: BridgeRunBarrierOptions = {},
): RetainedBridgeSetupRun[] {
  const authorityRoot = resolvedAuthorityRoot(options);
  const setupJournalRoot = resolve(options.setupJournalRoot ?? authorityRoot);
  const recoveryConfigRoot = resolve(options.recoveryConfigRoot ?? homedir());
  return listBridgeSetupJournals({
    scopeRoot: setupJournalRoot,
    recoveryConfigRoot,
  }).map((journal) => ({
    token: journal.token,
    journalPath: journal.path,
    recoveryConfigPath: journal.recoveryConfigPath,
    recoveryConfigPresent: retainedConfigExists(journal.recoveryConfigPath),
  }));
}

function targetMailboxScopeKey(options: BridgeRunBarrierOptions): string | undefined {
  if (options.mailboxScopeKey) return options.mailboxScopeKey;
  if (options.authorityConfigPath) {
    return resolveBridgeAuthorityScope({
      authorityConfigPath: options.authorityConfigPath,
      homeRoot: options.homeRoot,
    }).mailboxScopeKey;
  }
  return undefined;
}

/**
 * Inventory pre-journal encrypted clones for the selected mailbox. They are
 * never auto-deleted: old harnesses did not durably prove whether a matching
 * ownership manifest existed elsewhere, so an operator must triage them.
 * Malformed exact clone names also block because their mailbox cannot be
 * proven unrelated without reading or decrypting any credential.
 */
export function retainedBridgeUnjournaledClones(
  options: BridgeRunBarrierOptions = {},
  claimedTokens: ReadonlySet<string> = new Set(),
): RetainedBridgeUnjournaledClone[] {
  const mailboxScopeKey = targetMailboxScopeKey(options);
  if (!mailboxScopeKey) return [];
  const recoveryConfigRoot = resolve(options.recoveryConfigRoot ?? homedir());
  let names: string[];
  try {
    names = readdirSync(recoveryConfigRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(
      `Bridge E2E preflight could not inventory legacy recovery clones at ${recoveryConfigRoot}`,
      { cause: error },
    );
  }

  const retained: RetainedBridgeUnjournaledClone[] = [];
  for (const name of names.sort()) {
    const currentMatch = RECOVERY_CLONE_RE.exec(name);
    const legacyMatch = LEGACY_RECOVERY_CLONE_RE.exec(name);
    if (!currentMatch && !legacyMatch) continue;
    const token = currentMatch?.[1];
    if (token && claimedTokens.has(token)) continue;
    const format = currentMatch ? "token" : "legacy-timestamp";
    const identifier = token ?? `legacy-${legacyMatch![1]}-${legacyMatch![2]}`;
    const recoveryConfigPath = join(recoveryConfigRoot, name);
    try {
      const entry = lstatSync(recoveryConfigPath);
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new Error("exact recovery clone is not a regular, non-symlink file");
      }
      if (process.platform !== "win32" && (entry.mode & 0o077) !== 0) {
        throw new Error("exact recovery clone is not owner-only");
      }
      const parsed: unknown = JSON.parse(readFileSync(recoveryConfigPath, "utf8"));
      if (bridgeMailboxScopeKeyFromConfig(parsed) !== mailboxScopeKey) continue;
      retained.push({
        identifier,
        ...(token ? { token } : {}),
        recoveryConfigPath,
        format,
        mailboxIdentity: "matching",
      });
    } catch (error) {
      retained.push({
        identifier,
        ...(token ? { token } : {}),
        recoveryConfigPath,
        format,
        mailboxIdentity: "unverifiable",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return retained;
}

/** Refuse a new live-mail baseline while an exact recoverable run is pending. */
export function assertNoRetainedBridgeRecoveryRuns(
  options: BridgeRunBarrierOptions = {},
): void {
  const setups = retainedBridgeSetupRuns(options);
  const runs = retainedBridgeRecoveryRuns(options);
  const claimedTokens = new Set([
    ...setups.map((run) => run.token),
    ...runs.map((run) => run.token),
  ]);
  const unjournaledClones = retainedBridgeUnjournaledClones(options, claimedTokens);
  if (setups.length === 0 && runs.length === 0 && unjournaledClones.length === 0) return;

  const setupDetails = setups.map(({ token, journalPath, recoveryConfigPath, recoveryConfigPresent }) =>
    `${token} (journal ${journalPath}; encrypted clone ${recoveryConfigPresent ? recoveryConfigPath : "not present"})`
  ).join(", ");
  const recoveryDetails = runs.map(({ token, manifestPath, recoveryConfigPath }) =>
    `${token} (manifest ${manifestPath}; config ${recoveryConfigPath})`
  ).join(", ");
  const legacyCloneDetails = unjournaledClones.map(({ identifier, recoveryConfigPath, format, mailboxIdentity, error }) =>
    `${identifier} (${recoveryConfigPath}; format ${format}; mailbox ${mailboxIdentity}` +
      (error ? `: ${error}` : "") + ")"
  ).join(", ");
  const clauses = [
    ...(setups.length > 0
      ? [`${setups.length} interrupted setup journal(s) must be resolved first: ${setupDetails}. ` +
        "Retire any exact encrypted clone before removing its journal"]
      : []),
    ...(runs.length > 0
      ? [`${runs.length} retained ownership recovery run(s) must be resolved first: ${recoveryDetails}. ` +
        "Run npm run test:e2e:bridge:cleanup with each exact config and run token"]
      : []),
    ...(unjournaledClones.length > 0
      ? [`${unjournaledClones.length} pre-journal encrypted recovery clone(s) require manual triage: ` +
        `${legacyCloneDetails}. Verify that no matching legacy ownership manifest or E2E process remains, ` +
        "then durably retire only those exact files; they are never auto-deleted"]
      : []),
  ];
  throw new Error(
    `Bridge E2E refused before live mailbox baseline capture: ` +
    `${clauses.join("; ")}.`,
  );
}
