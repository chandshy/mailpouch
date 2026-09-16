/**
 * Memory scrubbing for cached mail.
 *
 * JavaScript strings are immutable and managed by V8's GC — they cannot be
 * reliably zeroed in-place. Scrubbing drops application-level references and
 * zeroes attachment Buffers, which keeps casual memory dumps from revealing
 * mail content. Defense-in-depth, not a guarantee against raw heap access.
 */

import type { EmailMessage } from "../types/index.js";

/** Overwrite sensitive fields in an EmailMessage. */
export function scrubEmail(email: EmailMessage): void {
  if (email.body) email.body = "";
  if (email.subject) email.subject = "";
  if (email.from) email.from = "";
  if (email.attachments) {
    for (const att of email.attachments) {
      if (att.content && Buffer.isBuffer(att.content)) {
        (att.content as Buffer).fill(0);
      }
      att.content = undefined;
      att.filename = "";
    }
  }
}
