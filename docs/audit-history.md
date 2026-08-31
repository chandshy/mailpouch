# Historical Audit Index

This compact index preserves the identifiers and dispositions from the
2026-05-28 full-repository audit. The archived
[evidence ledger](audit-2026-05-28.md) retains the original descriptions,
reproduction hypotheses, and resolution notes.

All findings were triaged before the v3.0.64 closeout. “Acknowledged” means the
behavior was explicitly retained with a documented rationale; it does not mean
the item was missed. Current source, tests, and security documentation remain
authoritative.

| ID | Finding | Disposition |
|---|---|---|
| `IMAP-001` | `runIdleLoop` silently downgrades to `rejectUnauthorized:false` when the user required a pinned Bridge cert | Resolved |
| `IMAP-002` | Unbounded UID set in single IMAP command exceeds Bridge's command-buffer cap | Resolved |
| `IMAP-003` | `bulkMarkRead` / `bulkStar` / `bulkCopyToFolder` silently default to INBOX on cache miss | Resolved |
| `IMAP-006` | UID FETCH preflight inside lock pretends a server error means "all UIDs missing" | Resolved |
| `IMAP-008` | `setFlag` lacks `findExistingUidsInLockedFolder` preflight — silent no-op restored for cache-hit paths | Resolved |
| `IMAP-004` | Unsanitised header search field/value enables IMAP SEARCH injection | Resolved |
| `IMAP-005` | `evictCacheEntry` for IDLE EXISTS/EXPUNGE mutates Map mid-iteration | Resolved |
| `IMAP-007` | `parsed.to`/`parsed.cc` can be an array of `AddressObject`; the code only handles the singular shape | Resolved |
| `IMAP-009` | `setFlag` does not accept `sourceFolder`, so the cross-folder UID hint plumbing is incomplete | Resolved |
| `IMAP-010` | `checkAndUpdateUidValidity` swallows every error | Resolved |
| `IMAP-012` | `getEmails` returns silently empty on connection lost; obscures errors to the caller | Resolved |
| `IMAP-014` | `protectedFolders` list uses literal English names; sees through localised special-use mailboxes | Resolved |
| `IMAP-016` | `messageDelete` per-UID retry path issues N EXPUNGEs in sequence on Bridge, blocking IDLE | Resolved |
| `IMAP-011` | `expandImapSequence` accepts comma/colon input with no validation; NaN propagates | Resolved |
| `IMAP-013` | `findDraftsFolder` swallows `getFolders` exceptions, falls back to literal `'Drafts'` | Resolved |
| `IMAP-015` | `validateEmailId` allows arbitrary-length decimal strings; UIDs > 2³² are silently meaningless | Resolved |
| `IMAP-018` | `getEmails` bodyPart `'1'` extraction is a heuristic that breaks on `text/html`-only emails | Resolved |
| `IMAP-019` | `disconnect()` calls `logout()` without a try/catch — error path leaves `client` non-null + `isConnected=true` | Resolved |
| `IMAP-020` | Search criteria string truncation is too aggressive: `\` removal can change semantic meaning | Acknowledged |
| `IMAP-022` | `getFolders` issues one `STATUS` per folder serially; bottleneck on accounts with many labels | Resolved |
| `IMAP-017` | IDLE handlers reference cache by raw `id` variable but the value is a `folder:uid` key — variable shadows the UID concept | Acknowledged |
| `IMAP-021` | `bridgeVersion` field is public-writable; not marked `private` or `readonly` | Acknowledged |
| `SMTP-001` | `persist()` race: scheduler write during in-flight `sendMail()` can lose newly-arrived items | Resolved |
| `SMTP-002` | Send-after-cancel TOCTOU: `cancel()` returns true after `sendEmail` started | Resolved |
| `SMTP-003` | `processDue` retry loop has no backoff between attempts on a single item | Resolved |
| `SMTP-004` | `retryCount` bumped before send actually fails to commit, but `persist()` only fires after the whole loop | Resolved |
| `SMTP-005` | Reminder `persist()` uses non-atomic cross-device rename | Resolved |
| `SMTP-006` | Reminder `persist()` exception is unhandled — corrupts in-memory state | Resolved |
| `SMTP-007` | `scanDue()` is destructive and not idempotent under partial-write failure | Resolved |
| `SMTP-011` | `saveDraft` falls back to literal "Drafts" path with no existence check | Resolved |
| `SMTP-012` | `saveDraft` does not strip CRLF from `subject` like SMTP path does | Resolved |
| `SMTP-008` | `processDue` "isProcessing" guard skips items silently across overlapping ticks | Resolved |
| `SMTP-009` | `reply_to_email` sends with subject that bypasses `MAX_SUBJECT_LENGTH` | Resolved |
| `SMTP-010` | `forward_email` does NOT sanitize `args.message` before splicing into body | Resolved |
| `SMTP-013` | `send_email` allows missing subject; `subject` is `required` in the input schema but the handler does not enforce it | Resolved |
| `SMTP-014` | `parseEmails` silently drops invalid addresses; recipient count can fall below caller's intent | Resolved |
| `SMTP-015` | `BackoffTracker` is per-SMTPService, but `processDue` iterates items synchronously: a backoff trip blocks the rest of the batch | Resolved |
| `SMTP-016` | `remind_if_no_reply` fetches by UID without confirming the message lives in the requested folder | Acknowledged |
| `SMTP-018` | `MAX_HISTORY_RECORDS` / `MAX_HISTORY_AGE_MS` only enforced on `load()`, not on persist | Resolved |
| `SMTP-017` | `_resetBridgeCertPinsForTests` is exported from production code | Acknowledged |
| `SMTP-019` | `tracer.spanSync` callbacks not indented, breaking visual block structure | Acknowledged |
| `SMTP-020` | `escapeHtml` does not escape apostrophe; safe to use in attribute-free contexts only | Resolved |
| `XPORT-002` | Phishable `client_name` in DCR endpoint enables consent-screen spoofing | Resolved |
| `XPORT-001` | Static bearer token forces all callers into one shared rate-limit bucket | Resolved |
| `XPORT-003` | OAuth consent page lacks clickjacking protection | Resolved |
| `XPORT-006` | OAuth dispatch uses socket-only IP, mismatching the loopback-XFF model | Resolved |
| `XPORT-007` | POST `/oauth/authorize` trusts form-supplied `code_challenge`, `state`, `resource` | Resolved |
| `XPORT-008` | Consent POST has no Origin/Referer or CSRF check | Resolved |
| `XPORT-009` | DCR `redirect_uri` accepts any URL scheme including `javascript:`/`data:`/`file:` | Resolved |
| `XPORT-015` | Plain HTTP allowed with arbitrary bind host; no warning at startup | Resolved |
| `XPORT-004` | Token endpoint leaks resource/redirect/PKCE-mismatch via `invalid_target` | Resolved |
| `XPORT-005` | Token verification skips constant-time compare; relies on Map hashing for token entropy | Resolved |
| `XPORT-010` | Health endpoint reveals OAuth-enabled flag without auth | Resolved |
| `XPORT-011` | Missing security headers on transport responses | Resolved |
| `XPORT-016` | OAuth `state` validation length-only; no character filtering | Resolved |
| `XPORT-017` | Resource indicator stored without validation | Resolved |
| `XPORT-018` | Caller logging includes attacker-supplied `client_name` verbatim | Resolved |
| `XPORT-021` | DCR endpoint has no per-IP grant cap; pending-grant flood possible | Resolved |
| `XPORT-013` | `tokensByClient` reverse-index counter overcount on stale set | Resolved |
| `XPORT-014` | `extractBearer` regex collapses whitespace; trailing-whitespace handling inconsistent | Resolved |
| `XPORT-012` | Subscription leak when `oauthEnabled` is set but admin password missing | Resolved |
| `XPORT-019` | Tests assert behavior with no host warning for non-loopback bind | Acknowledged |
| `XPORT-020` | `runWithCaller` doesn't include OAuth scope/resource on the caller context | Acknowledged |
| `XPORT-022` | Naming nits in transport | Acknowledged |
| `PERM-002` | Escalation approval applies globally, not to the requesting agent | Resolved |
| `PERM-003` | Per-tool rate-limit bypass via `bulk_delete` ↔ `bulk_delete_emails` alias | Resolved |
| `PERM-004` | `move_email` bypasses destructive-confirm via `targetFolder: "Trash"`/`"Spam"` | Resolved |
| `PERM-001` | Per-call escalation tools bypass agent-grant, permission, destructive-confirm, AND audit log | Resolved |
| `PERM-005` | Default-allow when tool name is missing from the loaded `tools` map | Resolved |
| `PERM-006` | Audit log + pending-file rename not lock-protected across processes | Resolved |
| `PERM-007` | Race between gate decision and tool execution allows TOCTOU widening | Resolved |
| `PERM-008` | Static-bearer token treated as fully trusted: no per-agent grant check, no audit row | Resolved |
| `PERM-009` | `clientName` is attacker-controlled and rendered to settings UI | Resolved |
| `PERM-011` | Folder allowlist bypassable via tools that don't expose a folder arg | Resolved |
| `PERM-013` | `intersectPresets` ranks `custom` equal to `full` | Resolved |
| `PERM-010` | `recordCall` mutates in memory but never flushes | Resolved |
| `PERM-012` | Audit log on rotation drops in-flight buffer between read and truncate | Resolved |
| `PERM-014` | `requestEscalation` race: two parallel callers each push a "pending" record | Resolved |
| `PERM-015` | Supervised rate-limit prefix-match misses non-`bulk_` mass tools | Resolved |
| `PERM-016` | `pass_get` is destructive-gated but `pass_search`/`pass_list` return names/URLs without confirm | Acknowledged |
| `TOOL-001` | `search_emails` blindly casts `args.folders` to `string[]` without runtime check | Resolved |
| `TOOL-002` | `request_permission_escalation` accepts missing `reason` despite schema declaring it required | Resolved |
| `TOOL-003` | `get_contacts` accepts negative `limit` and passes it to `Math.min` | Resolved |
| `TOOL-004` | `get_volume_trends` does not validate `days` is positive/finite | Resolved |
| `TOOL-008` | `get_correspondence_profile` may report "no prior correspondence" for known contacts | Resolved |
| `TOOL-025` | `get_email_by_id` mutates the cached `email` object before returning | Resolved |
| `TOOL-005` | `get_logs` NaN-propagates through Math.trunc/min/max | Resolved |
| `TOOL-006` | `alias_list` / `alias_get_activity` NaN pageSize passes the clamp | Resolved |
| `TOOL-007` | `alias_create_custom` accepts empty-string `aliasPrefix`/`signedSuffix` | Resolved |
| `TOOL-009` | `fts_search` does not validate `limit`/`sinceEpoch` ranges | Resolved |
| `TOOL-014` | `start_bridge` returns success-shaped result when ports never came up | Resolved |
| `TOOL-015` | `get_email_by_id`, `extract_action_items`, `extract_meeting`, `get_thread` cast `args.folder` without runtime type check | Resolved |
| `TOOL-016` | `search_emails` validates length only for `from`/`to`/`subject`, not `body`/`text`/`bcc` | Resolved |
| `TOOL-017` | `search_emails` coerces non-string `sentBefore`/`sentSince` via `new Date(args... as string)` | Resolved |
| `TOOL-012` | Late-group reading tools use `email_id` while early group uses `emailId` | Acknowledged |
| `TOOL-013` | `fts_rebuild` `_ftsRebuilding` flag is module-global, breaks multi-account | Resolved |
| `TOOL-020` | `shutdown_server`/`restart_server` audit row may be lost | Acknowledged |
| `TOOL-010` | `get_thread` outputSchema omits `messages` field shape match | Resolved |
| `TOOL-011` | `get_emails_by_label` outputSchema item type is a bare `object` | Resolved |
| `TOOL-018` | `get_connection_status` outputSchema has no `required` array | Resolved |
| `TOOL-019` | `fts_status` outputSchema missing `required: ["available"]` | Resolved |
| `TOOL-021` | `pass_get` outputSchema's `fields` map doesn't allow undefined | Resolved |
| `TOOL-022` | `check_escalation_status` `not_found` branch returns no `isError` | Acknowledged |
| `TOOL-023` | `clear_cache` claims to "clear all in-memory caches" but does not invalidate FTS handle | Resolved |
| `TOOL-024` | `get_emails_by_label` clamp order differs from `get_emails` | Resolved |
| `CRED-001` | `migrateCredentials()` migrates only `password` + `smtpToken`; `passAccessToken` and `simpleloginApiKey` remain plaintext on disk forever | Resolved |
| `CRED-002` | `_homeFile()` honors env-var overrides with zero containment check (path traversal hole) | Resolved |
| `CRED-003` | AES-GCM key derived via single SHA-256 over low-entropy inputs (no salt-stretching, no KDF) | Resolved |
| `CRED-006` | Auth-tag length not validated; truncated `authTag` is silently accepted by `setAuthTag` | Resolved |
| `CRED-007` | `saveConfig` writes 0o600 only on file creation; pass-audit and machine-id fallback never re-assert mode | Resolved |
| `CRED-008` | `loadConfig` cache breaks under concurrent writers — no file-lock anywhere | Resolved |
| `CRED-010` | `loadCredentialsFromKeychain` falls through to plaintext config when encrypted-blob decryption throws — masks compromise indicators | Resolved |
| `CRED-004` | `writeRegistry()` keychain-vs-plaintext detection brittle to future refactors | Resolved |
| `CRED-005` | `loadAccountCredentials` called twice per account in `readRegistryWithSecrets` | Resolved |
| `CRED-009` | Pass audit log is append-only by file mode only — not tamper-evident | Resolved |
| `CRED-011` | `re-encrypt v1 → v2` migration not atomic across the two credential fields | Resolved |
| `CRED-012` | SimpleLogin error path echoes upstream JSON verbatim — token leak risk | Resolved |
| `CRED-013` | Pass CLI child inherits `cwd`; pass-cli may write to attacker-writable dir | Resolved |
| `CRED-015` | `migrateCredentials()` does not deep-clone the config before mutate-and-save | Resolved |
| `CRED-014` | `SecureBuffer.toString()` allocates GC-tracked string, defeating wipe guarantee | Acknowledged |
| `VALID-001` | `getEmailById` and callers never validate `folderHint` | Resolved |
| `VALID-002` | `search_emails` does not length-cap or sanitise `body`/`text`/`bcc` | Resolved |
| `VALID-003` | Two `validateFolderName` functions with the same name and contradictory rules | Resolved |
| `VALID-005` | `saveDraft` has no attachment count or size cap (asymmetric to `sendEmail`) | Resolved |
| `VALID-006` | `validateAttachments` allows arbitrarily large `content` strings | Resolved |
| `VALID-009` | Tools that call `getEmailById(_, args.folder)` skip `validateTargetFolder` | Resolved |
| `VALID-015` | Tools coerce `args.attachments` via `as EmailAttachment[]` after structural-only validator | Resolved |
| `VALID-004` | Helpers `validateLabelName` and `validateFolderName` are byte-identical duplicates | Resolved |
| `VALID-007` | `validateLabelName`/`validateFolderName` miss DEL (\x7f) and C1 control range | Resolved |
| `VALID-008` | `requireNumericEmailId` accepts unbounded-length numeric strings and leading zeros | Resolved |
| `VALID-010` | `parseEmails` has no per-token length cap, exposes regex to large inputs | Resolved |
| `VALID-011` | Empty/whitespace `folderName` passes `validateTargetFolder`; redundant follow-up check inconsistent | Resolved |
| `VALID-012` | IMAP `validateFolderName` (private) doesn't reject leading/trailing whitespace or `&` escape | Resolved |
| `VALID-013` | `saveDraft` `inReplyTo` strips only `[\r\n\x00]` while `references` strips full `[\x00-\x1f\x7f]` | Resolved |
| `VALID-014` | `validateTargetFolder` length cap of 1000 lets through paths longer than the leaf cap of 255 | Resolved |
| `VALID-016` | `fts_search` accepts `folder` without any validation | Resolved |
| `VALID-017` | `sourceFolder` validator allows empty string by returning `null` (silent fall-back) | Resolved |
| `VALID-018` | `validateAttachments` filename allows any character including path separators | Resolved |
| `VALID-019` | `validateLabelName` rejects `/` but allows non-printable / non-ASCII that imapflow UTF-7 encodes | Resolved |
| `VALID-021` | `optionalSourceFolder` exists in two files and is duplicated | Resolved |
| `VALID-020` | `requireNumericEmailId` and IMAP-private `validateEmailId` produce different error shapes | Acknowledged |
| `PARSE-002` | FTS index has no folder-allowlist enforcement; snippets can leak from sensitive folders | Resolved |
| `PARSE-001` | `fts_search` propagates raw user query to FTS5 MATCH; malformed syntax raises uncaught exception | Resolved |
| `PARSE-003` | `fts_rebuild` clears the index before checking it can repopulate | Resolved |
| `PARSE-004` | `processContacts()` silently drops every new contact past the 10 000-cap including the largest senders | Resolved |
| `PARSE-005` | `calculateVolumeTrends` buckets by UTC ISO date; user-facing days drift by up to 24h | Resolved |
| `PARSE-010` | iCal `DTSTART;TZID=...:` parameter dropped on the floor | Resolved |
| `PARSE-014` | `downloadAttachment` re-fetches the full RFC 2822 source then base64-encodes the whole attachment in memory | Resolved |
| `PARSE-016` | `responseTimeStats` Message-ID lookup never normalizes angle brackets | Resolved |
| `PARSE-006` | `calculatePeakActivityHours` uses local-host `getHours()` while volume trends use UTC | Resolved |
| `PARSE-007` | `responseTimeStats.median` picks the upper-middle element for even-length arrays (off-by-one) | Resolved |
| `PARSE-008` | `stripHtml` unescapes entities AFTER tag-strip | Resolved |
| `PARSE-009` | `stripHtml` ignores HTML comments | Resolved |
| `PARSE-011` | iCal parser ignores `BEGIN:VEVENT` lines with parameters | Resolved |
| `PARSE-012` | `unfoldLines` first-line leading-whitespace handling | Resolved |
| `PARSE-013` | `MAX_BODY_BYTES` cap uses `body.slice(0, MAX_BODY_BYTES)` measured in chars after byte-length check | Resolved |
| `PARSE-015` | `extractAttachmentMeta`'s `att.size` is `number | undefined` but added unguarded | Resolved |
| `PARSE-017` | `inferOrganization` `'gov'` listed in both TLD and compound-SLD lists | Resolved |
| `PARSE-018` | `extractActionItems` dedup key punctuation-sensitive | Resolved |
| `PARSE-019` | `BULLET_RE` doesn't recognize `→`, `▪`, `‣`, or em-dash bullets | Resolved |
| `PARSE-020` | `extractEmailAddress` regex `/<([^>]+)>/` accepts the first angle-bracket pair anywhere | Resolved |
| `UI-001` | `<form onsubmit="return false">` inline handler is blocked by nonce'd script-src | Resolved |
| `UI-002` | Main settings CSP keeps `'unsafe-inline'` in `script-src` alongside the nonce | Resolved |
| `UI-003` | `/agent-setup` HTML serves `script-src 'unsafe-inline'; style-src 'unsafe-inline'` with no nonce | Resolved |
| `UI-005` | Settings UI bind retries 5×1 s and only warns; no fallback port, no signal to caller | Resolved |
| `UI-006` | `/api/shutdown` calls `process.exit(0)` without destroying tray subprocess | Resolved |
| `UI-007` | POST `/api/config` has a read-modify-write race with the MCP-side config writer | Resolved |
| `UI-009` | POST `/api/write-claude-desktop` overwrites a non-JSON config silently | Resolved |
| `UI-011` | Agent `approve` endpoint passes `conditions`/`toolOverrides` through without shape validation | Resolved |
| `UI-004` | Local `esc` helpers omit `>` and `'`, splitting the codebase's escaping contract | Resolved |
| `UI-008` | Desktop notifier subprocess has no timeout | Resolved |
| `UI-010` | `process.env.APPDATA ?? ""` falls through to relative paths on Windows when env is absent | Resolved |
| `UI-012` | Agent `approve`/`deny`/`revoke` and account `activate` skip the per-IP escalation rate-limit | Resolved |
| `UI-013` | Approve-with-conditions modal trusts client-decoded JSON in `data-conds` | Resolved |
| `UI-014` | Settings shell HTML served on path "/" even in LAN mode without the access token | Resolved |
| `UI-015` | Tray menu shows "Open Settings" when `_settingsUrl` is empty after a failed bind | Resolved |
| `UI-017` | Webhook dispatcher CloudEvents payload propagates raw `clientName` to every endpoint | Resolved |
| `UI-016` | Tab HTML builder treats string params as "already safe HTML" without type-system support | Acknowledged |
| `UI-018` | Audit-log `audit-event-` CSS class is built from `escHtml(e.event)` instead of an allowlist | Resolved |
| `TEST-001` | Default fetch mock turns the source-folder UID space into a wildcard | Resolved |
| `TEST-002` | `messageMove` mock ignores the source mailbox lock | Resolved |
| `TEST-003` | "Sanitizes" tests never inspect the sanitized output | Resolved |
| `TEST-004` | `reminder-service.prune()` test depends on wall-clock date | Resolved |
| `TEST-005` | Keychain suite has zero positive-path coverage | Resolved |
| `TEST-012` | 32 of 72 MCP tools have no E2E scenario coverage | Resolved |
| `TEST-006` | `imap-operations.test.ts` imports `beforeEach` but never uses it | Resolved |
| `TEST-007` | Mock drift in `getFolders` spy shape | Resolved |
| `TEST-008` | Agent-harness `expect(outcome).toBeDefined()` tests only that Bridge responded | Resolved |
| `TEST-009` | Permission-escalation test uses hardcoded `/tmp/test-pending-new.json` | Resolved |
| `TEST-010` | `MAILPOUCH_INSECURE_BRIDGE=1` global setup masks the strict TLS path | Acknowledged |
| `TEST-011` | Hardcoded Greenmail ports prevent parallel CI lanes | Acknowledged |
| `TEST-015` | Empty-array vs missing-array confusion in destructive-gate tests | Resolved |
| `TEST-013` | `fts-service.test.ts` silently degrades to zero coverage when sqlite is absent | Resolved |
| `TEST-014` | Agent-harness "discovery" test allows the tool surface to silently shrink | Resolved |
| `TEST-019` | Bridge-only `it.skip` calls form a parallel uncovered surface | Acknowledged |
| `TEST-024` | No test asserts `confirmed:true` gate at MCP layer (only the destructive call layer) | Resolved |
| `TEST-016` | `oauth-store.test.ts` mutates token internals to simulate expiry instead of mocking time | Resolved |
| `TEST-017` | `grant-store` prune tests backdate via `Date.now() - n*day` | Resolved |
| `TEST-018` | `analytics-service.test.ts` uses `toBeDefined` where shape matters | Resolved |
| `TEST-020` | E2E `smoke.e2e` "listTools" only spot-checks 4 names | Resolved |
| `TEST-021` | Bulk-action `errors[0]` string-matching assertions are over-loose | Resolved |
| `TEST-022` | No test asserts cache-key compound `folder:uid` format outside move/delete | Resolved |
| `TEST-023` | `test/integration.test.ts` is unit tests in disguise | Acknowledged |
| `TEST-025` | Harness retry budget is zero, so flakes look like real failures | Acknowledged |
| `BUILD-001` | `prepare` runs `npm run build` on every consumer install (publish-time-only intent) | Resolved |
| `BUILD-011` | `npm publish` workflow lacks `npm ci --ignore-scripts`; lifecycle scripts run with provenance signing keys in scope | Resolved |
| `BUILD-012` | Third-party GitHub Actions pinned to floating tags, not commit SHAs | Resolved |
| `BUILD-004` | `license-inv` baseline records `version: "(unknown)"` and `license: "UNKNOWN"` for legit prod deps | Resolved |
| `BUILD-002` | `npm-version-free` advisory check inverted on parse error | Resolved |
| `BUILD-003` | `npm audit` script may miscategorize advisories with `severity: unknown` | Resolved |
| `BUILD-005` | `license-inv` first-run silently writes the baseline *and* fails the gate | Resolved |
| `BUILD-006` | `tarball-smoke` only validates `--version` (skips `--omit=optional`); native-tray import path not exercised | Resolved |
| `BUILD-008` | `tsconfig.json` missing several strict-mode helpers | Resolved |
| `BUILD-009` | `package.json` ships `dist/**/*` blindly — includes `.d.ts.map`, `.js.map` with absolute source paths | Resolved |
| `BUILD-013` | `runSteps` halts but reports skipped steps without distinguishing from intentional skip | Resolved |
| `BUILD-014` | `docs/preship.md` claims `PRESHIP_SKIP=1 /ship` bypass exists; no code in this repo honors it | Resolved |
| `BUILD-015` | Pre-push hook (`preship:fast`) skips `tarball-smoke` and both E2E suites | Resolved |
| `BUILD-007` | `tarball-smoke` early-exit branches `process.exit(1)` skip the accumulator pattern | Resolved |
| `BUILD-010` | `overrides.fast-xml-parser` is a phantom — package isn't in the dep tree | Resolved |
| `BUILD-016` | `spawnNpmRun` passes `--silent` so failing output is suppressed | Resolved |
| `BUILD-017` | `spawnStep` merges `process.env` into child env unconditionally | Resolved |
| `BUILD-018` | `test:e2e:local` shell-chain swallows the `docker compose up -d` readiness wait | Resolved |
| `BUILD-019` | `engines.npm: ">=9.0.0"` enforced nowhere | Resolved |
| `BUILD-020` | `check-secrets` exclude list omits `test/**` where API-key-shaped fixtures live | Resolved |
| `BUILD-021` | `actions/setup-node` cache invalidation doesn't account for `overrides` changes | Acknowledged |
| `BUILD-022` | `lint` and `lint:fix` are both `tsc --noEmit`; preship's `lint` step is hardcoded `ok: true` | Acknowledged |
| `BUILD-023` | `publish-gpr` workflow mutates `package.json` in CI without revert | Resolved |
| `BUILD-024` | `mailpouch-settings` bin exposed publicly contradicts settings-UI lifecycle policy | Acknowledged |
| `BUILD-025` | `.gitignore` `/tmp/preship-pack-*` entries don't match anything | Resolved |
| `DOCS-009` | preship.md claims `npm-audit` hard-fails on HIGH/CRITICAL; orchestrator wraps it as `advisory` | Resolved |
| `DOCS-001` | README claims supervised deletion is capped at 5/hr; code caps at 20/hr | Resolved |
| `DOCS-002` | README claims shutdown_server/restart_server cap at 2/hr; code caps at 5/hr | Resolved |
| `DOCS-004` | HELP.md `fts_search` examples use `after:` arg that the schema does not accept | Resolved |
| `DOCS-005` | HELP.md `remind_if_no_reply` example uses non-existent `emailId`/`days` arg names | Resolved |
| `DOCS-006` | README_FIRST_AI.md documents non-existent `newTools` and wrong field names for escalation | Resolved |
| `DOCS-007` | HELP.md lists `.mailpouch-escalation-audit.jsonl` which never exists; mislabels `.mailpouch.audit.jsonl` | Resolved |
| `DOCS-010` | HELP.md "Require destructive confirmation" omits `delete_folder` | Resolved |
| `DOCS-003` | README "System" category tool count is 4; schema has 5 | Resolved |
| `DOCS-008` | README env-var table omits five `MAILPOUCH_*` knobs the code reads | Resolved |
| `DOCS-011` | docs/index.md "System / Bridge" row omits `get_server_version` | Resolved |
| `DOCS-012` | Schema's tier-comment internally inconsistent about core tool count | Resolved |

## Bridge capability quality program

The later Bridge-capability program was completed in eight phases:

1. Backbone and shared contracts
2. Folder discovery and classification
3. Read and fetch paths
4. Move, copy, delete, label, and empty Trash
5. Message flags and answered/forwarded state
6. IMAP and full-text search
7. Draft and send paths
8. System, connection, and authentication

Its detailed [per-review scorecard](quality-audit.md) remains archived. Shipped
behavior is described by the current source, tests, README, HELP, SECURITY, and
[2026-07-30 safety audit](audit-2026-07-30.md).
