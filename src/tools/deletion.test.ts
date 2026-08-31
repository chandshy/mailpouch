import { describe, it, expect } from "vitest";
import * as mod from "./deletion.js";
import { DESTRUCTIVE_TOOLS } from "../config/schema.js";
import type { ToolCallContext, ToolResult } from "./types.js";

function makeCtx(over: Partial<ToolCallContext>): ToolCallContext {
  const ok = (structured: Record<string, unknown>): ToolResult => ({
    content: [{ type: "text", text: JSON.stringify(structured) }],
    structuredContent: structured,
  });
  return {
    ok,
    invalidateAnalytics: () => {},
    ...over,
  } as unknown as ToolCallContext;
}

describe("empty_trash tool", () => {
  const def = mod.defs.find((d) => d.name === "empty_trash")!;

  it("is registered as a destructive, confirm-gated tool", () => {
    expect(def).toBeDefined();
    expect((def.annotations as { destructiveHint?: boolean }).destructiveHint).toBe(true);
    // The {confirmed:true} gate is enforced in index.ts for every DESTRUCTIVE_TOOL.
    expect(DESTRUCTIVE_TOOLS.has("empty_trash")).toBe(true);
    const props = (def.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(props.confirmed).toBeDefined();
  });

  it("description makes the permanence + Trash-only scope explicit", () => {
    expect(def.description).toMatch(/PERMANENTLY/);
    expect(def.description).toMatch(/UNRECOVERABLE/);
    expect(def.description).toMatch(/Trash/);
  });

  it("handler returns the purge count and invalidates this account's analytics cache", async () => {
    let emptied = false;
    let invalidated = false;
    const ctx = makeCtx({
      imapService: { emptyTrash: async () => { emptied = true; return { deleted: 7 }; } } as unknown as ToolCallContext["imapService"],
      invalidateAnalytics: () => { invalidated = true; },
    });
    const res = await mod.handlers.empty_trash(ctx);
    expect(emptied).toBe(true);
    expect(res.structuredContent).toMatchObject({ success: true, deleted: 7 });
    expect(invalidated).toBe(true);
  });
});
