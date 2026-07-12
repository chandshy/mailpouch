/**
 * Smoke test — proves the harness boots, mailpouch spawns + connects to
 * Greenmail, and basic IMAP fixtures round-trip cleanly. Every other
 * scenario file assumes these primitives work; if this fails, debug here
 * before chasing scenario-specific failures.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startE2E, type E2EHarness } from "../mcp-client.js";
import * as docker from "../support/docker.js";
import { PROMO_CREDIT_KARMA } from "../fixtures/seed-data.js";
import { advertisedToolDefs } from "../../../src/tools/registry.js";
import { toolsForTier, parseToolTier } from "../../../src/config/schema.js";

describe("smoke.e2e — harness boots and round-trips", () => {
  let h: E2EHarness;

  beforeAll(async () => {
    await docker.up();
    h = await startE2E();
  }, 60_000);

  afterAll(async () => {
    if (h) {
      try { await h.imap.wipe(); } catch { /* container may already be gone */ }
      await h.close();
    }
  });

  beforeEach(async () => {
    await h.resetState();
  });

  it("MCP listTools returns the mailpouch tool surface", async () => {
    const { tools } = await h.client.listTools();
    const names = tools.map((t) => t.name).sort();
    const set = new Set(names);
    // Sample assertions across categories.
    expect(set.has("get_emails")).toBe(true);
    expect(set.has("bulk_move_emails")).toBe(true);
    expect(set.has("delete_email")).toBe(true);
    expect(set.has("get_folders")).toBe(true);
    // TEST-020: lock the WHOLE surface so a tool silently disappearing (or an
    // accidental rename) fails loudly instead of slipping past the 4 spot
    // checks. Assert against the registry filtered by the same tier the server
    // applies (the harness runs no tier override → "complete"), rather than a
    // committed snapshot — vitest won't write a new snapshot in CI, and this is
    // self-updating when the registry changes.
    const visible = toolsForTier(parseToolTier(undefined));
    // Greenmail intentionally configures neither SimpleLogin nor Proton Pass;
    // listTools must therefore match the capability-filtered registry rather
    // than advertise companion tools that cannot run in this harness.
    const expectedNames = advertisedToolDefs({ simpleLogin: false, pass: false })
      .map((d) => d.name)
      .filter((n) => visible.has(n))
      .sort();
    expect(names).toEqual(expectedNames);
  });

  it("ImapFixtures APPEND + listUids round-trips", async () => {
    const uid = await h.imap.appendSeed("INBOX", PROMO_CREDIT_KARMA);
    expect(uid).toBeGreaterThan(0);
    const uids = await h.imap.listUids("INBOX");
    expect(uids).toContain(uid);
  });

  it("mailpouch get_folders sees INBOX", async () => {
    const result = h.json<{ folders: { path: string }[] }>(await h.call("get_folders"));
    const paths = result.folders.map((f) => f.path);
    expect(paths).toContain("INBOX");
  });

  it("mailpouch get_email_by_id fetches a seeded message", async () => {
    // Read-after-write through mailpouch validates the full path:
    // ImapFixtures.append → mailpouch IMAP fetch → MCP response. Using
    // get_email_by_id (which does a fresh UID FETCH) sidesteps the
    // mailbox-EXISTS cache lag that get_emails can hit on Greenmail.
    const uid = await h.imap.appendSeed("INBOX", PROMO_CREDIT_KARMA);
    await h.call("clear_cache");
    const result = h.json<{ subject: string }>(
      await h.call("get_email_by_id", { emailId: String(uid), folder: "INBOX" })
    );
    expect(result.subject).toBe(PROMO_CREDIT_KARMA.subject);
  });
});
