#!/usr/bin/env node
// Generate or verify the prod-dep license inventory at `LICENSES.json`.
//
// First run on a project: writes LICENSES.json from `npm ls --json --omit=dev`
// (commit it). Subsequent runs: diff against the committed file — any drift
// (new dep, removed dep, license changed) → hard fail. Unknown / non-SPDX
// licenses are advisory.
//
// Manual update flow: re-run with PRESHIP_LICENSE_WRITE=1 to overwrite the
// baseline, then commit.
//
// Exit 0 — no drift.
// Exit 1 — drift OR write requested.

import { readFile, writeFile } from "node:fs/promises";
import { existsSync, openSync, closeSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnShellFree } from "./lib/cross-platform-spawn.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const INVENTORY = join(ROOT, "LICENSES.json");

const res = await runNpmJson(["ls", "--all", "--json", "--omit=dev", "--long"]);
if (res.error || (res.status !== 0 && !res.stdout)) {
  console.error(`npm ls failed (exit ${res.status}): ${res.error?.message || res.stderr}`);
  process.exit(1);
}

const tree = JSON.parse(res.stdout);
const flat = [];

function visit(node, name) {
  if (!node || typeof node !== "object") return;
  if (name && name !== tree.name) {
    flat.push({
      name,
      version: node.version ?? "(unknown)",
      license: normalizeLicense(node.license),
    });
  }
  for (const [child, sub] of Object.entries(node.dependencies ?? {})) {
    visit(sub, child);
  }
}

function normalizeLicense(license) {
  if (!license) return "UNKNOWN";
  if (typeof license === "string") return license;
  if (Array.isArray(license)) return license.map((l) => l?.type ?? l).filter(Boolean).join(" OR ");
  if (typeof license === "object" && license.type) return license.type;
  return "UNKNOWN";
}

visit(tree, null);
// Dedupe by name+version. Skip entries where `npm ls` could not resolve a
// version — those are typically optional native deps for off-host platforms.
// Including them as `name@(unknown)` polluted the baseline (BUILD-004): a
// later install that resolves a real version looked like an add+remove.
const skipped = flat.filter((d) => d.version === "(unknown)");
const usable = flat.filter((d) => d.version !== "(unknown)");
const seen = new Map();
for (const dep of usable) {
  const key = `${dep.name}@${dep.version}`;
  if (!seen.has(key)) seen.set(key, dep);
}
const current = Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name));

const writeMode = process.env.PRESHIP_LICENSE_WRITE === "1";

if (writeMode) {
  const payload = {
    generatedAt: new Date().toISOString().slice(0, 10),
    rootPackage: `${tree.name}@${tree.version}`,
    deps: current,
  };
  await writeFile(INVENTORY, JSON.stringify(payload, null, 2) + "\n", "utf-8");
  console.log(`Wrote ${INVENTORY} (${current.length} prod deps; ${skipped.length} skipped as unresolved).`);
  process.exit(0);
}

if (!existsSync(INVENTORY)) {
  // First-run UX (BUILD-005): don't silently stage a baseline; error
  // actionably so the user reviews and explicitly accepts it.
  console.error(`license-inv ERROR: no baseline at ${INVENTORY}.`);
  console.error(`Generate one with: PRESHIP_LICENSE_WRITE=1 node scripts/check-licenses.mjs`);
  console.error(`Then commit the file so future runs can diff against it.`);
  process.exit(1);
}

const baseline = JSON.parse(await readFile(INVENTORY, "utf-8"));
const baselineByKey = new Map(
  (baseline.deps ?? [])
    .filter((d) => d.version !== "(unknown)")
    .map((d) => [`${d.name}@${d.version}`, d])
);
const currentByKey = new Map(current.map((d) => [`${d.name}@${d.version}`, d]));

const added = [];
const removed = [];
const licenseChanged = [];
for (const [key, dep] of currentByKey.entries()) {
  if (!baselineByKey.has(key)) added.push(dep);
  else if (baselineByKey.get(key).license !== dep.license) {
    licenseChanged.push({ key, was: baselineByKey.get(key).license, now: dep.license });
  }
}
for (const [key, dep] of baselineByKey.entries()) {
  if (!currentByKey.has(key)) removed.push(dep);
}

const unknown = current.filter((d) => d.license === "UNKNOWN");

const drifted = added.length + removed.length + licenseChanged.length;

if (skipped.length > 0) {
  // Diagnostic only — these deps weren't resolved by `npm ls`. They are
  // excluded from baseline + drift detection to avoid the BUILD-004 churn.
  console.error(`license-inv: ${skipped.length} dep(s) skipped (unresolved version):`);
  for (const d of skipped.slice(0, 5)) console.error(`  - ${d.name}`);
  if (skipped.length > 5) console.error(`  … (${skipped.length - 5} more)`);
}

if (drifted > 0) {
  console.error(`license-inv DRIFT detected:`);
  if (added.length > 0) {
    console.error(`  + ${added.length} added:`);
    for (const d of added.slice(0, 10)) console.error(`      ${d.name}@${d.version}  ${d.license}`);
    if (added.length > 10) console.error(`      … (${added.length - 10} more)`);
  }
  if (removed.length > 0) {
    console.error(`  - ${removed.length} removed:`);
    for (const d of removed.slice(0, 10)) console.error(`      ${d.name}@${d.version}  ${d.license}`);
    if (removed.length > 10) console.error(`      … (${removed.length - 10} more)`);
  }
  if (licenseChanged.length > 0) {
    console.error(`  ~ ${licenseChanged.length} license changed:`);
    for (const c of licenseChanged.slice(0, 10)) {
      console.error(`      ${c.key}  ${c.was} → ${c.now}`);
    }
  }
  console.error(`To accept: PRESHIP_LICENSE_WRITE=1 node scripts/check-licenses.mjs && git add LICENSES.json`);
  process.exit(1);
}

if (unknown.length > 0) {
  console.error(`license-inv advisory: ${unknown.length} dep(s) with UNKNOWN license:`);
  for (const d of unknown.slice(0, 10)) console.error(`  - ${d.name}@${d.version}`);
}

console.log(`license-inv OK: ${current.length} prod deps, no drift.`);

function runNpmJson(args) {
  return new Promise((resolve) => {
    const outPath = join(tmpdir(), `mailpouch-npm-out-${process.pid}-${Date.now()}.json`);
    const errPath = join(tmpdir(), `mailpouch-npm-err-${process.pid}-${Date.now()}.log`);
    const outFd = openSync(outPath, "w");
    const errFd = openSync(errPath, "w");
    const child = spawnShellFree("npm", args, {
      cwd: ROOT,
      stdio: ["ignore", outFd, errFd],
    });
    child.on("error", (error) => {
      closeSync(outFd);
      closeSync(errFd);
      resolve({ error, status: 1, stdout: "", stderr: "" });
    });
    child.on("close", (status) => {
      closeSync(outFd);
      closeSync(errFd);
      const stdout = readFileSync(outPath, "utf8");
      const stderr = readFileSync(errPath, "utf8");
      rmSync(outPath, { force: true });
      rmSync(errPath, { force: true });
      resolve({ status, stdout, stderr, error: null });
    });
  });
}
