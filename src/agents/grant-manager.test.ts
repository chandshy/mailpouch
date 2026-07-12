import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AgentGrantStore } from "./grant-store.js";
import { GrantManager } from "./grant-manager.js";
import { ServiceAccountStore } from "./service-account-store.js";
import { rmSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import { writeOwnerOnlyJsonAtomically } from "../utils/atomic-json.js";

function tmpPath(): string {
  return join(tmpdir(), `mailpouch-grant-mgr-${randomBytes(6).toString("hex")}.json`);
}

function removeStoreFiles(storePath: string): void {
  for (const suffix of ["", ".quota.sqlite", ".quota.sqlite-wal", ".quota.sqlite-shm", ".quota.sqlite-journal"]) {
    if (existsSync(storePath + suffix)) rmSync(storePath + suffix, { force: true });
  }
}

describe("GrantManager.check", () => {
  let path: string;
  let store: AgentGrantStore;
  let mgr: GrantManager;

  beforeEach(() => {
    path = tmpPath();
    store = new AgentGrantStore(path);
    mgr = new GrantManager(store);
  });

  afterEach(() => {
    store.close();
    removeStoreFiles(path);
  });

  it("denies when no grant exists", () => {
    const r = mgr.check({ clientId: "pmc_unknown", tool: "get_emails", globalPreset: "full" });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/no grant registered/i);
  });

  it("denies a pending grant with a clear message", () => {
    store.createPending({ clientId: "pmc_1", clientName: "A" });
    const r = mgr.check({ clientId: "pmc_1", tool: "get_emails", globalPreset: "full" });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/pending user approval/i);
  });

  it("denies a revoked grant", () => {
    store.createPending({ clientId: "pmc_1", clientName: "A" });
    store.deny("pmc_1");
    const r = mgr.check({ clientId: "pmc_1", tool: "get_emails", globalPreset: "full" });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/revoked/i);
  });

  it("allows an active grant for a tool inside the effective preset", () => {
    store.createPending({ clientId: "pmc_1", clientName: "A" });
    store.approve({ clientId: "pmc_1", preset: "full" });
    const r = mgr.check({ clientId: "pmc_1", tool: "get_emails", globalPreset: "full" });
    expect(r.allowed).toBe(true);
    expect(r.effectivePreset).toBe("full");
  });

  it("denies an orphaned service grant across tool, resource, and prompt checks while preserving interactive grants", () => {
    const servicePath = tmpPath();
    const serviceAccounts = new ServiceAccountStore(servicePath);
    const { account } = serviceAccounts.issue({ name: "orphaned-credential", preset: "full" });
    store.ensureActiveServiceGrant({
      clientId: account.clientId,
      clientName: account.clientName,
      preset: account.preset,
      conditions: account.conditions,
    });
    expect(store.get(account.clientId)?.credentialKind).toBe("service_account");
    // Model a grant written by the prior schema: it has the exact historical
    // service-account note but no explicit marker. The fallback must remain
    // conservative until the next normal synchronization upgrades it.
    const legacyGrantFile = JSON.parse(readFileSync(path, "utf-8")) as { grants: Array<Record<string, unknown>> };
    delete legacyGrantFile.grants.find(entry => entry.clientId === account.clientId)!.credentialKind;
    writeOwnerOnlyJsonAtomically(path, legacyGrantFile);
    const manager = new GrantManager(store, serviceAccounts);
    const serviceSurfaces = [
      { name: "tool", context: { clientId: account.clientId, tool: "get_emails", globalPreset: "full" as const } },
      { name: "resource", context: { clientId: account.clientId, tool: "get_folders", globalPreset: "full" as const } },
      { name: "prompt", context: { clientId: account.clientId, tool: "get_emails", args: { folder: "INBOX" }, globalPreset: "full" as const } },
    ];
    try {
      for (const surface of serviceSurfaces) {
        expect(manager.check(surface.context).allowed, surface.name).toBe(true);
      }

      // Simulate only the credential-file half of an external revoke. The
      // matching grant remains active on disk and the store's UI map remains
      // stale, exactly the interrupted cross-file state we must fail closed.
      const external = JSON.parse(readFileSync(servicePath, "utf-8")) as { accounts: Array<Record<string, unknown>> };
      external.accounts = external.accounts.filter(entry => entry.clientId !== account.clientId);
      writeOwnerOnlyJsonAtomically(servicePath, external);
      expect(serviceAccounts.get(account.clientId)).toBeDefined();

      for (const surface of serviceSurfaces) {
        const result = manager.check(surface.context);
        expect(result.allowed, surface.name).toBe(false);
        expect(result.reason, surface.name).toMatch(/service-account credential.*revoked or is missing/i);
      }

      // An ordinary DCR/interactive grant has no credential marker and must
      // not be denied simply because it is absent from ServiceAccountStore.
      store.createPending({ clientId: "pmc_interactive", clientName: "Interactive" });
      store.approve({ clientId: "pmc_interactive", preset: "full" });
      expect(manager.check({
        clientId: "pmc_interactive", tool: "get_emails", globalPreset: "full",
      }).allowed).toBe(true);
    } finally {
      rmSync(servicePath, { force: true });
    }
  });

  it("uses fresh durable snapshots for tool, resource, and prompt paths after an external revocation", () => {
    store.createPending({ clientId: "pmc_1", clientName: "A" });
    store.approve({ clientId: "pmc_1", preset: "full" });
    const staleStore = new AgentGrantStore(path);
    const staleManager = new GrantManager(staleStore);
    // These are the concrete backing checks used by index.ts: a normal tool
    // call, List/ReadResource (get_folders), and a prompt (get_emails).
    // Keep them distinct so a future path-specific cache cannot silently
    // reintroduce stale authorization on one of the MCP surfaces.
    const surfaces = [
      { name: "tool", context: { clientId: "pmc_1", tool: "get_emails", globalPreset: "full" as const } },
      { name: "resource", context: { clientId: "pmc_1", tool: "get_folders", globalPreset: "full" as const } },
      { name: "prompt", context: { clientId: "pmc_1", tool: "get_emails", args: { folder: "INBOX" }, globalPreset: "full" as const } },
    ];
    try {
      for (const surface of surfaces) {
        expect(staleManager.check(surface.context).allowed, surface.name).toBe(true);
      }
      // Write the durable record as a separate process would. Deliberately
      // bypass AgentGrantStore's notification bus: every surface must rely on
      // its fresh disk snapshot, not an in-process revocation event.
      const external = JSON.parse(readFileSync(path, "utf-8")) as { grants: Array<Record<string, unknown>> };
      const revoked = external.grants.find(grant => grant.clientId === "pmc_1")!;
      revoked.status = "revoked";
      revoked.revokedAt = new Date().toISOString();
      writeOwnerOnlyJsonAtomically(path, external);
      // `staleStore.get()` still says active, but GrantManager never consults
      // that map for authorization after this regression. This writer is a
      // second process/store and emits no transport-specific refresh signal.
      expect(staleStore.get("pmc_1")?.status).toBe("active");
      for (const surface of surfaces) {
        const result = staleManager.check(surface.context);
        expect(result.allowed, surface.name).toBe(false);
        expect(result.reason, surface.name).toMatch(/revoked/i);
      }
    } finally {
      staleStore.close();
    }
  });

  it("fails closed when the durable grant file is unreadable or removed", () => {
    store.createPending({ clientId: "pmc_1", clientName: "A" });
    store.approve({ clientId: "pmc_1", preset: "full" });
    writeFileSync(path, "not valid JSON", "utf-8");
    expect(mgr.check({ clientId: "pmc_1", tool: "get_emails", globalPreset: "full" })).toMatchObject({
      allowed: false,
      reason: expect.stringMatching(/unavailable.*fail-closed/i),
    });
    rmSync(path, { force: true });
    expect(mgr.check({ clientId: "pmc_1", tool: "get_emails", globalPreset: "full" })).toMatchObject({
      allowed: false,
      reason: expect.stringMatching(/no grant registered/i),
    });
  });

  it("enforces account binding from the same fresh grant snapshot", () => {
    store.createPending({ clientId: "pmc_1", clientName: "A" });
    store.approve({
      clientId: "pmc_1",
      preset: "full",
      conditions: { accountId: "account-a" },
    });
    expect(mgr.check({
      clientId: "pmc_1", tool: "get_emails", globalPreset: "full", targetAccountId: "account-a",
    }).allowed).toBe(true);
    expect(mgr.check({
      clientId: "pmc_1", tool: "get_emails", globalPreset: "full", targetAccountId: "account-b",
    })).toMatchObject({ allowed: false, reason: expect.stringMatching(/bound to account account-a/i) });
  });

  it("intersects grant preset with global preset (global wins when stricter)", () => {
    store.createPending({ clientId: "pmc_1", clientName: "A" });
    store.approve({ clientId: "pmc_1", preset: "full" });
    // Global preset is read_only — delete_email is not in read_only.
    const r = mgr.check({ clientId: "pmc_1", tool: "delete_email", globalPreset: "read_only" });
    expect(r.allowed).toBe(false);
  });

  it("honors explicit tool allow override even when preset would deny", () => {
    store.createPending({ clientId: "pmc_1", clientName: "A" });
    store.approve({
      clientId: "pmc_1",
      preset: "read_only",
      toolOverrides: { send_email: true },
    });
    const r = mgr.check({ clientId: "pmc_1", tool: "send_email", globalPreset: "full" });
    expect(r.allowed).toBe(true);
  });

  it("refuses a tool allow override when the global preset does not permit the tool", () => {
    store.createPending({ clientId: "pmc_1", clientName: "A" });
    store.approve({
      clientId: "pmc_1",
      preset: "full",
      toolOverrides: { delete_email: true },
    });
    const r = mgr.check({ clientId: "pmc_1", tool: "delete_email", globalPreset: "read_only" });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/global preset/i);
  });

  it("honors explicit tool deny override even when preset would allow", () => {
    store.createPending({ clientId: "pmc_1", clientName: "A" });
    store.approve({
      clientId: "pmc_1",
      preset: "full",
      toolOverrides: { delete_email: false },
    });
    const r = mgr.check({ clientId: "pmc_1", tool: "delete_email", globalPreset: "full" });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/explicitly denied/i);
  });

  it("applies a saved legacy alias override to the canonical tool", () => {
    store.createPending({ clientId: "pmc_1", clientName: "A" });
    store.approve({
      clientId: "pmc_1",
      preset: "full",
      toolOverrides: { bulk_delete: false } as never,
    });
    expect(mgr.check({ clientId: "pmc_1", tool: "bulk_delete", globalPreset: "full" }).allowed).toBe(false);
    expect(mgr.check({ clientId: "pmc_1", tool: "bulk_delete_emails", globalPreset: "full" }).allowed).toBe(false);
  });

  it("auto-expires a grant whose expiresAt has passed", () => {
    store.createPending({ clientId: "pmc_1", clientName: "A" });
    store.approve({
      clientId: "pmc_1",
      preset: "read_only",
      conditions: { expiresAt: new Date(Date.now() - 1_000).toISOString() },
    });
    const r = mgr.check({ clientId: "pmc_1", tool: "get_emails", globalPreset: "full" });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/expired/i);
    expect(store.get("pmc_1")?.status).toBe("expired");
  });

  it("honors IP pins: allow matching, deny mismatched", () => {
    store.createPending({ clientId: "pmc_1", clientName: "A" });
    store.approve({
      clientId: "pmc_1",
      preset: "read_only",
      conditions: { ipPins: ["10.0.0.5"] },
    });
    expect(
      mgr.check({ clientId: "pmc_1", tool: "get_emails", globalPreset: "full", callerIp: "10.0.0.5" }).allowed,
    ).toBe(true);
    expect(
      mgr.check({ clientId: "pmc_1", tool: "get_emails", globalPreset: "full", callerIp: "10.0.0.6" }).allowed,
    ).toBe(false);
  });

  it("enforces folderAllowlist against the call's folder arg", () => {
    store.createPending({ clientId: "pmc_1", clientName: "A" });
    store.approve({
      clientId: "pmc_1",
      preset: "read_only",
      conditions: { folderAllowlist: ["INBOX", "Sent"] },
    });
    expect(
      mgr.check({
        clientId: "pmc_1", tool: "get_emails", globalPreset: "full",
        args: { folder: "INBOX" },
      }).allowed,
    ).toBe(true);
    expect(
      mgr.check({
        clientId: "pmc_1", tool: "get_emails", globalPreset: "full",
        args: { folder: "Secret" },
      }).allowed,
    ).toBe(false);
  });

  it("skips folder check when the call has no folder-like arg (tool not folder-scoped)", () => {
    store.createPending({ clientId: "pmc_1", clientName: "A" });
    store.approve({
      clientId: "pmc_1",
      preset: "read_only",
      conditions: { folderAllowlist: ["INBOX"] },
    });
    const r = mgr.check({ clientId: "pmc_1", tool: "get_connection_status", globalPreset: "full" });
    expect(r.allowed).toBe(true);
  });

  // ── PERM-011: folder allowlist bypass via email-ID-scoped mutators ──────────
  it("enforces folderAllowlist against a convenience move's sourceFolder arg", () => {
    store.createPending({ clientId: "pmc_1", clientName: "A" });
    store.approve({
      clientId: "pmc_1",
      preset: "full",
      // move_to_trash moves mail to the literal Trash target, so a grant that permits the source
      // but not the derived destination must still be denied.
      conditions: { folderAllowlist: ["INBOX", "Trash"] },
    });
    // move_to_trash targeting a UID in Archive must be blocked: the grant
    // permits INBOX as a source and Trash only as its derived destination.
    expect(
      mgr.check({
        clientId: "pmc_1", tool: "move_to_trash", globalPreset: "full",
        args: { emailId: "42", sourceFolder: "Archive" },
      }).allowed,
    ).toBe(false);
    // Same tool against an allowed folder still passes.
    expect(
      mgr.check({
        clientId: "pmc_1", tool: "move_to_trash", globalPreset: "full",
        args: { emailId: "42", sourceFolder: "INBOX" },
      }).allowed,
    ).toBe(true);
  });

  it("fails closed for an email-ID-scoped tool with no sourceFolder when allowlisted", () => {
    store.createPending({ clientId: "pmc_1", clientName: "A" });
    store.approve({
      clientId: "pmc_1",
      preset: "full",
      conditions: { folderAllowlist: ["INBOX"] },
    });
    const r = mgr.check({
      clientId: "pmc_1", tool: "delete_email", globalPreset: "full",
      args: { emailId: "42" },
    });
    expect(r.allowed).toBe(false);
    // The dynamic Trash destination is evaluated only after the source. This
    // keeps an omitted source from being treated as safely scoped merely
    // because the ultimate special-use folder is also unresolved.
    expect(r.reason).toMatch(/sourceFolder.*explicit non-empty/i);
  });

  it("requires explicit allowed folders for direct by-ID content tools", () => {
    store.createPending({ clientId: "pmc_1", clientName: "A" });
    store.approve({ clientId: "pmc_1", preset: "full", conditions: { folderAllowlist: ["INBOX"] } });

    // The reading handlers now honor this folder scope too. In particular,
    // get_thread searches the caller's allowed folders rather than assuming
    // INBOX+Sent, so an INBOX-only grant remains usable when its seed is INBOX.
    for (const tool of [
      "get_email_by_id", "download_attachment", "get_thread",
      "extract_action_items", "extract_meeting", "reply_to_email", "forward_email",
    ]) {
      expect(
        mgr.check({ clientId: "pmc_1", tool, globalPreset: "full", args: { emailId: "42" } }).allowed,
      ).toBe(false);
      expect(
        mgr.check({ clientId: "pmc_1", tool, globalPreset: "full", args: { emailId: "42", folder: "INBOX" } }).allowed,
      ).toBe(true);
    }
  });

  it("checks every search folder instead of accepting the first allowed one", () => {
    store.createPending({ clientId: "pmc_1", clientName: "A" });
    store.approve({
      clientId: "pmc_1",
      preset: "full",
      conditions: { folderAllowlist: ["INBOX", "Sent"] },
    });
    const base = { clientId: "pmc_1", tool: "search_emails", globalPreset: "full" as const };

    // `folders` overrides the otherwise-allowed single `folder`; the former
    // first-folder extraction checked INBOX and missed Archive entirely.
    expect(mgr.check({ ...base, args: { folder: "INBOX", folders: ["INBOX", "Archive"] } }).allowed).toBe(false);
    expect(mgr.check({ ...base, args: { folders: ["INBOX", "Sent"] } }).allowed).toBe(true);
    expect(mgr.check({ ...base, args: { folder: "INBOX", folders: ["Sent"] } }).allowed).toBe(false);
    // Whole-mailbox sentinels expand in the IMAP service and cannot be proven
    // within an allowlist, regardless of an accompanying allowed folder arg.
    expect(mgr.check({ ...base, args: { folder: "INBOX", folders: ["*"] } }).allowed).toBe(false);
    expect(mgr.check({ ...base, args: { folders: ["all"] } }).allowed).toBe(false);
    // Restricted callers must state a real search set rather than triggering
    // the IMAP layer's historical empty-array fallback.
    expect(mgr.check({ ...base, args: { folders: [] } }).allowed).toBe(false);
  });

  it("maps label reads and handler-filtered content to their real folder scope", () => {
    store.createPending({ clientId: "pmc_1", clientName: "A" });
    store.approve({
      clientId: "pmc_1",
      preset: "full",
      conditions: { folderAllowlist: ["INBOX", "Labels/Work"] },
    });
    const base = { clientId: "pmc_1", globalPreset: "full" as const };

    expect(mgr.check({ ...base, tool: "get_emails_by_label", args: { label: "Work" } }).allowed).toBe(true);
    expect(mgr.check({ ...base, tool: "get_emails_by_label", args: { label: "Secret" } }).allowed).toBe(false);
    // fts_search supplies the final allowlist to the index when no folder is
    // given; an explicit request outside it is still rejected here.
    expect(mgr.check({ ...base, tool: "fts_search", args: { query: "invoice" } }).allowed).toBe(true);
    expect(mgr.check({ ...base, tool: "fts_search", args: { query: "invoice", folder: "Archive" } }).allowed).toBe(false);
    // The drafts handler filters its fixed Proton scheduled-mail candidates
    // before probing them, so policy marks that scope explicitly rather than
    // using the broad folder-agnostic fallback.
    expect(mgr.check({ ...base, tool: "list_proton_scheduled" }).allowed).toBe(true);
  });

  it("fails closed for a draft destination that cannot be proven allowlisted", () => {
    store.createPending({ clientId: "pmc_1", clientName: "A" });
    store.approve({
      clientId: "pmc_1",
      preset: "full",
      conditions: { folderAllowlist: ["INBOX"] },
    });
    expect(mgr.check({ clientId: "pmc_1", tool: "save_draft", globalPreset: "full" })).toMatchObject({
      allowed: false,
      reason: expect.stringMatching(/server-resolved special-use mailbox/i),
    });
  });

  it("validates every statically-resolvable mailbox-mutation source, destination, and derived folder", () => {
    const allMutationFolders = [
      "INBOX", "Archive", "Trash", "Spam", "Drafts",
      "Folders/Work", "Folders/Old", "Folders/New", "Labels/Work",
    ];
    store.createPending({ clientId: "pmc_mutations", clientName: "Mutation scope" });
    store.approve({
      clientId: "pmc_mutations",
      preset: "full",
      conditions: { folderAllowlist: allMutationFolders },
    });
    const base = { clientId: "pmc_mutations", globalPreset: "full" as const };

    // This table deliberately covers every IMAP-mutating matrix entry. A new
    // mutation must either be added here with its provenance or fail closed via
    // the ordinary folder gate.
    const allowed: Array<{ tool: string; args?: Record<string, unknown> }> = [
      { tool: "mark_email_read", args: { sourceFolder: "INBOX" } },
      { tool: "star_email", args: { sourceFolder: "INBOX" } },
      { tool: "mark_answered", args: { sourceFolder: "INBOX" } },
      { tool: "mark_forwarded", args: { sourceFolder: "INBOX" } },
      { tool: "bulk_mark_read", args: { sourceFolder: "INBOX" } },
      { tool: "bulk_star", args: { sourceFolder: "INBOX" } },
      { tool: "move_email", args: { sourceFolder: "INBOX", targetFolder: "Archive" } },
      { tool: "bulk_move_emails", args: { sourceFolder: "INBOX", targetFolder: "Archive" } },
      { tool: "move_to_folder", args: { sourceFolder: "INBOX", folder: "Work" } },
      { tool: "archive_email", args: { sourceFolder: "INBOX" } },
      { tool: "move_to_trash", args: { sourceFolder: "INBOX" } },
      { tool: "move_to_spam", args: { sourceFolder: "INBOX" } },
      { tool: "move_to_label", args: { sourceFolder: "INBOX", label: "Work" } },
      { tool: "bulk_move_to_label", args: { sourceFolder: "INBOX", label: "Work" } },
      { tool: "remove_label", args: { label: "Work" } },
      { tool: "bulk_remove_label", args: { label: "Work" } },
      { tool: "create_folder", args: { folderName: "Folders/New" } },
      { tool: "delete_folder", args: { folderName: "Folders/Old" } },
      { tool: "rename_folder", args: { oldName: "Folders/Old", newName: "Folders/New" } },
    ];
    for (const { tool, args } of allowed) {
      expect(mgr.check({ ...base, tool, args }).allowed, tool).toBe(true);
    }
    // Labels preserve their leaf spelling in the handlers. Do not trim a
    // derived destination into a neighboring allowlisted label.
    expect(mgr.check({
      ...base,
      tool: "move_to_label",
      args: { sourceFolder: "INBOX", label: " Work" },
    }).allowed).toBe(false);

    // `delete_email`, `bulk_delete_emails`, `empty_trash`, and `save_draft`
    // resolve a special-use mailbox from the active IMAP server. The grant
    // gate intentionally has no account-folder lookup, so even an English
    // special-use name in the allowlist cannot stand in for a physical path.
    for (const { tool, args } of [
      { tool: "delete_email", args: { sourceFolder: "INBOX" } },
      { tool: "bulk_delete_emails", args: { sourceFolder: "INBOX" } },
      { tool: "empty_trash", args: {} },
      { tool: "save_draft", args: {} },
    ]) {
      expect(mgr.check({ ...base, tool, args }).allowed, tool).toBe(false);
    }

    store.createPending({ clientId: "pmc_narrow", clientName: "Narrow mutation scope" });
    store.approve({
      clientId: "pmc_narrow",
      preset: "full",
      conditions: { folderAllowlist: ["INBOX"] },
    });
    const narrow = { clientId: "pmc_narrow", globalPreset: "full" as const };

    // An allowed-looking source cannot conceal an excluded destination, and an
    // allowed destination cannot conceal an excluded source. Derived label and
    // fixed special-folder targets are enforced just as strictly.
    for (const { tool, args } of [
      { tool: "move_email", args: { sourceFolder: "Archive", targetFolder: "INBOX" } },
      { tool: "move_email", args: { sourceFolder: "INBOX", targetFolder: "Archive" } },
      { tool: "move_to_folder", args: { sourceFolder: "INBOX", folder: "Work" } },
      { tool: "move_to_label", args: { sourceFolder: "INBOX", label: "Work" } },
      { tool: "remove_label", args: { label: "Work" } },
      { tool: "archive_email", args: { sourceFolder: "INBOX" } },
      { tool: "delete_email", args: { sourceFolder: "INBOX" } },
      { tool: "empty_trash", args: {} },
      { tool: "rename_folder", args: { oldName: "INBOX", newName: "Folders/Work" } },
      { tool: "save_draft", args: {} },
    ]) {
      expect(mgr.check({ ...narrow, tool, args }).allowed, tool).toBe(false);
    }
  });

  it("fails closed for localized runtime special-use destinations instead of authorizing English aliases", () => {
    store.createPending({ clientId: "pmc_localized", clientName: "Localized mailbox" });
    store.approve({
      clientId: "pmc_localized",
      preset: "full",
      // These are the real paths reported by a localized IMAP server, not the
      // English UI labels. The mutation matrix must not claim it can prove the
      // target merely because it knows a logical Trash/Drafts capability.
      conditions: { folderAllowlist: ["INBOX", "Papelera", "Brouillons"] },
    });
    const base = { clientId: "pmc_localized", globalPreset: "full" as const };

    for (const { tool, args } of [
      { tool: "delete_email", args: { sourceFolder: "INBOX" } },
      { tool: "bulk_delete_emails", args: { sourceFolder: "INBOX" } },
      { tool: "empty_trash", args: {} },
      { tool: "save_draft", args: {} },
    ]) {
      expect(mgr.check({ ...base, tool, args })).toMatchObject({
        allowed: false,
        reason: expect.stringMatching(/server-resolved special-use mailbox/i),
      });
    }
  });

  it("scopes sync_emails including its implicit INBOX default", () => {
    store.createPending({ clientId: "pmc_inbox", clientName: "INBOX sync" });
    store.approve({
      clientId: "pmc_inbox",
      preset: "full",
      conditions: { folderAllowlist: ["INBOX"] },
    });
    const inbox = { clientId: "pmc_inbox", tool: "sync_emails", globalPreset: "full" as const };
    expect(mgr.check(inbox).allowed).toBe(true);
    expect(mgr.check({ ...inbox, args: { folder: "Archive" } }).allowed).toBe(false);

    store.createPending({ clientId: "pmc_archive", clientName: "Archive sync" });
    store.approve({
      clientId: "pmc_archive",
      preset: "full",
      conditions: { folderAllowlist: ["Archive"] },
    });
    const archive = { clientId: "pmc_archive", tool: "sync_emails", globalPreset: "full" as const };
    // Omitted means INBOX, not "any configured folder".
    expect(mgr.check(archive).allowed).toBe(false);
    expect(mgr.check({ ...archive, args: { folder: "Archive" } }).allowed).toBe(true);
  });

  // ── SEC-RATE-001: grant-scoped hourly per-tool caps ───────────────────────
  it("enforces a rolling hourly cap per client and tool", () => {
    store.createPending({ clientId: "pmc_1", clientName: "A" });
    store.approve({
      clientId: "pmc_1",
      preset: "full",
      conditions: { maxCallsPerHourByTool: { get_emails: 2 } },
    });
    const ctx = { clientId: "pmc_1", tool: "get_emails", globalPreset: "full" as const };

    expect(mgr.check(ctx).allowed).toBe(true);
    expect(mgr.check(ctx).allowed).toBe(true);
    const exhausted = mgr.check(ctx);
    expect(exhausted.allowed).toBe(false);
    expect(exhausted.reason).toMatch(/cap of 2 calls\/hour/i);
  });

  it("treats an explicit cap of zero as deny-all, not unlimited", () => {
    store.createPending({ clientId: "pmc_1", clientName: "A" });
    store.approve({
      clientId: "pmc_1",
      preset: "full",
      conditions: { maxCallsPerHourByTool: { get_emails: 0 } },
    });

    const result = mgr.check({ clientId: "pmc_1", tool: "get_emails", globalPreset: "full" });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/capped at 0 calls\/hour/i);
  });

  it("fails closed for an out-of-range cap loaded from a persisted grant", () => {
    writeFileSync(path, JSON.stringify({
      version: 1,
      grants: [{
        clientId: "pmc_1",
        clientName: "A",
        status: "active",
        preset: "full",
        createdAt: "2026-01-01T00:00:00.000Z",
        totalCalls: 0,
        conditions: { maxCallsPerHourByTool: { get_emails: 10_001 } },
      }],
    }), "utf-8");
    store.close();
    store = new AgentGrantStore(path);
    mgr = new GrantManager(store);

    const result = mgr.check({ clientId: "pmc_1", tool: "get_emails", globalPreset: "full" });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/unavailable.*fail-closed/i);
  });

  it("distinguishes an unavailable durable quota ledger from cap exhaustion", () => {
    store.createPending({ clientId: "pmc_1", clientName: "A" });
    store.approve({
      clientId: "pmc_1",
      preset: "full",
      conditions: { maxCallsPerHourByTool: { get_emails: 1 } },
    });
    writeFileSync(`${path}.quota.sqlite`, "not a sqlite database", "utf-8");

    const result = mgr.check({ clientId: "pmc_1", tool: "get_emails", globalPreset: "full" });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/quota ledger is unavailable; denied fail-closed/i);
  });

  it("shares a durable canonical bucket between an alias invocation and a legacy alias cap key", () => {
    // Simulate a legacy/manual grant file from before alias keys were
    // normalized at the Settings write boundary.
    writeFileSync(path, JSON.stringify({
      version: 1,
      grants: [{
        clientId: "pmc_1",
        clientName: "A",
        status: "active",
        preset: "full",
        createdAt: "2026-01-01T00:00:00.000Z",
        totalCalls: 0,
        conditions: { maxCallsPerHourByTool: { bulk_delete: 1 } },
      }],
    }), "utf-8");
    // The beforeEach store loaded before this raw fixture, so use a fresh
    // instance to exercise disk reload exactly as a daemon restart would.
    store.close();
    store = new AgentGrantStore(path);
    mgr = new GrantManager(store);

    expect(mgr.check({ clientId: "pmc_1", tool: "bulk_delete", globalPreset: "full" }).allowed).toBe(true);
    store.close();

    // A fresh connection must retain the alias call's durable canonical slot.
    store = new AgentGrantStore(path);
    mgr = new GrantManager(store);
    const canonicalAttempt = mgr.check({ clientId: "pmc_1", tool: "bulk_delete_emails", globalPreset: "full" });
    expect(canonicalAttempt.allowed).toBe(false);
    expect(canonicalAttempt.reason).toMatch(/bulk_delete_emails.*cap of 1/i);
  });

  it("keeps hourly buckets isolated per client", () => {
    for (const clientId of ["pmc_a", "pmc_b"]) {
      store.createPending({ clientId, clientName: clientId });
      store.approve({
        clientId,
        preset: "full",
        conditions: { maxCallsPerHourByTool: { get_emails: 1 } },
      });
    }

    expect(mgr.check({ clientId: "pmc_a", tool: "get_emails", globalPreset: "full" }).allowed).toBe(true);
    expect(mgr.check({ clientId: "pmc_b", tool: "get_emails", globalPreset: "full" }).allowed).toBe(true);
    expect(mgr.check({ clientId: "pmc_a", tool: "get_emails", globalPreset: "full" }).allowed).toBe(false);
    expect(mgr.check({ clientId: "pmc_b", tool: "get_emails", globalPreset: "full" }).allowed).toBe(false);
  });

  it("does not reserve while dispatch is still in preflight or globally denied", () => {
    store.createPending({ clientId: "pmc_1", clientName: "A" });
    store.approve({
      clientId: "pmc_1",
      preset: "full",
      conditions: { maxCallsPerHourByTool: { delete_email: 1 } },
    });
    const allowedCtx = { clientId: "pmc_1", tool: "delete_email", globalPreset: "full" as const };

    // The normal dispatcher performs this preflight before the server-wide
    // permission and destructive-confirmation gates, so it must not charge.
    expect(mgr.check(allowedCtx, { reserveHourlyToolSlot: false }).allowed).toBe(true);
    // A global-preset denial exits before the final reserving check.
    expect(mgr.check({ ...allowedCtx, globalPreset: "read_only" }).allowed).toBe(false);
    // The first actually dispatchable call still owns the only slot.
    expect(mgr.check(allowedCtx).allowed).toBe(true);
    expect(mgr.check(allowedCtx).allowed).toBe(false);
  });

  it("reserves resource/prompt backing tools too, so read surfaces cannot bypass a cap", () => {
    store.createPending({ clientId: "pmc_1", clientName: "A" });
    store.approve({
      clientId: "pmc_1",
      preset: "full",
      // requireReadSurfaceAccess uses get_folders to gate resource listing.
      conditions: { maxCallsPerHourByTool: { get_folders: 1 } },
    });
    const resourceGate = { clientId: "pmc_1", tool: "get_folders", globalPreset: "full" as const };

    expect(mgr.check(resourceGate, { reserveHourlyToolSlot: false }).allowed).toBe(true);
    expect(mgr.check(resourceGate).allowed).toBe(true);
    expect(mgr.check(resourceGate).allowed).toBe(false);
  });

  it("atomically reserves no more than the cap across concurrent async callers", async () => {
    store.createPending({ clientId: "pmc_1", clientName: "A" });
    store.approve({
      clientId: "pmc_1",
      preset: "full",
      conditions: { maxCallsPerHourByTool: { get_emails: 3 } },
    });
    const ctx = { clientId: "pmc_1", tool: "get_emails", globalPreset: "full" as const };

    const results = await Promise.all(
      Array.from({ length: 12 }, () => Promise.resolve().then(() => mgr.check(ctx))),
    );
    expect(results.filter(result => result.allowed)).toHaveLength(3);
    expect(results.filter(result => !result.allowed)).toHaveLength(9);
  });

  // ── PERM-013: custom preset must not widen via intersection ─────────────────
  it("does not let a custom grant preset inherit another preset's enabled map", () => {
    store.createPending({ clientId: "pmc_1", clientName: "A" });
    // grant preset = custom, with delete_email explicitly disabled. The global
    // preset (supervised) DOES allow delete_email. The old rank table treated
    // custom == full, so intersectPresets returned "supervised" and the gate
    // consulted supervised's map — re-enabling the tool the user disabled.
    store.approve({
      clientId: "pmc_1",
      preset: "custom",
      toolOverrides: { delete_email: false },
    });
    const r = mgr.check({ clientId: "pmc_1", tool: "delete_email", globalPreset: "supervised" });
    expect(r.allowed).toBe(false);
  });

  it("a custom grant only allows tools it explicitly overrides to true", () => {
    store.createPending({ clientId: "pmc_1", clientName: "A" });
    store.approve({
      clientId: "pmc_1",
      preset: "custom",
      toolOverrides: { get_emails: true },
    });
    // Explicitly enabled, and within the global ceiling.
    expect(
      mgr.check({ clientId: "pmc_1", tool: "get_emails", globalPreset: "full" }).allowed,
    ).toBe(true);
    // Not overridden → default-deny under custom (no preset map to fall back on).
    expect(
      mgr.check({ clientId: "pmc_1", tool: "send_email", globalPreset: "full" }).allowed,
    ).toBe(false);
  });
});
