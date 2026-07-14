import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  hashOwnershipMessageId,
  OwnershipManifestStore,
  parseOwnershipManifest,
  type OwnershipManifest,
} from "./e2e/support/ownership-manifest.js";
import { runToken } from "./e2e/support/scratch.js";

const dirs: string[] = [];

function harness() {
  const token = runToken();
  const dir = mkdtempSync(join(tmpdir(), "mailpouch-ownership-"));
  dirs.push(dir);
  const path = join(dir, "manifest.json");
  return { token, path, store: new OwnershipManifestStore(token, path) };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Bridge E2E durable ownership manifests", () => {
  it("creates the first durable run manifest with its recovery baseline atomically", () => {
    const token = runToken();
    const dir = mkdtempSync(join(tmpdir(), "mailpouch-ownership-baseline-"));
    dirs.push(dir);
    const path = join(dir, "manifest.json");
    const baseline = {
      algorithm: "sha256" as const,
      mailboxPaths: ["INBOX"],
      mailboxes: [{ path: "INBOX", uidValidity: "42", messages: [] }],
    };

    const store = new OwnershipManifestStore(token, path, baseline);

    expect(store.baseline()).toEqual(baseline);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ version: 2, token, baseline });
    expect(() => new OwnershipManifestStore(token, path, baseline)).toThrow(/already exists/i);
  });

  it("durably records a constrained pending send before a result can be adopted", () => {
    const h = harness();
    const subject = `${h.token} post-dispatch recovery`;
    const pendingId = h.store.beginSent(subject);

    const durable = JSON.parse(readFileSync(h.path, "utf8")) as OwnershipManifest;
    expect(durable.pending).toEqual([{ id: pendingId, kind: "pending-sent", subject }]);
    expect(h.store.matches({ folder: "Sent", uid: 7, subject })).toBe(true);
    expect(h.store.matches({ folder: "Sent", uid: 7, subject: `${subject} altered` })).toBe(false);
  });

  it("atomically replaces pending authority with a complete Message-ID and subject tuple", () => {
    const h = harness();
    const subject = `${h.token} exact send`;
    const pendingId = h.store.beginSent(subject);
    h.store.finalizeMessage(pendingId, { messageId: "<created@example.test>", subject });

    const reopened = new OwnershipManifestStore(h.token, h.path);
    expect(reopened.snapshot().pending).toEqual([]);
    expect(reopened.matches({
      folder: "All Mail",
      uid: 9,
      messageId: "created@example.test",
      subject,
    })).toBe(true);
    expect(reopened.matches({
      folder: "All Mail",
      uid: 9,
      messageId: "created@example.test",
      subject: "pre-existing message",
    })).toBe(false);
  });

  it("durably promotes an exactly observed pending send before cleanup mutation", () => {
    const h = harness();
    const subject = "Test Email from mailpouch";
    h.store.beginSent(subject, h.token);

    expect(h.store.promoteObservedPending({
      folder: "Sent",
      uid: 17,
      messageId: "<recovered-send@example.test>",
      subject,
      source: `delivery body ${h.token}`,
    })).toBe(true);

    const reopened = new OwnershipManifestStore(h.token, h.path);
    expect(reopened.pending()).toEqual([]);
    expect(reopened.proofs()).toEqual([{
      kind: "message-id",
      messageId: "recovered-send@example.test",
      subject,
      bodyToken: h.token,
    }]);
  });

  it("promotes a pending draft only from its exact folder", () => {
    const h = harness();
    const subject = `${h.token} recovered draft`;
    h.store.beginDraft("Drafts", subject);

    expect(h.store.promoteObservedPending({
      folder: "INBOX",
      uid: 4,
      messageId: "wrong-folder@example.test",
      subject,
    })).toBe(false);
    expect(h.store.promoteObservedPending({
      folder: "Drafts",
      uid: 4,
      messageId: "recovered-draft@example.test",
      subject,
    })).toBe(true);
    expect(new OwnershipManifestStore(h.token, h.path).proofs()).toEqual([{
      kind: "message-id",
      messageId: "recovered-draft@example.test",
      subject,
    }]);
  });

  it("never reuses one observed Message-ID to retire another pending dispatch", () => {
    const h = harness();
    const subject = `${h.token} duplicate dispatch`;
    h.store.beginSent(subject);
    h.store.beginSent(subject);
    const candidate = {
      folder: "Sent",
      uid: 21,
      messageId: "one-artifact@example.test",
      subject,
    };

    expect(h.store.promoteObservedPending(candidate)).toBe(true);
    expect(h.store.pending()).toHaveLength(1);
    expect(h.store.promoteObservedPending({ ...candidate, folder: "All Mail", uid: 22 })).toBe(false);
    expect(new OwnershipManifestStore(h.token, h.path).pending()).toHaveLength(1);
  });

  it("retains missing-ID, fixture-seed, and differently constrained pending authority", () => {
    const missing = harness();
    const missingSubject = `${missing.token} missing identity`;
    missing.store.beginSent(missingSubject);
    expect(missing.store.promoteObservedPending({
      folder: "Sent",
      uid: 1,
      subject: missingSubject,
    })).toBe(false);
    expect(missing.store.pending()).toHaveLength(1);

    const seed = harness();
    const seedSubject = `${seed.token} seed collision`;
    seed.store.beginSent(seedSubject);
    seed.store.recordHeaderMessageId("fixture-seed@example.test");
    expect(seed.store.promoteObservedPending({
      folder: "Sent",
      uid: 2,
      messageId: "fixture-seed@example.test",
      subject: seedSubject,
    })).toBe(false);
    expect(seed.store.pending()).toHaveLength(1);

    const ambiguous = harness();
    const ambiguousSubject = `${ambiguous.token} sent or draft`;
    ambiguous.store.beginSent(ambiguousSubject);
    ambiguous.store.beginDraft("Drafts", ambiguousSubject);
    expect(ambiguous.store.promoteObservedPending({
      folder: "Drafts",
      uid: 3,
      messageId: "ambiguous@example.test",
      subject: ambiguousSubject,
    })).toBe(false);
    expect(ambiguous.store.pending()).toHaveLength(2);
    expect(ambiguous.store.proofs()).toEqual([]);
  });

  it("requires the exact body token for fixed-subject send_test_email artifacts", () => {
    const h = harness();
    const subject = "Test Email from mailpouch";
    const pendingId = h.store.beginSent(subject, h.token);
    expect(h.store.matches({ folder: "Sent", uid: 1, subject, source: "ordinary body" })).toBe(false);
    expect(h.store.matches({ folder: "Sent", uid: 1, subject, source: `probe ${h.token}` })).toBe(true);

    h.store.finalizeMessage(pendingId, {
      messageId: "probe@example.test",
      subject,
      bodyToken: h.token,
    });
    expect(h.store.matches({
      folder: "INBOX",
      uid: 2,
      messageId: "probe@example.test",
      subject,
      source: "body without proof",
    })).toBe(false);
  });

  it("persists fixture Message-ID search hints without granting ownership authority", () => {
    const h = harness();
    h.store.recordHeaderMessageId("<fixture-created@example.test>");
    const reopened = new OwnershipManifestStore(h.token, h.path);

    expect(reopened.searchMessageIds()).toContain("fixture-created@example.test");
    expect(reopened.matches({
      folder: "All Mail",
      uid: 77,
      messageId: "fixture-created@example.test",
      subject: "pre-existing duplicate",
    })).toBe(false);
  });

  it("binds positive mailbox creation proof to path and UIDVALIDITY", () => {
    const h = harness();
    const path = `Folders/${h.token}-created`;
    h.store.recordCreatedMailbox(path, "77");

    const reopened = new OwnershipManifestStore(h.token, h.path);
    expect(reopened.createdMailbox(path)).toEqual({ path, uidValidity: "77" });
    expect(reopened.snapshot().createdMailboxes).toEqual([{ path, uidValidity: "77" }]);
    expect(() => reopened.recordCreatedMailbox(path, "78")).toThrow(/refusing to replace ownership proof/i);
  });

  it("drops path-only legacy folder authority while retaining a readable manifest", () => {
    const h = harness();
    const path = `Folders/${h.token}-legacy`;
    writeFileSync(h.path, JSON.stringify({
      version: 2,
      token: h.token,
      pending: [],
      proofs: [],
      headerMessageIds: [],
      createdMailboxes: [path],
    }));

    expect(new OwnershipManifestStore(h.token, h.path).createdMailboxes()).toEqual([]);
  });

  it("durably advances rescue lifecycle metadata without granting ownership", () => {
    const h = harness();
    h.store.setAllMailRescuePhase("copy-pending");
    expect(new OwnershipManifestStore(h.token, h.path).allMailRescuePhase()).toBe("copy-pending");

    h.store.setAllMailRescuePhase("payload-observed");
    h.store.setAllMailRescuePhase("complete");
    expect(() => h.store.setAllMailRescuePhase("copy-pending")).toThrow(/cannot move backward/i);
    expect(new OwnershipManifestStore(h.token, h.path).matches({
      folder: "All Mail",
      uid: 77,
      subject: `${h.token} not otherwise proven`,
    })).toBe(false);
  });

  it("preserves validated rescue rearm replay barriers while advancing phase", () => {
    const h = harness();
    const hash = "ab".repeat(32);
    const raw = h.store.snapshot();
    writeFileSync(h.path, JSON.stringify({
      ...raw,
      cleanup: {
        allMailRescue: "copy-pending",
        rescueRearmConsumedHashes: [hash],
      },
    }));

    const reopened = new OwnershipManifestStore(h.token, h.path);
    reopened.setAllMailRescuePhase("payload-observed");
    expect(reopened.snapshot().cleanup).toEqual({
      allMailRescue: "payload-observed",
      rescueRearmConsumedHashes: [hash],
    });
  });

  it("rejects malformed or duplicate rescue rearm replay barriers", () => {
    const h = harness();
    const raw = h.store.snapshot();
    expect(() => parseOwnershipManifest({
      ...raw,
      cleanup: {
        allMailRescue: "payload-observed",
        rescueRearmConsumedHashes: ["ab".repeat(32), "ab".repeat(32)],
      },
    }, h.token)).toThrow(/replay barriers/i);
  });

  it("limits pending draft recovery to its exact folder and tokenized subject", () => {
    const h = harness();
    const subject = `${h.token} draft`;
    h.store.beginDraft("Drafts", subject);
    expect(h.store.matches({ folder: "Drafts", uid: 4, subject })).toBe(true);
    expect(h.store.matches({ folder: "INBOX", uid: 4, subject })).toBe(false);
    expect(h.store.matches({ folder: "Drafts", uid: 4, subject: `${subject} copy` })).toBe(false);
  });

  it("fails closed on legacy bare Message-ID claims", () => {
    const h = harness();
    writeFileSync(h.path, JSON.stringify({
      version: 1,
      token: h.token,
      adoptedMessageIds: ["unproven@example.test"],
    }));
    expect(() => new OwnershipManifestStore(h.token, h.path)).toThrow(/unverified bare Message-ID/i);
    expect(() => parseOwnershipManifest({
      version: 2,
      token: h.token,
      pending: [],
      proofs: [{ kind: "message-id", messageId: "x@example.test", subject: "unscoped" }],
    }, h.token)).toThrow(/not constrained/i);
  });

  it("persists a privacy-conscious immutable mailbox baseline", () => {
    const h = harness();
    const messageId = "private-message-id@example.test";
    h.store.setBaseline({
      algorithm: "sha256",
      mailboxPaths: ["INBOX", "Drafts"],
      mailboxes: [{
        path: "INBOX",
        uidValidity: "42",
        messages: [{
          uid: 7,
          flags: ["\\Seen"],
          messageIdHash: hashOwnershipMessageId(messageId),
        }],
      }],
    });

    const durable = readFileSync(h.path, "utf8");
    expect(durable).not.toContain(messageId);
    if (process.platform !== "win32") expect(statSync(h.path).mode & 0o777).toBe(0o600);
    expect(new OwnershipManifestStore(h.token, h.path).baseline()).toMatchObject({
      algorithm: "sha256",
      mailboxPaths: ["INBOX", "Drafts"],
      mailboxes: [{ path: "INBOX", uidValidity: "42" }],
    });
    expect(() => h.store.setBaseline({
      algorithm: "sha256",
      mailboxPaths: ["INBOX"],
      mailboxes: [],
    })).toThrow(/cannot be replaced/i);
  });
});
