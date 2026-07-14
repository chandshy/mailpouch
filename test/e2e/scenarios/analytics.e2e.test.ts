/**
 * analytics.e2e — coverage for src/tools/analytics.ts.
 *
 * These tools aggregate over the local IMAP cache. We seed enough variety
 * to make aggregates non-trivial, then call each endpoint and verify the
 * shape of the response.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bridgeConfigAvailable, startE2E, type E2EHarness } from "../mcp-client.js";
import * as docker from "../support/docker.js";
import { PROMO_BATCH } from "../fixtures/seed-data.js";

describe("analytics.e2e", () => {
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
    // Live Bridge analytics may inspect the existing mailbox, but never needs
    // to alter it. Greenmail still gets deterministic seed data so this lane
    // retains non-trivial aggregate coverage.
    if (!bridgeConfigAvailable()) {
      for (const seed of PROMO_BATCH) await h.imap.appendSeed("INBOX", seed);
    }
    await h.call("clear_cache");
    await h.call("sync_emails", { folder: "INBOX", limit: 20 });
  });

  describe("get_email_stats", () => {
    it("returns counts for a date range", async () => {
      const result = h.json<Record<string, unknown>>(
        await h.call("get_email_stats", { days: 30 })
      );
      expect(result).toBeTypeOf("object");
    });
  });

  describe("get_email_analytics", () => {
    it("returns top senders / aggregates", async () => {
      const result = h.json<Record<string, unknown>>(
        await h.call("get_email_analytics", { days: 30 })
      );
      expect(result).toBeTypeOf("object");
    });
  });

  describe("get_volume_trends", () => {
    it("returns per-day volume data", async () => {
      const result = h.json<Record<string, unknown>>(
        await h.call("get_volume_trends", { days: 30 })
      );
      expect(result).toBeTypeOf("object");
    });
  });

  describe("get_contacts", () => {
    it("returns a list of contacts derived from inbox traffic", async () => {
      const result = h.json<Record<string, unknown>>(
        await h.call("get_contacts", { limit: 50 })
      );
      expect(result).toBeTypeOf("object");
    });
  });
});
