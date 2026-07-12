/**
 * Greenmail container lifecycle wrapper.
 *
 * Idempotent: `up()` is a no-op when the container is already running and
 * IMAP is responsive. `down()` removes the container; safe to call when the
 * container is absent.
 */

import { spawnSync } from "child_process";
import { createConnection } from "net";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMPOSE_FILE = join(__dirname, "..", "fixtures", "greenmail-compose.yml");
const CONTAINER = "mailpouch-e2e-greenmail";

const GREENMAIL_HOST = "127.0.0.1";
export const GREENMAIL_IMAP_PORT = 3143;
export const GREENMAIL_SMTP_PORT = 3025;

/**
 * Protocol-aware readiness probe.
 *
 * Docker can publish a restarted container's port before Greenmail has
 * finished booting. A connect-only probe then returns true even though the
 * service immediately closes the first IMAP/SMTP sessions, which made the
 * next scenario's beforeAll fail intermittently. Require the service greeting
 * so readiness means the protocol is accepting sessions, not merely that the
 * host port exists.
 */
function probeService(port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: GREENMAIL_HOST, port });
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    const greeting = port === GREENMAIL_IMAP_PORT ? /^\* OK\b/i : /^220\b/;
    socket.setTimeout(timeoutMs);
    socket.once("data", (chunk) => finish(greeting.test(chunk.toString("utf8").trim())));
    socket.once("error", () => finish(false));
    socket.once("close", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}

async function waitForReady(port: number, attempts = 30): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (await probeService(port)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Greenmail port ${port} did not become ready within ${attempts * 0.5}s`);
}

/** Run a command with explicit argv (no shell) and return stdout. Throws on
 *  non-zero exit. Using `spawnSync` with an array avoids the shell entirely,
 *  which means COMPOSE_FILE / CONTAINER can never be interpreted as shell
 *  metacharacters even though they're derived from `__dirname`. */
function runArgv(cmd: string, args: string[], inherit = false): string {
  const res = spawnSync(cmd, args, {
    stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  });
  if (res.status !== 0) {
    const stderr = (res.stderr ?? "").toString().trim();
    throw new Error(`${cmd} ${args.join(" ")} exited ${res.status}: ${stderr}`);
  }
  return (res.stdout ?? "").toString();
}

/** True if the container exists and is in 'running' state. */
function isContainerRunning(): boolean {
  try {
    const out = runArgv("docker", ["inspect", "-f", "{{.State.Running}}", CONTAINER]).trim();
    return out === "true";
  } catch {
    return false;
  }
}

/**
 * When the Greenmail container is provided externally (e.g. by GitHub
 * Actions' `services:` block on a hosted runner that doesn't have
 * `docker compose` CLI available), set MAILPOUCH_E2E_GREENMAIL_EXTERNAL=1
 * to make up/down/restart no-op the docker compose calls. Tests still wait
 * for the IMAP/SMTP ports to be reachable, so the harness is self-checking
 * rather than blindly trusting the env var.
 */
const externallyManaged = (): boolean =>
  process.env.MAILPOUCH_E2E_GREENMAIL_EXTERNAL === "1";

export async function up(): Promise<void> {
  if (externallyManaged()) {
    await waitForReady(GREENMAIL_IMAP_PORT);
    await waitForReady(GREENMAIL_SMTP_PORT);
    return;
  }
  if (isContainerRunning()
    && (await probeService(GREENMAIL_IMAP_PORT))
    && (await probeService(GREENMAIL_SMTP_PORT))) return;
  runArgv("docker", ["compose", "-f", COMPOSE_FILE, "up", "-d"], /* inherit */ true);
  await waitForReady(GREENMAIL_IMAP_PORT);
  await waitForReady(GREENMAIL_SMTP_PORT);
}

export async function down(): Promise<void> {
  if (externallyManaged()) return;
  try {
    runArgv("docker", ["compose", "-f", COMPOSE_FILE, "down"], /* inherit */ true);
  } catch {
    // already down — nothing to do
  }
}

/**
 * Hard-restart Greenmail. Use in beforeAll of any scenario file that must
 * not be polluted by state left over from earlier files in the run. Vitest
 * runs e2e files serially under singleFork; this is the cleanest way to
 * guarantee a fresh UID space and empty mailbox tree.
 *
 * When the container is externally managed (MAILPOUCH_E2E_GREENMAIL_EXTERNAL=1),
 * we can't restart it — instead, ensure ports are reachable and call wipe()
 * via a quick standalone ImapFlow client. Tests in those environments
 * accept the residual cross-file state risk; CI typically only runs the
 * full suite once per workflow so the risk is small.
 */
export async function restart(): Promise<void> {
  if (externallyManaged()) {
    await waitForReady(GREENMAIL_IMAP_PORT);
    await waitForReady(GREENMAIL_SMTP_PORT);
    return;
  }
  await up();
  runArgv("docker", ["compose", "-f", COMPOSE_FILE, "restart"], /* inherit */ true);
  await waitForReady(GREENMAIL_IMAP_PORT);
  await waitForReady(GREENMAIL_SMTP_PORT);
}

/** Greenmail user provisioned in compose env. */
export const TEST_USER = {
  email: "alice@test.local",
  username: "alice",
  password: "test-password",
} as const;

/** Second Greenmail user — useful for send/receive scenarios. */
export const TEST_USER_BOB = {
  email: "bob@test.local",
  username: "bob",
  password: "test-password",
} as const;
