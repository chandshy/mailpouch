#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BRIDGE_E2E_STATUS_CONTEXT,
  normalizeCommitSha,
} from "./lib/release-attestations.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

function cleanCheckout() {
  return git("status", "--porcelain=v1", "--untracked-files=all") === "";
}

function resolveToken() {
  const fromEnvironment = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (fromEnvironment) return fromEnvironment;
  try {
    return execFileSync("gh", ["auth", "token"], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    throw new Error("A GitHub token with commit-status write access is required (run `gh auth login` or set GH_TOKEN)");
  }
}

function resolveRepository() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  try {
    return execFileSync(
      "gh",
      ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
      { cwd: root, encoding: "utf8" },
    ).trim();
  } catch {
    throw new Error("Could not resolve the GitHub owner/name (set GITHUB_REPOSITORY or configure the `gh` remote)");
  }
}

const sha = normalizeCommitSha(git("rev-parse", "HEAD"), "HEAD SHA");
if (!process.env.MAILPOUCH_E2E_BRIDGE_CONFIG) {
  throw new Error("MAILPOUCH_E2E_BRIDGE_CONFIG must identify the live Bridge test config");
}
if (!cleanCheckout()) {
  throw new Error("Bridge E2E attestation refused: the checkout has tracked or untracked changes");
}

const repository = resolveRepository();
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
  throw new Error(`Invalid GitHub repository: ${repository}`);
}
const token = resolveToken();
const apiBase = (process.env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/, "");
const serverBase = (process.env.GITHUB_SERVER_URL ?? "https://github.com").replace(/\/$/, "");
const targetUrl = `${serverBase}/${repository}/commit/${sha}`;

async function postStatus(state, description) {
  const response = await fetch(`${apiBase}/repos/${repository}/statuses/${sha}`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "mailpouch-bridge-e2e-attestation",
    },
    body: JSON.stringify({
      state,
      context: BRIDGE_E2E_STATUS_CONTEXT,
      description,
      target_url: targetUrl,
    }),
  });
  if (!response.ok) {
    const body = (await response.text()).slice(0, 500);
    throw new Error(`Could not write GitHub commit status (${response.status}): ${body}`);
  }
}

await postStatus("pending", "Full local Proton Bridge E2E is running");

const childEnv = { ...process.env };
for (const name of [
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_URL",
  "CI_JOB_JWT",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GIT_ASKPASS",
  "GPG_AGENT_INFO",
  "NODE_AUTH_TOKEN",
  "NPM_TOKEN",
  "SSH_ASKPASS",
  "SSH_AUTH_SOCK",
]) delete childEnv[name];

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
async function runRequiredNpmCommand(args, description) {
  const result = spawnSync(npm, args, {
    cwd: root,
    env: childEnv,
    stdio: "inherit",
  });
  if (result.error || result.status !== 0) {
    await postStatus("failure", `${description} failed`);
    if (result.error) throw result.error;
    process.exit(result.status ?? 1);
  }
}

function runRequiredNpmScript(script, description) {
  return runRequiredNpmCommand(["run", script], description);
}

// Establish dependencies from the exact lockfile after publishing pending, so
// neither a stale/pre-poisoned node_modules tree nor transitive lifecycle code
// can influence release evidence. Re-enable install scripts only for the two
// explicitly trusted native packages required by typecheck/build/live E2E.
await runRequiredNpmCommand(
  ["ci", "--ignore-scripts"],
  "Clean lockfile dependency install before Proton Bridge E2E",
);
await runRequiredNpmCommand(
  ["rebuild", "better-sqlite3", "@napi-rs/keyring"],
  "Trusted native dependency rebuild before Proton Bridge E2E",
);

// The harness executes dist/index.js. Rebuild it from this exact clean HEAD so
// ignored output left by another branch/commit can never receive an attested
// success. Typecheck first to make the source contract explicit.
await runRequiredNpmScript("typecheck", "Typecheck before Proton Bridge E2E");
await runRequiredNpmScript("build:clean", "Clean exact-SHA build before Proton Bridge E2E");
await runRequiredNpmScript("test:e2e:bridge", "Full local Proton Bridge E2E");

const finalSha = normalizeCommitSha(git("rev-parse", "HEAD"), "final HEAD SHA");
if (finalSha !== sha || !cleanCheckout()) {
  await postStatus("error", "Checkout changed while Proton Bridge E2E was running");
  throw new Error("Bridge E2E attestation refused: HEAD or the worktree changed during the run");
}

await postStatus("success", "Full local Proton Bridge E2E passed on this exact commit");
process.stdout.write(`Bridge E2E attested: ${BRIDGE_E2E_STATUS_CONTEXT} ${sha}\n`);
