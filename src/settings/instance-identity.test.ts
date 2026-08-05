/**
 * The settings-UI singleton probe (src/index.ts) used to accept any local
 * listener that answered GET /api/status with a boolean `hasConfig` field.
 * Whoever bound the settings port first therefore became the URL mailpouch
 * advertises to the tray and to agents — the page that asks for the Bridge
 * password. These tests pin the replacement: identity is a nonce published
 * beside the 0o600 config, not a forgeable response shape.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from "fs";
import { homedir, platform } from "os";
import { join } from "path";
import { getConfigPath } from "../config/loader.js";
import {
  publishInstanceId,
  currentInstanceId,
  clearInstanceId,
  instanceIdMatches,
  instancePath,
} from "./instance-identity.js";

describe("settings instance identity", () => {
  let directory: string;
  let previousConfigPath: string | undefined;

  beforeEach(() => {
    // MAILPOUCH_CONFIG deliberately permits only paths below $HOME.
    directory = mkdtempSync(join(homedir(), ".mailpouch-instance-test-"));
    previousConfigPath = process.env.MAILPOUCH_CONFIG;
    process.env.MAILPOUCH_CONFIG = join(directory, ".mailpouch.json");
  });

  afterEach(() => {
    clearInstanceId();
    if (previousConfigPath === undefined) delete process.env.MAILPOUCH_CONFIG;
    else process.env.MAILPOUCH_CONFIG = previousConfigPath;
    rmSync(directory, { recursive: true, force: true });
  });

  it("accepts the nonce the running instance published", () => {
    const id = publishInstanceId();
    expect(id).toBeTruthy();
    expect(currentInstanceId()).toBe(id);
    expect(instanceIdMatches(id)).toBe(true);
  });

  // The whole point: a squatter can echo any SHAPE it likes, but not the value.
  it("rejects a listener that forges the response shape but not the nonce", () => {
    publishInstanceId();
    expect(instanceIdMatches("attacker-supplied")).toBe(false);
    expect(instanceIdMatches(true)).toBe(false);
    expect(instanceIdMatches(undefined)).toBe(false);
    expect(instanceIdMatches(null)).toBe(false);
    expect(instanceIdMatches("")).toBe(false);
    expect(instanceIdMatches(1234)).toBe(false);
    expect(instanceIdMatches({})).toBe(false);
  });

  // A same-length wrong value must not slip past the length pre-check into a
  // timingSafeEqual that would throw and get swallowed as "true".
  it("rejects a wrong nonce of exactly the right length", () => {
    const id = publishInstanceId();
    expect(id).toBeTruthy();
    const sameLengthDecoy = "f".repeat(id!.length);
    expect(sameLengthDecoy).toHaveLength(id!.length);
    expect(sameLengthDecoy).not.toBe(id);
    expect(instanceIdMatches(sameLengthDecoy)).toBe(false);
  });

  it("rejects everything when no instance has published — probe binds its own", () => {
    expect(instanceIdMatches("anything")).toBe(false);
    expect(currentInstanceId()).toBeNull();
  });

  it("stops matching a replayed nonce once the instance shuts down", () => {
    const id = publishInstanceId();
    expect(instanceIdMatches(id)).toBe(true);
    clearInstanceId();
    expect(instanceIdMatches(id)).toBe(false);
    expect(currentInstanceId()).toBeNull();
  });

  it("publishes a distinct nonce per instance", () => {
    const first = publishInstanceId();
    const second = publishInstanceId();
    expect(first).not.toBe(second);
    // The superseded nonce must not still be honoured.
    expect(instanceIdMatches(first)).toBe(false);
    expect(instanceIdMatches(second)).toBe(true);
  });

  it("writes the nonce 0o600 so another local user cannot read it", () => {
    publishInstanceId();
    const target = instancePath();
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf-8")).toHaveLength(64);
    // Windows does not implement POSIX mode bits.
    if (platform() !== "win32") {
      expect(statSync(target).mode & 0o777).toBe(0o600);
    }
  });

  it("sits beside the active config, so profiles do not share an identity", () => {
    expect(instancePath()).toBe(join(directory, ".mailpouch.json.settings-instance"));
    expect(getConfigPath().startsWith(directory)).toBe(true);
  });

  it("removes the file on shutdown, not just the in-memory value", () => {
    publishInstanceId();
    expect(existsSync(instancePath())).toBe(true);
    clearInstanceId();
    expect(existsSync(instancePath())).toBe(false);
  });
});
