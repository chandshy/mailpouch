import { describe, it, expect, vi } from "vitest";
import mod from "./actions.js";
import { ALL_TOOLS } from "../config/schema.js";
import type { ToolCallContext, ToolResult } from "./types.js";

function makeCtx(over: Partial<ToolCallContext>): ToolCallContext {
  const actionOk = (): ToolResult => ({ content: [{ type: "text", text: "Done." }], structuredContent: { success: true } });
  return { actionOk, invalidateAnalytics: () => {}, ...over } as unknown as ToolCallContext;
}

describe("mark_answered / mark_forwarded tools (Phase 4 flag gap)", () => {
  it("both tools are registered in defs and ALL_TOOLS", () => {
    expect(mod.defs.some((d) => d.name === "mark_answered")).toBe(true);
    expect(mod.defs.some((d) => d.name === "mark_forwarded")).toBe(true);
    expect(ALL_TOOLS).toContain("mark_answered");
    expect(ALL_TOOLS).toContain("mark_forwarded");
  });

  it("mark_answered sets the \\Answered flag via setFlag (defaults answered=true)", async () => {
    const setFlag = vi.fn().mockResolvedValue(true);
    const ctx = makeCtx({ args: { emailId: "42" }, imapService: { setFlag } as unknown as ToolCallContext["imapService"] });
    await mod.handlers.mark_answered(ctx);
    expect(setFlag).toHaveBeenCalledWith("42", "\\Answered", true, undefined);
  });

  it("mark_answered can CLEAR the flag and threads sourceFolder", async () => {
    const setFlag = vi.fn().mockResolvedValue(true);
    const ctx = makeCtx({ args: { emailId: "7", answered: false, sourceFolder: "Folders/Work" }, imapService: { setFlag } as unknown as ToolCallContext["imapService"] });
    await mod.handlers.mark_answered(ctx);
    expect(setFlag).toHaveBeenCalledWith("7", "\\Answered", false, "Folders/Work");
  });

  it("mark_forwarded sets the $Forwarded keyword (the flag readers honour)", async () => {
    const setFlag = vi.fn().mockResolvedValue(true);
    const ctx = makeCtx({ args: { emailId: "99" }, imapService: { setFlag } as unknown as ToolCallContext["imapService"] });
    await mod.handlers.mark_forwarded(ctx);
    expect(setFlag).toHaveBeenCalledWith("99", "$Forwarded", true, undefined);
  });

  it("mark_forwarded can CLEAR the keyword and threads sourceFolder", async () => {
    const setFlag = vi.fn().mockResolvedValue(true);
    const ctx = makeCtx({ args: { emailId: "8", forwarded: false, sourceFolder: "Labels/Foo" }, imapService: { setFlag } as unknown as ToolCallContext["imapService"] });
    await mod.handlers.mark_forwarded(ctx);
    expect(setFlag).toHaveBeenCalledWith("8", "$Forwarded", false, "Labels/Foo");
  });

  it("rejects a non-boolean answered/forwarded", async () => {
    const ctx = makeCtx({ args: { emailId: "1", answered: "yes" }, imapService: { setFlag: vi.fn() } as unknown as ToolCallContext["imapService"] });
    await expect(mod.handlers.mark_answered(ctx)).rejects.toThrow(/must be a boolean/);
    const ctx2 = makeCtx({ args: { emailId: "1", forwarded: 1 }, imapService: { setFlag: vi.fn() } as unknown as ToolCallContext["imapService"] });
    await expect(mod.handlers.mark_forwarded(ctx2)).rejects.toThrow(/must be a boolean/);
  });
});
