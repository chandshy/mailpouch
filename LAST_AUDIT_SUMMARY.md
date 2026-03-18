# Last Audit Summary — Cycle #1
**Date:** 2026-03-17 23:38 Eastern
**Auditor:** Claude Sonnet 4.6 (auto-improve cycle)

---

## Phase 0: Architecture & Context Mapping

**Structure:**
- `src/index.ts` — MCP server entry point, all 30+ tool handlers, Resources + Prompts (~2600 lines)
- `src/services/simple-imap-service.ts` — ImapFlow wrapper, email cache (FIFO, 500 cap), folder ops
- `src/services/smtp-service.ts` — Nodemailer wrapper, header injection defense, attachment limits
- `src/services/analytics-service.ts` — In-memory analytics, contact map (10K cap), response-time calculation
- `src/services/scheduler.ts` — JSON-persisted scheduled sends, background 60s interval, 3-retry logic
- `src/permissions/manager.ts` — Per-tool enable/disable + rolling 1-hour rate limits, 15s config cache
- `src/permissions/escalation.ts` — Two-channel human-gated escalation, file-backed state, CSRF protection
- `src/config/loader.ts` — JSON config file, preset-based permissions, path-traversal protection
- `src/config/schema.ts` — ALL_TOOLS registry (45 tools), TOOL_CATEGORIES, preset definitions
- `src/security/keychain.ts` — Optional @napi-rs/keyring integration
- `src/settings/security.ts` — RateLimiter, body-size cap, origin validation, CSRF, input sanitizers
- `src/utils/helpers.ts` — Email validation (RFC 5321 limits), parse, sanitize, generateId
- `src/utils/logger.ts` — In-memory ring buffer (1000 logs), sensitive key redaction, sanitizeData
- `src/types/index.ts` — Full TypeScript types for all domain objects

**Data flow:** MCP tool call → permission gate → IMAP/SMTP service → typed response
**Key invariant:** All tools route through `permissions.check()` except the two meta escalation tools.

---

## Phase 1: Full Functionality Audit

### Issues Found:

**[MEDIUM] `send_test_email` — missing `to` email address validation (index.ts:1606)**
The `send_test_email` handler casts `args.to` directly to string and passes it to `smtpService.sendEmail()` without checking `isValidEmail()` first. The SMTP service does perform validation inside `sendEmail`, but the error message that propagates is not user-friendly and gets caught by the generic `safeErrorMessage` handler which may strip the informative details.

**[LOW] `schedule_email` — `send_at` date parsing allows partial ISO strings (index.ts:1739)**
`new Date("2026-03-17")` parses as midnight UTC which is technically valid, but a user supplying a date-only string expecting "today at this hour" could be confused. Not a bug but a UX issue; could add a note or stricter ISO datetime validation (requires T time component).

**[MEDIUM] `get_emails_by_label` — label name not validated (index.ts:1690-1712)**
The `lblName` variable (`args.label as string`) is used directly to construct `Labels/${lblName}` which is then passed to `imapService.getEmails()`. Unlike `move_to_label` (which validates for `/`, `..`, control chars, length), `get_emails_by_label` skips that validation. An attacker could supply `"../INBOX"` to produce path `Labels/../INBOX`, potentially accessing arbitrary folders.
**Fix:** Add the same label validation present in `move_to_label` to `get_emails_by_label`.

**[LOW] `move_to_folder` — folder name not validated (index.ts:1862-1866)**
Similarly, `args.folder` is used without the slash/dotdot/control-char validation applied before constructing `Folders/${folderName}`.

**[MEDIUM] Duplicate tool `bulk_delete` / `bulk_delete_emails` (schema.ts:25, index.ts:913-927)**
Both tools are listed in `ALL_TOOLS` array AND shown separately in the tool listing. They share the same handler via a fall-through case. This is intentional (alias) but the schema.ts `ALL_TOOLS` array includes both names, meaning the permission system counts them as separate tools. This is low-risk but creates confusion and two entries in `rateLimitStatus()`.

**[LOW] `list_labels` — brittle label detection (index.ts:1686)**
Detection logic: `f.path?.startsWith("Labels/") || f.name?.startsWith("Labels/")`. The `f.name` check is redundant (names don't have the path prefix), and this doesn't account for Proton Bridge possibly using different capitalizations on localized installs.

**[LOW] `analytics-service.ts` — `Math.min(...dates)` spread on large arrays (line 131)**
`Math.min(...allEmails.map(e => e.date.getTime()))` uses spread which can cause "Maximum call stack size exceeded" for large arrays (>100K items). Given the 200-cap on IMAP fetch, this is practically safe but should use `reduce` for robustness.

**[LOW] `helpers.ts:parseEmails` — silently drops invalid addresses**
`parseEmails` filters out invalid emails silently. If the caller passes `"validuser@domain.com, invalidaddr"`, only the valid one is used. There's no warning. This affects CC/BCC paths where some recipients could be silently dropped.

---

## Phase 2: Logical & Architectural Audit

**[LOW] `analyticsCacheInflight` not cleared on error**
In `getAnalyticsEmails()` (index.ts:131-145), the `analyticsCacheInflight` is set to null in a `finally` block, which is correct. But if the fetch throws, `analyticsCache` is not set, and the next call will re-fetch — that's correct behavior.

**[LOW] Cursor pagination decoding — `folder` field mismatch**
`decodeCursor` validates that the folder in the cursor matches the requested folder. However, for `get_emails_by_label`, the cursor check uses `decoded.folder !== lblFolder` (line 1698) which is correct. For `get_emails` (line 1627), same pattern. Both are fine.

**[MEDIUM] `remove_label` / `bulk_remove_label` don't validate `targetFolder` (index.ts:1989-2016)**
The `targetFolder` argument is used directly as an IMAP path without folder name validation. An attacker could supply a path traversal or control characters.

**[LOW] Rate-bucket memory leak risk in long-running server**
`PermissionManager.rateBuckets` is a Map keyed by tool name — this is bounded by the number of tools (~45). No leak risk.

**[LOW] `SchedulerService` — no cap on `this.items` array size**
If the scheduler JSON file grows large (e.g., thousands of sent/failed records), the entire array is loaded into memory. A `MAX_HISTORY` style cleanup should prune old completed/failed/cancelled items.

---

## Phase 3: Security Audit (OWASP Top 10 + CWE Top 25)

**[HIGH] IMAP injection via `get_emails_by_label` unvalidated label (see Phase 1)**
The IMAP folder path `Labels/${args.label}` is constructed without validation. ImapFlow's `getMailboxLock(folder)` sends the folder name in an IMAP SELECT command. A `../` traversal could select a different mailbox. Input with IMAP special chars could cause unexpected behavior.

**[MEDIUM] `move_to_folder` unvalidated folder arg (same pattern as above)**

**[FIXED] Header injection — subject/from/to/replyTo** — already mitigated with `stripHeaderInjection` in smtp-service.ts. Good.

**[FIXED] Attachment size limits** — 25MB per-file, 25MB total. Good.

**[FIXED] IMAP search injection** — `sanitizeImapStr` strips `"` and `\`. Good.

**[FIXED] Email address RFC 5321 length limits** — local part 64, domain 253, total 320. Good.

**[FIXED] Rate limiting (per-tool, per-IP in settings server)** — Good.

**[FIXED] CSRF protection on settings server** — X-CSRF-Token with embedded HTML token. Good.

**[FIXED] Credential redaction in logs** — SENSITIVE_KEYS regex. Good.

**[FIXED] Config path traversal protection** — must be within homedir. Good.

**[FIXED] Memory bounds** — email cache 500 cap, logs 1000 cap, contacts 10K cap. Good.

---

## Phase 4: Documentation Audit

**[LOW] `package.json` description says "45 tools" but ALL_TOOLS has 45 entries + duplicate `bulk_delete`/`bulk_delete_emails` listed in schema**
Counting ALL_TOOLS: 45 entries. The tool listing in index.ts exposes all 45. Description is accurate.

**[LOW] `send_test_email` body uses emoji in HTML (`🧪`, `🌟`, `🎉`)**
Emoji in default test email body is fine but may render incorrectly in some email clients. Minor cosmetic issue.

**[LOW] Inline comment in graceful shutdown says "3." twice (lines 2613 and 2618 in index.ts)**
Two step labels both read "3." — should be "3." and "4.".

**[LOW] `migrateCredentials` is imported in index.ts but never called (line 37)**
`import { loadConfig, defaultConfig, migrateCredentials } from "./config/loader.js"` — `migrateCredentials` is imported but not used in index.ts. The function exists for the settings UI.

---

## Summary of Findings

| Severity | Count | Category |
|----------|-------|----------|
| HIGH     | 1     | IMAP path traversal via unvalidated label |
| MEDIUM   | 3     | Unvalidated label/folder in 3 handlers + duplicate tool |
| LOW      | 8     | Minor bugs, cosmetic, documentation |

**Priority work for Cycle #1:**
1. Fix `get_emails_by_label` — add label validation (HIGH security fix, ~5 lines)
2. Fix `move_to_folder` — add folder validation (MEDIUM security fix, ~8 lines)
3. Fix `remove_label` / `bulk_remove_label` — validate `targetFolder` (MEDIUM, ~10 lines)
4. Fix unused import `migrateCredentials` in index.ts (LOW, 1 line change)
