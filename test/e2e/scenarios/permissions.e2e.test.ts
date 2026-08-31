import { describe, expect, it } from "vitest";
import type { PermissionPreset } from "../../../src/config/schema.js";
import { startE2E, type E2EHarness } from "../mcp-client.js";
import { PROMO_CREDIT_KARMA } from "../fixtures/seed-data.js";

type Probe = readonly [name: string, args: Record<string, unknown>];

const SEND: Probe[] = [
  ["send_email", { to: "noreply@example.com", subject: "blocked probe", body: "blocked probe" }],
  ["reply_to_email", { emailId: "1", body: "blocked probe" }],
  ["forward_email", { emailId: "1", to: "noreply@example.com" }],
  ["send_test_email", { to: "noreply@example.com" }],
  ["save_draft", {}],
  ["schedule_email", { to: "noreply@example.com", subject: "blocked probe", body: "blocked probe", send_at: "2099-01-01T00:00:00Z" }],
  ["list_scheduled_emails", {}],
  ["cancel_scheduled_email", { id: "missing" }],
  ["list_proton_scheduled", {}],
  ["remind_if_no_reply", { email_id: "1", after_days: 1 }],
  ["list_pending_reminders", {}],
  ["cancel_reminder", { reminder_id: "missing" }],
  ["check_reminders", {}],
];

const STATE: Probe[] = [
  ["mark_email_read", { emailId: "1", sourceFolder: "INBOX" }],
  ["star_email", { emailId: "1", sourceFolder: "INBOX" }],
  ["move_email", { emailId: "1", targetFolder: "Archive", sourceFolder: "INBOX" }],
  ["archive_email", { emailId: "1", sourceFolder: "INBOX" }],
  ["move_to_folder", { emailId: "1", folder: "Archive", sourceFolder: "INBOX" }],
  ["bulk_mark_read", { emailIds: ["1"], sourceFolder: "INBOX" }],
  ["bulk_star", { emailIds: ["1"], sourceFolder: "INBOX" }],
  ["bulk_move_emails", { emailIds: ["1"], targetFolder: "Archive", sourceFolder: "INBOX" }],
  ["move_to_label", { emailId: "1", label: "blocked-probe", sourceFolder: "INBOX" }],
  ["bulk_move_to_label", { emailIds: ["1"], label: "blocked-probe", sourceFolder: "INBOX" }],
  ["remove_label", { emailId: "1", label: "blocked-probe" }],
  ["bulk_remove_label", { emailIds: ["1"], label: "blocked-probe" }],
  ["sync_folders", {}],
];

const FULL: Probe[] = [
  ["delete_email", { emailId: "1", sourceFolder: "INBOX" }],
  ["bulk_delete_emails", { emailIds: ["1"], sourceFolder: "INBOX" }],
  ["bulk_delete", { emailIds: ["1"], sourceFolder: "INBOX" }],
  ["create_folder", { folderName: "Folders/blocked-probe" }],
  ["delete_folder", { folderName: "Folders/blocked-probe" }],
  ["rename_folder", { oldName: "Folders/blocked-probe", newName: "Folders/blocked-probe-2" }],
  ["alias_create_random", {}],
  ["alias_create_custom", { aliasPrefix: "blocked-probe", signedSuffix: "invalid" }],
  ["alias_toggle", { aliasId: "missing" }],
  ["alias_delete", { aliasId: "missing" }],
  ["pass_list", {}],
  ["pass_search", { query: "blocked-probe" }],
  ["pass_get", { item_id: "missing" }],
  ["shutdown_server", {}],
  ["restart_server", {}],
];

async function expectBlocked(h: E2EHarness, probes: Probe[], preset: PermissionPreset): Promise<void> {
  for (const [name, args] of probes) {
    const result = await h.callRaw(name, args);
    expect(h.isPermissionBlocked(result), `${preset}: ${name} should be blocked`).toBe(true);
  }
}

describe("permission preset matrix — ownership-scoped", () => {
  for (const preset of ["read_only", "send_only", "supervised", "full"] as const) {
    it(`${preset} advertises and enforces only its permitted surface`, async () => {
      const h = await startE2E({ safe: true, preset });
      try {
        const sendAllowed = preset !== "read_only";
        const stateAllowed = preset === "supervised" || preset === "full";
        const destructiveAllowed = preset === "supervised" || preset === "full";

        expect(h.isPermissionBlocked(await h.callRaw("get_connection_status"))).toBe(false);
        if (!sendAllowed) await expectBlocked(h, SEND, preset);
        else expect(h.isPermissionBlocked(await h.callRaw("list_scheduled_emails"))).toBe(false);
        if (!stateAllowed) await expectBlocked(h, STATE, preset);
        if (!destructiveAllowed) await expectBlocked(h, FULL, preset);

        if (stateAllowed) {
          const owned = { ...PROMO_CREDIT_KARMA, subject: `${h.runToken} permission-${preset}` };
          const { uid } = await h.appendVisibleSeed("INBOX", owned);
          const result = await h.callRaw("mark_email_read", {
            emailId: String(uid),
            sourceFolder: "INBOX",
            isRead: true,
          });
          expect(h.isPermissionBlocked(result), `${preset}: owned state mutation`).toBe(false);
          expect(await h.imap.getFlags("INBOX", uid)).toContain("\\Seen");

          if (destructiveAllowed) {
            const confirmation = await h.callRaw("delete_email", {
              emailId: String(uid),
              sourceFolder: "INBOX",
            });
            expect(h.isPermissionBlocked(confirmation), `${preset}: destructive tool should reach confirmation gate`).toBe(false);
          }
        }
      } finally {
        await h.close();
      }
    });
  }
});
