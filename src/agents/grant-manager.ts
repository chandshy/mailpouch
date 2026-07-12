/**
 * Per-agent permission gate.
 *
 * Consults the AgentGrantStore to decide whether a specific agent may call
 * a specific tool at this instant. Runs BEFORE the existing global-preset
 * check and BEFORE the destructive-confirmation gate, so denials are
 * cheap and conditional permissions are applied consistently.
 *
 * Design notes
 *  - The grant's preset is intersected with the global preset to produce
 *    the effective permissions. A grant can never widen what the global
 *    config allows.
 *  - Expiry is checked at call time. Crossing expiresAt transitions the
 *    grant to "expired" and logs the status change — the MCP client will
 *    get a 401-equivalent on its next call, which is the clearest signal.
 *  - Folder-allowlist checks use an explicit matrix for every tool that
 *    returns or consumes direct mailbox content. This prevents a multi-folder
 *    input from being reduced to its first allowed value, and makes known
 *    handler-level scopes visible in one reviewable policy surface.
 */

import type { AgentGrant, GrantCheckResult } from "./types.js";
import { canonicalToolName, TOOL_ALIASES, type ToolName, type PermissionPreset } from "../config/schema.js";
import { buildPermissions } from "../config/loader.js";
import {
  grantHasExpired,
  isServiceAccountGrant,
  type AgentGrantStore,
  type AuthorizationGrantSnapshot,
} from "./grant-store.js";
import type { ServiceAccountStore } from "./service-account-store.js";
import { isValidAgentToolHourlyCap } from "./grant-conditions.js";

export interface GrantCheckContext {
  clientId: string;
  tool: ToolName | string;
  args?: Record<string, unknown>;
  callerIp?: string;
  /** Account the call will operate on; checked against conditions.accountId. */
  targetAccountId?: string;
  /** The global config preset — the upper bound for the grant. */
  globalPreset: PermissionPreset;
}

export interface GrantCheckOptions {
  /**
   * Reserve the configured per-tool hourly slot when every grant condition
   * passes. Defaults to true. Dispatch performs an initial non-reserving
   * policy check, then makes a final reserving check immediately before the
   * handler so unrelated global/confirmation denials do not consume a slot.
   */
  reserveHourlyToolSlot?: boolean;
  /**
   * A fresh snapshot fetched by the caller for this authorization decision.
   * Passing it lets account binding, the grant gate, and folder scoping all
   * operate on one durable view rather than separate stale map lookups.
   */
  snapshot?: AuthorizationGrantSnapshot;
}

export class GrantManager {
  constructor(
    private readonly store: AgentGrantStore,
    private readonly serviceAccounts?: ServiceAccountStore,
  ) {}

  /**
   * Core decision: allowed? Returns a structured result. Callers surface the
   * reason string to the MCP response so the agent can distinguish "not yet
   * approved" from "revoked" from "tool outside your scope".
   */
  check(ctx: GrantCheckContext, options: GrantCheckOptions = {}): GrantCheckResult {
    const reserveHourlyToolSlot = options.reserveHourlyToolSlot !== false;
    const tool = canonicalToolName(ctx.tool) as ToolName;
    const normalizedCtx: GrantCheckContext = tool === ctx.tool ? ctx : { ...ctx, tool };
    const snapshot = options.snapshot ?? this.getAuthorizationSnapshot(ctx.clientId);
    if (snapshot.kind === "unavailable") {
      return { allowed: false, reason: "Grant records are unavailable; denied fail-closed." };
    }
    if (snapshot.kind === "missing") {
      return { allowed: false, reason: `No grant registered for client ${ctx.clientId}. An MCP host is expected to DCR before calling tools.` };
    }
    const grant = snapshot.grant;

    switch (grant.status) {
      case "pending":
        return { allowed: false, reason: `Grant for '${grant.clientName}' is pending user approval. Open the settings UI to approve.` };
      case "revoked":
        return { allowed: false, reason: `Grant for '${grant.clientName}' was revoked at ${grant.revokedAt ?? "(unknown time)"}.` };
      case "expired":
        return { allowed: false, reason: `Grant for '${grant.clientName}' expired. Reapprove in the settings UI.` };
    }

    // A service-account grant is only valid while its credential record is
    // still present. The normal revoke operation removes both records, but a
    // crash or a separate process can leave an active grant behind after the
    // credential was deleted. Never let that orphan become authorization.
    // Interactive DCR grants have no marker and intentionally bypass this
    // check: their absence from ServiceAccountStore is expected.
    if (isServiceAccountGrant(grant)) {
      if (!this.serviceAccounts) {
        return { allowed: false, reason: "Service-account credentials are unavailable; denied fail-closed." };
      }
      const serviceSnapshot = this.serviceAccounts.getAuthorizationSnapshot(grant.clientId);
      if (serviceSnapshot.kind === "unavailable") {
        return { allowed: false, reason: "Service-account credentials are unavailable; denied fail-closed." };
      }
      if (serviceSnapshot.kind === "missing") {
        return { allowed: false, reason: `Service-account credential for '${grant.clientName}' was revoked or is missing.` };
      }
    }

    // Status is "active" — check conditions.
    if (grantHasExpired(grant)) {
      this.store.markExpired(grant.clientId);
      return { allowed: false, reason: `Grant for '${grant.clientName}' expired.` };
    }

    if (grant.conditions?.accountId && grant.conditions.accountId !== ctx.targetAccountId) {
      return {
        allowed: false,
        reason: `Grant for '${grant.clientName}' is bound to account ${grant.conditions.accountId}; call targeted ${ctx.targetAccountId ?? "(unknown)"}.`,
      };
    }

    if (grant.conditions?.ipPins && grant.conditions.ipPins.length > 0) {
      if (!ctx.callerIp || !grant.conditions.ipPins.includes(ctx.callerIp)) {
        return { allowed: false, reason: `Grant for '${grant.clientName}' is IP-pinned; caller IP ${ctx.callerIp ?? "(unknown)"} is not in the allowlist.` };
      }
    }

    // Tool override always wins, in either direction.
    const overrides = grant.toolOverrides as Record<string, boolean | undefined> | undefined;
    const legacyAlias = Object.entries(TOOL_ALIASES)
      .find(([, canonical]) => canonical === tool)?.[0];
    const legacyOverride = legacyAlias ? overrides?.[legacyAlias] : undefined;
    const override = overrides?.[tool] ?? overrides?.[ctx.tool] ?? legacyOverride;
    if (override === false) {
      return { allowed: false, reason: `Tool '${tool}' is explicitly denied for '${grant.clientName}'.` };
    }
    if (override === true) {
      // Override opens the tool but it still needs to exist in the global preset.
      if (!this.globalAllows(normalizedCtx.globalPreset, tool)) {
        return { allowed: false, reason: `Tool '${tool}' is disabled by the global preset; per-agent override cannot widen the server's ceiling.` };
      }
      return this.applyHourlyRateCap(
        grant,
        tool,
        this.checkFolderCondition(grant, normalizedCtx, grant.preset),
        reserveHourlyToolSlot,
      );
    }

    // PERM-013: a "custom" grant has no meaningful preset map of its own —
    // buildPermissions("custom") enables every tool, identical to "full". The
    // user's intent for a custom grant lives entirely in `toolOverrides`,
    // which were already applied above. With no override the tool is NOT in
    // the custom surface, so it must default-deny here. The old rank table
    // ranked custom == full (3); intersecting custom with a lower global
    // preset returned the GLOBAL preset and then consulted its enabled-map,
    // silently re-enabling tools the user had disabled in the custom set.
    if (grant.preset === "custom") {
      return { allowed: false, reason: `Tool '${tool}' is not in the custom grant surface for '${grant.clientName}' (custom grants allow only explicitly-overridden tools).` };
    }

    // No override — apply the intersection of grant preset and global preset.
    const effective = intersectPresets(grant.preset, normalizedCtx.globalPreset);
    if (!this.globalAllows(effective, tool)) {
      return { allowed: false, reason: `Tool '${tool}' is outside the effective preset '${effective}' for '${grant.clientName}'.` };
    }

    return this.applyHourlyRateCap(
      grant,
      tool,
      this.checkFolderCondition(grant, normalizedCtx, effective),
      reserveHourlyToolSlot,
    );
  }

  /**
   * Apply an optional grant-scoped per-tool hourly cap after the ordinary
   * status/preset/IP/folder checks have all passed.  The store reserves the
   * slot synchronously, making the check-and-consume operation safe when
   * multiple async MCP calls arrive together.
   */
  private applyHourlyRateCap(
    grant: AgentGrant,
    canonicalTool: ToolName,
    result: GrantCheckResult,
    reserveHourlyToolSlot: boolean,
  ): GrantCheckResult {
    if (!result.allowed || !reserveHourlyToolSlot) return result;

    const cap = this.hourlyRateCapForTool(grant, canonicalTool);
    if (cap === undefined) return result;
    if (cap === null) {
      return {
        allowed: false,
        reason: `Tool '${canonicalTool}' has an invalid per-agent hourly cap; denied fail-closed.`,
      };
    }
    if (cap === 0) {
      return {
        allowed: false,
        reason: `Tool '${canonicalTool}' is capped at 0 calls/hour for '${grant.clientName}'.`,
      };
    }

    const reservation = this.store.reserveHourlyToolCall(grant.clientId, canonicalTool, cap);
    if (reservation.failure === "quota_store_unavailable") {
      return {
        allowed: false,
        reason: `Tool '${canonicalTool}' hourly quota ledger is unavailable; denied fail-closed.`,
      };
    }
    if (!reservation.allowed) {
      return {
        allowed: false,
        reason: `Tool '${canonicalTool}' has reached its per-agent cap of ${cap} calls/hour for '${grant.clientName}'.`,
      };
    }
    return result;
  }

  /**
   * Return the cap configured for a canonical tool.  Normal settings saves
   * only permit canonical keys, but legacy/manual grant files can contain an
   * alias such as `bulk_delete`; resolve those keys too so aliases cannot get
   * a separate budget.  A canonical key wins over legacy aliases.  If more
   * than one legacy alias exists, use the strictest cap.
   *
   * `undefined` means no cap. `null` represents malformed persisted data and
   * is denied by the caller rather than accidentally treated as unlimited.
   */
  private hourlyRateCapForTool(grant: AgentGrant, canonicalTool: ToolName): number | null | undefined {
    const caps = grant.conditions?.maxCallsPerHourByTool as Record<string, unknown> | undefined;
    if (!caps) return undefined;

    if (Object.prototype.hasOwnProperty.call(caps, canonicalTool)) {
      return normalizeHourlyCap(caps[canonicalTool]);
    }

    let legacyCap: number | undefined;
    for (const [configuredTool, candidate] of Object.entries(caps)) {
      if (canonicalToolName(configuredTool) !== canonicalTool) continue;
      const normalized = normalizeHourlyCap(candidate);
      if (normalized === null) return null;
      if (legacyCap === undefined || normalized < legacyCap) legacyCap = normalized;
    }
    return legacyCap;
  }

  private checkFolderCondition(grant: AgentGrant, ctx: GrantCheckContext, effective: PermissionPreset): GrantCheckResult {
    const allow = grant.conditions?.folderAllowlist;
    if (!allow || allow.length === 0) return { allowed: true, effectivePreset: effective };

    // Mailbox mutations often have two independently security-relevant paths:
    // the mailbox an existing UID comes from and the mailbox it will be moved,
    // copied, created, renamed, or purged in.  The historical fallback below
    // only found the first folder-looking argument, which let an allowed target
    // hide an excluded source (or vice versa).  Resolve the complete, explicit
    // mutation matrix before consulting the older compatibility path.
    const mutationScope = MAILBOX_MUTATION_FOLDER_SCOPES[ctx.tool];
    if (mutationScope) {
      const resolution = resolveMailboxMutationFolders(mutationScope, ctx.args);
      if (resolution.kind === "missing") {
        return {
          allowed: false,
          reason: `Tool '${ctx.tool}' requires a resolvable folder scope under this grant: ${resolution.reason}`,
        };
      }
      return allowResolvedFolders(allow, resolution.folders, effective);
    }

    const directScope = DIRECT_CONTENT_FOLDER_SCOPES[ctx.tool];
    if (directScope) {
      const resolution = resolveDirectContentFolders(directScope, ctx.args);
      if (resolution.kind === "missing") {
        return {
          allowed: false,
          reason: `Tool '${ctx.tool}' requires a resolvable folder scope under this grant: ${resolution.reason}`,
        };
      }
      return allowResolvedFolders(allow, resolution.folders, effective);
    }

    // The explicit mutation matrix above owns source/destination semantics for
    // known IMAP mutators. Keep the compatibility fallback separate from the
    // direct-content matrix so a future non-mutating tool cannot silently
    // inherit only one side of a move/label policy.
    const folder = extractLegacyFolderArg(ctx.args);
    if (!folder) {
      // For folder-scoped tools, the absence of a recognized folder arg is
      // suspicious: an attacker could tunnel folder intent through a
      // non-standard arg name to escape the allowlist. Fail closed unless
      // the tool is explicitly known to be folder-agnostic.
      if (FOLDER_AGNOSTIC_TOOLS.has(ctx.tool)) return { allowed: true, effectivePreset: effective };
      return { allowed: false, reason: `Tool '${ctx.tool}' has no recognized folder argument; the grant's folder allowlist requires a folder.` };
    }
    const lower = folder.toLowerCase();
    if (!allow.some(a => a.toLowerCase() === lower)) {
      return { allowed: false, reason: `Folder '${folder}' is outside the grant's allowlist (${allow.join(", ")}).` };
    }
    return { allowed: true, effectivePreset: effective };
  }

  private globalAllows(preset: PermissionPreset, tool: string): boolean {
    // Memoize on preset — buildPermissions materializes a full map per call,
    // but the preset→permissions mapping is pure. `check()` can consult this
    // twice per call (once for the override path, once for the preset path),
    // and a high-QPS agent would materialize the same map over and over.
    let perms = this.permsCache.get(preset);
    if (!perms) {
      perms = buildPermissions(preset);
      this.permsCache.set(preset, perms);
    }
    return !!perms.tools[tool as ToolName]?.enabled;
  }

  private readonly permsCache = new Map<PermissionPreset, ReturnType<typeof buildPermissions>>();

  /** Fetch a disk-backed view for one authorization decision. */
  getAuthorizationSnapshot(clientId: string): AuthorizationGrantSnapshot {
    return this.store.getAuthorizationSnapshot(clientId);
  }

  /**
   * Resolve the effective folder allowlist for a caller. Used by tools that
   * return folder-bearing content (e.g., FTS snippets) and need to filter
   * results to the caller's allowed folders independently of the per-call
   * `folder` arg check in {@link check}.
   *
   * Returns:
   *  - `undefined` when there is no grant, the grant has no folder restriction,
   *    or the grant's allowlist is an empty array. Caller should treat
   *    `undefined` as "no restriction — return all folders" to preserve
   *    existing behavior for unscoped grants and stdio/local callers.
   *  - A non-empty `string[]` when the grant's `conditions.folderAllowlist`
   *    is set to a non-empty list. Caller should restrict results to those
   *    folders.
   *
   * Note: this method intentionally does not return `[]` to distinguish
   * "no grant / no restriction" from "explicitly empty allowlist". The
   * grant schema treats an empty allowlist the same as no allowlist; if
   * future revisions tighten that semantic, callers can switch on the
   * returned value's length.
   */
  resolveAllowedFolders(grant: AgentGrant): string[] | undefined {
    const allow = grant.conditions?.folderAllowlist;
    if (!allow || allow.length === 0) return undefined;
    return [...allow];
  }
}

/** Valid grant caps are non-negative whole call counts; 0 deliberately denies all calls. */
function normalizeHourlyCap(value: unknown): number | null {
  return isValidAgentToolHourlyCap(value) ? value : null;
}

/**
 * Folder sources for tools that return (or derive an action from) direct mail
 * content. This is intentionally a policy matrix rather than a generic
 * "first folder-looking argument wins" heuristic:
 *
 * - `search_emails` can read every entry in `folders`, so every entry is
 *   checked and wildcard expansion is denied for a restricted grant.
 * - by-ID/content tools require an explicit folder, preventing their IMAP
 *   fallback from searching arbitrary mailboxes.
 * - `fts_search` and the persisted-record tools named `handler-scoped` have
 *   an independently enforced handler-level allowlist; they remain explicit
 *   here so that exemption is reviewable rather than hidden in a broad set.
 */
type DirectContentFolderScope =
  | { mode: "required"; field: string }
  | { mode: "default"; field: string; defaultFolder: string }
  | { mode: "search"; folderField: string; foldersField: string; defaultFolder: string }
  | { mode: "label"; field: string; prefix: string }
  | { mode: "output-filtered"; field: string }
  | { mode: "handler-scoped" };

type DirectContentFolderResolution =
  | { kind: "folders"; folders: string[] }
  | { kind: "missing"; reason: string };

/**
 * Every folder touched by an IMAP mailbox mutation.  `field` entries must be
 * explicitly supplied for a folder-restricted grant: without that provenance,
 * the service may discover the UID in an arbitrary mailbox.  `fixed` and
 * derived entries model destinations that are not carried as a full path in
 * the request itself. A `dynamic-special-use` destination is deliberately
 * different: the IMAP service resolves its physical path from the account's
 * server-reported special-use folders (for example `\\Trash` → `Papelera`).
 * GrantManager has no account-scoped folder discovery at this synchronous
 * authorization boundary, so it must fail closed for folder-restricted grants
 * rather than mistake an English logical name for the actual IMAP path.
 */
type MailboxMutationFolderSource =
  | { mode: "field"; field: string }
  | { mode: "fixed"; folder: string }
  | { mode: "prefixed"; field: string; prefix: string }
  | { mode: "folder-or-prefixed"; field: string; prefix: string }
  | { mode: "dynamic-special-use"; specialUse: "Trash" | "Drafts" };

type MailboxMutationFolderScope = readonly MailboxMutationFolderSource[];

const DIRECT_CONTENT_FOLDER_SCOPES: Readonly<Record<string, DirectContentFolderScope>> = {
  // Mail content returned directly from IMAP.
  get_emails: { mode: "default", field: "folder", defaultFolder: "INBOX" },
  get_email_by_id: { mode: "required", field: "folder" },
  search_emails: { mode: "search", folderField: "folder", foldersField: "folders", defaultFolder: "INBOX" },
  get_emails_by_label: { mode: "label", field: "label", prefix: "Labels/" },
  download_attachment: { mode: "required", field: "folder" },
  get_thread: { mode: "required", field: "folder" },
  extract_action_items: { mode: "required", field: "folder" },
  extract_meeting: { mode: "required", field: "folder" },
  // Despite its maintenance-oriented name, sync_emails fetches and caches
  // direct mailbox content. Its omitted-folder behavior is an INBOX read and
  // must not escape a restricted grant through FOLDER_AGNOSTIC_TOOLS.
  sync_emails: { mode: "default", field: "folder", defaultFolder: "INBOX" },

  // These send operations fetch an existing message before composing output.
  reply_to_email: { mode: "required", field: "folder" },
  forward_email: { mode: "required", field: "folder" },

  // `fts_search` passes the final grant allowlist to FtsIndexService even
  // when no per-call folder is supplied; an explicit folder still must be
  // within that allowlist.
  fts_search: { mode: "output-filtered", field: "folder" },

  // These handlers independently filter persisted/fixed mailbox data with
  // ctx.getCallerAllowedFolders() before reading it. Keep the trust boundary
  // visible instead of treating them as broadly folder-agnostic.
  list_proton_scheduled: { mode: "handler-scoped" },
  remind_if_no_reply: { mode: "handler-scoped" },
};

/**
 * Folder provenance for every tool that mutates an IMAP mailbox.  Keep this
 * deliberately explicit instead of falling back to a generic first-folder
 * heuristic: move/copy operations have both a source and a destination, and
 * several convenience tools derive their target from a label, a leaf name, or
 * a fixed special mailbox.
 *
 * Local scheduler/reminder records are intentionally absent. Their handlers
 * already fail closed for folder-restricted callers because those records lack
 * mailbox provenance. SMTP-only sends are likewise outside this IMAP mutation
 * surface.
 */
const MAILBOX_MUTATION_FOLDER_SCOPES: Readonly<Record<string, MailboxMutationFolderScope>> = {
  // UID mutations: an omitted source makes the IMAP service search mailboxes,
  // so restricted callers must state the exact source.
  mark_email_read: [{ mode: "field", field: "sourceFolder" }],
  star_email: [{ mode: "field", field: "sourceFolder" }],
  mark_answered: [{ mode: "field", field: "sourceFolder" }],
  mark_forwarded: [{ mode: "field", field: "sourceFolder" }],
  bulk_mark_read: [{ mode: "field", field: "sourceFolder" }],
  bulk_star: [{ mode: "field", field: "sourceFolder" }],

  // Generic moves validate both ends; validating only targetFolder used to
  // allow a colliding UID from an excluded source mailbox to be moved.
  move_email: [
    { mode: "field", field: "sourceFolder" },
    { mode: "field", field: "targetFolder" },
  ],
  bulk_move_emails: [
    { mode: "field", field: "sourceFolder" },
    { mode: "field", field: "targetFolder" },
  ],
  move_to_folder: [
    { mode: "field", field: "sourceFolder" },
    { mode: "folder-or-prefixed", field: "folder", prefix: "Folders/" },
  ],

  // Convenience moves have a fixed destination in addition to their source.
  archive_email: [
    { mode: "field", field: "sourceFolder" },
    { mode: "fixed", folder: "Archive" },
  ],
  move_to_trash: [
    { mode: "field", field: "sourceFolder" },
    { mode: "fixed", folder: "Trash" },
  ],
  move_to_spam: [
    { mode: "field", field: "sourceFolder" },
    { mode: "fixed", folder: "Spam" },
  ],
  // These tools resolve the physical special-use mailbox at runtime. On a
  // localized account, `Trash` may be `Papelera` and `Drafts` may be
  // `Brouillons`; accepting the English aliases here would authorize a path
  // other than the operator's literal folder allowlist. Keep source provenance
  // first so a missing/invalid source still fails for the correct reason, then
  // deny the unresolved destination under any restricted grant.
  delete_email: [
    { mode: "field", field: "sourceFolder" },
    { mode: "dynamic-special-use", specialUse: "Trash" },
  ],
  bulk_delete_emails: [
    { mode: "field", field: "sourceFolder" },
    { mode: "dynamic-special-use", specialUse: "Trash" },
  ],
  empty_trash: [{ mode: "dynamic-special-use", specialUse: "Trash" }],

  // Label operations derive the real IMAP mailbox from a label leaf.
  move_to_label: [
    { mode: "field", field: "sourceFolder" },
    { mode: "prefixed", field: "label", prefix: "Labels/" },
  ],
  bulk_move_to_label: [
    { mode: "field", field: "sourceFolder" },
    { mode: "prefixed", field: "label", prefix: "Labels/" },
  ],
  remove_label: [{ mode: "prefixed", field: "label", prefix: "Labels/" }],
  bulk_remove_label: [{ mode: "prefixed", field: "label", prefix: "Labels/" }],

  // Folder administration operates on the exact requested path(s).
  create_folder: [{ mode: "field", field: "folderName" }],
  delete_folder: [{ mode: "field", field: "folderName" }],
  rename_folder: [
    { mode: "field", field: "oldName" },
    { mode: "field", field: "newName" },
  ],

  save_draft: [{ mode: "dynamic-special-use", specialUse: "Drafts" }],
};

function resolveDirectContentFolders(
  scope: DirectContentFolderScope,
  args: Record<string, unknown> | undefined,
): DirectContentFolderResolution {
  switch (scope.mode) {
    case "required": {
      const folder = readFolder(args?.[scope.field]);
      return folder
        ? { kind: "folders", folders: [folder] }
        : { kind: "missing", reason: `'${scope.field}' must be a non-empty folder path.` };
    }
    case "default": {
      const raw = args?.[scope.field];
      const folder = readFolder(raw);
      if (folder) return { kind: "folders", folders: [folder] };
      if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) {
        return { kind: "folders", folders: [scope.defaultFolder] };
      }
      return { kind: "missing", reason: `'${scope.field}' must be a folder path when provided.` };
    }
    case "search":
      return resolveSearchFolders(scope, args);
    case "label": {
      // Label handlers preserve leaf whitespace when constructing `Labels/...`.
      // Keep that exact derivation here: trimming would authorize Labels/Work
      // while the handler actually reads a distinct Labels/ Work mailbox.
      const label = readNonEmptyString(args?.[scope.field]);
      return label
        ? { kind: "folders", folders: [`${scope.prefix}${label}`] }
        : { kind: "missing", reason: `'${scope.field}' must identify the label folder.` };
    }
    case "output-filtered": {
      const raw = args?.[scope.field];
      if (raw === undefined || raw === null) return { kind: "folders", folders: [] };
      const folder = readFolder(raw);
      return folder
        ? { kind: "folders", folders: [folder] }
        : { kind: "missing", reason: `'${scope.field}' must be a non-empty folder path when provided.` };
    }
    case "handler-scoped":
      return { kind: "folders", folders: [] };
  }
}

/** Resolve every source and destination described by an IMAP mutation policy. */
function resolveMailboxMutationFolders(
  scope: MailboxMutationFolderScope,
  args: Record<string, unknown> | undefined,
): DirectContentFolderResolution {
  const folders: string[] = [];
  for (const source of scope) {
    switch (source.mode) {
      case "fixed":
        folders.push(source.folder);
        break;
      case "field": {
        const folder = readFolder(args?.[source.field]);
        if (!folder) {
          return { kind: "missing", reason: `'${source.field}' must be an explicit non-empty folder path.` };
        }
        folders.push(folder);
        break;
      }
      case "prefixed": {
        // Labels are a leaf-name API and their handlers preserve whitespace in
        // the supplied leaf. Derive the exact path they will mutate rather
        // than normalizing it to a neighboring allowlisted mailbox.
        const leaf = readNonEmptyString(args?.[source.field]);
        if (!leaf) {
          return { kind: "missing", reason: `'${source.field}' must identify a non-empty destination.` };
        }
        folders.push(`${source.prefix}${leaf}`);
        break;
      }
      case "folder-or-prefixed": {
        const target = readFolder(args?.[source.field]);
        if (!target) {
          return { kind: "missing", reason: `'${source.field}' must identify a non-empty destination.` };
        }
        // Match move_to_folder's handler exactly: a fully-qualified Folders/
        // or Labels/ path is used verbatim; an unqualified leaf is placed
        // under Folders/. Do not case-fold the prefix here, or the policy could
        // authorize a path different from the one the handler will mutate.
        folders.push(/^(Folders|Labels)\//.test(target) ? target : `${source.prefix}${target}`);
        break;
      }
      case "dynamic-special-use":
        // `deleteEmail`/`emptyTrash` resolve `\\Trash`, and `saveDraft`
        // resolves `\\Drafts`, by consulting the connected account's folder
        // list. This grant gate deliberately does not accept a symbolic
        // English alias in place of that physical destination: an operator's
        // allowlist contains IMAP paths, not special-use capabilities.
        return {
          kind: "missing",
          reason: `${source.specialUse} is a server-resolved special-use mailbox and cannot be proven within a folder-restricted grant.`,
        };
    }
  }
  return { kind: "folders", folders };
}

function allowResolvedFolders(
  allow: readonly string[],
  folders: readonly string[],
  effective: PermissionPreset,
): GrantCheckResult {
  for (const folder of folders) {
    if (!allow.some(allowed => allowed.toLowerCase() === folder.toLowerCase())) {
      return {
        allowed: false,
        reason: `Folder '${folder}' is outside the grant's allowlist (${allow.join(", ")}).`,
      };
    }
  }
  return { allowed: true, effectivePreset: effective };
}

function resolveSearchFolders(
  scope: Extract<DirectContentFolderScope, { mode: "search" }>,
  args: Record<string, unknown> | undefined,
): DirectContentFolderResolution {
  const rawFolders = args?.[scope.foldersField];
  if (rawFolders !== undefined) {
    if (!Array.isArray(rawFolders)) {
      return { kind: "missing", reason: `'${scope.foldersField}' must be an array of folder paths.` };
    }
    // A restricted caller must state an actual search set. The handler also
    // rejects [] rather than allowing the IMAP service's historical INBOX
    // fallback to turn an apparently scoped request into an implicit read.
    if (rawFolders.length === 0) {
      return { kind: "missing", reason: `'${scope.foldersField}' must contain at least one explicit folder path.` };
    }

    const folders: string[] = [];
    for (const raw of rawFolders) {
      const folder = readFolder(raw);
      if (!folder) {
        return { kind: "missing", reason: `'${scope.foldersField}' must contain only non-empty folder paths.` };
      }
      // SimpleIMAPService expands either sentinel when it occupies the first
      // slot. Deny either anywhere in the supplied list so future service
      // ordering changes cannot turn a restricted grant into a whole-mailbox
      // search.
      if (folder === "*" || folder.toLowerCase() === "all") {
        return { kind: "missing", reason: `'${scope.foldersField}' cannot include a whole-mailbox wildcard under a folder-restricted grant.` };
      }
      folders.push(folder);
    }

    // The handler validates a scalar `folder` too when `folders` is present:
    // it must be both allowlisted and part of the effective array. Do the same
    // here so an ignored-looking raw argument cannot hide a conflicting scope
    // from a future handler implementation.
    const rawScalar = args?.[scope.folderField];
    if (rawScalar !== undefined && rawScalar !== null && rawScalar !== "") {
      const scalar = readFolder(rawScalar);
      if (!scalar) {
        return { kind: "missing", reason: `'${scope.folderField}' must be a non-empty folder path when provided.` };
      }
      if (!folders.some(folder => folder.toLowerCase() === scalar.toLowerCase())) {
        return {
          kind: "missing",
          reason: `'${scope.folderField}' must match one of the effective '${scope.foldersField}' entries.`,
        };
      }
    }
    return { kind: "folders", folders };
  }

  return resolveDirectContentFolders(
    { mode: "default", field: scope.folderField, defaultFolder: scope.defaultFolder },
    args,
  );
}

function readFolder(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** A non-empty string whose original spelling is significant to a handler. */
function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * Legacy compatibility fallback for non-direct-content tools. It deliberately
 * preserves the historical first-folder behavior for mailbox mutations until
 * SEC-FOLDER-MULTI-001 defines whether their source, destination, or both are
 * constrained. New direct-content tools must be added to the matrix above.
 */
function extractLegacyFolderArg(args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined;
  for (const k of ["folder", "mailbox", "targetFolder", "folderName", "target_folder", "sourceFolder", "source_folder"]) {
    const v = args[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

/**
 * Tools outside the direct-content matrix that legitimately have no call-level
 * folder argument. They either expose aggregate/non-mail data, or enforce any
 * persisted-record scope inside their handler. Mailbox mutations intentionally
 * retain the legacy fallback above until SEC-FOLDER-MULTI-001 defines their
 * source/destination policy.
 */
const FOLDER_AGNOSTIC_TOOLS = new Set<string>([
  "get_email_stats", "get_email_analytics", "get_volume_trends",
  "get_contacts", "get_correspondence_profile",
  "list_labels", "get_folders", "sync_folders",
  "get_connection_status", "get_unread_count", "get_email_stats",
  "clear_cache", "get_logs", "start_bridge", "shutdown_server", "restart_server",
  "fts_rebuild", "fts_status",
  "list_scheduled_emails", "cancel_scheduled_email",
  "list_pending_reminders", "cancel_reminder", "check_reminders",
  "alias_list", "alias_create_random", "alias_create_custom",
  "alias_toggle", "alias_delete", "alias_get_activity",
  "pass_list", "pass_search", "pass_get",
  "send_email", "send_test_email",
  "schedule_email",
  "request_permission_escalation", "check_escalation_status",
]);

/**
 * Intersect two presets — return the stricter of the two. Ordering is
 * read_only < send_only < supervised < full.
 *
 * PERM-013: `a` (the grant preset) is never "custom" here — check() short-
 * circuits a custom grant to its explicit toolOverrides before reaching this
 * function, because buildPermissions("custom") is all-enabled and carries no
 * real restriction. `b` (the global preset) may still be "custom"; it sorts at
 * the top of the rank (most permissive preset-level ceiling), and the live
 * per-tool custom config is enforced separately by the global permission gate
 * (PermissionManager.check), so a custom global cannot silently widen a grant.
 */
function intersectPresets(a: PermissionPreset, b: PermissionPreset): PermissionPreset {
  const rank: Record<PermissionPreset, number> = {
    read_only: 0,
    send_only: 1,
    supervised: 2,
    full: 3,
    custom: 3,
  };
  return rank[a] <= rank[b] ? a : b;
}
