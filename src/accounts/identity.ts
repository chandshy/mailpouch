/** Stable, non-secret identity fingerprints for account-owned state. */

import { createHash } from "crypto";
import type { AccountSpec } from "./types.js";

/**
 * Fields that identify a mailbox/transport destination. Password rotations,
 * certificate-path changes, and display-name edits intentionally do not alter
 * identity: they are operational changes to the same mailbox.
 */
function canonicalIdentity(spec: AccountSpec): string {
  return JSON.stringify({
    version: 1,
    providerType: spec.providerType,
    username: spec.username.trim().toLowerCase(),
    imapHost: spec.imapHost.trim().toLowerCase(),
    imapPort: spec.imapPort,
    smtpHost: spec.smtpHost.trim().toLowerCase(),
    smtpPort: spec.smtpPort,
    tlsMode: spec.tlsMode ?? "starttls",
  });
}

/** Opaque fingerprint safe to persist beside queued work and FTS metadata. */
export function accountIdentityFingerprint(spec: AccountSpec): string {
  return createHash("sha256").update(canonicalIdentity(spec)).digest("hex");
}

/** Whether an edit repoints an existing account ID at a different mailbox. */
export function hasMaterialAccountIdentityChange(previous: AccountSpec, next: AccountSpec): boolean {
  return accountIdentityFingerprint(previous) !== accountIdentityFingerprint(next);
}
