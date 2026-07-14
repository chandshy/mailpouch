export type E2EBackend = "greenmail" | "bridge";

export const E2E_BACKEND_ENV = "MAILPOUCH_E2E_BACKEND";

function invalidBackend(value: string | undefined): Error {
  const detail = value === undefined || value === ""
    ? `${E2E_BACKEND_ENV} is not set`
    : `${E2E_BACKEND_ENV}=${JSON.stringify(value)} is invalid`;
  return new Error(
    `E2E backend selection refused: ${detail}. ` +
      `Use the npm test:e2e:local or test:e2e:bridge script, or set it explicitly to "greenmail" or "bridge".`,
  );
}

/** Return the backend explicitly selected by the invoking E2E command.
 *
 * A Bridge config path is intentionally not a selector: developers commonly
 * keep that variable exported, and a local run must still target Greenmail.
 * Conversely, a Bridge command with a missing config must fail instead of
 * silently becoming a disposable-server run.
 */
export function requestedE2EBackend(
  env: NodeJS.ProcessEnv = process.env,
): E2EBackend {
  const value = env[E2E_BACKEND_ENV];
  if (value === "greenmail" || value === "bridge") return value;
  throw invalidBackend(value);
}

/** Resolve an optional programmatic override without allowing it to conflict
 * with the backend selected by the invoking command. An explicit override is
 * sufficient for focused harness callers that do not use an npm script. */
export function resolveE2EBackend(
  explicit: E2EBackend | undefined,
  env: NodeJS.ProcessEnv = process.env,
): E2EBackend {
  const selected = env[E2E_BACKEND_ENV] === undefined || env[E2E_BACKEND_ENV] === ""
    ? undefined
    : requestedE2EBackend(env);
  if (explicit && selected && explicit !== selected) {
    throw new Error(
      `E2E backend selection refused: startE2E requested ${JSON.stringify(explicit)} ` +
        `but ${E2E_BACKEND_ENV} selected ${JSON.stringify(selected)}.`,
    );
  }
  if (explicit) return explicit;
  if (selected) return selected;
  throw invalidBackend(env[E2E_BACKEND_ENV]);
}

export function bridgeModeRequested(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return requestedE2EBackend(env) === "bridge";
}
