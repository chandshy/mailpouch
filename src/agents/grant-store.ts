/**
 * Persistence for {@link AgentGrant} records.
 *
 * A single JSON file (`~/.pm-bridge-mcp-agents.json`) holds every grant the
 * server has ever seen, across all three statuses. Writes are atomic via
 * tmp→rename, consistent with the rest of the project's credential-hygiene
 * story. The file is mode 0600.
 *
 * We deliberately keep this in memory as a Map<clientId, AgentGrant> and
 * flush the whole file on every mutation. n is small (<100 grants even in
 * aggressive use), JSON serialization is tens of μs, and atomic writes
 * eliminate the need for a lockfile.
 */

import { readFileSync, writeFileSync, existsSync, renameSync } from "fs";
import { randomBytes } from "crypto";
import type { AgentGrant, AgentGrantStatus, GrantConditions } from "./types.js";
import type { PermissionPreset, ToolName } from "../config/schema.js";
import { logger } from "../utils/logger.js";
import { notifications } from "./notifications.js";

interface StoreFile {
  version: 1;
  grants: AgentGrant[];
}

export interface CreatePendingArgs {
  clientId: string;
  clientName: string;
}

export interface ApproveArgs {
  clientId: string;
  preset: PermissionPreset;
  toolOverrides?: Partial<Record<ToolName, boolean>>;
  conditions?: GrantConditions;
  note?: string;
}

export class AgentGrantStore {
  private grants = new Map<string, AgentGrant>();
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
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

  private persist(): void {
    const payload: StoreFile = { version: 1, grants: [...this.grants.values()] };
    // tmp MUST be on the same filesystem as the destination for rename(2) to
    // be atomic. On Linux installs where /tmp is tmpfs and $HOME is on
    // separate storage, using os.tmpdir() fails with EXDEV. Put the tmp
    // next to the destination instead.
    const tmp = `${this.path}.${randomBytes(8).toString("hex")}.tmp`;
    writeFileSync(tmp, JSON.stringify(payload, null, 2), { encoding: "utf-8", mode: 0o600 });
    renameSync(tmp, this.path);
  }

  /**
   * Record a brand-new DCR client as a pending grant. Called from the OAuth
   * DCR handler; idempotent when the same client_id is registered twice (e.g.
   * an MCP host retrying on a disconnected tunnel).
   */
  createPending(args: CreatePendingArgs): AgentGrant {
    const existing = this.grants.get(args.clientId);
    if (existing) return existing;

    const grant: AgentGrant = {
      clientId: args.clientId,
      clientName: args.clientName || "(unnamed client)",
      status: "pending",
      preset: "read_only", // placeholder — replaced on approve
      createdAt: new Date().toISOString(),
      totalCalls: 0,
    };
    this.grants.set(args.clientId, grant);
    this.persist();
    notifications.emitGrantChanged("grant-created", grant);
    return grant;
  }

  approve(args: ApproveArgs): AgentGrant | null {
    const g = this.grants.get(args.clientId);
    if (!g) return null;
    g.status = "active";
    g.preset = args.preset;
    g.toolOverrides = args.toolOverrides;
    g.conditions = args.conditions;
    g.note = args.note;
    g.approvedAt = new Date().toISOString();
    g.revokedAt = undefined;
    this.persist();
    notifications.emitGrantChanged("grant-approved", g);
    return g;
  }

  deny(clientId: string, note?: string): AgentGrant | null {
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
  }

  revoke(clientId: string): AgentGrant | null {
    return this.deny(clientId);
  }

  /**
   * Mark a grant as expired in-place. Called by the gate when it observes
   * expiresAt has passed; atomic so concurrent tool calls agree on the state.
   */
  markExpired(clientId: string): AgentGrant | null {
    const g = this.grants.get(clientId);
    if (!g) return null;
    if (g.status === "expired") return g;
    g.status = "expired";
    this.persist();
    notifications.emitGrantChanged("grant-expired", g);
    return g;
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
    // A future sweep step can flush these updates.
  }

  /** Force-flush any in-memory call-count updates to disk. */
  flushCounters(): void {
    this.persist();
  }

  get(clientId: string): AgentGrant | undefined {
    return this.grants.get(clientId);
  }

  list(filter?: { status?: AgentGrantStatus }): AgentGrant[] {
    const rows = [...this.grants.values()];
    if (filter?.status) return rows.filter(g => g.status === filter.status);
    return rows;
  }

  /** Drop revoked/expired grants older than `retainDays` days. */
  prune(retainDays = 90, now = Date.now()): number {
    const cutoff = now - retainDays * 24 * 60 * 60_000;
    let removed = 0;
    for (const [k, g] of this.grants) {
      if (g.status !== "revoked" && g.status !== "expired") continue;
      const endAt = g.revokedAt ?? g.approvedAt ?? g.createdAt;
      if (Date.parse(endAt) < cutoff) {
        this.grants.delete(k);
        removed++;
      }
    }
    if (removed > 0) this.persist();
    return removed;
  }
}
