/**
 * `mailpouch agent <subcommand>` — provision and manage service accounts
 * (the non-interactive half of the agent-auth model) from the command line.
 *
 *   mailpouch agent issue  --name <n> --preset <preset> [--expires <iso>] [--folder a,b]
 *   mailpouch agent list
 *   mailpouch agent revoke <client_id>
 *
 * Runs as a short-lived process distinct from the MCP daemon: it edits the
 * on-disk service-account + grant stores directly. `issue`/`list` are fully
 * effective immediately; `revoke` removes the credential and marks the grant
 * revoked on disk — a *running* daemon drops the live token on its next
 * grant-store sync or restart (the in-process Settings UI revoke is immediate).
 */

import type { ServiceAccountStore } from "../agents/service-account-store.js";
import type { AgentGrantStore } from "../agents/grant-store.js";
import { PERMISSION_PRESETS, type PermissionPreset } from "../config/schema.js";
import type { GrantConditions } from "../agents/types.js";

export interface AgentCliDeps {
  serviceAccounts: ServiceAccountStore;
  agentGrants: AgentGrantStore;
  /** Where to write user-facing output. Injectable for tests. */
  out?: (line: string) => void;
  err?: (line: string) => void;
}

const USAGE = `Usage:
  mailpouch agent issue --name <name> --preset <${PERMISSION_PRESETS.join("|")}> [--expires <iso8601>] [--folder a,b,c]
  mailpouch agent list
  mailpouch agent revoke <client_id>`;

/** Parse `--flag value` / `--flag=value` pairs and positional args from argv. */
function parseFlags(args: string[]): { flags: Record<string, string>; positional: string[] } {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq >= 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        flags[a.slice(2)] = args[i + 1] ?? "";
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

/**
 * Run the `agent` subcommand. `argv` is the slice AFTER "agent"
 * (e.g. ["issue", "--name", "cron"]). Returns a process exit code.
 */
export async function runAgentCli(argv: string[], deps: AgentCliDeps): Promise<number> {
  const out = deps.out ?? ((l: string) => process.stdout.write(l + "\n"));
  const err = deps.err ?? ((l: string) => process.stderr.write(l + "\n"));
  const [sub, ...rest] = argv;
  const { flags, positional } = parseFlags(rest);

  switch (sub) {
    case "issue": {
      const name = flags.name?.trim();
      const preset = flags.preset?.trim() as PermissionPreset | undefined;
      if (!name) { err("error: --name is required."); err(USAGE); return 2; }
      if (!preset || !PERMISSION_PRESETS.includes(preset)) {
        err(`error: --preset must be one of ${PERMISSION_PRESETS.join(", ")}.`); err(USAGE); return 2;
      }
      const conditions: GrantConditions = {};
      if (flags.expires) {
        const t = Date.parse(flags.expires);
        if (Number.isNaN(t)) { err("error: --expires must be an ISO-8601 timestamp."); return 2; }
        conditions.expiresAt = new Date(t).toISOString();
      }
      if (flags.folder) {
        conditions.folderAllowlist = flags.folder.split(",").map(s => s.trim()).filter(Boolean);
      }
      const hasConditions = Object.keys(conditions).length > 0;
      const { account, clientSecret } = deps.serviceAccounts.issue({
        name,
        preset,
        conditions: hasConditions ? conditions : undefined,
      });
      deps.agentGrants.ensureActiveServiceGrant({
        clientId: account.clientId,
        clientName: account.clientName,
        preset: account.preset,
        conditions: account.conditions,
      });
      out("Service account issued and pre-approved (active grant created).");
      out("");
      out(`  client_id:     ${account.clientId}`);
      out(`  client_secret: ${clientSecret}`);
      out(`  preset:        ${account.preset}`);
      if (account.conditions?.expiresAt) out(`  expires:       ${account.conditions.expiresAt}`);
      if (account.conditions?.folderAllowlist) out(`  folders:       ${account.conditions.folderAllowlist.join(", ")}`);
      out("");
      out("Store the client_secret now — it is shown ONCE and cannot be recovered.");
      out("Log in with: POST /oauth/token  grant_type=client_credentials");
      out("  Authorization: Basic base64(client_id:client_secret)");
      return 0;
    }

    case "list": {
      const accounts = deps.serviceAccounts.list();
      if (accounts.length === 0) { out("No service accounts. Create one with `mailpouch agent issue`."); return 0; }
      out(`${accounts.length} service account(s):`);
      out("");
      for (const a of accounts) {
        const grant = deps.agentGrants.get(a.clientId);
        const status = grant?.status ?? "(no grant)";
        const expires = a.conditions?.expiresAt ? ` expires=${a.conditions.expiresAt}` : "";
        out(`  ${a.clientId}  "${a.clientName}"  preset=${a.preset}  status=${status}${expires}`);
      }
      return 0;
    }

    case "revoke": {
      const clientId = positional[0] ?? flags.id;
      if (!clientId) { err("error: revoke requires a client_id."); err(USAGE); return 2; }
      const existed = deps.serviceAccounts.revoke(clientId);
      const grant = deps.agentGrants.revoke(clientId);
      if (!existed && !grant) { err(`error: no service account or grant found for ${clientId}.`); return 1; }
      out(`Revoked ${clientId}: service account ${existed ? "removed" : "absent"}, grant ${grant ? "revoked" : "absent"}.`);
      out("A running daemon drops the live token on its next grant-store sync or restart.");
      return 0;
    }

    default:
      err(sub ? `error: unknown agent subcommand '${sub}'.` : "error: missing agent subcommand.");
      err(USAGE);
      return 2;
  }
}
