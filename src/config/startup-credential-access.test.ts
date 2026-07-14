import { describe, expect, it, vi } from "vitest";
import { StartupCredentialAccess } from "./startup-credential-access.js";

const TOKEN = "mpE2E-00000000-0000-4000-8000-000000000003";
const PATH = `/home/test/.mailpouch-e2e-bridge-${TOKEN}.json`;

describe("startup credential access", () => {
  it("keeps exact config-only startup away from migration and every external keychain reader", async () => {
    const access = new StartupCredentialAccess({
      MAILPOUCH_E2E_CONFIG_ONLY_CREDENTIALS: "1",
      MAILPOUCH_E2E_RUN_TOKEN: TOKEN,
    }, PATH);
    const migrate = vi.fn(async () => true);
    const auxiliary = vi.fn(async () => ({ passAccessToken: "operator-pass" }));
    const remote = vi.fn(async () => ({ remoteBearerToken: "operator-remote" }));
    const mailboxFromConfig = vi.fn(async () => ({ password: "clone-password" }));
    const mailboxFromKeychain = vi.fn(async () => ({ password: "operator-password" }));

    await expect(access.migrate(migrate)).resolves.toBe(false);
    await expect(access.readExternal(auxiliary)).resolves.toBeNull();
    await expect(access.readExternal(remote)).resolves.toBeNull();
    await expect(access.readMailbox(mailboxFromConfig, mailboxFromKeychain))
      .resolves.toEqual({ password: "clone-password" });

    expect(migrate).not.toHaveBeenCalled();
    expect(auxiliary).not.toHaveBeenCalled();
    expect(remote).not.toHaveBeenCalled();
    expect(mailboxFromConfig).toHaveBeenCalledOnce();
    expect(mailboxFromKeychain).not.toHaveBeenCalled();
  });

  it("applies the same no-keychain policy to an exact Greenmail test profile", async () => {
    const access = new StartupCredentialAccess({
      MAILPOUCH_E2E_CONFIG_ONLY_CREDENTIALS: "1",
      MAILPOUCH_E2E_CREDENTIAL_TOKEN: TOKEN,
    }, `/home/test/.mailpouch-e2e-greenmail-${TOKEN}.json`);
    const migrate = vi.fn(async () => true);
    const external = vi.fn(async () => "operator-secret");
    const mailboxFromConfig = vi.fn(async () => "greenmail-password");
    const mailboxFromKeychain = vi.fn(async () => "operator-password");

    await expect(access.migrate(migrate)).resolves.toBe(false);
    await expect(access.readExternal(external)).resolves.toBeNull();
    await expect(access.readMailbox(mailboxFromConfig, mailboxFromKeychain))
      .resolves.toBe("greenmail-password");
    expect(migrate).not.toHaveBeenCalled();
    expect(external).not.toHaveBeenCalled();
    expect(mailboxFromKeychain).not.toHaveBeenCalled();
  });

  it("retains normal startup access outside config-only mode", async () => {
    const access = new StartupCredentialAccess({}, "/home/test/.mailpouch.json");
    const migrate = vi.fn(async () => true);
    const external = vi.fn(async () => "keychain-value");
    const mailboxFromConfig = vi.fn(async () => "config-value");
    const mailboxFromKeychain = vi.fn(async () => "keychain-value");

    await expect(access.migrate(migrate)).resolves.toBe(true);
    await expect(access.readExternal(external)).resolves.toBe("keychain-value");
    await expect(access.readMailbox(mailboxFromConfig, mailboxFromKeychain))
      .resolves.toBe("keychain-value");

    expect(migrate).toHaveBeenCalledOnce();
    expect(external).toHaveBeenCalledOnce();
    expect(mailboxFromConfig).not.toHaveBeenCalled();
    expect(mailboxFromKeychain).toHaveBeenCalledOnce();
  });
});
