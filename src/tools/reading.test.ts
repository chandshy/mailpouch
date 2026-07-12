import { describe, expect, it, vi } from "vitest";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import type { EmailMessage } from "../types/index.js";
import { handlers } from "./reading.js";
import type { ToolCallContext, ToolResult } from "./types.js";

const LIMITS = {
  maxResponseBytes: 1_000_000,
  maxEmailBodyChars: 10_000,
  maxEmailListResults: 100,
  maxAttachmentBytes: 1_000_000,
  warnOnLargeResponse: false,
};

function email(overrides: Partial<EmailMessage> = {}): EmailMessage {
  return {
    id: "42",
    from: "sender@example.test",
    to: [],
    subject: "Project update",
    body: "Please review the proposal.",
    isHtml: false,
    date: new Date("2026-07-11T12:00:00.000Z"),
    folder: "INBOX",
    isRead: false,
    isStarred: false,
    hasAttachment: false,
    ...overrides,
  };
}

function makeCtx({
  args,
  allowedFolders,
  imapService,
}: {
  args: Record<string, unknown>;
  allowedFolders?: string[];
  imapService: Record<string, unknown>;
}): ToolCallContext {
  const ok = (structured: Record<string, unknown>, text?: string): ToolResult => ({
    content: [{ type: "text", text: text ?? JSON.stringify(structured) }],
    structuredContent: structured,
  });
  return {
    args,
    imapService,
    limits: LIMITS,
    ok,
    getCallerAllowedFolders: () => allowedFolders,
  } as unknown as ToolCallContext;
}

describe("reading folder provenance", () => {
  it("requires an explicit folder before a restricted caller can resolve a UID", async () => {
    const getEmailById = vi.fn();
    const ctx = makeCtx({
      args: { emailId: "42" },
      allowedFolders: ["INBOX"],
      imapService: { getEmailById },
    });

    await expect(handlers.get_email_by_id(ctx)).rejects.toThrow(McpError);
    await expect(handlers.get_email_by_id(ctx)).rejects.toThrow(/requires a folder/i);
    expect(getEmailById).not.toHaveBeenCalled();
  });

  it("rejects an allowed-looking email hint when the service resolves another folder", async () => {
    const getEmailById = vi.fn().mockResolvedValue(email({ folder: "Archive" }));
    const ctx = makeCtx({
      args: { emailId: "42", folder: "INBOX" },
      allowedFolders: ["INBOX"],
      imapService: { getEmailById },
    });

    await expect(handlers.get_email_by_id(ctx)).rejects.toThrow(/resolved email.*outside/i);
    expect(getEmailById).toHaveBeenCalledWith("42", "INBOX");
  });

  it("keeps folder provenance exact even when both folders are allowlisted", async () => {
    const getEmailById = vi.fn().mockResolvedValue(email({ folder: "Projects" }));
    const ctx = makeCtx({
      args: { emailId: "42", folder: "INBOX" },
      allowedFolders: ["INBOX", "Projects"],
      imapService: { getEmailById },
    });

    await expect(handlers.get_email_by_id(ctx)).rejects.toThrow(/does not match the requested folder/i);
  });

  it("fails closed if a folder-scoped list or search returns a message from an excluded folder", async () => {
    const getEmails = vi.fn().mockResolvedValue([email({ folder: "Archive" })]);
    const listCtx = makeCtx({
      args: { folder: "INBOX", limit: 2 },
      allowedFolders: ["INBOX"],
      imapService: { getEmails },
    });
    await expect(handlers.get_emails(listCtx)).rejects.toThrow(/resolved email.*outside/i);

    const searchEmails = vi.fn().mockResolvedValue([email({ folder: "Archive" })]);
    const searchCtx = makeCtx({
      args: { folder: "INBOX" },
      allowedFolders: ["INBOX"],
      imapService: { searchEmails },
    });
    await expect(handlers.search_emails(searchCtx)).rejects.toThrow(/resolved email.*outside/i);
  });

  it("derives label provenance before returning label content to a restricted caller", async () => {
    const getEmails = vi.fn().mockResolvedValue([email({ folder: "Archive" })]);
    const ctx = makeCtx({
      args: { label: "Work", limit: 2 },
      allowedFolders: ["Labels/Work"],
      imapService: { getEmails },
    });

    await expect(handlers.get_emails_by_label(ctx)).rejects.toThrow(/resolved email.*outside/i);
    expect(getEmails).toHaveBeenCalledWith("Labels/Work", 2, 0);
  });

  it("requires and verifies attachment folder provenance before returning binary content", async () => {
    const getEmailById = vi.fn().mockResolvedValue(email({ folder: "INBOX", hasAttachment: true }));
    const downloadAttachment = vi.fn().mockResolvedValue({
      filename: "proposal.pdf",
      contentType: "application/pdf",
      size: 3,
      content: "cGRm",
      encoding: "base64",
    });
    const ctx = makeCtx({
      args: { email_id: "42", folder: "INBOX", attachment_index: 0 },
      allowedFolders: ["INBOX"],
      imapService: { getEmailById, downloadAttachment },
    });

    const result = await handlers.download_attachment(ctx);
    expect(result.isError).toBeUndefined();
    expect((result.structuredContent as { filename: string }).filename).toBe("proposal.pdf");
    expect(getEmailById).toHaveBeenCalledWith("42", "INBOX");
    expect(downloadAttachment).toHaveBeenCalledWith("42", 0, "INBOX");
  });

  it("does not download an attachment when the resolved UID belongs to an excluded folder", async () => {
    const getEmailById = vi.fn().mockResolvedValue(email({ folder: "Archive", hasAttachment: true }));
    const downloadAttachment = vi.fn();
    const ctx = makeCtx({
      args: { email_id: "42", folder: "INBOX", attachment_index: 0 },
      allowedFolders: ["INBOX"],
      imapService: { getEmailById, downloadAttachment },
    });

    await expect(handlers.download_attachment(ctx)).rejects.toThrow(/resolved email.*outside/i);
    expect(downloadAttachment).not.toHaveBeenCalled();
  });

  it("keeps folderless attachment behavior for unrestricted callers", async () => {
    const downloadAttachment = vi.fn().mockResolvedValue({
      filename: "proposal.pdf",
      contentType: "application/pdf",
      size: 3,
      content: "cGRm",
      encoding: "base64",
    });
    const ctx = makeCtx({
      args: { email_id: "42", attachment_index: 0 },
      imapService: { downloadAttachment },
    });

    await expect(handlers.download_attachment(ctx)).resolves.toBeDefined();
    expect(downloadAttachment).toHaveBeenCalledWith("42", 0, undefined);
  });

  it("scopes a restricted thread to all and only allowed folders and retains duplicate UIDs per folder", async () => {
    const getEmailById = vi.fn().mockResolvedValue(email({ id: "1", folder: "Projects", subject: "Project update" }));
    const searchEmails = vi.fn(async ({ folder }: { folder: string }) => {
      if (folder === "Projects") {
        return [
          email({ id: "7", folder: "Projects", subject: "Re: Project update", date: new Date("2026-07-11T11:00:00.000Z") }),
        ];
      }
      return [
        email({ id: "7", folder: "INBOX", subject: "Fwd: Project update", date: new Date("2026-07-11T10:00:00.000Z") }),
      ];
    });
    const ctx = makeCtx({
      args: { email_id: "1", folder: "Projects" },
      allowedFolders: ["Projects", "INBOX"],
      imapService: { getEmailById, searchEmails },
    });

    const result = await handlers.get_thread(ctx);
    const messages = (result.structuredContent as { messages: Array<{ id: string; folder: string }> }).messages;

    expect(searchEmails.mock.calls.map(([options]) => options.folder)).toEqual(["Projects", "INBOX"]);
    expect(messages.map((message) => `${message.folder}:${message.id}`).sort()).toEqual([
      "INBOX:7",
      "Projects:1",
      "Projects:7",
    ]);
  });

  it("fails closed when an allowed thread search resolves a message from another folder", async () => {
    const getEmailById = vi.fn().mockResolvedValue(email({ id: "1", folder: "INBOX", subject: "Project update" }));
    const searchEmails = vi.fn().mockResolvedValue([
      email({ id: "9", folder: "Archive", subject: "Project update" }),
    ]);
    const ctx = makeCtx({
      args: { email_id: "1", folder: "INBOX" },
      allowedFolders: ["INBOX"],
      imapService: { getEmailById, searchEmails },
    });

    await expect(handlers.get_thread(ctx)).rejects.toThrow(/resolved email.*outside/i);
  });

  it("fails closed when a restricted thread query returns a different allowed folder", async () => {
    const getEmailById = vi.fn().mockResolvedValue(email({ id: "1", folder: "INBOX", subject: "Project update" }));
    const searchEmails = vi.fn(async ({ folder }: { folder: string }) => {
      if (folder === "INBOX") {
        // Both paths are allowlisted, but this message was returned by the
        // INBOX query and therefore cannot be attributed to Projects.
        return [email({ id: "9", folder: "Projects", subject: "Project update" })];
      }
      return [];
    });
    const ctx = makeCtx({
      args: { email_id: "1", folder: "INBOX" },
      allowedFolders: ["INBOX", "Projects"],
      imapService: { getEmailById, searchEmails },
    });

    await expect(handlers.get_thread(ctx)).rejects.toThrow(/does not match the requested folder/i);
  });

  it("requires an allowed seed folder before a restricted caller can expand a thread", async () => {
    const getEmailById = vi.fn();
    const searchEmails = vi.fn();
    const ctx = makeCtx({
      args: { email_id: "42" },
      allowedFolders: ["INBOX"],
      imapService: { getEmailById, searchEmails },
    });

    await expect(handlers.get_thread(ctx)).rejects.toThrow(/requires a folder/i);
    expect(getEmailById).not.toHaveBeenCalled();
    expect(searchEmails).not.toHaveBeenCalled();
  });

  it("preserves unrestricted INBOX and Sent thread expansion", async () => {
    const getEmailById = vi.fn().mockResolvedValue(email({ subject: "Project update" }));
    const searchEmails = vi.fn().mockResolvedValue([]);
    const ctx = makeCtx({
      args: { email_id: "42" },
      imapService: { getEmailById, searchEmails },
    });

    await expect(handlers.get_thread(ctx)).resolves.toBeDefined();
    expect(searchEmails.mock.calls.map(([options]) => options.folder)).toEqual(["INBOX", "Sent"]);
  });

  it.each([
    ["extract_action_items", { email_id: "42" }],
    ["extract_meeting", { email_id: "42" }],
  ] as const)("requires folder provenance for %s", async (tool, args) => {
    const getEmailById = vi.fn();
    const ctx = makeCtx({
      args,
      allowedFolders: ["INBOX"],
      imapService: { getEmailById },
    });

    await expect(handlers[tool](ctx)).rejects.toThrow(/requires a folder/i);
    expect(getEmailById).not.toHaveBeenCalled();
  });

  it.each([
    ["extract_action_items", { email_id: "42", folder: "INBOX" }],
    ["extract_meeting", { email_id: "42", folder: "INBOX" }],
  ] as const)("rejects an excluded resolved email for %s", async (tool, args) => {
    const getEmailById = vi.fn().mockResolvedValue(email({ folder: "Archive" }));
    const ctx = makeCtx({
      args,
      allowedFolders: ["INBOX"],
      imapService: { getEmailById },
    });

    await expect(handlers[tool](ctx)).rejects.toThrow(/resolved email.*outside/i);
  });
});
