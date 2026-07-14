import { describe, expect, it } from "vitest";
import {
  createRescueLifecycle,
  markRescueCreated,
  markRescueRetained,
  permitInitialRescueStage,
  permitNextRescueStage,
  planRescueRound,
} from "./e2e/support/rescue-lifecycle.mjs";

const defaultIdentities = (allMailOwned: number) => Array.from(
  { length: allMailOwned },
  (_, index) => `message-id:owned-${index + 1}@example.test`,
);
const absent = (allMailOwned: number, identities = defaultIdentities(allMailOwned)) => ({
  rescueExists: false,
  rescueOwned: 0,
  rescueTotal: 0,
  allMailOwned,
  allMailOwnedIdentities: identities,
});
const present = (
  rescueOwned: number,
  rescueTotal: number,
  allMailOwned: number,
  identities = defaultIdentities(allMailOwned),
) => ({
  rescueExists: true,
  rescueOwned,
  rescueTotal,
  allMailOwned,
  allMailOwnedIdentities: identities,
});

describe("All Mail rescue lifecycle", () => {
  it("bounds initial staging and retains the rescue after two source-clean empty proofs", () => {
    const state = createRescueLifecycle();
    permitInitialRescueStage(state);
    expect(planRescueRound(state, absent(1))).toEqual({ action: "stage", phaseChanged: true });
    expect(state.phase).toBe("create-pending");
    markRescueCreated(state);
    expect(state.phase).toBe("copy-pending");

    expect(planRescueRound(state, present(1, 1, 1))).toEqual({ action: "drain", phaseChanged: true });
    expect(state.phase).toBe("payload-observed");
    expect(planRescueRound(state, present(0, 0, 0))).toEqual({ action: "none", phaseChanged: false });
    expect(planRescueRound(state, present(0, 0, 0))).toEqual({ action: "retain", phaseChanged: false });
    expect(markRescueRetained(state)).toBe(true);

    for (let round = 0; round < 5; round++) {
      expect(planRescueRound(state, absent(1)).action).toBe("none");
    }
  });

  it("does not suppress a later owned record after a transient clean All Mail view", () => {
    const state = createRescueLifecycle();
    expect(planRescueRound(state, absent(0))).toEqual({ action: "none", phaseChanged: false });
    expect(state.phase).toBe("idle");
    expect(planRescueRound(state, absent(1))).toEqual({ action: "none", phaseChanged: false });
    permitInitialRescueStage(state);
    expect(planRescueRound(state, absent(1))).toEqual({ action: "stage", phaseChanged: true });
  });

  it("never replays an ambiguous pending copy after restart", () => {
    const restarted = createRescueLifecycle("copy-pending");
    expect(planRescueRound(restarted, absent(1))).toEqual({ action: "none", phaseChanged: false });
    expect(planRescueRound(restarted, present(1, 1, 1))).toEqual({ action: "drain", phaseChanged: true });
  });

  it("consumes one volatile next-stage permission and restart cannot reconstruct it", () => {
    const state = createRescueLifecycle();
    permitInitialRescueStage(state);
    expect(planRescueRound(state, absent(3)).action).toBe("stage");
    markRescueCreated(state);
    expect(planRescueRound(state, present(1, 1, 3)).action).toBe("drain");
    permitNextRescueStage(state);
    expect(planRescueRound(state, present(0, 0, 3)).action).toBe("none");
    expect(planRescueRound(state, present(0, 0, 2, defaultIdentities(3).slice(1)))).toEqual({
      action: "stage-existing",
      phaseChanged: false,
    });
    expect(planRescueRound(state, present(0, 0, 2)).action).toBe("none");

    const restarted = createRescueLifecycle("payload-observed");
    expect(planRescueRound(restarted, present(0, 0, 2)).action).toBe("none");
  });

  it("supports sequential singleton cycles only after each explicit confirmation", () => {
    const state = createRescueLifecycle();
    permitInitialRescueStage(state);
    expect(planRescueRound(state, absent(3)).action).toBe("stage");
    markRescueCreated(state);
    expect(planRescueRound(state, present(1, 1, 3)).action).toBe("drain");

    permitNextRescueStage(state);
    expect(planRescueRound(state, present(0, 0, 3)).action).toBe("none");
    const finalTwo = defaultIdentities(3).slice(1);
    expect(planRescueRound(state, present(0, 0, 2, finalTwo)).action).toBe("stage-existing");
    expect(planRescueRound(state, present(1, 1, 2, finalTwo)).action).toBe("drain");

    permitNextRescueStage(state);
    expect(planRescueRound(state, present(0, 0, 2, finalTwo)).action).toBe("none");
    const finalOne = finalTwo.slice(1);
    expect(planRescueRound(state, present(0, 0, 1, finalOne)).action).toBe("stage-existing");
    expect(planRescueRound(state, present(1, 1, 1, finalOne)).action).toBe("drain");
    expect(planRescueRound(state, present(0, 0, 0)).action).toBe("none");
    expect(planRescueRound(state, present(0, 0, 0)).action).toBe("retain");
  });

  it("allows one operator-rearmed COPY only after two fresh empty rescue proofs", () => {
    const state = createRescueLifecycle("payload-observed", { operatorRetryPermitted: true });
    expect(planRescueRound(state, present(0, 0, 2)).action).toBe("none");
    expect(planRescueRound(state, present(0, 0, 2)).action).toBe("stage-existing");
    expect(planRescueRound(state, present(0, 0, 2)).action).toBe("none");

    const restarted = createRescueLifecycle("payload-observed");
    expect(planRescueRound(restarted, present(0, 0, 2)).action).toBe("none");
    expect(planRescueRound(restarted, present(0, 0, 2)).action).toBe("none");
  });

  it("allows the same bounded operator rearm for an ambiguous initial copy", () => {
    const state = createRescueLifecycle("copy-pending", { operatorRetryPermitted: true });
    expect(planRescueRound(state, present(0, 0, 1)).action).toBe("none");
    expect(planRescueRound(state, present(0, 0, 1)).action).toBe("stage-existing");
    expect(planRescueRound(state, present(0, 0, 1)).action).toBe("none");
  });

  it("requires explicit operator authority to adopt an ambiguously-created rescue", () => {
    const automatic = createRescueLifecycle("create-pending");
    expect(planRescueRound(automatic, present(0, 0, 1)).action).toBe("none");
    expect(planRescueRound(automatic, present(0, 0, 1)).action).toBe("none");

    const operator = createRescueLifecycle("create-pending", { operatorRetryPermitted: true });
    expect(planRescueRound(operator, present(0, 0, 1)).action).toBe("none");
    expect(planRescueRound(operator, present(0, 0, 1)).action).toBe("stage-existing");
  });

  it("requires two fresh absence proofs before operator-authorized CREATE retry", () => {
    const state = createRescueLifecycle("create-pending", { operatorRetryPermitted: true });
    expect(planRescueRound(state, absent(1)).action).toBe("none");
    expect(planRescueRound(state, absent(1)).action).toBe("retry-stage");
    expect(planRescueRound(state, absent(1)).action).toBe("none");
  });

  it("allows nonce-bound operator recovery of late residue after durable completion", () => {
    const state = createRescueLifecycle("complete", { operatorRetryPermitted: true });
    expect(planRescueRound(state, present(0, 0, 1)).action).toBe("none");
    expect(planRescueRound(state, present(0, 0, 1)).action).toBe("stage-existing");
    expect(state.phase).toBe("complete");
  });

  it("does not accept a count decrease while the previously staged identity remains", () => {
    const state = createRescueLifecycle();
    permitInitialRescueStage(state);
    const original = defaultIdentities(3);
    expect(planRescueRound(state, absent(3, original)).action).toBe("stage");
    markRescueCreated(state);
    expect(planRescueRound(state, present(1, 1, 3, original)).action).toBe("drain");
    permitNextRescueStage(state);

    // A different record vanished, but the record staged in the prior cycle
    // is still projected. Count alone must never authorize another COPY.
    expect(planRescueRound(state, present(0, 0, 2, original.slice(0, 2))).action).toBe("none");
  });

  it("recovers a stable late replacement without requiring the owned count to decrease", () => {
    const state = createRescueLifecycle();
    permitInitialRescueStage(state);
    const original = defaultIdentities(2);
    expect(planRescueRound(state, absent(2, original)).action).toBe("stage");
    markRescueCreated(state);
    expect(planRescueRound(state, present(1, 1, 2, original)).action).toBe("drain");
    permitNextRescueStage(state);

    const lateReplacement = [original[1], "message-id:late-owned@example.test"];
    // The first fresh view proves that the staged identity has zero matches
    // and begins, but does not complete, the stable replacement proof.
    expect(planRescueRound(state, present(0, 0, 2, lateReplacement)).action).toBe("none");
    expect(planRescueRound(state, present(0, 0, 2, lateReplacement)).action).toBe("stage-existing");
  });

  it("does not persist or reuse a same-cardinality replacement proof", () => {
    const state = createRescueLifecycle();
    permitInitialRescueStage(state);
    const original = defaultIdentities(2);
    expect(planRescueRound(state, absent(2, original)).action).toBe("stage");
    markRescueCreated(state);
    expect(planRescueRound(state, present(1, 1, 2, original)).action).toBe("drain");
    permitNextRescueStage(state);

    const firstCandidate = [original[1], "message-id:late-a@example.test"];
    const changedCandidate = [original[1], "message-id:late-b@example.test"];
    expect(planRescueRound(state, present(0, 0, 2, firstCandidate)).action).toBe("none");
    expect(planRescueRound(state, present(0, 0, 2, changedCandidate)).action).toBe("none");

    const restarted = createRescueLifecycle("payload-observed");
    expect(planRescueRound(restarted, present(0, 0, 2, changedCandidate)).action).toBe("none");
    expect(planRescueRound(restarted, present(0, 0, 2, changedCandidate)).action).toBe("none");
  });

  it("restarts replacement proof after the previously staged identity reappears", () => {
    const state = createRescueLifecycle();
    permitInitialRescueStage(state);
    const original = defaultIdentities(2);
    expect(planRescueRound(state, absent(2, original)).action).toBe("stage");
    markRescueCreated(state);
    expect(planRescueRound(state, present(1, 1, 2, original)).action).toBe("drain");
    permitNextRescueStage(state);

    const replacement = [original[1], "message-id:late-owned@example.test"];
    expect(planRescueRound(state, present(0, 0, 2, replacement)).action).toBe("none");
    expect(planRescueRound(state, present(0, 0, 2, [original[0], replacement[1]])).action).toBe("none");
    expect(planRescueRound(state, present(0, 0, 2, replacement)).action).toBe("none");
    expect(planRescueRound(state, present(0, 0, 2, replacement)).action).toBe("stage-existing");
  });

  it("does not reconstruct automatic next-stage proof from a post-restart payload", () => {
    const restarted = createRescueLifecycle("copy-pending");
    expect(planRescueRound(restarted, present(1, 1, 2)).action).toBe("drain");
    expect(() => permitNextRescueStage(restarted)).toThrow(/stage identity/i);
    expect(planRescueRound(restarted, present(0, 0, 1)).action).toBe("none");
  });

  it("adopts an existing empty rescue conservatively and waits for a clean source", () => {
    const restarted = createRescueLifecycle();
    expect(planRescueRound(restarted, present(0, 0, 1))).toEqual({ action: "none", phaseChanged: true });
    expect(planRescueRound(restarted, present(0, 0, 1))).toEqual({ action: "none", phaseChanged: false });
    expect(planRescueRound(restarted, present(0, 0, 0))).toEqual({ action: "retain", phaseChanged: false });
  });

  it("fails closed on any foreign rescue content", () => {
    const state = createRescueLifecycle("copy-pending");
    expect(() => planRescueRound(state, present(1, 2, 1))).toThrow(/non-owned mail/i);
    expect(state.phase).toBe("copy-pending");
  });
});
