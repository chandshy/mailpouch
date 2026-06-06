/**
 * `mailpouch status` — fast, read-only operational view. Exits immediately;
 * NEVER starts a server (the bug this command exists to avoid: typing a
 * status check used to boot a second full MCP server in the foreground).
 *
 * Reports what you'd otherwise assemble by hand from ps/ss/log/json:
 *   - is a mailpouch instance already running (PID from the singleton lock),
 *     and on which settings port — confirmed by probing its GET /api/status,
 *   - the live connection + approved-agent counts from that running instance,
 *   - plus the offline diagnosis (config path, Bridge reachability, next step)
 *     and the config/log file locations.
 *
 * Reuses gatherSetupStatus (src/diagnostics/setup-status.ts), the singleton-lock
 * path (src/utils/singleton-lock.ts), and the home-path helper. `--json` for scripts.
 */

import http from "http";
import { readFileSync } from "fs";
import { loadConfig, getConfigPath } from "../config/loader.js";
import { getLogFilePath } from "../utils/logger.js";
import { lockPathForAccount } from "../utils/singleton-lock.js";
import { homeFile } from "../utils/home-path.js";
import { gatherSetupStatus, type SetupStatusResult } from "../diagnostics/setup-status.js";

export interface RunningInstance {
  pid: number | null;
  reachable: boolean;
  version?: string;
  connected?: boolean;
  account?: string;
  pendingCount?: number;
  activeCount?: number;
}

export interface StatusResult {
  running: boolean;
  instance: RunningInstance;
  settingsPort: number;
  configPath: string;
  logPath: string;
  agents: { pending: number; active: number };
  diagnosis: SetupStatusResult;
}

export interface StatusCliDeps {
  out?: (line: string) => void;
  err?: (line: string) => void;
  /** Probe a running instance's GET /api/status. Injectable for tests. */
  probe?: (port: number) => Promise<Record<string, unknown> | null>;
  /** Resolve the live PID from the singleton lock. Injectable for tests. */
  readPid?: (accountIdentity: string | undefined) => number | null;
  /** Offline diagnosis. Injectable for tests. */
  gather?: typeof gatherSetupStatus;
  /** Persisted agent-grant counts (used when no instance is running). */
  grantCounts?: () => { pending: number; active: number };
}

const USAGE = `Usage:
  mailpouch status [--json]`;

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: unknown) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // exists, other user
  }
}

/** Read the live holder PID from this account's singleton lock, or null. */
function readLockPid(accountIdentity: string | undefined): number | null {
  try {
    const pid = parseInt(readFileSync(lockPathForAccount(accountIdentity), "utf-8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 && isPidAlive(pid) ? pid : null;
  } catch {
    return null;
  }
}

/** GET /api/status on a running instance; null if nothing valid answers. */
function probeApiStatus(port: number): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: "/api/status", method: "GET", timeout: 750 },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => { body += c; if (body.length > 4096) { res.destroy(); resolve(null); } });
        res.on("end", () => {
          try {
            const j = JSON.parse(body) as Record<string, unknown>;
            resolve(typeof j.hasConfig === "boolean" ? j : null);
          } catch { resolve(null); }
        });
        res.on("error", () => resolve(null));
      },
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.end();
  });
}

/** Count persisted grants by status without instantiating the live store. */
function readGrantCounts(): { pending: number; active: number } {
  try {
    const path = homeFile("MAILPOUCH_AGENTS", ".mailpouch-agents.json");
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as { grants?: Array<{ status?: string }> };
    const grants = Array.isArray(parsed.grants) ? parsed.grants : [];
    return {
      pending: grants.filter((g) => g.status === "pending").length,
      active: grants.filter((g) => g.status === "active").length,
    };
  } catch {
    return { pending: 0, active: 0 };
  }
}

export async function runStatusCli(argv: string[], deps: StatusCliDeps = {}): Promise<number> {
  const out = deps.out ?? ((l: string) => process.stdout.write(l + "\n"));
  const err = deps.err ?? ((l: string) => process.stderr.write(l + "\n"));
  const probe = deps.probe ?? probeApiStatus;
  const readPid = deps.readPid ?? readLockPid;
  const gather = deps.gather ?? gatherSetupStatus;
  const grantCounts = deps.grantCounts ?? readGrantCounts;

  const json = argv.includes("--json");
  const unknown = argv.find((a) => a !== "--json");
  if (unknown) { err(`error: unknown argument '${unknown}'.`); err(USAGE); return 2; }

  const cfg = loadConfig();
  const accountIdentity = cfg?.connection.username || "";
  const settingsPort = cfg?.settingsPort ?? 8766;

  const pid = readPid(accountIdentity);
  const payload = await probe(settingsPort);
  const diagnosis = await gather();

  const reachable = payload !== null;
  const running = pid !== null || reachable;
  const instance: RunningInstance = {
    pid,
    reachable,
    ...(payload
      ? {
          version: typeof payload.version === "string" ? payload.version : undefined,
          connected: typeof payload.connected === "boolean" ? payload.connected : undefined,
          account: typeof payload.account === "string" ? payload.account : undefined,
          pendingCount: typeof payload.pendingCount === "number" ? payload.pendingCount : undefined,
          activeCount: typeof payload.activeCount === "number" ? payload.activeCount : undefined,
        }
      : {}),
  };

  // Live counts from the running instance when available; else the persisted store.
  const agents = payload && typeof payload.pendingCount === "number" && typeof payload.activeCount === "number"
    ? { pending: payload.pendingCount as number, active: payload.activeCount as number }
    : grantCounts();

  const result: StatusResult = {
    running,
    instance,
    settingsPort,
    configPath: getConfigPath(),
    logPath: getLogFilePath(),
    agents,
    diagnosis,
  };

  if (json) {
    out(JSON.stringify(result, null, 2));
  } else {
    const runLine = running
      ? `RUNNING${pid ? ` (pid ${pid})` : ""}${reachable ? ` · settings http://localhost:${settingsPort}` : " · settings UI not answering"}`
      : "NOT RUNNING (no live instance for this account)";
    out(`mailpouch status: ${runLine}`);
    out("");
    if (reachable) {
      // An instance that predates /api/status enrichment omits these fields —
      // report "unknown" rather than a misleading "NOT connected".
      const older = " (older instance — restart to populate)";
      out(`  version       : ${instance.version ?? `unknown${older}`}`);
      out(`  connection    : ${instance.connected === undefined ? `unknown${older}` : instance.connected ? "connected" : "NOT connected"}`);
      out(`  account       : ${instance.account || diagnosis.username || "(not set)"}`);
    }
    out(`  agents        : ${agents.active} active, ${agents.pending} pending`);
    out(`  Bridge IMAP   : ${diagnosis.imap.host}:${diagnosis.imap.port} ${diagnosis.imap.reachable ? "reachable" : "UNREACHABLE"}`);
    out(`  Bridge SMTP   : ${diagnosis.smtp.host}:${diagnosis.smtp.port} ${diagnosis.smtp.reachable ? "reachable" : "UNREACHABLE"}`);
    out(`  config file   : ${result.configPath}`);
    out(`  log file      : ${result.logPath}`);
    if (diagnosis.state !== "ready") {
      out("");
      out(`Setup not complete (${diagnosis.state}). Run \`mailpouch doctor\` for the next step.`);
    }
  }

  // Exit 0 when a running instance reports connected, or the offline diagnosis is ready.
  return (reachable && instance.connected) || diagnosis.state === "ready" ? 0 : 1;
}
