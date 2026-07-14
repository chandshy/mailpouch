/**
 * Coverage for SMTPService.verifyConnection, sendEmail, sendTestEmail,
 * close, and wipeCredentials. TLS-specific branch coverage lives in
 * smtp-tls.test.ts; this file exercises the higher-level send and lifecycle
 * paths with a mocked nodemailer transporter.
 */

import { Socket } from "node:net";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SMTPService } from "./smtp-service.js";
import {
  MailboxMutationDeadlineError,
  withMailboxMutationDeadline,
} from "./mailbox-mutation-deadline.js";
import type { ProtonMailConfig } from "../types/index.js";

const verifyMock = vi.fn();
const sendMailMock = vi.fn();
const closeMock = vi.fn();
const poolConnections: unknown[] = [];

vi.mock("nodemailer", () => ({
  default: {
    createTransport: vi.fn(() => ({
      verify: verifyMock,
      sendMail: sendMailMock,
      close: closeMock,
      transporter: { _connections: poolConnections },
    })),
  },
}));

function makeConfig(overrides: Partial<ProtonMailConfig["smtp"]> = {}): ProtonMailConfig {
  return {
    smtp: {
      host: "127.0.0.1",
      port: 1025,
      secure: false,
      username: "me@example.com",
      password: "pw",
      allowInsecureBridge: true,
      ...overrides,
    },
    imap: {
      host: "127.0.0.1",
      port: 1143,
      secure: false,
      username: "me@example.com",
      password: "pw",
    },
  };
}

beforeEach(() => {
  verifyMock.mockReset();
  sendMailMock.mockReset();
  closeMock.mockReset();
  poolConnections.splice(0);
  verifyMock.mockResolvedValue(true);
  sendMailMock.mockResolvedValue({ messageId: "<abc@x>" });
});

describe("SMTPService transport configuration", () => {
  it("uses a bounded pool with one message per connection", async () => {
    const nodemailer = await import("nodemailer");
    const createTransport = (nodemailer.default as { createTransport: ReturnType<typeof vi.fn> }).createTransport;
    createTransport.mockClear();

    new SMTPService(makeConfig());

    expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({
      pool: true,
      maxConnections: 5,
      maxMessages: 1,
      maxRequeues: 0,
      connectionTimeout: 30_000,
      greetingTimeout: 30_000,
      socketTimeout: 45_000,
      getSocket: expect.any(Function),
    }));
  });
});

describe("SMTPService.verifyConnection", () => {
  it("returns true when the transporter verifies cleanly", async () => {
    const svc = new SMTPService(makeConfig());
    await expect(svc.verifyConnection()).resolves.toBe(true);
    expect(verifyMock).toHaveBeenCalled();
  });

  it("re-throws when the transporter verify fails", async () => {
    verifyMock.mockRejectedValueOnce(new Error("EAUTH"));
    const svc = new SMTPService(makeConfig());
    await expect(svc.verifyConnection()).rejects.toThrow("EAUTH");
  });
});

describe("SMTPService.sendEmail", () => {
  it("sends a minimal plain-text email and returns success", async () => {
    const svc = new SMTPService(makeConfig());
    const res = await svc.sendEmail({ to: "a@example.com", subject: "Hi", body: "Hello" });
    expect(res.success).toBe(true);
    expect(res.messageId).toBe("<abc@x>");
    const call = sendMailMock.mock.calls[0][0];
    expect(call.to).toBe("a@example.com");
    expect(call.subject).toBe("Hi");
    expect(call.text).toBe("Hello");
    expect(call.html).toBeUndefined();
  });

  it("sends HTML content when isHtml is set", async () => {
    const svc = new SMTPService(makeConfig());
    await svc.sendEmail({ to: "a@example.com", subject: "H", body: "<p>hi</p>", isHtml: true });
    const call = sendMailMock.mock.calls[0][0];
    expect(call.html).toBe("<p>hi</p>");
    expect(call.text).toBeUndefined();
  });

  it("accepts CC and BCC lists", async () => {
    const svc = new SMTPService(makeConfig());
    await svc.sendEmail({
      to: ["a@example.com"],
      cc: ["b@example.com", "c@example.com"],
      bcc: "d@example.com",
      subject: "S",
      body: "B",
    });
    const call = sendMailMock.mock.calls[0][0];
    expect(call.cc).toBe("b@example.com, c@example.com");
    expect(call.bcc).toBe("d@example.com");
  });

  it("throws when no recipients are supplied", async () => {
    const svc = new SMTPService(makeConfig());
    await expect(svc.sendEmail({ to: "", subject: "S", body: "B" })).rejects.toThrow(
      /At least one recipient/
    );
  });

  it("throws when a recipient address is invalid", async () => {
    const svc = new SMTPService(makeConfig());
    // Pass as array to bypass parseEmails() which silently drops unparseable strings
    await expect(
      svc.sendEmail({ to: ["not-an-email"], subject: "S", body: "B" })
    ).rejects.toThrow(/Invalid email address/);
  });

  it("SMTP-014: hard-fails when a `to` address is dropped as invalid instead of silently shrinking", async () => {
    const svc = new SMTPService(makeConfig());
    await expect(
      svc.sendEmail({ to: "good@example.com, bogus, bob@example.com", subject: "S", body: "B" })
    ).rejects.toThrow(/Invalid recipient address\(es\) in "to": bogus/);
  });

  it("throws when the combined recipient count exceeds the cap", async () => {
    const svc = new SMTPService(makeConfig());
    const many = Array.from({ length: 51 }, (_, i) => `u${i}@example.com`);
    await expect(svc.sendEmail({ to: many, subject: "S", body: "B" })).rejects.toThrow(
      /Too many recipients/
    );
  });

  it("validates a custom replyTo address", async () => {
    const svc = new SMTPService(makeConfig());
    await expect(
      svc.sendEmail({ to: "a@example.com", subject: "S", body: "B", replyTo: "not-an-email" })
    ).resolves.toMatchObject({ success: false });
  });

  it("strips CRLF from Message-ID style headers (inReplyTo, references)", async () => {
    const svc = new SMTPService(makeConfig());
    await svc.sendEmail({
      to: "a@example.com",
      subject: "S",
      body: "B",
      inReplyTo: "<a@x>\r\nBcc: evil@x.com",
      references: ["<b@x>\r\nBcc: evil@x.com", "<c@x>"],
    });
    const call = sendMailMock.mock.calls[0][0];
    expect(call.inReplyTo).not.toMatch(/\r|\n/);
    expect(call.references).not.toMatch(/\r|\n/);
  });

  it("drops blocked custom headers (to/from/bcc/etc.)", async () => {
    const svc = new SMTPService(makeConfig());
    await svc.sendEmail({
      to: "a@example.com",
      subject: "S",
      body: "B",
      headers: { "X-Ok": "fine", Bcc: "hidden@x.com", From: "attacker@x.com" },
    });
    const call = sendMailMock.mock.calls[0][0];
    expect(call.headers).toBeDefined();
    expect(call.headers["X-Ok"]).toBe("fine");
    expect(call.headers.Bcc).toBeUndefined();
    expect(call.headers.From).toBeUndefined();
  });

  it("rejects attachments when the count exceeds the cap", async () => {
    const svc = new SMTPService(makeConfig());
    const attachments = Array.from({ length: 21 }, (_, i) => ({
      filename: `f${i}.txt`,
      contentType: "text/plain",
      size: 1,
      content: "AA==",
    }));
    const res = await svc.sendEmail({ to: "a@example.com", subject: "S", body: "B", attachments });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Too many attachments/);
  });

  it("accepts a normal Buffer attachment and shapes the MIME envelope", async () => {
    const svc = new SMTPService(makeConfig());
    const res = await svc.sendEmail({
      to: "a@example.com",
      subject: "S",
      body: "B",
      attachments: [
        {
          filename: "doc.pdf\r\nContent-Type: text/html", // header injection attempt in filename
          contentType: "application/pdf",
          size: 4,
          content: Buffer.from("AAAA"),
          contentId: "cid-1",
        },
      ],
    });
    expect(res.success).toBe(true);
    const call = sendMailMock.mock.calls[0][0];
    expect(call.attachments).toHaveLength(1);
    expect(call.attachments[0].filename).not.toMatch(/\r|\n/);
    expect(call.attachments[0].contentType).toBe("application/pdf");
    expect(call.attachments[0].cid).toBe("cid-1");
  });

  it("rejects attachments whose content is neither Buffer nor string", async () => {
    const svc = new SMTPService(makeConfig());
    const res = await svc.sendEmail({
      to: "a@example.com",
      subject: "S",
      body: "B",
      attachments: [{
        filename: "stream.bin",
        contentType: "application/octet-stream",
        size: 10,
        content: { pipe: () => undefined } as unknown as Buffer,
      }],
    });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/must be a Buffer or base64 string/);
  });

  it("rejects when the combined attachment size exceeds the total cap", async () => {
    const svc = new SMTPService(makeConfig());
    // Two 15 MB attachments — each under the 25 MB per-file cap but together over the 25 MB total cap
    const block = Buffer.alloc(15 * 1024 * 1024, 0);
    const res = await svc.sendEmail({
      to: "a@example.com",
      subject: "S",
      body: "B",
      attachments: [
        { filename: "a.bin", contentType: "application/octet-stream", size: block.length, content: block },
        { filename: "b.bin", contentType: "application/octet-stream", size: block.length, content: block },
      ],
    });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Total attachment size/);
  });

  it("drops invalid contentType values while keeping the attachment", async () => {
    const svc = new SMTPService(makeConfig());
    await svc.sendEmail({
      to: "a@example.com",
      subject: "S",
      body: "B",
      attachments: [{
        filename: "x.bin",
        contentType: "not-a-valid-mime",
        size: 2,
        content: Buffer.from("xx"),
      }],
    });
    const call = sendMailMock.mock.calls[0][0];
    expect(call.attachments[0].contentType).toBeUndefined();
  });

  it("accepts a base64 string attachment", async () => {
    const svc = new SMTPService(makeConfig());
    const res = await svc.sendEmail({
      to: "a@example.com",
      subject: "S",
      body: "B",
      attachments: [{
        filename: "note.txt",
        contentType: "text/plain",
        size: 4,
        content: "aGVsbG8=", // base64 "hello"
      }],
    });
    expect(res.success).toBe(true);
  });

  it("rejects a single oversized attachment", async () => {
    const svc = new SMTPService(makeConfig());
    const big = Buffer.alloc(26 * 1024 * 1024, 0); // 26 MB > 25 MB cap
    const res = await svc.sendEmail({
      to: "a@example.com",
      subject: "S",
      body: "B",
      attachments: [{ filename: "big.bin", contentType: "application/octet-stream", size: big.length, content: big }],
    });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/too large/);
  });

  it("returns { success: false } when the transporter throws", async () => {
    sendMailMock.mockRejectedValueOnce(new Error("ENETUNREACH"));
    const svc = new SMTPService(makeConfig());
    const res = await svc.sendEmail({ to: "a@example.com", subject: "S", body: "B" });
    expect(res.success).toBe(false);
    expect(res.error).toBe("ENETUNREACH");
  });
});

describe("SMTPService.sendTestEmail", () => {
  it("delegates to sendEmail with a diagnostic subject", async () => {
    const svc = new SMTPService(makeConfig());
    const res = await svc.sendTestEmail("user@example.com");
    expect(res.success).toBe(true);
    const call = sendMailMock.mock.calls[0][0];
    expect(call.subject).toMatch(/Test Email/);
  });

  it("uses a custom body when one is supplied", async () => {
    const svc = new SMTPService(makeConfig());
    await svc.sendTestEmail("user@example.com", "<p>hello from test</p>");
    const call = sendMailMock.mock.calls[0][0];
    expect(call.html).toContain("hello from test");
  });
});

describe("SMTPService.close and wipeCredentials", () => {
  it("closes the transporter on close()", async () => {
    const svc = new SMTPService(makeConfig());
    await svc.close();
    expect(closeMock).toHaveBeenCalled();
  });

  it("close() is a no-op when already closed", async () => {
    const svc = new SMTPService(makeConfig());
    await svc.close();
    closeMock.mockClear();
    await svc.close();
    expect(closeMock).not.toHaveBeenCalled();
  });

  it("wipeCredentials clears password, token, and username, and closes the transporter", () => {
    const cfg = makeConfig({ password: "secret", smtpToken: "tok", username: "me@example.com" });
    const svc = new SMTPService(cfg);
    svc.wipeCredentials();
    expect(cfg.smtp.password).toBe("");
    expect(cfg.smtp.smtpToken).toBe("");
    expect(cfg.smtp.username).toBe("");
    expect(closeMock).toHaveBeenCalled();
  });

  it("closes and replaces a cancelled send transport", async () => {
    const svc = new SMTPService(makeConfig());
    const nodemailer = await import("nodemailer");
    const createTransport = (nodemailer.default as { createTransport: ReturnType<typeof vi.fn> }).createTransport;
    createTransport.mockClear();

    svc.abortActiveMutationTransport("test cancellation");

    expect(closeMock).toHaveBeenCalledTimes(1);
    expect(createTransport).toHaveBeenCalledTimes(1);
  });

  it("destroys active pooled SMTP sockets before closing and replacing the transport", async () => {
    const firstDestroy = vi.fn();
    const secondDestroy = vi.fn();
    const firstConnectionClose = vi.fn();
    const secondConnectionClose = vi.fn();
    const firstResourceClose = vi.fn(() => firstConnectionClose());
    const secondResourceClose = vi.fn(() => secondConnectionClose());
    poolConnections.push(
      {
        available: false,
        connection: {
          _socket: { socket: { destroy: firstDestroy, destroyed: false } },
          close: firstConnectionClose,
        },
        close: firstResourceClose,
      },
      {
        available: false,
        connection: {
          _socket: { destroy: secondDestroy, destroyed: false },
          close: secondConnectionClose,
        },
        close: secondResourceClose,
      },
    );
    const svc = new SMTPService(makeConfig());
    const nodemailer = await import("nodemailer");
    const createTransport = (nodemailer.default as { createTransport: ReturnType<typeof vi.fn> }).createTransport;
    createTransport.mockClear();

    svc.abortActiveMutationTransport("test cancellation");

    expect(firstDestroy).toHaveBeenCalledTimes(1);
    expect(secondDestroy).toHaveBeenCalledTimes(1);
    expect(firstConnectionClose).toHaveBeenCalledTimes(1);
    expect(secondConnectionClose).toHaveBeenCalledTimes(1);
    expect(firstResourceClose).toHaveBeenCalledTimes(1);
    expect(secondResourceClose).toHaveBeenCalledTimes(1);
    expect(closeMock).toHaveBeenCalledTimes(1);
    expect(createTransport).toHaveBeenCalledTimes(1);
  });

  it.each(["reinitialize", "close", "wipe"] as const)(
    "%s destroys the active pooled TLS socket before closing its resource",
    async (lifecycle) => {
      const destroy = vi.fn();
      const connectionClose = vi.fn();
      const resourceClose = vi.fn(() => connectionClose());
      poolConnections.push({
        available: false,
        connection: {
          _socket: { socket: { destroy, destroyed: false } },
          close: connectionClose,
        },
        close: resourceClose,
      });
      const svc = new SMTPService(makeConfig());

      if (lifecycle === "reinitialize") svc.reinitialize();
      else if (lifecycle === "close") await svc.close();
      else svc.wipeCredentials();

      expect(destroy).toHaveBeenCalledTimes(1);
      expect(resourceClose).toHaveBeenCalledTimes(1);
      expect(connectionClose).toHaveBeenCalledTimes(1);
      expect(closeMock).toHaveBeenCalledTimes(1);
    },
  );

  it("destroys a tracked raw socket while it is still connecting", async () => {
    const connect = vi.spyOn(Socket.prototype, "connect")
      .mockImplementation(function (this: Socket) { return this; });
    const destroy = vi.spyOn(Socket.prototype, "destroy");
    try {
      const svc = new SMTPService(makeConfig());
      const nodemailer = await import("nodemailer");
      const createTransport = (nodemailer.default as { createTransport: ReturnType<typeof vi.fn> }).createTransport;
      const transportOptions = createTransport.mock.lastCall?.[0] as {
        getSocket?: (
          options: { host: string; port: number },
          callback: (error: Error | null, result?: { connection: Socket }) => void,
        ) => void;
      };
      const callback = vi.fn();

      transportOptions.getSocket?.({ host: "127.0.0.1", port: 1025 }, callback);
      svc.abortActiveMutationTransport("test cancellation");

      expect(connect).toHaveBeenCalledTimes(1);
      expect(destroy).toHaveBeenCalledTimes(1);
      await new Promise<void>((resolve) => { setImmediate(resolve); });
      expect(callback).toHaveBeenCalledWith(expect.any(Error));
    } finally {
      connect.mockRestore();
      destroy.mockRestore();
    }
  });

  it.each(["reinitialize", "close", "wipe", "abort"] as const)(
    "%s invalidates a pending getSocket callback and destroys its raw socket",
    async (lifecycle) => {
      const connect = vi.spyOn(Socket.prototype, "connect")
        .mockImplementation(function (this: Socket) { return this; });
      const destroy = vi.spyOn(Socket.prototype, "destroy")
        .mockImplementation(function (this: Socket) { return this; });
      try {
        const svc = new SMTPService(makeConfig());
        const nodemailer = await import("nodemailer");
        const createTransport = (nodemailer.default as { createTransport: ReturnType<typeof vi.fn> }).createTransport;
        const transportOptions = createTransport.mock.lastCall?.[0] as {
          getSocket?: (
            options: { host: string; port: number },
            callback: (error: Error | null, result?: { connection: Socket }) => void,
          ) => void;
        };
        const callback = vi.fn();
        transportOptions.getSocket?.({ host: "127.0.0.1", port: 1025 }, callback);

        if (lifecycle === "reinitialize") svc.reinitialize();
        else if (lifecycle === "close") await svc.close();
        else if (lifecycle === "wipe") svc.wipeCredentials();
        else svc.abortActiveMutationTransport("test cancellation");

        expect(callback).toHaveBeenCalledTimes(1);
        expect(callback).toHaveBeenCalledWith(expect.any(Error));
        expect(destroy).toHaveBeenCalledTimes(1);
      } finally {
        connect.mockRestore();
        destroy.mockRestore();
      }
    },
  );

  it("rejects a delayed getSocket call from a retired transporter without allocating a socket", async () => {
    const connect = vi.spyOn(Socket.prototype, "connect")
      .mockImplementation(function (this: Socket) { return this; });
    try {
      const svc = new SMTPService(makeConfig());
      const nodemailer = await import("nodemailer");
      const createTransport = (nodemailer.default as { createTransport: ReturnType<typeof vi.fn> }).createTransport;
      const retiredOptions = createTransport.mock.lastCall?.[0] as {
        getSocket?: (
          options: { host: string; port: number },
          callback: (error: Error | null, result?: { connection: Socket }) => void,
        ) => void;
      };
      svc.reinitialize();
      const callback = vi.fn();

      retiredOptions.getSocket?.({ host: "127.0.0.1", port: 1025 }, callback);

      expect(callback).toHaveBeenCalledWith(expect.any(Error));
      expect(connect).not.toHaveBeenCalled();
    } finally {
      connect.mockRestore();
    }
  });

  it("hard-closes tracked sockets even if the transporter was already detached", async () => {
    const connect = vi.spyOn(Socket.prototype, "connect")
      .mockImplementation(function (this: Socket) { return this; });
    const destroy = vi.spyOn(Socket.prototype, "destroy")
      .mockImplementation(function (this: Socket) { return this; });
    try {
      const svc = new SMTPService(makeConfig());
      const nodemailer = await import("nodemailer");
      const createTransport = (nodemailer.default as { createTransport: ReturnType<typeof vi.fn> }).createTransport;
      const transportOptions = createTransport.mock.lastCall?.[0] as {
        getSocket?: (
          options: { host: string; port: number },
          callback: (error: Error | null, result?: { connection: Socket }) => void,
        ) => void;
      };
      const callback = vi.fn();
      transportOptions.getSocket?.({ host: "127.0.0.1", port: 1025 }, callback);
      (svc as unknown as { transporter: unknown }).transporter = null;
      createTransport.mockClear();

      svc.abortActiveMutationTransport("detached transport cancellation");

      expect(callback).toHaveBeenCalledWith(expect.any(Error));
      expect(destroy).toHaveBeenCalledTimes(1);
      expect(createTransport).not.toHaveBeenCalled();
    } finally {
      connect.mockRestore();
      destroy.mockRestore();
    }
  });

  it("reports missing pool internals as an unverified hard close", () => {
    poolConnections.push({ available: false, close: vi.fn() });
    const svc = new SMTPService(makeConfig());

    expect(() => svc.abortActiveMutationTransport("test cancellation"))
      .toThrow(/did not hard-close cleanly/);
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch SMTP after cancellation resolves a delayed preflight", async () => {
    const svc = new SMTPService(makeConfig());
    const controller = new AbortController();
    let releasePreflight!: () => void;
    const preflight = new Promise<void>((resolve) => { releasePreflight = resolve; });
    let finishLateOperation!: () => void;
    const lateOperationFinished = new Promise<void>((resolve) => { finishLateOperation = resolve; });

    const running = withMailboxMutationDeadline({
      tool: "send_email",
      signal: controller.signal,
      deadlineAt: Date.now() + 10_000,
      transports: [{
        scope: svc,
        abort: () => svc.abortActiveMutationTransport("test cancellation"),
      }],
    }, async () => {
      await preflight;
      try {
        return await svc.sendEmail({ to: "a@example.com", subject: "S", body: "B" });
      } finally {
        finishLateOperation();
      }
    });

    controller.abort();
    await expect(running).rejects.toBeInstanceOf(MailboxMutationDeadlineError);
    releasePreflight();
    await lateOperationFinished;
    expect(sendMailMock).not.toHaveBeenCalled();
    // The SMTP scope never became active, so there is no wire to tear down.
    expect(closeMock).not.toHaveBeenCalled();
  });

  it("reports an in-flight send as outcome-unknown when lifecycle replacement retires its generation", async () => {
    let rejectSend!: (error: Error) => void;
    sendMailMock.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      rejectSend = reject;
    }));
    const svc = new SMTPService(makeConfig());
    const sending = svc.sendEmail({ to: "a@example.com", subject: "S", body: "B" });
    await vi.waitFor(() => expect(sendMailMock).toHaveBeenCalledTimes(1));

    svc.reinitialize();
    rejectSend(new Error("retired socket closed"));

    const error = await sending.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MailboxMutationDeadlineError);
    expect((error as MailboxMutationDeadlineError).outcomeUnknown).toBe(true);
  });
});

describe("SMTPService.verifyConnection pre-config state", () => {
  it("throws when the transporter is null (e.g. after wipeCredentials)", async () => {
    const svc = new SMTPService(makeConfig());
    svc.wipeCredentials();
    await expect(svc.verifyConnection()).rejects.toThrow(/transporter not initialized/);
  });
});

describe("SMTPService.reinitialize", () => {
  it("rebuilds the transporter using current config values", async () => {
    const svc = new SMTPService(makeConfig());
    const nodemailer = await import("nodemailer");
    const createTransport = (nodemailer.default as { createTransport: ReturnType<typeof vi.fn> }).createTransport;
    createTransport.mockClear();
    svc.reinitialize();
    expect(createTransport).toHaveBeenCalledTimes(1);
  });
});

describe("SMTPService abuse-signal backoff", () => {
  it("arms backoff on SMTP 421 and short-circuits subsequent sends", async () => {
    const svc = new SMTPService(makeConfig());
    // First send hits a 421 (throttle) — outcome is recorded as "abuse"
    sendMailMock.mockRejectedValueOnce(Object.assign(new Error("421 4.7.0 throttled"), { responseCode: 421 }));
    const first = await svc.sendEmail({ to: "a@example.com", subject: "S", body: "B" });
    expect(first.success).toBe(false);
    expect(svc.backoff.isBlocked()).toBe(true);
    expect(svc.backoff.failureCount).toBe(1);

    // Second send must be short-circuited (no nodemailer call) while blocked
    sendMailMock.mockClear();
    const second = await svc.sendEmail({ to: "a@example.com", subject: "S", body: "B" });
    expect(second.success).toBe(false);
    expect(second.error).toMatch(/backoff active/i);
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("clears backoff on a successful send", async () => {
    const svc = new SMTPService(makeConfig());
    svc.backoff.record("abuse");
    expect(svc.backoff.isBlocked()).toBe(true);
    svc.backoff.reset();

    const res = await svc.sendEmail({ to: "a@example.com", subject: "S", body: "B" });
    expect(res.success).toBe(true);
    expect(svc.backoff.isBlocked()).toBe(false);
    expect(svc.backoff.failureCount).toBe(0);
  });

  it("does not arm backoff on a terminal (non-throttle) error", async () => {
    const svc = new SMTPService(makeConfig());
    sendMailMock.mockRejectedValueOnce(new Error("Invalid login"));
    const res = await svc.sendEmail({ to: "a@example.com", subject: "S", body: "B" });
    expect(res.success).toBe(false);
    expect(svc.backoff.isBlocked()).toBe(false);
    expect(svc.backoff.failureCount).toBe(0);
  });
});

describe("SMTPService.sendEmail optional fields", () => {
  it("passes a priority through to nodemailer when supplied", async () => {
    const svc = new SMTPService(makeConfig());
    await svc.sendEmail({ to: "a@example.com", subject: "S", body: "B", priority: "high" });
    const call = sendMailMock.mock.calls[0][0];
    expect(call.priority).toBe("high");
  });

  it("passes a valid replyTo through", async () => {
    const svc = new SMTPService(makeConfig());
    await svc.sendEmail({
      to: "a@example.com",
      subject: "S",
      body: "B",
      replyTo: "reply@example.com",
    });
    const call = sendMailMock.mock.calls[0][0];
    expect(call.replyTo).toBe("reply@example.com");
  });

  it("sendEmail throws when the transporter was closed first", async () => {
    const svc = new SMTPService(makeConfig());
    await svc.close();
    await expect(
      svc.sendEmail({ to: "a@example.com", subject: "S", body: "B" })
    ).rejects.toThrow(/transporter not initialized/);
  });
});
