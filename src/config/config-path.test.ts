/**
 * Profile identity must be based on the physical configuration location, not
 * the spelling supplied through MAILPOUCH_CONFIG. These tests use the real
 * filesystem because a mocked realpath cannot verify symlink-parent behavior.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { getConfigPath } from "./loader.js";
import { profileHomeFile } from "../utils/home-path.js";
import { lockPathForAccount } from "../utils/singleton-lock.js";

describe("configuration profile path canonicalization", () => {
  let directory: string;
  let previousConfigPath: string | undefined;
  let previousRuntimePath: string | undefined;

  beforeEach(() => {
    // MAILPOUCH_CONFIG deliberately permits only paths below $HOME.
    directory = mkdtempSync(join(homedir(), ".mailpouch-config-path-test-"));
    previousConfigPath = process.env.MAILPOUCH_CONFIG;
    previousRuntimePath = process.env.MAILPOUCH_TEST_RUNTIME_PATH;
    delete process.env.MAILPOUCH_TEST_RUNTIME_PATH;
  });

  afterEach(() => {
    if (previousConfigPath === undefined) delete process.env.MAILPOUCH_CONFIG;
    else process.env.MAILPOUCH_CONFIG = previousConfigPath;
    if (previousRuntimePath === undefined) delete process.env.MAILPOUCH_TEST_RUNTIME_PATH;
    else process.env.MAILPOUCH_TEST_RUNTIME_PATH = previousRuntimePath;
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it("uses one singleton and runtime-state profile for a config symlink and its target", () => {
    const target = join(directory, "target.json");
    const alias = join(directory, "alias.json");
    writeFileSync(target, "{}", { mode: 0o600 });
    symlinkSync(target, alias);

    process.env.MAILPOUCH_CONFIG = alias;
    const aliasPath = getConfigPath();

    process.env.MAILPOUCH_CONFIG = target;
    const targetPath = getConfigPath();

    expect(aliasPath).toBe(targetPath);
    expect(lockPathForAccount(`profile:${aliasPath}`))
      .toBe(lockPathForAccount(`profile:${targetPath}`));
    expect(profileHomeFile("MAILPOUCH_TEST_RUNTIME_PATH", ".mailpouch-test-state", aliasPath))
      .toBe(profileHomeFile("MAILPOUCH_TEST_RUNTIME_PATH", ".mailpouch-test-state", targetPath));
  });

  it("canonicalizes an existing symlink parent while preserving a new config filename", () => {
    const targetDirectory = join(directory, "physical-profile");
    const aliasDirectory = join(directory, "profile-alias");
    mkdirSync(targetDirectory);
    symlinkSync(targetDirectory, aliasDirectory, "dir");

    const newConfigViaAlias = join(aliasDirectory, "new-profile.json");
    process.env.MAILPOUCH_CONFIG = newConfigViaAlias;

    expect(getConfigPath()).toBe(join(targetDirectory, "new-profile.json"));
  });
});
