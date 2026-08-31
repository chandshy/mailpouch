import { describe, expect, it, vi } from "vitest";
import * as mod from "./drafts.js";
import type { ToolCallContext, ToolResult } from "./types.js";

function makeCtx(over: Partial<ToolCallContext>): ToolCallContext {
  const ok = (structured: Record<string, unknown>): ToolResult => ({
    content: [{ type: "text", text: JSON.stringify(structured) }],
    structuredContent: structured,
  });
  const actionOk = (): ToolResult => ({
    content: [{ type: "text", text: "Done." }],
    structuredContent: { success: true },
  });
  return {
    accountId: "account-a",
    accountIdentity: "mailbox-a-v1",
    ok,
    actionOk,
    MAX_SUBJECT_LENGTH: 998,
    MAX_BODY_LENGTH: 10 * 1024 * 1024,
    safeErrorMessage: error => error instanceof Error ? error.message : String(error),
    ...over,
  } as unknown as ToolCallContext;
}

describe("draft scheduling and reminder account routing", () => {
  it("passes the dispatcher-resolved owner to scheduled-email operations", async () => {
    const schedule = vi.fn().mockReturnValue("0a0a0a0a-0000-4000-8000-000000000000");
    const list = vi.fn().mockReturnValue([]);
    const cancel = vi.fn().mockReturnValue({ ok: true });
    const schedulerService = { schedule, list, cancel } as unknown as ToolCallContext["schedulerService"];
    const sendAt = new Date(Date.now() + 120_000).toISOString();

    await mod.handlers.schedule_email(makeCtx({
      args: { to: "recipient@example.com", subject: "Hello", body: "Body", send_at: sendAt },
      schedulerService,
    }));
    await mod.handlers.list_scheduled_emails(makeCtx({ args: {}, schedulerService }));
    await mod.handlers.cancel_scheduled_email(makeCtx({
      args: { id: "0a0a0a0a-0000-4000-8000-000000000000" },
      schedulerService,
    }));

    expect(schedule).toHaveBeenCalledWith(expect.objectContaining({ to: "recipient@example.com" }), new Date(sendAt), "account-a", "mailbox-a-v1");
    expect(list).toHaveBeenCalledWith("account-a");
    expect(cancel).toHaveBeenCalledWith("0a0a0a0a-0000-4000-8000-000000000000", "account-a");
  });

  it("passes the dispatcher-resolved owner to reminder persistence and scoped reads", async () => {
    const sentAt = new Date();
    const add = vi.fn().mockReturnValue({
      id: "r-123", accountId: "account-a", recipient: "recipient@example.com", subject: "Hello",
      fireAt: new Date(sentAt.getTime() + 86_400_000).toISOString(),
    });
    const listPending = vi.fn().mockReturnValue([]);
    const cancel = vi.fn().mockReturnValue(true);
    const scanDue = vi.fn().mockReturnValue([]);
    const prune = vi.fn().mockReturnValue(0);
    const reminderService = { add, listPending, cancel, scanDue, prune } as unknown as ToolCallContext["reminderService"];

    await mod.handlers.remind_if_no_reply(makeCtx({
      args: { email_id: "42", after_days: 1 },
      imapService: {
        getEmailById: vi.fn().mockResolvedValue({
          headers: { "message-id": "<outbound@example.com>" },
          date: sentAt,
          to: ["recipient@example.com"],
          subject: "Hello",
        }),
      } as unknown as ToolCallContext["imapService"],
      reminderService,
    }));
    await mod.handlers.list_pending_reminders(makeCtx({ args: {}, reminderService }));
    await mod.handlers.cancel_reminder(makeCtx({ args: { reminder_id: "r-123" }, reminderService }));
    await mod.handlers.check_reminders(makeCtx({ args: {}, reminderService }));

    expect(add).toHaveBeenCalledWith(expect.objectContaining({ accountId: "account-a", accountIdentity: "mailbox-a-v1", imapUid: "42" }));
    expect(listPending).toHaveBeenCalledWith("account-a");
    expect(cancel).toHaveBeenCalledWith("r-123", "account-a");
    expect(scanDue).toHaveBeenCalledWith(expect.any(Date), "account-a");
    expect(prune).toHaveBeenCalledWith(30, "account-a");
  });
});

describe("folder-restricted draft and reminder callers", () => {
  it("only probes allowlisted Proton scheduled-mail folders and filters returned records", async () => {
    const getEmails = vi.fn().mockResolvedValue([
      {
        id: "1", from: "sender@example.com", subject: "Scheduled", date: new Date(),
        folder: "Scheduled", isRead: false, isStarred: false, hasAttachment: false,
      },
      {
        id: "2", from: "sender@example.com", subject: "Wrong adapter result", date: new Date(),
        folder: "Archive", isRead: false, isStarred: false, hasAttachment: false,
      },
    ]);

    const result = await mod.handlers.list_proton_scheduled(makeCtx({
      args: {},
      getCallerAllowedFolders: () => ["Scheduled"],
      imapService: { getEmails } as unknown as ToolCallContext["imapService"],
    }));

    expect(getEmails).toHaveBeenCalledTimes(1);
    expect(getEmails).toHaveBeenCalledWith("Scheduled", 50);
    expect(result.structuredContent).toMatchObject({ count: 1, folder: "Scheduled" });
  });

  it("does not probe Proton scheduled-mail folders outside a restricted allowlist", async () => {
    const getEmails = vi.fn();
    await expect(mod.handlers.list_proton_scheduled(makeCtx({
      args: {},
      getCallerAllowedFolders: () => ["INBOX"],
      imapService: { getEmails } as unknown as ToolCallContext["imapService"],
    }))).rejects.toThrow(/no Proton scheduled-mail folder is in this agent's folder allowlist/);
    expect(getEmails).not.toHaveBeenCalled();
  });

  it("requires an allowlisted source folder before creating a no-reply reminder", async () => {
    const getEmailById = vi.fn();
    await expect(mod.handlers.remind_if_no_reply(makeCtx({
      args: { email_id: "42", folder: "Archive", after_days: 1 },
      getCallerAllowedFolders: () => ["Sent"],
      imapService: { getEmailById } as unknown as ToolCallContext["imapService"],
      reminderService: {} as ToolCallContext["reminderService"],
    }))).rejects.toThrow(/outside this agent's folder allowlist/);
    expect(getEmailById).not.toHaveBeenCalled();
  });

  it("uses the deterministic Sent default only when it is allowlisted", async () => {
    const sentAt = new Date();
    const getEmailById = vi.fn().mockResolvedValue({
      headers: { "message-id": "<outbound@example.com>" },
      date: sentAt,
      to: ["recipient@example.com"],
      subject: "Hello",
      folder: "Sent",
    });
    const add = vi.fn().mockReturnValue({
      id: "r-123", recipient: "recipient@example.com", subject: "Hello",
      fireAt: new Date(sentAt.getTime() + 86_400_000).toISOString(),
    });

    await mod.handlers.remind_if_no_reply(makeCtx({
      args: { email_id: "42", after_days: 1 },
      getCallerAllowedFolders: () => ["Sent"],
      imapService: { getEmailById } as unknown as ToolCallContext["imapService"],
      reminderService: { add } as unknown as ToolCallContext["reminderService"],
    }));

    expect(getEmailById).toHaveBeenCalledWith("42", "Sent");
  });

  it("rejects a colliding UID when IMAP resolves it in a different allowlisted folder", async () => {
    const getEmailById = vi.fn().mockResolvedValue({
      headers: { "message-id": "<outbound@example.com>" },
      date: new Date(),
      to: ["recipient@example.com"],
      subject: "Hello",
      folder: "Archive",
    });
    const add = vi.fn();

    await expect(mod.handlers.remind_if_no_reply(makeCtx({
      args: { email_id: "42", folder: "Sent", after_days: 1 },
      getCallerAllowedFolders: () => ["Sent", "Archive"],
      imapService: { getEmailById } as unknown as ToolCallContext["imapService"],
      reminderService: { add } as unknown as ToolCallContext["reminderService"],
    }))).rejects.toThrow(/rather than the requested folder/);

    expect(add).not.toHaveBeenCalled();
  });

  it("does not use the Sent default when that folder is excluded", async () => {
    const getEmailById = vi.fn();
    await expect(mod.handlers.remind_if_no_reply(makeCtx({
      args: { email_id: "42", after_days: 1 },
      getCallerAllowedFolders: () => ["INBOX"],
      imapService: { getEmailById } as unknown as ToolCallContext["imapService"],
      reminderService: {} as ToolCallContext["reminderService"],
    }))).rejects.toThrow(/outside this agent's folder allowlist/);
    expect(getEmailById).not.toHaveBeenCalled();
  });

  it("fails closed for account-scoped scheduled and reminder records without folder provenance", async () => {
    const schedulerList = vi.fn();
    const schedulerCancel = vi.fn();
    const listPending = vi.fn();
    const reminderCancel = vi.fn();
    const scanDue = vi.fn();
    const restricted = () => ["INBOX"];

    await expect(mod.handlers.list_scheduled_emails(makeCtx({
      args: {}, getCallerAllowedFolders: restricted,
      schedulerService: { list: schedulerList } as unknown as ToolCallContext["schedulerService"],
    }))).rejects.toThrow(/no source-folder provenance/);
    await expect(mod.handlers.cancel_scheduled_email(makeCtx({
      args: { id: "0a0a0a0a-0000-4000-8000-000000000000" }, getCallerAllowedFolders: restricted,
      schedulerService: { cancel: schedulerCancel } as unknown as ToolCallContext["schedulerService"],
    }))).rejects.toThrow(/no source-folder provenance/);
    await expect(mod.handlers.list_pending_reminders(makeCtx({
      args: {}, getCallerAllowedFolders: restricted,
      reminderService: { listPending } as unknown as ToolCallContext["reminderService"],
    }))).rejects.toThrow(/no source-folder provenance/);
    await expect(mod.handlers.cancel_reminder(makeCtx({
      args: { reminder_id: "r-123" }, getCallerAllowedFolders: restricted,
      reminderService: { cancel: reminderCancel } as unknown as ToolCallContext["reminderService"],
    }))).rejects.toThrow(/no source-folder provenance/);
    await expect(mod.handlers.check_reminders(makeCtx({
      args: {}, getCallerAllowedFolders: restricted,
      reminderService: { scanDue, prune: vi.fn() } as unknown as ToolCallContext["reminderService"],
    }))).rejects.toThrow(/no source-folder provenance/);

    expect(schedulerList).not.toHaveBeenCalled();
    expect(schedulerCancel).not.toHaveBeenCalled();
    expect(listPending).not.toHaveBeenCalled();
    expect(reminderCancel).not.toHaveBeenCalled();
    expect(scanDue).not.toHaveBeenCalled();
  });
});
