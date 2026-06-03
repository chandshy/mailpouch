/**
 * Pure IMAP projection/formatting helpers — the shared backbone the IMAP
 * service builds on. Kept dependency-free (no `this`, no IMAP client, no I/O) so
 * they're trivially unit-testable and reusable across getEmailById /
 * searchSingleFolder / get_thread without duplicating the parse→shape mapping.
 */

import type { ParsedMail, Attachment, AddressObject } from "mailparser";
import type { EmailMessage } from "../types/index.js";

/** Strip HTML to plain text. Decodes entities BEFORE stripping tags (PARSE-008)
 *  so encoded `&lt;script&gt;…` can't survive as literal markup, and drops HTML
 *  comments up front (PARSE-009) so their inner text doesn't leak as prose. */
export function stripHtml(html: string): string {
  if (!html) return "";
  const decodeEntities = (s: string): string =>
    s
      .replace(/&nbsp;/g, " ")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#x27;/gi, "'")
      .replace(/&#(\d{1,7});/g, (_m, d) => String.fromCodePoint(Number(d)))
      .replace(/&#x([0-9a-f]{1,6});/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&amp;/g, "&");

  return decodeEntities(html.replace(/<!--[\s\S]*?-->/g, " "))
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Truncate a body to `maxLength`, breaking on a word boundary when close. */
export function truncateBody(body: string, maxLength = 300): string {
  if (!body) return "";
  const cleaned = body.replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxLength) return cleaned;
  const truncated = cleaned.substring(0, maxLength);
  const lastSpace = truncated.lastIndexOf(" ");
  if (lastSpace > maxLength * 0.8) return truncated.substring(0, lastSpace) + "...";
  return truncated + "...";
}

/** Flatten a mailparser address field into display strings. IMAP-007: the field
 *  can be a single AddressObject OR an array (multiple `To:` header lines, legal
 *  per RFC 5322 §3.6.3 and emitted by Proton on bridged forwards). */
export function normalizeAddressList(
  field: AddressObject | AddressObject[] | undefined,
): string[] {
  if (!field) return [];
  const objs = Array.isArray(field) ? field : [field];
  const result: string[] = [];
  for (const obj of objs) if (obj?.text) result.push(obj.text);
  return result;
}

/** The minimal shape of an imapflow fetch result `buildEmailMessage` reads. */
export interface FetchedMessageShape {
  uid: number;
  flags?: Set<string>;
}

/**
 * Project a fully-parsed message (mailparser `ParsedMail` + the imapflow fetch
 * envelope's uid/flags) into the canonical `EmailMessage`. This is the single
 * source of truth for the parse→shape mapping used by getEmailById and
 * searchSingleFolder (was duplicated verbatim in both).
 */
export function buildEmailMessage(
  message: FetchedMessageShape,
  parsed: ParsedMail,
  folderPath: string,
): EmailMessage {
  const fullBody = parsed.text || parsed.html || "";
  const plainBody = parsed.text || stripHtml(parsed.html || "");

  const contentType = parsed.headers?.get("content-type");
  const ctStr =
    typeof contentType === "string"
      ? contentType
      : ((contentType as unknown as { value?: string } | null)?.value ?? "");

  const pmId = parsed.headers?.get("x-pm-internal-id");

  return {
    id: message.uid.toString(),
    from: parsed.from?.text || "",
    to: normalizeAddressList(parsed.to),
    cc: normalizeAddressList(parsed.cc),
    subject: parsed.subject || "(No Subject)",
    body: fullBody,
    bodyPreview: truncateBody(plainBody),
    isHtml: !!parsed.html,
    date: parsed.date || new Date(),
    folder: folderPath,
    isRead: message.flags?.has("\\Seen") || false,
    isStarred: message.flags?.has("\\Flagged") || false,
    hasAttachment: (parsed.attachments?.length || 0) > 0,
    attachments: parsed.attachments?.map((att: Attachment) => ({
      filename: att.filename || "unnamed",
      contentType: att.contentType,
      size: att.size,
      content: att.content,
      contentId: att.cid,
    })),
    headers: parsed.headers
      ? Object.fromEntries(
          Array.from(parsed.headers.entries()).map(([k, v]) => [
            k,
            Array.isArray(v) ? v.join(", ") : String(v),
          ]),
        )
      : undefined,
    inReplyTo: parsed.inReplyTo,
    references: parsed.references,
    isAnswered: message.flags?.has("\\Answered") ?? false,
    isForwarded: message.flags?.has("\\Forward") ?? false,
    isSignedPGP: ctStr.includes("multipart/signed") && ctStr.includes("application/pgp-signature"),
    isEncryptedPGP: ctStr.includes("multipart/encrypted") && ctStr.includes("application/pgp-encrypted"),
    protonId: typeof pmId === "string" ? pmId.trim() : undefined,
    messageId: parsed.messageId || undefined,
  };
}
