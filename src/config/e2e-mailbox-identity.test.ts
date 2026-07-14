import { describe, expect, it } from "vitest";
import {
  assertE2EMailboxIdentity,
  assertE2EUidPlusCapability,
  E2E_MAILBOX_IDENTITY_ARG,
  withE2EMailboxIdentity,
} from "./e2e-mailbox-identity.js";

const TOKEN = "mpE2E-00000000-0000-4000-8000-000000000001";
const FOLDER = `Folders/${TOKEN}-source`;
const ENV = {
  MAILPOUCH_E2E_CONFIG_ONLY_CREDENTIALS: "1",
  MAILPOUCH_E2E_RUN_TOKEN: TOKEN,
} as NodeJS.ProcessEnv;

function args(folder = FOLDER, uidValidity = "17", uids = ["42"]): Record<string, unknown> {
  return {
    [E2E_MAILBOX_IDENTITY_ARG]: { token: TOKEN, folder, uidValidity, uids },
  };
}

describe("Bridge E2E child mailbox identity", () => {
  it("is inert outside tightly scoped E2E credential mode", () => {
    expect(() => assertE2EMailboxIdentity("INBOX", ["1"], false, {})).not.toThrow();
    expect(() => assertE2EUidPlusCapability(undefined, {})).not.toThrow();
  });

  it("requires negotiated UIDPLUS for live destructive commands", () => {
    expect(() => assertE2EUidPlusCapability(new Map(), ENV)).toThrow(/UIDPLUS/i);
    expect(() => assertE2EUidPlusCapability(undefined, ENV)).toThrow(/UIDPLUS/i);
    expect(() => assertE2EUidPlusCapability(new Map([["UIDPLUS", true]]), ENV)).not.toThrow();
  });

  it("accepts the exact request-local folder, UIDVALIDITY, and UID", () => {
    expect(() => withE2EMailboxIdentity(
      args(),
      () => assertE2EMailboxIdentity(FOLDER, ["42"], { uidValidity: 17n }, ENV),
      ENV,
    )).not.toThrow();
  });

  it("accepts an exact-owned INBOX UID but no other non-scratch system folder", () => {
    expect(() => withE2EMailboxIdentity(
      args("INBOX"),
      () => assertE2EMailboxIdentity("INBOX", ["42"], { uidValidity: 17n }, ENV),
      ENV,
    )).not.toThrow();

    for (const folder of ["All Mail", "Archive", "Trash", "Sent", "Inbox", "INBOX/Subfolder"]) {
      expect(() => withE2EMailboxIdentity(args(folder), () => undefined, ENV))
        .toThrow(/invalid internal/i);
    }
  });

  it("refuses a mutation with no request-local proof", () => {
    expect(() => withE2EMailboxIdentity(
      {},
      () => assertE2EMailboxIdentity(FOLDER, ["42"], { uidValidity: 17n }, ENV),
      ENV,
    )).toThrow(/proof is missing/i);
  });

  it("refuses changed mailbox identity and unauthorized UID operands", () => {
    expect(() => withE2EMailboxIdentity(
      args(),
      () => assertE2EMailboxIdentity(FOLDER, ["42"], { uidValidity: 18n }, ENV),
      ENV,
    )).toThrow(/identity changed/i);
    expect(() => withE2EMailboxIdentity(
      args(),
      () => assertE2EMailboxIdentity(FOLDER, ["43"], { uidValidity: 17n }, ENV),
      ENV,
    )).toThrow(/not pre-authorized/i);
    expect(() => withE2EMailboxIdentity(
      args(),
      () => assertE2EMailboxIdentity(`${FOLDER}-other`, ["42"], { uidValidity: 17n }, ENV),
      ENV,
    )).toThrow(/identity changed/i);
  });

  it("refuses malformed or non-scratch internal proofs", () => {
    expect(() => withE2EMailboxIdentity(args("Archive"), () => undefined, ENV))
      .toThrow(/invalid internal/i);
    expect(() => withE2EMailboxIdentity(args(FOLDER, "0"), () => undefined, ENV))
      .toThrow(/invalid internal/i);
    expect(() => withE2EMailboxIdentity(args(FOLDER, "4294967296"), () => undefined, ENV))
      .toThrow(/invalid internal/i);
    expect(() => withE2EMailboxIdentity(args(FOLDER, "17", ["4294967296"]), () => undefined, ENV))
      .toThrow(/invalid internal/i);
  });

  it("refuses a proof whose embedded token does not match the enabled run", () => {
    const otherToken = "mpE2E-00000000-0000-4000-8000-000000000099";
    expect(() => withE2EMailboxIdentity({
      [E2E_MAILBOX_IDENTITY_ARG]: {
        token: otherToken,
        folder: `Folders/${otherToken}-source`,
        uidValidity: "17",
        uids: ["42"],
      },
    }, () => undefined, ENV)).toThrow(/invalid internal/i);
  });

  it("refuses duplicate UIDs instead of silently widening a replayable proof", () => {
    expect(() => withE2EMailboxIdentity(
      args(FOLDER, "17", ["42", "42"]),
      () => undefined,
      ENV,
    )).toThrow(/duplicate UID/i);
  });

  it("isolates concurrent request proofs", async () => {
    const otherFolder = `Labels/${TOKEN}-other`;
    await Promise.all([
      withE2EMailboxIdentity(args(FOLDER, "17", ["42"]), async () => {
        await Promise.resolve();
        assertE2EMailboxIdentity(FOLDER, ["42"], { uidValidity: 17n }, ENV);
      }, ENV),
      withE2EMailboxIdentity(args(otherFolder, "19", ["7"]), async () => {
        await Promise.resolve();
        assertE2EMailboxIdentity(otherFolder, ["7"], { uidValidity: 19n }, ENV);
      }, ENV),
    ]);
  });
});
