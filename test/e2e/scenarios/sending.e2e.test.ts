/**
 * sending.e2e — Greenmail-backed E2E coverage for the SMTP send path
 * (TEST-012 in the 2026-05-28 audit). Previously the entire SMTP surface
 * (`send_email`, `reply_to_email`, `forward_email`, `send_test_email`) had
 * zero E2E coverage; a regression that forgot to call `transporter.sendMail`
 * would slip past unit tests + the IMAP-only harness.
 *
 * Greenmail's standalone image exposes SMTP on port 3025 without STARTTLS.
 * mailpouch's SMTP service refuses to send plaintext to localhost unless
 * `allowInsecureBridge: true` (or `MAILPOUCH_INSECURE_BRIDGE=1`) — both are
 * already set by the harness for the Greenmail Phase-1 config, so requireTLS
 * is dropped to match. Production Bridge deployments are unaffected.
 *
 * Cross-user verification: alice@test.local sends; we open a second IMAP
 * connection as bob@test.local and assert the message landed in bob's INBOX
 * with the expected subject / recipients / body. This is the property that
 * catches false-success counters — mailpouch can no longer pretend the SMTP
 * call succeeded without the message actually being delivered.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ImapFlow } from "imapflow";
import { bridgeConfigAvailable, startE2E, type E2EHarness } from "../mcp-client.js";
import * as docker from "../support/docker.js";
import { TEST_USER, TEST_USER_BOB } from "../support/docker.js";

/**
 * Poll bob's INBOX until at least `expected` messages are present. Greenmail
 * applies SMTP deliveries asynchronously; without the wait the immediate
 * IMAP read can race the spool.
 */
async function waitForBobMessages(expected: number, timeoutMs = 5000): Promise<Array<{
  uid: number;
  subject: string;
  to: string[];
  cc: string[];
  body: string;
  rawSource: string;
}>> {
  const deadline = Date.now() + timeoutMs;
  let lastSeen: Array<{ uid: number; subject: string; to: string[]; cc: string[]; body: string; rawSource: string }> = [];
  while (Date.now() < deadline) {
    const client = new ImapFlow({
      host: "127.0.0.1",
      port: docker.GREENMAIL_IMAP_PORT,
      secure: false,
      auth: { user: TEST_USER_BOB.username, pass: TEST_USER_BOB.password },
      logger: false,
    });
    try {
      await client.connect();
      const lock = await client.getMailboxLock("INBOX");
      try {
        const out: typeof lastSeen = [];
        for await (const msg of client.fetch(
          "1:*",
          { uid: true, envelope: true, source: true, bodyParts: new Set(["1"]) },
          { uid: false }
        )) {
          if (typeof msg.uid !== "number") continue;
          const env = msg.envelope ?? {};
          const subject = env.subject ?? "";
          const toAddrs = (env.to ?? []).map((a) => a.address ?? "");
          const ccAddrs = (env.cc ?? []).map((a) => a.address ?? "");
          const rawSource = msg.source ? Buffer.from(msg.source).toString("utf8") : "";
          // bodyParts is a Map of part-number → Buffer; "1" is the first text part.
          let body = "";
          const parts = msg.bodyParts as Map<string, Buffer> | undefined;
          if (parts) {
            const buf = parts.get("1");
            if (buf) body = buf.toString("utf8");
          }
          out.push({ uid: msg.uid, subject, to: toAddrs, cc: ccAddrs, body, rawSource });
        }
        lastSeen = out;
        if (out.length >= expected) return out;
      } finally {
        lock.release();
      }
    } finally {
      try { await client.logout(); } catch { /* ignore */ }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return lastSeen;
}

/** Wipe bob's mailbox so each test starts from zero. */
async function wipeBobInbox(): Promise<void> {
  const client = new ImapFlow({
    host: "127.0.0.1",
    port: docker.GREENMAIL_IMAP_PORT,
    secure: false,
    auth: { user: TEST_USER_BOB.username, pass: TEST_USER_BOB.password },
    logger: false,
  });
  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      const uids: number[] = [];
      for await (const msg of client.fetch("1:*", { uid: true }, { uid: false })) {
        if (typeof msg.uid === "number") uids.push(msg.uid);
      }
      if (uids.length > 0) {
        await client.messageDelete(uids.join(","), { uid: true });
      }
    } finally {
      lock.release();
    }
  } catch {
    // INBOX may be empty / connection refused on early boot — ignore.
  } finally {
    try { await client.logout(); } catch { /* ignore */ }
  }
}

/** Bridge delivery verification is self-addressed and identity-scoped. Poll
 * only for the unique run-token subject; pre-existing Inbox mail is never
 * enumerated, changed, or used as an assertion target. */
async function waitForOwnedSubject(h: E2EHarness, subject: string, timeoutMs = 30_000): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const uids = await h.imap.searchSubject("INBOX", subject);
    if (uids.length > 0) return uids;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return [];
}

async function waitForBridgeDelivery(
  h: E2EHarness,
  messageId: string,
  bodyToken: string,
  timeoutMs = 30_000,
): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const uids = await h.imap.findMessageByProof(
      "INBOX",
      messageId,
      "Test Email from mailpouch",
      bodyToken,
    );
    if (uids.length > 0) return uids;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return [];
}

describe("sending.e2e — send_email actually delivers via Greenmail SMTP", () => {
  let h: E2EHarness;

  beforeAll(async () => {
    if (!bridgeConfigAvailable()) await docker.restart();
    h = await startE2E({ user: TEST_USER });
  });

  afterAll(async () => {
    if (h) {
      if (!bridgeConfigAvailable()) {
        try { await wipeBobInbox(); } catch { /* ignore */ }
      }
      await h.close();
    }
  });

  beforeEach(async () => {
    await h.resetState();
    if (!bridgeConfigAvailable()) await wipeBobInbox();
  });

  it("delivers a simple text-body send_email to the recipient's INBOX", async () => {
    const subject = `${h.runToken ?? "greenmail"} sending.e2e simple body`;
    const recipient = bridgeConfigAvailable() ? h.accountEmail! : TEST_USER_BOB.email;
    const result = h.json<{ success: boolean; messageId?: string }>(
      await h.call("send_email", {
        to: recipient,
        subject,
        body: "Hello Bob — this is alice via mailpouch.",
      })
    );
    expect(result.success).toBe(true);

    if (bridgeConfigAvailable()) {
      expect(await waitForOwnedSubject(h, subject)).not.toHaveLength(0);
      return;
    }

    const inbox = await waitForBobMessages(1);
    expect(inbox.length).toBeGreaterThanOrEqual(1);
    const msg = inbox[0];
    expect(msg.subject).toBe(subject);
    expect(msg.to).toContain(TEST_USER_BOB.email);
    // imapflow's `bodyParts: new Set(["1"])` doesn't always populate for
    // single-part plain-text messages (the section number varies); the
    // raw source is the reliable fallback.
    expect(msg.body || msg.rawSource).toContain("Hello Bob");
  }, 90_000);

  it.skipIf(bridgeConfigAvailable())("propagates To, Cc, and Bcc headers correctly", async () => {
    // Add a third Greenmail user for the carbon-copy assertion is overkill;
    // Greenmail provisions exactly alice+bob via the compose file. To assert
    // CC delivery without adding a third user, send To: bob, Cc: bob_alias
    // (greenmail accepts any address and dumps to the matching mailbox).
    // The harness asserts the message envelope reflects the headers; Bcc
    // recipients must NOT appear in the envelope per RFC 5322.
    const result = h.json<{ success: boolean }>(
      await h.call("send_email", {
        to: TEST_USER_BOB.email,
        cc: "cc-watcher@test.local",
        bcc: "bcc-watcher@test.local",
        subject: "sending.e2e header propagation",
        body: "Headers check.",
      })
    );
    expect(result.success).toBe(true);

    const inbox = await waitForBobMessages(1);
    const msg = inbox.find((m) => m.subject === "sending.e2e header propagation");
    expect(msg).toBeDefined();
    expect(msg!.to).toContain(TEST_USER_BOB.email);
    expect(msg!.cc).toContain("cc-watcher@test.local");
    // Bcc must NOT appear in the rendered headers / envelope sent on the
    // wire. Read the raw source — a regression that leaks Bcc into the
    // outbound headers would be a real privacy bug.
    expect(msg!.rawSource.toLowerCase()).not.toContain("bcc:");
    expect(msg!.rawSource.toLowerCase()).not.toContain("bcc-watcher@test.local");
  });

  it("sends an HTML body when isHtml=true", async () => {
    const subject = `${h.runToken ?? "greenmail"} sending.e2e html`;
    const recipient = bridgeConfigAvailable() ? h.accountEmail! : TEST_USER_BOB.email;
    const result = h.json<{ success: boolean }>(
      await h.call("send_email", {
        to: recipient,
        subject,
        body: "<p>Hello <b>Bob</b> in HTML.</p>",
        isHtml: true,
      })
    );
    expect(result.success).toBe(true);

    if (bridgeConfigAvailable()) {
      expect(await waitForOwnedSubject(h, subject)).not.toHaveLength(0);
      return;
    }

    const inbox = await waitForBobMessages(1);
    const msg = inbox.find((m) => m.subject === subject);
    expect(msg).toBeDefined();
    // Body part 1 of an HTML-only mail is the HTML string; the raw source
    // declares text/html. Assert both — the body part and the Content-Type.
    expect(msg!.rawSource.toLowerCase()).toContain("content-type: text/html");
    expect(msg!.body || msg!.rawSource).toMatch(/<b>Bob<\/b>/);
  }, 90_000);

  it("send_test_email delivers a probe message to the configured recipient", async () => {
    const recipient = bridgeConfigAvailable() ? h.accountEmail! : TEST_USER_BOB.email;
    const bridgeBody = `${h.runToken} delivery probe`;
    const result = h.json<{ success: boolean; messageId?: string }>(
      await h.call("send_test_email", {
        to: recipient,
        ...(bridgeConfigAvailable() ? { customMessage: bridgeBody } : {}),
      })
    );
    expect(result.success).toBe(true);

    if (bridgeConfigAvailable()) {
      expect(result.messageId).toBeTruthy();
      expect(await waitForBridgeDelivery(h, result.messageId!, bridgeBody)).not.toHaveLength(0);
      return;
    }

    const inbox = await waitForBobMessages(1);
    expect(inbox.length).toBeGreaterThanOrEqual(1);
    // The default mailpouch test-email subject is "Test Email from mailpouch"
    // (or similar) — we don't pin the exact wording to keep the test robust
    // against copywriting tweaks; we just assert the message arrived.
    expect(inbox[0].to).toContain(TEST_USER_BOB.email);
  }, 90_000);
});

// ─── alias_* — SimpleLogin gate ───────────────────────────────────────────────
//
// SimpleLogin requires a real API key; Greenmail can't impersonate it. These
// tests are placeholders mirroring the Bridge-only skip pattern: they only
// run when MAILPOUCH_E2E_SIMPLELOGIN=1 is set in the environment AND a
// SimpleLogin API key is wired into the test config. Until then we publish
// a skipped placeholder so the audit gap is visible and future runs can
// drop the skip with one env flip.

const SIMPLELOGIN_ENABLED = process.env.MAILPOUCH_E2E_SIMPLELOGIN === "1";

describe.skipIf(!SIMPLELOGIN_ENABLED)(
  "alias_*.e2e — SimpleLogin alias management (requires MAILPOUCH_E2E_SIMPLELOGIN=1)",
  () => {
    it("placeholder — alias_list / alias_create / alias_toggle / alias_delete", () => {
      // The lane is enabled (MAILPOUCH_E2E_SIMPLELOGIN=1) but no alias_* tool
      // is exercised yet — fail loudly rather than report false coverage
      // (Copilot review on #146). Default (env unset) stays skipped via the
      // describe.skipIf above. When implementing: list aliases, create,
      // toggle enabled, delete; assert each step via tool response + a
      // follow-up alias_list verification, then remove this expect.fail.
      expect.fail(
        "SimpleLogin E2E lane enabled but alias_* scenarios are not implemented — " +
        "this placeholder must stay red until real assertions land.",
      );
    });
  },
);

// ─── pass_* — Proton Pass gate ────────────────────────────────────────────────
//
// Same shape: Proton Pass tests require a Pass PAT plus an actual Pass
// account; we skip with a clear reason until MAILPOUCH_E2E_PASS=1 is set.

const PASS_ENABLED = process.env.MAILPOUCH_E2E_PASS === "1";

describe.skipIf(!PASS_ENABLED)(
  "pass_*.e2e — Proton Pass credential vault (requires MAILPOUCH_E2E_PASS=1)",
  () => {
    it("placeholder — pass_list / pass_get / pass_search", () => {
      // Lane enabled (MAILPOUCH_E2E_PASS=1) but no pass_* tool is exercised
      // yet — fail loudly rather than report false coverage (Copilot review
      // on #146). Default (env unset) stays skipped. When implementing: list
      // items, fetch by id, run a search; assert each tool returns the
      // expected shape and the audit log records the read, then remove this.
      expect.fail(
        "Proton Pass E2E lane enabled but pass_* scenarios are not implemented — " +
        "this placeholder must stay red until real assertions land.",
      );
    });
  },
);
