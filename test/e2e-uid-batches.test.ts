import { describe, expect, it } from "vitest";
import {
  BRIDGE_MUTATION_UID_BATCH_SIZE,
  bridgeMutationUidBatches,
  chunkUids,
} from "./e2e/support/uid-batches.mjs";
import {
  isFatalCleanupError,
  requireMutationResult,
} from "./e2e/support/mutation-result.mjs";

describe("Bridge E2E UID batching", () => {
  it("issues live mutations one exact-owned UID at a time", () => {
    expect(BRIDGE_MUTATION_UID_BATCH_SIZE).toBe(1);
    expect(bridgeMutationUidBatches([19, 7, 11, 7])).toEqual([[7], [11], [19]]);
  });

  it("bounds large baseline FETCH operands without losing sparse UIDs", () => {
    const uids = Array.from({ length: 1_203 }, (_, index) => index * 3 + 1);
    const chunks = chunkUids(uids, 500);

    expect(chunks.map((chunk) => chunk.length)).toEqual([500, 500, 203]);
    expect(chunks.flat()).toEqual(uids);
  });

  it("rejects invalid UIDs and batch sizes", () => {
    expect(() => chunkUids([1, 0], 1)).toThrow(/positive safe integers/i);
    expect(() => chunkUids([1], 0)).toThrow(/batch size/i);
  });

  it("treats ImapFlow false and undefined mutation results as fatal", () => {
    for (const result of [false, undefined, null]) {
      let thrown: unknown;
      try { requireMutationResult(result, "exact-owned UID MOVE"); }
      catch (error) { thrown = error; }
      expect(isFatalCleanupError(thrown)).toBe(true);
    }
    expect(requireMutationResult({ ok: true }, "exact-owned UID MOVE")).toEqual({ ok: true });
  });
});
