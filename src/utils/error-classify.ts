/**
 * Error classification for client-facing tool error messages.
 *
 * Cluster 6 (2026-05-31 consolidated report): many tools collapsed every
 * failure into the opaque string "An error occurred", giving agents/users
 * nothing actionable. This module maps a thrown error — including the
 * imapflow-style server rejections that expose `responseText` /
 * `responseStatus` / `code` — into a small set of stable, distinguishable
 * categories plus a concise, actionable message.
 *
 * Internal stack detail is intentionally NOT included in the returned message;
 * callers should log the raw error separately (the dispatcher already does).
 */

/**
 * A connection/credential problem the OPERATOR must fix (e.g. wrong Bridge
 * password, Bridge not running). Its message is written for a human and is
 * surfaced VERBATIM to the MCP client (safeErrorMessage passes it through), so
 * the agent — and through it the user — gets actionable guidance instead of an
 * opaque "IMAP operation failed". Thrown from the connection chokepoints; not
 * reclassified.
 */
export class ConnectionStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectionStateError";
  }
}

/** Stable, machine-stable error categories surfaced to callers. */
export type ErrorCategory =
  | "not_found" // a folder/label/mailbox does not exist
  | "auth" // IMAP/SMTP authentication failed
  | "connection" // connection lost / unavailable
  | "timeout" // operation timed out
  | "internal"; // anything else / unclassified

export interface ClassifiedError {
  category: ErrorCategory;
  /** Concise, actionable, safe-to-surface message. No stack/PII. */
  message: string;
}

/**
 * imapflow rejections carry server response metadata on the error object.
 * None of these are guaranteed present, so every read is defensive.
 */
interface ImapErrorShape {
  responseText?: unknown;
  responseStatus?: unknown;
  code?: unknown;
  authenticationFailed?: unknown;
}

function readImapShape(error: unknown): ImapErrorShape {
  if (typeof error !== "object" || error === null) return {};
  const e = error as Record<string, unknown>;
  return {
    responseText: e.responseText,
    responseStatus: e.responseStatus,
    code: e.code,
    authenticationFailed: e.authenticationFailed,
  };
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Classify an arbitrary thrown value into a category + actionable message.
 *
 * @param error The thrown value.
 * @param context Optional hint about the resource being acted on (e.g. the
 *   folder or label name) so a not-found message can name it precisely.
 */
export function classifyError(
  error: unknown,
  context?: { folder?: string },
): ClassifiedError {
  const shape = readImapShape(error);
  const rawMsg = error instanceof Error ? error.message : asString(error);
  const responseText = asString(shape.responseText);
  const code = asString(shape.code);
  // Single lowercase haystack covering message + server response text + code.
  const hay = `${rawMsg} ${responseText} ${code}`.toLowerCase();

  const folderLabel = context?.folder;

  // ── not found ────────────────────────────────────────────────────────────
  // imapflow throws on SELECT of a missing mailbox with responseText
  // "NONEXISTENT" or a textual "Mailbox doesn't exist".
  if (
    hay.includes("nonexistent") ||
    hay.includes("mailbox doesn't exist") ||
    hay.includes("mailbox does not exist") ||
    hay.includes("does not exist") ||
    hay.includes("no such mailbox") ||
    hay.includes("not found")
  ) {
    return {
      category: "not_found",
      message: folderLabel
        ? `Folder/label '${folderLabel}' not found.`
        : "The requested folder or label was not found.",
    };
  }

  // ── auth ─────────────────────────────────────────────────────────────────
  if (
    shape.authenticationFailed === true ||
    code === "AUTHENTICATIONFAILED" ||
    hay.includes("authenticationfailed") ||
    hay.includes("authentication failed") ||
    hay.includes("invalid credentials") ||
    hay.includes("login failed")
  ) {
    return {
      category: "auth",
      message:
        "Mail server authentication failed. Check the mailbox credentials in Settings.",
    };
  }

  // ── timeout ──────────────────────────────────────────────────────────────
  // Checked before connection: a timeout often also reads as a conn issue.
  if (
    code === "ETIMEDOUT" ||
    code === "ESOCKETTIMEDOUT" ||
    hay.includes("timed out") ||
    hay.includes("timeout")
  ) {
    return {
      category: "timeout",
      message: "The mail server operation timed out. Please retry.",
    };
  }

  // ── connection lost / unavailable ─────────────────────────────────────────
  if (
    (error instanceof Error && error.name === "IMAPNotConnectedError") ||
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "EPIPE" ||
    code === "ENOTFOUND" ||
    code === "EHOSTUNREACH" ||
    hay.includes("connection unavailable") ||
    hay.includes("not connected") ||
    hay.includes("connection closed") ||
    hay.includes("connection lost") ||
    hay.includes("socket")
  ) {
    return {
      category: "connection",
      message:
        "Lost connection to the mail server. The connection will be retried — please try again.",
    };
  }

  // ── fallthrough ────────────────────────────────────────────────────────────
  return {
    category: "internal",
    message: "An internal error occurred. See server logs for details.",
  };
}

/**
 * Returns true when the error looks like a "mailbox/folder does not exist"
 * rejection from the IMAP server. Used by read tools to convert an opaque
 * server rejection into a precise, named not-found error up front.
 */
export function isFolderNotFoundError(error: unknown): boolean {
  return classifyError(error).category === "not_found";
}
