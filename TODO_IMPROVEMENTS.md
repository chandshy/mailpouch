# TODO Improvements — Prioritized Backlog

Last updated: Cycle #5 (2026-03-18)

---

## HIGH PRIORITY

### [DONE - Cycle 1] Path traversal in label/folder handlers
Fixed in `get_emails_by_label`, `move_to_folder`, `remove_label`, `bulk_remove_label`.

---

## MEDIUM PRIORITY

### [DONE - Cycle 2] Add test coverage for new input validation
Extracted `validateLabelName`, `validateFolderName`, `validateTargetFolder` to `src/utils/helpers.ts`.
Added 27 tests in `helpers.test.ts` covering all branches. Refactored 4 handlers to use helpers.

### [DONE - Cycle 2] `SchedulerService` — items array unbounded growth
`pruneHistory()` method added. Called from `load()`. Drops non-pending records >30 days old, caps at 1000 records. 2 new tests added.

### [DONE - Cycle 2] `Analytics.getEmailStats()` — spread on large array
`Math.min/max(...dates)` replaced with `reduce` pattern in `analytics-service.ts`.

---

## LOW PRIORITY

### [DONE - Cycle 2] Fix comment numbering in graceful shutdown
Second "// 3." corrected to "// 4." in `src/index.ts`.

### [DONE - Cycle 2] `list_labels` detection logic cleanup
Removed redundant `|| f.name?.startsWith("Labels/")` condition.

### [DONE - Cycle 3] `move_email` / `bulk_move_emails` — missing targetFolder validation
Added `validateTargetFolder()` call before `imapService.moveEmail()` in both handlers.
Returns `McpError(InvalidParams)` for `..`, control chars, or oversized strings.

### [DONE - Cycle 3] `send_test_email` validation — friendly error
Added `isValidEmail(args.to)` check at handler entry. Returns `McpError(InvalidParams)`.

### [DONE - Cycle 3] `parseEmails` — silent dropping of invalid addresses
Imported `logger` into helpers.ts. `parseEmails` now calls `logger.warn(...)` for each dropped address.

### [DONE - Cycle 4] `send_test_email` body uses emoji in HTML
Fixed in `src/services/smtp-service.ts`. Subject and body now use plain ASCII text only.

### [DONE - Cycle 4] Add handler-level validation tests for Cycle #3 changes
Added 16 tests in `src/utils/helpers.test.ts` covering `move_email`, `bulk_move_emails`, and `send_test_email` validation paths (traversal, control chars, invalid email, oversized inputs, valid cases).

---

## NEW — Cycle #4 Findings (all completed in Cycle #5)

### [DONE - Cycle 5] `decodeCursor` folder field not validated against traversal
Fixed in `src/index.ts` `decodeCursor()`. Added `validateTargetFolder(parsed.folder) !== null` check before returning cursor. Crafted cursors with traversal paths (e.g. `../../etc`) now return null and are rejected as "Invalid or expired cursor".

### [DONE - Cycle 5] `get_email_by_id` / `download_attachment` — no handler-level type check on emailId/attachmentIndex
Fixed in `src/index.ts`. Added `!/^\d+$/.test(rawEmailId)` guard in `get_email_by_id`. Added numeric UID guard + `!Number.isInteger(rawAttIdx) || rawAttIdx < 0` guard in `download_attachment`. Both return `McpError(InvalidParams)` with clear messages.

---

## NEW — Cycle #5 Findings (all completed in Cycle #6)

### [DONE - Cycle 6] Add tests for Cycle #5 handler-level guards
Added 29 unit tests in `src/utils/helpers.test.ts` covering all branches of the three Cycle #5 guards: `decodeCursor` folder-validation (8 tests), `get_email_by_id` numeric UID guard (10 tests), and `download_attachment` email_id + attachment_index guards (11 tests).

### [DONE - Cycle 6] `search_emails` free-text fields — max-length guard
Added `MAX_SEARCH_TEXT = 500` and three inline checks in the `search_emails` handler in `src/index.ts`. Returns `McpError(InvalidParams)` for `from`/`to`/`subject` exceeding 500 characters.

---

## NEW — Cycle #6 Findings

### 11. `create_folder` / `rename_folder` args — validateFolderName check
**File:** `src/index.ts` `create_folder` and `rename_folder` handlers
**Issue:** `args.folderName` and `args.newName` may be passed to IMAP service without `validateFolderName()` check at handler level. Service may have internal validation; worth confirming and adding handler-level guard for consistency.
**Effort:** LOW — ~4 lines each handler
**Risk:** LOW

### 12. Remaining `args.X as Y` casts — type-check audit
**File:** `src/index.ts`
**Issue:** Many handlers use `args.X as SomeType` without a runtime check. Most are guarded by JSON schema validation at the MCP layer, but a targeted audit would identify any gaps where a malformed arg could reach a service method unguarded.
**Effort:** LOW–MEDIUM — audit only, fix if gaps found
**Risk:** LOW

---

## FUTURE / ARCHITECTURAL

### 5. Cursor token HMAC binding
**File:** `src/index.ts` cursor encode/decode
**Issue:** The cursor is base64url-encoded JSON `{folder, offset, limit}`. Adding HMAC would bind the cursor to the server instance (prevents cursor forgery across restarts).
**Effort:** Low-medium, low security impact

### 6. IMAP connection health check / reconnect on error
**File:** `src/services/simple-imap-service.ts`
**Issue:** `ensureConnection()` only checks `isConnected` flag. If IMAP server drops without a 'close' event (TCP RST), `isConnected` stays true and next op throws. Proactive NOOP check would be more robust.
**Effort:** Medium, moderate risk

---
