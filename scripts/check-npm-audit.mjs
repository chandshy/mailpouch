#!/usr/bin/env node
// Run `npm audit` against production dependencies. Hard-fail on HIGH or
// CRITICAL findings; treat MODERATE and LOW as advisory.
//
// `.preship-audit-allow.json` (committed) can override severity for specific
// advisory IDs:
//   { "allow": [{ "id": 1234, "reason": "false positive — see #PR-456" }] }
//
// Exit 0 — clean OR only allowed advisories present.
// Exit 1 — HIGH/CRITICAL finding NOT in allow-list, or audit error.
// Exit 2 — MODERATE/LOW present (advisory; preship.mjs flags this mode).

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnShellFreeSync } from "./lib/cross-platform-spawn.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ALLOW_FILE = join(ROOT, ".preship-audit-allow.json");

let allowedIds = new Set();
if (existsSync(ALLOW_FILE)) {
  try {
    const raw = JSON.parse(await readFile(ALLOW_FILE, "utf-8"));
    if (Array.isArray(raw.allow)) {
      allowedIds = new Set(raw.allow.map((a) => a.id));
    }
  } catch (e) {
    console.error(`Could not parse ${ALLOW_FILE}: ${e.message}`);
    process.exit(1);
  }
}

const res = spawnShellFreeSync("npm", ["audit", "--omit=dev", "--json"], {
  encoding: "utf-8",
  cwd: ROOT,
});
if (res.error) {
  console.error(`npm-audit ERROR: npm could not be started: ${res.error.message}`);
  process.exit(1);
}
// `npm audit --json` returns non-zero on any vulns, 0 on clean.
// We don't trust the exit code — we parse the JSON.
let report;
try {
  report = JSON.parse(res.stdout);
} catch {
  console.error("npm-audit ERROR: could not parse `npm audit --json` output.");
  console.error(res.stdout || res.stderr);
  process.exit(1);
}

// FAIL CLOSED on an audit that did not actually run.
//
// `npm audit --json` emits VALID JSON on a registry/network failure, but with
// no `vulnerabilities` key:
//
//   { "message": "request to https://registry.npmjs.org/-/npm/v1/security/
//                 advisories/bulk failed, reason: connect ECONNREFUSED",
//     "error": { "summary": "", "detail": "" } }
//
// `report.vulnerabilities ?? {}` turned that into "zero findings", so a
// transient registry outage made this gate print OK and exit 0 — while it is
// wired to prepublishOnly and the pre-push hook. An audit that could not run
// is not an audit that found nothing.
if (report.error || typeof report.message === "string") {
  const why = report.message ?? JSON.stringify(report.error);
  console.error(`npm-audit ERROR: npm audit did not complete: ${why}`);
  console.error("Refusing to report a clean audit for a run that never happened.");
  process.exit(1);
}
if (!report.vulnerabilities || typeof report.vulnerabilities !== "object") {
  console.error("npm-audit ERROR: `npm audit --json` returned no `vulnerabilities` map.");
  console.error(res.stdout?.slice(0, 2000) || res.stderr);
  process.exit(1);
}

const vulns = report.vulnerabilities;
const allFindings = [];
for (const [pkgName, info] of Object.entries(vulns)) {
  if (!info || typeof info !== "object") continue;
  // npm audit's "vulnerabilities" map nests advisories under .via (array of objects+strings)
  const direct = Array.isArray(info.via) ? info.via.filter((v) => typeof v === "object") : [];
  for (const adv of direct) {
    allFindings.push({
      id: adv.source ?? adv.id ?? null,
      pkg: pkgName,
      severity: (adv.severity ?? info.severity ?? "unknown").toLowerCase(),
      title: adv.title ?? "(no title)",
      url: adv.url ?? "",
    });
  }
}

const filtered = allFindings.filter((f) => !allowedIds.has(f.id));
const highCrit = filtered.filter((f) => f.severity === "high" || f.severity === "critical");
const modLow = filtered.filter((f) => f.severity === "moderate" || f.severity === "low");
// Anything that isn't high/critical or moderate/low — e.g. "info", "unknown",
// or a future severity label npm introduces. These were previously dropped
// silently; surface them so an unbucketed advisory can't hide.
const other = filtered.filter(
  (f) => !["high", "critical", "moderate", "low"].includes(f.severity)
);

if (highCrit.length > 0) {
  console.error(`npm-audit FAILED: ${highCrit.length} HIGH/CRITICAL finding(s):`);
  for (const f of highCrit) {
    console.error(`  - [${f.severity.toUpperCase()}] ${f.pkg}  (advisory ${f.id})  ${f.title}`);
    if (f.url) console.error(`    ${f.url}`);
  }
  if (allowedIds.size > 0) {
    console.error(`  ${allowedIds.size} advisory ID(s) are allow-listed in .preship-audit-allow.json`);
  }
  process.exit(1);
}

// Print BOTH advisory buckets before exiting — an early exit after MODERATE/LOW
// would hide any unbucketed-severity findings whenever both are present.
if (modLow.length > 0) {
  console.error(`npm-audit advisory: ${modLow.length} MODERATE/LOW finding(s):`);
  for (const f of modLow) {
    console.error(`  - [${f.severity.toUpperCase()}] ${f.pkg}  (advisory ${f.id})  ${f.title}`);
  }
}
if (other.length > 0) {
  console.error(`npm-audit advisory: ${other.length} finding(s) with unbucketed severity:`);
  for (const f of other) {
    console.error(`  - [${(f.severity || "UNKNOWN").toUpperCase()}] ${f.pkg}  (advisory ${f.id})  ${f.title}`);
  }
}
if (modLow.length > 0 || other.length > 0) {
  // Preship orchestrator treats this step as `mode: "advisory"`, so it prints
  // and continues. Exit code distinguishes for standalone callers.
  process.exit(2);
}

const skipped = allFindings.length - filtered.length;
console.log(
  `npm-audit OK: 0 prod-dep findings${skipped ? ` (${skipped} allow-listed)` : ""}`
);
