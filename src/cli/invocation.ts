/**
 * Pure CLI dispatch resolution for `mailpouch`.
 *
 * The bare `mailpouch` (no positional subcommand) is the MCP stdio server that
 * Claude Desktop spawns — it must keep booting the full server. But a human
 * inspecting the install types `mailpouch status` / `mailpouch --help` and used
 * to get a *second* full server booted in the foreground (it hung until SIGTERM
 * and spawned a transient instance beside the real daemon), because anything
 * unrecognized fell through to the server start.
 *
 * This resolver makes the surface explicit: known subcommands and --help/--version
 * are handled and exit; an UNKNOWN positional command is an error (never the
 * server); only a bare or flag-only invocation reaches the server. Kept pure and
 * dependency-free so it's unit-tested directly; main() switches on the result.
 */

export const KNOWN_SUBCOMMANDS = ["setup", "doctor", "status", "agent", "daemon"] as const;
export type KnownSubcommand = (typeof KNOWN_SUBCOMMANDS)[number];

/** Flags that consume the following token as their value (so it isn't mistaken
 *  for a positional subcommand). Only the daemon's --host/--port do this. */
const VALUE_FLAGS: ReadonlySet<string> = new Set(["--host", "--port"]);

export type Invocation =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "subcommand"; name: KnownSubcommand }
  | { kind: "server" }
  | { kind: "unknown"; arg: string };

/**
 * Resolve a full `process.argv` (argv[0]=node, argv[1]=script, argv[2..]=args)
 * into the intended action. --help/--version win over everything (mirrors the
 * pre-existing --version short-circuit).
 */
export function resolveInvocation(argv: string[]): Invocation {
  const args = argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) return { kind: "help" };
  if (args.includes("--version") || args.includes("-v")) return { kind: "version" };

  // Find the first POSITIONAL token, skipping flags and any value a flag consumes.
  let positional: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("-")) {
      if (VALUE_FLAGS.has(a)) i++; // skip the flag's value (e.g. `--port 9000`)
      continue;
    }
    positional = a;
    break;
  }

  if (positional === undefined) return { kind: "server" }; // bare or flag-only → MCP stdio server
  if ((KNOWN_SUBCOMMANDS as readonly string[]).includes(positional)) {
    return { kind: "subcommand", name: positional as KnownSubcommand };
  }
  return { kind: "unknown", arg: positional };
}

export const USAGE = `mailpouch — MCP server for Proton Mail / IMAP via Proton Bridge.

For one-off commands, the PATH-proof form (no global install needed) is:
  npx -y mailpouch <command>

Commands:
  (no command)        Run the MCP server on stdio. This is what an MCP client
                      (e.g. Claude Desktop) spawns; not meant to run by hand.
  setup               Configure Bridge credentials non-interactively
                        --username <addr> (--password-stdin | --password-file <p> | --password <pw>)
                        [--imap-host/--imap-port/--smtp-host/--smtp-port] [--bridge-cert <p> | --insecure]
  doctor [--json]     Diagnose the install/connection; prints the next step, exits
  status [--json]     Show whether mailpouch is running, its ports, connection, and
                      approved agents — read-only, exits (does not start a server)
  agent <issue|list|revoke …>   Manage headless service accounts
  daemon [--host H] [--port P]  Run the shared HTTP daemon (forces HTTP transport)

Flags:
  -h, --help          Show this help and exit
  -v, --version       Print the version and exit
  --settings-only     Run only the settings UI + tray (no MCP transport)
  --no-tray           Don't start the system tray icon
  --no-settings-ui    Don't start the settings UI server`;
