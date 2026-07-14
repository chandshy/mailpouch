#!/usr/bin/env node

import {
  REQUIRED_RELEASE_WORKFLOWS,
  normalizeCommitSha,
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

const combinedStatus = await github(`/commits/${sha}/status?per_page=100`);
const bridge = requireSuccessfulBridgeStatus({ expectedSha: sha, combinedStatus });
process.stdout.write(
  `release-attestation OK: Proton Bridge E2E (${bridge.url ?? "no URL"})\n`,
);
