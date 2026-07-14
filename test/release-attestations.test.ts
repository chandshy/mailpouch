import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  BRIDGE_E2E_STATUS_CONTEXT,
  REQUIRED_RELEASE_WORKFLOWS,
  requireSuccessfulBridgeStatus,
  requireSuccessfulWorkflowRun,
} from "../scripts/lib/release-attestations.mjs";

const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const WORKFLOW = REQUIRED_RELEASE_WORKFLOWS[0]!;

function workflowRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 10,
    run_number: 10,
    run_attempt: 1,
    head_sha: SHA,
    status: "completed",
    conclusion: "success",
    html_url: "https://github.test/actions/runs/10",
    ...overrides,
  };
}

function commitStatus(overrides: Record<string, unknown> = {}) {
  return {
    id: 10,
    context: BRIDGE_E2E_STATUS_CONTEXT,
    state: "success",
    target_url: "https://github.test/commit/a",
    description: "passed",
    ...overrides,
  };
}

describe("release exact-SHA attestations", () => {
  it("accepts successful hosted and Bridge evidence for the release commit", () => {
    expect(requireSuccessfulWorkflowRun({
      expectedSha: SHA,
      workflow: WORKFLOW,
      runs: [workflowRun()],
    })).toMatchObject({ id: 10, runNumber: 10, runAttempt: 1 });

    expect(requireSuccessfulBridgeStatus({
      expectedSha: SHA,
      combinedStatus: { sha: SHA, statuses: [commitStatus()] },
    })).toMatchObject({ id: 10, description: "passed" });
  });

  it("does not let an older workflow success mask a newer unfinished or failed run", () => {
    const oldSuccess = workflowRun({ id: 10, run_number: 10 });
    const newRunning = workflowRun({
      id: 11,
      run_number: 11,
      status: "in_progress",
      conclusion: null,
    });
    expect(() => requireSuccessfulWorkflowRun({
      expectedSha: SHA,
      workflow: WORKFLOW,
      runs: [oldSuccess, newRunning],
    })).toThrow(/in_progress\/null/);

    const newFailure = workflowRun({
      id: 12,
      run_number: 12,
      status: "completed",
      conclusion: "failure",
    });
    expect(() => requireSuccessfulWorkflowRun({
      expectedSha: SHA,
      workflow: WORKFLOW,
      runs: [newFailure, oldSuccess],
    })).toThrow(/completed\/failure/);
  });

  it("rejects hosted evidence that is absent or belongs to another commit", () => {
    expect(() => requireSuccessfulWorkflowRun({
      expectedSha: SHA,
      workflow: WORKFLOW,
      runs: [workflowRun({ head_sha: OTHER_SHA })],
    })).toThrow(/no run for release commit/);
    expect(() => requireSuccessfulWorkflowRun({
      expectedSha: SHA,
      workflow: WORKFLOW,
      runs: [],
    })).toThrow(/no run for release commit/);
  });

  it("does not let an older Bridge success mask a newer failure or pending run", () => {
    const oldSuccess = commitStatus({ id: 10, state: "success" });
    for (const state of ["failure", "pending", "error"]) {
      expect(() => requireSuccessfulBridgeStatus({
        expectedSha: SHA,
        combinedStatus: {
          sha: SHA,
          statuses: [commitStatus({ id: 11, state }), oldSuccess],
        },
      })).toThrow(new RegExp(`is ${state}`));
    }
  });

  it("rejects a missing Bridge context and a status response for another SHA", () => {
    expect(() => requireSuccessfulBridgeStatus({
      expectedSha: SHA,
      combinedStatus: { sha: SHA, statuses: [commitStatus({ context: "other/check" })] },
    })).toThrow(/Missing mailpouch\/proton-bridge-e2e/);
    expect(() => requireSuccessfulBridgeStatus({
      expectedSha: SHA,
      combinedStatus: { sha: OTHER_SHA, statuses: [commitStatus()] },
    })).toThrow(/not release commit/);
  });

  it("wires the publish gate to hosted workflows, Bridge status, and tagged-release checks", () => {
    const workflow = readFileSync(".github/workflows/publish.yml", "utf8");
    const checker = readFileSync("scripts/check-release-attestations.mjs", "utf8");
    const attester = readFileSync("scripts/attest-bridge-e2e.mjs", "utf8");

    expect(workflow).toContain("actions: read");
    expect(workflow).toContain("statuses: read");
    expect(workflow).toContain('node scripts/check-release-attestations.mjs "$COMMIT_SHA"');
    expect(workflow).toContain("COMMIT_SHA: ${{ steps.release_ref.outputs.commit_sha }}");
    expect(workflow).toContain("npm run preship:fast");
    expect(workflow).toContain("npm run build:clean");
    expect(workflow).toContain('CHECK_CHANGELOG_BODY: "1"');

    expect(checker).toContain("for (const workflow of REQUIRED_RELEASE_WORKFLOWS)");
    expect(REQUIRED_RELEASE_WORKFLOWS.map(item => item.id)).toEqual(["ci.yml", "preship.yml"]);
    const pending = attester.indexOf('await postStatus("pending"');
    const cleanInstall = attester.indexOf('["ci", "--ignore-scripts"]');
    const nativeRebuild = attester.indexOf(
      '["rebuild", "better-sqlite3", "@napi-rs/keyring"]',
    );
    const typecheck = attester.indexOf('runRequiredNpmScript("typecheck"');
    const cleanBuild = attester.indexOf('runRequiredNpmScript("build:clean"');
    const bridgeE2e = attester.indexOf('runRequiredNpmScript("test:e2e:bridge"');

    expect(pending).toBeGreaterThan(-1);
    expect(cleanInstall).toBeGreaterThan(pending);
    expect(nativeRebuild).toBeGreaterThan(cleanInstall);
    expect(typecheck).toBeGreaterThan(nativeRebuild);
    expect(cleanBuild).toBeGreaterThan(typecheck);
    expect(bridgeE2e).toBeGreaterThan(cleanBuild);
    expect(attester).toContain("env: childEnv");
    expect(attester).toContain("delete childEnv[name]");
    for (const secret of [
      "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "NODE_AUTH_TOKEN",
      "NPM_TOKEN",
    ]) expect(attester).toContain(`"${secret}"`);
    expect(attester).toContain('runRequiredNpmScript("typecheck"');
    expect(attester).toContain('runRequiredNpmScript("build:clean"');
    expect(attester.indexOf('runRequiredNpmScript("build:clean"'))
      .toBeLessThan(attester.indexOf('runRequiredNpmScript("test:e2e:bridge"'));
  });
});
