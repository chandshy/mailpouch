import { describe, it, expect } from "vitest";
import { runSetupCli } from "./setup-cli.js";
import type { AccountRegistry, AccountSpec } from "../accounts/types.js";

function primary(overrides: Partial<AccountSpec> = {}): AccountSpec {
  return {
    id: "primary",
    name: "Proton Mail (Bridge)",
    providerType: "proton-bridge",
    smtpHost: "127.0.0.1", smtpPort: 1025,
    imapHost: "127.0.0.1", imapPort: 1143,
    username: "", password: "",
    ...overrides,
  };
}

function harness(reg: AccountRegistry = { accounts: [primary()], activeAccountId: "primary" }) {
  const out: string[] = [];
  const err: string[] = [];
  let written: AccountRegistry | null = null;
  const deps = {
    out: (l: string) => out.push(l),
    err: (l: string) => err.push(l),
    readRegistry: () => reg,
    writeRegistry: async (r: AccountRegistry) => { written = r; },
    loadConfig: () => ({ credentialStorage: "keychain" } as never),
  };
  return { out, err, deps, get written() { return written; } };
}

function activeOf(reg: AccountRegistry | null): AccountSpec | undefined {
  return reg?.accounts.find((a) => a.id === reg.activeAccountId);
}

describe("mailpouch setup CLI", () => {
  it("writes username + password to the active account via writeRegistry", async () => {
    const h = harness();
    const code = await runSetupCli(["--username", "me@proton.me", "--password", "bridge-pw"], h.deps);
    expect(code).toBe(0);
    const a = activeOf(h.written);
    expect(a?.username).toBe("me@proton.me");
    expect(a?.password).toBe("bridge-pw");
    expect(a?.imapHost).toBe("127.0.0.1");
    expect(a?.imapPort).toBe(1143);
    expect(a?.smtpPort).toBe(1025);
    expect(h.out.join("\n")).toMatch(/stored in keychain/);
  });

  it("updates the ACTIVE account on a multi-account registry (not the legacy key)", async () => {
    const reg: AccountRegistry = {
      accounts: [primary({ id: "primary", username: "old@proton.me" }), primary({ id: "work", username: "work@x.com" })],
      activeAccountId: "work",
    };
    const h = harness(reg);
    const code = await runSetupCli(["--username", "work2@x.com", "--password", "p"], h.deps);
    expect(code).toBe(0);
    // The active account ("work") was updated; the other is untouched.
    expect(h.written?.accounts.find((a) => a.id === "work")?.username).toBe("work2@x.com");
    expect(h.written?.accounts.find((a) => a.id === "primary")?.username).toBe("old@proton.me");
    expect(h.out.join("\n")).toMatch(/account 'work'/);
    expect(h.out.join("\n")).toMatch(/other account\(s\) untouched/);
  });

  it("reads the password from stdin with --password-stdin (trailing newlines stripped)", async () => {
    const h = harness();
    const deps = { ...h.deps, readStdin: async () => "secret-from-stdin\n\n" };
    const code = await runSetupCli(["--username", "me@proton.me", "--password-stdin"], deps);
    expect(code).toBe(0);
    expect(activeOf(h.written)?.password).toBe("secret-from-stdin");
  });

  it("does NOT swallow the next flag as a password value", async () => {
    const h = harness();
    const code = await runSetupCli(["--username", "me@proton.me", "--password", "--insecure"], h.deps);
    expect(code).toBe(2);
    expect(h.err.join("\n")).toMatch(/missing value for: --password/);
    expect(h.written).toBeNull();
  });

  it("accepts a value starting with -- via the = form", async () => {
    const h = harness();
    const code = await runSetupCli(["--username", "me@proton.me", "--password=--weird--pw"], h.deps);
    expect(code).toBe(0);
    expect(activeOf(h.written)?.password).toBe("--weird--pw");
  });

  it("requires --username", async () => {
    const h = harness();
    const code = await runSetupCli(["--password", "x"], h.deps);
    expect(code).toBe(2);
    expect(h.err.join("\n")).toMatch(/--username is required/);
    expect(h.written).toBeNull();
  });

  it("rejects a username without @", async () => {
    const h = harness();
    expect(await runSetupCli(["--username", "notanemail", "--password", "x"], h.deps)).toBe(2);
  });

  it("requires a password source", async () => {
    const h = harness();
    const code = await runSetupCli(["--username", "me@proton.me"], h.deps);
    expect(code).toBe(2);
    expect(h.err.join("\n")).toMatch(/password is required/);
  });

  it("rejects more than one password source", async () => {
    const h = harness();
    const deps = { ...h.deps, readStdin: async () => "x" };
    const code = await runSetupCli(["--username", "me@proton.me", "--password", "a", "--password-stdin"], deps);
    expect(code).toBe(2);
    expect(h.err.join("\n")).toMatch(/only one password source/);
  });

  it("rejects an empty password", async () => {
    const h = harness();
    const deps = { ...h.deps, readStdin: async () => "\n" };
    expect(await runSetupCli(["--username", "me@proton.me", "--password-stdin"], deps)).toBe(2);
  });

  it("validates ports and rejects non-decimal values", async () => {
    for (const bad of ["notaport", "0x10", "70000", "0"]) {
      const h = harness();
      const code = await runSetupCli(
        ["--username", "me@proton.me", "--password", "x", "--imap-port", bad],
        h.deps,
      );
      expect(code, `port '${bad}' should be rejected`).toBe(2);
      expect(h.err.join("\n")).toMatch(/imap-port/);
    }
  });

  it("--insecure sets allowInsecureBridge; mutually exclusive with --bridge-cert", async () => {
    const h1 = harness();
    expect(await runSetupCli(["--username", "me@proton.me", "--password", "x", "--insecure"], h1.deps)).toBe(0);
    expect(activeOf(h1.written)?.allowInsecureBridge).toBe(true);

    const h2 = harness();
    const code = await runSetupCli(
      ["--username", "me@proton.me", "--password", "x", "--insecure", "--bridge-cert", "/c.pem"],
      h2.deps,
    );
    expect(code).toBe(2);
    expect(h2.err.join("\n")).toMatch(/mutually exclusive/);
  });

  it("rejects unknown arguments", async () => {
    const h = harness();
    const code = await runSetupCli(["--username", "me@proton.me", "--password", "x", "--bogus"], h.deps);
    expect(code).toBe(2);
    expect(h.err.join("\n")).toMatch(/unrecognized argument/);
  });
});
