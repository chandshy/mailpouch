import { describe, it, expect, afterEach } from "vitest";
import { runAgentCli } from "./agent-cli.js";
import { ServiceAccountStore } from "../agents/service-account-store.js";
import { AgentGrantStore } from "../agents/grant-store.js";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import { rmSync } from "fs";

const paths: string[] = [];
function tmpFile(tag: string): string {
  const p = join(tmpdir(), `mp-cli-${tag}-${randomBytes(6).toString("hex")}.json`);
  paths.push(p);
  return p;
}

function harness() {
  const serviceAccounts = new ServiceAccountStore(tmpFile("sa"));
  const agentGrants = new AgentGrantStore(tmpFile("ag"));
  const out: string[] = [];
  const err: string[] = [];
  const deps = { serviceAccounts, agentGrants, out: (l: string) => out.push(l), err: (l: string) => err.push(l) };
  return { serviceAccounts, agentGrants, out, err, deps };
}

afterEach(() => {
  while (paths.length) {
    const p = paths.pop();
    if (p) { try { rmSync(p, { force: true }); } catch { /* ignore */ } }
  }
});

describe("mailpouch agent CLI", () => {
  it("issue creates a pre-approved (active) service account and prints the secret once", async () => {
    const h = harness();
    const code = await runAgentCli(["issue", "--name", "cron", "--preset", "read_only"], h.deps);
    expect(code).toBe(0);
    const accounts = h.serviceAccounts.list();
    expect(accounts).toHaveLength(1);
    // Matching grant is born active.
    expect(h.agentGrants.get(accounts[0].clientId)?.status).toBe("active");
    const printed = h.out.join("\n");
    expect(printed).toContain("client_id:");
    expect(printed).toContain("client_secret:");
    expect(printed).toMatch(/shown ONCE/i);
  });

  it("issue parses --expires and --folder into grant conditions", async () => {
    const h = harness();
    const code = await runAgentCli(
      ["issue", "--name", "scoped", "--preset", "full", "--expires", "2030-06-01T00:00:00Z", "--folder", "INBOX,Archive"],
      h.deps,
    );
    expect(code).toBe(0);
    const acct = h.serviceAccounts.list()[0];
    expect(acct.conditions?.folderAllowlist).toEqual(["INBOX", "Archive"]);
    expect(acct.conditions?.expiresAt).toBe(new Date("2030-06-01T00:00:00Z").toISOString());
  });

  it("issue rejects a bad preset with exit code 2", async () => {
    const h = harness();
    const code = await runAgentCli(["issue", "--name", "x", "--preset", "bogus"], h.deps);
    expect(code).toBe(2);
    expect(h.err.join("\n")).toMatch(/preset must be one of/i);
    expect(h.serviceAccounts.list()).toHaveLength(0);
  });

  it("issue requires --name", async () => {
    const h = harness();
    const code = await runAgentCli(["issue", "--preset", "full"], h.deps);
    expect(code).toBe(2);
    expect(h.err.join("\n")).toMatch(/--name is required/i);
  });

  it("list shows issued accounts and their grant status", async () => {
    const h = harness();
    await runAgentCli(["issue", "--name", "one", "--preset", "full"], h.deps);
    h.out.length = 0;
    const code = await runAgentCli(["list"], h.deps);
    expect(code).toBe(0);
    const printed = h.out.join("\n");
    expect(printed).toContain('"one"');
    expect(printed).toContain("status=active");
  });

  it("revoke removes the account and revokes the grant", async () => {
    const h = harness();
    await runAgentCli(["issue", "--name", "kill", "--preset", "full"], h.deps);
    const clientId = h.serviceAccounts.list()[0].clientId;
    h.out.length = 0;
    const code = await runAgentCli(["revoke", clientId], h.deps);
    expect(code).toBe(0);
    expect(h.serviceAccounts.list()).toHaveLength(0);
    expect(h.agentGrants.get(clientId)?.status).toBe("revoked");
  });

  it("revoke of an unknown id returns exit code 1", async () => {
    const h = harness();
    const code = await runAgentCli(["revoke", "pmc_nope"], h.deps);
    expect(code).toBe(1);
  });

  it("unknown subcommand returns exit code 2 with usage", async () => {
    const h = harness();
    const code = await runAgentCli(["frobnicate"], h.deps);
    expect(code).toBe(2);
    expect(h.err.join("\n")).toMatch(/unknown agent subcommand/i);
  });
});
