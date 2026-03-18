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

## NEW — Cycle #5 Findings

### 9. Add tests for Cycle #5 handler-level guards
**File:** `src/utils/helpers.test.ts`
**Issue:** No unit tests yet for the new `decodeCursor` folder-validation path, `get_email_by_id` emailId numeric guard, or `download_attachment` email_id / attachment_index guards.
**Effort:** LOW — ~20 tests, same pattern as Cycle #4 test additions
**Risk:** NONE (test-only change)

### 10. `search_emails` free-text fields — consider max-length guard
**File:** `src/index.ts` `search_emails` handler
**Issue:** `from`, `to`, `subject` fields passed to imapflow without length cap. imapflow handles encoding; no injection risk, but excessively long strings could produce large IMAP SEARCH commands.
**Effort:** LOW — add 3 length checks (e.g. max 500 chars each)
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
