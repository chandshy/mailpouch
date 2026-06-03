import { describe, it, expect } from "vitest";
import { runWithCaller, currentCaller, localAgentId } from "./caller-context.js";

describe("localAgentId", () => {
  it("is stable for the same client name and case-insensitive", () => {
    expect(localAgentId("Claude Desktop")).toBe(localAgentId("claude desktop"));
    expect(localAgentId(" Claude Desktop ")).toBe(localAgentId("claude desktop"));
  });
  it("differs across distinct client names", () => {
    expect(localAgentId("Claude Desktop")).not.toBe(localAgentId("Cursor"));
  });
  it("namespaces local ids with a stdio: prefix (distinct from OAuth pmc_ ids)", () => {
    expect(localAgentId("X")).toMatch(/^stdio:[0-9a-f]{16}$/);
  });
  it("collapses empty/whitespace names to a stable fallback bucket", () => {
    expect(localAgentId("")).toBe(localAgentId("   "));
    expect(localAgentId("")).toMatch(/^stdio:/);
  });
});

describe("caller-context", () => {
  it("returns undefined outside of a runWithCaller scope", () => {
    expect(currentCaller()).toBeUndefined();
  });

  it("propagates context through sync calls", () => {
    const result = runWithCaller(
      { clientId: "pmc_1", clientName: "A", ip: "127.0.0.1" },
      () => currentCaller(),
    );
    expect(result).toEqual({ clientId: "pmc_1", clientName: "A", ip: "127.0.0.1" });
  });

  it("propagates context through awaited async calls", async () => {
    const result = await runWithCaller(
      { clientId: "pmc_2", clientName: "B", staticBearer: true },
      async () => {
        await new Promise(r => setImmediate(r));
        return currentCaller();
      },
    );
    expect(result?.staticBearer).toBe(true);
  });

  it("isolates concurrent scopes", async () => {
    const [a, b] = await Promise.all([
      runWithCaller({ clientId: "pmc_A", clientName: "A" }, async () => {
        await new Promise(r => setTimeout(r, 5));
        return currentCaller()?.clientId;
      }),
      runWithCaller({ clientId: "pmc_B", clientName: "B" }, async () => {
        return currentCaller()?.clientId;
      }),
    ]);
    expect(a).toBe("pmc_A");
    expect(b).toBe("pmc_B");
  });
});
