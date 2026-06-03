/**
 * Transport selection for the MCP server.
 *
 * The server runs over either stdio (a client spawns it as a child process)
 * or HTTP (a long-lived remote/self-host daemon). The choice normally follows
 * `connection.remoteMode` in the config — but a single config can't serve both
 * a shared HTTP daemon AND a per-client stdio spawn. `MAILPOUCH_FORCE_STDIO`
 * lets a stdio MCP-client entry (e.g. Claude Code in `~/.claude.json`) force
 * stdio for that spawn even when the global config has `remoteMode: true`, so
 * the two coexist without a duplicate config file.
 */

export type Transport = "stdio" | "http";

/**
 * Decide the transport. `forceStdio` (MAILPOUCH_FORCE_STDIO) wins so a stdio
 * MCP-client entry runs stdio even under remoteMode:true. `forceHttp` (the
 * `mailpouch daemon` command) runs the shared HTTP daemon regardless of
 * remoteMode. If both are set, stdio wins (an explicit per-client stdio spawn
 * should never accidentally become a daemon).
 */
export function chooseTransport(opts: { remoteMode?: boolean; forceStdio?: boolean; forceHttp?: boolean }): Transport {
  if (opts.forceStdio) return "stdio";
  if (opts.forceHttp) return "http";
  return opts.remoteMode ? "http" : "stdio";
}

/** Parse the MAILPOUCH_FORCE_STDIO env value (`1`/`true`, case-insensitive). */
export function forceStdioFromEnv(value: string | undefined): boolean {
  return /^(1|true)$/i.test(value ?? "");
}
