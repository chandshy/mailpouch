# Quality Audit Ledger

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

### PR #192 reviewer fixes (CodeQL + Copilot)
- `stripHtml` block-strip now matches `</script\s*>` / `</style\s*>` (trailing
  whitespace close tag could bypass the strip — CodeQL bad-HTML-filtering).
- `connect()` `isLocalhost` now includes IPv6 loopback `::1`, matching
  `buildBridgeTlsConfig` (host `::1` previously got a localhost TLS config but a
  non-localhost implicit-TLS `secure` default).
- Removed now-unused `ParsedMail`/`AddressObject` type imports from the service.
