#!/usr/bin/env node
// Enforce the committed coverage floor against Vitest's json-summary report.
//
// The baseline is intentionally versioned in scripts/coverage-baseline.json.
// Raise its minimums in a reviewed change after measuring better coverage; this
// script never rewrites the baseline, so a regression cannot self-approve.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BASELINE_PATH = join(ROOT, "scripts", "coverage-baseline.json");
const SUMMARY_PATH = join(ROOT, "coverage", "coverage-summary.json");
const METRICS = ["statements", "branches", "functions", "lines"];
const EPSILON = 0.0001;

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, "utf-8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`coverage-ratchet ERROR: could not read ${label} (${path}): ${detail}`);
    process.exit(1);
  }
}

const baseline = await readJson(BASELINE_PATH, "baseline");
const summary = await readJson(SUMMARY_PATH, "coverage summary");

if (!Number.isInteger(baseline.version) || baseline.version < 1) {
  console.error("coverage-ratchet ERROR: baseline.version must be a positive integer.");
  process.exit(1);
}

if (!baseline.minimums || typeof baseline.minimums !== "object") {
  console.error("coverage-ratchet ERROR: baseline.minimums must be an object.");
  process.exit(1);
}

if (!summary.total || typeof summary.total !== "object") {
  console.error("coverage-ratchet ERROR: coverage summary is missing its total metrics.");
  process.exit(1);
}

const failures = [];
for (const metric of METRICS) {
  const minimum = baseline.minimums[metric];
  const actual = summary.total[metric]?.pct;

  if (!Number.isFinite(minimum) || minimum < 0 || minimum > 100) {
    console.error(`coverage-ratchet ERROR: baseline minimum for ${metric} must be a number from 0 to 100.`);
    process.exit(1);
  }
  if (!Number.isFinite(actual)) {
    console.error(`coverage-ratchet ERROR: coverage summary is missing a numeric ${metric} percentage.`);
    process.exit(1);
  }

  const result = `${metric.padEnd(10)} ${actual.toFixed(2)}% (floor ${minimum.toFixed(2)}%)`;
  if (actual + EPSILON < minimum) failures.push(result);
  else console.log(`coverage-ratchet OK: ${result}`);
}

if (failures.length > 0) {
  console.error(`coverage-ratchet FAILED (baseline v${baseline.version}):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error("Add tests to restore coverage, or intentionally raise the versioned baseline after review.");
  process.exit(1);
}

console.log(`coverage-ratchet OK: baseline v${baseline.version} met.`);
