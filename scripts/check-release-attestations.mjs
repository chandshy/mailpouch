#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import {
  BRIDGE_E2E_STATUS_CONTEXT,
  REQUIRED_RELEASE_WORKFLOWS,
  classifyBridgeStatus,
  normalizeCommitSha,
  releaseNotesWaiveBridgeE2E,
  requireSuccessfulBridgeStatus,
  requireSuccessfulWorkflowRun,
} from "./lib/release-attestations.mjs";

const sha = normalizeCommitSha(process.argv[2] ?? process.env.MAILPOUCH_RELEASE_SHA, "release commit SHA");
const repository = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
const apiBase = (process.env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/, "");

if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
  throw new Error("GITHUB_REPOSITORY must be owner/name");
}
if (!token) {
  throw new Error("GITHUB_TOKEN is required to verify release attestations");
}

async function github(path) {
  const response = await fetch(`${apiBase}/repos/${repository}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "mailpouch-release-attestation-check",
    },
  });
  if (!response.ok) {
    const body = (await response.text()).slice(0, 500);
    throw new Error(`GitHub API ${response.status} for ${path}: ${body}`);
  }
  return response.json();
}

for (const workflow of REQUIRED_RELEASE_WORKFLOWS) {
  const payload = await github(
    `/actions/workflows/${encodeURIComponent(workflow.id)}/runs?head_sha=${sha}&per_page=100`,
  );
  const evidence = requireSuccessfulWorkflowRun({
    expectedSha: sha,
    workflow,
    runs: payload.workflow_runs,
  });
  process.stdout.write(
    `release-attestation OK: ${workflow.label} run ${String(evidence.runNumber)}` +
      `${evidence.runAttempt > 1 ? ` attempt ${String(evidence.runAttempt)}` : ""}` +
      ` (${evidence.url ?? "no URL"})\n`,
  );
}

// The Bridge E2E attestation can be waived, but ONLY by an explicit act at
// release time, in one of two channels: `waive_bridge_e2e: true` on a manual
// workflow_dispatch, or the marker in the GitHub release notes. It is
// deliberately not a repo variable or a default: a waiver has to be a decision
// someone makes and that shows up on the release itself, not ambient state
// that quietly erodes the gate.
//
// The release-notes channel exists because `release: published` takes no
// inputs. Without it that trigger could never waive, so shipping a waived
// release meant dispatching manually and letting the release event fail a few
// minutes later — after the package was already on npm. Three consecutive
// releases did exactly that, which turned a red Publish run into the expected
// outcome of a normal release and taught everyone to ignore the gate. A gate
// that always fails protects nothing; this one now fails only when evidence is
// genuinely missing AND nobody said so out loud.
//
// The alternative — hand-POSTing a green `proton-bridge-e2e` status — is worse
// in the way that matters: it makes every future release's attestation
// unfalsifiable-looking but meaningless. Waiving loudly keeps the signal honest.
//
// CI and preship attestations above are NEVER waivable.
const waivedByDispatch = process.env.MAILPOUCH_WAIVE_BRIDGE_E2E === "true";
const waivedByNotes = releaseNotesWaiveBridgeE2E(process.env.MAILPOUCH_RELEASE_BODY);
const waived = waivedByDispatch || waivedByNotes;

// The status is fetched unconditionally, even when waived. Checking the waiver
// first and returning early — the previous shape — meant a waiver skipped the
// lookup entirely, so a RED Bridge run published exactly as easily as an unrun
// one. A waiver is a statement that no evidence was gathered; it is not a
// licence to ignore evidence that was gathered and came back broken.
const verdict = classifyBridgeStatus({
  expectedSha: sha,
  combinedStatus: await github(`/commits/${sha}/status?per_page=100`),
});

if (verdict.kind === "failed") {
  throw new Error(
    `${BRIDGE_E2E_STATUS_CONTEXT} latest status for ${sha} is ${String(verdict.state)}` +
      `${verdict.evidence?.url ? ` (${verdict.evidence.url})` : ""}` +
      (waived ? " — a waiver cannot suppress a failed Bridge run, only an absent one" : ""),
  );
}

if (verdict.kind === "success") {
  process.stdout.write(
    `release-attestation OK: Proton Bridge E2E (${verdict.evidence?.url ?? "no URL"})\n`,
  );
} else if (waived) {
  const via = waivedByDispatch ? "workflow_dispatch input" : "release-notes marker";
  const because = verdict.state === "pending" ? "still running" : "never run";
  const message =
    "release-attestation WAIVED: Proton Bridge E2E was explicitly waived for this release " +
    `(commit ${sha}, via ${via}; evidence ${because}). No live Proton Bridge evidence exists for these bytes.`;
  process.stdout.write(`${message}\n`);
  // Also surface it on the run summary: a waiver buried in step logs is not the
  // "loud" this gate's design depends on.
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### ⚠️ Proton Bridge E2E waived\n\n${message}\n`,
    );
  }
} else {
  // Not waived and no usable evidence — reuse the strict checker so the error
  // wording for missing/pending evidence stays in one place.
  requireSuccessfulBridgeStatus({
    expectedSha: sha,
    combinedStatus: await github(`/commits/${sha}/status?per_page=100`),
  });
}
