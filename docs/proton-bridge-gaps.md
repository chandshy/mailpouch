# Proton Bridge — Gaps Analysis

This document compares what Proton Bridge actually provides (as documented in the other files in this directory) against what the MCP server at `R:/Code/protonmail-mcp-server/src/` currently implements. Items are ordered roughly by priority.

---

## 1. Bridge-Specific Features Not Implemented

### 1.1 No Detection of Bridge Running State — ✅ RESOLVED

**Resolution**: `isBridgeReachable()` was added to `src/index.ts`. On startup, `main()` probes both `config.smtp.host:config.smtp.port` and `config.imap.host:config.imap.port` via TCP before attempting IMAP/SMTP connections. A clear warning is logged if Bridge is unreachable — the server still starts and tools fail gracefully rather than crashing.

---

### 1.2 Split Mode Not Supported — OPEN

**Gap**: The MCP server assumes combined address mode (one credential set for all addresses). Split mode — where each Proton address gets its own IMAP account with separate credentials — is not supported. Users with multiple Proton addresses who use split mode cannot configure the MCP server to access a specific address.

**What Bridge provides**: In split mode, each address has distinct IMAP credentials and a completely separate mailbox hierarchy.

**Location of gap**: `src/config/schema.ts` `ConnectionSettings` has only one username/password pair. `src/types/index.ts` `ProtonMailConfig` has single `smtp` and `imap` configs.

**Actionable fix**: Either document "combined mode required" prominently, or add a `splitModeAccounts` array in `ConnectionSettings` to support multiple address/password pairs and route IMAP connections accordingly.

---

### 1.3 No SMTP Token for Bridge Connections — ✅ RESOLVED (by design)

**Resolution**: Confirmed correct by design. The `smtpToken` config field exists for direct `smtp.protonmail.ch` connections only; it is not used for Bridge connections (`isLocalhost` check in `smtp-service.ts`). The settings UI and docs now clarify this distinction.

---

### 1.4 No Support for `proton.me` vs `protonmail.com` Address Disambiguation — ✅ RESOLVED (by guidance)

**Resolution**: The settings UI displays guidance that the username must match the account's primary address exactly. No code change required — this is a user-education issue.

---

## 2. IMAP Behavioral Gaps

### 2.1 `getEmailById` Searches All Folders — Expensive and Fragile — OPEN (partial)

**Gap**: `getEmailById()` searches all IMAP folders sequentially on cache miss. This is architecturally necessary due to IMAP's per-mailbox UID scope, but remains O(N folders) on cache miss. The `setCacheEntry` and flag-update paths keep the cache up to date after operations, reducing cache misses.

**Status**: Cache TTL (5 minutes), UIDVALIDITY tracking, and cache-aware bulk operations reduce the practical frequency of full-folder scans. Full resolution would require a `(uid → folder)` index map.

---

### 2.2 No Body-Text / Full-Text Search — OPEN

**Gap**: `search_emails` does not support body content search. Proton Bridge does not index message bodies for IMAP SEARCH. The `query` field in `SearchEmailOptions` exists but is documented as ignored (Bridge does not support it).

**Status**: The `query` field is documented as unsupported. Tool description for `search_emails` notes that body-text filtering is not available. No further action without implementing client-side full-text search.

---

### 2.3 Labels / Folders Shown as Duplicates in Folder Listing — ✅ RESOLVED

**Resolution**: `getFolders()` now annotates each folder with `folderType: 'system' | 'user-folder' | 'label'`. The `list_labels` tool filters for `Labels/` prefix. The `get_folders` tool returns all folders with type annotations so agents can distinguish system, user, and label folders.

---

### 2.4 Inbox Listing Fetches Full Source (Expensive) — ✅ RESOLVED

**Resolution**: `getEmails()` now fetches only `envelope`, `bodyStructure`, `flags`, `uid`, and `bodyParts: ['1']` (text preview). It does NOT use `source: true`. Attachment metadata is extracted from `bodyStructure` without downloading binary content. Full source is fetched only in `getEmailById()` when the full message is needed.

---

### 2.5 No IDLE / Real-Time Event Support — OPEN (partial)

**Gap**: Bridge does not implement IMAP IDLE. The MCP server now has a background polling loop in `main()` (gated on `config.autoSync && config.syncInterval > 0`) that calls `getEmails('INBOX', 50)` and `getEmails('Sent', 50)` at the configured interval, keeping the analytics cache warm.

**Status**: Background polling implemented. True push notification is not possible without IDLE support.

---

### 2.6 Cache Staleness on Flag Updates — ✅ RESOLVED

**Resolution**: Email cache entries now include a `cachedAt` timestamp. `getCacheEntry()` evicts entries older than `CACHE_TTL_MS` (5 minutes). External flag changes will be picked up after the TTL expires.

---

### 2.7 Bulk Operations Are Not Atomic and Per-Email Rather Than Range-Based — ✅ RESOLVED

**Resolution**: `bulkMoveEmails()` and `bulkDeleteEmails()` now group emails by source folder and issue a single UID-set `messageMove`/`messageDelete` per folder (e.g., `"123,456,789"`). Per-email fallback is used only when the batch operation fails.

---

## 3. Settings UI Gaps

### 3.1 TLS Mode Toggle Not Exposed — ✅ RESOLVED

**Resolution**: `tlsMode?: 'starttls' | 'ssl'` was added to `ConnectionSettings` in `src/config/schema.ts`. `main()` in `src/index.ts` now reads `cn.tlsMode` and sets `config.smtp.secure` and `config.imap.secure` accordingly (`true` for `'ssl'`, `false` for `'starttls'`). `SimpleIMAPService.connect()` now accepts a `secure` parameter and passes it to ImapFlow, overriding the `!isLocalhost` default.

---

### 3.2 No UI Guidance on Bridge Certificate Path — ✅ RESOLVED (partially)

**Resolution**: Settings UI includes a `bridgeCertPath` field. Platform-specific hints for the cert path are documented in the settings wizard. Full guidance is provided at setup.

---

### 3.3 Port Fields Have No "Restore Defaults" Button — OPEN

**Gap**: No quick way to restore default ports (1025, 1143) in the settings UI.

**Actionable fix**: Add a small "Reset to defaults" link next to the port fields.

---

### 3.4 No Combined vs Split Mode Selection — OPEN

**Gap**: The settings UI has no concept of combined vs split mode.

**Actionable fix**: Add a note explaining "Connect in combined mode — all your Proton addresses share one inbox."

---

## 4. Security Considerations Not Yet Addressed

### 4.1 `insecureTls` Flag Is Exposed But Not Surfaced to the User Prominently — ✅ RESOLVED

**Resolution**: `get_connection_status` now includes `insecureTls: boolean` in both the `smtp` and `imap` status objects. A warning text is appended to the response when either service is running with certificate validation disabled. Users and agents are informed when operating in an insecure mode.

---

### 4.2 Credential Wipe Does Not Cover All Code Paths — ✅ RESOLVED

**Resolution**: `gracefulShutdown()` in `src/index.ts` now calls `imapService.wipeCache()`, `analyticsService.wipeData()`, and `smtpService.wipeCredentials()` before exiting. A `process.on('exit')` handler provides a last-resort wipe on any exit path. The top-level `config.smtp.password`, `config.imap.password`, and `config.smtp.smtpToken` fields are also zeroed.

---

### 4.3 Scheduler Store Contains Plaintext Email Content — ✅ RESOLVED (mode 0600)

**Resolution**: `SchedulerService.persist()` now calls `chmodSync(this.storePath, 0o600)` after each write, ensuring the scheduler store file has owner-only read/write permissions. The `writeFileSync` call also uses `mode: 0o600`. Full at-rest encryption is not implemented; the 0600 mode is the documented mitigation.

---

### 4.4 No Rate Limiting on IMAP Operations — ✅ RESOLVED

**Resolution**: The `supervised` preset in `buildPermissions()` (in `src/config/loader.ts`) now sets `get_emails` to 60/hr, `search_emails` to 30/hr, and `get_email_by_id` to 200/hr.

---

## 5. Performance Considerations

### 5.1 `getEmails` Downloads Full MIME for All Messages — ✅ RESOLVED

**Resolution**: See 2.4 above. `getEmails()` now uses envelope + bodyStructure + bodyParts['1'] only.

### 5.2 `getEmailById` Cross-Folder Search on Cache Miss — OPEN (partially mitigated)

See 2.1 above. Cache hits avoid cross-folder search; cache misses still scan all folders.

### 5.3 Analytics Cache Uses Full Email Objects — ✅ RESOLVED

**Resolution**: `trimForAnalytics()` in `src/index.ts` strips `body` and attachment binary content before storing in `analyticsCache` and calling `analyticsService.updateEmails()`. Only headers, dates, and attachment metadata are retained.

### 5.4 Multi-Folder Search Uses `Promise.allSettled` in Parallel — OPEN

**Gap**: Concurrent mailbox lock acquisitions in parallel multi-folder search may produce unexpected behavior with imapflow. Mitigated in practice because imapflow's lock queue serializes concurrent lock requests, but sequential iteration would be safer.

---

## 6. Missing Features That Bridge Supports

### 6.1 No `\Answered` Flag Support — ✅ RESOLVED

**Resolution**: After a successful reply in `reply_to_email`, `imapService.setFlag(emailId, '\\Answered')` is called. The `setFlag()` method was added to `SimpleIMAPService` and handles flag add/remove for arbitrary IMAP flags.

---

### 6.2 No `$Forwarded` Flag Support — ✅ RESOLVED

**Resolution**: After a successful forward in `forward_email`, `imapService.setFlag(fwdId, '$Forwarded')` is called. Uses the same `setFlag()` method as `\Answered`.

---

### 6.3 Draft Editing / Update Not Supported — OPEN

**Gap**: `save_draft` always appends a new draft. No `update_draft` or `delete_draft` tool exists.

**Actionable fix**: Add an optional `draftId` parameter to `save_draft`; if provided, delete the existing draft UID before appending the new version.

---

### 6.4 No Move-to-Label as Proton "Apply Label" — ✅ RESOLVED

**Resolution**: `move_to_label` now uses `copyEmailToFolder()` (IMAP COPY) instead of `moveEmail()` (IMAP MOVE). `remove_label` uses `deleteFromFolder()` to delete the copy from `Labels/<name>`. This matches Proton's label model: the original email stays in its primary folder while a copy appears in the label folder. `copyEmailToFolder()` and `deleteFromFolder()` were added to `SimpleIMAPService`.

---

### 6.5 No `All Mail` / All-Messages View — OPEN (documented)

**Gap**: The `All Mail` IMAP folder is exposed by Bridge but not specially documented in tool descriptions.

**Status**: `All Mail` is included in the protected folder list in `deleteFolder()`/`renameFolder()` and in the `SYSTEM_PATHS` set in `getFolders()`.

---

## 7. Miscellaneous / Other Gaps

### 7.1 `SearchEmailOptions.query` Field Is Dead Code — OPEN (documented)

**Status**: The `query` field is documented with `// NOTE: Bridge does not support server-side full-text search; this field is ignored` in `src/types/index.ts`. No functional change; the dead-field warning is in the code comment.

---

### 7.2 `autoSync` and `syncInterval` Config Fields Are Unused — ✅ RESOLVED

**Resolution**: `main()` now starts a background `setInterval` loop (gated on `config.autoSync && config.syncInterval > 0`) that calls `getEmails('INBOX', 50)` and `getEmails('Sent', 50)` and updates the analytics service. The timer uses `.unref()` to avoid blocking clean process exit.

---

### 7.3 `get_connection_status` IMAP Check Is Flag-Based Only — ✅ RESOLVED

**Resolution**: The `get_connection_status` handler now calls `await imapService.healthCheck()` (which sends a NOOP command) for the `healthy` field, in addition to `imapService.isActive()` for the `connected` flag. Both are included in the response.

---

### 7.4 No Handling of Bridge UIDVALIDITY Changes — ✅ RESOLVED

**Resolution**: `SimpleIMAPService` now maintains a `uidValidityMap: Map<string, number>` (one entry per folder). `checkAndUpdateUidValidity()` is called after each `getMailboxLock()` in `getEmails()` and `getEmailById()`. If UIDVALIDITY changes for a folder, the entire email cache is invalidated.

---

### 7.5 Attachment Content Stored in emailCache Could Be Gigabytes — ✅ RESOLVED

**Resolution**: `setCacheEntry()` strips attachment binary content (`content: undefined`) before caching. `downloadAttachment()` re-fetches the full email source via `fetchEmailFullSource()` on demand when attachment content is needed. The email cache now holds only metadata and text bodies.

---

### 7.6 No Connection Timeout on IMAP `connect()` — ✅ RESOLVED

**Resolution**: `connectionTimeout: 30000` (30 seconds) was added to the ImapFlow constructor in `SimpleIMAPService.connect()`.

---

### 7.7 Missing `credentialStorage` Indicator in Settings — OPEN

**Gap**: The `credentialStorage: "keychain" | "config"` field is saved to the config but not displayed in the settings UI.

---

## 8. New Gaps Tracked and Resolved

### 8.1 Full-text Body Search — ✅ RESOLVED

**Resolution**: `body` and `text` search parameters added to `search_emails`. Client-side filtering on fetched email bodies is performed when these fields are provided, since Proton Bridge does not support server-side IMAP SEARCH on body content.

---

### 8.2 IMAP IDLE Push Invalidation — ✅ RESOLVED

**Resolution**: `startIdle()` and `stopIdle()` methods added to `SimpleIMAPService`. A background IDLE loop maintains a persistent INBOX watch connection; on `exists` or `expunge` events the INBOX portion of the email cache is invalidated immediately. `startIdle()` is called in `main()` after IMAP connection is established; `stopIdle()` is called in `gracefulShutdown()`.

---

### 8.3 Encryption Detection (`isSignedPGP` / `isEncryptedPGP`) — ✅ RESOLVED

**Resolution**: `isSignedPGP` and `isEncryptedPGP` flags added to `EmailMessage`. These are derived from the `X-Pm-Content-Encryption` header exposed by Proton Bridge on fetched messages.

---

### 8.4 `\Forwarded` Flag Exposed in EmailMessage — ✅ RESOLVED

**Resolution**: `isForwarded` field added to `get_email_by_id` outputSchema and tool descriptions. The field reflects the `$Forwarded` IMAP flag set by `forward_email`.

---

### 8.5 `X-Pm-Internal-Id` Exposed as `protonId` — ✅ RESOLVED

**Resolution**: `protonId` field added to `EmailMessage` to surface the Proton-internal message ID from the `X-Pm-Internal-Id` / `X-Pm-Message-Id` header, useful for deduplication.

---

### 8.6 Proton Native Scheduled Folder — ✅ RESOLVED

**Resolution**: `list_proton_scheduled` tool added. Reads the `All Scheduled` (or `Scheduled`) IMAP folder exposed by Proton Bridge for emails natively scheduled via the Proton web/mobile app. Distinct from `list_scheduled_emails` which lists MCP-scheduler-managed emails.

---

### 8.7 Additional Search Criteria — ✅ RESOLVED

**Resolution**: `bcc`, `answered`, `draft`, `larger`, `smaller`, `sentBefore`, and `sentSince` search parameters added to `search_emails` inputSchema and `SearchEmailOptions`, enabling richer IMAP SEARCH queries where Bridge supports them.

---

## Summary Table

| # | Gap | Status |
|---|-----|--------|
| 1.1 | No Bridge-running detection | ✅ RESOLVED — `isBridgeReachable()` probe in `main()` |
| 1.2 | No split mode support | OPEN — requires multi-account config |
| 1.3 | SMTP token confusion in UI | ✅ RESOLVED — by design (token only for non-Bridge) |
| 1.4 | `@proton.me` vs `@protonmail.com` confusion | ✅ RESOLVED — settings UI guidance |
| 2.1 | Cross-folder UID search expensive | OPEN (partially mitigated by cache) |
| 2.2 | No body-text SEARCH | OPEN — Bridge limitation; `query` field documented as ignored |
| 2.3 | Label duplication in folder list | ✅ RESOLVED — `folderType` annotation added |
| 2.4 | Full-source fetch for list view | ✅ RESOLVED — envelope+bodyParts only |
| 2.5 | No polling / autoSync not wired | ✅ RESOLVED — background interval in `main()` |
| 2.6 | Cache staleness | ✅ RESOLVED — 5-minute TTL on cache entries |
| 2.7 | Bulk ops per-email, not range-based | ✅ RESOLVED — UID-set batch operations |
| 3.1 | TLS mode not exposed in settings | ✅ RESOLVED — `tlsMode` in config schema + applied in `main()` |
| 3.2 | No cert path hints in UI | ✅ RESOLVED — platform hints in settings wizard |
| 3.3 | Port fields have no reset button | OPEN |
| 3.4 | No combined vs split mode selection | OPEN |
| 4.1 | insecureTls not surfaced | ✅ RESOLVED — included in `get_connection_status` response |
| 4.2 | analyticsCache not wiped on shutdown | ✅ RESOLVED — wipe in `gracefulShutdown()` |
| 4.3 | Scheduler store not encrypted | ✅ RESOLVED (mode 0600) — full encryption not implemented |
| 4.4 | No rate limits on IMAP reads | ✅ RESOLVED — supervised preset limits |
| 5.1 | Full MIME download for listing | ✅ RESOLVED — envelope+bodyParts only |
| 5.3 | Analytics cache stores full bodies | ✅ RESOLVED — `trimForAnalytics()` strips bodies |
| 5.4 | Multi-folder search parallel locks | OPEN — imapflow serializes internally |
| 6.1 | No `\Answered` flag on reply | ✅ RESOLVED — `setFlag('\\Answered')` after reply |
| 6.2 | No `$Forwarded` flag on forward | ✅ RESOLVED — `setFlag('$Forwarded')` after forward |
| 6.3 | Draft editing not supported | OPEN |
| 6.4 | move_to_label uses MOVE not COPY | ✅ RESOLVED — COPY+DELETE semantics |
| 6.5 | No All Mail documentation | OPEN (partially — in protected folder list) |
| 7.1 | `query` field is dead code | OPEN — documented as ignored in types |
| 7.2 | autoSync config unused | ✅ RESOLVED — background poll in `main()` |
| 7.3 | get_connection_status uses flag not NOOP | ✅ RESOLVED — `healthCheck()` used |
| 7.4 | No UIDVALIDITY change detection | ✅ RESOLVED — `uidValidityMap` + cache invalidation |
| 7.5 | Attachment buffers in cache = OOM risk | ✅ RESOLVED — content stripped in `setCacheEntry()` |
| 7.6 | No connection timeout on IMAP connect | ✅ RESOLVED — `connectionTimeout: 30000` |
| 7.7 | credentialStorage not shown in UI | OPEN |
