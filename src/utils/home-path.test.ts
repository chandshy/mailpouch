import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { homedir, tmpdir } from "os";
import { join, sep } from "path";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { homeFile, profileHomeFile } from "./home-path.js";

describe("homeFile (CRED-002 containment)", () => {
  const ENV = "MAILPOUCH_TEST_PATH";
  const original = process.env[ENV];

  beforeEach(() => { delete process.env[ENV]; });
  afterEach(() => {
    if (original === undefined) delete process.env[ENV];
    else process.env[ENV] = original;
  });

  it("returns $HOME/basename when env var unset", () => {
    const p = homeFile(ENV, ".mailpouch-thing");
    expect(p).toBe(`${homedir()}${sep}.mailpouch-thing`);
  });

  it("returns the resolved env path when it stays inside $HOME", () => {
    process.env[ENV] = `${homedir()}/sub/thing.json`;
    const p = homeFile(ENV, "fallback.json");
    expect(p).toBe(`${homedir()}${sep}sub${sep}thing.json`);
  });

  it("throws when env path traverses out of $HOME via ..", () => {
    process.env[ENV] = `${homedir()}/../etc/cron.d/foo`;
    expect(() => homeFile(ENV, "fallback")).toThrow(/must point to a path within the home directory/);
  });

  it("throws when env path is an absolute path outside $HOME", () => {
    process.env[ENV] = "/tmp/leak.jsonl";
    expect(() => homeFile(ENV, "fallback")).toThrow(/must point to a path within the home directory/);
  });

  it("throws on a path that resolves to / via redundant ..", () => {
    process.env[ENV] = "/../../../etc/passwd";
    expect(() => homeFile(ENV, "fallback")).toThrow(/must point to a path within the home directory/);
  });

  it("error message names the env var so operators can identify which override is wrong", () => {
    process.env[ENV] = "/tmp/x";
    let caught: Error | null = null;
    try { homeFile(ENV, "fallback"); } catch (e) { caught = e as Error; }
    expect(caught).toBeTruthy();
    expect(caught!.message).toContain(ENV);
    // Don't assert on the resolved path string content — node:path.resolve
    // is platform-specific (Windows turns "/tmp/x" into "C:\\tmp\\x") and the
    // env-var name is the actionable bit for the operator anyway.
  });

  it("keeps default-profile state at the legacy filename", () => {
    const configPath = `${homedir()}${sep}.mailpouch.json`;
    expect(profileHomeFile(ENV, ".mailpouch-thing", configPath))
      .toBe(`${homedir()}${sep}.mailpouch-thing`);
  });

  it("isolates custom configuration profiles in stable opaque directories", () => {
    const a = profileHomeFile(ENV, ".mailpouch-thing", `${homedir()}${sep}profiles${sep}work.json`);
    const b = profileHomeFile(ENV, ".mailpouch-thing", `${homedir()}${sep}profiles${sep}personal.json`);
    expect(a).toContain(`${sep}.mailpouch-profiles${sep}`);
    expect(a).toMatch(/\.mailpouch-thing$/);
    expect(a).not.toBe(b);
  });

  it("honors an explicit data-file override even for a custom profile", () => {
    process.env[ENV] = `${homedir()}/custom/thing.json`;
    expect(profileHomeFile(ENV, "fallback.json", `${homedir()}/profiles/work.json`))
      .toBe(`${homedir()}${sep}custom${sep}thing.json`);
  });
});

describe("profileHomeFile default-profile continuity", () => {
  const ENV = "MAILPOUCH_TEST_DEFAULT_PROFILE_PATH";
  let tempHome: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;
  let originalOverride: string | undefined;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "mailpouch-home-path-test-"));
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    originalOverride = process.env[ENV];
    delete process.env[ENV];
    process.env.HOME = tempHome;
    // os.homedir() reads USERPROFILE on Windows and HOME on POSIX. Keep both
    // spellings aligned so these profile-identity tests exercise the same
    // temporary home on every supported runner.
    process.env.USERPROFILE = tempHome;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    if (originalOverride === undefined) delete process.env[ENV];
    else process.env[ENV] = originalOverride;
    if (tempHome) rmSync(tempHome, { recursive: true, force: true });
  });

  it("keeps historic default state when the default config is a symlink", () => {
    const physicalConfigDirectory = join(tempHome, "physical-config");
    mkdirSync(physicalConfigDirectory);
    const physicalConfig = join(physicalConfigDirectory, "mailpouch.json");
    writeFileSync(physicalConfig, "{}");
    symlinkSync(physicalConfig, join(tempHome, ".mailpouch.json"));

    expect(profileHomeFile(ENV, ".mailpouch-test-state", physicalConfig))
      .toBe(join(tempHome, ".mailpouch-test-state"));
  });

  it("keeps historic default state when HOME itself is a symlink", () => {
    const physicalHome = join(tempHome, "physical-home");
    const homeAlias = join(tempHome, "home-alias");
    mkdirSync(physicalHome);
    symlinkSync(physicalHome, homeAlias, "dir");
    process.env.HOME = homeAlias;
    process.env.USERPROFILE = homeAlias;

    const physicalDefaultConfig = join(physicalHome, ".mailpouch.json");
    writeFileSync(physicalDefaultConfig, "{}");

    expect(profileHomeFile(ENV, ".mailpouch-test-state", physicalDefaultConfig))
      .toBe(join(homeAlias, ".mailpouch-test-state"));
  });
});
