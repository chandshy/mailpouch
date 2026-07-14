/**
 * search.e2e — coverage for search_emails (IMAP server search) and the FTS
 * tools (fts_search / fts_rebuild / fts_status).
 *
 * Greenmail's IMAP SEARCH supports the standard criteria; we exercise the
 * common subset. FTS tools operate on the local cache, so we seed + sync
 * before any FTS assertions.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bridgeConfigAvailable, startE2E, type E2EHarness } from "../mcp-client.js";
import * as docker from "../support/docker.js";
import {
  PROMO_CREDIT_KARMA,
  RELEASE_NVIDIA,
} from "../fixtures/seed-data.js";

type SearchEmail = { subject: string };

/** Bridge accepts APPEND before its live IMAP search index necessarily sees
 * the message. Poll only the exact positive assertion predicate and retain the
 * last authoritative tool result for a useful failure. Negative searches are
 * intentionally not retried. */
async function waitForSearchMatch(
  h: E2EHarness,
  args: Record<string, unknown>,
  matches: (email: SearchEmail) => boolean,
  timeoutMs = bridgeConfigAvailable() ? 30_000 : 5_000,
): Promise<SearchEmail[]> {
  const deadline = Date.now() + timeoutMs;
  let emails: SearchEmail[] = [];
  do {
    const result = h.json<{ emails: SearchEmail[] }>(await h.call("search_emails", args));
    emails = result.emails;
    if (emails.some(matches)) return emails;
    const remainingMs = deadline - Date.now();
    if (remainingMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(500, remainingMs)));
    }
  } while (Date.now() < deadline);
  return emails;
}

describe("search.e2e", () => {
  let h: E2EHarness;

  beforeAll(async () => {
    if (!bridgeConfigAvailable()) await docker.restart();
    h = await startE2E();
  });

  afterAll(async () => {
    if (h) await h.close();
  });

  beforeEach(async () => {
    await h.resetState();
    await h.call("clear_cache");
    await h.call("sync_emails", { folder: "INBOX", limit: 20 });
  });

  describe("search_emails", () => {
    it("finds seeded INBOX messages by subject substring", async () => {
      const needle = h.runToken ?? `greenmail-${Date.now()}`;
      await h.imap.appendSeed("INBOX", {
        ...PROMO_CREDIT_KARMA,
        subject: `${needle} credit search probe`,
      });
      const emails = await waitForSearchMatch(
        h,
        { folder: "INBOX", subject: needle },
        (email) => email.subject.includes(needle),
      );
      expect(emails.some((email) => email.subject.includes(needle))).toBe(true);
    });

    it("returns empty for a subject that doesn't match", async () => {
      const needle = `absent-${h.runToken ?? Date.now()}-xyzqv`;
      const result = h.json<{ emails: unknown[] }>(
        await h.call("search_emails", { folder: "INBOX", subject: needle })
      );
      expect(result.emails.length).toBe(0);
    });

    // Greenmail's IMAP SEARCH FROM uses substring matching but its tokenization
    // differs from Bridge/Dovecot in some cases. Bridge-validated.
    it.runIf(bridgeConfigAvailable())("finds messages by from address — bridge-only", async () => {
      const subject = `${h.runToken} bridge from search probe`;
      await h.imap.appendSeed("INBOX", { ...RELEASE_NVIDIA, subject });
      const emails = await waitForSearchMatch(
        h,
        { folder: "INBOX", from: "nvidia.com" },
        (email) => email.subject === subject,
      );
      expect(emails.some((email) => email.subject === subject)).toBe(true);
    });
  });

  describe("fts_status", () => {
    it("returns the FTS index health metadata", async () => {
      const result = h.json<Record<string, unknown>>(await h.call("fts_status"));
      expect(result).toBeTypeOf("object");
    });
  });

  describe("fts_search", () => {
    it("returns a hits envelope even when the index is empty", async () => {
      const result = h.json<{ hits: unknown[] }>(
        // This assertion checks the response envelope, not ownership lookup.
        // A raw mpE2E UUID contains '-' operators in FTS5 query syntax, so use
        // a deliberately syntax-safe term even when the live index is empty.
        await h.call("fts_search", { query: "credit", limit: 10 })
      );
      expect(Array.isArray(result.hits)).toBe(true);
    });
  });
});
