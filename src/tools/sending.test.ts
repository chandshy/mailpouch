import { describe, it, expect, vi } from "vitest";
import * as mod from "./sending.js";
import type { ToolCallContext, ToolResult } from "./types.js";
import type { EmailMessage } from "../types/index.js";

function makeCtx(over: Partial<ToolCallContext>): ToolCallContext {
  const actionOk = (messageId?: string): ToolResult => ({
    content: [{ type: "text", text: "Done." }], structuredContent: { success: true, messageId },
  });
  return {
    actionOk,
    invalidateAnalytics: () => {},
    MAX_SUBJECT_LENGTH: 998,
    MAX_BODY_LENGTH: 25 * 1024 * 1024,
    ...over,
  } as unknown as ToolCallContext;
}

function original(over: Partial<EmailMessage> = {}): EmailMessage {
  return {
    id: "42", from: "Alice <alice@x.com>", to: ["bob@x.com"], subject: "Hello",
    body: "original body", isHtml: false, date: new Date("2026-01-01T00:00:00Z"),
    folder: "INBOX", isRead: true, isStarred: false, hasAttachment: false,
    inReplyTo: "<parent@x.com>", references: ["<root@x.com>", "<parent@x.com>"],
    ...over,
  } as EmailMessage;
}

describe("forward_email", () => {
  it("carries the original threading headers (inReplyTo/references) onto the forward", async () => {
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "<new@x.com>" });
    const ctx = makeCtx({
      args: { emailId: "42", to: "carol@x.com" },
      imapService: { getEmailById: async () => original(), setFlag: vi.fn().mockResolvedValue(true) } as unknown as ToolCallContext["imapService"],
      smtpService: { sendEmail } as unknown as ToolCallContext["smtpService"],
    });
    await mod.handlers.forward_email(ctx);
    const sent = sendEmail.mock.calls[0][0];
    expect(sent.inReplyTo).toBe("<parent@x.com>");
    expect(sent.references).toEqual(["<root@x.com>", "<parent@x.com>"]);
  });

  it("strips control chars from the embedded original From/To in the quoted header", async () => {
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "<n@x.com>" });
    const ctx = makeCtx({
      args: { emailId: "42", to: "carol@x.com" },
      imapService: {
        getEmailById: async () => original({ from: "Evil\r\nBcc: leak@e.com <evil@x.com>", to: ["x@y.com\r\nInjected: 1"] }),
        setFlag: vi.fn().mockResolvedValue(true),
      } as unknown as ToolCallContext["imapService"],
      smtpService: { sendEmail } as unknown as ToolCallContext["smtpService"],
    });
    await mod.handlers.forward_email(ctx);
    const body = sendEmail.mock.calls[0][0].body as string;
    // No raw CRLF-injected header lines survive in the quoted block.
    expect(body).not.toMatch(/\r\nBcc:/);
    expect(body).not.toMatch(/\r\nInjected:/);
    expect(body).toContain("Forwarded message");
  });

  it("sets $Forwarded on success and does not throw if the flag set fails", async () => {
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "<n@x.com>" });
    const setFlag = vi.fn().mockRejectedValue(new Error("flag failed"));
    const ctx = makeCtx({
      args: { emailId: "42", to: "carol@x.com" },
      imapService: { getEmailById: async () => original(), setFlag } as unknown as ToolCallContext["imapService"],
      smtpService: { sendEmail } as unknown as ToolCallContext["smtpService"],
    });
    // Flag failure is logged, not thrown — the forward still succeeds.
    await expect(mod.handlers.forward_email(ctx)).resolves.toBeDefined();
    expect(setFlag).toHaveBeenCalledWith("42", "$Forwarded", true, "INBOX");
  });
});

describe("folder-restricted reply and forward", () => {
  it("requires an explicit allowlisted source folder before reading a reply source", async () => {
    const getEmailById = vi.fn();
    await expect(mod.handlers.reply_to_email(makeCtx({
      args: { emailId: "42", body: "Thanks" },
      getCallerAllowedFolders: () => ["INBOX"],
      imapService: { getEmailById } as unknown as ToolCallContext["imapService"],
    }))).rejects.toThrow(/requires an explicit source folder/);
    expect(getEmailById).not.toHaveBeenCalled();
  });

  it("rejects a reply source outside the allowlist before reading it", async () => {
    const getEmailById = vi.fn();
    await expect(mod.handlers.reply_to_email(makeCtx({
      args: { emailId: "42", folder: "Archive", body: "Thanks" },
      getCallerAllowedFolders: () => ["INBOX"],
      imapService: { getEmailById } as unknown as ToolCallContext["imapService"],
    }))).rejects.toThrow(/outside this agent's folder allowlist/);
    expect(getEmailById).not.toHaveBeenCalled();
  });

  it("uses one allowlisted source folder for reply read and Answered flag", async () => {
    const getEmailById = vi.fn().mockResolvedValue(original({ folder: "Archive" }));
    const setFlag = vi.fn().mockResolvedValue(true);
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "<reply@x.com>" });

    await mod.handlers.reply_to_email(makeCtx({
      args: { emailId: "42", folder: "Archive", body: "Thanks" },
      getCallerAllowedFolders: () => ["Archive"],
      config: { smtp: { username: "bob@x.com" } } as ToolCallContext["config"],
      imapService: { getEmailById, setFlag } as unknown as ToolCallContext["imapService"],
      smtpService: { sendEmail } as unknown as ToolCallContext["smtpService"],
    }));

    expect(getEmailById).toHaveBeenCalledWith("42", "Archive");
    expect(setFlag).toHaveBeenCalledWith("42", "\\Answered", true, "Archive");
  });

  it("uses the resolved allowlisted mailbox for forward reads and Forwarded flags", async () => {
    const getEmailById = vi.fn().mockResolvedValue(original({ folder: "Archive" }));
    const setFlag = vi.fn().mockResolvedValue(true);
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "<forward@x.com>" });

    await mod.handlers.forward_email(makeCtx({
      args: { emailId: "42", folder: "Archive", to: "carol@x.com" },
      getCallerAllowedFolders: () => ["Archive"],
      imapService: { getEmailById, setFlag } as unknown as ToolCallContext["imapService"],
      smtpService: { sendEmail } as unknown as ToolCallContext["smtpService"],
    }));

    expect(getEmailById).toHaveBeenCalledWith("42", "Archive");
    expect(setFlag).toHaveBeenCalledWith("42", "$Forwarded", true, "Archive");
  });

  it("rejects a forward if the fetched message does not prove the requested allowed source", async () => {
    const getEmailById = vi.fn().mockResolvedValue(original({ folder: "Archive" }));
    const sendEmail = vi.fn();

    await expect(mod.handlers.forward_email(makeCtx({
      args: { emailId: "42", folder: "INBOX", to: "carol@x.com" },
      getCallerAllowedFolders: () => ["INBOX"],
      imapService: { getEmailById } as unknown as ToolCallContext["imapService"],
      smtpService: { sendEmail } as unknown as ToolCallContext["smtpService"],
    }))).rejects.toThrow(/resolved an email outside this agent's folder allowlist/);

    expect(getEmailById).toHaveBeenCalledWith("42", "INBOX");
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("rejects an allowlisted-but-different resolved mailbox rather than flagging a colliding UID", async () => {
    const getEmailById = vi.fn().mockResolvedValue(original({ folder: "Archive" }));
    const setFlag = vi.fn();
    const sendEmail = vi.fn();

    await expect(mod.handlers.reply_to_email(makeCtx({
      args: { emailId: "42", folder: "INBOX", body: "Thanks" },
      getCallerAllowedFolders: () => ["INBOX", "Archive"],
      config: { smtp: { username: "bob@x.com" } } as ToolCallContext["config"],
      imapService: { getEmailById, setFlag } as unknown as ToolCallContext["imapService"],
      smtpService: { sendEmail } as unknown as ToolCallContext["smtpService"],
    }))).rejects.toThrow(/rather than the requested source folder/);

    expect(sendEmail).not.toHaveBeenCalled();
    expect(setFlag).not.toHaveBeenCalled();
  });
});
