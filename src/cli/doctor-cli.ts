/**
 * `mailpouch doctor` — print the install/connect diagnosis and exit.
 *
 * Offline admin command (no Bridge connect, no MCP transport). Prints the same
 * diagnosis the `setup_status` MCP tool returns, in human form, plus the single
 * next step. Exit code is 0 when the install is `ready`, 1 otherwise — so it can
 * gate a script (`mailpouch doctor && …`). `--json` emits the structured result.
 *
 * See src/diagnostics/setup-status.ts for the shared decision logic.
 */

import { gatherSetupStatus } from "../diagnostics/setup-status.js";

export interface DoctorCliDeps {
  out?: (line: string) => void;
  err?: (line: string) => void;
}

const USAGE = `Usage:
  mailpouch doctor [--json]`;

export async function runDoctorCli(argv: string[], deps: DoctorCliDeps = {}): Promise<number> {
  const out = deps.out ?? ((l: string) => process.stdout.write(l + "\n"));
  const err = deps.err ?? ((l: string) => process.stderr.write(l + "\n"));

  const json = argv.includes("--json");
  const unknown = argv.find((a) => a !== "--json");
  if (unknown) {
    err(`error: unknown argument '${unknown}'.`);
    err(USAGE);
    return 2;
  }

  const result = await gatherSetupStatus();
  if (json) {
    out(JSON.stringify(result, null, 2));
  } else {
    out(result.summary);
  }
  return result.state === "ready" ? 0 : 1;
}
