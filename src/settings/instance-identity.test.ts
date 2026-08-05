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
  instanceProofMatches,
  answerChallenge,
  newChallenge,
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

  it("accepts a proof computed from the nonce the running instance published", () => {
    const id = publishInstanceId();
    expect(id).toBeTruthy();
    expect(currentInstanceId()).toBe(id);
    const c = newChallenge();
    expect(instanceProofMatches(c, answerChallenge(c))).toBe(true);
  });

  it("never returns the nonce itself — only a proof", () => {
    const id = publishInstanceId();
    const c = newChallenge();
    const answer = answerChallenge(c);
    expect(answer).toBeTruthy();
    expect(answer).not.toBe(id);
    expect(answer).not.toContain(id);
  });

  it("rejects a proof replayed against a different challenge", () => {
    publishInstanceId();
    const first = newChallenge();
    const answer = answerChallenge(first);
    expect(instanceProofMatches(first, answer)).toBe(true);
    expect(instanceProofMatches(newChallenge(), answer)).toBe(false);
  });

  it("refuses to answer a missing or oversized challenge", () => {
    publishInstanceId();
    expect(answerChallenge(undefined)).toBeNull();
    expect(answerChallenge("")).toBeNull();
    expect(answerChallenge(123)).toBeNull();
    expect(answerChallenge("x".repeat(129))).toBeNull();
  });

  // The whole point: a squatter can echo any SHAPE it likes, but not the value.
  it("rejects a listener that forges the response shape but not the proof", () => {
    publishInstanceId();
    const c = newChallenge();
    expect(instanceProofMatches(c, "attacker-supplied")).toBe(false);
    expect(instanceProofMatches(c, true)).toBe(false);
    expect(instanceProofMatches(c, undefined)).toBe(false);
    expect(instanceProofMatches(c, null)).toBe(false);
    expect(instanceProofMatches(c, "")).toBe(false);
    expect(instanceProofMatches(c, 1234)).toBe(false);
    expect(instanceProofMatches(c, {})).toBe(false);
  });

  // A same-length wrong value must not slip past the length pre-check into a
  // timingSafeEqual that would throw and get swallowed as "true".
  it("rejects a wrong proof of exactly the right length", () => {
    publishInstanceId();
    const c = newChallenge();
    const real = answerChallenge(c)!;
    const decoy = "f".repeat(real.length);
    expect(decoy).toHaveLength(real.length);
    expect(decoy).not.toBe(real);
    expect(instanceProofMatches(c, decoy)).toBe(false);
  });

  it("rejects everything when no instance has published — probe binds its own", () => {
    expect(instanceProofMatches(newChallenge(), "anything")).toBe(false);
    expect(answerChallenge(newChallenge())).toBeNull();
    expect(currentInstanceId()).toBeNull();
  });

  it("stops matching a replayed proof once the instance shuts down", () => {
    publishInstanceId();
    const c = newChallenge();
    const answer = answerChallenge(c);
    expect(instanceProofMatches(c, answer)).toBe(true);
    clearInstanceId();
    expect(instanceProofMatches(c, answer)).toBe(false);
    expect(currentInstanceId()).toBeNull();
  });

  it("publishes a distinct nonce per instance", () => {
    const c = newChallenge();
    publishInstanceId();
    const firstAnswer = answerChallenge(c);
    publishInstanceId();
    const secondAnswer = answerChallenge(c);
    expect(firstAnswer).not.toBe(secondAnswer);
    // The superseded nonce's proof must not still be honoured.
    expect(instanceProofMatches(c, firstAnswer)).toBe(false);
    expect(instanceProofMatches(c, secondAnswer)).toBe(true);
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
