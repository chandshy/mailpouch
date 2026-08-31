# Quality Audit Ledger

> Archived review ledger. For routine lookup use the compact
> [historical audit index](audit-history.md); current source and tests are
> authoritative.

Per-function code-review scores for the Bridge-capability program (plan
`crispy-wibbling-dusk`). Each function is scored 1–10 on five dimensions —
**job-as-designed** (correct vs Proton Bridge semantics), **simplicity**,
**elegance**, **security**, **focus** (single responsibility). Gate to merge:
**average ≥ 9.5 AND no single dimension < 9**, else rebuild.

Verdicts come from the multi-agent ultra-review (adversarial: a first reviewer
scores, a second independently tries to refute any REBUILD). Findings the second
reviewer cannot confirm as a genuine defect are not actioned.

## Phase 0 — Backbone (`refactor/phase0-backbone`, PR #192)

| Function | File | Job | Simpl | Eleg | Sec | Focus | Avg | Verdict |
|---|---|---|---|---|---|---|---|---|
| `verifyRelocatedMessages` | imap-helpers.ts | 10 | 10 | 10 | 10 | 10 | 10.0 | PASS |
| `buildSearchCriteria` + `sanitizeImapSearchValue` | imap-helpers.ts | 10 | 10 | 10 | 10 | 10 | 10.0 | PASS |
| `stripHtml`/`truncateBody`/`normalizeAddressList` | imap-helpers.ts | 10 | 10 | 10 | 10 | 10 | 10.0 | PASS |
| `buildBridgeTlsConfig` | bridge-tls.ts | 10 | 10 | 10 | 10 | 10 | 10.0 | PASS |
| `validateAttachmentLimits` | utils/helpers.ts | 10 | 10 | 10 | 10 | 10 | 10.0 | PASS |
| `chunkedBatchOp` (config form) | simple-imap-service.ts | 10 | 9 | 9 | 10 | 10 | 9.6 | PASS |
| `buildEmailMessage` | imap-helpers.ts | 9 | 9 | 9 | 10 | 9 | 9.2 | PASS¹ |
| `groupEmailsByFolder` | simple-imap-service.ts | 9.5 | 9 | 8.5 | 10 | 9 | 9.2 | REBUILT → PASS² |
| `validateSearchInput` | tools/search-input.ts | 8.5 | 9 | 8.5 | 9.5 | 9 | 8.9 | REBUILT → PASS³ |

¹ First reviewer scored 9.2/REBUILD; the adversarial verifier did not confirm a
genuine defect (the flagged items were stylistic), so no rebuild — treated PASS.

² **Rebuilt** (commit `1e707d5`): the catch conflated ID-format validation with
IMAP discovery/transport failure — both surfaced as "Invalid email ID". Split so
a discovery error reads "Failed to locate email <id>". Test:
`imap-operations.test.ts` "surfaces discovery transport errors distinctly".

³ **Rebuilt** (commits `1e707d5`, reviewer-pass): `dateFrom`/`dateTo` only
type-checked, never `Date.parse`-validated — `{dateFrom:"not-a-date"}` passed
through and was silently dropped (violated the TOOL-017 contract honored by
`sentBefore`/`sentSince`). Now rejected. Also made `body`/`text`/`bcc` reject
non-strings to match the documented "throws on malformed input" contract.
Tests added in `search-input.test.ts`.

## Phase 1 — Folders (`refactor/phase1-folders`)

| Function | File | Job | Simpl | Eleg | Sec | Focus | Avg | Verdict |
|---|---|---|---|---|---|---|---|---|
| `deleteFolder` | simple-imap-service.ts | 10 | 9 | 10 | 10 | 9 | 9.6 | PASS |
| `createFolder` + `ensureFolderExists` | simple-imap-service.ts | 9 | 9 | 9 | 9.5 | 9 | 9.1 | PASS¹ |
| `renameFolder` | simple-imap-service.ts | 8.5 | 9 | 8.5 | 9 | 9 | 8.8 | REBUILT → PASS² |
| `get_folders` tool + schema | tools/folders.ts | 8 | 9 | 8 | 9 | 8 | 8.4 | REBUILT → PASS³ |
| `getFolders` + `syncFolders` | simple-imap-service.ts | 7 | 8 | 8 | 6 | 8 | 7.4 | REBUILT → PASS⁴ |

¹ First reviewer 9.1/REBUILD; adversarial verifier did not confirm a genuine defect — PASS.

² **Rebuilt:** added the same cross-namespace collision detection `createFolder` has (extracted to shared `isNameInUse`); the listing fallback now catches a `Folders/X`→`Labels/X` collision even when Bridge omits the ALREADYEXISTS text. Also refuses renaming a folder INTO a reserved system name. Tests in `folder-management.test.ts`.

³ **Rebuilt** (this branch's primary capability gap): `get_folders` `outputSchema` now advertises `specialUse` + `folderType` (enum system|user-folder|label), and the description steers agents to special-use over English-name matching and away from the `\All` union. Tests in `folders.test.ts`.

⁴ **Rebuilt — two blockers + a security fix:**
- **`isProtectedFolder` failed OPEN** (security): if `getFolders()` threw, it swallowed and returned `false`, letting `delete`/`rename` hit a localised system mailbox (e.g. `Papelera`=\Trash). Now fails CLOSED — discovery failure propagates and the destructive op refuses.
- **`Promise.all` → `Promise.allSettled`**: one folder's `STATUS` rejection no longer nukes the whole listing; a failed probe yields 0/0 counts.
- **IMAP-012**: a cold-cache + disconnect now throws `IMAPNotConnectedError` instead of returning `[]` (indistinguishable from a zero-folder account), matching `getEmails`.
- **Constant drift**: `SYSTEM_PATHS`/`PROTECTED_NAMES` unified into one `SYSTEM_FOLDER_NAMES` source of truth (classification now includes `junk`).
Tests: allSettled best-effort, junk classification, localised-mailbox protection, fail-closed-on-discovery-failure.

## Phase 2 — Read & fetch (`refactor/phase2-read-fetch`)

| Function | File | Job | Simpl | Eleg | Sec | Focus | Avg | Verdict |
|---|---|---|---|---|---|---|---|---|
| `fetchEmailFullSource` | simple-imap-service.ts | 8.5 | — | — | — | — | 8.5 | PASS¹ |
| `getEmailById` | simple-imap-service.ts | 8 | — | — | — | — | 8.0 | PASS¹ |
| `getEmails` | simple-imap-service.ts | 7 | 8 | 8 | 9 | 9 | 8.2 | REBUILT → PASS² |
| `get_emails`/`get_email_by_id`/`download_attachment`/`get_thread` tool | tools/reading.ts | 8 | — | — | — | — | 8.0 | REBUILT → PASS³ |
| `downloadAttachment` | simple-imap-service.ts | 6 | 8 | 7 | 5 | 9 | 7.0 | REBUILT → PASS⁴ |

¹ First reviewer flagged REBUILD; adversarial verifier did not confirm a genuine defect (the getEmailById per-folder-scan is a documented correctness-over-speed tradeoff mitigated by caching) — PASS.

² **Rebuilt — pagination boundary + flag bug:**
- **Pagination:** `offset >= total` returned a clamped message #1 (`Math.max(1,…)` collapsed start=end=1) instead of an empty page. Now an explicit `offset >= total` guard returns `[]` before the clamp.
- **`$Forwarded` flag:** the list view read the non-existent `\Forward` (never matched) while the forward setter writes `$Forwarded` — every message read back as not-forwarded. Now reads `$Forwarded` || `\Forwarded`.

³ Covered by the getEmails/downloadAttachment rebuilds; tool defs reviewed, no separate defect.

⁴ **Rebuilt — security (memory) + correctness:**
- **Size-guard bypass:** the oversize check read STALE cached `att.size` (which is `?? 0` from bodyStructure) before the re-fetch and never re-checked the fetched bytes — a large attachment with understated/0 cached size could OOM. Now guards on the ACTUAL resolved byte length right before the base64 expansion.
- **Attachment-order drift:** the index came from a bodyStructure-ordered list view but the re-fetch uses mailparser order; on a mismatch `downloadAttachment` now re-maps by filename so it returns the file the caller selected, not the drifted index.
- Also fixed the `\Forward` flag in `buildEmailMessage` (shared by getEmailById).
Tests: pagination empty-page, $Forwarded read (list + buildEmailMessage), oversize-on-refetch guard, filename re-map on order drift.

## Phase 3 — Move / Copy / Delete / Label + `empty_trash` (`refactor/phase3-move-delete`)

| Function | File | Job | Simpl | Eleg | Sec | Focus | Avg | Verdict |
|---|---|---|---|---|---|---|---|---|
| `emptyTrash` (NEW) | simple-imap-service.ts | 10 | 10 | 10 | 10 | 10 | 10.0 | PASS |
| `bulkMoveEmails` | simple-imap-service.ts | 10 | 9.5 | 9.5 | 10 | 9.5 | 9.64 | PASS |
| `deletionTool` (delete/bulk/empty_trash + gate) | tools/deletion.ts | 9.5 | — | — | — | — | 9.5 | PASS |
| `moveEmail` | simple-imap-service.ts | 9.5 | 9 | 9.5 | 10 | 9 | 9.4 | PASS |
| `deleteEmail` + `bulkDeleteEmails` | simple-imap-service.ts | 9 | — | — | — | — | 9.2 | PASS |
| `bulkCopyToFolder` + `bulkDeleteFromFolder` | simple-imap-service.ts | 9 | 9.5 | 9 | 9.5 | 8.5 | 9.0 | REBUILT → PASS¹ |

**New capability — `empty_trash`** (the plan's gated permanent-delete): server-`\Trash`-only target (never a caller folder), `{ confirmed: true }`-gated (`DESTRUCTIVE_TOOLS`), empty-mailbox short-circuit. Scored **10/10**. Everywhere else delete remains move-to-Trash.

¹ **Rebuilt:** `bulkCopyToFolder` omitted the `folder` field from its verify jobs (and used a 1-arg error callback), so copy-failure messages lost the source folder that `bulkMoveEmails` includes — a multi-source copy failure was undebuggable. Now matches the move path: `folder` threaded through, `(uid, src)` error message. Test asserts `from <source>` appears in the failure.

## Phase 4 — Flags + `mark_answered`/`mark_forwarded` (`refactor/phase4-flags`)

| Function | File | Job | Simpl | Eleg | Sec | Focus | Avg | Verdict |
|---|---|---|---|---|---|---|---|---|
| `setFlag` | simple-imap-service.ts | 10 | 10 | 10 | 10 | 10 | 10.0 | PASS |
| `markEmailRead` | simple-imap-service.ts | 9.8 | — | — | — | — | 9.8 | PASS |
| `starEmail` | simple-imap-service.ts | 9.5 | — | — | — | — | 9.5 | PASS¹ |
| `mark_email_read`/`star_email`/`mark_answered`/`mark_forwarded` tools | tools/actions.ts | 9.2 | — | — | — | — | 9.2 | PASS |
| `bulkMarkRead` + `bulkStar` | simple-imap-service.ts | 7 | 9 | 8 | 10 | 8 | 8.4 | REBUILT → PASS² |

**New capability — `mark_answered` / `mark_forwarded`** (the plan's flag gap): wrap `setFlag` with `\Answered` and `$Forwarded` respectively (`$Forwarded` is the keyword the forward tool writes and the Phase-2-fixed readers honour). Both thread `sourceFolder`; registered in `ALL_TOOLS` + the email-actions preset.

¹ `starEmail` (single) had the same missing-cache-clear bug as `bulkStar` (the verifier noted it); fixed alongside ².

² **Rebuilt:** `bulkStar` (and single `starEmail`) toggled `\Flagged` — which changes the Starred system-folder count — but did NOT `clearFolderCache()`, so `get_folders` returned stale starred counts until the TTL expired (`bulkMarkRead`/`markEmailRead` correctly clear on the `\Seen` path). Both now clear the cache on success. Tests assert a star refetches folder counts.

## Phase 5 — Search (IMAP SEARCH incl. BODY/TEXT + FTS) (`refactor/phase5-search`)

All five flagged REBUILD; the search path had the most accumulated debt of any subsystem.

| Function | File | Verdict |
|---|---|---|
| `searchEmails` | simple-imap-service.ts | REBUILT → PASS |
| `searchSingleFolder` | simple-imap-service.ts | REBUILT → PASS |
| `validateSearchInput`/`buildSearchCriteria` | search-input.ts / imap-helpers.ts | PASS (criteria already 10/10 in Phase 0; doc reconciled) |
| FTS `search` | fts-service.ts | REBUILT → PASS |
| `search_emails`/`fts_search` tool | reading.ts | PASS (covered by the service fixes) |

**Capability note:** the plan's "IMAP `SEARCH BODY/TEXT`" gap was already wired in Phase 0 (`buildSearchCriteria` maps `c.body`/`c.text`, exposed on `search_emails`). The Bridge doc still carried the pre-Phase-0 "not implemented" note — **reconciled** (body/text are wired + sanitized; FTS remains the reliable ranked full-text path).

**Rebuilt defects:**
- **IMAP-012:** `searchEmails` returned `[]` on a connection failure (indistinguishable from "no matches") — now throws `IMAPNotConnectedError`, matching `getFolders`/`getEmails`.
- **`hasAttachment` under-return:** the local filter ran AFTER the limit slice (both single + multi-folder), so an attachment query could return far fewer than `limit`. Now filters before the limit with a bounded per-folder over-fetch (200) when the filter is active.
- **Silent failures surfaced:** per-folder `Promise.allSettled` rejections and the 20-folder cap truncation are now logged (were invisible).
- **`searchSingleFolder`** validates its folder name defensively (private, but a bad name must fail clearly, not via a cryptic lock error).
- **FTS `sinceEpoch`:** was a post-`LIMIT` filter → under-returned. Pushed into the SQL `WHERE` (all three query paths) so the date floor applies before `LIMIT`.

## Phase 6 — Drafts & Send (`refactor/phase6-drafts-send`)

| Function | File | Avg | Verdict |
|---|---|---|---|
| `saveDraft` | simple-imap-service.ts | 9.5 | PASS |
| `sendEmail` | smtp-service.ts | 9.3 | PASS |
| SMTP connect/TLS | smtp-service.ts | 8.4 | REBUILT → PASS¹ |
| `send_email`/`reply_to_email`/`forward_email` tools | sending.ts | 8.6 | REBUILT → PASS² |
| reply/forward handlers | sending.ts | 6.8 | REBUILT → PASS² |

**Scope-check — Proton-native scheduled-send (create/cancel):** OUT OF SCOPE. Creating/cancelling a Proton-NATIVE scheduled send requires Proton's private REST API (no public API — see [[project_proton_roadmap]]); Bridge IMAP/SMTP can't. mailpouch already covers future delivery correctly via its OWN scheduler (`schedule_email`/`cancel_scheduled_email`/`list_scheduled_emails`, deferred SMTP) plus read-only `list_proton_scheduled` (reads the "All Scheduled" IMAP folder). No build.

¹ **Rebuilt — the Phase-0 follow-up + a real bug:** SMTP had a 4th inline copy of the Bridge-TLS decision tree that didn't reuse `buildBridgeTlsConfig`, AND it omitted IPv6 loopback `::1` from its localhost check (host `::1` → full-validation TLS against Bridge's self-signed cert → connection failure). Refactored `initializeTransporter` to call `buildBridgeTlsConfig` (kills the 4th copy + fixes `::1` in one move), preserving SMTP's deferred-init via try/catch. Also fixed the same `::1` omission in the IMAP IDLE socket path.

² **Rebuilt:** `forward_email` dropped the original `inReplyTo`/`references` (broke thread continuity — `reply_to_email` carried them); now threaded. The embedded original From/To in the quoted header are CRLF-stripped. Both reply + forward now LOG a `setFlag` (`\Answered`/`$Forwarded`) failure instead of silently swallowing it.

## Phase 7 — System / Connection / Auth (`refactor/phase7-system-auth`) — FINAL

| Function | File | Avg | Verdict |
|---|---|---|---|
| `ensureConnection` + `reconnect` + `healthCheck` | simple-imap-service.ts | 9.8 | PASS |
| `connect` | simple-imap-service.ts | 9.2 | PASS |
| per-agent gate + OAuth automatic-consent | index.ts / grant-manager.ts | 9.0 | PASS |
| `startIdle` + `runIdleLoop` | simple-imap-service.ts | 9.0 | REBUILT → PASS¹ |
| startup credential resolution | index.ts / registry.ts / keychain.ts | 7.4 | REBUILT → PASS² |

¹ **Rebuilt — multi-account IDLE:** `startIdle()` ran only for the ACTIVE account at boot, so a non-active account never received INBOX EXISTS/EXPUNGE push invalidations (degraded to manual syncs). Now IDLE starts for **every** account at boot (`accountManager.list()`), and a runtime account change rebuilds then warms only that account. `startIdle` is idempotent and every account watches from boot. (The transient-throttle detection still uses free-text regex on Bridge error messages; a `classifyError` `throttled` category would be more robust.)

² **Rebuilt — credential isolation:** the former legacy-key broadcast path was removed entirely. Each account now reloads only its own keychain-backed credentials from the registry; Settings updates the active account through that registry and the manager rebuilds before the UI claims a live change. Per-account keychain entries remain authoritative, with the legacy key only as the `primary` fallback when no account-specific entry exists. A keychain miss still preserves config-plaintext compatibility. Tests cover per-account precedence, scoped live refresh, and the no-broadcast invariant.

### PR #192 reviewer fixes (CodeQL + Copilot)
- `stripHtml` block-strip now matches `</script\s*>` / `</style\s*>` (trailing
  whitespace close tag could bypass the strip — CodeQL bad-HTML-filtering).
- `connect()` `isLocalhost` now includes IPv6 loopback `::1`, matching
  `buildBridgeTlsConfig` (host `::1` previously got a localhost TLS config but a
  non-localhost implicit-TLS `secure` default).
- Removed now-unused `ParsedMail`/`AddressObject` type imports from the service.
