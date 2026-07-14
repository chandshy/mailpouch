import { basename } from "node:path";

const RUN_TOKEN_RE = /^mpE2E-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Validate the tightly-scoped E2E credential mode.
 *
 * Both live Bridge and disposable Greenmail children must stay away from the
 * operator's OS keychain. A normal config path can never opt in by setting
 * only an environment variable: exactly one backend-specific token must match
 * the exact UUIDv4-bearing temporary config basename.
 */
export function e2eConfigOnlyCredentialsRequested(
  env: NodeJS.ProcessEnv,
  configPath: string,
): boolean {
  if (env.MAILPOUCH_E2E_CONFIG_ONLY_CREDENTIALS !== "1") return false;
  const bridgeToken = env.MAILPOUCH_E2E_RUN_TOKEN ?? "";
  const greenmailToken = env.MAILPOUCH_E2E_CREDENTIAL_TOKEN ?? "";
  const name = basename(configPath);
  const bridgeRequested = bridgeToken.length > 0;
  const greenmailRequested = greenmailToken.length > 0;
  const bridgeMatch = bridgeRequested
    && !greenmailRequested
    && RUN_TOKEN_RE.test(bridgeToken)
    && name === `.mailpouch-e2e-bridge-${bridgeToken}.json`;
  const greenmailMatch = greenmailRequested
    && !bridgeRequested
    && RUN_TOKEN_RE.test(greenmailToken)
    && name === `.mailpouch-e2e-greenmail-${greenmailToken}.json`;
  if (!bridgeMatch && !greenmailMatch) {
    throw new Error(
      "MAILPOUCH_E2E_CONFIG_ONLY_CREDENTIALS is restricted to an exact UUID-named E2E config clone.",
    );
  }
  return true;
}
