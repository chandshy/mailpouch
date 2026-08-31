import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./agent-harness.test.ts", import.meta.url), "utf8");
const permissionMatrix = readFileSync(new URL("./e2e/scenarios/permissions.e2e.test.ts", import.meta.url), "utf8");

function section(start: string, end: string): string {
  const startAt = source.indexOf(start);
  const endAt = source.indexOf(end, startAt + start.length);
  expect(startAt, `missing section start ${start}`).toBeGreaterThanOrEqual(0);
  expect(endAt, `missing section end ${end}`).toBeGreaterThan(startAt);
  return source.slice(startAt, endAt);
}

describe("agent harness live-mail safety", () => {
  it("never dispatches a flag mutation against the pre-existing read target", () => {
    const actions = section("// ─── Actions", "// ─── Drafts & scheduling");

    expect(actions).not.toContain('callRaw("mark_email_read"');
    expect(actions).not.toContain('callRaw("star_email"');
    expect(actions).toContain('it.skip("mark_email_read requires a run-owned seeded message"');
    expect(actions).toContain('it.skip("star_email requires a run-owned seeded message"');
    expect(actions).toContain('callRaw("extract_action_items"');
  });

  it("does not dispatch live folder mutations", () => {
    const folders = section("// ─── Folders", "// ─── Actions");

    expect(folders).not.toContain('callRaw("create_folder"');
    expect(folders).not.toContain('callRaw("delete_folder"');
    expect(folders).toContain('it.skip("create/delete folder lifecycle requires an isolated backend"');
  });

  it("uses missing UUID-owned sources for destructive-gate probes", () => {
    const destructive = section("// ─── Permission gate", "// ─── Argument validation");

    expect(destructive).toContain('ownedHarnessFolder("missing-delete-source")');
    expect(destructive).toContain('ownedHarnessFolder("missing-bulk-delete-source")');
    expect(destructive).not.toContain('folder: "INBOX"');
  });

  it("runs the preset matrix only through ownership-scoped fixtures", () => {
    expect(source).not.toContain("permission gate — preset security matrix");
    expect(permissionMatrix).toContain("startE2E({ safe: true, preset })");
    expect(permissionMatrix).toContain('appendVisibleSeed("INBOX", owned)');
    expect(permissionMatrix).not.toContain('callRaw("create_folder"');
    expect(permissionMatrix).not.toContain('callRaw("delete_folder"');
  });
});
