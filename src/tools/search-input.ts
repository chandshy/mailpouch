/**
 * Validation + normalization for the `search_emails` tool args. Extracted from
 * the handler so the ~110 LOC of input checks (type/length/range; VALID-002
 * length caps; TOOL-016 byte predicates; TOOL-017 parseable dates) live in one
 * testable place instead of crowding the handler. Throws McpError(InvalidParams)
 * on any malformed input; returns a ready-to-use SearchEmailOptions.
 */

import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { validateTargetFolder } from "../utils/helpers.js";
import type { SearchEmailOptions } from "../types/index.js";

const MAX_SEARCH_TEXT = 500;

export function validateSearchInput(
  args: Record<string, unknown>,
  maxEmailListResults: number,
): SearchEmailOptions {
  const folder = (args.folder as string) || "INBOX";
  // Runtime-guard the array cast: a client passing folders:"INBOX" (string)
  // would otherwise iterate per-character into validateTargetFolder; folders:{}
  // would silently fall through with folders.length === undefined (TOOL-001).
  if (args.folders !== undefined && !Array.isArray(args.folders)) {
    throw new McpError(ErrorCode.InvalidParams, "'folders' must be an array of folder paths when provided.");
  }
  const folders = args.folders as string[] | undefined;
  if (!folders) {
    const seFolderErr = validateTargetFolder(folder);
    if (seFolderErr) throw new McpError(ErrorCode.InvalidParams, `folder: ${seFolderErr}`);
  }
  if (folders && !(folders.length === 1 && folders[0] === "*")) {
    for (let i = 0; i < folders.length; i++) {
      const fErr = validateTargetFolder(folders[i]);
      if (fErr) throw new McpError(ErrorCode.InvalidParams, `folders[${i}]: ${fErr}`);
    }
  }
  if (args.from !== undefined && typeof args.from !== "string") {
    throw new McpError(ErrorCode.InvalidParams, "'from' filter must be a string when provided.");
  }
  if (args.from && (args.from as string).length > MAX_SEARCH_TEXT) {
    throw new McpError(ErrorCode.InvalidParams, `'from' filter must not exceed ${MAX_SEARCH_TEXT} characters.`);
  }
  if (args.to !== undefined && typeof args.to !== "string") {
    throw new McpError(ErrorCode.InvalidParams, "'to' filter must be a string when provided.");
  }
  if (args.to && (args.to as string).length > MAX_SEARCH_TEXT) {
    throw new McpError(ErrorCode.InvalidParams, `'to' filter must not exceed ${MAX_SEARCH_TEXT} characters.`);
  }
  if (args.subject !== undefined && typeof args.subject !== "string") {
    throw new McpError(ErrorCode.InvalidParams, "'subject' filter must be a string when provided.");
  }
  if (args.subject && (args.subject as string).length > MAX_SEARCH_TEXT) {
    throw new McpError(ErrorCode.InvalidParams, `'subject' filter must not exceed ${MAX_SEARCH_TEXT} characters.`);
  }
  if (args.hasAttachment !== undefined && typeof args.hasAttachment !== "boolean") {
    throw new McpError(ErrorCode.InvalidParams, "'hasAttachment' must be a boolean when provided.");
  }
  if (args.isRead !== undefined && typeof args.isRead !== "boolean") {
    throw new McpError(ErrorCode.InvalidParams, "'isRead' must be a boolean when provided.");
  }
  if (args.isStarred !== undefined && typeof args.isStarred !== "boolean") {
    throw new McpError(ErrorCode.InvalidParams, "'isStarred' must be a boolean when provided.");
  }
  if (args.limit !== undefined && typeof args.limit !== "number") {
    throw new McpError(ErrorCode.InvalidParams, "'limit' must be a number.");
  }
  // TOOL-017: dateFrom/dateTo must be a string AND parseable when provided — same
  // contract as sentBefore/sentSince below. The old type-only check let
  // {dateFrom:"not-a-date"} pass through and be silently dropped downstream.
  if (args.dateFrom !== undefined &&
      (typeof args.dateFrom !== "string" || Number.isNaN(Date.parse(args.dateFrom)))) {
    throw new McpError(ErrorCode.InvalidParams, "'dateFrom' must be a parseable date string when provided.");
  }
  if (args.dateTo !== undefined &&
      (typeof args.dateTo !== "string" || Number.isNaN(Date.parse(args.dateTo)))) {
    throw new McpError(ErrorCode.InvalidParams, "'dateTo' must be a parseable date string when provided.");
  }
  if (args.dateFrom && args.dateTo) {
    const dfTs = Date.parse(args.dateFrom as string);
    const dtTs = Date.parse(args.dateTo as string);
    if (dfTs > dtTs) {
      throw new McpError(ErrorCode.InvalidParams, "'dateFrom' must not be later than 'dateTo'.");
    }
  }
  // VALID-002: length-cap body/text/bcc at MAX_SEARCH_TEXT like from/to/subject.
  // These were previously read with only a typeof check and forwarded unbounded,
  // letting a multi-MB filter burn server memory.
  const body = typeof args.body === "string" ? args.body : undefined;
  const text = typeof args.text === "string" ? args.text : undefined;
  const bcc = typeof args.bcc === "string" ? args.bcc : undefined;
  if (body !== undefined && body.length > MAX_SEARCH_TEXT) {
    throw new McpError(ErrorCode.InvalidParams, `'body' filter must not exceed ${MAX_SEARCH_TEXT} characters.`);
  }
  if (text !== undefined && text.length > MAX_SEARCH_TEXT) {
    throw new McpError(ErrorCode.InvalidParams, `'text' filter must not exceed ${MAX_SEARCH_TEXT} characters.`);
  }
  if (bcc !== undefined && bcc.length > MAX_SEARCH_TEXT) {
    throw new McpError(ErrorCode.InvalidParams, `'bcc' filter must not exceed ${MAX_SEARCH_TEXT} characters.`);
  }
  const answered = typeof args.answered === "boolean" ? args.answered : undefined;
  const isDraft = typeof args.isDraft === "boolean" ? args.isDraft : undefined;
  // TOOL-016: byte-size predicates are non-negative integers; reject negatives
  // and non-finite (NaN/Infinity) instead of forwarding them to the IMAP wire.
  if (args.larger !== undefined &&
      (typeof args.larger !== "number" || !Number.isFinite(args.larger) || args.larger < 0)) {
    throw new McpError(ErrorCode.InvalidParams, "'larger' must be a non-negative finite number (bytes) when provided.");
  }
  if (args.smaller !== undefined &&
      (typeof args.smaller !== "number" || !Number.isFinite(args.smaller) || args.smaller < 0)) {
    throw new McpError(ErrorCode.InvalidParams, "'smaller' must be a non-negative finite number (bytes) when provided.");
  }
  const larger = typeof args.larger === "number" ? args.larger : undefined;
  const smaller = typeof args.smaller === "number" ? args.smaller : undefined;
  // TOOL-017: require a string + a parseable date. The old truthy-check let
  // numbers/objects through — `new Date(null)` → 1970, `new Date({})` →
  // Invalid Date — silently corrupting the search window.
  const parseSentDate = (raw: unknown, field: string): Date | undefined => {
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw !== "string" || Number.isNaN(Date.parse(raw))) {
      throw new McpError(ErrorCode.InvalidParams, `'${field}' must be a parseable date string when provided.`);
    }
    return new Date(raw);
  };
  const sentBefore = parseSentDate(args.sentBefore, "sentBefore");
  const sentSince = parseSentDate(args.sentSince, "sentSince");

  return {
    folder: folders ? undefined : folder,
    folders,
    from: args.from as string | undefined,
    to: args.to as string | undefined,
    subject: args.subject as string | undefined,
    hasAttachment: args.hasAttachment as boolean | undefined,
    isRead: args.isRead as boolean | undefined,
    isStarred: args.isStarred as boolean | undefined,
    dateFrom: args.dateFrom as string | undefined,
    dateTo: args.dateTo as string | undefined,
    limit: Math.min(Math.max(1, (args.limit as number) || 50), 200, maxEmailListResults),
    body,
    text,
    bcc,
    answered,
    isDraft,
    larger,
    smaller,
    sentBefore,
    sentSince,
  };
}
