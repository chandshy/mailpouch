/**
 * folders.e2e — coverage for src/tools/folders.ts.
 *
 * Exercises create/list/rename/delete of custom folders. delete_folder has
 * a destructive gate; system folders (INBOX) are protected.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bridgeConfigAvailable, startE2E, type E2EHarness } from "../mcp-client.js";
import * as docker from "../support/docker.js";

type ActionResult = { success: boolean };
type Folder = { path: string; totalMessages?: number };

describe("folders.e2e", () => {
  let h: E2EHarness;

  beforeAll(async () => {
    if (!bridgeConfigAvailable()) await docker.restart();
    h = await startE2E({ safe: true });
    expect(h.scratch).toBeDefined();
  });

  afterAll(async () => {
    if (h) await h.close();
  });

  beforeEach(async () => {
    await h.resetState();
  });

  describe("get_folders", () => {
    it("includes INBOX", async () => {
      const result = h.json<{ folders: Folder[] }>(await h.call("get_folders"));
      expect(result.folders.some((f) => f.path === "INBOX")).toBe(true);
    });

    // Disabled for live Bridge: mailbox creation cannot be paired with an
    // atomic, foreign-message-safe cleanup DELETE. Greenmail's side-channel
    // cache behavior makes this unsuitable there as well.
    it.skip("includes folders created via ImapFixtures after a sync", async () => {
      const folder = await h.scratch!.create("folders");
      await h.call("sync_folders");
      const result = h.json<{ folders: Folder[] }>(await h.call("get_folders"));
      expect(result.folders.some((f) => f.path === folder)).toBe(true);
    });
  });

  describe("create_folder", () => {
    it.skipIf(bridgeConfigAvailable())("creates a new Folders/ folder", async () => {
      const folder = h.scratch!.path("folders");
      h.json<ActionResult>(await h.call("create_folder", { folderName: folder }));
      const paths = await h.imap.listMailboxes();
      expect(paths).toContain(folder);
    });
  });

  describe("rename_folder", () => {
    it.skipIf(bridgeConfigAvailable())("renames a folder created earlier", async () => {
      const before = h.scratch!.path("folders");
      const after = h.scratch!.path("folders");
      h.json<ActionResult>(await h.call("create_folder", { folderName: before }));
      h.json<ActionResult>(
        await h.call("rename_folder", { oldName: before, newName: after })
      );
      const paths = await h.imap.listMailboxes();
      expect(paths).toContain(after);
      expect(paths).not.toContain(before);
    });
  });

  describe("delete_folder — destructive gate", () => {
    it.skipIf(bridgeConfigAvailable())("rejects without confirmed:true", async () => {
      const folder = h.scratch!.path("folders");
      h.json<ActionResult>(await h.call("create_folder", { folderName: folder }));
      const raw = await h.call("delete_folder", { folderName: folder });
      expect(raw.isError).toBe(true);
      const paths = await h.imap.listMailboxes();
      expect(paths).toContain(folder);
    });

    it.skipIf(bridgeConfigAvailable())("deletes when confirmed:true is supplied", async () => {
      const folder = h.scratch!.path("folders");
      h.json<ActionResult>(await h.call("create_folder", { folderName: folder }));
      h.json<ActionResult>(
        await h.call("delete_folder", { folderName: folder, confirmed: true })
      );
      const paths = await h.imap.listMailboxes();
      expect(paths).not.toContain(folder);
    });
  });

  describe("sync_folders", () => {
    it("returns a success result with a count", async () => {
      const result = h.json<{ success: boolean; count?: number }>(await h.call("sync_folders"));
      expect(result.success).toBe(true);
    });
  });
});
