export const BRIDGE_E2E_STATUS_CONTEXT = "mailpouch/proton-bridge-e2e";

export const REQUIRED_RELEASE_WORKFLOWS = Object.freeze([
  Object.freeze({ id: "ci.yml", label: "CI" }),
  Object.freeze({ id: "preship.yml", label: "preship" }),
]);

export function normalizeCommitSha(value, label = "commit SHA") {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/i.test(value)) {
    throw new Error(`${label} must be a full 40-character Git commit SHA`);
  }
  return value.toLowerCase();
}

function numeric(value) {
  return Number.isSafeInteger(value) ? value : -1;
}

function newestWorkflowRun(runs) {
  return [...runs].sort((a, b) => {
    const runNumber = numeric(b?.run_number) - numeric(a?.run_number);
    if (runNumber !== 0) return runNumber;
    const attempt = numeric(b?.run_attempt) - numeric(a?.run_attempt);
    if (attempt !== 0) return attempt;
    return numeric(b?.id) - numeric(a?.id);
  })[0];
}

/**
 * Require the newest run of one workflow for the immutable release commit to
 * have completed successfully. An older success never masks a newer queued,
 * running, cancelled, or failed run.
 */
export function requireSuccessfulWorkflowRun({ expectedSha, workflow, runs }) {
  const sha = normalizeCommitSha(expectedSha, "release commit SHA");
  if (!workflow || typeof workflow.id !== "string" || typeof workflow.label !== "string") {
    throw new Error("Release workflow descriptor is invalid");
  }
  if (!Array.isArray(runs)) {
    throw new Error(`${workflow.label} workflow response did not contain a run list`);
  }

  const exactRuns = runs.filter(run => {
    try {
      return normalizeCommitSha(run?.head_sha, `${workflow.label} head SHA`) === sha;
    } catch {
      return false;
    }
  });
  const latest = newestWorkflowRun(exactRuns);
  if (!latest) {
    throw new Error(`${workflow.label} has no run for release commit ${sha}`);
  }
  if (latest.status !== "completed" || latest.conclusion !== "success") {
    throw new Error(
      `${workflow.label} latest run for ${sha} is ${String(latest.status)}/${String(latest.conclusion)}`,
    );
  }

  return {
    id: latest.id,
    url: latest.html_url,
    runNumber: latest.run_number,
    runAttempt: latest.run_attempt,
  };
}

function newestCommitStatus(statuses) {
  return [...statuses].sort((a, b) => numeric(b?.id) - numeric(a?.id))[0];
}

/** Require the newest local Bridge E2E status on the exact release commit. */
export function requireSuccessfulBridgeStatus({ expectedSha, combinedStatus }) {
  const sha = normalizeCommitSha(expectedSha, "release commit SHA");
  if (!combinedStatus || typeof combinedStatus !== "object") {
    throw new Error("Bridge E2E status response is invalid");
  }
  const statusSha = normalizeCommitSha(combinedStatus.sha, "Bridge E2E status SHA");
  if (statusSha !== sha) {
    throw new Error(`Bridge E2E status belongs to ${statusSha}, not release commit ${sha}`);
  }
  if (!Array.isArray(combinedStatus.statuses)) {
    throw new Error("Bridge E2E status response did not contain a status list");
  }

  const latest = newestCommitStatus(
    combinedStatus.statuses.filter(status => status?.context === BRIDGE_E2E_STATUS_CONTEXT),
  );
  if (!latest) {
    throw new Error(`Missing ${BRIDGE_E2E_STATUS_CONTEXT} status for release commit ${sha}`);
  }
  if (latest.state !== "success") {
    throw new Error(
      `${BRIDGE_E2E_STATUS_CONTEXT} latest status for ${sha} is ${String(latest.state)}`,
    );
  }

  return {
    id: latest.id,
    url: latest.target_url,
    description: latest.description,
  };
}
