/**
 * Helper utilities for mailpouch
 */

import { randomUUID } from "crypto";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { logger } from "./logger.js";

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
 * Parse comma-separated email addresses.
 * Invalid or malformed addresses are skipped; a warning is logged for each
 * so that callers can detect misconfigured CC/BCC lists without hard-failing.
 */
export function parseEmails(emailString: string): string[] {
  if (!emailString || emailString.trim() === "") {
    return [];
  }

  const valid: string[] = [];
  for (const raw of emailString.split(",")) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    if (isValidEmail(trimmed)) {
      valid.push(trimmed);
    } else {
      logger.warn("parseEmails: dropping invalid address", "helpers", { address: sanitizeForLog(trimmed, 80) });
    }
  }
  return valid;
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
  const match = emailString.match(/<([^>]+)>/);
  return match ? match[1] : emailString.trim();
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
 * Validate a label name before constructing an IMAP path (e.g. `Labels/<name>`).
 *
 * Returns `null` on success or an error message string on failure.
 * Rules mirror those used in `move_to_label`:
 *   - Must be a non-empty string after trimming
 *   - Must not contain `/` (path separator) or `..` (traversal)
 *   - Must not contain C0 control characters (U+0000–U+001F)
 *   - Must not exceed 255 characters
 */
export function validateLabelName(label: unknown): string | null {
  if (!label || typeof label !== "string" || !label.trim()) {
    return "label must be a non-empty string.";
  }
  if (label.includes("/") || label.includes("..") || /[\x00-\x1f]/.test(label)) {
    return "label contains invalid characters (/, .., or control characters).";
  }
  if (label.length > 255) {
    return "label exceeds maximum length of 255 characters.";
  }
  return null;
}

/**
 * Validate a folder name before constructing an IMAP path (e.g. `Folders/<name>`).
 *
 * Returns `null` on success or an error message string on failure.
 * Same rules as validateLabelName — the folder name is the leaf segment only;
 * the `Folders/` prefix is added by the caller.
 */
export function validateFolderName(folder: unknown): string | null {
  if (!folder || typeof folder !== "string" || !folder.trim()) {
    return "folder must be a non-empty string.";
  }
  if (folder.includes("/") || folder.includes("..") || /[\x00-\x1f]/.test(folder)) {
    return "folder contains invalid characters (/, .., or control characters).";
  }
  if (folder.length > 255) {
    return "folder exceeds maximum length of 255 characters.";
  }
  return null;
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
  if (targetFolder === undefined || targetFolder === null || targetFolder === "") {
    return null; // omitted/empty — caller uses a default (e.g. INBOX)
  }
  if (typeof targetFolder !== "string") {
    return "targetFolder must be a string.";
  }
  if (/[\x00-\x1f]/.test(targetFolder) || targetFolder.includes("..")) {
    return "targetFolder contains invalid characters (.. or control characters).";
  }
  if (targetFolder.length > 1000) {
    return "targetFolder exceeds maximum length of 1000 characters.";
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
  if (!raw || typeof raw !== "string" || !/^\d+$/.test(raw)) {
    throw new McpError(ErrorCode.InvalidParams, `${fieldName} must be a non-empty numeric UID string.`);
  }
  return raw;
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
  for (let i = 0; i < attachments.length; i++) {
    const att = attachments[i];
    if (!att || typeof att !== "object" || Array.isArray(att)) {
      return `attachments[${i}] must be an object.`;
    }
    const { filename, content, contentType } = att as Record<string, unknown>;
    if (!filename || typeof filename !== "string") {
      return `attachments[${i}].filename must be a non-empty string.`;
    }
    if (content === undefined || content === null || (typeof content !== "string" && !Buffer.isBuffer(content))) {
      return `attachments[${i}].content must be a base64 string or Buffer.`;
    }
    if (contentType !== undefined && typeof contentType !== "string") {
      return `attachments[${i}].contentType must be a string when provided.`;
    }
  }
  return null;
}
