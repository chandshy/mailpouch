/**
 * Regression guard for the destructive E2E reset. ImapFixtures.wipe() empties
 * INBOX/Sent/Archive/Trash/Spam/Drafts and deletes every other folder — it must
 * NEVER run against a real mailbox. This asserts wipe() refuses unless the
 * caller explicitly opted in (allowWipe). The guard runs BEFORE any IMAP
 * connection, so this test touches no server and no mailbox.
 *
 * Born from a 2026-06-02 near-miss: the Bridge E2E was pointed at a real Proton
 * account; only a TLS quirk stopped wipe() from erasing it. This makes the
 * destructive path opt-in so it can't happen by accident.
 */

import { describe, it, expect } from "vitest";
import { ImapFixtures } from "./e2e/fixtures/imap-fixtures.js";

const base = { host: "127.0.0.1", port: 1143, user: "real@example.com", pass: "secret" };

describe("ImapFixtures.wipe() safety guard", () => {
  it("refuses to wipe when allowWipe is unset (default)", async () => {
    const f = new ImapFixtures(base);
    await expect(f.wipe()).rejects.toThrow(/refused|disposable|MAILPOUCH_E2E_ALLOW_WIPE/i);
  });

  it("refuses to wipe when allowWipe is explicitly false", async () => {
    const f = new ImapFixtures({ ...base, allowWipe: false });
    await expect(f.wipe()).rejects.toThrow(/refused/i);
  });

  it("the refusal names the mailbox so an accidental real-account run is obvious", async () => {
    const f = new ImapFixtures(base);
    await expect(f.wipe()).rejects.toThrow(/real@example\.com/);
  });
});
