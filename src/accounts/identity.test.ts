import { describe, expect, it } from "vitest";
import { accountIdentityFingerprint, hasMaterialAccountIdentityChange } from "./identity.js";
import type { AccountSpec } from "./types.js";

function account(overrides: Partial<AccountSpec> = {}): AccountSpec {
  return {
    id: "acct-a",
    name: "Mailbox A",
    providerType: "imap",
    smtpHost: "smtp.example.test",
    smtpPort: 587,
    imapHost: "imap.example.test",
    imapPort: 993,
    username: "person@example.test",
    password: "secret",
    tlsMode: "ssl",
    ...overrides,
  };
}

describe("account identity fingerprint", () => {
  it("is stable across display, password, and TLS-certificate maintenance edits", () => {
    const original = account();
    const maintained = account({ name: "Renamed", password: "rotated", bridgeCertPath: "/tmp/bridge.pem" });
    expect(accountIdentityFingerprint(maintained)).toBe(accountIdentityFingerprint(original));
    expect(hasMaterialAccountIdentityChange(original, maintained)).toBe(false);
  });

  it("changes when an account ID is repointed at another mailbox or transport", () => {
    const original = account();
    expect(hasMaterialAccountIdentityChange(original, account({ username: "other@example.test" }))).toBe(true);
    expect(hasMaterialAccountIdentityChange(original, account({ imapHost: "other-imap.example.test" }))).toBe(true);
    expect(hasMaterialAccountIdentityChange(original, account({ smtpHost: "other-smtp.example.test" }))).toBe(true);
  });
});
