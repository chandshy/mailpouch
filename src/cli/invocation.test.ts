import { describe, it, expect } from "vitest";
import { resolveInvocation } from "./invocation.js";

// Helper: build a full process.argv (node + script + the rest).
const argv = (...rest: string[]) => ["node", "/x/dist/index.js", ...rest];

describe("resolveInvocation", () => {
  it("bare invocation → server (the MCP stdio child)", () => {
    expect(resolveInvocation(argv())).toEqual({ kind: "server" });
  });

  it("flag-only invocations → server (MCP child with options)", () => {
    expect(resolveInvocation(argv("--no-tray")).kind).toBe("server");
    expect(resolveInvocation(argv("--settings-only")).kind).toBe("server");
    expect(resolveInvocation(argv("--no-settings-ui", "--no-tray")).kind).toBe("server");
  });

  it("--help / -h → help", () => {
    expect(resolveInvocation(argv("--help"))).toEqual({ kind: "help" });
    expect(resolveInvocation(argv("-h"))).toEqual({ kind: "help" });
  });

  it("--version / -v → version (wins over a subcommand)", () => {
    expect(resolveInvocation(argv("--version"))).toEqual({ kind: "version" });
    expect(resolveInvocation(argv("-v"))).toEqual({ kind: "version" });
  });

  it("known subcommands resolve", () => {
    for (const name of ["setup", "doctor", "status", "agent", "daemon"] as const) {
      expect(resolveInvocation(argv(name))).toEqual({ kind: "subcommand", name });
    }
  });

  it("subcommand with its own args still resolves to the subcommand", () => {
    expect(resolveInvocation(argv("agent", "issue", "--name", "cron"))).toEqual({ kind: "subcommand", name: "agent" });
    expect(resolveInvocation(argv("doctor", "--json"))).toEqual({ kind: "subcommand", name: "doctor" });
    expect(resolveInvocation(argv("status", "--json"))).toEqual({ kind: "subcommand", name: "status" });
  });

  it("daemon value-flags don't get mistaken for a positional", () => {
    expect(resolveInvocation(argv("daemon", "--port", "9000"))).toEqual({ kind: "subcommand", name: "daemon" });
    expect(resolveInvocation(argv("daemon", "--host", "127.0.0.1", "--port", "8788"))).toEqual({ kind: "subcommand", name: "daemon" });
    // `--port 9000` without a subcommand must NOT treat "9000" as a command.
    expect(resolveInvocation(argv("--port", "9000")).kind).toBe("server");
  });

  it("REGRESSION: an unknown positional is 'unknown' — NEVER 'server' (no rogue instance)", () => {
    expect(resolveInvocation(argv("bogus"))).toEqual({ kind: "unknown", arg: "bogus" });
    expect(resolveInvocation(argv("staus"))).toEqual({ kind: "unknown", arg: "staus" }); // typo of status
    expect(resolveInvocation(argv("start"))).toEqual({ kind: "unknown", arg: "start" });
    // The whole point: these must not boot a server.
    for (const bad of ["bogus", "staus", "start"]) {
      expect(resolveInvocation(argv(bad)).kind).not.toBe("server");
    }
  });
});
