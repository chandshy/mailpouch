/**
 * system.e2e — coverage for src/tools/system.ts.
 *
 * Tests boil down to "does this introspection endpoint return the expected
 * structure" — they don't drive new IMAP traffic.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bridgeConfigAvailable, startE2E, type E2EHarness } from "../mcp-client.js";
import * as docker from "../support/docker.js";

describe("system.e2e", () => {
  let h: E2EHarness;

  beforeAll(async () => {
    if (!bridgeConfigAvailable()) await docker.restart();
    h = await startE2E();
  });

  afterAll(async () => {
    if (h) await h.close();
  });

  describe("get_server_version", () => {
    it("returns a version string", async () => {
      const result = h.json<{ version: string }>(await h.call("get_server_version"));
      expect(typeof result.version).toBe("string");
      expect(result.version).toMatch(/^\d+\.\d+\.\d+/);
    });
  });

  describe("get_connection_status", () => {
    it("returns SMTP + IMAP status fields", async () => {
      const result = h.json<{ imap?: unknown; smtp?: unknown }>(
        await h.call("get_connection_status")
      );
      expect(result.imap).toBeTruthy();
      expect(result.smtp).toBeTruthy();
    });
  });

  describe("clear_cache", () => {
    it("succeeds without arguments", async () => {
      const result = h.json<{ success: boolean }>(await h.call("clear_cache"));
      expect(result.success).toBe(true);
    });
  });

  describe("get_logs", () => {
    it("returns a logs array", async () => {
      const result = h.json<{ logs: unknown[] }>(await h.call("get_logs", { limit: 10 }));
      expect(Array.isArray(result.logs)).toBe(true);
    });
  });
});
