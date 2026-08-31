import { describe, it, expect } from "vitest";
import * as mod from "./folders.js";
import type { ToolCallContext, ToolResult } from "./types.js";
import type { EmailFolder } from "../types/index.js";

/** Minimal ctx stub — folder handlers only touch imapService + the response helpers. */
function makeCtx(over: Partial<ToolCallContext>): ToolCallContext {
  const ok = (structured: Record<string, unknown>): ToolResult => ({
    content: [{ type: "text", text: JSON.stringify(structured) }],
    structuredContent: structured,
  });
  return { ok, ...over } as unknown as ToolCallContext;
}

describe("get_folders tool contract", () => {
  const def = mod.defs.find((d) => d.name === "get_folders")!;

  it("advertises specialUse + folderType in its outputSchema (capability discovery)", () => {
    const props = (def.outputSchema as { properties: { folders: { items: { properties: Record<string, unknown>; required: string[] } } } })
      .properties.folders.items;
    expect(props.properties.specialUse).toBeDefined();
    expect(props.properties.folderType).toBeDefined();
    expect((props.properties.folderType as { enum: string[] }).enum)
      .toEqual(["system", "user-folder", "label"]);
    // folderType is always populated by the service, so the contract requires it;
    // specialUse stays optional (ordinary folders have none).
    expect(props.required).toEqual(["name", "path", "totalMessages", "unreadMessages", "folderType"]);
    expect(props.required).toContain("folderType");
    expect(props.required).not.toContain("specialUse");
  });

  it("description steers agents to specialUse over English-name matching", () => {
    expect(def.description).toMatch(/specialUse/);
    expect(def.description).toMatch(/All Mail|\\\\All/);
  });

  it("passes folderType + specialUse through to structuredContent", async () => {
    const folders: EmailFolder[] = [
      { name: "INBOX", path: "INBOX", totalMessages: 3, unreadMessages: 1, specialUse: "\\Inbox", folderType: "system" },
      { name: "Trash", path: "Papelera", totalMessages: 0, unreadMessages: 0, specialUse: "\\Trash", folderType: "system" },
      { name: "Work", path: "Labels/Work", totalMessages: 5, unreadMessages: 0, folderType: "label" },
      { name: "Project", path: "Folders/Project", totalMessages: 2, unreadMessages: 0, folderType: "user-folder" },
    ];
    const ctx = makeCtx({ imapService: { getFolders: async () => folders } as unknown as ToolCallContext["imapService"] });
    const res = await mod.handlers.get_folders(ctx);
    const out = res.structuredContent as { folders: EmailFolder[] };
    expect(out.folders).toHaveLength(4);
    expect(out.folders[1]).toMatchObject({ path: "Papelera", specialUse: "\\Trash", folderType: "system" });
    expect(out.folders[2]).toMatchObject({ folderType: "label" });
    expect(out.folders[3]).toMatchObject({ folderType: "user-folder" });
  });
});
