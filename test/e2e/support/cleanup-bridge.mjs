#!/usr/bin/env node
/**
 * Fail-closed cleanup for one crashed ownership-scoped Bridge E2E run.
 *
 * Both the config and exact run token are required. The script permanently
 * deletes only messages whose X-MailPouch-E2E-Run header exactly equals that
 * token (or whose complete subject/Message-ID proof is in the run manifest).
 * Empty folders in the run's anchored Folders/Labels namespace are verified,
 * retained, and reported for manual cleanup: live recovery never issues IMAP
 * mailbox DELETE. Prefix-only discovery is intentionally not enough to
 * classify a folder as safe residue.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { ImapFlow } from "imapflow";
import {
  DeadlineExceededError,
  runDeadlinePhase as runObservedDeadlinePhase,
} from "./deadline-race.mjs";
import { beginFailClosedDeadline } from "./fail-closed-deadline.mjs";
import { buildOwnershipDiscoveryQuery } from "./ownership-search.mjs";
import {
  isFatalCleanupError,
  MutationOutcomeUnknownError,
  MutationRefusedError,
  requireMutationResult,
} from "./mutation-result.mjs";
import {
  bridgeMutationUidBatches,
  chunkUids,
} from "./uid-batches.mjs";
import {
  createRescueLifecycle,
  markRescueCreated,
  markRescueRetained,
  permitInitialRescueStage,
  permitNextRescueStage,
  planRescueRound,
} from "./rescue-lifecycle.mjs";
import {
  BRIDGE_BASELINE_VERIFY_MS,
  BRIDGE_ALL_MAIL_RESCUE_STABILITY_MS,
  BRIDGE_CLEANUP_SETTLE_MS,
  BRIDGE_MUTATION_COMMAND_MS,
  BRIDGE_SETUP_MS,
  bridgeStandaloneProcessBudgetMs,
} from "./time-budgets.mjs";
import {
  acquireBridgeCleanupLeaseAccess,
  bridgeMailboxScopeKeyFromConfig,
  resolveBridgeAuthorityScope,
} from "./bridge-authority-root.mjs";
import { retireBridgeSetupJournal } from "./bridge-setup-journal.mjs";

const CONNECTION_TIMEOUT_MS = 15_000;
const GREETING_TIMEOUT_MS = 15_000;
const SOCKET_TIMEOUT_MS = 30_000;
const BASELINE_FETCH_UID_BATCH_SIZE = 500;
const MAX_AMBIGUOUS_SESSION_RESTARTS = 8;
const AMBIGUOUS_SESSION_SETTLE_MS = 1_000;
const RESCUE_REARM_NONCE_RE = /^[0-9a-f]{64}$/i;
const MAX_RESCUE_REARM_HASHES = 64;

const configPath = process.env.MAILPOUCH_E2E_BRIDGE_CONFIG;
const authorityConfigPath = process.env.MAILPOUCH_E2E_AUTHORITY_CONFIG;
const token = process.env.MAILPOUCH_E2E_RUN_TOKEN;
const tokenRe = /^mpE2E-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
let cleanupLease;

if (!configPath || !existsSync(configPath)) fail("Set MAILPOUCH_E2E_BRIDGE_CONFIG to an existing Bridge config.");
if (!token || !tokenRe.test(token)) fail("Set MAILPOUCH_E2E_RUN_TOKEN to the exact mpE2E-<UUIDv4> run token.");
if (!authorityConfigPath) {
  fail("Set MAILPOUCH_E2E_AUTHORITY_CONFIG to the original source configuration profile for this run.");
}

// Establish the exact non-symlink recovery clone and derive its credential-free
// mailbox identity before selecting an authority namespace. This synchronous
// read grants no mutation authority and performs no keychain or network work.
const resolvedConfigPath = resolve(configPath);
const expectedClonePath = resolve(
  homedir(),
  `.mailpouch-e2e-bridge-${token}.json`,
);
let cloneIdentity;
let configBytes;
try {
  if (!samePlatformPath(resolvedConfigPath, expectedClonePath)) {
    throw new Error(`expected the exact token-bound recovery clone at ${expectedClonePath}`);
  }
  const entry = lstatSync(resolvedConfigPath, { bigint: true });
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new Error("the token-bound recovery clone must be a regular, non-symlink file");
  }
  const canonicalClonePath = realpathSync.native(resolvedConfigPath);
  if (!samePlatformPath(canonicalClonePath, resolvedConfigPath)) {
    throw new Error("the token-bound recovery clone path did not resolve to itself");
  }
  configBytes = readFileSync(resolvedConfigPath);
  cloneIdentity = {
    dev: entry.dev,
    ino: entry.ino,
    sha256: createHash("sha256").update(configBytes).digest("hex"),
  };
} catch (error) {
  fail(`Bridge cleanup refused unsafe recovery config: ${message(error)}`);
}

let config;
try {
  config = JSON.parse(configBytes.toString("utf8"));
} catch (error) {
  fail(`Bridge cleanup recovery clone is not valid JSON: ${message(error)}`);
}

let mailboxScopeKey;
try {
  mailboxScopeKey = bridgeMailboxScopeKeyFromConfig(config);
} catch (error) {
  fail(`Bridge cleanup recovery clone has no valid mailbox identity: ${message(error)}`);
}

// Resolve authority outside the repository checkout and participate in the
// mailbox's shared lease before reading its manifest, hydrating credentials,
// or opening IMAP. A manual cleanup atomically owns the same lease through its
// terminal commit. A live harness may instead delegate its exact random owner
// token; that child participates without releasing the parent's lease.
let authority;
try {
  authority = resolveBridgeAuthorityScope({ authorityConfigPath, mailboxScopeKey });
  if (samePlatformPath(resolvedConfigPath, authority.authorityConfigPath)) {
    throw new Error("the recovery clone resolves to the source authority config");
  }
  cleanupLease = acquireBridgeCleanupLeaseAccess({
    scope: authority,
    ownerToken: process.env.MAILPOUCH_E2E_LEASE_OWNER_TOKEN,
  });
} catch (error) {
  fail(`Bridge cleanup lease check failed: ${message(error)}`);
}

// Parse the durable recovery authority and arm the independent process
// watchdog before keychain hydration, connection setup, or any other await.
// A native credential backend or transport promise can otherwise outlive all
// phase-local timers without ever reaching their finally blocks.
const manifestRoot = authority.scopeRoot;
const manifestPath = resolve(manifestRoot, `bridge-run-${token}.json`);
if (!existsSync(manifestPath)) {
  fail(`Bridge cleanup refused: required v2 ownership manifest is missing at ${manifestPath}.`);
}
let manifest;
try {
  const rawManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (rawManifest?.version !== 2) throw new Error("standalone cleanup requires a v2 manifest");
  manifest = parseManifest(rawManifest);
  if (!manifest.baseline) throw new Error("v2 manifest is missing its durable mailbox baseline");
} catch (error) {
  fail(`Invalid ownership manifest ${manifestPath}: ${message(error)}`);
}
const rescueCopyRearm = process.env.MAILPOUCH_E2E_REARM_RESCUE_COPY;
const rescueCopyRearmNonce = process.env.MAILPOUCH_E2E_REARM_RESCUE_COPY_NONCE;
if (rescueCopyRearm !== undefined && rescueCopyRearm !== token) {
  fail("Bridge cleanup refused a rescue COPY rearm which was not bound to the exact run token.");
}
if ((rescueCopyRearm === undefined) !== (rescueCopyRearmNonce === undefined)) {
  fail("Bridge cleanup requires the exact-token rescue COPY rearm and its one-use nonce together.");
}
if (rescueCopyRearmNonce !== undefined && !RESCUE_REARM_NONCE_RE.test(rescueCopyRearmNonce)) {
  fail("Bridge cleanup refused an invalid rescue COPY rearm nonce; expected 64 hexadecimal characters.");
}
if (rescueCopyRearm === token
  && manifest.cleanup?.allMailRescue !== "create-pending"
  && manifest.cleanup?.allMailRescue !== "copy-pending"
  && manifest.cleanup?.allMailRescue !== "payload-observed"
  && manifest.cleanup?.allMailRescue !== "complete") {
  fail("Bridge cleanup refused rescue COPY rearm without a durable rescue lifecycle phase.");
}
const rescueCopyRearmHash = rescueCopyRearm === token
  ? createHash("sha256")
    .update(`mailpouch-e2e-rescue-rearm-v1\0${token}\0${rescueCopyRearmNonce}`, "utf8")
    .digest("hex")
  : undefined;
if (rescueCopyRearmHash
  && manifest.cleanup?.rescueRearmConsumedHashes?.includes(rescueCopyRearmHash)) {
  fail("Bridge cleanup refused a rescue COPY rearm nonce which this run already consumed.");
}
let peerProofOwners;
try {
  peerProofOwners = loadRecoveryPeerProofOwners(
    process.env.MAILPOUCH_E2E_RECOVERY_PEER_TOKENS,
    process.env.MAILPOUCH_E2E_RECOVERY_APPEND_HASHES,
  );
} catch (error) {
  fail(`Bridge cleanup refused invalid recovery peer authority: ${message(error)}`);
}
let client;
let activeDeadline;
const verbose = process.env.MAILPOUCH_E2E_CLEANUP_VERBOSE === "1";
const processStartedAt = Date.now();
const setupDeadline = processStartedAt + BRIDGE_SETUP_MS;
const processGuard = beginFailClosedDeadline({
  deadline: processStartedAt + bridgeStandaloneProcessBudgetMs(manifest.pending.length > 0),
  label: "standalone cleanup process",
  closeConnection: () => client?.close(),
  report: reportDeadline,
  terminate: terminateCleanup,
});
const accounts = Array.isArray(config.accounts) ? config.accounts : [];
const active = accounts.find((account) => account?.id === config.activeAccountId) ?? accounts[0];
const conn = active ? { ...(config.connection ?? {}), ...active } : { ...(config.connection ?? {}) };
const exactEncryptedClone = true;

if (config.keychainMailboxCredentialsQuarantined === true && !exactEncryptedClone) {
  fail("Bridge cleanup refused: mailbox keychain credentials are quarantined after a failed reset.");
}

if (!conn.password && conn.passwordEncrypted) {
  try {
    const { CredentialEncryption } = await runCleanupDeadlinePhase(
      setupDeadline,
      "credential decryption setup",
      () => import(
        new URL("../../../dist/crypto/credential-encryption.js", import.meta.url)
      ),
    );
    if (!CredentialEncryption.isValidEncrypted(conn.passwordEncrypted)) {
      fail("Bridge cleanup config contains an invalid encrypted password shape.");
    }
    conn.password = CredentialEncryption.decrypt(conn.passwordEncrypted);
  } catch (error) {
    fail(`Could not decrypt Bridge cleanup credentials; run npm run build first: ${message(error)}`);
  }
}

// Normal mailpouch installations keep Bridge credentials in the OS keychain.
// Reuse the built runtime adapter so crash cleanup never requires copying a
// password into a second durable config file or printing it in a shell.
if (!conn.password && !exactEncryptedClone) {
  try {
    const { perAccount, legacy } = await runCleanupDeadlinePhase(
      setupDeadline,
      "credential hydration setup",
      async () => {
        const keychain = await import(new URL("../../../dist/security/keychain.js", import.meta.url));
        checkDeadline();
        const perAccount = active?.id ? await keychain.loadAccountCredentials(active.id) : null;
        checkDeadline();
        const legacy = !active || active.id === "primary" ? await keychain.loadCredentials() : null;
        checkDeadline();
        return { perAccount, legacy };
      },
    );
    conn.password = perAccount?.password
      || (active?.id === "primary" ? legacy?.password : "")
      || (!active ? legacy?.password : "")
      || "";
  } catch (error) {
    fail(`Could not hydrate Bridge cleanup credentials from the OS keychain; run npm run build first: ${message(error)}`);
  }
}
if (!conn.imapHost || !conn.username || !conn.password) {
  fail("Config and OS keychain do not provide usable Bridge IMAP host, username, and password fields.");
}

let tls;
if (conn.bridgeCertPath) {
  if (!existsSync(conn.bridgeCertPath)) fail(`Bridge certificate not found: ${conn.bridgeCertPath}`);
  tls = {
    ca: [readFileSync(conn.bridgeCertPath, "utf8")],
    rejectUnauthorized: true,
    checkServerIdentity: () => undefined,
    minVersion: "TLSv1.2",
  };
} else if (conn.allowInsecureBridge === true) {
  tls = { rejectUnauthorized: false, minVersion: "TLSv1.2" };
} else {
  fail("Bridge cleanup requires bridgeCertPath or the explicit allowInsecureBridge opt-in.");
}

client = createImapClient();

const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const scratchRe = new RegExp(`^(?:Folders|Labels)/${escaped}(?:-[A-Za-z0-9][A-Za-z0-9._-]*| spaced [1-9][0-9]*)$`);
const rescuePath = `Folders/${token}-cleanup-rescue`;
const rescueLifecycle = createRescueLifecycle(
  manifest.cleanup?.allMailRescue ?? "idle",
  { operatorRetryPermitted: rescueCopyRearm === token },
);
let initialAllMailSourceObservation;
let rescueReadyToComplete = false;
if (rescueCopyRearm === token) {
  debug("operator-authorized, nonce-bound one-shot rescue COPY rearm is armed for this exact run token");
}
for (const proof of manifest.createdMailboxes) {
  if (!scratchRe.test(proof.path)) fail(`Bridge cleanup refused: invalid created mailbox proof ${proof.path}.`);
  if (manifest.baseline.mailboxPaths.includes(proof.path)) {
    fail(`Bridge cleanup refused: created mailbox proof ${proof.path} collides with the pre-run baseline.`);
  }
}
const createdMailboxes = new Map(
  manifest.createdMailboxes.map((proof) => [proof.path, proof.uidValidity]),
);
const errors = [];
const ownershipUidProofs = new Map();
const allMailPaths = new Set();
const peerBaselineExemptions = [];
/** Baseline discrepancies in mailboxes this run could not have mutated. Never
 * fatal, always reported: silence would make a narrowed scope indistinguishable
 * from a clean mailbox. */
const outOfScopeBaselineDrift = [];
const usedPeerBaselineProofs = new Set();
let retainedEmptyFolders = [];

try {
  await runCleanupDeadlinePhase(
    setupDeadline,
    "IMAP connection and authentication setup",
    async () => {
      await client.connect();
      checkDeadline();
      requireUidPlus("after IMAP authentication");
    },
  );
  const startedAt = Date.now();
  const pendingAtStart = manifest.pending.length > 0;
  const settleMs = BRIDGE_CLEANUP_SETTLE_MS;
  const pendingGraceDeadline = pendingAtStart ? startedAt + settleMs : startedAt;
  // A large Bridge profile can take many seconds for one comprehensive scan.
  // After the full pending-delivery grace, retain a second full window for the
  // two independent clean scans required to finish safely.
  const convergenceDeadline = startedAt + settleMs + (pendingAtStart ? settleMs : 0);
  await runCleanupDeadlinePhase(
    convergenceDeadline,
    "cleanup convergence",
    async () => {
    // Bridge mailbox views converge asynchronously. Reconcile the exact-owned
    // set until two complete, consecutive scans agree that every selectable
    // mailbox is clean. A stale post-MOVE view is therefore retried instead of
    // becoming a permanent error, and delayed Trash/All Mail records trigger
    // another exact purge/rescue pass.
    let consecutiveCleanScans = 0;
    let consecutiveEnvironmentCleanScans = 0;
    let lastOwnedResidue = new Map();
    let lastScratchResidue = [];
    const observedErrors = new Set();
    const emptyScratchProofs = new Map();
    let round = 0;
    let ambiguousSessionRestarts = 0;
    // A successful MOVE can leave a projected source association behind.
    // Re-prove and remove that association only in a later fresh session;
    // never stack a DELETE behind the MOVE that created the checkpoint.
    let pendingSourcePurge;
    // Volatile proof chain for sequential singleton rescue cycles. This is
    // deliberately lost on restart: payload-observed alone never authorizes a
    // new COPY. A later stage is permitted only after this process explicitly
    // observed MOVE success, purged its Trash record, and re-proved the rescue
    // source empty in a fresh session.
    let rescueAwaitingTrashPurge = false;
    let rescueTrashPurgeConfirmed = false;
    let rescueTrashCheckpoint;
    // Once a durable rescue cycle exists, target only its concrete checkpoints
    // between singleton mutations. Comprehensive audits still inspect every
    // mailbox; any newly observed ordinary residue disables this fast path for
    // the next round.
    let rescueFastPath = rescueLifecycle.phase !== "idle";

    while (consecutiveCleanScans < 2) {
      checkDeadline();
      round += 1;
      try {
      // Confirmation rounds must observe a new Bridge session. Two scans on a
      // single SELECT cache are correlated and can both miss delayed virtual
      // projections.
      if (round > 1) await refreshCleanupClient();
      checkDeadline();
      const listed = await client.list();
      checkDeadline();
      rememberAllMailPaths(listed);
      const selectable = listed.filter(isSelectable);
      const trash = selectable.find((mailbox) => mailbox.specialUse?.toLowerCase() === "\\trash")
        ?? selectable.find((mailbox) => mailbox.path.toLowerCase() === "trash");
      if (!trash) throw new Error("No \\Trash special-use mailbox exists; refusing to create a system folder.");

      const scratch = new Set(selectable.map((mailbox) => mailbox.path).filter((path) => scratchRe.test(path)));
      const work = selectable
        .filter((mailbox) => !isAllMailMailbox(mailbox))
        .map((mailbox) => mailbox.path)
        // All Mail is a virtual projection whose UIDs Proton Bridge may remap
        // without changing UIDVALIDITY. Observe it during the audit, but never
        // use one of its UIDs as a mutation operand.
        .filter((path) => path !== trash.path && path !== rescuePath)
        .sort((left, right) => rank(left, scratch) - rank(right, scratch) || right.length - left.length);
      const touchedScratch = new Set();
      // Rebuilt from current-round observations. A path is reported as safely
      // retained only after this fresh session re-proves its created identity
      // and emptiness; it is never an operand to mailbox DELETE.
      const manualFolderCleanup = new Set();
      let roundMutated = false;
      let roundSafetyReadFailed = false;

      // Trash is the highest-value concrete checkpoint. Clear an exact-owned
      // Trash UID before either a remembered source checkpoint or a broad
      // source scan. If this mutates, retain the source checkpoint and
      // reconcile it only after another fresh session proves Trash clean.
      try {
        const purgedTrash = await purgeExactOwned(trash.path);
        if (purgedTrash.count > 0) {
          debug(`round ${round}: purged ${purgedTrash.count} owned message(s) from ${trash.path}`);
          if (rescueAwaitingTrashPurge
            && rescueTrashCheckpoint
            && purgedTrash.uidValidity === rescueTrashCheckpoint.uidValidity
            && purgedTrash.uids.includes(rescueTrashCheckpoint.uid)) {
            rescueTrashPurgeConfirmed = true;
          }
          roundMutated = true;
        }
      } catch (error) {
        if (isFatalStandaloneCleanupError(error)) throw error;
        checkDeadline();
        roundSafetyReadFailed = true;
        observedErrors.add(`${trash.path}: purge failed: ${message(error)}`);
      }
      if (roundMutated) {
        resetInitialAllMailSourceStability();
        emptyScratchProofs.clear();
        consecutiveCleanScans = 0;
        consecutiveEnvironmentCleanScans = 0;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
        checkDeadline();
        continue;
      }

      if (pendingSourcePurge) {
        const path = pendingSourcePurge;
        if (!work.includes(path) && path !== rescuePath) pendingSourcePurge = undefined;
      }
      if (pendingSourcePurge === rescuePath
        && rescueAwaitingTrashPurge
        && !rescueTrashPurgeConfirmed) {
        // The MOVE destination may be delayed. Do not clear or mutate the
        // rescue source checkpoint until the exact UIDPLUS destination UID has
        // been explicitly deleted from Trash in a later fresh session.
        resetInitialAllMailSourceStability();
        emptyScratchProofs.clear();
        consecutiveCleanScans = 0;
        consecutiveEnvironmentCleanScans = 0;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
        checkDeadline();
        continue;
      }
      if (pendingSourcePurge) {
        const path = pendingSourcePurge;
        try {
          const purged = await purgeExactOwned(path);
          if (purged.count > 0) {
            debug(`round ${round}: removed ${purged.count} retained owned association(s) from ${path}`);
            roundMutated = true;
            if (scratch.has(path)) touchedScratch.add(path);
          } else {
            pendingSourcePurge = undefined;
            if (path === rescuePath
              && rescueAwaitingTrashPurge
              && rescueTrashPurgeConfirmed) {
              if (rescueLifecycle.phase === "payload-observed") {
                permitNextRescueStage(rescueLifecycle);
              }
              rescueAwaitingTrashPurge = false;
              rescueTrashPurgeConfirmed = false;
              rescueTrashCheckpoint = undefined;
            }
          }
        } catch (error) {
          if (isFatalStandaloneCleanupError(error)) throw error;
          checkDeadline();
          roundSafetyReadFailed = true;
          observedErrors.add(`${path}: retained-source purge failed: ${message(error)}`);
        }
      }

      if (roundMutated || pendingSourcePurge) {
        // The mutation is already durably discoverable and this one-shot
        // session must not perform a correlated all-mailbox audit. Rotate at
        // the top of the next round and re-prove this exact source first.
        resetInitialAllMailSourceStability();
        emptyScratchProofs.clear();
        consecutiveCleanScans = 0;
        consecutiveEnvironmentCleanScans = 0;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
        checkDeadline();
        continue;
      }

      // Concrete folders and labels are safe mutation sources only after an
      // exact header/Message-ID ownership query returns their UIDs.
      for (const path of roundMutated || pendingSourcePurge || rescueFastPath ? [] : work) {
        checkDeadline();
        let sourceMutated = false;
        try {
          // Proton's Starred/Important category views can reject or never
          // acknowledge MOVE. UID DELETE is bounded to the freshly-proven
          // exact-owned operands and avoids wedging before rescue cleanup.
          const directDelete = requiresDirectOwnedDelete(path);
          const moved = directDelete
            ? await purgeExactOwned(path)
            : await moveExactOwned(path, trash.path);
          if (moved.count > 0) {
            debug(
              directDelete
                ? `round ${round}: deleted ${moved.count} owned projected message(s) from ${path}`
                : `round ${round}: moved ${moved.count} owned message(s) from ${path} to ${trash.path}`,
            );
            sourceMutated = true;
            roundMutated = true;
            pendingSourcePurge = path;
            if (scratch.has(path)) touchedScratch.add(path);
          }
        } catch (error) {
          if (isFatalStandaloneCleanupError(error)) throw error;
          if (sourceMutated) {
            try { client?.close(); } catch { /* do not continue after a post-mutation read failure */ }
            throw new MutationOutcomeUnknownError("post-mutation source verification");
          }
          checkDeadline();
          roundSafetyReadFailed = true;
          observedErrors.add(`${path}: ${message(error)}`);
        }
        // Let Trash purge the canonical records, then begin the next source
        // from a fresh Bridge session. Mutating multiple projected mailboxes in
        // one session can leave a later MOVE operating on stale canonical state.
        if (sourceMutated) break;
      }

      checkDeadline();
      if (roundMutated || pendingSourcePurge) {
        resetInitialAllMailSourceStability();
        emptyScratchProofs.clear();
        consecutiveCleanScans = 0;
        consecutiveEnvironmentCleanScans = 0;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
        checkDeadline();
        continue;
      }

      if (roundSafetyReadFailed) {
        // COPY rescue is permitted only after every concrete source and Trash
        // checkpoint was read successfully in this fresh session. A partial
        // discovery cannot establish that residue exists only in All Mail.
        resetInitialAllMailSourceStability();
        emptyScratchProofs.clear();
        consecutiveCleanScans = 0;
        consecutiveEnvironmentCleanScans = 0;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
        checkDeadline();
        continue;
      }

      // All Mail is never a destructive operand. Once every concrete source is
      // clean, reconcile at most one exact-owned virtual UID through the
      // durable rescue mailbox using COPY only. The helper persists lifecycle
      // state before dispatch and returns after at most one wire mutation path.
      const rescue = await reconcileAllMailRescue(
        selectable.filter(isAllMailMailbox),
        selectable.some((mailbox) => mailbox.path === rescuePath),
        trash.path,
      );
      if (rescue.drained) {
        pendingSourcePurge = rescuePath;
        rescueAwaitingTrashPurge = true;
        rescueTrashPurgeConfirmed = false;
        rescueTrashCheckpoint = rescue.trashCheckpoint;
      }
      if (rescue.staged || rescue.drained) rescueFastPath = true;
      if (rescue.mutated) {
        resetInitialAllMailSourceStability();
        emptyScratchProofs.clear();
        consecutiveCleanScans = 0;
        consecutiveEnvironmentCleanScans = 0;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
        checkDeadline();
        continue;
      }

      // Classify only strict token folders independently verified empty. IMAP
      // has no atomic DELETE-if-empty command, so live recovery always retains
      // these folders. Any foreign message leaves the folder outside this
      // allowed retained set and prevents a clean result.
      const afterActions = await client.list();
      checkDeadline();
      rememberAllMailPaths(afterActions);
      for (const path of roundMutated
        ? []
        : afterActions.map((mailbox) => mailbox.path).filter((path) => scratchRe.test(path))) {
        checkDeadline();
        try {
          // A path that existed before this run is never this run's folder,
          // even if its spelling happens to match the random token namespace.
          if (manifest.baseline.mailboxPaths.includes(path)) {
            emptyScratchProofs.delete(path);
            observedErrors.add(`${path}: retained because it existed in the pre-run baseline`);
            continue;
          }
          const createdUidValidity = createdMailboxes.get(path);
          if (!createdUidValidity) {
            emptyScratchProofs.delete(path);
            observedErrors.add(`${path}: retained because this run has no positive mailbox-creation proof`);
            continue;
          }
          if (touchedScratch.has(path)) {
            emptyScratchProofs.delete(path);
            continue;
          }
          const observation = await mailboxIdentityAndCount(path);
          if (observation.uidValidity !== createdUidValidity) {
            emptyScratchProofs.delete(path);
            observedErrors.add(
              `${path}: retained because UIDVALIDITY changed from the run-created identity ${createdUidValidity} to ${observation.uidValidity}`,
            );
            continue;
          }
          if (observation.count !== 0) {
            emptyScratchProofs.delete(path);
            continue;
          }
          const priorProof = emptyScratchProofs.get(path);
          const emptyProofs = priorProof?.uidValidity === observation.uidValidity
            ? priorProof.count + 1
            : 1;
          emptyScratchProofs.set(path, {
            count: emptyProofs,
            uidValidity: observation.uidValidity,
          });
          // Require two zero observations separated by the fresh-session
          // boundary at the top of the next round. Recreating the path changes
          // UIDVALIDITY and resets the proof. Repeated proof authorizes only an
          // explicit manual-cleanup report, never mailbox DELETE.
          if (emptyProofs >= 2) manualFolderCleanup.add(path);
        } catch (error) {
          emptyScratchProofs.delete(path);
          if (isFatalStandaloneCleanupError(error)) throw error;
          checkDeadline();
          observedErrors.add(`${path}: retained-folder classification failed: ${message(error)}`);
        }
      }

      // This comprehensive scan is authoritative for the round. Requiring two
      // clean scans prevents a transiently empty virtual view from ending the
      // cleanup before delayed records reappear.
      const auditList = await client.list();
      checkDeadline();
      rememberAllMailPaths(auditList);
      lastScratchResidue = auditList.map((mailbox) => mailbox.path).filter((path) => scratchRe.test(path));
      lastOwnedResidue = new Map();
      let auditFailed = false;
      for (const mailbox of auditList.filter(isSelectable)) {
        checkDeadline();
        try {
          const remaining = await exactOwnedUids(mailbox.path);
          if (remaining.length) lastOwnedResidue.set(mailbox.path, remaining.length);
        } catch (error) {
          if (isFatalStandaloneCleanupError(error)) throw error;
          checkDeadline();
          auditFailed = true;
          observedErrors.add(`${mailbox.path}: ownership audit failed: ${message(error)}`);
        }
      }
      if (rescueFastPath && [...lastOwnedResidue.keys()].some((path) => (
        path !== rescuePath
        && path !== trash.path
        && !allMailPaths.has(path)
        && !/^all mail$/i.test(path.trim())
      ))) {
        rescueFastPath = false;
      }

      // Recheck every allowed retained folder during the authoritative audit.
      // This cannot make DELETE safe, but it prevents a stale empty
      // classification from being reported after content or identity changed.
      for (const path of [...manualFolderCleanup]) {
        checkDeadline();
        try {
          const observation = await mailboxIdentityAndCount(path);
          if (observation.uidValidity !== createdMailboxes.get(path) || observation.count !== 0) {
            manualFolderCleanup.delete(path);
          }
        } catch (error) {
          if (isFatalStandaloneCleanupError(error)) throw error;
          checkDeadline();
          manualFolderCleanup.delete(path);
          auditFailed = true;
          observedErrors.add(`${path}: retained-folder verification failed: ${message(error)}`);
        }
      }

      if (auditFailed) resetInitialAllMailSourceStability();

      retainedEmptyFolders = lastScratchResidue
        .filter((path) => manualFolderCleanup.has(path))
        .sort();
      const unsafeScratchResidue = lastScratchResidue
        .filter((path) => !manualFolderCleanup.has(path));
      const environmentClean = !roundMutated
        && !auditFailed
        && lastOwnedResidue.size === 0
        && unsafeScratchResidue.length === 0;
      const rescueTerminal = rescueLifecycle.phase === "idle"
        || rescueLifecycle.phase === "complete"
        || rescueReadyToComplete;
      const pendingGraceElapsed = Date.now() >= pendingGraceDeadline;
      debug(
        `round ${round}: owned=${JSON.stringify(Object.fromEntries(lastOwnedResidue))} ` +
        `scratch=${JSON.stringify(lastScratchResidue)} rescuePhase=${rescueLifecycle.phase}`,
      );
      consecutiveEnvironmentCleanScans = environmentClean && pendingGraceElapsed
        ? consecutiveEnvironmentCleanScans + 1
        : 0;
      const remainingPending = manifest.pending.length;
      if (remainingPending > 0 && consecutiveEnvironmentCleanScans >= 2) {
        throw new Error(
          `${remainingPending} unresolved pending ownership proof(s) remain after the delivery grace`,
        );
      }
      // A nonterminal rescue phase records an ambiguous CREATE/COPY or a
      // payload which has not completed its fresh-session drain proof. Even
      // if virtual views are transiently empty, retiring the manifest here
      // would discard the only authority needed to reconcile a late result.
      consecutiveCleanScans = environmentClean
        && rescueTerminal
        && pendingGraceElapsed
        && remainingPending === 0
        ? consecutiveCleanScans + 1
        : 0;
      if (consecutiveCleanScans >= 2
        && rescueReadyToComplete
        && rescueLifecycle.phase !== "complete") {
        if (markRescueRetained(rescueLifecycle)) persistRescueLifecyclePhase();
      }
      if (consecutiveCleanScans < 2) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
        checkDeadline();
      }
      } catch (error) {
        if (error?.code !== "MAILPOUCH_E2E_MUTATION_OUTCOME_UNKNOWN") throw error;
        ambiguousSessionRestarts += 1;
        if (ambiguousSessionRestarts > MAX_AMBIGUOUS_SESSION_RESTARTS) {
          throw new MutationOutcomeUnknownError(
            `standalone cleanup exceeded ${MAX_AMBIGUOUS_SESSION_RESTARTS} fresh-session rediscovery attempts`,
          );
        }
        // The command may have reached Bridge even though no explicit result
        // came back. Never issue another command on that poisoned session.
        // After a bounded settle delay, the next loop iteration creates a new
        // authenticated client and re-discovers exact ownership from durable
        // proofs before deciding whether any further mutation is needed.
        try { client?.close(); } catch { /* already poisoned/closed */ }
        resetInitialAllMailSourceStability();
        ownershipUidProofs.clear();
        emptyScratchProofs.clear();
        consecutiveCleanScans = 0;
        consecutiveEnvironmentCleanScans = 0;
        debug(
          `ambiguous mutation outcome; retrying exact discovery on fresh session ` +
          `${ambiguousSessionRestarts}/${MAX_AMBIGUOUS_SESSION_RESTARTS}`,
        );
        await new Promise((resolveDelay) => setTimeout(resolveDelay, AMBIGUOUS_SESSION_SETTLE_MS));
        checkDeadline();
      }
    }
      checkDeadline();
    },
  );

  // Baseline verification has its own hard wall-clock budget. If any IMAP
  // operation is still in flight when it expires, the same live connection is
  // closed and the durable manifest remains available for a later retry.
  const baselineErrors = await runCleanupDeadlinePhase(
    Date.now() + BRIDGE_BASELINE_VERIFY_MS,
    "baseline verification",
    async () => {
      await refreshCleanupClient();
      return verifyBaseline(manifest.baseline);
    },
  );
  reportPeerBaselineExemptions();
  reportOutOfScopeBaselineDrift();
  for (const baselineError of baselineErrors) errors.push(baselineError);

  if (processGuard.expireIfDue()) {
    throw new DeadlineExceededError("standalone cleanup process");
  }
  client.close();
  if (errors.length) {
    console.error(`Bridge cleanup for ${token} was incomplete:`);
    for (const error of errors) console.error(`  ${error}`);
    terminateCleanup(1);
  }
  if (processGuard.expireIfDue()) {
    throw new DeadlineExceededError("standalone cleanup process finalization");
  }
  // Retire the setup journal while both the exact clone and manifest still
  // exist, so a journal unlink/fsync failure leaves a fully rerunnable recovery
  // pair. Then retire credentials before ownership authority; a later crash can
  // leave only a credential-free orphan manifest, never an untracked clone.
  retireBridgeSetupJournal({
    scopeRoot: authority.scopeRoot,
    token,
    recoveryConfigPath: resolvedConfigPath,
    allowMissing: true,
  });
  // Revalidate clone identity/content at the last responsible moment so an
  // exchanged path is never unlinked.
  retireExactRecoveryClone();
  durableUnlink(manifestPath, "ownership manifest");
  // All terminal artifacts are now durably absent. Disarm the watchdog
  // immediately; later best-effort diagnostics cannot recreate authority.
  processGuard.clear();
  releaseCleanupLease({ requireManualRelease: true });
  if (retainedEmptyFolders.length > 0) {
    try {
      console.warn(
        `Bridge cleanup retained ${retainedEmptyFolders.length} positively-created empty folder(s) for manual deletion; ` +
        `live cleanup never issues IMAP mailbox DELETE: ${retainedEmptyFolders.join(", ")}`,
      );
    } catch {
      // Cleanup is already durably committed; warning output is best-effort.
    }
  }
  try { console.log(`Bridge cleanup for ${token} completed and verified.`); } catch {
    // Cleanup is already durably committed; a closed output stream cannot
    // recreate recovery authority and must not turn success into failure.
  }
} catch (error) {
  try { client?.close(); } catch { /* socket may already be closed */ }
  fail(`Bridge cleanup failed: ${message(error)}`);
}

async function runCleanupDeadlinePhase(deadline, label, operation) {
  let expired = false;
  const guard = {
    deadline,
    label,
    expire() {
      if (expired) return;
      expired = true;
      try { client?.close(); } catch { /* the socket may already be closed */ }
    },
    get expired() { return expired; },
  };
  activeDeadline = guard;
  try {
    return await runObservedDeadlinePhase(operation, {
      deadline,
      label,
      onDeadline: guard.expire,
      onTransition: debugPhaseTransition,
    });
  } finally {
    if (activeDeadline === guard) activeDeadline = undefined;
  }
}

function checkDeadline() {
  const guard = activeDeadline;
  if (!guard) return;
  if (guard.expired || Date.now() >= guard.deadline) {
    guard.expire();
    throw new DeadlineExceededError(guard.label);
  }
}

function reportDeadline(text) {
  try {
    writeSync(2, `Bridge cleanup failed: ${text}; manifest ${manifestPath} was not removed\n`);
  } catch {
    // process termination remains authoritative if stderr is unavailable
  }
}

function rank(path, scratch) {
  if (scratch.has(path)) return 0;
  const normalized = path.trim().toLowerCase();
  const commonIndex = ["inbox", "archive", "drafts", "sent", "spam"].indexOf(normalized);
  if (commonIndex >= 0) return 10 + commonIndex;
  return /^(?:starred|important)$/i.test(path.trim()) ? 30 : 20;
}

function requiresDirectOwnedDelete(path) {
  return /^(?:starred|important)$/i.test(path.trim());
}

function isSelectable(mailbox) {
  return ![...mailbox.flags].some((flag) => flag.toLowerCase() === "\\noselect");
}

function isAllMailMailbox(mailbox) {
  return mailbox?.specialUse?.toLowerCase() === "\\all"
    || /^all mail$/i.test(mailbox?.path?.trim?.() ?? "");
}

/**
 * Mailboxes this run could plausibly have mutated, derived from durable
 * manifest state rather than a hardcoded list so it cannot drift from what the
 * run actually did.
 *
 * The baseline snapshots every selectable mailbox in the account. Against a
 * disposable test account that is exactly right. Against a live personal
 * mailbox it also captures folders the suite never writes to — Spam, unrelated
 * Labels — where Proton's own auto-purge and ordinary mail movement produce
 * baseline discrepancies that are indistinguishable from E2E damage. Each such
 * false failure retains a run that blocks every later run, so the gate reliably
 * fails for reasons that say nothing about mailpouch.
 *
 * Discrepancies inside this scope stay fatal. Outside it they are reported as
 * drift. INBOX and All Mail are always in scope: sends land in INBOX, and All
 * Mail is the virtual union containing everything the run creates.
 */
function mutationScopePaths() {
  const scope = new Set(["INBOX"]);
  for (const path of allMailPaths) scope.add(path);
  for (const proof of manifest.createdMailboxes) scope.add(proof.path);
  for (const proof of manifest.pending) {
    if (typeof proof.folder === "string" && proof.folder) scope.add(proof.folder);
  }
  return scope;
}

/** True when `path` is outside everything this run could have mutated. */
function isOutsideMutationScope(path, scope) {
  if (scope.has(path)) return false;
  // Also match All Mail by name: allMailPaths is populated from a live LIST,
  // and a missed entry would silently demote the virtual union to drift.
  if (isAllMailMailbox({ path })) return false;
  // A token-shaped path is this run's own namespace even if the manifest lost
  // the created-mailbox proof — never treat it as somebody else's folder.
  return !path.includes(manifest.token);
}

function rememberAllMailPaths(mailboxes) {
  for (const mailbox of mailboxes) {
    if (isAllMailMailbox(mailbox)) allMailPaths.add(mailbox.path);
  }
}

function assertMutableMailbox(path) {
  if (allMailPaths.has(path) || /^all mail$/i.test(path.trim())) {
    throw unsafeMailboxMutation(
      `Refusing to use All Mail projection ${path} as an IMAP mutation operand`,
    );
  }
}

function assertSelectedMailbox(path) {
  if (client.mailbox?.path !== path) {
    throw unsafeMailboxMutation(`Mailbox lock selected ${client.mailbox?.path ?? "nothing"}, expected ${path}`);
  }
}

function selectedUidValidity(path) {
  assertSelectedMailbox(path);
  if (client.mailbox.uidValidity === undefined) {
    throw unsafeMailboxMutation(`Mailbox ${path} did not expose UIDVALIDITY`);
  }
  return String(client.mailbox.uidValidity);
}

function assertSelectedMailboxIdentity(path, expectedUidValidity) {
  const observed = selectedUidValidity(path);
  if (observed !== expectedUidValidity) {
    throw unsafeMailboxMutation(
      `Mailbox ${path} UIDVALIDITY changed; expected ${expectedUidValidity}, observed ${observed}`,
    );
  }
}

function unsafeMailboxMutation(text) {
  const error = new Error(text);
  error.code = "MAILPOUCH_E2E_UNSAFE_MAILBOX_MUTATION";
  return error;
}

function isFatalStandaloneCleanupError(error) {
  return isFatalCleanupError(error)
    || error?.code === "MAILPOUCH_E2E_UNSAFE_MAILBOX_MUTATION";
}

function createImapClient() {
  return new ImapFlow({
    host: conn.imapHost,
    port: conn.imapPort ?? 1143,
    secure: false,
    auth: { user: conn.username, pass: conn.password },
    logger: false,
    tls,
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    greetingTimeout: GREETING_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
  });
}

async function refreshCleanupClient() {
  checkDeadline();
  try { client?.close(); } catch { /* the prior session may already be closed */ }
  checkDeadline();
  client = createImapClient();
  await client.connect();
  checkDeadline();
  requireUidPlus("after IMAP reauthentication");
}

function requireUidPlus(context) {
  if (client?.capabilities?.has?.("UIDPLUS")) return;
  try { client?.close(); } catch { /* fail closed below */ }
  throw unsafeMailboxMutation(
    `Bridge cleanup refused ${context}: the authenticated IMAP server did not advertise UIDPLUS`,
  );
}

async function runMutationCommand(label, operation) {
  checkDeadline();
  const phaseDeadline = activeDeadline?.deadline ?? (Date.now() + BRIDGE_MUTATION_COMMAND_MS);
  const deadline = Math.min(phaseDeadline, Date.now() + BRIDGE_MUTATION_COMMAND_MS);
  try {
    const result = await runObservedDeadlinePhase(operation, {
      deadline,
      label,
      // A timeout leaves command success ambiguous. Close the session and fail
      // the whole attempt; never dispatch a second mutation on a poisoned
      // connection. The next explicit recovery re-discovers exact ownership.
      onDeadline: () => {
        try { client?.close(); } catch { /* the socket may already be closed */ }
      },
      onTransition: debugPhaseTransition,
    });
    return requireMutationResult(result, label, {
      connectionUsable: client?.usable === true,
    });
  } catch (error) {
    // A tagged NO with a usable connection is a definite single-UID no-op:
    // nothing was applied, so the session stays healthy and the convergence
    // loop retries after the server settles (Proton refuses moves of
    // freshly-sent Sent messages until its backend catches up).
    if (error instanceof MutationRefusedError) throw error;
    // Once the command callback has been entered, a rejection does not prove
    // whether Bridge applied the mutation before reporting failure. Poison the
    // session and retain the recovery manifest for exact re-discovery.
    try { client?.close(); } catch { /* stop every later client command */ }
    if (isFatalStandaloneCleanupError(error)) throw error;
    throw new MutationOutcomeUnknownError(label);
  }
}

async function exactOwnedRecords(path) {
  checkDeadline();
  const lock = await client.getMailboxLock(path);
  try {
    return await exactOwnedRecordsInSelectedMailbox(path);
  } finally { lock.release(); }
}

async function exactOwnedUidsInSelectedMailbox(path) {
  return (await exactOwnedRecordsInSelectedMailbox(path)).map((record) => record.uid);
}

async function exactOwnedUids(path) {
  return (await exactOwnedRecords(path)).map((record) => record.uid);
}

async function exactOwnedRecordsInSelectedMailbox(path) {
  checkDeadline();
  assertSelectedMailbox(path);
  if (client.mailbox.exists === 0) return [];
  const uidValidity = client.mailbox.uidValidity === undefined
    ? undefined
    : String(client.mailbox.uidValidity);
  const ownershipQuery = buildOwnershipDiscoveryQuery(
    "X-MailPouch-E2E-Run",
    token,
    manifestMessageIds(),
    manifestSubjects(path),
  );
  // Scratch folders additionally enumerate their full contents to tolerate
  // Bridge's delayed custom-header index. Exact fetched authorization remains
  // the only source of destructive authority.
  const discoveryQuery = scratchRe.test(path)
    ? { or: [ownershipQuery, { all: true }] }
    : ownershipQuery;
  const discoveryMatches = await client.search(discoveryQuery, { uid: true });
  checkDeadline();
  assertSelectedMailbox(path);
  const candidates = new Set(Array.isArray(discoveryMatches) ? discoveryMatches : []);
  const priorProof = ownershipUidProofs.get(path);
  if (uidValidity && priorProof?.uidValidity === uidValidity) {
    for (const uid of priorProof.uids) candidates.add(uid);
  }
  if (candidates.size === 0) return [];
  const exact = [];
  for await (const item of client.fetch(
    [...candidates],
    {
      uid: true,
      envelope: true,
      headers: ["X-MailPouch-E2E-Run", "Message-ID", "Subject"],
      ...(manifestNeedsSource() ? { source: true } : {}),
    },
    { uid: true },
  )) {
    checkDeadline();
    assertSelectedMailbox(path);
    const headers = item.headers?.toString("utf8").replace(/\r?\n[ \t]+/g, " ") ?? "";
    const values = headers.split(/\r?\n/)
      .filter((line) => line.toLowerCase().startsWith("x-mailpouch-e2e-run:"))
      .map((line) => line.slice(line.indexOf(":") + 1).trim());
    const messageId = canonicalMessageId(item.envelope?.messageId ?? header(headers, "message-id"));
    const subject = item.envelope?.subject ?? header(headers, "subject") ?? "";
    if (typeof item.uid === "number") {
      const exactHeader = values.length === 1 && values[0] === token;
      const candidate = {
        folder: path,
        uid: item.uid,
        messageId,
        subject,
        source: item.source ? Buffer.from(item.source).toString("utf8") : undefined,
      };
      let manifestOwned = !exactHeader && manifestFinalizedMatches(candidate);
      if (!exactHeader && !manifestOwned) {
        // Persist the stable identity before this UID can be returned to a
        // caller that will MOVE/DELETE it. A crash after promotion can then
        // rediscover every delayed Bridge projection by Message-ID.
        manifestOwned = promoteObservedPending(candidate);
      }
      if (exactHeader || manifestOwned) exact.push({
        uid: item.uid,
        messageId,
        subject,
      });
    }
  }
  checkDeadline();
  assertSelectedMailbox(path);
  if (uidValidity) {
    ownershipUidProofs.set(path, {
      uidValidity,
      uids: new Set(exact.map((record) => record.uid)),
    });
  }
  return exact;
}

async function purgeExactOwned(path) {
  checkDeadline();
  assertMutableMailbox(path);
  const lock = await client.getMailboxLock(path);
  let mutated = false;
  try {
    checkDeadline();
    assertMutableMailbox(path);
    const uidValidity = selectedUidValidity(path);
    const uids = await exactOwnedUidsInSelectedMailbox(path);
    const batch = bridgeMutationUidBatches(uids)[0];
    if (batch) {
      assertSelectedMailboxIdentity(path, uidValidity);
      await runMutationCommand(
        `exact-owned UID DELETE in ${path}`,
        () => {
          requireUidPlus(`before exact-owned UID DELETE in ${path}`);
          return client.messageDelete(batch, { uid: true });
        },
      );
      mutated = true;
      checkDeadline();
    }
    return {
      count: batch?.length ?? 0,
      uids: batch ? [...batch] : [],
      uidValidity,
    };
  } catch (error) {
    if (!mutated || isFatalStandaloneCleanupError(error)) throw error;
    try { client?.close(); } catch { /* do not continue after a post-mutation failure */ }
    throw new MutationOutcomeUnknownError("post-DELETE ownership cleanup");
  } finally {
    try {
      lock.release();
    } catch (error) {
      if (!mutated) throw error;
      try { client?.close(); } catch { /* do not continue after a post-mutation failure */ }
      throw new MutationOutcomeUnknownError("post-DELETE mailbox lock release");
    }
  }
}

async function moveExactOwned(path, trash, { requireDestinationProof = false } = {}) {
  checkDeadline();
  assertMutableMailbox(path);
  assertMutableMailbox(trash);
  const lock = await client.getMailboxLock(path);
  let mutated = false;
  let destinationProof;
  try {
    checkDeadline();
    assertMutableMailbox(path);
    assertMutableMailbox(trash);
    const uidValidity = selectedUidValidity(path);
    const uids = await exactOwnedUidsInSelectedMailbox(path);
    const batch = bridgeMutationUidBatches(uids)[0];
    if (batch) {
      assertSelectedMailboxIdentity(path, uidValidity);
      const result = await runMutationCommand(
        `exact-owned UID MOVE from ${path} to ${trash}`,
        () => {
          requireUidPlus(`before exact-owned UID MOVE from ${path} to ${trash}`);
          return client.messageMove(batch, trash, { uid: true });
        },
      );
      mutated = true;
      checkDeadline();
      const destinationUid = result?.uidMap instanceof Map
        ? result.uidMap.get(batch[0])
        : undefined;
      if (result?.uidValidity !== undefined && Number.isSafeInteger(destinationUid) && destinationUid > 0) {
        destinationProof = {
          uidValidity: String(result.uidValidity),
          uid: destinationUid,
        };
      } else if (requireDestinationProof) {
        try { client?.close(); } catch { /* MOVE may already have applied */ }
        throw new MutationOutcomeUnknownError("post-MOVE UIDPLUS destination proof validation");
      }
      rememberDestinationUids(trash, result);
    }
    return { count: batch?.length ?? 0, destinationProof };
  } catch (error) {
    if (!mutated || isFatalStandaloneCleanupError(error)) throw error;
    try { client?.close(); } catch { /* do not continue after a post-mutation failure */ }
    throw new MutationOutcomeUnknownError("post-MOVE ownership cleanup");
  } finally {
    try {
      lock.release();
    } catch (error) {
      if (!mutated) throw error;
      try { client?.close(); } catch { /* do not continue after a post-mutation failure */ }
      throw new MutationOutcomeUnknownError("post-MOVE mailbox lock release");
    }
  }
}

async function observeRescueMailbox(exists) {
  if (!exists) return { rescueExists: false, rescueOwned: 0, rescueTotal: 0 };
  if (manifest.baseline.mailboxPaths.includes(rescuePath)) {
    throw unsafeMailboxMutation(`All Mail rescue path ${rescuePath} existed in the pre-run baseline`);
  }
  const lock = await client.getMailboxLock(rescuePath);
  try {
    checkDeadline();
    const uidValidity = selectedUidValidity(rescuePath);
    const creationProof = createdMailboxes.get(rescuePath);
    if (creationProof && creationProof !== uidValidity) {
      throw unsafeMailboxMutation(
        `All Mail rescue ${rescuePath} UIDVALIDITY changed from ${creationProof} to ${uidValidity}`,
      );
    }
    const owned = await exactOwnedUidsInSelectedMailbox(rescuePath);
    checkDeadline();
    return {
      rescueExists: true,
      rescueOwned: owned.length,
      rescueTotal: client.mailbox?.exists ?? 0,
      uidValidity,
      creationProof,
    };
  } finally { lock.release(); }
}

function persistRescueLifecyclePhase() {
  const phase = rescueLifecycle.phase;
  if (phase === "idle" || manifest.cleanup?.allMailRescue === phase) return;
  const next = { ...manifest, cleanup: { ...manifest.cleanup, allMailRescue: phase } };
  writeDurableManifest(manifestPath, next);
  manifest = next;
}

function consumeRescueCopyRearm() {
  if (!rescueCopyRearmHash) return;
  const consumed = manifest.cleanup?.rescueRearmConsumedHashes ?? [];
  if (consumed.includes(rescueCopyRearmHash)) {
    throw unsafeMailboxMutation("Rescue COPY rearm nonce was already consumed");
  }
  if (consumed.length >= MAX_RESCUE_REARM_HASHES) {
    throw unsafeMailboxMutation("Rescue COPY rearm replay-barrier limit is exhausted");
  }
  const next = {
    ...manifest,
    cleanup: {
      ...manifest.cleanup,
      allMailRescue: rescueLifecycle.phase,
      rescueRearmConsumedHashes: [...consumed, rescueCopyRearmHash],
    },
  };
  // The replay barrier is durable before COPY dispatch. If the wire outcome is
  // ambiguous, rerunning the same operator command cannot issue it again.
  writeDurableManifest(manifestPath, next);
  manifest = next;
}

function persistRescueCreationProof(uidValidity) {
  if (manifest.baseline.mailboxPaths.includes(rescuePath)) {
    throw unsafeMailboxMutation(`Refusing to claim baseline mailbox ${rescuePath} as an All Mail rescue`);
  }
  const existing = createdMailboxes.get(rescuePath);
  if (existing && existing !== uidValidity) {
    throw unsafeMailboxMutation(
      `All Mail rescue ${rescuePath} changed UIDVALIDITY from ${existing} to ${uidValidity}`,
    );
  }
  if (existing) return;
  const createdMailboxesNext = [
    ...manifest.createdMailboxes,
    { path: rescuePath, uidValidity },
  ].sort((left, right) => left.path.localeCompare(right.path));
  const next = { ...manifest, createdMailboxes: createdMailboxesNext };
  writeDurableManifest(manifestPath, next);
  manifest = next;
  createdMailboxes.set(rescuePath, uidValidity);
}

async function createProvenRescueMailbox() {
  if (manifest.baseline.mailboxPaths.includes(rescuePath)) {
    throw unsafeMailboxMutation(`Refusing to create baseline-colliding All Mail rescue ${rescuePath}`);
  }

  // CREATE and COPY never share a connection. If CREATE is ambiguous, the
  // already-persisted copy-pending phase prevents every later replay.
  await refreshCleanupClient();
  const result = await runMutationCommand(
    `CREATE exact-token All Mail rescue ${rescuePath}`,
    () => client.mailboxCreate(rescuePath),
  );
  if (result?.created !== true || result.path !== rescuePath) {
    try { client?.close(); } catch { /* do not reuse an uncertain CREATE session */ }
    throw unsafeMailboxMutation(`All Mail rescue CREATE did not positively create ${rescuePath}`);
  }

  await refreshCleanupClient();
  const observation = await mailboxIdentityAndCount(rescuePath);
  if (observation.count !== 0) {
    throw unsafeMailboxMutation(`New All Mail rescue ${rescuePath} was not empty`);
  }
  // The identity-bound creation proof is durable before COPY can be issued.
  persistRescueCreationProof(observation.uidValidity);
}

async function copyOneExactOwnedFromAllMail(sourcePath, expectedIdentity) {
  if (!allMailPaths.has(sourcePath) && !/^all mail$/i.test(sourcePath.trim())) {
    throw unsafeMailboxMutation(`Refusing All Mail rescue COPY from non-All-Mail path ${sourcePath}`);
  }
  const rescueUidValidity = createdMailboxes.get(rescuePath);
  if (!rescueUidValidity) {
    throw unsafeMailboxMutation(`All Mail rescue ${rescuePath} has no durable creation proof`);
  }

  // COPY gets its own fresh authenticated session, selected source lock, fresh
  // exact ownership proof, and singleton operand. MOVE/DELETE are forbidden.
  await refreshCleanupClient();
  const lock = await client.getMailboxLock(sourcePath);
  let copied = false;
  try {
    checkDeadline();
    assertSelectedMailbox(sourcePath);
    const sourceUidValidity = selectedUidValidity(sourcePath);
    const records = await exactOwnedRecordsInSelectedMailbox(sourcePath);
    const matches = records.filter((record) => allMailRecordIdentity(record) === expectedIdentity);
    if (matches.length > 1) {
      throw unsafeMailboxMutation(
        `All Mail rescue source identity ${expectedIdentity} is not unique in ${sourcePath}`,
      );
    }
    const batch = matches.length === 1 ? [matches[0].uid] : undefined;
    if (!batch) return false;
    assertSelectedMailboxIdentity(sourcePath, sourceUidValidity);
    const result = await runMutationCommand(
      `singleton exact-owned UID COPY from ${sourcePath} to ${rescuePath}`,
      () => {
        requireUidPlus(`before singleton exact-owned UID COPY from ${sourcePath}`);
        return client.messageCopy(batch, rescuePath, { uid: true });
      },
    );
    copied = true;
    const destinationUid = result?.uidMap instanceof Map
      ? result.uidMap.get(batch[0])
      : undefined;
    if (String(result?.uidValidity ?? "") !== rescueUidValidity
      || !Number.isSafeInteger(destinationUid)
      || destinationUid < 1) {
      try { client?.close(); } catch { /* COPY may already have applied */ }
      throw new MutationOutcomeUnknownError("post-COPY UIDPLUS rescue mapping validation");
    }
    rememberDestinationUids(rescuePath, result);
    return true;
  } catch (error) {
    if (!copied || isFatalStandaloneCleanupError(error)) throw error;
    try { client?.close(); } catch { /* COPY may already have applied */ }
    throw new MutationOutcomeUnknownError("post-COPY All Mail rescue cleanup");
  } finally {
    try {
      lock.release();
    } catch (error) {
      if (!copied) throw error;
      try { client?.close(); } catch { /* do not reuse post-COPY session */ }
      throw new MutationOutcomeUnknownError("post-COPY All Mail mailbox lock release");
    }
  }
}

async function reconcileAllMailRescue(allMailMailboxes, rescueExists, trash) {
  const sources = [];
  let allMailOwned = 0;
  const allMailOwnedIdentities = [];
  for (const mailbox of [...allMailMailboxes].sort((left, right) => left.path.localeCompare(right.path))) {
    const records = await exactOwnedRecords(mailbox.path);
    const identified = records.map((record) => ({
      ...record,
      identity: allMailRecordIdentity(record),
    }));
    if (identified.some((record) => record.identity === undefined)) {
      throw unsafeMailboxMutation(
        `All Mail rescue requires a canonical Message-ID for every exact-owned record in ${mailbox.path}`,
      );
    }
    if (identified.length > 0) sources.push({ path: mailbox.path, records: identified });
    allMailOwned += identified.length;
    allMailOwnedIdentities.push(...identified.map((record) => record.identity));
  }
  updateInitialAllMailSourceStability(rescueExists, allMailOwnedIdentities);
  const rescue = await observeRescueMailbox(rescueExists);
  if (allMailOwned > 0 || rescue.rescueOwned > 0 || !rescue.rescueExists) {
    rescueReadyToComplete = false;
  }
  // A crash can land after the UIDVALIDITY-bound creation proof is durable but
  // before the following phase write. That proof is sufficient to finish only
  // the CREATE transition; it does not grant authority to issue or replay COPY.
  if ((rescueLifecycle.phase === "idle" || rescueLifecycle.phase === "create-pending")
    && rescue.creationProof) {
    markRescueCreated(rescueLifecycle);
    persistRescueLifecyclePhase();
  }
  const operatorRearmWasArmed = rescueLifecycle.operatorRetryPermitted;
  const plan = planRescueRound(rescueLifecycle, {
    rescueExists: rescue.rescueExists,
    rescueOwned: rescue.rescueOwned,
    rescueTotal: rescue.rescueTotal,
    allMailOwned,
    allMailOwnedIdentities,
  });
  if (plan.phaseChanged) persistRescueLifecyclePhase();

  if (plan.action === "stage" || plan.action === "retry-stage" || plan.action === "stage-existing") {
    const stageIdentity = rescueLifecycle.lastStagedIdentity;
    const source = sources.find(({ records }) => (
      records.some((record) => record.identity === stageIdentity)
    ));
    if (!source) throw unsafeMailboxMutation("All Mail rescue planner selected COPY without an exact-owned source");
    if (plan.action === "stage" || plan.action === "retry-stage") {
      if (plan.action === "retry-stage") consumeRescueCopyRearm();
      await createProvenRescueMailbox();
      markRescueCreated(rescueLifecycle);
      persistRescueLifecyclePhase();
    } else if (!rescue.creationProof) {
      if (rescueLifecycle.phase !== "create-pending" || !operatorRearmWasArmed) {
        throw unsafeMailboxMutation(`Existing All Mail rescue ${rescuePath} has no durable creation proof`);
      }
      // Two fresh empty observations plus an exact nonce authorize adoption of
      // only this baseline-absent token path and its currently selected identity.
      consumeRescueCopyRearm();
      persistRescueCreationProof(rescue.uidValidity);
      markRescueCreated(rescueLifecycle);
      persistRescueLifecyclePhase();
    } else if (rescueLifecycle.phase === "create-pending") {
      markRescueCreated(rescueLifecycle);
      persistRescueLifecyclePhase();
    }
    if (plan.action === "stage-existing"
      && operatorRearmWasArmed
      && !manifest.cleanup?.rescueRearmConsumedHashes?.includes(rescueCopyRearmHash)) {
      consumeRescueCopyRearm();
    }
    const copied = await copyOneExactOwnedFromAllMail(source.path, stageIdentity);
    return { mutated: copied, drained: false, staged: copied };
  }

  if (plan.action === "drain") {
    if (!rescue.creationProof) {
      throw unsafeMailboxMutation(`All Mail rescue ${rescuePath} payload has no durable creation proof`);
    }
    const moved = await moveExactOwned(rescuePath, trash, { requireDestinationProof: true });
    return {
      mutated: moved.count > 0,
      drained: moved.count > 0,
      staged: false,
      trashCheckpoint: moved.destinationProof,
    };
  }

  if (plan.action === "retain") {
    if (!rescue.creationProof) {
      throw unsafeMailboxMutation(`Empty All Mail rescue ${rescuePath} has no durable creation proof`);
    }
    // Completion becomes durable only after the outer loop also observes two
    // comprehensive clean audits with no unresolved pending delivery proof.
    rescueReadyToComplete = manifest.pending.length === 0;
  }
  return { mutated: false, drained: false, staged: false };
}

function updateInitialAllMailSourceStability(rescueExists, identities) {
  if (rescueExists || rescueLifecycle.phase !== "idle" || identities.length === 0) {
    initialAllMailSourceObservation = undefined;
    return;
  }
  const signature = JSON.stringify([...identities].sort());
  const now = Date.now();
  if (initialAllMailSourceObservation?.signature !== signature) {
    initialAllMailSourceObservation = { signature, firstSeenAt: now, observations: 1 };
    return;
  }
  initialAllMailSourceObservation.observations += 1;
  if (initialAllMailSourceObservation.observations >= 2
    && now - initialAllMailSourceObservation.firstSeenAt >= BRIDGE_ALL_MAIL_RESCUE_STABILITY_MS) {
    permitInitialRescueStage(rescueLifecycle);
  }
}

function resetInitialAllMailSourceStability() {
  initialAllMailSourceObservation = undefined;
  rescueReadyToComplete = false;
}

function rememberDestinationUids(path, result) {
  if (!result || result.uidValidity === undefined || !result.uidMap?.size) return;
  const uidValidity = String(result.uidValidity);
  const existing = ownershipUidProofs.get(path);
  const uids = existing?.uidValidity === uidValidity ? new Set(existing.uids) : new Set();
  for (const uid of result.uidMap.values()) uids.add(uid);
  ownershipUidProofs.set(path, { uidValidity, uids });
}

async function mailboxIdentityAndCount(path) {
  checkDeadline();
  const lock = await client.getMailboxLock(path);
  try {
    checkDeadline();
    assertSelectedMailbox(path);
    if (client.mailbox.uidValidity === undefined) {
      throw unsafeMailboxMutation(`Mailbox ${path} did not expose UIDVALIDITY`);
    }
    return {
      count: client.mailbox.exists ?? 0,
      uidValidity: String(client.mailbox.uidValidity),
    };
  }
  finally { lock.release(); }
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}

function header(headers, name) {
  const prefix = `${name.toLowerCase()}:`;
  const values = headers.split(/\r?\n/)
    .filter((line) => line.toLowerCase().startsWith(prefix))
    .map((line) => line.slice(line.indexOf(":") + 1).trim());
  return values.length === 1 ? values[0] : undefined;
}

function canonicalMessageId(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (/\r|\n|\s/.test(trimmed)) return undefined;
  const unwrapped = trimmed.startsWith("<") && trimmed.endsWith(">") ? trimmed.slice(1, -1) : trimmed;
  if (!unwrapped || !unwrapped.includes("@") || /[<>]/.test(unwrapped)) return undefined;
  return unwrapped;
}

function allMailRecordIdentity(record) {
  return record?.messageId ? `message-id:${record.messageId}` : undefined;
}

function safeText(value, name) {
  if (typeof value !== "string" || value.length === 0 || value.length > 998 || /[\r\n\0]/.test(value)) {
    throw new Error(`Invalid E2E ownership ${name}`);
  }
  return value;
}

function safeUidValidity(value) {
  const text = safeText(value, "UIDVALIDITY");
  if (!/^[1-9][0-9]*$/.test(text) || BigInt(text) > 0xffff_ffffn) {
    throw new Error("invalid ownership UIDVALIDITY");
  }
  return text;
}

function safeSubject(value, requireToken = true, expectedToken = token) {
  const subject = safeText(value, "subject");
  if (requireToken && !subject.includes(expectedToken)) {
    throw new Error(`E2E ownership subject does not contain run token ${expectedToken}`);
  }
  return subject;
}

function safeBodyToken(value, expectedToken = token) {
  if (value === undefined) return undefined;
  if (value !== expectedToken) throw new Error("E2E ownership body proof must equal the exact run token");
  return value;
}

function parseManifest(raw, expectedToken = token) {
  if (!raw || typeof raw !== "object" || raw.token !== expectedToken) throw new Error("manifest token mismatch");
  if (raw.version !== 2 || !Array.isArray(raw.pending) || !Array.isArray(raw.proofs)) {
    throw new Error("unsupported manifest version or shape");
  }

  const pendingIds = new Set();
  const pending = raw.pending.map((value) => {
    if (!value || typeof value !== "object" || typeof value.id !== "string"
      || !/^pending-[0-9a-f-]{36}$/.test(value.id) || pendingIds.has(value.id)) {
      throw new Error("invalid or duplicate pending ownership proof ID");
    }
    pendingIds.add(value.id);
    if (value.kind === "pending-sent") {
      const bodyToken = safeBodyToken(value.bodyToken, expectedToken);
      const subject = safeSubject(value.subject, false, expectedToken);
      if (!subject.includes(expectedToken) && bodyToken !== expectedToken) {
        throw new Error("pending sent proof is not constrained by the run token");
      }
      return { id: value.id, kind: value.kind, subject, ...(bodyToken ? { bodyToken } : {}) };
    }
    if (value.kind === "pending-draft") {
      return {
        id: value.id,
        kind: value.kind,
        folder: safeText(value.folder, "folder"),
        subject: safeSubject(value.subject, true, expectedToken),
      };
    }
    throw new Error("unknown pending ownership proof kind");
  });

  const proofs = raw.proofs.map((value) => {
    if (!value || typeof value !== "object") throw new Error("invalid ownership proof");
    if (value.kind === "message-id") {
      const messageId = canonicalMessageId(value.messageId);
      if (!messageId) throw new Error("invalid Message-ID ownership proof");
      const bodyToken = safeBodyToken(value.bodyToken, expectedToken);
      const subject = safeSubject(value.subject, false, expectedToken);
      if (!subject.includes(expectedToken) && bodyToken !== expectedToken) {
        throw new Error("Message-ID proof is not constrained by the run token");
      }
      return { kind: value.kind, messageId, subject, ...(bodyToken ? { bodyToken } : {}) };
    }
    throw new Error("unknown ownership proof kind");
  });
  const rawHeaderMessageIds = raw.headerMessageIds ?? [];
  if (!Array.isArray(rawHeaderMessageIds)) throw new Error("invalid header Message-ID hints");
  const headerMessageIds = rawHeaderMessageIds.map((value) => {
    const messageId = canonicalMessageId(value);
    if (!messageId) throw new Error("invalid header Message-ID hint");
    return messageId;
  });
  const rawCreatedMailboxes = raw.createdMailboxes ?? [];
  if (!Array.isArray(rawCreatedMailboxes)) throw new Error("invalid created mailbox proofs");
  const createdMailboxes = [];
  for (const value of rawCreatedMailboxes) {
    // Path-only WIP claims remain valid for exact message discovery but never
    // authorize folder deletion after a crash.
    if (typeof value === "string") {
      safeText(value, "created mailbox path");
      continue;
    }
    if (!value || typeof value !== "object") throw new Error("invalid created mailbox proof");
    createdMailboxes.push({
      path: safeText(value.path, "created mailbox path"),
      uidValidity: safeUidValidity(value.uidValidity),
    });
  }
  if (new Set(createdMailboxes.map((proof) => proof.path)).size !== createdMailboxes.length) {
    throw new Error("duplicate created mailbox path proof");
  }
  return {
    version: 2,
    token: expectedToken,
    pending,
    proofs,
    headerMessageIds: [...new Set(headerMessageIds)],
    createdMailboxes,
    ...(raw.baseline === undefined ? {} : { baseline: parseBaseline(raw.baseline) }),
    ...(raw.cleanup === undefined ? {} : { cleanup: parseCleanup(raw.cleanup) }),
  };
}

function parseCleanup(value) {
  if (!value || typeof value !== "object") throw new Error("invalid ownership cleanup state");
  const phase = value.allMailRescue;
  if (phase !== "create-pending" && phase !== "copy-pending"
    && phase !== "payload-observed" && phase !== "complete") {
    throw new Error("invalid All Mail rescue phase");
  }
  const consumed = value.rescueRearmConsumedHashes;
  if (consumed !== undefined && (!Array.isArray(consumed)
    || consumed.length > MAX_RESCUE_REARM_HASHES
    || consumed.some((hash) => typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash))
    || new Set(consumed).size !== consumed.length)) {
    throw new Error("invalid rescue rearm replay barriers");
  }
  return {
    allMailRescue: phase,
    ...(consumed === undefined ? {} : { rescueRearmConsumedHashes: [...consumed] }),
  };
}

function parseBaseline(value) {
  if (!value || typeof value !== "object" || value.algorithm !== "sha256"
    || !Array.isArray(value.mailboxPaths) || !Array.isArray(value.mailboxes)) {
    throw new Error("invalid ownership baseline shape");
  }
  const mailboxPaths = value.mailboxPaths.map((path) => safeText(path, "baseline mailbox path"));
  if (new Set(mailboxPaths).size !== mailboxPaths.length) throw new Error("duplicate baseline mailbox path");
  const pathSet = new Set(mailboxPaths);
  const seen = new Set();
  const mailboxes = value.mailboxes.map((rawMailbox) => {
    if (!rawMailbox || typeof rawMailbox !== "object") throw new Error("invalid baseline mailbox");
    const path = safeText(rawMailbox.path, "baseline mailbox path");
    if (!pathSet.has(path) || seen.has(path)) throw new Error("invalid or duplicate baseline mailbox path");
    seen.add(path);
    const uidValidity = safeUidValidity(rawMailbox.uidValidity);
    if (!Array.isArray(rawMailbox.messages)) throw new Error("invalid baseline messages");
    const uids = new Set();
    const messages = rawMailbox.messages.map((rawMessage) => {
      if (!rawMessage || typeof rawMessage !== "object" || !Number.isSafeInteger(rawMessage.uid)
        || rawMessage.uid < 1 || uids.has(rawMessage.uid) || !Array.isArray(rawMessage.flags)) {
        throw new Error("invalid or duplicate baseline message UID");
      }
      uids.add(rawMessage.uid);
      const flags = rawMessage.flags.map((flag) => safeText(flag, "baseline flag")).sort();
      if (rawMessage.messageIdHash !== undefined
        && (typeof rawMessage.messageIdHash !== "string" || !/^[0-9a-f]{64}$/.test(rawMessage.messageIdHash))) {
        throw new Error("invalid baseline Message-ID hash");
      }
      return {
        uid: rawMessage.uid,
        flags,
        ...(typeof rawMessage.messageIdHash === "string" ? { messageIdHash: rawMessage.messageIdHash } : {}),
      };
    });
    return { path, uidValidity, messages };
  });
  return { algorithm: "sha256", mailboxPaths, mailboxes };
}

function loadRecoveryPeerProofOwners(value, appendHashValue) {
  if ((value === undefined || value === "")
    && (appendHashValue === undefined || appendHashValue === "")) return new Map();
  if (value === undefined || value === "") {
    throw new Error("append-origin recovery requires exact recovery peer tokens");
  }
  const peerTokens = value.split(",");
  if (peerTokens.length > 100) throw new Error("too many recovery peer tokens");
  const seen = new Set();
  const peerManifests = new Map();
  const owners = new Map();
  for (const peerToken of peerTokens) {
    if (!tokenRe.test(peerToken)) {
      throw new Error(`invalid exact recovery peer token ${JSON.stringify(peerToken)}`);
    }
    if (peerToken === token) throw new Error("the active run token cannot be its own recovery peer");
    if (seen.has(peerToken)) throw new Error(`duplicate recovery peer token ${peerToken}`);
    seen.add(peerToken);
    const expectedName = `bridge-run-${peerToken}.json`;
    const peerPath = resolve(manifestRoot, expectedName);
    if (dirname(peerPath) !== manifestRoot || basename(peerPath) !== expectedName) {
      throw new Error(`recovery peer path did not resolve exactly for ${peerToken}`);
    }
    if (!existsSync(peerPath)) {
      throw new Error(`required recovery peer manifest is missing at ${peerPath}`);
    }
    let peerManifest;
    try {
      const rawPeerManifest = JSON.parse(readFileSync(peerPath, "utf8"));
      peerManifest = parseManifest(rawPeerManifest, peerToken);
      if (!peerManifest.baseline) throw new Error("v2 manifest is missing its durable mailbox baseline");
    } catch (error) {
      throw new Error(`invalid recovery peer manifest ${peerPath}: ${message(error)}`);
    }
    peerManifests.set(peerToken, peerManifest);
    const addAuthority = (proofHash, origin) => {
      const authority = owners.get(proofHash) ?? {
        finalized: new Set(),
        appendOrigin: new Set(),
        appendMessageIds: new Set(),
      };
      authority[origin].add(peerToken);
      owners.set(proofHash, authority);
    };

    // Finalized Message-ID proofs retain their existing recovery authority.
    for (const proof of peerManifest.proofs) {
      if (proof.kind !== "message-id") continue;
      addAuthority(hashMessageId(proof.messageId), "finalized");
    }
  }

  // Header Message-IDs are search hints, not ownership proofs. Historical
  // overlapping runs may nevertheless need one disappeared baseline artifact
  // classified as peer-created. That weaker forensic exception is available
  // only through an explicit exact peer-token:SHA-256 allowlist. The hash must
  // be a unique peer hint, absent from that owner's pre-run baseline, and
  // relevant to this active run's immutable baseline. Merely naming a peer
  // never elevates all of its header hints.
  if (appendHashValue !== undefined && appendHashValue !== "") {
    const entries = appendHashValue.split(",");
    if (entries.length > 100) throw new Error("too many append-origin recovery hashes");
    const requested = new Set();
    const activeBaselineHashes = new Set(
      manifest.baseline.mailboxes.flatMap((mailbox) => mailbox.messages
        .map((entry) => entry.messageIdHash)
        .filter((messageIdHash) => typeof messageIdHash === "string")),
    );
    const hintOwners = new Map();
    for (const [peerToken, peerManifest] of peerManifests) {
      for (const messageId of peerManifest.headerMessageIds) {
        const proofHash = hashMessageId(messageId);
        const matchingOwners = hintOwners.get(proofHash) ?? new Set();
        matchingOwners.add(peerToken);
        hintOwners.set(proofHash, matchingOwners);
      }
    }
    for (const entry of entries) {
      const separator = entry.indexOf(":");
      if (separator < 1 || separator !== entry.lastIndexOf(":")) {
        throw new Error(`invalid append-origin recovery entry ${JSON.stringify(entry)}`);
      }
      const peerToken = entry.slice(0, separator);
      const proofHash = entry.slice(separator + 1);
      if (!tokenRe.test(peerToken) || !/^[0-9a-f]{64}$/.test(proofHash)) {
        throw new Error(`invalid append-origin recovery entry ${JSON.stringify(entry)}`);
      }
      if (!peerManifests.has(peerToken)) {
        throw new Error(`append-origin recovery token ${peerToken} is not an exact supplied peer`);
      }
      const requestKey = `${peerToken}:${proofHash}`;
      if (requested.has(requestKey)) {
        throw new Error(`duplicate append-origin recovery entry ${requestKey}`);
      }
      requested.add(requestKey);
      if (!activeBaselineHashes.has(proofHash)) {
        throw new Error(`append-origin recovery hash ${proofHash} is absent from the active baseline`);
      }
      const matchingOwners = hintOwners.get(proofHash);
      if (!matchingOwners?.has(peerToken)) {
        throw new Error(`append-origin recovery hash ${proofHash} is not an exact header hint for ${peerToken}`);
      }
      if (matchingOwners.size !== 1) {
        throw new Error(`append-origin recovery hash ${proofHash} has ambiguous peer hint owners`);
      }
      const peerManifest = peerManifests.get(peerToken);
      const existedBeforePeer = peerManifest.baseline.mailboxes.some((mailbox) =>
        mailbox.messages.some((entry) => entry.messageIdHash === proofHash));
      if (existedBeforePeer) {
        throw new Error(`append-origin recovery hash ${proofHash} existed in ${peerToken}'s baseline`);
      }
      const matchingMessageIds = peerManifest.headerMessageIds
        .filter((messageId) => hashMessageId(messageId) === proofHash);
      if (matchingMessageIds.length !== 1) {
        throw new Error(`append-origin recovery hash ${proofHash} does not identify one exact peer Message-ID`);
      }
      const authority = owners.get(proofHash) ?? {
        finalized: new Set(),
        appendOrigin: new Set(),
        appendMessageIds: new Set(),
      };
      authority.appendOrigin.add(peerToken);
      authority.appendMessageIds.add(matchingMessageIds[0]);
      owners.set(proofHash, authority);
    }
  }
  return owners;
}

function exemptPeerBaselineDiscrepancy(
  mailboxPath,
  expected,
  detail,
  { allowAppendOrigin = false, livePeerHeader } = {},
) {
  if (typeof expected.messageIdHash !== "string") return false;
  const authority = peerProofOwners.get(expected.messageIdHash);
  if (!authority) return false;
  // Append-origin evidence is weaker than a finalized proof and can classify
  // only true disappearance. Flag-only drift needs the stronger current proof
  // that the surviving same-hash record itself carries the exact peer marker.
  const exactLivePeer = typeof livePeerHeader === "string"
    && authority.appendOrigin.size === 1
    && authority.appendOrigin.has(livePeerHeader);
  const origin = authority.finalized.size > 0
    ? "finalized"
    : exactLivePeer
      ? "live-peer-header"
    : allowAppendOrigin && authority.appendOrigin.size > 0
      ? "append-origin"
      : undefined;
  if (!origin) return false;
  const owners = origin === "finalized" ? authority.finalized : authority.appendOrigin;
  const usageKey = `${mailboxPath}\0${expected.messageIdHash}`;
  if (usedPeerBaselineProofs.has(usageKey)) return false;
  usedPeerBaselineProofs.add(usageKey);
  peerBaselineExemptions.push({
    mailboxPath,
    uid: expected.uid,
    detail,
    owners: [...owners].sort(),
    origin,
  });
  return true;
}

function reportOutOfScopeBaselineDrift() {
  if (outOfScopeBaselineDrift.length === 0) return;
  const byPath = new Map();
  for (const entry of outOfScopeBaselineDrift) {
    byPath.set(entry.path, (byPath.get(entry.path) ?? 0) + 1);
  }
  const paths = [...byPath.entries()].sort(([a], [b]) => a.localeCompare(b));
  process.stdout.write(
    `Baseline drift observed in ${paths.length} mailbox(es) this run never mutated `
      + "— reported, not treated as E2E damage:\n",
  );
  for (const [path, count] of paths) {
    process.stdout.write(`  ${path}: ${count} discrepancy(ies)\n`);
  }
  process.stdout.write(
    "  These mailboxes are outside the run's mutation scope, so the suite cannot have caused this. "
      + "On a live personal account, ordinary mail movement and Proton's own auto-purge produce exactly "
      + "this. Running against a disposable Bridge account removes the ambiguity entirely.\n",
  );
}

function reportPeerBaselineExemptions() {
  if (peerBaselineExemptions.length === 0) return;
  const finalizedOwners = [...new Set(peerBaselineExemptions
    .filter((entry) => entry.origin === "finalized")
    .flatMap((entry) => entry.owners))].sort();
  const appendOriginOwners = [...new Set(peerBaselineExemptions
    .filter((entry) => entry.origin === "append-origin")
    .flatMap((entry) => entry.owners))].sort();
  const livePeerHeaderOwners = [...new Set(peerBaselineExemptions
    .filter((entry) => entry.origin === "live-peer-header")
    .flatMap((entry) => entry.owners))].sort();
  const authorities = [
    ...(finalizedOwners.length > 0
      ? [`finalized Message-ID proofs from ${finalizedOwners.join(", ")}`]
      : []),
    ...(appendOriginOwners.length > 0
      ? [`explicit append-origin evidence from ${appendOriginOwners.join(", ")}`]
      : []),
    ...(livePeerHeaderOwners.length > 0
      ? [`exact live peer headers from ${livePeerHeaderOwners.join(", ")}`]
      : []),
  ];
  try {
    console.warn(
      `Bridge cleanup applied ${peerBaselineExemptions.length} peer baseline exemption(s) ` +
      `backed by ${authorities.join("; ")}.`,
    );
    if (verbose) {
      for (const entry of peerBaselineExemptions) {
        console.warn(
          `[bridge-cleanup] peer exemption mailbox=${JSON.stringify(entry.mailboxPath)} ` +
          `uid=${entry.uid} detail=${JSON.stringify(entry.detail)} ` +
          `authority=${entry.origin} owners=${entry.owners.join(",")}`,
        );
      }
    }
  } catch {
    // Diagnostic output must not change a fully observed baseline result.
  }
}

async function hasAppendMessageIdAtDifferentUid(mailboxPath, expected) {
  if (typeof expected.messageIdHash !== "string") return false;
  const authority = peerProofOwners.get(expected.messageIdHash);
  if (!authority?.appendOrigin.size) return false;
  if (authority.appendMessageIds.size !== 1) {
    throw new Error(
      `${mailboxPath}: append-origin hash ${expected.messageIdHash} has ambiguous Message-ID evidence`,
    );
  }
  assertSelectedMailbox(mailboxPath);
  const [messageId] = authority.appendMessageIds;
  const searchResult = await client.search(
    { header: { "message-id": messageId } },
    { uid: true },
  );
  checkDeadline();
  assertSelectedMailbox(mailboxPath);
  if (!Array.isArray(searchResult)) {
    throw new Error(`${mailboxPath}: Message-ID displacement search returned no explicit result`);
  }
  const candidates = searchResult.filter((uid) =>
    Number.isSafeInteger(uid) && uid > 0 && uid !== expected.uid);
  for (const uidBatch of chunkUids(candidates, BASELINE_FETCH_UID_BATCH_SIZE)) {
    for await (const item of client.fetch(
      uidBatch,
      { uid: true, envelope: true, headers: ["Message-ID"] },
      { uid: true },
    )) {
      checkDeadline();
      const headers = item.headers?.toString("utf8").replace(/\r?\n[ \t]+/g, " ") ?? "";
      const observedMessageId = canonicalMessageId(
        item.envelope?.messageId ?? header(headers, "message-id"),
      );
      if (observedMessageId && hashMessageId(observedMessageId) === expected.messageIdHash) {
        return true;
      }
    }
  }
  checkDeadline();
  assertSelectedMailbox(mailboxPath);
  return false;
}

async function verifyBaseline(baseline) {
  const rawErrors = [];
  const baselineErrors = [];
  checkDeadline();
  const current = await client.list();
  checkDeadline();
  const currentPaths = new Set(current.map((mailbox) => mailbox.path));
  const currentByPath = new Map(current.map((mailbox) => [mailbox.path, mailbox]));
  rememberAllMailPaths(current);
  const scope = mutationScopePaths();
  // Collect first, classify at the end: the message-level checks below push
  // strings from many branches, and re-deriving scope at each push site is how
  // one branch quietly ends up on the wrong side of the boundary.
  const classify = () => {
    for (const entry of rawErrors) {
      if (isOutsideMutationScope(entry.path, scope)) {
        outOfScopeBaselineDrift.push(entry);
      } else {
        baselineErrors.push(entry.message);
      }
    }
  };
  for (const path of baseline.mailboxPaths) {
    checkDeadline();
    if (!currentPaths.has(path)) rawErrors.push({ path, message: `baseline mailbox was removed or renamed: ${path}` });
  }
  for (const mailbox of baseline.mailboxes) {
    checkDeadline();
    if (!currentPaths.has(mailbox.path)) continue;
    try {
      const lock = await client.getMailboxLock(mailbox.path);
      try {
        checkDeadline();
        const virtual = isAllMailMailbox(currentByPath.get(mailbox.path));
        const uidValidity = client.mailbox?.uidValidity === undefined
          ? undefined
          : String(client.mailbox.uidValidity);
        if (!virtual && uidValidity !== mailbox.uidValidity) {
          rawErrors.push({
            path: mailbox.path,
            message: `${mailbox.path}: UIDVALIDITY changed from ${mailbox.uidValidity} to ${uidValidity ?? "(missing)"}`,
          });
          continue;
        }
        const observed = new Map();
        const virtualAvailable = new Map();
        const virtualMessageIdHashes = new Set();
        const virtualCandidatesByHash = new Map();
        const baselineHashCounts = new Map();
        for (const expected of mailbox.messages) {
          if (typeof expected.messageIdHash !== "string") continue;
          baselineHashCounts.set(
            expected.messageIdHash,
            (baselineHashCounts.get(expected.messageIdHash) ?? 0) + 1,
          );
        }
        if (mailbox.messages.length > 0 && client.mailbox?.exists !== 0) {
          const captureRange = async (range, uid) => {
            for await (const item of client.fetch(
              range,
              {
                uid: true,
                flags: true,
                envelope: true,
                headers: ["Message-ID", "X-MailPouch-E2E-Run"],
              },
              { uid },
            )) {
              checkDeadline();
              if (typeof item.uid !== "number") continue;
              const headers = item.headers?.toString("utf8").replace(/\r?\n[ \t]+/g, " ") ?? "";
              const messageId = canonicalMessageId(item.envelope?.messageId ?? header(headers, "message-id"));
              const runHeader = header(headers, "x-mailpouch-e2e-run");
              const flags = [...(item.flags ?? [])]
                .filter((flag) => flag.toLowerCase() !== "\\recent")
                .sort();
              const messageIdHash = messageId ? hashMessageId(messageId) : undefined;
              observed.set(item.uid, {
                flags,
                ...(messageIdHash ? { messageIdHash } : {}),
                ...(runHeader ? { runHeader } : {}),
              });
              if (virtual) {
                const key = `${messageIdHash ? `mid:${messageIdHash}` : `uid:${item.uid}`}|flags:${flags.join(",")}`;
                virtualAvailable.set(key, (virtualAvailable.get(key) ?? 0) + 1);
                if (messageIdHash) {
                  virtualMessageIdHashes.add(messageIdHash);
                  const candidates = virtualCandidatesByHash.get(messageIdHash) ?? [];
                  candidates.push({ uid: item.uid, flags, runHeader });
                  virtualCandidatesByHash.set(messageIdHash, candidates);
                }
              }
            }
          };
          if (virtual) {
            await captureRange("1:*", false);
          } else {
            for (const uidBatch of chunkUids(
              mailbox.messages.map((entry) => entry.uid),
              BASELINE_FETCH_UID_BATCH_SIZE,
            )) {
              checkDeadline();
              await captureRange(uidBatch, true);
            }
          }
        }
        for (const expected of mailbox.messages) {
          checkDeadline();
          if (virtual) {
            const key = `${expected.messageIdHash ? `mid:${expected.messageIdHash}` : `uid:${expected.uid}`}|flags:${expected.flags.join(",")}`;
            const count = virtualAvailable.get(key) ?? 0;
            if (count === 0) {
              const trulyMissing = typeof expected.messageIdHash === "string"
                && !virtualMessageIdHashes.has(expected.messageIdHash);
              const sameHashCandidates = typeof expected.messageIdHash === "string"
                ? (virtualCandidatesByHash.get(expected.messageIdHash) ?? [])
                : [];
              // A virtual UID is unstable, so exact live-header evidence is
              // unambiguous only for one baseline record and one current
              // same-hash projection. Duplicate candidates or expectations
              // remain ordinary baseline drift.
              const livePeerHeader = typeof expected.messageIdHash === "string"
                && baselineHashCounts.get(expected.messageIdHash) === 1
                && sameHashCandidates.length === 1
                ? sameHashCandidates[0].runHeader
                : undefined;
              if (!exemptPeerBaselineDiscrepancy(
                mailbox.path,
                expected,
                "virtual message missing or flags changed",
                { allowAppendOrigin: trulyMissing, livePeerHeader },
              )) {
                rawErrors.push({
                  path: mailbox.path,
                  message: `${mailbox.path}: baseline virtual ${expected.messageIdHash ? "Message-ID hash" : `UID ${expected.uid}`} is missing or its flags changed`,
                });
              }
            } else {
              virtualAvailable.set(key, count - 1);
            }
            continue;
          }
          const actual = observed.get(expected.uid);
          if (!actual) {
            const displaced = await hasAppendMessageIdAtDifferentUid(mailbox.path, expected);
            if (!exemptPeerBaselineDiscrepancy(
              mailbox.path,
              expected,
              "message missing",
              { allowAppendOrigin: !displaced },
            )) {
              rawErrors.push({ path: mailbox.path, message: `${mailbox.path}: baseline UID ${expected.uid} is missing` });
            }
            continue;
          }
          const messageIdChanged = actual.messageIdHash !== expected.messageIdHash;
          const flagsChanged = JSON.stringify(actual.flags) !== JSON.stringify(expected.flags);
          if (messageIdChanged || flagsChanged) {
            const detail = [
              ...(messageIdChanged ? ["Message-ID changed"] : []),
              ...(flagsChanged ? ["flags changed"] : []),
            ].join(" and ");
            if (!exemptPeerBaselineDiscrepancy(
              mailbox.path,
              expected,
              detail,
              {
                livePeerHeader: !messageIdChanged && flagsChanged
                  ? actual.runHeader
                  : undefined,
              },
            )) {
              if (messageIdChanged) {
                rawErrors.push({ path: mailbox.path, message: `${mailbox.path}: baseline UID ${expected.uid} Message-ID changed` });
              }
              if (flagsChanged) {
                rawErrors.push({ path: mailbox.path, message: `${mailbox.path}: baseline UID ${expected.uid} flags changed` });
              }
            }
          }
        }
      } finally { lock.release(); }
    } catch (error) {
      checkDeadline();
      rawErrors.push({ path: mailbox.path, message: `${mailbox.path}: baseline verification failed: ${message(error)}` });
    }
  }
  checkDeadline();
  classify();
  return baselineErrors;
}

function hashMessageId(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function manifestMessageIds() {
  return [...new Set([
    ...manifest.headerMessageIds,
    ...manifest.proofs
      .filter((proof) => proof.kind === "message-id")
      .map((proof) => proof.messageId),
  ])];
}

function manifestSubjects(folder) {
  const subjects = [];
  for (const proof of manifest.pending) {
    if (proof.kind === "pending-sent" || proof.folder === folder) subjects.push(proof.subject);
  }
  return [...new Set(subjects)];
}

function manifestNeedsSource() {
  return manifest.pending.some((proof) => proof.kind === "pending-sent" && proof.bodyToken)
    || manifest.proofs.some((proof) => proof.kind === "message-id" && proof.bodyToken);
}

function pendingMatchesCandidate(proof, candidate) {
  if (proof.kind === "pending-sent") {
    return candidate.subject === proof.subject
      && (!proof.bodyToken || candidate.source?.includes(proof.bodyToken));
  }
  return candidate.folder === proof.folder && candidate.subject === proof.subject;
}

function pendingConstraintKey(proof) {
  return proof.kind === "pending-sent"
    ? JSON.stringify([proof.kind, proof.subject, proof.bodyToken ?? null])
    : JSON.stringify([proof.kind, proof.folder, proof.subject]);
}

function promoteObservedPending(candidate) {
  const messageId = canonicalMessageId(candidate.messageId);
  if (!messageId
    || manifest.headerMessageIds.includes(messageId)
    || manifest.proofs.some((proof) => proof.kind === "message-id" && proof.messageId === messageId)) {
    return false;
  }
  const matching = manifest.pending.filter((proof) => pendingMatchesCandidate(proof, candidate));
  if (matching.length === 0) return false;
  const constraint = pendingConstraintKey(matching[0]);
  if (matching.some((proof) => pendingConstraintKey(proof) !== constraint)) return false;

  const pending = matching[0];
  const proof = {
    kind: "message-id",
    messageId,
    subject: pending.subject,
    ...(pending.kind === "pending-sent" && pending.bodyToken
      ? { bodyToken: pending.bodyToken }
      : {}),
  };
  const next = {
    ...manifest,
    proofs: [...manifest.proofs, proof],
    pending: manifest.pending.filter((item) => item.id !== pending.id),
  };
  writeDurableManifest(manifestPath, next);
  manifest = next;
  return true;
}

function manifestFinalizedMatches(candidate) {
  const candidateId = canonicalMessageId(candidate.messageId);
  for (const proof of manifest.proofs) {
    if (proof.kind === "message-id") {
      if (candidateId === proof.messageId
        && candidate.subject === proof.subject
        && (!proof.bodyToken || candidate.source?.includes(proof.bodyToken))) return true;
    }
  }
  return false;
}

function writeDurableManifest(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, path);
    if (process.platform !== "win32") {
      const dirFd = openSync(dirname(path), "r");
      try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temp); } catch { /* rename or failed create removed it */ }
  }
}

function fsyncParentDirectory(path) {
  if (process.platform === "win32") return;
  const directoryFd = openSync(dirname(path), "r");
  try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
}

function durableUnlink(path, label) {
  try {
    unlinkSync(path);
    fsyncParentDirectory(path);
  } catch (error) {
    throw new Error(`Cleanup succeeded but ${label} retirement failed at ${path}: ${message(error)}`, {
      cause: error,
    });
  }
}

function retireExactRecoveryClone() {
  let current;
  let currentBytes;
  try {
    if (!samePlatformPath(resolvedConfigPath, expectedClonePath)
      || basename(resolvedConfigPath) !== `.mailpouch-e2e-bridge-${token}.json`) {
      throw new Error("recovery clone path no longer matches the exact token-bound path");
    }
    current = lstatSync(resolvedConfigPath, { bigint: true });
    if (!current.isFile() || current.isSymbolicLink()) {
      throw new Error("recovery clone is no longer a regular, non-symlink file");
    }
    if (!samePlatformPath(realpathSync.native(resolvedConfigPath), resolvedConfigPath)
      || samePlatformPath(resolvedConfigPath, authority.authorityConfigPath)) {
      throw new Error("recovery clone now resolves outside its authorized identity");
    }
    currentBytes = readFileSync(resolvedConfigPath);
  } catch (error) {
    throw new Error(`Refusing to retire the recovery clone: ${message(error)}`, { cause: error });
  }
  const currentHash = createHash("sha256").update(currentBytes).digest("hex");
  if (current.dev !== cloneIdentity.dev
    || current.ino !== cloneIdentity.ino
    || currentHash !== cloneIdentity.sha256) {
    throw new Error("Refusing to retire the recovery clone because its file identity or content changed.");
  }

  // Never unlink the public clone path after validating it: another process
  // could exchange that directory entry between the final read and unlink.
  // Atomically move the entry into a fresh private quarantine, then validate
  // the moved inode and bytes again before deleting that unpredictable path.
  // A mismatch is retained with recovery authority intact for inspection.
  const quarantineDirectory = resolve(
    dirname(resolvedConfigPath),
    `.${basename(resolvedConfigPath)}.retiring-${randomUUID()}`,
  );
  const quarantinedPath = resolve(quarantineDirectory, basename(resolvedConfigPath));
  try {
    mkdirSync(quarantineDirectory, { mode: 0o700 });
    fsyncParentDirectory(quarantineDirectory);
    renameSync(resolvedConfigPath, quarantinedPath);
    fsyncParentDirectory(resolvedConfigPath);
    fsyncParentDirectory(quarantinedPath);
  } catch (error) {
    try { rmdirSync(quarantineDirectory); } catch { /* retain any uncertain quarantine */ }
    throw new Error(`Refusing to quarantine the recovery clone before retirement: ${message(error)}`, {
      cause: error,
    });
  }

  let quarantined;
  let quarantinedBytes;
  try {
    quarantined = lstatSync(quarantinedPath, { bigint: true });
    if (!quarantined.isFile() || quarantined.isSymbolicLink()) {
      throw new Error("quarantined recovery clone is not a regular, non-symlink file");
    }
    if (!samePlatformPath(realpathSync.native(quarantinedPath), quarantinedPath)) {
      throw new Error("quarantined recovery clone no longer resolves to itself");
    }
    quarantinedBytes = readFileSync(quarantinedPath);
  } catch (error) {
    throw new Error(
      `Refusing to retire the quarantined recovery clone at ${quarantinedPath}: ${message(error)}`,
      { cause: error },
    );
  }
  const quarantinedHash = createHash("sha256").update(quarantinedBytes).digest("hex");
  if (quarantined.dev !== cloneIdentity.dev
    || quarantined.ino !== cloneIdentity.ino
    || quarantinedHash !== cloneIdentity.sha256) {
    throw new Error(
      `Refusing to retire a substituted recovery clone; the exchanged file is retained at ${quarantinedPath}.`,
    );
  }

  durableUnlink(quarantinedPath, "quarantined exact encrypted recovery clone");
  try {
    rmdirSync(quarantineDirectory);
    fsyncParentDirectory(quarantineDirectory);
  } catch (error) {
    throw new Error(
      `Cleanup removed the encrypted recovery clone but could not retire its empty quarantine ${quarantineDirectory}: ${message(error)}`,
      { cause: error },
    );
  }
}

function samePlatformPath(left, right) {
  if (process.platform === "win32") return left.toLowerCase() === right.toLowerCase();
  return left === right;
}

function fail(text) {
  console.error(text);
  terminateCleanup(1);
}

function releaseCleanupLease({ requireManualRelease = false } = {}) {
  try {
    cleanupLease?.release();
  } catch (error) {
    if (requireManualRelease && cleanupLease?.delegated !== true) {
      throw new Error(`Manual cleanup lease release failed: ${message(error)}`, { cause: error });
    }
    // Failure termination is already preserving the primary error. The lease
    // implementation retains uncertain ownership rather than unlinking a
    // record which may belong to another process.
    return;
  }
  if (requireManualRelease
    && cleanupLease?.delegated !== true
    && cleanupLease?.scope?.leasePath
    && existsSync(cleanupLease.scope.leasePath)) {
    throw new Error(
      `Manual cleanup lease remains at ${cleanupLease.scope.leasePath}; refusing to report cleanup success`,
    );
  }
}

function terminateCleanup(code) {
  releaseCleanupLease();
  process.exit(code);
}

function debug(text) {
  if (verbose) console.error(`[bridge-cleanup] ${text}`);
}

function debugPhaseTransition({ label, state, at, deadline, elapsedMs }) {
  debug(
    `phase=${JSON.stringify(label)} state=${state} at=${new Date(at).toISOString()} ` +
    `deadline=${new Date(deadline).toISOString()} elapsedMs=${elapsedMs}`,
  );
}
