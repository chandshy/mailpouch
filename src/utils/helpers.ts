/**
 * Helper utilities for mailpouch
 */

import { randomUUID } from "crypto";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { logger } from "./logger.js";
import type { EmailAttachment } from "../types/index.js";

/**
 * Shared attachment caps. The SMTP send path (smtp-service.ts) and the IMAP
 * draft path (simple-imap-service.ts) MUST enforce the same limits — VALID-005
 * tracked the asymmetry where saveDraft mirrored sanitisation but not the caps.
 * Bytes match Proton's own 25 MB per-message limit.
 */
export const MAX_ATTACHMENT_COUNT = 20;
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/**
 * Per-token cap for `parseEmails` (VALID-010). RFC 5321 caps a full address at
 * 320 chars; 1024 leaves generous room for a `Display Name <addr>` token while
 * keeping the regex off multi-kilobyte inputs.
 */
export const MAX_ADDRESS_TOKEN = 1024;

/**
 * Best-effort decoded byte size of an attachment `content` value.
 * base64 strings decode to ~3/4 of their character length; Buffers are exact.
 * Returns `null` for anything that is neither (e.g. a Readable stream), which
 * callers treat as "unsizable → reject".
 */
export function attachmentByteSize(content: unknown): number | null {
  if (Buffer.isBuffer(content)) return content.length;
  if (typeof content === "string") return Math.ceil(content.length * 0.75);
  return null;
}

/**
 * Validate email address format.
 *
 * Enforces RFC 5321 length limits in addition to structural checks:
 *   • Total address: max 320 characters
 *   • Local part (before @): max 64 characters
 *   • Domain (after @): max 253 characters
 *
 * An unbounded regex check alone allowed multi-kilobyte "addresses" to pass,
 * risking header bloat and downstream OOM in MIME parsers.
 */
export function isValidEmail(email: string): boolean {
  // Reject control characters before anything else (prevents null-byte bypass).
  if (/[\x00-\x1f\x7f]/.test(email)) return false;

  // RFC 5321 § 4.5.3.1 length limits.
  if (email.length > 320) return false;
  const atIdx = email.indexOf("@");
  if (atIdx < 1) return false;                   // no local part
  const localPart = email.slice(0, atIdx);
  const domain    = email.slice(atIdx + 1);
  if (localPart.length > 64)  return false;
  if (domain.length > 253)    return false;
  if (domain.length === 0)    return false;

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

/**
 * Parse comma-separated email addresses, returning both the valid addresses and
 * the raw segments that were dropped as invalid.
 *
 * SMTP-014: the original `parseEmails` silently discarded malformed addresses,
 * so a caller submitting "alice@x.com, bogus, bob@y.com" proceeded with two
 * recipients and no signal that one was dropped. This detailed form lets the
 * SMTP layer surface partial-failure to the caller instead of quietly sending
 * to fewer recipients than intended.
 */
export function parseEmailsDetailed(emailString: string): { valid: string[]; dropped: string[] } {
  if (!emailString || emailString.trim() === "") {
    return { valid: [], dropped: [] };
  }

  const valid: string[] = [];
  const dropped: string[] = [];
  for (const raw of emailString.split(",")) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    // VALID-010: reject pathologically long tokens before running the regex.
    // RFC 5321 caps a full address at 320 chars; allow generous room for a
    // display name but cap so a multi-MB token can't be fed to the matcher.
    if (trimmed.length > MAX_ADDRESS_TOKEN) {
      logger.warn("parseEmails: dropping over-length address token", "helpers", { length: trimmed.length });
      continue;
    }
    // Support "Display Name <email@domain.com>" format by extracting the angle-bracket part.
    // Anchored to reject multiple/nested brackets: "Name <<x>>" or "a> <b".
    const angleMatch = trimmed.match(/^[^<>]*<([^<>]+)>$/);
    const candidate = angleMatch ? angleMatch[1].trim() : trimmed;
    if (isValidEmail(candidate)) {
      valid.push(candidate);
    } else {
      dropped.push(trimmed);
      logger.warn("parseEmailsDetailed: dropping invalid address", "helpers", { address: sanitizeForLog(trimmed, 80) });
    }
  }
  return { valid, dropped };
}

/**
 * Parse comma-separated email addresses.
 * Invalid or malformed addresses are skipped; a warning is logged for each
 * so that callers can detect misconfigured CC/BCC lists without hard-failing.
 */
export function parseEmails(emailString: string): string[] {
  return parseEmailsDetailed(emailString).valid;
}

/**
 * Format date to ISO string
 */
export function formatDate(date: Date): string {
  return date.toISOString();
}

/**
 * Parse date from string
 */
export function parseDate(dateString: string): Date {
  return new Date(dateString);
}

/**
 * Format bytes to human-readable size
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 Bytes";

  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

/**
 * Convert bytes to megabytes
 */
export function bytesToMB(bytes: number): number {
  return parseFloat((bytes / (1024 * 1024)).toFixed(2));
}

/**
 * Sanitize string for safe logging.
 *
 * Strips the full C0/C1 control-character set (U+0000–U+001F and U+007F)
 * before truncating.  Only stripping [\r\n\t] left 24 other control characters
 * (backspace, form-feed, vertical-tab, ESC, etc.) available for log injection
 * or terminal-escape attacks.
 */
export function sanitizeForLog(str: string, maxLength: number = 100): string {
  if (!str) return "";

  // Replace every C0/C1 control character with a space (consistent with the
  // CONTROL_CHARS_RE used in security.ts sanitizeText).
  let sanitized = str.replace(/[\x00-\x1f\x7f]/g, " ").trim();

  if (sanitized.length > maxLength) {
    sanitized = sanitized.substring(0, maxLength) + "...";
  }

  return sanitized;
}

/**
 * Extract email address from "Name <email@domain.com>" format
 */
export function extractEmailAddress(emailString: string): string {
  // PARSE-020: take the LAST angle-bracket pair, not the first one found
  // anywhere. A hostile header like `<bogus> "Alice" <real@x.com>` previously
  // returned `bogus` (first `<...>`) and poisoned the contact map; the real
  // address is conventionally the trailing `<addr>` segment.
  const lastOpen = emailString.lastIndexOf("<");
  if (lastOpen !== -1) {
    const close = emailString.indexOf(">", lastOpen + 1);
    if (close !== -1) {
      const inner = emailString.slice(lastOpen + 1, close).trim();
      if (inner) return inner;
    }
  }
  return emailString.trim();
}

/**
 * Extract name from "Name <email@domain.com>" format
 */
export function extractName(emailString: string): string | undefined {
  const match = emailString.match(/^([^<]+)</);
  return match ? match[1].trim() : undefined;
}

/**
 * Sleep/delay function
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry function with exponential backoff
 */
export async function retry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  delayMs: number = 1000
): Promise<T> {
  let lastError: unknown;

  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error: unknown) {
      lastError = error;
      if (i < maxRetries - 1) {
        await sleep(delayMs * Math.pow(2, i));
      }
    }
  }

  throw lastError;
}

/**
 * Generate unique ID using cryptographically secure randomness
 */
export function generateId(): string {
  return randomUUID();
}

/**
 * Control-character class rejected by every text-shape validator: the full
 * C0 range (U+0000–U+001F), DEL (U+007F), and the C1 range (U+0080–U+009F).
 * VALID-007: the old `/[\x00-\x1f]/` let DEL and C1 through; this matches the
 * CONTROL_CHARS_RE documented in settings/security.ts sanitizeText.
 */
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f\x80-\x9f]/;

/**
 * Validate a single IMAP name segment (a "leaf") before it is composed into a
 * path such as `Labels/<name>` or `Folders/<name>`. Shared by
 * `validateLabelName` and `validateFolderName` so the rules can't drift
 * (VALID-004 — the two were byte-identical duplicates).
 *
 * Returns `null` on success or an error message string on failure. Rules:
 *   - Must be a non-empty string after trimming
 *   - Must not contain `/` (path separator) or `..` (traversal)
 *   - Must not contain C0/C1 control characters or DEL
 *   - Must not exceed 255 characters
 */
export function validateLeafName(value: unknown, fieldName: string): string | null {
  if (!value || typeof value !== "string" || !value.trim()) {
    return `${fieldName} must be a non-empty string.`;
  }
  if (value.includes("/") || value.includes("..") || CONTROL_CHARS_RE.test(value)) {
    return `${fieldName} contains invalid characters (/, .., or control characters).`;
  }
  if (value.length > 255) {
    return `${fieldName} exceeds maximum length of 255 characters.`;
  }
  return null;
}

/**
 * Validate a label name before constructing an IMAP path (e.g. `Labels/<name>`).
 * Returns `null` on success or an error message string on failure.
 *
 * Note (VALID-019): a non-ASCII leaf like `Wörk` is accepted here but imapflow
 * encodes it to modified UTF-7 (`W&APY-rk`) on the wire, so the IMAP-stored
 * name differs from the in-memory key. Callers that use the label as a map key
 * must re-list to learn the encoded name.
 */
export function validateLabelName(label: unknown): string | null {
  return validateLeafName(label, "label");
}

/**
 * Validate a folder name before constructing an IMAP path (e.g. `Folders/<name>`).
 * Returns `null` on success or an error message string on failure.
 * The folder name is the leaf segment only; the `Folders/` prefix is added by
 * the caller.
 */
export function validateFolderName(folder: unknown): string | null {
  return validateLeafName(folder, "folder");
}

/**
 * Validate a `targetFolder` argument used as a direct IMAP path (not prefixed).
 *
 * Returns `null` on success or an error message string on failure.
 * Unlike validateLabelName/validateFolderName, a forward slash IS allowed here
 * since the full path may include separators (e.g. `Folders/Work`).
 * Rejects `..` (traversal) and C0 control characters.
 * Max length 1000 characters.
 */
export function validateTargetFolder(targetFolder: unknown): string | null {
  // VALID-017: empty/omitted is intentionally NOT an error here — it signals
  // "caller falls back to a default (e.g. INBOX)". Folder-MUTATING tools that
  // require a concrete name must use `validateRequiredTargetFolder` instead, or
  // an empty string would silently reach imapflow.
  if (targetFolder === undefined || targetFolder === null || targetFolder === "") {
    return null; // omitted/empty — caller uses a default (e.g. INBOX)
  }
  if (typeof targetFolder !== "string") {
    return "targetFolder must be a string.";
  }
  // VALID-007: reject the full C0/C1+DEL control range, not just C0.
  if (CONTROL_CHARS_RE.test(targetFolder) || targetFolder.includes("..")) {
    return "targetFolder contains invalid characters (.. or control characters).";
  }
  // VALID-014: 1000 is the single full-path bound. A multi-segment path may
  // exceed any single 255-char leaf cap; the per-leaf validators enforce 255
  // on the segments that callers compose, this caps the assembled path.
  if (targetFolder.length > 1000) {
    return "targetFolder exceeds maximum length of 1000 characters.";
  }
  return null;
}

/**
 * Like `validateTargetFolder` but REQUIRES a non-empty (after trim) name.
 *
 * VALID-011: folder-mutating tools (`create_folder`/`delete_folder`/
 * `rename_folder`) always need a concrete name, so the empty-string fall-back
 * semantics of `validateTargetFolder` are wrong for them. Each handler used to
 * repeat its own `!args.folderName || ...trim()` guard with subtly different
 * shapes; this centralises it. Returns the trimmed value on success or throws
 * `McpError(InvalidParams, …)`.
 */
export function validateRequiredTargetFolder(raw: unknown, fieldName: string = "folderName"): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new McpError(ErrorCode.InvalidParams, `${fieldName} is required and must be a non-empty string.`);
  }
  const trimmed = raw.trim();
  const err = validateTargetFolder(trimmed);
  if (err) {
    const cleaned = err.replace(/^targetFolder\s*/, "");
    throw new McpError(ErrorCode.InvalidParams, `Invalid ${fieldName}: ${cleaned}`);
  }
  return trimmed;
}

/**
 * Validate an IMAP folder *path* (full path, separators allowed) before it is
 * serialised into an IMAP command literal. Unlike the leaf-only
 * `validateFolderName`/`validateLabelName`, a forward slash IS permitted here
 * because the value is a complete path (e.g. `Folders/Work`).
 *
 * Returns `null` on success or an error message string on failure. Rules:
 *   - Must be a non-empty string after trimming
 *   - Must not contain `..` (path traversal)
 *   - Must not contain C0 control characters (U+0000–U+001F)
 *   - Must not exceed 1000 characters
 *
 * VALID-003: single source of truth for the full-path check. The IMAP service's
 * private `validateFolderName(name)` delegates here (rethrowing the message as
 * an Error) so the two no longer diverge.
 */
export function validateImapPath(path: unknown): string | null {
  if (!path || typeof path !== "string" || !path.trim()) {
    return "folder path must be a non-empty string.";
  }
  // VALID-012: reject leading/trailing whitespace rather than silently
  // accepting a path that selects a different mailbox than the visible name
  // (e.g. " INBOX" vs "INBOX"). The IMAP modified-UTF-7 `&` escape is left
  // intact since legitimate encoded folder names contain it.
  if (path !== path.trim()) {
    return "folder path must not have leading or trailing whitespace.";
  }
  // VALID-007: reject the full C0/C1+DEL control range, not just C0.
  if (path.includes("..") || CONTROL_CHARS_RE.test(path)) {
    return "folder path contains invalid characters (.. or control characters).";
  }
  if (path.length > 1000) {
    return "folder path exceeds maximum length of 1000 characters.";
  }
  return null;
}

/**
 * Truncate text to a maximum length, appending "..." when truncated.
 *
 * @param text - The string to truncate.
 * @param maxLength - Maximum number of characters (including the 3-char ellipsis).
 *   Must be greater than 3 for the ellipsis to fit; strings shorter than or
 *   equal to maxLength are returned unchanged.
 */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + "...";
}

/**
 * Assert that `raw` is a non-empty, all-digit string suitable for use as an
 * IMAP UID.  Returns the validated string on success or throws an
 * `McpError(InvalidParams, …)` on failure.
 *
 * Centralises the repeated guard pattern found across ~12 tool handlers:
 *
 * ```ts
 * if (!X || typeof X !== "string" || !/^\d+$/.test(X)) {
 *   throw new McpError(ErrorCode.InvalidParams, "emailId must be a non-empty numeric UID string.");
 * }
 * ```
 *
 * @param raw       - The raw argument value from the MCP tool call (type `unknown`).
 * @param fieldName - The argument field name used in the error message, e.g. `"emailId"`.
 *                    Defaults to `"emailId"`.
 * @returns The validated UID string.
 * @throws {McpError} with `ErrorCode.InvalidParams` when validation fails.
 */
export function requireNumericEmailId(raw: unknown, fieldName: string = "emailId"): string {
  // VALID-008: IMAP UIDs are 32-bit unsigned (max 4294967295 = 10 digits).
  // Reject leading zeros (except the literal "0") and over-length strings so a
  // thousand-digit "UID" can't burn log space / Bridge round-trips. `^\d+$`
  // alone admitted "0000001" and arbitrarily long numeric strings.
  if (!raw || typeof raw !== "string" || !/^(0|[1-9]\d{0,9})$/.test(raw)) {
    throw new McpError(ErrorCode.InvalidParams, `${fieldName} must be a non-empty numeric UID string.`);
  }
  // 10 digits still admits up to 9999999999, beyond the 32-bit unsigned max.
  // Enforce the real ceiling so an out-of-range "UID" can't reach the Bridge.
  if (Number(raw) > 4294967295) {
    throw new McpError(ErrorCode.InvalidParams, `${fieldName} exceeds the maximum IMAP UID (4294967295).`);
  }
  return raw;
}

/**
 * Validate an optional `folder` argument that flows from a tool handler into
 * `imapService.getEmailById` (or similar service methods that take a folder
 * hint). Returns the validated folder string when present; returns undefined
 * for `undefined`/`null`/empty-string; throws `McpError(InvalidParams, …)`
 * for non-strings or invalid IMAP paths (CRLF / control chars / `..`).
 *
 * Closes VALID-001 / VALID-009 from the 2026-05-28 audit — the by-id reading
 * tools (`get_email_by_id`, `get_thread`, `extract_action_items`,
 * `extract_meeting`, `reply_to_email`, `forward_email`) were forwarding
 * `args.folder` raw via `as string | undefined` casts.
 */
export function optionalFolderHint(raw: unknown, fieldName: string = "folder"): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") {
    throw new McpError(ErrorCode.InvalidParams, `'${fieldName}' must be a string when provided.`);
  }
  // Trim and treat whitespace-only as "not provided" — otherwise '   ' passes
  // `validateTargetFolder()` and reaches `getEmailById()` only to be rejected
  // with a generic Error("Folder name must not be empty") from the service
  // layer, defeating the McpError(InvalidParams) shape the gate gives.
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const err = validateTargetFolder(trimmed);
  if (err) {
    // Rewrite the validator's `targetFolder ...` prefix so the error reads
    // as the caller's own field name, not the helper's internal vocabulary.
    const cleaned = err.replace(/^targetFolder\s+/, "").replace(/^targetFolder/, "");
    throw new McpError(ErrorCode.InvalidParams, `Invalid ${fieldName}: ${cleaned}`);
  }
  return trimmed;
}

/**
 * Validate an optional `sourceFolder` argument — the full IMAP path the
 * UID(s) live in (e.g. `Folders/Work`, `Labels/Foo`). Uses the full-path
 * validator (`validateTargetFolder`) so embedded `/` is allowed. Returns the
 * value when present, `undefined` for omitted/empty/null, and throws
 * `McpError(InvalidParams, …)` otherwise.
 *
 * VALID-021: previously defined byte-for-byte in both `tools/actions.ts` and
 * `tools/deletion.ts`; consolidated here so the two can't drift.
 */
export function optionalSourceFolder(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string") {
    throw new McpError(ErrorCode.InvalidParams, "'sourceFolder' must be a string when provided.");
  }
  // Validate with the same validator the service layer uses (validateFolderName
  // delegates to validateImapPath) so the tool gate and the service agree —
  // e.g. " INBOX" is rejected here with a clean McpError instead of passing the
  // gate and failing later with a non-McpError shape.
  const err = validateImapPath(raw);
  if (err) throw new McpError(ErrorCode.InvalidParams, `Invalid sourceFolder: ${err}`);
  return raw;
}

/**
 * Coerce an optional numeric tool argument into a finite integer clamped to
 * `[min, max]`, returning `fallback` when the value is absent or non-finite.
 *
 * Centralises the numeric-hygiene pattern that several tool handlers got
 * subtly wrong (TOOL-003/004/005/006/009 in the 2026-05-28 audit):
 *   - `(args.x as number) || dflt` lets a truthy negative (`-50`) through.
 *   - `typeof x === "number"` passes `NaN`/`Infinity`, which then survive
 *     `Math.min(Math.max(1, NaN), cap)` as `NaN` and reach the service/wire.
 *
 * `NaN`, `Infinity`, `-Infinity`, and non-number types all collapse to
 * `fallback`; finite values are truncated toward zero, then clamped.
 *
 * @param raw      - Raw argument value from the MCP tool call (type `unknown`).
 * @param fallback - Value used when `raw` is absent or non-finite.
 * @param min      - Inclusive lower bound after coercion.
 * @param max      - Inclusive upper bound after coercion.
 */
export function clampOptionalInt(
  raw: unknown,
  fallback: number,
  min: number,
  max: number
): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return Math.min(Math.max(min, fallback), max);
  }
  return Math.min(Math.max(min, Math.trunc(raw)), max);
}

/**
 * Require a non-empty (after trim) string tool argument. Returns the trimmed
 * value on success or throws `McpError(InvalidParams, …)`. Used for fields
 * where an empty string would reach an upstream API and yield an opaque 4xx
 * (TOOL-007: `aliasPrefix`/`signedSuffix`; TOOL-002: `reason`).
 */
export function requireNonEmptyString(raw: unknown, fieldName: string): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new McpError(ErrorCode.InvalidParams, `${fieldName} is required and must be a non-empty string.`);
  }
  return raw.trim();
}

/**
 * Validate the shape of an `attachments` argument before passing it to a service.
 *
 * Each element must be a plain object with:
 *   - `filename`: a non-empty string
 *   - `content`: a string (base64) or Buffer
 *   - `contentType`: optional — if present, must be a string
 *
 * The service layer performs deeper sanitization (MIME-type format, CRLF
 * stripping, size limits).  This guard only ensures the handler receives
 * structurally valid objects so that service-layer errors are not confusingly
 * attributed to malformed inputs.
 *
 * @param attachments - Raw value of `args.attachments` from the tool call.
 * @returns `null` on success, or an error message string describing the problem.
 */
export function validateAttachments(attachments: unknown): string | null {
  if (attachments === undefined || attachments === null) {
    return null; // omitted — fine, attachments are optional
  }
  if (!Array.isArray(attachments)) {
    return "attachments must be an array.";
  }
  if (attachments.length > MAX_ATTACHMENT_COUNT) {
    return `attachments must not exceed ${MAX_ATTACHMENT_COUNT} items.`;
  }
  let totalBytes = 0;
  for (let i = 0; i < attachments.length; i++) {
    const att = attachments[i];
    if (!att || typeof att !== "object" || Array.isArray(att)) {
      return `attachments[${i}] must be an object.`;
    }
    const { filename, content, contentType } = att as Record<string, unknown>;
    if (!filename || typeof filename !== "string") {
      return `attachments[${i}].filename must be a non-empty string.`;
    }
    // VALID-018: the SMTP/IMAP layers scrub CRLF/traversal later, but reject
    // path separators and control chars here so `../../../etc/passwd` and the
    // like never reach a layer that might interpret them.
    if (filename.includes("/") || filename.includes("\\") || filename.includes("..") || CONTROL_CHARS_RE.test(filename)) {
      return `attachments[${i}].filename must not contain path separators, '..', or control characters.`;
    }
    if (filename.length > 255) {
      return `attachments[${i}].filename exceeds maximum length of 255 characters.`;
    }
    if (content === undefined || content === null || (typeof content !== "string" && !Buffer.isBuffer(content))) {
      return `attachments[${i}].content must be a base64 string or Buffer.`;
    }
    if (contentType !== undefined && typeof contentType !== "string") {
      return `attachments[${i}].contentType must be a string when provided.`;
    }
    // VALID-006: cap per-file and aggregate content size so an unbounded base64
    // payload can't OOM the process before it reaches the service layer.
    const bytes = attachmentByteSize(content);
    if (bytes === null) {
      return `attachments[${i}].content must be a base64 string or Buffer.`;
    }
    if (bytes > MAX_ATTACHMENT_BYTES) {
      return `attachments[${i}] is too large: ${Math.round(bytes / 1024 / 1024)}MB exceeds the ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB per-file limit.`;
    }
    totalBytes += bytes;
    if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
      return `total attachment size exceeds the ${MAX_TOTAL_ATTACHMENT_BYTES / 1024 / 1024}MB limit.`;
    }
  }
  return null;
}

/**
 * Service-layer attachment LIMIT check (count + per-file + total size) — shared
 * by the SMTP send path and the IMAP saveDraft path. Both enforce the caps even
 * though the tool layer's {@link validateAttachments} already did (VALID-005/006:
 * defense in depth, so an unbounded base64 payload can't OOM the process before
 * it reaches the wire). Operates on already-structured attachments (assumes the
 * shape {@link validateAttachments} guarantees); returns an error string or null.
 */
export function validateAttachmentLimits(
  attachments: ReadonlyArray<{ filename?: string; content?: unknown }>,
): string | null {
  if (attachments.length > MAX_ATTACHMENT_COUNT) {
    return `Too many attachments: ${attachments.length} supplied, max ${MAX_ATTACHMENT_COUNT} allowed.`;
  }
  let totalBytes = 0;
  for (const att of attachments) {
    const name = att.filename ?? "unnamed";
    const bytes = attachmentByteSize(att.content);
    if (bytes === null) {
      return `Attachment '${name}': content must be a Buffer or base64 string.`;
    }
    if (bytes > MAX_ATTACHMENT_BYTES) {
      return `Attachment '${name}' is too large: ${Math.round(bytes / 1024 / 1024)}MB exceeds the ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB per-file limit.`;
    }
    totalBytes += bytes;
    if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
      return `Total attachment size exceeds the ${MAX_TOTAL_ATTACHMENT_BYTES / 1024 / 1024}MB limit.`;
    }
  }
  return null;
}

/**
 * Coerce a raw `args.attachments` value into a clean `EmailAttachment[]` that
 * carries ONLY the known fields. VALID-015: tools previously did
 * `args.attachments as EmailAttachment[]`, which let attacker-controlled extra
 * keys (e.g. nodemailer's `path`, `href`, `raw`, `encoding`) ride through to
 * the mailer — `path` in particular makes nodemailer read a file from disk.
 *
 * Call AFTER `validateAttachments` has returned null. Returns `undefined` when
 * the input is absent so optional-attachment call sites stay unchanged.
 */
export function sanitizeAttachments(attachments: unknown): EmailAttachment[] | undefined {
  if (attachments === undefined || attachments === null) return undefined;
  if (!Array.isArray(attachments)) return undefined;
  return attachments.map((raw) => {
    const att = raw as Record<string, unknown>;
    const out: EmailAttachment = {
      filename: att.filename as string,
      content: att.content as string | Buffer,
      // contentType/size are part of EmailAttachment; size is metadata only and
      // not used on the send/draft paths, so default it to 0 when absent.
      contentType: typeof att.contentType === "string" ? att.contentType : "",
      size: typeof att.size === "number" ? att.size : 0,
    };
    if (typeof att.contentId === "string") out.contentId = att.contentId;
    return out;
  });
}
