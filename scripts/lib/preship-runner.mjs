// Sequential step runner + summary formatter for the preship gate.
//
// Each step is { name, mode, run() }:
//   mode: "hard"     — failure aborts the run with a non-zero exit
//   mode: "advisory" — failure prints a warning and the run continues
//
// run() must return { ok, summary?, output? }:
//   ok: boolean — true = step passed, false = step failed
//   summary: short single-line note shown next to the step in the table
//   output: long-form detail printed when the step fails OR when --verbose

import { styleText } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";

const CHECK = styleText(["green", "bold"], "✓");
const CROSS = styleText(["red", "bold"], "✗");
const WARN_MARK = styleText(["yellow", "bold"], "!");
const SKIP_MARK = styleText(["gray"], "○");
// Distinct mark + colour for steps skipped because an earlier step hard-failed.
// Red (not gray) so a stdout parser cannot mistake a halted run's tail for an
// intentional skip / pass.
const DEFER_MARK = styleText(["red", "bold"], "↷");
const HR = "─".repeat(60);

function fmtDuration(ms) {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m} m ${s.toString().padStart(2, "0")} s`;
}

export async function runSteps(steps, { header = "PRESHIP", verbose = false } = {}) {
  const results = [];
  const t0 = Date.now();
  console.log(styleText("bold", header));
  console.log(HR);
  let halted = false;
  for (const step of steps) {
    if (halted) {
      results.push({ step, status: "skipped", durationMs: 0 });
      console.log(`${DEFER_MARK} ${step.name.padEnd(16)} ${"—".padStart(8)}  ${styleText("red", "deferred after halt")}`);
      continue;
    }
    process.stdout.write(`… ${step.name}\r`);
    const start = Date.now();
    let res;
    try {
      res = await step.run();
    } catch (e) {
      res = { ok: false, summary: e instanceof Error ? e.message : String(e), output: e?.stack ?? "" };
    }
    const durationMs = Date.now() - start;
    const status = res.ok ? "ok" : step.mode === "advisory" ? "advisory" : "fail";
    results.push({ step, status, durationMs, ...res });
    const mark = status === "ok" ? CHECK : status === "advisory" ? WARN_MARK : CROSS;
    const nameCol = step.name.padEnd(16);
    const durCol = fmtDuration(durationMs).padStart(8);
    const summary = res.summary ? "  " + styleText("gray", res.summary) : "";
    console.log(`${mark} ${nameCol} ${durCol}${summary}`);
    if (status === "fail") {
      if (res.output) {
        // CI step logs can truncate one large flush from the end, losing the
        // test-runner summary. Print the tail first so the failure detail
        // survives truncation, then the full output for local readers.
        const lines = res.output.split("\n");
        if (lines.length > 200) {
          console.log(styleText("gray", `--- last 200 lines of ${step.name} output ---`));
          console.log(styleText("gray", lines.slice(-200).join("\n")));
          console.log(styleText("gray", `--- full ${step.name} output follows ---`));
        }
        console.log(styleText("gray", res.output));
      }
      halted = true;
    } else if (status === "advisory" && (res.output || verbose)) {
      if (res.output) console.log(styleText("gray", res.output));
    } else if (verbose && res.output) {
      console.log(styleText("gray", res.output));
    }
  }
  const totalMs = Date.now() - t0;
  console.log(HR);
  const summary = formatFinal(results, totalMs);
  console.log(summary.line);
  return { results, ok: summary.ok, totalMs };
}

function formatFinal(results, totalMs) {
  const failed = results.filter((r) => r.status === "fail");
  const advisories = results.filter((r) => r.status === "advisory");
  const skipped = results.filter((r) => r.status === "skipped");
  const ok = failed.length === 0;
  let label;
  if (!ok) {
    label = styleText(["red", "bold"], "FAIL");
    const names = failed.map((r) => r.step.name).join(", ");
    label += `  — hard failure: ${names}`;
  } else {
    label = styleText(["green", "bold"], "PASS");
    if (advisories.length > 0) {
      label += ` (with ${advisories.length} advisory)`;
    }
  }
  if (skipped.length > 0) {
    label += styleText(["red", "bold"], `  · ${skipped.length} deferred after halt`);
  }
  return { ok, line: `${label}  · total ${fmtDuration(totalMs)}` };
}

// ─── Standardized step builder for spawning a subprocess ─────────────────────

import { spawnShellFree } from "./cross-platform-spawn.mjs";

/**
 * BUILD-017: secrets that no preship step needs but which would otherwise be
 * inherited from the operator's shell. Stripped from every child env by default
 * (defence in depth: the secrets scanner shouldn't run with a real PAT in
 * scope). A step that genuinely needs one can opt back in via `keepEnv`.
 */
const SCRUBBED_ENV_KEYS = ["NPM_TOKEN", "NODE_AUTH_TOKEN", "GITHUB_TOKEN", "GH_TOKEN"];
const DEFAULT_NPM_CACHE = path.join(tmpdir(), "mailpouch-npm-cache");

function buildChildEnv(extra, keepEnv = []) {
  const base = { ...process.env };
  for (const k of SCRUBBED_ENV_KEYS) {
    if (!keepEnv.includes(k)) delete base[k];
  }
  if (!base.npm_config_cache) {
    base.npm_config_cache = DEFAULT_NPM_CACHE;
  }
  return { ...base, ...(extra ?? {}) };
}

/**
 * Run a child process and resolve a step result. Captures stdout+stderr.
 * Treats exit 0 as ok unless `successWhen` is provided.
 *
 *   spawnStep("vitest", ["run"], { mode: "hard" })
 */
export function spawnStep(cmd, args, opts = {}) {
  const { successWhen, env, cwd, summary, keepEnv } = opts;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnShellFree(cmd, args, {
        env: buildChildEnv(env, keepEnv),
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({ ok: false, summary: `failed to spawn: ${err.message}`, output: err.stack });
      return;
    }
    const chunks = [];
    child.stdout.on("data", (c) => chunks.push(c));
    child.stderr.on("data", (c) => chunks.push(c));
    child.on("close", (code) => {
      const output = Buffer.concat(chunks).toString("utf-8");
      const ok = successWhen ? successWhen({ code, output }) : code === 0;
      resolve({
        ok,
        summary: typeof summary === "function" ? summary({ code, output, ok }) : summary,
        output: ok ? undefined : output,
        exitCode: code,
      });
    });
    child.on("error", (err) => {
      resolve({ ok: false, summary: `failed to spawn: ${err.message}`, output: err.stack });
    });
  });
}

/**
 * Helper for npm-script steps: `spawnNpmRun("test")` runs `npm run test`.
 *
 * BUILD-016: no `--silent` — it suppresses npm's own `npm error` framing on a
 * failing script, so the operator saw less than they would running the script
 * directly. We already capture and print the child's stdout+stderr on failure.
 */
export function spawnNpmRun(scriptName, opts = {}) {
  return spawnStep("npm", ["run", scriptName], opts);
}
