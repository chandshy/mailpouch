/**
 * Real-socket coverage for SMTP mutation cancellation.
 *
 * This test never contacts Proton Bridge or an account. It runs a minimal
 * plaintext SMTP peer on an ephemeral 127.0.0.1 port, accepts one message,
 * and deliberately withholds the final response after DATA. The production
 * mutation coordinator must reject with an ambiguous outcome and hard-close the
 * actual Nodemailer client socket instead of leaving the send wedged.
 */

import { afterEach, describe, expect, it } from "vitest";
import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import type { ProtonMailConfig } from "../types/index.js";
import {
  MailboxMutationDeadlineError,
  withMailboxMutationDeadline,
} from "./mailbox-mutation-deadline.js";
import { SMTPService } from "./smtp-service.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function within<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function configFor(port: number): ProtonMailConfig {
  return {
    smtp: {
      host: "127.0.0.1",
      port,
      secure: false,
      username: "sender@example.com",
      password: "test-password",
      allowInsecureBridge: true,
    },
    imap: {
      host: "127.0.0.1",
      port: 1,
      secure: false,
      username: "unused@example.com",
      password: "unused",
      allowInsecureBridge: true,
    },
  };
}

let service: SMTPService | undefined;
let server: Server | undefined;
const acceptedSockets = new Set<Socket>();
const originalPlaintextSetting = process.env.MAILPOUCH_SMTP_ALLOW_PLAINTEXT;

afterEach(async () => {
  await service?.close();
  service = undefined;

  for (const socket of acceptedSockets) socket.destroy();
  acceptedSockets.clear();
  if (server?.listening) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
  server = undefined;

  if (originalPlaintextSetting === undefined) {
    delete process.env.MAILPOUCH_SMTP_ALLOW_PLAINTEXT;
  } else {
    process.env.MAILPOUCH_SMTP_ALLOW_PLAINTEXT = originalPlaintextSetting;
  }
});

describe("SMTPService mutation cancellation real-socket integration", () => {
  it("hard-closes a send stalled while awaiting the final DATA response", async () => {
    process.env.MAILPOUCH_SMTP_ALLOW_PLAINTEXT = "1";

    const dataReceived = deferred<number>();
    const peerClosed = deferred<number>();
    const commands: string[] = [];
    const socketErrors: NodeJS.ErrnoException[] = [];

    server = createServer((socket) => {
      acceptedSockets.add(socket);
      let input = "";
      let readingData = false;

      socket.on("error", (error: NodeJS.ErrnoException) => socketErrors.push(error));
      socket.on("close", () => {
        acceptedSockets.delete(socket);
        peerClosed.resolve(Date.now());
      });
      socket.on("data", (chunk) => {
        input += chunk.toString("utf8");

        while (input.length > 0) {
          if (readingData) {
            const terminator = input.indexOf("\r\n.\r\n");
            if (terminator === -1) return;
            input = input.slice(terminator + 5);
            readingData = false;
            dataReceived.resolve(Date.now());
            // Deliberately do not send the final `250`: sendEmail() must stay
            // pending until the request-scoped mutation deadline closes it.
            return;
          }

          const lineEnd = input.indexOf("\r\n");
          if (lineEnd === -1) return;
          const line = input.slice(0, lineEnd);
          input = input.slice(lineEnd + 2);
          const verb = line.split(/[ \t]/, 1)[0]?.toUpperCase() ?? "";
          commands.push(verb);

          if (verb === "EHLO") {
            socket.write("250-test.invalid\r\n250 AUTH PLAIN\r\n");
          } else if (verb === "AUTH") {
            socket.write("235 2.7.0 Authentication successful\r\n");
          } else if (verb === "MAIL" || verb === "RCPT") {
            socket.write("250 2.1.0 Accepted\r\n");
          } else if (verb === "DATA") {
            socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
            readingData = true;
          } else if (verb === "RSET" || verb === "NOOP") {
            socket.write("250 2.0.0 OK\r\n");
          } else if (verb === "QUIT") {
            socket.end("221 2.0.0 Bye\r\n");
          } else {
            socket.end("500 5.5.1 Unexpected command\r\n");
          }
        }
      });

      socket.write("220 test.invalid ESMTP ready\r\n");
    });

    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as AddressInfo).port;
    service = new SMTPService(configFor(port));

    const controller = new AbortController();
    const deadlineAt = Date.now() + 10_000;
    const sendOutcome = withMailboxMutationDeadline({
      tool: "send_email",
      signal: controller.signal,
      deadlineAt,
      transports: [{
        scope: service,
        abort: () => service!.abortActiveMutationTransport("real-socket integration cancellation"),
      }],
    }, () => service!.sendEmail({
      to: "recipient@example.com",
      subject: "SMTP deadline socket test",
      body: "This message is accepted only by the local test stub.",
    })).then(
      () => ({ status: "fulfilled" as const }),
      (reason: unknown) => ({ status: "rejected" as const, reason }),
    );

    try {
      const dataReceivedAt = await within(
        dataReceived.promise,
        5_000,
        "Local SMTP peer never received the complete DATA payload",
      );

      controller.abort();
      const outcome = await within(
        sendOutcome,
        2_000,
        "Cancelled SMTP send did not settle promptly",
      );
      const mutationSettledAt = Date.now();

      expect(outcome.status).toBe("rejected");
      if (outcome.status !== "rejected") throw new Error("Cancelled SMTP send unexpectedly fulfilled");
      expect(outcome.reason).toBeInstanceOf(MailboxMutationDeadlineError);
      expect((outcome.reason as MailboxMutationDeadlineError).outcomeUnknown).toBe(true);

      const peerClosedAt = await within(
        peerClosed.promise,
        2_000,
        "Local SMTP peer did not observe the client socket close promptly",
      );

      expect(dataReceivedAt).toBeLessThanOrEqual(mutationSettledAt);
      expect(peerClosedAt).toBeGreaterThanOrEqual(dataReceivedAt);
      expect(Math.max(0, peerClosedAt - mutationSettledAt)).toBeLessThan(2_000);
      expect(commands).toEqual(["EHLO", "AUTH", "MAIL", "RCPT", "DATA"]);
      expect(socketErrors.every((error) => error.code === "ECONNRESET")).toBe(true);
    } finally {
      controller.abort();
      await within(sendOutcome, 2_000, "SMTP send remained pending during test cleanup")
        .catch(() => undefined);
    }
  }, 15_000);
});
