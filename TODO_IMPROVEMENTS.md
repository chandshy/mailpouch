# TODO Improvements — Prioritized Backlog

Last updated: Cycle #2 (2026-03-17)

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

### 1. `move_email` / `bulk_move_emails` — missing targetFolder validation
**File:** `src/index.ts` cases `move_email` (line ~1854) and `bulk_move_emails` (line ~1934)
**Issue:** `args.targetFolder` is passed directly to `imapService.moveEmail()` without calling `validateTargetFolder()`. The other handlers (`remove_label`, `bulk_remove_label`) now use the helper; these two don't.
**Fix:** Add `validateTargetFolder()` call before the `moveEmail()` call in both handlers.
**Effort:** ~5 lines each, very low risk

### 2. `send_test_email` validation — friendly error
**File:** `src/index.ts` case `send_test_email`
**Issue:** `args.to` is not validated before passing to `smtpService`. If invalid, error propagates from SMTP service and gets caught by `safeErrorMessage` which may strip detail.
**Fix:** Add `isValidEmail(args.to)` check at the handler level with a clear error message, consistent with `send_email`.
**Effort:** ~5 lines, low risk

### 3. `parseEmails` — silent dropping of invalid addresses
**File:** `src/utils/helpers.ts`
**Issue:** Invalid addresses in a comma-separated list are silently dropped. No warning is emitted.
**Fix:** Log a warning for dropped addresses.
**Effort:** ~5 lines, low risk

### 4. `send_test_email` body uses emoji in HTML
**File:** `src/index.ts` case `send_test_email`
**Issue:** Default test email body includes emoji (`🧪`, `🌟`, `🎉`) which may render incorrectly in some email clients.
**Effort:** Cosmetic, trivial

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
