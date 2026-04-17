import { describe, it, expect } from "vitest";
import { runWithCaller, currentCaller } from "./caller-context.js";

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
