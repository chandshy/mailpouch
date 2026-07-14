import { describe, expect, it } from "vitest";
import { e2eConfigOnlyCredentialsRequested } from "./e2e-credential-mode.js";

const TOKEN = "mpE2E-12345678-1234-4abc-8def-1234567890ab";

describe("E2E config-only credential mode", () => {
  it("is disabled unless explicitly requested", () => {
    expect(e2eConfigOnlyCredentialsRequested({}, "/home/test/.mailpouch.json")).toBe(false);
  });

  it("accepts only the exact UUID-tokenized temporary filename", () => {
    expect(e2eConfigOnlyCredentialsRequested({
      MAILPOUCH_E2E_CONFIG_ONLY_CREDENTIALS: "1",
      MAILPOUCH_E2E_RUN_TOKEN: TOKEN,
    }, `/home/test/.mailpouch-e2e-bridge-${TOKEN}.json`)).toBe(true);
  });

  it("accepts an exact Greenmail credential token without enabling the live-mail token", () => {
    expect(e2eConfigOnlyCredentialsRequested({
      MAILPOUCH_E2E_CONFIG_ONLY_CREDENTIALS: "1",
      MAILPOUCH_E2E_CREDENTIAL_TOKEN: TOKEN,
    }, `/home/test/.mailpouch-e2e-greenmail-${TOKEN}.json`)).toBe(true);
  });

  it("rejects a normal operator config", () => {
    expect(() => e2eConfigOnlyCredentialsRequested({
      MAILPOUCH_E2E_CONFIG_ONLY_CREDENTIALS: "1",
      MAILPOUCH_E2E_RUN_TOKEN: TOKEN,
    }, "/home/test/.mailpouch.json")).toThrow(/restricted/i);
  });

  it("rejects malformed and mismatched tokens", () => {
    for (const token of ["mpE2E-not-a-uuid", "mpE2E-12345678-1234-4abc-8def-1234567890ac"]) {
      expect(() => e2eConfigOnlyCredentialsRequested({
        MAILPOUCH_E2E_CONFIG_ONLY_CREDENTIALS: "1",
        MAILPOUCH_E2E_RUN_TOKEN: token,
      }, `/home/test/.mailpouch-e2e-bridge-${TOKEN}.json`)).toThrow(/restricted/i);
    }
  });

  it("rejects mixed Bridge and Greenmail tokens and cross-backend filenames", () => {
    expect(() => e2eConfigOnlyCredentialsRequested({
      MAILPOUCH_E2E_CONFIG_ONLY_CREDENTIALS: "1",
      MAILPOUCH_E2E_RUN_TOKEN: TOKEN,
      MAILPOUCH_E2E_CREDENTIAL_TOKEN: TOKEN,
    }, `/home/test/.mailpouch-e2e-bridge-${TOKEN}.json`)).toThrow(/restricted/i);
    expect(() => e2eConfigOnlyCredentialsRequested({
      MAILPOUCH_E2E_CONFIG_ONLY_CREDENTIALS: "1",
      MAILPOUCH_E2E_CREDENTIAL_TOKEN: TOKEN,
    }, `/home/test/.mailpouch-e2e-bridge-${TOKEN}.json`)).toThrow(/restricted/i);
  });
});
