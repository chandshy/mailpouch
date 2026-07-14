import { describe, expect, it, vi } from "vitest";
import {
  guardBridgeCall,
  unclassifiedBridgeMutationTools,
  type BridgeOwnershipProbe,
} from "./e2e/support/bridge-safety.js";
import { runToken } from "./e2e/support/scratch.js";
import {
  assertE2EMailboxIdentity,
  E2E_MAILBOX_IDENTITY_ARG,
  withE2EMailboxIdentity,
} from "../src/config/e2e-mailbox-identity.js";

function harnessState() {
  const token = runToken();
  const owned = new Set<string>();
  const existing = new Set<string>();
  const claimed = new Set<string>();
  const key = (folder: string, uid: number) => `${folder}:${uid}`;
  const imap: BridgeOwnershipProbe = {
    isOwnedMessage: vi.fn(async (folder, uid) => owned.has(key(folder, uid))),
    proveOwnedMutation: vi.fn(async (folder, uids) => {
      if (folder !== "INBOX" && !claimed.has(folder)) {
        return { ok: false as const, reason: "mailbox-identity" as const };
      }
      for (const uid of uids) {
        if (!owned.has(key(folder, uid))) {
          return { ok: false as const, reason: "unowned" as const, uid };
        }
      }
      return { ok: true as const, uidValidity: "1" };
    }),
    uidExists: vi.fn(async (folder, uid) => existing.has(key(folder, uid))),
    listUids: vi.fn(async (folder) => [...existing]
      .filter((entry) => entry.startsWith(`${folder}:`))
      .map((entry) => Number(entry.slice(entry.lastIndexOf(":") + 1)))),
    countMessages: vi.fn(async (folder) => [...existing]
      .filter((entry) => entry.startsWith(`${folder}:`)).length),
    isAllMailMailbox: vi.fn(async (folder) => /^all mail$/i.test(folder)),
    isCreatedMailbox: vi.fn(async (folder) => claimed.has(folder)),
    draftsMailbox: vi.fn(async () => "Drafts"),
  };
  return {
    token,
    owned,
    existing,
    claimed,
    key,
    ctx: { token, accountEmail: "owner@proton.test", imap },
  };
}

describe("live Bridge E2E mutation guard", () => {
  it("allows registry-declared read-only tools and local refreshes", async () => {
    const h = harnessState();
    await expect(guardBridgeCall("get_emails", { folder: "INBOX" }, h.ctx)).resolves.toBeUndefined();
    await expect(guardBridgeCall("sync_emails", { folder: "INBOX" }, h.ctx)).resolves.toBeUndefined();
    expect(h.ctx.imap.isOwnedMessage).not.toHaveBeenCalled();
  });

  it("allows a mutation only after exact folder+UID ownership succeeds", async () => {
    const h = harnessState();
    const scratch = `Folders/${h.token}-source`;
    h.claimed.add(scratch);
    h.owned.add(h.key(scratch, 42));
    h.existing.add(h.key(scratch, 42));
    const args = {
      emailId: "42",
      sourceFolder: scratch,
    };
    await expect(guardBridgeCall("mark_email_read", args, h.ctx)).resolves.toBeUndefined();
    expect(args).toHaveProperty(E2E_MAILBOX_IDENTITY_ARG, {
      token: h.token,
      folder: scratch,
      uidValidity: "1",
      uids: ["42"],
    });
    await expect(guardBridgeCall("star_email", {
      emailId: "42",
      sourceFolder: "Archive",
    }, h.ctx)).rejects.toThrow(/exclusive scratch source/i);
  });

  it("requires an explicit source and allows only exact-owned INBOX UIDs", async () => {
    const h = harnessState();
    h.owned.add(h.key("INBOX", 42));

    await expect(guardBridgeCall("mark_email_read", {
      emailId: "42",
    }, h.ctx)).rejects.toThrow(/explicit.*sourceFolder/i);
    await expect(guardBridgeCall("mark_email_read", {
      emailId: "42",
      sourceFolder: "INBOX",
    }, h.ctx)).resolves.toBeUndefined();
    expect(h.ctx.imap.proveOwnedMutation).toHaveBeenCalledWith("INBOX", [42], h.token);
  });

  it("passes an exact-owned INBOX proof through the child parser and wire fence", async () => {
    const h = harnessState();
    h.owned.add(h.key("INBOX", 42));
    const args: Record<string, unknown> = {
      emailId: "42",
      sourceFolder: "INBOX",
    };
    await guardBridgeCall("mark_email_read", args, h.ctx);
    const env = {
      MAILPOUCH_E2E_CONFIG_ONLY_CREDENTIALS: "1",
      MAILPOUCH_E2E_RUN_TOKEN: h.token,
    } as NodeJS.ProcessEnv;

    expect(() => withE2EMailboxIdentity(
      args,
      () => assertE2EMailboxIdentity("INBOX", ["42"], { uidValidity: 1n }, env),
      env,
    )).not.toThrow();
  });

  it("refuses a token-shaped source without positive mailbox identity proof", async () => {
    const h = harnessState();
    const scratch = `Folders/${h.token}-unclaimed`;
    h.owned.add(h.key(scratch, 42));

    await expect(guardBridgeCall("mark_email_read", {
      emailId: "42",
      sourceFolder: scratch,
    }, h.ctx)).rejects.toThrow(/no positive mailbox-creation proof/i);
    expect(h.ctx.imap.isOwnedMessage).not.toHaveBeenCalled();
  });

  it("refuses every absent or unowned UID, including in a claimed scratch folder", async () => {
    const h = harnessState();
    const scratch = `Folders/${h.token}-negative`;
    h.claimed.add(scratch);
    await expect(guardBridgeCall("bulk_mark_read", {
      emailIds: ["4294967295"],
      sourceFolder: scratch,
    }, h.ctx)).rejects.toThrow(/not owned/i);
    await expect(guardBridgeCall("bulk_mark_read", {
      emailIds: ["4294967295"],
      sourceFolder: "INBOX",
    }, h.ctx)).rejects.toThrow(/not owned/i);
  });

  it("rejects one unowned existing UID before dispatching the entire bulk call", async () => {
    const h = harnessState();
    const scratch = `Folders/${h.token}-bulk`;
    h.claimed.add(scratch);
    h.owned.add(h.key(scratch, 1));
    h.existing.add(h.key(scratch, 1));
    h.existing.add(h.key(scratch, 2));
    await expect(guardBridgeCall("bulk_star", {
      emailIds: ["1", "2"],
      sourceFolder: scratch,
    }, h.ctx)).rejects.toThrow(/UID 2.*not owned/i);
  });

  it("refuses every mutation sourced from the unstable All Mail projection", async () => {
    const h = harnessState();
    h.owned.add(h.key("All Mail", 42));
    h.existing.add(h.key("All Mail", 42));
    const target = `Folders/${h.token}-target`;

    await expect(guardBridgeCall("mark_email_read", {
      emailId: "42",
      sourceFolder: "All Mail",
    }, h.ctx)).rejects.toThrow(/remap All Mail UIDs/i);
    await expect(guardBridgeCall("bulk_move_emails", {
      emailIds: ["42"],
      sourceFolder: "All Mail",
      targetFolder: target,
    }, h.ctx)).rejects.toThrow(/remap All Mail UIDs/i);
    expect(h.ctx.imap.isOwnedMessage).not.toHaveBeenCalled();
  });

  it("allows Archive as a system move target and requires proofs for custom targets", async () => {
    const h = harnessState();
    const source = `Folders/${h.token}-source`;
    h.claimed.add(source);
    h.owned.add(h.key(source, 7));
    const target = `Folders/${h.token}-target`;
    h.claimed.add(target);
    await expect(guardBridgeCall("move_email", {
      emailId: "7",
      sourceFolder: source,
      targetFolder: target,
    }, h.ctx)).resolves.toBeUndefined();
    await expect(guardBridgeCall("move_email", {
      emailId: "7",
      sourceFolder: source,
      targetFolder: "Archive",
    }, h.ctx)).resolves.toBeUndefined();
    await expect(guardBridgeCall("move_email", {
      emailId: "7",
      sourceFolder: source,
      targetFolder: `Folders/${h.token}-unclaimed-target`,
    }, h.ctx)).rejects.toThrow(/no current identity-bound mailbox-creation proof/i);
    await expect(guardBridgeCall("delete_folder", {
      folderName: "Folders/Personal",
      confirmed: true,
    }, h.ctx)).rejects.toThrow(/Scratch guard REFUSED/);
  });

  it("refuses live folder delete and rename even for run scratch paths", async () => {
    const h = harnessState();
    const folder = `Folders/${h.token}-folder`;
    const renamed = `Folders/${h.token}-renamed`;
    await expect(guardBridgeCall("delete_folder", { folderName: folder }, h.ctx))
      .rejects.toThrow(/no atomic delete-if-empty/i);
    await expect(guardBridgeCall("rename_folder", {
      oldName: folder,
      newName: renamed,
    }, h.ctx)).rejects.toThrow(/contents can change/i);
    expect(h.ctx.imap.countMessages).not.toHaveBeenCalled();
    expect(h.ctx.imap.listUids).not.toHaveBeenCalled();
  });

  it("refuses live folder creation even for a run scratch path", async () => {
    const h = harnessState();
    await expect(guardBridgeCall("create_folder", {
      folderName: `Folders/${h.token}-folder`,
    }, h.ctx)).rejects.toThrow(/cannot later be deleted atomically/i);
  });

  it("requires strict run labels and validates label-folder UIDs", async () => {
    const h = harnessState();
    const label = `${h.token}-label`;
    const folder = `Labels/${label}`;
    h.claimed.add(folder);
    h.owned.add(h.key(folder, 9));
    await expect(guardBridgeCall("remove_label", { emailId: "9", label }, h.ctx)).resolves.toBeUndefined();
    await expect(guardBridgeCall("remove_label", {
      emailId: "9",
      label: "Priority",
    }, h.ctx)).rejects.toThrow(/Scratch guard REFUSED/);
  });

  it("restricts SMTP and drafts to self with an exact run-token subject", async () => {
    const h = harnessState();
    const subject = `${h.token} delivery probe`;
    await expect(guardBridgeCall("send_email", {
      to: h.ctx.accountEmail,
      subject,
      body: "probe",
    }, h.ctx)).resolves.toEqual({ kind: "adopt-sent", expectedSubject: subject });
    await expect(guardBridgeCall("save_draft", {
      to: h.ctx.accountEmail,
      subject,
      body: "probe",
    }, h.ctx)).resolves.toEqual({ kind: "adopt-draft", folder: "Drafts", expectedSubject: subject });
    await expect(guardBridgeCall("send_email", {
      to: "someone-else@example.test",
      subject,
      body: "probe",
    }, h.ctx)).rejects.toThrow(/only to the configured/i);
    await expect(guardBridgeCall("send_email", {
      to: h.ctx.accountEmail,
      bcc: "someone-else@example.test",
      subject,
      body: "probe",
    }, h.ctx)).rejects.toThrow(/bcc/i);
    await expect(guardBridgeCall("save_draft", {
      to: h.ctx.accountEmail,
      subject: "untagged",
    }, h.ctx)).rejects.toThrow(/run token/i);
    await expect(guardBridgeCall("send_test_email", {
      to: h.ctx.accountEmail,
      customMessage: `${h.token} delivery probe`,
    }, h.ctx)).resolves.toEqual({
      kind: "adopt-sent",
      expectedSubject: "Test Email from mailpouch",
      expectedBodyToken: h.token,
    });
  });

  it("refuses globally destructive, unadoptable, and unclassified mutations", async () => {
    const h = harnessState();
    await expect(guardBridgeCall("empty_trash", { confirmed: true }, h.ctx)).rejects.toThrow(/never permitted/i);
    await expect(guardBridgeCall("send_test_email", { to: h.ctx.accountEmail }, h.ctx)).rejects.toThrow(/customMessage/i);
    await expect(guardBridgeCall("schedule_email", {}, h.ctx)).rejects.toThrow(/not classified/i);
    await expect(guardBridgeCall("totally_new_mutator", {}, h.ctx)).rejects.toThrow(/not classified/i);
    expect(unclassifiedBridgeMutationTools()).toContain("schedule_email");
    expect(unclassifiedBridgeMutationTools()).toContain("shutdown_server");
  });

  it("applies the same ownership policy to the bulk_delete compatibility alias", async () => {
    const h = harnessState();
    const scratch = `Folders/${h.token}-alias`;
    h.claimed.add(scratch);
    h.owned.add(h.key(scratch, 3));
    await expect(guardBridgeCall("bulk_delete", {
      emailIds: ["3"],
      sourceFolder: scratch,
      confirmed: true,
    }, h.ctx)).resolves.toBeUndefined();
  });
});
