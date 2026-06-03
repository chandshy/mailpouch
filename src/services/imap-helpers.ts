/**
 * Pure IMAP projection/formatting helpers — the shared backbone the IMAP
 * service builds on. Kept dependency-free (no `this`, no IMAP client, no I/O) so
 * they're trivially unit-testable and reusable across getEmailById /
 * searchSingleFolder / get_thread without duplicating the parse→shape mapping.
 */

import type { ParsedMail, Attachment, AddressObject } from "mailparser";
import type { SearchObject } from "imapflow";
import type { EmailMessage, SearchEmailOptions } from "../types/index.js";

/** Strip IMAP search-unsafe characters before they reach the SEARCH command:
 *  quote/backslash (would break imapflow's quoted strings) and CR/LF/NUL (could
 *  smuggle a command line into the IMAP stream — VALID-002 / IMAP-004). */
export function sanitizeImapSearchValue(s: string): string {
  return s.replace(/["\\\r\n\x00]/g, "");
}

/**
 * Map a validated SearchEmailOptions to an imapflow SearchObject — all values
 * sanitized, the header field-name held to the RFC 5322 grammar. Pure; throws
 * only on an invalid header field name. (Was inlined in searchSingleFolder.)
 */
export function buildSearchCriteria(options: SearchEmailOptions): SearchObject {
  const c: SearchObject = {};
  if (options.from) c.from = sanitizeImapSearchValue(options.from);
  if (options.to) c.to = sanitizeImapSearchValue(options.to);
  if (options.subject) c.subject = sanitizeImapSearchValue(options.subject);
  if (options.dateFrom) {
    const d = new Date(options.dateFrom);
    if (!isNaN(d.getTime())) c.since = d;
  }
  if (options.dateTo) {
    const d = new Date(options.dateTo);
    if (!isNaN(d.getTime())) c.before = d;
  }
  // imapflow uses a single boolean: `seen:false` = unseen, etc.
  if (options.isRead !== undefined) c.seen = options.isRead;
  if (options.isStarred !== undefined) c.flagged = options.isStarred;
  if (options.body) c.body = sanitizeImapSearchValue(options.body);
  if (options.text) c.text = sanitizeImapSearchValue(options.text);
  if (options.bcc) c.bcc = sanitizeImapSearchValue(options.bcc);
  // IMAP-004: sanitize the header value AND enforce the field-name grammar so a
  // raw '"' or malformed field can't break the `SEARCH HEADER <field> <value>` syntax.
  if (options.header) {
    const field = options.header.field;
    if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(field)) {
      throw new Error(`Invalid header field name: ${JSON.stringify(field)}`);
    }
    c.header = { [field]: sanitizeImapSearchValue(options.header.value) };
  }
  if (options.answered !== undefined) c.answered = options.answered;
  if (options.isDraft !== undefined) c.draft = options.isDraft;
  if (options.larger !== undefined) c.larger = options.larger;
  if (options.smaller !== undefined) c.smaller = options.smaller;
  if (options.sentBefore) c.sentBefore = options.sentBefore;
  if (options.sentSince) c.sentSince = options.sentSince;
  return c;
}

/** Per-source-folder record of a bulk move/copy: which UIDs the server accepted,
 *  their captured Message-IDs, the UIDs UIDPLUS confirmed relocated, and whether
 *  the server returned a COPYUID map at all. */
export interface RelocationJob {
  accepted: string[];
  midMap: Map<string, string>;
  relocated: Set<string>;
  uidplus: boolean;
  /** Source folder (move only) — woven into the failure message. */
  folder?: string;
}

/**
 * Honest verified-landing check for bulk move/copy. A relocation counts as
 * success ONLY if the server's UIDPLUS COPYUID map confirmed it, or (no UIDPLUS)
 * the message's Message-ID is found in the target. Anything else is a failure —
 * never an assumed success — which is what catches the silent All-Mail-union
 * no-op (Bug A). Was duplicated verbatim in bulkMoveEmails + bulkCopyToFolder.
 */
export async function verifyRelocatedMessages(
  jobs: RelocationJob[],
  targetFolder: string,
  findMessageIdsInFolder: (folder: string, mids: string[]) => Promise<Set<string>>,
  makeError: (uid: string, sourceFolder: string | undefined) => string,
): Promise<{ success: number; failed: number; errors: string[] }> {
  const out = { success: 0, failed: 0, errors: [] as string[] };
  for (const job of jobs) {
    if (job.accepted.length === 0) continue;
    let found = new Set<string>();
    if (!job.uidplus) {
      const mids = job.accepted
        .filter((u) => !job.relocated.has(u))
        .map((u) => job.midMap.get(u))
        .filter((m): m is string => !!m);
      if (mids.length > 0) {
        try { found = await findMessageIdsInFolder(targetFolder, mids); } catch { /* unverifiable → failure below */ }
      }
    }
    for (const uid of job.accepted) {
      const mid = job.midMap.get(uid);
      if (job.relocated.has(uid) || (!job.uidplus && mid && found.has(mid))) out.success++;
      else { out.failed++; out.errors.push(makeError(uid, job.folder)); }
    }
  }
  return out;
}

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
    // Closing tags may carry trailing whitespace (`</script >`) per the HTML
    // tokenizer — match `<\/script\s*>` so the block strip can't be bypassed (CodeQL).
    .replace(/<style[^>]*>[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<script[^>]*>[\s\S]*?<\/script\s*>/gi, " ")
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
