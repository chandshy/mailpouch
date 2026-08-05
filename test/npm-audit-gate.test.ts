/**
 * The npm-audit gate is wired to `prepublishOnly` and the pre-push hook, so it
 * is one of the last things standing between a vulnerable tree and a publish.
 *
 * `npm audit --json` emits VALID JSON on a registry/network failure, but with
 * no `vulnerabilities` key — just `{ message, error }`. Reading that through
 * `report.vulnerabilities ?? {}` turned "the audit could not run" into "the
 * audit found nothing", and the gate printed OK and exited 0.
 *
 * A gate that passes vacuously is worse than no gate, because it reports
 * success. This pins the fail-closed behaviour.
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = join(ROOT, "scripts", "check-npm-audit.mjs");

/** Port 9 (discard) refuses connections immediately — no network wait. */
const DEAD_REGISTRY = "http://127.0.0.1:9";

describe("npm-audit gate fails closed when the audit cannot run", () => {
  it("exits non-zero instead of reporting a clean audit on a registry failure", () => {
    const res = spawnSync(process.execPath, [SCRIPT], {
      cwd: ROOT,
      encoding: "utf-8",
      env: { ...process.env, npm_config_registry: DEAD_REGISTRY },
      timeout: 120_000,
    });

    const output = `${res.stdout ?? ""}${res.stderr ?? ""}`;

    // The gate must NOT claim the tree is clean when it never checked.
    expect(output).not.toMatch(/npm-audit OK/);
    // And it must fail loudly.
    expect(res.status).not.toBe(0);
    expect(output).toMatch(/did not complete|no `vulnerabilities` map/i);
  }, 130_000);
});
