/**
 * Persistence for {@link AgentGrant} records.
 *
 * A single JSON file (`~/.mailpouch-agents.json`) holds every grant the
 * server has ever seen, across all three statuses. Writes are atomic via
 * tmp→rename, consistent with the rest of the project's credential-hygiene
 * story. The file is mode 0600.
 *
 * We deliberately keep this in memory as a Map<clientId, AgentGrant> and
 * flush the whole file on every mutation. n is small (<100 grants even in
 * aggressive use), JSON serialization is tens of μs, and atomic writes
 * eliminate the need for a lockfile.
 */

import { readFileSync, existsSync } from "fs";
import type { AgentGrant, AgentGrantStatus, GrantConditions } from "./types.js";
import type { PermissionPreset, ToolName } from "../config/schema.js";
import { logger } from "../utils/logger.js";
import { notifications } from "./notifications.js";
import { withFileLock } from "../utils/file-lock.js";
import { writeOwnerOnlyJsonAtomically } from "../utils/atomic-json.js";
import {
  HourlyQuotaLedger,
  hourlyQuotaPathForGrantPath,
  type HourlyToolReservation,
} from "./hourly-quota-ledger.js";
import { isValidAgentToolHourlyCap, sanitizeGrantConditions } from "./grant-conditions.js";

export { hourlyQuotaPathForGrantPath, type HourlyToolReservation } from "./hourly-quota-ledger.js";

interface StoreFile {
  version: 1;
  grants: AgentGrant[];
}

/** Fresh, disk-backed authorization view used on every security decision. */
export type AuthorizationGrantSnapshot =
  | { kind: "present"; grant: AgentGrant }
  | { kind: "missing" }
  | { kind: "unavailable" };

/** Historical marker used before AgentGrant gained credentialKind. */
export const LEGACY_SERVICE_ACCOUNT_GRANT_NOTE = "service account (client_credentials)";

/**
 * True only for a credential-backed grant. Interactive OAuth grants must
 * never be inferred from a generic HTTP transport value: they have no service
 * credential to require. The exact old note keeps existing persisted service
 * grants protected until they are next synchronized with the explicit marker.
 */
export function isServiceAccountGrant(grant: AgentGrant): boolean {
  return grant.credentialKind === "service_account"
    || grant.note === LEGACY_SERVICE_ACCOUNT_GRANT_NOTE;
}

export interface CreatePendingArgs {
  clientId: string;
  clientName: string;
  /** IP the agent registered from (for display on the approval card). */
  registeredFromIp?: string;
}

export interface ApproveArgs {
  clientId: string;
  preset: PermissionPreset;
  toolOverrides?: Partial<Record<ToolName, boolean>>;
  conditions?: GrantConditions;
  note?: string;
}

export interface AgentGrantStoreOptions {
  /**
   * Test-only override for the durable rate-quota ledger. Production derives
   * this from the grants path so profile and MAILPOUCH_AGENTS overrides always
   * share the same quota state.
   */
  quotaPath?: string;
}

/**
 * XPORT-021: ceiling on simultaneously-pending (not-yet-reviewed) grants. The
 * DCR endpoint creates a pending grant per registration; a per-IP rate limiter
 * caps the burst but a slow flood could still grow the settings-UI grant list
 * without bound. When the cap is reached we evict the oldest pending grant
 * before admitting a new one, so the review queue stays usefully small.
 */
const MAX_PENDING_GRANTS = 50;
const GRANT_STATUSES = new Set<AgentGrantStatus>(["pending", "active", "revoked", "expired"]);
const GRANT_PRESETS = new Set<PermissionPreset>(["full", "read_only", "supervised", "send_only", "custom"]);

export class AgentGrantStore {
  private grants = new Map<string, AgentGrant>();
  private readonly path: string;
  /** Durable SQLite ledger shared by every daemon using this grants profile. */
  private readonly hourlyQuotaLedger: HourlyQuotaLedger;

  constructor(path: string, options: AgentGrantStoreOptions = {}) {
    this.path = path;
    this.hourlyQuotaLedger = new HourlyQuotaLedger(options.quotaPath ?? hourlyQuotaPathForGrantPath(path));
    this.load();
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      const raw = readFileSync(this.path, "utf-8");
      const parsed = JSON.parse(raw) as Partial<StoreFile>;
      const list = Array.isArray(parsed.grants) ? parsed.grants : [];
      for (const g of list) {
        if (g && typeof g.clientId === "string") {
          this.grants.set(g.clientId, g);
        }
      }
    } catch (err) {
      logger.warn(`AgentGrantStore: failed to parse ${this.path}, starting empty`, "AgentGrantStore", err);
      this.grants.clear();
    }
  }

  /**
   * PERM-006: run a structural mutation under a cross-process advisory lock.
   * Both the MCP server and the settings server hold their own AgentGrantStore
   * instance over the same file; without locking + a reload-merge, one
   * process's whole-file rewrite silently drops grants the other process
   * created or modified. We reload the on-disk state under the lock, MERGE the
   * caller's pending in-memory record set on top (so a fresh local `set` made
   * by `fn` before persist isn't lost), apply `fn`, then persist atomically.
   */
  private mutate<T>(fn: () => T): T {
    return withFileLock(this.path, () => {
      this.reloadMerge();
      return fn();
    });
  }

  /**
   * Reload the file from disk under the lock so on-disk state is authoritative
   * before we mutate + persist. This both recovers grants another process
   * created (the PERM-006 lost-grant case) AND refreshes the *status* of grants
   * we already hold — without this, a grant that process A approved/revoked
   * while we held a stale `pending` copy would be silently reverted by our
   * whole-file `persist()`. The one thing the disk is NOT authoritative for is
   * the call counters (`totalCalls`/`lastCallAt`): `recordCall` bumps those in
   * memory and defers the fsync, so if our in-memory count is ahead we carry it
   * forward onto the disk record rather than losing the unflushed increments.
   */
  private reloadMerge(): void {
    if (!existsSync(this.path)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf-8")) as Partial<StoreFile>;
      const list = Array.isArray(parsed.grants) ? parsed.grants : [];
      const seen = new Set<string>();
      for (const g of list) {
        if (!g || typeof g.clientId !== "string") continue;
        seen.add(g.clientId);
        const mine = this.grants.get(g.clientId);
        if (mine && mine.totalCalls > (g.totalCalls ?? 0)) {
          // Preserve our not-yet-flushed call counters; disk wins for everything else.
          this.grants.set(g.clientId, { ...g, totalCalls: mine.totalCalls, lastCallAt: mine.lastCallAt });
        } else {
          this.grants.set(g.clientId, g);
        }
      }
      // Drop in-memory records that no longer exist on disk (pruned by a peer),
      // but keep any we created this session that haven't been persisted yet
      // (none, given mutate() persists under the lock — defensive only).
      for (const clientId of [...this.grants.keys()]) {
        if (!seen.has(clientId)) this.grants.delete(clientId);
      }
    } catch (err) {
      logger.warn(`AgentGrantStore: reloadMerge failed for ${this.path}`, "AgentGrantStore", err);
    }
  }

  private persist(): void {
    const payload: StoreFile = { version: 1, grants: [...this.grants.values()] };
    writeOwnerOnlyJsonAtomically(this.path, payload);
  }

  /**
   * Record a brand-new DCR client as a pending grant. Called from the OAuth
   * DCR handler; idempotent when the same client_id is registered twice (e.g.
   * an MCP host retrying on a disconnected tunnel).
   */
  createPending(args: CreatePendingArgs): AgentGrant {
    return this.mutate(() => {
      const existing = this.grants.get(args.clientId);
      if (existing) return existing;

      // XPORT-021: bound the pending-review queue. Evict the oldest pending
      // grant(s) (by createdAt) once we'd exceed the cap so a registration
      // flood can't grow the settings-UI list unboundedly.
      const pending = [...this.grants.values()]
        .filter(g => g.status === "pending")
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      for (let i = 0; i <= pending.length - MAX_PENDING_GRANTS; i++) {
        this.grants.delete(pending[i].clientId);
      }

      const grant: AgentGrant = {
        clientId: args.clientId,
        clientName: args.clientName || "(unnamed client)",
        status: "pending",
        preset: "read_only", // placeholder — replaced on approve
        createdAt: new Date().toISOString(),
        totalCalls: 0,
        ...(args.registeredFromIp ? { registeredFromIp: args.registeredFromIp } : {}),
      };
      this.grants.set(args.clientId, grant);
      this.persist();
      notifications.emitGrantChanged("grant-created", grant);
      return grant;
    });
  }

  /**
   * Ensure an *active* grant exists for a service account (client_credentials).
   * Unlike the interactive flow (createPending → approve), a service account is
   * pre-approved out-of-band at issuance, so its grant is born active. Called at
   * startup for each persisted service account; idempotent — refreshes the
   * preset/conditions/name on an existing grant and (re-)activates it, so an
   * operator re-issuing or editing an account converges the grant.
   */
  ensureActiveServiceGrant(args: {
    clientId: string;
    clientName: string;
    preset: PermissionPreset;
    conditions?: GrantConditions;
  }): AgentGrant {
    return this.mutate(() => {
      const now = new Date().toISOString();
      const existing = this.grants.get(args.clientId);
      const grant: AgentGrant = {
        clientId: args.clientId,
        clientName: args.clientName || "(service account)",
        status: "active",
        preset: args.preset,
        conditions: args.conditions,
        createdAt: existing?.createdAt ?? now,
        approvedAt: existing?.approvedAt ?? now,
        totalCalls: existing?.totalCalls ?? 0,
        // Carried forward with totalCalls: this rebuild runs on every
        // client_credentials login, so dropping it reset service accounts to
        // "last used: never" no matter how many calls they had made.
        lastCallAt: existing?.lastCallAt,
        transport: "http",
        credentialKind: "service_account",
        note: LEGACY_SERVICE_ACCOUNT_GRANT_NOTE,
      };
      // No-op re-verify of an already-active service grant: this runs on EVERY
      // client_credentials login, so re-emitting a "grant-approved" event here
      // spammed a notification/toast on each re-auth (e.g. cowork reconnecting).
      // Only notify on a real transition — first creation, or (re)activation of
      // a grant that wasn't already active.
      const wasActive = existing?.status === "active";
      this.grants.set(args.clientId, grant);
      this.persist();
      if (!existing) notifications.emitGrantChanged("grant-created", grant);
      else if (!wasActive) notifications.emitGrantChanged("grant-approved", grant);
      return grant;
    });
  }

  /**
   * Record live connection info captured at the MCP `initialize` handshake onto
   * an existing grant (display-only; does NOT change status or identity). No-op
   * if the clientId has no grant — an unregistered caller is handled by the
   * grant gate, not here.
   */
  recordConnection(
    clientId: string,
    info: { mcpClientName?: string; mcpClientVersion?: string; transport?: "http" | "stdio"; registeredFromIp?: string },
  ): AgentGrant | null {
    return this.mutate(() => {
      const g = this.grants.get(clientId);
      if (!g) return null;
      if (info.mcpClientName) g.mcpClientName = info.mcpClientName;
      if (info.mcpClientVersion) g.mcpClientVersion = info.mcpClientVersion;
      if (info.transport) g.transport = info.transport;
      if (info.registeredFromIp && !g.registeredFromIp) g.registeredFromIp = info.registeredFromIp;
      g.lastConnectedAt = new Date().toISOString();
      this.persist();
      return g;
    });
  }

  approve(args: ApproveArgs): AgentGrant | null {
    return this.mutate(() => {
      const g = this.grants.get(args.clientId);
      if (!g) return null;
      g.status = "active";
      g.preset = args.preset;
      g.toolOverrides = args.toolOverrides;
      g.conditions = sanitizeGrantConditions(args.conditions);
      g.note = args.note;
      g.approvedAt = new Date().toISOString();
      g.revokedAt = undefined;
      this.persist();
      notifications.emitGrantChanged("grant-approved", g);
      return g;
    });
  }

  deny(clientId: string, note?: string): AgentGrant | null {
    return this.mutate(() => {
      const g = this.grants.get(clientId);
      if (!g) return null;
      const wasPending = g.status === "pending";
      g.status = "revoked";
      g.revokedAt = new Date().toISOString();
      g.note = note ?? g.note;
      this.persist();
      // Distinguish "deny" (never-approved pending grant rejected) from
      // "revoke" (previously-approved grant taken back) for UI filtering.
      notifications.emitGrantChanged(wasPending ? "grant-denied" : "grant-revoked", g);
      return g;
    });
  }

  revoke(clientId: string): AgentGrant | null {
    return this.deny(clientId);
  }

  /**
   * Mark a grant as expired in-place. Called by the gate when it observes
   * expiresAt has passed; atomic so concurrent tool calls agree on the state.
   */
  markExpired(clientId: string): AgentGrant | null {
    return this.mutate(() => {
      const g = this.grants.get(clientId);
      if (!g) return null;
      if (g.status === "expired") return g;
      g.status = "expired";
      this.persist();
      notifications.emitGrantChanged("grant-expired", g);
      return g;
    });
  }

  /**
   * Delete pending grants whose approval window (`maxAgeMs` since createdAt) has
   * elapsed — the auth request expires if the user doesn't approve in time, so
   * the agent must connect/auth again. Emits `grant-expired` for each (which
   * revokes any issued token) and removes the record. Returns the count expired.
   */
  expireStalePending(maxAgeMs: number): number {
    return this.mutate(() => {
      const now = Date.now();
      const stale = [...this.grants.values()].filter(
        (g) => g.status === "pending" && now - Date.parse(g.createdAt) > maxAgeMs,
      );
      if (stale.length === 0) return 0;
      for (const g of stale) this.grants.delete(g.clientId);
      this.persist();
      // Emit after the delete + persist so token revocation (the grant-expired
      // subscriber) acts on the now-removed grant's clientId.
      for (const g of stale) notifications.emitGrantChanged("grant-expired", g);
      return stale.length;
    });
  }

  /** Record a successful tool call against the grant's counters. */
  recordCall(clientId: string): void {
    const g = this.grants.get(clientId);
    if (!g) return;
    g.lastCallAt = new Date().toISOString();
    g.totalCalls += 1;
    // Only persist periodically-ish to avoid fsync on every single tool
    // call. We flush on every mutation anyway when the grant *changes*;
    // this method deliberately does NOT persist so hot paths stay cheap.
    // PERM-010: index.ts now calls flushCounters() on a 5-minute interval and
    // again in gracefulShutdown, so these in-memory increments survive restart.
  }

  /**
   * Reserve one slot in a client's canonical-tool rolling hourly budget.
   *
   * The ledger uses a shared SQLite `BEGIN IMMEDIATE` transaction for prune →
   * count → insert, so separate processes cannot admit the same final slot.
   * Callers must invoke it immediately before dispatching the handler; started
   * calls retain their reservation even when the handler later fails.
   *
   * `limit === 0` is an explicit deny-all cap.  `undefined` means no cap and
   * is handled by GrantManager before it calls this method.
   */
  reserveHourlyToolCall(
    clientId: string,
    canonicalTool: string,
    limit: number,
    now = Date.now(),
  ): HourlyToolReservation {
    return this.hourlyQuotaLedger.reserve(clientId, canonicalTool, limit, now);
  }

  /** Close the durable quota connection without deleting or checkpointing it. */
  close(): void {
    this.hourlyQuotaLedger.close();
  }

  /** Force-flush any in-memory call-count updates to disk. */
  flushCounters(): void {
    // Go through mutate() so we reload + reconcile on-disk status first; a bare
    // persist() here would blind-write our whole map and could revert a status
    // change a peer process made (the same hazard reloadMerge guards against).
    this.mutate(() => this.persist());
  }

  get(clientId: string): AgentGrant | undefined {
    return this.grants.get(clientId);
  }

  /**
   * Read one authorization grant directly from durable storage.
   *
   * The in-memory map remains useful for settings/UI counters and local
   * mutations, but it is deliberately NOT an authorization cache: another
   * process can revoke a grant while this daemon is running. Atomic writes
  * guarantee this observes either the prior complete file or the new complete
  * file. Any unreadable or structurally corrupt state is unavailable rather
  * than being mistaken for an empty/unrestricted grant.
  */
  getAuthorizationSnapshot(clientId: string): AuthorizationGrantSnapshot {
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf-8")) as Partial<StoreFile>;
      if (parsed.version !== 1 || !Array.isArray(parsed.grants) || !parsed.grants.every(isValidAuthorizationGrant)) {
        logger.warn("AgentGrantStore: authorization snapshot is malformed; denying access", "AgentGrantStore");
        return { kind: "unavailable" };
      }
      const clientIds = new Set<string>();
      for (const entry of parsed.grants) {
        if (clientIds.has(entry.clientId)) {
          logger.warn("AgentGrantStore: authorization snapshot has duplicate client IDs; denying access", "AgentGrantStore");
          return { kind: "unavailable" };
        }
        clientIds.add(entry.clientId);
      }
      const grant = parsed.grants.find(g => g.clientId === clientId);
      return grant ? { kind: "present", grant } : { kind: "missing" };
    } catch (err) {
      // Do not preflight with existsSync(): it can report false for an
      // inaccessible path, which would incorrectly turn a read failure into
      // a definitive "missing" grant and cause the HTTP layer to purge a
      // still-valid cached bearer. Only an actual ENOENT is absence.
      if (isNoEntryError(err)) return { kind: "missing" };
      logger.warn("AgentGrantStore: authorization snapshot could not be read; denying access", "AgentGrantStore", err);
      return { kind: "unavailable" };
    }
  }

  list(filter?: { status?: AgentGrantStatus }): AgentGrant[] {
    const rows = [...this.grants.values()];
    if (filter?.status) return rows.filter(g => g.status === filter.status);
    return rows;
  }

  /**
   * The grants {@link prune} would drop. Exposed so a caller can preview the
   * removal (`agent prune --dry-run`) against the same predicate that performs
   * it — a second copy of this rule silently drifts from the real one.
   */
  listPrunable(retainDays = 90, now = Date.now()): AgentGrant[] {
    const cutoff = now - retainDays * 24 * 60 * 60_000;
    return [...this.grants.values()].filter(g => {
      if (g.status !== "revoked" && g.status !== "expired") return false;
      const endAt = g.revokedAt ?? g.approvedAt ?? g.createdAt;
      // Inclusive: retainDays=0 means "everything already revoked", which is
      // otherwise a coin flip against a same-millisecond cutoff.
      return Date.parse(endAt) <= cutoff;
    });
  }

  /** Drop revoked/expired grants older than `retainDays` days. */
  prune(retainDays = 90, now = Date.now()): number {
    return this.mutate(() => {
      const doomed = this.listPrunable(retainDays, now);
      for (const g of doomed) this.grants.delete(g.clientId);
      if (doomed.length > 0) this.persist();
      return doomed.length;
    });
  }
}

/** True when a durable grant's status or expiry condition has elapsed. */
export function grantHasExpired(grant: AgentGrant, now = Date.now()): boolean {
  if (grant.status === "expired") return true;
  const expiresAt = grant.conditions?.expiresAt;
  if (!expiresAt) return false;
  const expiryMs = Date.parse(expiresAt);
  return Number.isFinite(expiryMs) && expiryMs <= now;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNoEntryError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

/** Validate enough persisted shape to never turn corrupted records into access. */
function isValidAuthorizationGrant(value: unknown): value is AgentGrant {
  if (!isRecord(value)) return false;
  if (typeof value.clientId !== "string" || !value.clientId) return false;
  if (typeof value.clientName !== "string") return false;
  if (typeof value.status !== "string" || !GRANT_STATUSES.has(value.status as AgentGrantStatus)) return false;
  if (typeof value.preset !== "string" || !GRANT_PRESETS.has(value.preset as PermissionPreset)) return false;
  if (typeof value.createdAt !== "string" || !value.createdAt) return false;
  if (typeof value.totalCalls !== "number" || !Number.isSafeInteger(value.totalCalls) || value.totalCalls < 0) return false;
  if (!optionalString(value.approvedAt) || !optionalString(value.revokedAt) || !optionalString(value.lastCallAt)
    || !optionalString(value.note) || !optionalString(value.registeredFromIp)
    || !optionalString(value.mcpClientName) || !optionalString(value.mcpClientVersion)
    || !optionalString(value.lastConnectedAt)) return false;
  if (value.transport !== undefined && value.transport !== "http" && value.transport !== "stdio") return false;
  if (value.credentialKind !== undefined && value.credentialKind !== "service_account") return false;
  if (!validToolOverrides(value.toolOverrides) || !validConditions(value.conditions)) return false;
  return true;
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function validToolOverrides(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return Object.values(value).every(override => typeof override === "boolean");
}

function validConditions(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  if (value.expiresAt !== undefined && (typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt)))) return false;
  if (value.accountId !== undefined && typeof value.accountId !== "string") return false;
  if (value.accountIdentity !== undefined && (typeof value.accountIdentity !== "string" || !/^[a-f0-9]{64}$/i.test(value.accountIdentity))) return false;
  if (value.accountIdentity !== undefined && value.accountId === undefined) return false;
  if (value.folderAllowlist !== undefined && (!Array.isArray(value.folderAllowlist) || !value.folderAllowlist.every(folder => typeof folder === "string"))) return false;
  if (value.ipPins !== undefined && (!Array.isArray(value.ipPins) || !value.ipPins.every(ip => typeof ip === "string"))) return false;
  if (value.maxCallsPerHourByTool !== undefined) {
    if (!isRecord(value.maxCallsPerHourByTool) || !Object.values(value.maxCallsPerHourByTool).every(isValidAgentToolHourlyCap)) return false;
  }
  return true;
}
