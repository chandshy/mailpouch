/**
 * Memory scrubbing utilities for sensitive data.
 *
 * JavaScript strings are immutable and managed by V8's GC — they cannot be
 * reliably zeroed in-place. These utilities remove all application-level
 * references and overwrite Buffer contents, which prevents casual memory
 * dumps from revealing secrets. This is defense-in-depth, not a guarantee
 * against a sophisticated attacker with raw V8 heap access.
 */

import type { EmailMessage } from "../types/index.js";

// ─── SecureBuffer ─────────────────────────────────────────────────────────────

/**
 * Wraps a secret string in a Buffer so it can be deterministically zeroed.
 * Use this for credentials that need to persist in memory during the process
 * lifetime but must be wiped on shutdown.
 */
export class SecureBuffer {
  private buf: Buffer;
  private wiped = false;

  constructor(secret: string) {
    this.buf = Buffer.from(secret, "utf-8");
  }

  /** Return the secret as a string. Throws if already wiped. */
  toString(): string {
    if (this.wiped) throw new Error("SecureBuffer has been wiped");
    return this.buf.toString("utf-8");
  }

  /** Fill the underlying buffer with zeroes. */
  wipe(): void {
    if (!this.wiped) {
      this.buf.fill(0);
      this.wiped = true;
    }
  }

  get isWiped(): boolean {
    return this.wiped;
  }
}

// ─── Object wiping ────────────────────────────────────────────────────────────

/** Overwrite a string property on an object with an empty string, then delete it. */
export function wipeString(obj: any, key: string): void {
  if (obj && typeof obj[key] === "string") {
    obj[key] = "";
    delete obj[key];
  }
}

/** Wipe multiple string keys from an object. */
export function wipeObject(obj: Record<string, any>, keys: string[]): void {
  for (const key of keys) {
    wipeString(obj, key);
  }
}

// ─── Email cache wiping ───────────────────────────────────────────────────────

/** Overwrite sensitive fields in an EmailMessage. */
function scrubEmail(email: EmailMessage): void {
  if (email.body) (email as any).body = "";
  if (email.subject) (email as any).subject = "";
  if (email.from) (email as any).from = "";
  if (email.attachments) {
    for (const att of email.attachments) {
      if (att.content && Buffer.isBuffer(att.content)) {
        (att.content as Buffer).fill(0);
      }
      (att as any).content = undefined;
      (att as any).filename = "";
    }
  }
}

/** Scrub all entries in an email cache Map, then clear it. */
export function wipeEmailCache(cache: Map<string, EmailMessage>): void {
  for (const [, email] of cache) {
    scrubEmail(email);
  }
  cache.clear();
}

/** Scrub all entries in an email array, then return an empty array. */
export function wipeEmailArray(arr: EmailMessage[]): EmailMessage[] {
  for (const email of arr) {
    scrubEmail(email);
  }
  arr.length = 0;
  return [];
}
