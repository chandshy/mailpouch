import { describe, it, expect, afterEach } from "vitest";
import { runDoctorCli } from "./doctor-cli.js";
import { invalidateConfigCache } from "../config/loader.js";
import { homedir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";

// MAILPOUCH_CONFIG must resolve inside the home directory (loader guards traversal),
// so point at a nonexistent file there to exercise the `unconfigured` path.
const prev = process.env.MAILPOUCH_CONFIG;
function pointAtMissingConfig(): void {
  process.env.MAILPOUCH_CONFIG = join(homedir(), `.mailpouch-doctor-test-${randomBytes(6).toString("hex")}.json`);
  invalidateConfigCache();
}

afterEach(() => {
  if (prev === undefined) delete process.env.MAILPOUCH_CONFIG;
  else process.env.MAILPOUCH_CONFIG = prev;
  invalidateConfigCache();
});

describe("mailpouch doctor CLI", () => {
  it("prints the diagnosis and exits non-zero when unconfigured", async () => {
    pointAtMissingConfig();
    const out: string[] = [];
    const code = await runDoctorCli([], { out: (l) => out.push(l), err: () => {} });
    expect(code).toBe(1);
    const text = out.join("\n");
    expect(text).toMatch(/UNCONFIGURED/);
    expect(text).toMatch(/mailpouch setup/);
  });

  it("--json emits a parseable structured result", async () => {
    pointAtMissingConfig();
    const out: string[] = [];
    const code = await runDoctorCli(["--json"], { out: (l) => out.push(l), err: () => {} });
    expect(code).toBe(1);
    const parsed = JSON.parse(out.join("\n"));
    expect(parsed.state).toBe("unconfigured");
    expect(parsed.configured).toBe(false);
    expect(typeof parsed.nextStep).toBe("string");
  });

  it("rejects unknown arguments with exit code 2", async () => {
    const err: string[] = [];
    const code = await runDoctorCli(["--bogus"], { out: () => {}, err: (l) => err.push(l) });
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/unknown argument/);
  });
});
