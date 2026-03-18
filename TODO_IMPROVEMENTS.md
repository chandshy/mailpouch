# TODO Improvements — Prioritized Backlog

Last updated: Cycle #32 (2026-03-18)

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

## NEW — Cycle #6 Findings (all completed in Cycle #7)

### [DONE - Cycle 7] `create_folder` / `rename_folder` / `delete_folder` args — validateFolderName check
Added `validateFolderName()` call at handler entry for `create_folder`, `delete_folder` (folderName), and `rename_folder` (oldName and newName). All return `McpError(InvalidParams)` with clear messages for empty, slash, traversal, control-char, or oversized inputs.

### [DONE - Cycle 7] `mark_email_read` / `star_email` — missing numeric emailId guard
Added `!/^\d+$/.test(emailId)` guard to both handlers matching the pattern established in `get_email_by_id` (Cycle #5). Returns `McpError(InvalidParams, "emailId must be a non-empty numeric UID string.")` for invalid inputs.

---

## NEW — Cycle #7 Findings (all completed in Cycle #8)

### [DONE - Cycle 8] Remaining `args.X as Y` casts — type-check audit
Systematic audit performed. All `args.emailId as string` casts now have handler-level numeric UID guards. Bulk operation array items now filtered to `/^\d+$/.test(id)`. `get_emails` folder validated with `validateTargetFolder()`. See Cycle #8 work log for full details.

### 14. `save_draft` / `schedule_email` attachment validation
**File:** `src/index.ts`, `src/services/simple-imap-service.ts`
**Issue:** `args.attachments as any` is passed to `imapService.saveDraft()`. Attachment objects (name, contentType, content) are not validated at handler level. The service's `saveDraft` uses the contentType directly in MIME construction.
**Effort:** LOW–MEDIUM
**Risk:** LOW (content is base64-encoded; contentType is used as a MIME field and already handled by nodemailer/imapflow encoding)

---

## NEW — Cycle #8 Findings (all completed in Cycle #9)

### [DONE - Cycle 9] `move_to_label` / `remove_label` — missing numeric emailId guard
Added `!/^\d+$/.test(emailId)` guard to both handlers. `mtlEmailId` and `rlEmailId` local variables introduced (consistent naming). Returns `McpError(InvalidParams, "emailId must be a non-empty numeric UID string.")`.

### [DONE - Cycle 9] `save_draft` attachment validation — filename/contentType sanitization gap
`saveDraft` in `simple-imap-service.ts` now strips CRLF/NUL from `filename` (truncates to 255 chars, falls back to "attachment"), and validates `contentType` against type/subtype regex (falls back to undefined if invalid). Mirrors the robust sanitization already present in `smtp-service.ts sendEmail()`.

---

## NEW — Cycle #9 Findings (all completed in Cycle #10)

### [DONE - Cycle 10] Code quality — unused imports / dead code scan
No unused imports found. All imports in `src/index.ts` are referenced. `EmailAttachment` added to the import line as part of narrowing `as any` casts.

### [DONE - Cycle 10] Type safety — remaining `as any` casts in production code
9 avoidable `as any` casts removed across `src/index.ts`, `analytics-service.ts`, and `simple-imap-service.ts`. 2 unavoidable casts remain: `(result as any).uid` (imapflow type gap), `(att as any).content = undefined` (type omits undefined). See Cycle #10 log for full details.

### JSDoc coverage — public methods in service files
Partially addressed: `truncate()` in `helpers.ts` received expanded JSDoc. `SimpleIMAPService` and `SmtpService` public methods still largely undocumented. Deferred to Cycle #11.

---

## NEW — Cycle #10 Findings (all completed in Cycle #11)

### [DONE - Cycle 11] `(result as any).uid` in `simple-imap-service.ts` saveDraft
Added local `interface AppendResult { uid?: number }` before the class definition. Cast narrowed from `as any` to `as AppendResult`. Zero remaining `as any` casts for this access path.

### [DONE - Cycle 11] `(att as any).content = undefined` in `simple-imap-service.ts` wipeCache
`EmailAttachment.content` was already `content?: Buffer | string` (optional). The cast was spurious. Replaced with direct `att.content = undefined`.

### [DONE - Cycle 11] JSDoc coverage — SimpleIMAPService and SmtpService public methods
14 public methods now documented: `connect`, `disconnect`, `isActive`, `getFolders`, `getEmails`, `getEmailById`, `searchEmails`, `markEmailRead`, `starEmail`, `moveEmail` (SimpleIMAPService); `verifyConnection`, `sendEmail`, `sendTestEmail`, `close` (SmtpService). `saveDraft` was already documented.

---

## NEW — Cycle #11 Findings

### [DONE - Cycle 12] `smtp-service.ts` `wipeCredentials()` — remaining `as any` casts
Removed 3 `as any` casts from `wipeCredentials()`. Direct property writes compile cleanly against `SMTPConfig`.

### [DONE - Cycle 12] `clearCache()` in `simple-imap-service.ts` — missing JSDoc
Added one-line JSDoc to `clearCache()`.

### [DONE - Cycle 12] `security/memory.ts` `scrubEmail()` — 5 spurious `as any` casts
Removed all 5 casts in `scrubEmail()`. `EmailMessage.body/subject/from` and `EmailAttachment.filename` are non-optional mutable strings; `EmailAttachment.content` is already optional. Direct writes compile cleanly.

**Zero avoidable `as any` casts remain in any production code file.**

---

---

## NEW — Cycle #12 Findings

### [DONE - Cycle 13] `SimpleIMAPService.healthCheck()` — NOOP-based connection probe
Added `async healthCheck(): Promise<boolean>`. Issues `this.client.noop()`. Returns true on success, false on any failure or when disconnected. Never throws. 5 new unit tests added.

### [DONE - Cycle 13] DRY — numeric emailId guard in 12+ handlers
Extracted `requireNumericEmailId(raw: unknown, fieldName?: string): string` to `src/utils/helpers.ts`. Throws `McpError(InvalidParams, ...)` on failure. Replaced all 12 guard sites in `src/index.ts`. 14 new unit tests added.

### [DONE - Cycle 14] Wire `healthCheck()` into `get_connection_status`
Added `healthy: await imapService.healthCheck()` to the `imap` sub-object of the `get_connection_status` response. Updated `outputSchema` to declare the new field. NOOP probe now surfaced to agents.

### [DONE - Cycle 14] Inline label validation in `move_to_label` / `bulk_move_to_label`
Both handlers now call `validateLabelName()` instead of 3 inline if-blocks each. Net -14 lines in `src/index.ts`. Behavior unchanged; all existing tests cover the validation paths.

### 27. Error message clarity for lost IMAP connections
**File:** `src/services/simple-imap-service.ts`
**Issue:** When IMAP connection is lost and an operation is attempted, the raw imapflow error propagates. Wrapping `ensureConnection()` failures with a friendly "IMAP connection lost; reconnect via the settings tool." message would improve user experience. Assessed in Cycle #14 — existing messages are reasonably clear (logged with context). Low priority.
**Effort:** LOW
**Risk:** LOW

---

---

## NEW — Cycle #14 Findings

### [DONE - Cycle 15] `save_draft` / `schedule_email` / `send_email` attachment validation (carried from Cycle #8)
Added `validateAttachments()` helper to `src/utils/helpers.ts`. Called in all three handlers. Returns `McpError(InvalidParams)` for non-array input, primitive array items, missing/wrong-type filename, missing/null/wrong-type content, or wrong-type contentType. 23 new tests added. 416 tests total.

### [DONE - Cycle 16] README accuracy — tool count and `get_connection_status` description
Corrected tool count from 45 → 47 in README tagline, README Full Access preset row, and CHANGELOG [2.1.0]. Extended `get_connection_status` table description to mention `imap.healthy` (NOOP probe) and `insecureTls` fields. Added comprehensive `[Unreleased]` CHANGELOG section documenting all Cycle #1–#15 improvements.

### [DONE - Cycle 17] README — all 5 MCP prompts now listed
Expanded README "MCP Prompts" subsection from a 3-item bullet list to a 5-row table. Added `triage_inbox` (limit, focus args) and `daily_briefing` (no args). Now matches all 5 prompts registered in `ListPromptsRequestSchema` in `src/index.ts`.

### [DONE - Cycle 17] Settings UI embedded HTML — "40 tools" corrected to "47 tools"
Fixed two occurrences of "All 40 tools" in `src/settings/server.ts` (preset comparison table + setup wizard card). Now consistent with README and CHANGELOG (all say 47).

### 31. `ensureConnection()` friendly error wrapping — CLOSED (Cycle #18 re-assessment)
**Status:** No action needed. Re-assessed in Cycle #18:
- Read-path methods catch and return empty arrays on reconnect failure.
- Write-path errors propagate to the top-level `safeErrorMessage()` handler which maps IMAP messages to "IMAP operation failed".
- Error handling is correct and user-friendly. Closing this item.

### [DONE - Cycle 18] `get_connection_status` outputSchema accuracy
Added 6 missing fields to outputSchema: `smtp.lastCheck`, `smtp.insecureTls`, `smtp.error`, `imap.insecureTls`, `settingsConfigured`, `settingsConfigPath`.

### [DONE - Cycle 18] `list_scheduled_emails` outputSchema missing `retryCount`
Added `retryCount` field to the scheduled item properties in the outputSchema.

### [DONE - Cycle 19] `get_email_analytics` outputSchema — 4 incomplete entries
Expanded `topSenders`, `topRecipients`, `peakActivityHours`, and `attachmentStats` from bare `{type:"object"}` to full typed schemas matching the `EmailAnalytics` interface.

### [DONE - Cycle 19] `get_contacts` outputSchema — 4 missing Contact fields
Added `name`, `firstInteraction`, `averageResponseTime`, `isFavorite` to the contact item schema to match the full `Contact` interface.

---

## FUTURE / ARCHITECTURAL

### 5. Cursor token HMAC binding
**File:** `src/index.ts` cursor encode/decode
**Issue:** The cursor is base64url-encoded JSON `{folder, offset, limit}`. Adding HMAC would bind the cursor to the server instance (prevents cursor forgery across restarts).
**Effort:** Low-medium, low security impact
**Status:** DEFERRED — low risk (folder field already traversal-validated; no sensitive data in cursor). Revisit if multi-instance deployment is planned.

### 6. IMAP connection health check / reconnect on error
**File:** `src/services/simple-imap-service.ts`
**Issue:** `ensureConnection()` only checks `isConnected` flag. If IMAP server drops without a 'close' event (TCP RST), `isConnected` stays true and next op throws. Proactive NOOP check would be more robust.
**Effort:** Medium, moderate risk
**Status:** PARTIALLY ADDRESSED — `healthCheck()` NOOP probe added (Cycle 13), surfaced in `get_connection_status` (Cycle 14). Full proactive background reconnect deferred: read-path catches errors; write-path maps to safeErrorMessage. Low marginal value.

---

## NEW — Cycle #22 Findings (all completed in Cycle #22)

### [DONE - Cycle 22] `search_emails` multi-folder `folders[]` — no handler-level path traversal validation
The handler forwarded the `folders[]` array directly to the service without validating individual strings. The service's private `validateFolderName()` did not check for `..` traversal, so paths like `../../etc` could reach imapflow. Added handler-level loop calling `validateTargetFolder()` on each entry (exempting the `["*"]` wildcard), plus added `..` check to the service method itself as defence-in-depth.

### [DONE - Cycle 22] `cancel_scheduled_email` — no UUID format validation on `id`
The raw `args.id` string was passed directly to `schedulerService.cancel()`. Added a UUID regex guard (`/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`) that returns `McpError(InvalidParams)` for non-UUID values.

### [DONE - Cycle 22] Settings HTML response — missing security headers
`GET /` response lacked `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, and `Cache-Control` headers. Added all four to match the headers already present on all JSON API responses from the `json()` helper.

### [DONE - Cycle 22] Service-level `validateFolderName()` — no `..` traversal check
The private method in `SimpleIMAPService` checked for empty, too-long, and control characters but not for `..` path traversal sequences. Added `name.includes('..')` check as a second layer of defence below the handler-level `validateTargetFolder()` guards.

---

---

## NEW — Cycle #23 Findings (all completed in Cycle #23)

### [DONE - Cycle 23] `send_email` / `forward_email` `to` field — no handler-level empty-string guard
Both handlers forwarded `args.to as string` without checking for empty/whitespace-only values. An empty `to` would reach `smtpService.sendEmail()` and produce an opaque SMTP error rather than a clear `InvalidParams`. Added guard `!args.to || typeof args.to !== "string" || !(args.to).trim()` → `McpError(InvalidParams)` in both handlers.

### [DONE - Cycle 23] `reply_to_email` `body` field — no handler-level empty-string guard
`args.body as string` passed directly to the SMTP service without emptiness check. A blank body would silently send an empty reply. Added guard `!args.body || typeof args.body !== "string" || !(args.body).trim()` → `McpError(InvalidParams, "'body' must be a non-empty string.")`.

### [DONE - Cycle 23] Bulk operations — empty `emailIds` array produces silent no-op
All 6 bulk tools (`bulk_mark_read`, `bulk_star`, `bulk_move_emails`, `bulk_move_to_label`, `bulk_remove_label`, `bulk_delete_emails` / `bulk_delete`) previously returned `{success:0, failed:0, errors:[]}` when called with `emailIds: []`. Added up-front guard → `McpError(InvalidParams, "emailIds must be a non-empty array of numeric UID strings.")` in all six handlers.

---

## NEW — Cycle #24 Findings (all completed in Cycle #24)

### [DONE - Cycle 24] `schedule_email` — missing `to` empty-string guard
`args.to` was passed directly to `schedulerService.schedule()` without checking for empty/whitespace-only values. An empty `to` would schedule a job that silently failed at send-time with an opaque SMTP error. Added guard consistent with `send_email`/`forward_email` → `McpError(InvalidParams, "'to' must be a non-empty string...")`.

### [DONE - Cycle 24] `schedule_email` — `send_at` validation used `return` pattern (inconsistency)
Both `send_at` guards (missing value, invalid date) used `return { ..., isError: true, ... }` instead of `throw new McpError(ErrorCode.InvalidParams, ...)`. Refactored to throw `McpError(InvalidParams)` with clear messages including an ISO 8601 format hint. Now consistent with every other handler's parameter validation pattern.

### [DONE - Cycle 24] `get_contacts` / `get_volume_trends` — no handler-level numeric type check on `limit`/`days`
Both handlers cast `args.limit`/`args.days` directly as `number | undefined` without verifying the runtime type. A non-numeric value (e.g. string `"30"`) would silently fall back to the service default. Added handler-level type guards → `McpError(InvalidParams, "'limit' must be a number.")` and `McpError(InvalidParams, "'days' must be a number.")`.

---

## NEW — Cycle #25 Findings (all completed in Cycle #25)

### [DONE - Cycle 25] `get_emails` / `search_emails` — `limit` parameter has no runtime type guard
Both handlers used `(args.limit as number) || 50` inside `Math.min(Math.max(...))` without verifying the runtime type. A non-numeric string like `"abc"` produces NaN that bypasses clamping and reaches the IMAP service. Added `if (args.limit !== undefined && typeof args.limit !== "number") throw McpError(InvalidParams)` in both handlers, consistent with the type guards added to `get_contacts.limit` and `get_volume_trends.days` in Cycle #24.

### [DONE - Cycle 25] `search_emails` — no cross-validation of `dateFrom`/`dateTo`
When both `dateFrom` and `dateTo` are provided, no check was made that `dateFrom ≤ dateTo`. A reversed range (e.g. dateFrom=2024-12-31, dateTo=2024-01-01) would be forwarded to imapflow silently returning zero results. Added cross-validation: when both parse as valid dates and `Date.parse(dateFrom) > Date.parse(dateTo)`, throws `McpError(InvalidParams, "'dateFrom' must not be later than 'dateTo'.")`.

### [DONE - Cycle 25] `download_attachment` — `attachment_index` has no upper bound
The existing guard only checked `!isInteger || < 0` but allowed values like 999999. Requesting absurdly large indices wastes resources and is always a caller error. Added `MAX_ATTACHMENT_INDEX = 50` constant and guard `if (rawAttIdx > MAX_ATTACHMENT_INDEX) throw McpError(InvalidParams)`.

---

## NEW — Cycle #27 Findings (all completed in Cycle #27)

### [DONE - Cycle 27] `get_emails_by_label` — `limit` parameter no runtime type guard
The handler used `(args.limit as number) || 50` without checking `typeof args.limit === "number"`. A non-numeric string produces NaN inside Math.max/min, reaching the IMAP service unclamped. Added type guard consistent with get_emails / search_emails (Cycle #25).

### [DONE - Cycle 27] `sync_emails` — `limit` parameter no runtime type guard
Same NaN-propagation issue: `(args.limit as number) || 100` inside Math.min/max without a type check. Added the same guard pattern.

---

## NEW — Cycle #28 Findings (all completed in Cycle #28)

### [DONE - Cycle 28] `send_email` / `schedule_email` — `body` field has no empty-string guard
Both handlers forwarded `args.body as string` to the SMTP service without any emptiness check. An empty or whitespace-only body would silently send/schedule a blank email. Added guard `!args.body || typeof args.body !== "string" || !(args.body).trim()` → `McpError(InvalidParams)` in both handlers, consistent with `reply_to_email` (Cycle #23).

### [DONE - Cycle 28] `save_draft` — `body` field has no empty-string guard (optional variant)
`save_draft` accepts `body` as optional (undefined is fine), but an explicitly empty string like `""` or `"  "` was silently accepted. Added optional-variant guard: when `body` is present but not a non-empty string, returns `McpError(InvalidParams, "'body' must be a non-empty string when provided.")`.

### [DONE - Cycle 28] `send_email` / `schedule_email` — `priority` field has no runtime enum validation
The inputSchema declares `enum: ["high", "normal", "low"]` but the handler cast the value directly with no runtime check. Added `VALID_PRIORITIES = new Set(["high", "normal", "low"])` guard in `send_email` and an inline equivalent in `schedule_email`, both returning `McpError(InvalidParams)` for out-of-enum values including wrong-case strings like `"HIGH"`.

### [DONE - Cycle 28] `saveDraft` `inReplyTo` — not CRLF-sanitized in IMAP service
In `smtp-service.ts`, `inReplyTo` was already sanitized via `stripHeaderInjection()`. In `simple-imap-service.ts` `saveDraft()`, `options.inReplyTo` was passed raw to nodemailer — a crafted value like `"<id>\r\nBcc: evil@x.com"` could inject a MIME header. Added `options.inReplyTo.replace(/[\r\n\x00]/g, "")` to match the SMTP service behaviour. `references` on the next line already stripped control chars; `inReplyTo` was the sole gap.

---

## NEW — Cycle #29 Findings (all completed in Cycle #29)

### [DONE - Cycle 29] `forward_email` — no subject length cap (RFC 2822)
`send_email`, `save_draft`, and `schedule_email` all received a 998-char subject length cap in Cycle #26, but `forward_email` was missed. The handler builds `fwdSubject` from the original email's subject (control-char-stripped) plus optional "Fwd: " prefix, then passes it to `smtpService.sendEmail()` without a length check. A long original subject can exceed 998 chars. Fixed by slicing `fwdSubject` to 998 chars after the prefix is applied.

### [DONE - Cycle 29] `rename_folder` — no same-name guard
When `args.oldName === args.newName`, the handler issued a spurious IMAP RENAME command that servers reject with cryptic errors (e.g., "Mailbox already exists" from Dovecot). Added explicit `McpError(InvalidParams, "'newName' must be different from 'oldName'.")` guard after both `validateFolderName` checks pass.

### [DONE - Cycle 29] `get_emails` / `get_emails_by_label` — `cursor` not type-checked
Both pagination handlers used `if (args.cursor)` (truthy) then `args.cursor as string` cast without `typeof` check. A non-string value (e.g., number `50`) would be truthy, pass the check, and produce the generic "Invalid or expired cursor" error response instead of a clear type error. Added `if (args.cursor !== undefined && typeof args.cursor !== "string") throw McpError(InvalidParams, "'cursor' must be a string.")` in both handlers.

---

## NEW — Cycle #30 Findings (all completed in Cycle #30)

### [DONE - Cycle 30] `send_email` / `schedule_email` — `replyTo` field no handler-level isValidEmail check
Both handlers forwarded `args.replyTo as string | undefined` to the SMTP service / scheduler without any format check. The SMTP service validates it but returns an opaque "Email delivery failed" result. For `schedule_email` an invalid replyTo is stored in the scheduler and only fails at send-time (silent failure). Added `isValidEmail()` guard in both handlers → `McpError(InvalidParams, "'replyTo' must be a valid email address.")`.

### [DONE - Cycle 30] `send_email` / `save_draft` / `schedule_email` — `subject` non-string type guard
The length cap (Cycle #26) used `typeof args.subject === "string"` in the condition, so non-string values (numbers, objects) silently bypassed the check and were cast to string downstream. Added a dedicated type guard `if (args.subject !== undefined && typeof args.subject !== "string") throw McpError(InvalidParams, "'subject' must be a string.")` before the length check in all three handlers.

### [DONE - Cycle 30] `save_draft` — `to` field type guard when provided
`save_draft` accepted `to` as optional with no type check. A non-string `to` (array, number) was silently cast and forwarded to the IMAP saveDraft layer. Added `if (args.to !== undefined && typeof args.to !== "string") throw McpError(InvalidParams, "'to' must be a string when provided.")`.

---

## NEW — Cycle #31 Findings (all completed in Cycle #31)

### [DONE - Cycle 31] `send_email` / `save_draft` / `schedule_email` — `cc` and `bcc` fields missing type guards
All three handlers cast `args.cc` and `args.bcc` directly as `string | undefined` with no type check. A caller supplying an array (e.g. `cc: ["a@b.com"]`) or a number (`cc: 42`) would have the value silently coerced to a malformed string and forwarded unchecked. For `schedule_email` the value is stored in the scheduler and only fails at send-time. Added `if (args.cc !== undefined && typeof args.cc !== "string") throw McpError(InvalidParams)` and an equivalent `bcc` guard in all three handlers, consistent with the `to` type guard pattern already present in each handler.

### [DONE - Cycle 31] `forward_email` — `message` field missing type guard
The optional `message` parameter was used as `args.message ? \`${args.message as string}\n\n\` : ""` with no type check. A non-string value (number, array) is truthy, passes the ternary, and is silently coerced via template literal. Added `if (args.message !== undefined && typeof args.message !== "string") throw McpError(InvalidParams, "'message' must be a string when provided.")` before the template-literal use, consistent with all other optional string fields in the codebase.

## NEW — Cycle #32 Findings (all completed in Cycle #32)

### [DONE - Cycle 32] `send_test_email` — `customMessage` field missing type guard
The optional `customMessage` parameter was cast directly as `string | undefined` with no type check. A non-string value (number, array, object) is truthy, satisfies the SMTP service's `customMessage || <default>` fallback, and is silently coerced to a string producing a garbled test email body. Added `if (args.customMessage !== undefined && typeof args.customMessage !== "string") throw McpError(InvalidParams)` consistent with the `message` guard in `forward_email` (Cycle #31).

### [DONE - Cycle 32] `get_logs` outputSchema — missing `data` field
The `LogEntry` interface has an optional `data?: any` field carrying sanitized/redacted metadata, but the `get_logs` outputSchema items did not list `data`. Added `data: { description: "Optional structured metadata attached to the log entry (sensitive fields redacted)" }` to the items properties for accurate schema documentation.

### [DONE - Cycle 32] `list_labels` — `(f: any)` cast in array filter
The `list_labels` filter used `(f: any)` with optional chaining `f.path?.startsWith()`. Since `getFolders()` returns `EmailFolder[]` and `path` is non-optional, the cast was spurious. Replaced with `(f: EmailFolder)` and direct `f.path.startsWith()`. Added `EmailFolder` to the import line.

IMPROVEMENT CYCLES COMPLETE — 2026-03-18 — 32 cycles
