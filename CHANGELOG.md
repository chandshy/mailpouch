# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.0.72] — 2026-05-31

### Changed — OAuth is now fully automatic; Approve/Deny is the only human gate (BREAKING for OAuth deployments)

- The OAuth `/authorize` **admin-password consent has been removed entirely.** Agents now authenticate **fully automatically** (DCR → PKCE-S256 → token, no human-typed password): a valid `GET /oauth/authorize` immediately issues a code and 302-redirects. The **only** human interaction is the per-agent **Approve `<agent>`? / Deny** in the Agents tab (auto-surfaced approval window). The issued token is **inert until the grant is approved**, so this moves the human gate rather than removing it. The security envelope is unchanged otherwise: PKCE binds the code to the agent's verifier, `redirect_uri` is allowlisted, and endpoints are rate-limited.
- **`remoteOauthAdminPassword` is deprecated and ignored** (a startup warning is logged if set). `remoteOauthEnabled: true` alone now enables OAuth in automatic-consent mode — no admin password to configure. The consent HTML page, the password `POST /oauth/authorize`, and the consent CSRF machinery were removed.
- **Pending approvals expire after 5 minutes.** If you don't Approve/Deny within 5 minutes, the request is deleted (any issued token revoked) and the agent must connect/auth again. Swept every 30s (`AgentGrantStore.expireStalePending`).
- `http.test.ts` OAuth suite rewritten to the auto-consent flow (GET → 302 with code → PKCE token exchange); password/CSRF/consent-page tests removed.

### Added — agents' MCP handshake connection info captured + shown in the Agents tab

- On the MCP `initialize` handshake, mailpouch now records the connecting agent's **self-reported MCP client name + version**, the **transport**, and a **last-connected** timestamp onto its grant, and shows them on the Agents-tab card (distinct from the DCR-supplied client name). Captured in the per-session `createSessionServer().oninitialized` hook via `server.getClientVersion()` + `currentCaller()`, persisted by a new no-mutation `AgentGrantStore.recordConnection()`. Display-only — **identity remains the stable server-issued OAuth `client_id`**, never the spoofable client name.
- This makes the register → one-time approve → remembered-on-reconnect → revocable flow (OAuth Dynamic Client Registration) show real connection info per agent. **Non-local agents must use OAuth** to register/appear/approve: set `connection.remoteMode: true` + `remoteOauthEnabled: true` + an admin password (`remoteOauthAdminPassword`, keychain preferred) in `~/.mailpouch.json` and restart. A shared **static bearer token has no per-agent identity, so bearer agents bypass registration by design** and won't appear — switch to OAuth for per-agent visibility/approval. (Bearer/stdio remain trusted/bypassing.)
- `grant-store` tests cover `recordConnection` (updates + persists handshake info; no-op for an unknown clientId).

### Added — approval window pops up when a new remote agent connects

- When a remote/HTTP (OAuth) agent registers (DCR), mailpouch now **auto-opens the Settings UI Agents tab in the browser** so the user can approve or deny the connection immediately — on top of the existing desktop notification + tray badge. The agent stays **blocked until approved** (the pending-grant gate already returns an actionable "pending user approval" error to the agent). Authentication between the agent and the server remains automatic (OAuth DCR + PKCE); the only human step is approve/deny.
- The pending agent's **registering IP and time** are captured at DCR and shown on its approval card, so the user has context to decide. (`AgentGrant.registeredFromIp`, threaded from the registration request via the `onClientRegistered` hook.)
- Auto-open is gated: only when a **display is present** (skipped on headless/remote hosts), the UI is up, and at most once per ~10s (a registration burst opens one tab, which lists all pending). Controlled by a new **`autoOpenApprovalWindow`** setting (default on) with a Setup-tab toggle. The settings UI gained `#agents` hash deep-linking (used by the auto-open and available for manual navigation).
- New `auto-open-approval.ts` pure decision helper + tests; `grant-store` test covers the persisted IP. Local stdio clients are unaffected (still auto-trusted); static-bearer clients still bypass the grant gate by design.

### Fixed — IMAP IDLE socket error crashed the whole process (primary "keeps crashing" cause)

- **Bug:** the background IMAP IDLE client (`runIdleLoop`, `src/services/simple-imap-service.ts`) was constructed with `'exists'`/`'expunge'` listeners but **no `'error'` listener**. `imapflow` extends `EventEmitter`, and an `EventEmitter` that emits `'error'` with no listener **throws synchronously** — which became an `uncaughtException`, and `src/index.ts` routes `uncaughtException`/`unhandledRejection` straight into `gracefulShutdown` → `process.exit`. IDLE sockets to a local Proton Bridge reset routinely (Bridge sleep/restart/session caps), so a single mid-IDLE socket reset took the entire MCP server down — the recurring crash. The main `connect()` path already attached `'error'`/`'close'` listeners; the IDLE client did not.
- **Fix:** attach `'error'` and `'close'` listeners to the IDLE client immediately after construction (before `connect()`). The existing reconnect loop (try/catch + exponential backoff) already recovers from the drop; the listeners only ensure the async socket error is *handled* instead of thrown.
- **Also fixed:** the Bridge watchdog `setInterval` callback (`startBridgeWatchdog`, `src/index.ts`) ran `await Promise.all([isBridgeReachable…])` and `await launchProtonBridge()` with **no outer try/catch** — a rejection there became an `unhandledRejection` → the same `gracefulShutdown` → exit, firing every 30s precisely while Bridge was flapping. Wrapped the whole tick body in try/catch.
- **Test:** `src/services/idle-error-listener.test.ts` asserts the IDLE client registers an `'error'` listener; verified to fail before the fix and pass after.

### Changed — updating credentials now flushes the old ones and reconnects (no restart)

- Saving a new Bridge password in Settings → Connection now takes effect **without a server restart**. Previously `applyKeychainCredentials` only refreshed SMTP and staged the IMAP password in the account spec — the live IMAP client kept using the old password until the process was restarted. Now the settings save also calls `AccountManager.reloadImapCredentials`, which for each affected account: tears down the main + IDLE clients (both still authed with the **old** password), loads the **new** password into the live connection config, clears the auth-failure stop (so tools stop fast-failing and the tray blink ends), and reconnects + restarts IDLE.
- Added an IDLE-loop **generation guard** (`_idleGen`) so a stop-then-restart during the reload can never leave two loops racing on the IDLE socket.
- The reconnect is fire-and-forget from the save handler (so the HTTP save response isn't blocked on a reconnect that may back off if Bridge is still throttling); the UI's "Check Now" surfaces the result. `idle-reconnect-policy.test.ts` covers the reload (new password loaded, auth-stop cleared, reconnected) and the generation bump.

### Added — tools return an actionable error when the connection is broken

- When an agent calls a mailbox tool while mailpouch can't connect, it now gets a clear, operator-actionable error instead of an opaque "IMAP operation failed" / hang — so the user knows exactly what to go fix. A new `ConnectionStateError` (`error-classify.ts`) is surfaced **verbatim** by `safeErrorMessage`.
  - **Login failure recorded** → every IMAP tool fast-fails (via `ensureConnection`) with *"mailpouch can't sign in to your Proton mailbox — … Open the mailpouch Settings UI → Connection, update the Bridge password, then restart mailpouch."* and **does not re-attempt the login** (so tool calls can't re-trip Bridge's "too many login attempts" lockout).
  - **Reconnect that fails on auth** records the failure (so later calls fast-fail and the tray blink kicks in) and returns the same guidance.
  - **Bridge unreachable** → *"mailpouch couldn't reach Proton Bridge — … Make sure Proton Bridge is running and signed in, then try again."*
  - **`send_email`** auth failures now return the same actionable message rather than a bare "Invalid login: 454 …".
- `idle-reconnect-policy.test.ts` covers the fast-fail (no reconnect attempt), the reconnect-auth path (records failure), and the Bridge-unreachable path.

### Added — tray icon blinks a red ⚠ triangle while the mail connection is failing

- When mailpouch can't maintain its IMAP connection (a login/credential failure, or an ongoing connection problem), the system-tray icon now **alternates between the normal envelope and a red warning triangle every 5 seconds**, and the tray tooltip shows the reason (e.g. the login-failed message). It restores to the steady normal icon automatically once the connection recovers. Driven by the `idleAuthFailure` / `idleLastIssue` state from the IDLE reconnect policy; the warning icon is generated in-code (`makeWarningIconPng`, no new asset) to match the existing zero-asset icon pipeline. The 5s timer is `unref`'d and cleared on shutdown.

### Changed — IDLE reconnect stops on a login failure; backs off on transient issues

- The IMAP IDLE loop (`runIdleLoop`, `simple-imap-service.ts`) previously retried *every* failure on a fixed exponential backoff — including a rejected login, which just hammered Bridge until it returned "too many login attempts" and locked the account out. Now the loop **classifies the failure**:
  - **Login/credential failure** (`classifyError` → `auth`, e.g. wrong Bridge password): logs a prominent `error` ("IMAP login failed — … Fix the Bridge password in Settings → Connection, then restart …") and **stops reconnecting** (`idleAuthFailure` is set for surfacing). It does not retry a bad password into a lockout. Restarting (or relaunching from the MCP client) clears the stop and retries with the new credentials.
  - **Transient issue** (connection lost / timeout / `too many login attempts` throttle): logs a `warn` with the reason and the next retry time, and retries on a **1 → 5 → 15 → 30-minute** schedule (holding at 30), recording `idleLastIssue`. A throttle is treated as transient (it self-clears) rather than a permanent stop.
- New `idle-reconnect-policy.test.ts` covers all three branches (auth-stop, connection-retry, throttle-retry).

### Fixed — connection check showed "✅ Reachable" during an auth failure (454)

- Both the browser "Check Now"/"Test Connections" (`/api/test-connection`) and the terminal-UI test only did a **TCP port probe** (`tcpCheck`), so a Bridge that accepts the socket but rejects AUTH — a 454 throttle or a stale Bridge password — was still shown as green "Reachable". A new shared module `src/settings/connection-check.ts` now does **TCP reachability AND a STARTTLS+AUTH probe** with the saved credentials, distinguishing `reachable` from `authenticated`. The UI renders three states: ✅ Connected / ⚠ Port open · auth failed (with the server's reason, e.g. the 454) / ❌ Unreachable — it can no longer show green while auth is broken.
- **Hard timeout:** `imapflow`/`nodemailer` don't reliably honor their own connect/socket timeouts when a server accepts the socket then stalls mid-AUTH (observed against Bridge during a 454), so each probe is wrapped in a wall-clock cap — the check (and the "Check Now" spinner) always returns instead of hanging.
- Both UIs (browser settings + `tui.ts`) now share one faithful probe; `connection-check.test.ts` covers reachable/authenticated/unreachable/no-creds/auth-stall verdicts.

### Added — `npm run check:bulk:live`, a safe live-Bridge bulk audit

- A self-scoped probe (`scripts/check-bulk-live.mjs`) that exercises the real `SimpleIMAPService` bulk tools against live Proton Bridge to confirm moves actually **land** (not just self-report success), including a move out of the real **"All Mail"** union — the Bridge-specific axis Greenmail can't reproduce. It **never calls `wipe()`** and only creates/deletes its own uniquely-named `Folders/BulkLive*-<ts>` folders and `[bulklive-<ts>] …` messages; existing mail is never touched. A bare run prints the plan; `--confirm` is required to execute. Verdicts: PASS / FALSE-SUCCESS (the bug) / HONEST-FAIL / SKIP.

### Changed — default settings-UI port is now 8766 (was 8765)

- The default `settingsPort` moved from **8765 → 8766** across every code site (loader, schema, `index.ts`, `settings-main`, settings server, setup UI) and the docs. Installs that pin `settingsPort` in `~/.mailpouch.json` are unaffected; only the unset-default changes. This also steps the default off 8765, a port commonly taken by ad-hoc local HTTP servers.

### Improved — settings UI survives an occupied port and explains itself

- **Port fallback:** if the configured `settingsPort` (default 8766) is held by a *foreign* process, `_startSettingsServerDaemon` now binds the next free port (`basePort … basePort+10`) instead of retrying the same dead port 5× and then giving up for the whole session. The configured port still gets a few quick retries first (covers a mailpouch restarting on it); a fallback bind logs a clear "configured port N was occupied — bound to M instead" warning. Real-world trigger: a respawning local HTTP server permanently squatting the configured port took the UI down every session.
- **Tray surfaces the reason:** when the settings UI can't bind at all, the tray tooltip now reads "Settings UI off: <reason>" and a disabled menu item shows it, instead of the "Open Settings" entry silently vanishing (`buildSettingsTrayMenu` gains `settingsUnavailableReason`).
- **Friendly unreachable message:** when the page's backing server dies (stopped/restarted while the tab stayed open), tab loading now shows "The settings server is no longer reachable — mailpouch may have stopped or restarted. Restart mailpouch and reload this page." instead of the raw `TypeError: Failed to fetch`.

### Fixed — `--settings-only` self-terminated on stdin close (secondary "keeps crashing" cause)

- **Bug:** `mailpouch --settings-only` was an **unrecognised flag** — it was parsed nowhere, so the process fell through to the full MCP server on the stdio transport. The stdio transport binds process lifetime to `process.stdin.on("close", → gracefulShutdown("stdin-closed"))`. When launched by a wrapper/autostart/`nohup` that opens a stdin **pipe** and then closes it (or exits), `close` fired and mailpouch shut itself down within seconds — which the operator experienced as the settings UI "crashing" (and the page's backing server dying → `Failed to fetch`). Empirically confirmed: a closed stdin **pipe** triggers the exit (`code=0`); `/dev/null` stdin does not, which is why it was intermittent.
- **Fix:** `--settings-only` is now a real mode. It starts **just** the settings UI + tray and returns — no Bridge connect, no scheduler/IDLE loop, no `StdioServerTransport`, and crucially **no stdin-close handler**. The settings HTTP server (and tray) keep the process alive until the tray's Quit or a signal. `--settings-only --no-settings-ui` is rejected as contradictory; if the settings server fails to bind in this mode the process now fails loudly (port-occupied message) rather than exiting silently.
- **Test:** `test/e2e/scenarios/settings-only-lifecycle.e2e.test.ts` spawns the built `dist/index.js --settings-only` with a real stdin pipe, closes it after boot, and asserts the process stays alive and keeps serving `GET /api/status`. Verified to fail against the pre-fix binary and pass after.

## [3.0.71] — 2026-05-31

### Verified — `search_emails` already issues a live IMAP SEARCH (consolidated report cluster 7 / Observation O1)

- **Investigation:** Observation O1 reported that `search_emails({folder:"INBOX", subject:"…"})` returned `count:0` for a message verifiably in INBOX (e.g. a just-sent self-mail), with the hypothesis that search scanned a stale local cache rather than issuing a live IMAP SEARCH — so freshly-arrived mail would be missed. A read of `searchEmails` → `searchSingleFolder` (`src/services/simple-imap-service.ts`) and the `search_emails` tool handler (`src/tools/reading.ts`) confirmed search is **already live**: every query runs `client.search(criteria, {uid, returnOptions:[{partial}]})` against the locked folder, and the in-memory email cache is consulted **only after** the live SEARCH returns UIDs (to avoid re-fetching bodies already held). A UID the server returns but the cache lacks is fetched directly within the held lock, so a message that arrived after the last cache fill is still found. The handler is pure validation + pass-through and does not pre-filter against any cache.
- **Regression guard:** the honest IMAP mock (`src/services/imap-operations.test.ts`) gained a `seedMessage()` helper plus subject-aware SEARCH and source-bearing FETCH, modelling a message that exists on the (mock) server but was never inserted into the production cache. New tests assert `searchEmails` returns such a freshly-seeded message, materialises it into the cache for cheap re-serve, and returns empty when nothing matches. Because the mock's SEARCH answers from the per-folder UID table independent of the cache, a future cache-only regression (iterating the cache instead of the live result) would surface a cold-cache miss and fail these tests.
- No production behaviour change; existing search semantics (subject/from/to/date/flag/size filters, folder scoping, the v3.0.x SEARCH-injection sanitisation and length caps) are unchanged.

## [3.0.70] — 2026-05-31

### Fixed — actionable error classification (consolidated report cluster 6)

- **Many tools collapsed every failure into the opaque string `"An error occurred"`**, giving users and agents nothing to act on. In particular, `get_emails({ folder: "Labels/X" })`, `get_emails_by_label({ label: "X" })`, and `sync_emails({ folder: "Labels/X" })` against a non-existent folder/label returned the generic message instead of saying what was wrong.
- Added a focused error-classification helper (`src/utils/error-classify.ts`) that maps a thrown error — including imapflow rejections that expose `responseText` / `responseStatus` / `code` — into stable, actionable categories: **folder/label not found**, **IMAP auth failed**, **IMAP connection lost**, **timeout**, and **internal error**. Internal stack detail is kept out of the user-facing string (still logged by the dispatcher).
- The three cited read tools now detect a missing-mailbox SELECT rejection (imapflow `NONEXISTENT` / "Mailbox doesn't exist") and return a precise `McpError(InvalidParams)` naming the resource, e.g. `Folder/label 'Labels/X' not found.`, rather than the generic message.
- The MCP dispatcher's `safeErrorMessage()` now routes previously-opaque IMAP/connection/auth/timeout failures through the classifier for distinguishable, actionable messages.

## [3.0.69] — 2026-05-31

### Fixed — instance singleton lock (consolidated report cluster 2 follow-up)

- **Multiple `claude --continue` sessions each spawned their own mailpouch MCP**, and each one opened a separate IMAP IDLE/auth loop against the *same* mailbox — a compounded version of the connection leak addressed in 3.0.68. Nothing prevented N concurrent instances from N-multiplying the Bridge session load.
- **Fix:** on startup, after config load and before any IMAP/SMTP connectivity, each instance acquires a **per-account PID lock** under `$HOME` (`~/.mailpouch-<accounthash>.lock`). If another **live** instance for the same account already holds it (the recorded PID is verified alive), the new instance logs a clear message and **exits 0** instead of starting a second connection. **Stale locks** from crashed/killed processes (dead PID, or garbage contents) are reclaimed automatically, so a legitimate restart after a clean *or* crashed shutdown is never blocked. The lock is released on `gracefulShutdown` (and on the hard-exit path). Always on; set `MAILPOUCH_NO_SINGLETON=1` to allow intentional multi-instance setups. Fail-safe: if the lock mechanism itself errors, the instance logs and continues rather than blocking a legitimate start. New `src/utils/singleton-lock.ts` helper with unit tests (acquire-when-free, live-holder signal, stale/garbage reclaim, ownership-checked release).

### Fixed — settings-UI bind race (consolidated report cluster 4)

- **The settings HTTP server bind was sequenced *after* the IMAP/SMTP connectivity check in `main()`.** When a backend probe/verify hung (observed after ~3-day uptime), the settings server never bound — port stayed unbound, HTTP probes got connection-refused — leaving the UI unreachable *precisely* when the operator needed it to fix the backend misconfiguration.
- **Fix:** the settings server (and system tray) now **bind before** the Bridge reachability probe and backend connect, so the UI is reachable independent of backend state. Added a **watchdog log line** every 15 s while the bind is still pending, naming what it is waiting on, so a stuck bind is visible in `~/.mailpouch.log`.

## [3.0.68] — 2026-05-31

### Fixed — IMAP connection leak / auth-retry storm (consolidated report cluster 2)

- **`connect()` and the IDLE reconnect loop never closed the previous IMAP client before creating a new one**, so every reconnect (or half-open drop) orphaned a socket. Over a long-running process this leaked one Bridge IMAP session per reconnect; once Proton Bridge hit its per-user session cap and began rejecting auth (`454 too many login attempts`), the IDLE loop — retrying at a **flat 30 s with no backoff** — turned a single auth failure into thousands of leaked sockets and failed-auth attempts per day, eventually saturating Bridge. A reporter observed ~44,000 ESTABLISHED sockets across three orphaned instances.
- **Fix:** `connect()` now reaps any existing client (`logout()`, falling back to `close()`) before assigning a new one. `runIdleLoop()` reaps the failed client on every iteration (so a dropped/failed connection's socket is never orphaned) and applies **exponential backoff** (30 s → cap 5 min), resetting to 30 s only after a clean connect — so a session-capped Bridge is no longer hammered. Regression test asserts a reconnect logs out the stale client before creating the new one.
- **Note (report cluster 3, folder/label loss):** a read-only audit of every IMAP `STORE`/`COPY`/`MOVE`/`DELETE`/`mailboxDelete` call site found **no path that targets a wildcard, empty, or all-folders UID set** — all mutations are scoped to explicit, validated UIDs (empty sets short-circuit) and `delete_folder` deletes a single gated folder name. mailpouch could not have mass-unlabelled or mass-deleted folders directly; the loss correlates with the cluster-2 connection storm exhausting/corrupting Bridge, which this fix removes the trigger for.

## [3.0.67] — 2026-05-31

### Added — Enable/Disable Settings UI toggle on the standalone launcher tray

- The standalone `mailpouch-settings` tray now mirrors the MCP server's tray: an **"Enable Settings UI" ↔ "Disable Settings UI"** toggle, with **"Open Settings" shown only when the UI is enabled**. "Disable" stops the HTTP server while keeping the tray and process alive (so the icon stays an always-available control point); "Enable" brings the server back up on the same port. Previously the launcher tray had only Open Settings / Quit, so the only way to stop serving was to quit entirely. Menu construction is the pure, unit-tested `buildLauncherTrayMenu()` (`src/utils/tray-menu.ts`).

## [3.0.66] — 2026-05-31

### Changed — tray Settings-UI toggle made testable (no behavior change)

- Extracted the system-tray menu construction into a pure, unit-tested `buildSettingsTrayMenu()` (`src/utils/tray-menu.ts`); `index.ts` now delegates to it. This validates the tray's enable/disable behaviour: the toggle reads **"Enable Settings UI"** when the UI is off and **"Disable Settings UI"** when it is on (stable `enable`/`disable` ids the click handler switches on), **"Open Settings" appears only when the UI is enabled with a live URL** (the UI-005/UI-007 invariant), and pending/active agent badges show only when non-zero. The tray icon is created at startup (`_initTray`, gated only by `--no-tray`). Behaviour is unchanged; this is a refactor + regression coverage.

## [3.0.65] — 2026-05-31

### Fixed — move/copy/label silently false-succeeded from non-INBOX/All Mail sources (Bug A regression)

- **`bulk_move_to_label`, `bulk_move_emails`, `move_to_label`, `move_email` counted success when the IMAP `COPY`/`MOVE` verb merely *resolved*, not when the message actually landed in the target.** The v3.0.41/IMAP-003 work added a *source*-side UID pre-flight but never verified the *target*. RFC-strict servers (Greenmail, used in CI) reject a COPY to a nonexistent mailbox, so this never surfaced in tests — but Proton Bridge answers `COPY`/`MOVE` from the **All Mail** union with `OK` while doing nothing, so a real retest reported `{success:N}` with no message moved and no label created. Reported against v3.0.64.
- **Fix — honest counts by verification.** After the copy/move, the message is verified actually present in the target before being counted as success. Primary signal is the server's **UIDPLUS `COPYUID` map** (a per-message, identity-independent proof the server assigned a destination UID — advertised by both Proton Bridge and Greenmail, and free of extra round-trips); when a server returns no UIDPLUS data we fall back to a **Message-ID** search. A message that is accepted but cannot be verified present — including one with no Message-ID — is an explicit failure with an actionable error ("…accepted but could not be verified present in the target — likely a no-op from a union mailbox (e.g. All Mail). Pass the message's real source folder."), never an assumed success. Applies to `bulkCopyToFolder`, `bulkMoveEmails`, `copyEmailToFolder`, `moveEmail`.
- **`bulk_move_to_label` / `move_to_label` now create the `Labels/<name>` mailbox if missing** (new `ensureFolderExists`), so applying a label that isn't there creates it instead of copying into a nonexistent mailbox that Bridge silently no-ops.
- Regression tests model a Bridge-style "verb resolves but nothing lands" no-op from an All Mail source and assert it is reported as failure, not success; plus real-copy/real-move-from-non-INBOX paths that verify landing and succeed.

## [3.0.64] — 2026-05-30

### Fixed — Info triage + final audit-ledger reconciliation (audit 2026-05-28)

Closeout batch for the 2026-05-28 audit. Triaged the 21 remaining Info findings (fix-or-acknowledge) and reconciled seven previously-shipped findings whose audit-doc blocks were never annotated. After this batch every `#### <ID>` block in `docs/audit-2026-05-28.md` carries a Resolved/Acknowledged annotation (241/241).

**Info fixes (7)**
- TOOL-018: `get_connection_status` outputSchema gains `required: ["smtp","imap","settingsConfigured","settingsConfigPath"]`.
- TOOL-019: `fts_status` outputSchema gains `required: ["available"]`.
- TOOL-021: `pass_get`'s `fields` schema documents its optional/omitted-when-empty semantics.
- TOOL-023: `clear_cache` description states it does NOT rebuild the FTS index (use `fts_rebuild`).
- TOOL-024: `get_emails_by_label` limit clamp mirrors `get_emails`' `Math.min(Math.max(1, …), …)` order.
- SMTP-020: `escapeHtml` now also escapes `'` → `&#39;` for safe reuse in single-quoted attributes.
- UI-018: audit-log CSS class built from a `{requested,approved,denied,expired}` allowlist instead of `escHtml(e.event)`.

**Info acknowledged as by-design (14)** — IMAP-017 (already addressed by the IMAP-005 rename), IMAP-021, SMTP-017, SMTP-019, XPORT-019, XPORT-020, XPORT-022, PERM-016, TOOL-022, CRED-014, VALID-020, UI-016, TEST-023, TEST-025. Reasons recorded inline in the audit doc.

### Ledger reconciliation
Verified against shipped code and annotated in `docs/audit-2026-05-28.md`: TEST-016 / TEST-017 / TEST-018 / TEST-020 / TEST-021 / TEST-022 (v3.0.63 test-quality sweep #174), and BUILD-014 (v3.0.43 preship-gate hotfix #130 — `PRESHIP_SKIP=1` bypass at `scripts/preship.mjs:31`).

## [3.0.63] — 2026-05-30

### Fixed
Transport / permission / UI / build / docs low-severity sweep from the 2026-05-28 audit. Scope: `src/transports/{http,oauth-handlers,oauth-store}.ts`, `src/agents/{grant-store,audit}.ts`, `src/config/loader.ts`, `src/index.ts`, `src/settings/{server,security}.ts`, `src/notifications/{desktop,webhooks}.ts`, `scripts/{smoke-tarball,check-secrets,lib/preship-runner,wait-for-port}.mjs`, `.github/workflows/publish.yml`, `package.json`, `.npmrc`, `.gitignore`, plus README/HELP/docs accuracy fixes.

- **Transport hardening** — `/health` no longer leaks the OAuth/transport fingerprint (XPORT-010); every transport response carries `nosniff`/`DENY`/`no-referrer`/`no-store` headers (XPORT-011); the OAuth-without-password check moved before the notifications subscribe so the handle can't be orphaned (XPORT-012); `extractBearer` matches RFC 6750 exactly (XPORT-014); the token endpoint collapses the resource mismatch into `invalid_grant` to remove the confirmed-good-code oracle (XPORT-004); the OAuth `state` parameter rejects non-printable characters (XPORT-016); resource indicators are parse-validated and default to the canonical resource so the per-token binding is never skipped (XPORT-017); OAuth access tokens are keyed by `sha256(token)` internally rather than the raw bearer (XPORT-005); and the DCR pending-grant queue is capped to bound a registration flood (XPORT-021).
- **Permissions** — per-agent call counters now flush on a 5-minute interval and at shutdown so they survive restart (PERM-010); the agent audit log rotates by atomic rename so a concurrent append can't be lost in the read→truncate window (PERM-012); the supervised bulk-action rate limit uses an explicit tool allowlist instead of a `bulk_` prefix match (PERM-015).
- **Settings UI** — desktop notifier subprocesses are killed after a 3 s timeout (UI-008); the Claude Desktop config path resolves to `null` on Windows without `%APPDATA%` instead of a CWD-relative path (UI-010); agent approve/deny/revoke and account-activate now share the per-IP escalation rate limiter (UI-012); the shell HTML on `/` is gated by a bootstrap `?token=` check in LAN mode (UI-014); and a hostile DCR `client_name` can no longer trigger Slack/Discord `@here`/link injection in webhook payloads (UI-017).
- **Build / CI** — `smoke-tarball` early-exits via `throw` so cleanup always runs (BUILD-007); dropped the phantom `fast-xml-parser` override (BUILD-010); preship npm-script steps no longer pass `--silent` (BUILD-016) and strip publish-only secrets from child envs (BUILD-017); `test:e2e:local` waits for the Greenmail IMAP port before running vitest (BUILD-018); added `.npmrc engine-strict=true` to enforce `engines.npm` (BUILD-019); `check-secrets` excludes test-fixture trees (BUILD-020); the GPR publish job restores `package.json` after its rename (BUILD-023); removed the dead `/tmp/...` `.gitignore` entries (BUILD-025).
- **Docs** — README System tool count 4→5 (DOCS-003); README env-var table gains the six missing `MAILPOUCH_*` knobs (DOCS-008); HELP destructive-confirm list adds `delete_folder` (DOCS-010); docs/index System row adds `get_server_version` (DOCS-011); the schema tier comment + README standardise on "27 tools + 2 escalation = 29 visible" (DOCS-012).
- **Tests** — `oauth-store` expiry tests use fake timers instead of poking record internals (TEST-016); `grant-store` prune tests use fixed anchors via `prune(now)` (TEST-017); analytics tests assert shape over `toBeDefined` (TEST-018); the E2E smoke test snapshots the full tool surface (TEST-020); bulk-action tests assert `errors.length` (TEST-021); a new test locks the `folder:uid` cache-key wire format (TEST-022).

### Ledger reconciliation
Verified against shipped code and annotated in `docs/audit-2026-05-28.md`: DOCS-009 / BUILD-002 / BUILD-004 / BUILD-005 / BUILD-006 / BUILD-014 (v3.0.43 preship-gate hotfix), UI-007 (v3.0.55 config file lock), XPORT-013 / XPORT-018 (#126/#145), UI-004 / UI-013 (v3.0.57), PERM-014 (file-lock already in `requestEscalation`). Acknowledged as by-design: BUILD-021 (npm writes resolved overrides into the lock, so setup-node's cache invalidates correctly), BUILD-022 (lint slot is a stable no-op until a real linter is wired), BUILD-024 (`mailpouch-settings` is the documented user-initiated, on-demand launcher — not an autostart daemon).

## [3.0.62] — 2026-05-30

### Fixed — tools / validators / parsers / credentials low-severity sweep (audit 2026-05-28)

**Validators (`src/utils/helpers.ts`)**
- VALID-004: `validateLabelName` and `validateFolderName` now delegate to a single shared `validateLeafName(value, fieldName)` core so the byte-identical rules can't drift.
- VALID-007: every text-shape validator (`validateLeafName`, `validateTargetFolder`, `validateImapPath`) now rejects the full C0/C1 control range plus DEL (`\x7f`), not just C0.
- VALID-008: `requireNumericEmailId` caps UID strings at 10 digits and rejects leading zeros (except `"0"`).
- VALID-010: `parseEmails` drops tokens longer than `MAX_ADDRESS_TOKEN` (1024) before running the regex.
- VALID-011: added `validateRequiredTargetFolder`; `create_folder`/`delete_folder`/`rename_folder` now use it instead of duplicated empty-name guards.
- VALID-012: `validateImapPath` rejects leading/trailing whitespace.
- VALID-013: `saveDraft` `inReplyTo` and `references` now share one header-field sanitiser.
- VALID-016: `fts_search` validates its `folder` filter for parity with `search_emails`.
- VALID-017: documented `validateTargetFolder("")` empty-as-default contract.
- VALID-018: `validateAttachments` rejects path separators, traversal, control chars, and over-255-char filenames.
- VALID-021: `optionalSourceFolder` consolidated into `helpers.ts` (was duplicated in `tools/actions.ts` + `tools/deletion.ts`).

**Tools (`src/tools/*`)**
- TOOL-011: `get_emails_by_label` outputSchema advertises `EMAIL_SUMMARY_SCHEMA` items + `required`.
- TOOL-010: `get_thread` narrows returned messages to the summary shape (bounded `bodyPreview`), matching its schema and capping response size.
- TOOL-013: `fts_rebuild` keys its in-progress guard per resolved DB path so concurrent rebuilds on different accounts don't collide.
- TOOL-014: `start_bridge` flags `isError: true` when the SMTP/IMAP ports never come up.
- TOOL-016: `search_emails` rejects negative/non-finite `larger`/`smaller`.
- TOOL-017: `search_emails` requires parseable date strings for `sentBefore`/`sentSince`.

**Parsers**
- PARSE-020: `extractEmailAddress` takes the last angle-bracket pair (trailing address) instead of the first, so a hostile `From` header can't poison the contact map.

**Credentials**
- CRED-005: `readRegistryWithSecrets` fetches each account's keychain entry once instead of twice.
- CRED-009: the Pass audit log is now hash-chained (`prevHash` + `hash` per row) and documented as best-effort tamper-evident.
- CRED-011: the v1→v2 credential re-encrypt stages both blobs before saving, so a mid-migration throw can't persist a half-migrated config.
- CRED-012: SimpleLogin error bodies are scrubbed of the configured API key and opaque token-shaped substrings before they reach logs/responses.
- CRED-013: the Pass CLI subprocess `cwd` is pinned to the user's home directory.
- CRED-015: `migrateCredentials` runs its read-modify-write under the config write lock against a deep clone, so concurrent readers never see an in-flight, partially-blanked config.

## [3.0.61] — 2026-05-30

### Fixed

IMAP/SMTP low-severity sweep + test-quality hardening (2026-05-28 audit, batch P2-A).

- **IMAP-011** — `expandImapSequence` now rejects NaN / `*` / inverted ranges and caps expansion at 10 000 UIDs, instead of silently returning `[1]` for `1:*` or OOMing on `1:1000000000`.
- **IMAP-013** — `findDraftsFolder` logs the underlying folder-discovery failure (network/auth) before treating it as "no Drafts folder", so the actionable cause isn't swallowed.
- **IMAP-015** — `validateEmailId` now enforces 32-bit UID bounds (`/^[1-9]\d{0,9}$/` ≤ 4 294 967 295), rejecting arbitrary-length pseudo-UIDs and log poisoning.
- **IMAP-018** — `getEmails` preview suppresses MIME boundary/header noise for `multipart/related` roots instead of shipping `----=_Part…` markers into the list view.
- **IMAP-019** — `disconnect()` wraps `logout()` in try/finally so a rejected logout still nulls `client` and clears `isConnected` (no more stale "connected" state on a dead socket).
- **IMAP-022** — `getFolders` issues its per-folder `STATUS` probes concurrently (`Promise.all`) instead of one serial round-trip per folder.
- **SMTP-008** — `processDue` logs a debug line when a tick is skipped because the previous one is still in flight.
- **SMTP-009** — `reply_to_email` caps the `Re:` subject to `MAX_SUBJECT_LENGTH`, matching the forward path.
- **SMTP-010** — `forward_email` escapes the user message via `escapeHtml` when the forwarded original is HTML, closing a body-injection gap.
- **SMTP-013** — `send_email` now enforces a non-empty `subject` (the schema marked it required but the handler didn't), so transports that skip schema validation can't send an empty Subject.
- **SMTP-014** — new `parseEmailsDetailed` reports dropped addresses; the SMTP `to` field now hard-fails on a partial drop instead of silently shrinking the recipient set.
- **SMTP-015** — `processDue` defers the rest of a batch (without bumping `retryCount`) when the SMTP backoff gate is already tripped, instead of mass-failing untried items.
- **SMTP-018** — `pruneHistory` now runs on every `persist()`, not only at `load()`, so the scheduler store can't grow unbounded between restarts.
- **IMAP-003 / IMAP-006 / IMAP-008 / IMAP-009** — reconciled: already closed by the v3.0.44 sourceFolder/pre-flight work; now annotated in the audit doc.

### Tests

- **TEST-006** — `imap-operations.test.ts` now uses its imported `beforeEach` to `vi.restoreAllMocks()` between tests.
- **TEST-007** — added a `makeFolder()` helper producing the full `EmailFolder` shape (incl. `specialUse`); applied at the `getFolders` spy sites to stop mock drift.
- **TEST-008** — agent-harness smoke tests assert a well-formed discriminated outcome instead of the tautological `expect(outcome).toBeDefined()`.
- **TEST-009** — escalation env-override test uses a unique `mkdtempSync` dir with try/finally env restore instead of a fixed `/tmp` path.
- **TEST-013** — `fts-service.test.ts` hard-fails (instead of silently skipping) when `better-sqlite3` is missing under `CI`.
- **TEST-014** — agent-harness discovery test derives expectations from the tool registry (subset + ceiling against `allToolDefs()`) instead of a hand-picked subset + `>= 40` floor.
- **TEST-015** — destructive-gate harness tests require an *explicit* refusal, so a silent `{success:0,failed:0}` no-op no longer counts as "gated".
- **TEST-024** — deletion E2E additionally asserts the folder message count is unchanged after a `confirmed:false` rejection, evidencing the gate fires before any IMAP mutation.
- Added focused regressions for IMAP-011/015/019, SMTP-009/010/013/014/015/018.

### Notes

- **IMAP-020** — acknowledged, by design: the `"`/`\` strip in `sanitizeImapStr` is a deliberate, audited injection defense; trading it for rare search-fidelity edge cases (`O\'Brien`, quoted phrases) risks regressing the IMAP SEARCH injection guard.
- **SMTP-016** — acknowledged, by design: `remind_if_no_reply` already binds the reminder to the fetched message's real `Message-ID`, so auto-cancel matches the correct thread; a Message-ID input option is a product/schema change out of scope.
- **TEST-010** — acknowledged with mitigation: kept the global `MAILPOUCH_INSECURE_BRIDGE=1` default (a full strict-by-default flip churns several connect-path test files) and documented the strict-test opt-out contract in `test-setup.ts`.
- **TEST-011** — acknowledged, deferred: ephemeral Greenmail ports require dynamic docker-compose port allocation that can't be validated without a Docker runner.
- **TEST-019** — acknowledged, deferred: a bridge-only-skip → counterpart registry would hard-fail CI today because the Phase-2 `bridge-only` counterpart suite doesn't exist yet.

## [3.0.60] — 2026-05-30

### Fixed
UI/CSP + build/docs sweep from the 2026-05-28 audit. Scope: `src/settings/server.ts`, `src/settings/shell.ts`, `src/settings/tabs/setup.ts`, `src/index.ts`, `scripts/check-npm-audit.mjs`, `scripts/lib/preship-runner.mjs`, `scripts/preship.mjs`, `tsconfig.json`, `package.json`, plus README/HELP/README_FIRST_AI doc fixes.

- **Eliminated the last inline event handler in the settings UI** (UI-001). The Setup tab's `<form onsubmit="return false">` is replaced with `data-submit="noop"` wired through a delegated `submit` listener inside the nonce'd script block, so it executes under CSP3's nonce regime.
- **Dropped `'unsafe-inline'` from the main UI `script-src`** (UI-002). With no remaining inline handlers, the CSP is now `script-src 'nonce-…'` only — CSP1/2 browsers no longer honour a now-pointless keyword.
- **`/agent-setup` CSP hardened and all interpolations escaped** (UI-003). `script-src` is locked to `'self'` (the page has no scripts), `escapeHtml` now also escapes `'`, and every remaining raw `${data.*}` interpolation is wrapped.
- **`/api/shutdown` now runs graceful cleanup** (UI-006). The endpoint routes through a new `onShutdownRequested` callback that invokes `gracefulShutdown` (which destroys the tray subprocess) instead of calling `process.exit(0)` directly.
- **`/api/write-claude-desktop` no longer clobbers an unparseable config** (UI-009). A present-but-invalid (or unreadable) `claude_desktop_config.json` now returns `{ ok: false }` and leaves the file untouched; only a missing file (ENOENT) starts fresh.
- **Agent approve endpoint validates `conditions`/`toolOverrides` shape** (UI-011). Both are sanitized against a key whitelist and per-value type checks, dropping unknown keys and `__proto__`-style prototype-pollution payloads.
- **`npm audit` gate surfaces unbucketed severities** (BUILD-003). Findings that are neither high/critical nor moderate/low (e.g. `info`/`unknown`) are now printed as advisories instead of being silently dropped.
- **Enabled low-cost strict-mode tsconfig flags** (BUILD-008). `noImplicitOverride` and `isolatedModules` are on; `noUncheckedIndexedAccess`/`exactOptionalPropertyTypes` remain deferred to a dedicated follow-up per the finding.
- **Production tarball no longer ships source maps** (BUILD-009). The `files` array now excludes `dist/**/*.js.map` and `dist/**/*.d.ts.map`, so maintainer absolute paths no longer leak in the published package.
- **Preship runner distinguishes deferred-after-halt steps** (BUILD-013). Steps skipped because an earlier step hard-failed render with a red `↷ deferred after halt` mark instead of gray "skipped", so a stdout parser cannot mistake a halted run for a clean one.
- **`tarball-smoke` moved into the fast (pre-push) tier** (BUILD-015). The only gate that catches a missing bin shebang or dropped `files` entry now runs on every push.
- **Documentation corrected to match code** (DOCS-001, DOCS-002, DOCS-004, DOCS-005, DOCS-006, DOCS-007). README supervised deletion cap (5→20/hr) and server-lifecycle cap (2→5/hr); HELP `fts_search` (`after:`→`sinceEpoch:`) and `remind_if_no_reply` (`emailId`/`days`→`email_id`/`after_days`); HELP audit-log file list (dropped the non-existent `~/.mailpouch-escalation-audit.jsonl`, relabeled `~/.mailpouch.audit.jsonl` as the escalation audit log); README_FIRST_AI escalation inputs (`targetPreset`/`newTools`→`target_preset`/`reason`) and return shape.

## [3.0.59] — 2026-05-30

### Fixed
Crypto/credential discipline batch from the 2026-05-28 audit (CRED findings 004, 006, 007, 010). Scope: `src/crypto/credential-encryption.ts`, `src/config/loader.ts`, `src/accounts/registry.ts`.

- **GCM auth-tag length is validated before use** (CRED-006). `setAuthTag` silently accepts any 4–16 byte tag (a 4-byte tag has only 2^32 forgery margin). `decrypt()` and `isValidEncrypted()` now require a full 16-byte tag and reject short/garbage/over-length tags. The v1→v3 read-side migration is unaffected — real blobs always carry a 16-byte tag.
- **Decrypt failure fails closed instead of falling through to plaintext** (CRED-010). When a well-formed encrypted blob in `~/.mailpouch.json` fails authenticated decryption, `loadCredentialsFromKeychain` now logs a `logger.error` and returns null rather than serving a coexisting plaintext `connection.password`/`smtpToken` from the same file. Plaintext coexisting with a failed-auth blob is treated as a tamper indicator, not a migration fallback.
- **Credential files are re-asserted to 0o600** (CRED-007). `writeFileSync({mode})` only applies the mode at creation and is masked by umask, so an existing/restored file can be group/world-readable. `saveConfig` (config file) and the machine-id fallback now `chmod 0o600` when the mode has drifted wider, mirroring the logger's chmod-on-detect pattern.
- **Keychain-vs-plaintext detection uses the real save result** (CRED-004). `writeRegistry` inferred keychain success from the scrubbed account shape (`!password && !smtpToken`), which a future empty-field normalization could flip to a false-clean "keychain" badge. It now records the actual `saveAccountCredentials` return value per account and marks `credentialStorage` from that.

## [3.0.58] — 2026-05-30

### Fixed
Validator unification + draft/send symmetry + IMAP/parser residuals (W3-A batch of the 2026-05-28 audit). Scope: `src/utils/helpers.ts`, `src/services/simple-imap-service.ts`, `src/tools/sending.ts`, `src/tools/drafts.ts`, `src/tools/reading.ts`.

- **SMTP-011** — `saveDraft` now returns a structured, actionable error ("No Drafts folder found…") instead of appending to a literal "Drafts" path; `findDraftsFolder` returns `null` when no Drafts mailbox is resolvable.
- **SMTP-012** — `saveDraft` strips CR/LF/NUL from `subject`/`to`/`cc`/`bcc` (not just `inReplyTo`/`references`/attachments), closing the header-injection asymmetry the old comment falsely claimed.
- **VALID-002** — `search_emails` length-caps `body`/`text`/`bcc` at 500 chars; the service's `sanitizeImapStr` now also strips `\r`/`\n`/NUL to block IMAP command-line smuggling.
- **VALID-003** — unified the two divergent `validateFolderName` implementations: the IMAP service now delegates to a single shared `validateImapPath()` in `helpers.ts`.
- **VALID-005** — `saveDraft` enforces the same attachment count (20) and per-file/total size caps (25 MB) as the SMTP send path.
- **VALID-006** — `validateAttachments` now caps per-file and aggregate attachment content size.
- **VALID-015** — tools route `args.attachments` through a new `sanitizeAttachments()` that keeps only known fields, stripping attacker-controlled keys (`path`/`href`/`raw`/`encoding`) that nodemailer would otherwise honor.
- **PARSE-008** — `stripHtml` now decodes HTML entities (incl. numeric decimal/hex) BEFORE stripping tags, so encoded `&lt;script&gt;` cannot emerge as live markup in FTS/bodyPreview.
- **PARSE-009** — `stripHtml` strips HTML comments (`<!-- … -->`) up front so their contents don't survive as prose.
- **PARSE-003 (wiring)** — `fts_rebuild` tool handler switched from non-atomic `clear()`+`upsertMany()` to the atomic `rebuild(records)` (the atomic method shipped in v3.0.54).

## [3.0.57] — 2026-05-30

### Fixed
Permission/grant correctness batch from the 2026-05-28 audit (PERM findings 001, 005, 006, 007, 008, 009, 011, 013). Scope: `src/permissions/manager.ts`, `src/permissions/escalation.ts`, `src/agents/grant-manager.ts`, `src/agents/grant-store.ts`, `src/transports/http.ts`, `src/settings/shell.ts`, plus a new `src/utils/file-lock.ts`.

- **Escalation meta-tools now write a per-agent audit row** (PERM-001). `request_permission_escalation` / `check_escalation_status` bypass the grant/permission/destructive gates by design (they can never grant access), but they were also invisible in `~/.mailpouch-agent-audit.jsonl`. The dispatcher now writes an audit row around the escalation handler for OAuth callers, so a revoked agent spamming escalations leaves an attributable trail.
- **An unmapped tool name now defaults to DENY, not ALLOW** (PERM-005). `PermissionManager.check` returned `{ allowed: true }` when the tool resolved to no permission entry; a handler added to the registry but not to `ALL_TOOLS` (or an arbitrary `request.params.name`) ran ungated. Undefined `perm` now denies with a clear reason.
- **Grant store and escalation pending-file mutations are cross-process locked** (PERM-006). New minimal advisory lock (`withFileLock`, a sibling `${target}.lock` dir with stale-break, no new dependency) serializes the load→mutate→atomic-rename cycles in `escalation.ts` and `grant-store.ts`. The grant store also reload-merges grants another process created so a whole-file rewrite no longer drops them.
- **The gate chain reads a single config snapshot** (PERM-007). The agent-grant gate (global preset) and the destructive-confirm gate each called `loadConfig()` independently; a settings save landing between them produced a TOCTOU window where the two gates judged the same call against different snapshots. Both now use one snapshot taken at the top of the handler.
- **Static bearer is rejected when OAuth is enabled** (PERM-008). A static bearer authenticates as one shared, fully-trusted identity that bypasses the per-agent grant store and audit log. When `oauthEnabled` is true the static-bearer path is now refused; OAuth deployments must use per-client DCR tokens that are independently gated, audited, and revocable.
- **Settings-UI grant cards use the strict 5-replacement HTML escaper** (PERM-009). The grant/agent list renderers used a weak `esc()` (only `& < "`); attacker-controlled `clientName` could inject `>`/`'`. The page-level `esc()` now escapes all five (`& < > " '`), matching `escHtml`. (DCR-time `sanitizeDcrClientName` from v3.0.50 #145 already strips control chars + caps length; this closes the render side.)
- **Folder allowlist is enforced on email-ID-scoped mutators** (PERM-011). `delete_email`, `get_email_by_id`, `get_thread`, `mark_email_read`, `star_email`, `download_attachment` were treated as folder-agnostic, so a grant pinned to `INBOX` accepted `delete_email { sourceFolder: "Archive" }`. They are dropped from `FOLDER_AGNOSTIC_TOOLS` and `extractFolderArg` now reads `sourceFolder`/`source_folder`; a call that omits the folder fails closed.
- **A `custom` grant preset no longer ranks equal to `full`** (PERM-013). `intersectPresets` ranked `custom == full`, so intersecting a `custom` grant with a lower global preset returned the global preset's enabled-map and silently re-enabled tools the user disabled. A `custom` grant is now governed solely by its explicit `toolOverrides` (default-deny for un-overridden tools), bounded by the global ceiling.

## [3.0.56] — 2026-05-30

### Security — OAuth/transport hardening (audit 2026-05-28, batch M4)

- **XPORT-001** — Static-bearer rate-limit bucket is now keyed per caller IP (`bearer:static:<ip>`) instead of a single global bucket, so one busy or malicious caller can no longer DoS every other legitimate user of the shared token.
- **XPORT-003** — OAuth consent page now sets `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and a `frame-ancestors 'none'` CSP directive, blocking clickjacking of the Approve button.
- **XPORT-006** — `oauth-handlers.ts` now reuses the exported `clientIp()` from the transport layer, so the OAuth rate-limit / IP-pin trust model matches the rest of the transport (XFF trusted only behind a loopback peer) instead of socket-only.
- **XPORT-007** — The consent POST now re-runs the GET handler's `code_challenge` / `code_challenge_method` / `state` format checks, so a direct POST can no longer mint an auth code with an empty/malformed/plain (non-S256) challenge.
- **XPORT-008** — Consent POST now requires a per-flow CSRF token (HMAC of `client_id` with a per-process secret, issued by the GET page) and rejects cross-site `Origin` headers, closing the password-known cross-site submission vector.
- **XPORT-009** — DCR `redirect_uri` registration now enforces a scheme allowlist (https, http-loopback, custom native-app reverse-DNS scheme) and rejects `javascript:`/`data:`/`file:`/`blob:`/other schemes with `invalid_redirect_uri`.
- **XPORT-015** — Startup now logs a high-severity warning when serving auth over plain HTTP on a non-loopback bind, and never advertises `0.0.0.0`/`::` as the OAuth issuer/resource host (falls back to loopback) so RFC 8414/9728 discovery doesn't break.

## [3.0.55] — 2026-05-30

### Fixed
Persistence-atomicity batch from the 2026-05-28 audit (SMTP-003/004/005/006/007, CRED-008, UI-005). Scope: `scheduler.ts`, `reminder-service.ts`, `config/loader.ts`, `accounts/registry.ts`, `index.ts`.

- **Scheduler retries now back off per item** (SMTP-003). A failed send sets `nextAttemptAt = now + exp_backoff(retryCount)` (60s → 120s → … capped at 30m); `processDue()` skips items whose `nextAttemptAt` is still in the future, so a brief Bridge outage no longer re-burns every pending item on every 60s poll tick.
- **Scheduler persists after each item's status flip** (SMTP-004). `persist()` now runs after every per-item terminal/retry transition, not only at the end of the batch loop, so a crash mid-loop cannot leave an already-sent item recorded as `pending` and re-send it (non-idempotent SMTP) on restart.
- **Reminder writes use a same-filesystem temp file** (SMTP-005). `persist()` builds the temp path as `${this.path}.<rand>.tmp` (sibling of the store) instead of `tmpdir()`, so `rename(2)` stays atomic and no longer fails `EXDEV` on containerised / NFS-home installs where `$HOME` and `/tmp` are on different mounts.
- **Reminder persist failures roll back in-memory state** (SMTP-006). Every mutating method snapshots `reminders` before mutating and routes the write through `persistOrRollback()`, which on a write failure restores the snapshot, logs at error level, and re-throws — so a failed write can never later be flushed as a half-baked mutation.
- **`scanDue()` commits the fired transition before returning** (SMTP-007, partially-addressed). The `pending → fired` flip is now persisted (and rolled back atomically on failure) before the due list is returned, closing the partial-write window. The at-least-once delivery limitation (a dropped MCP response after a successful persist) remains by design pending a dedicated acknowledge tool — see the audit note cross-referencing SMTP-006.
- **Config read-modify-write is serialized with an exclusive file lock** (CRED-008). `saveConfig` and `writeRegistry` now take an `O_EXCL` lock on `${config}.lock` (with stale-lock reclamation, reentrancy, and always-release-in-finally) plus an in-process async mutex, so racing settings-UI POSTs / registry writes can no longer clobber each other. No new dependency.
- **Tray "Open Settings" item is gated on a live settings URL** (UI-005). Verified already in place: the tray entry is only built when `_settingsEnabled && _settingsUrl`, so a failed UI bind no longer shows a dead menu item.

## [3.0.54] — 2026-05-29

### Fixed
Parser/analytics correctness batch from the 2026-05-28 audit (DATA-PARSERS findings PARSE-001/003/004/005/006/007/010/011/012/013/015/016/017/018/019). Scope: `fts-service.ts`, `analytics-service.ts`, `content-parser.ts`.

- **`fts_search` no longer throws on malformed FTS5 query syntax** (PARSE-001). `search()` passed the raw user query straight into `MATCH ?`; a stray `"`, `(`, or column-filter garbage raised an uncaught `SqliteError: fts5: syntax error` to the MCP client. (SQL injection was already impossible — the operand is a bound parameter.) Added a `runMatch()` wrapper around every `.all()` call site that catches FTS5 query-DSL syntax errors and returns a clean empty result; any other error is re-thrown unchanged.
- **`FtsIndexService.rebuild()` clears and repopulates the index atomically** (PARSE-003). The previous flow (`clear()` then `upsertMany()`) committed the `DELETE` immediately, so a throw mid-repopulate left the index empty until the user noticed and re-triggered a rebuild. New `rebuild(records)` wraps the delete + bulk upsert in a single `db.transaction`, rolling back to the prior index on any failure. (The `fts_rebuild` tool handler in `src/tools/reading.ts` should be switched from `clear()`+`upsertMany()` to `rebuild()` — owned by the tools batch.)
- **Contact cap no longer drops the user's own most-frequent recipients** (PARSE-004). `processContacts()` enforced the 10,000-contact cap in insertion order, iterating inbox before sent — so a flood of one-off inbox senders (newsletters, bounces) could exhaust the cap and silently drop every sent-to recipient. Sent recipients are now processed first, guaranteeing high-value contacts claim their map slots.
- **Analytics now uses a single host-local time basis** (PARSE-005/006). `volumeTrends` previously bucketed by UTC ISO date while `peakActivityHours` used host-local `getHours()`, so two charts from the same dataset disagreed and evening mail drifted up to a day. Volume-trend day buckets now use host-local calendar dates (`localDateKey()`), matching peak-hours. Day buckets are seeded by walking back N *calendar* days via local y/m/d construction so a DST transition can't collapse or skip a day. No timezone library introduced.
- **`responseTimeStats.median` is the conventional median** (PARSE-007). For even-length arrays it now returns the mean of the two middle values (`[1,2,3,4] → 2.5`) instead of the upper-middle element (`3`).
- **`responseTimeStats` matches replies across angle-bracket variation** (PARSE-016). The Message-ID → date lookup now normalizes both the stored header and `inReplyTo` by stripping surrounding `<>`/whitespace, so a mailparser-style `<abc@x.com>` matches a bare `abc@x.com`; previously the lookup missed every reply and the whole block returned `null`.
- **Undefined attachment sizes no longer poison storage stats** (PARSE-015). `att.size` (runtime `number | undefined`) is now added as `att.size ?? 0` in both `getEmailStats` and `calculateAttachmentStats`, preventing a single missing size from turning `storageUsedMB`/`totalSizeMB` into `NaN`.
- **`inferOrganization` handles government domains correctly** (PARSE-017). `'gov'` was listed in both the TLD and compound-SLD branches; the duplicate left `cdc.gov` mis-cased and made the compound branch unreachable for it. Acronym TLDs (`edu`/`gov`/`mil`) now upper-case the whole label (`cdc.gov → CDC`), and `gov` in the compound branch only fires for real compounds like `gov.uk` (`hmrc.gov.uk → Hmrc`).
- **iCal `DTSTART;TZID=...` zone is preserved** (PARSE-010). `splitProperty` now returns the property's parameter map; `parseIcs` persists the TZID on a new optional `Meeting.startTzid` field. The `start` value itself stays the raw RFC 5545 date-time string.
- **iCal `BEGIN:VEVENT` lines with parameters are recognized** (PARSE-011). Legacy producers emit `BEGIN:VEVENT;X-MICROSOFT-CDO-BUSYSTATUS=BUSY`; the strict-equality block-start check silently produced `null`. Block boundaries are now matched on the parsed property name/value (and `END:VEVENT;…` is tolerated).
- **iCal `unfoldLines` trims leading whitespace on the first line** (PARSE-012). A leading space/tab on the very first line is not a fold continuation (nothing to fold onto); it is now stripped so `splitProperty` doesn't read a property name of `" SUMMARY"` and drop the field.
- **`extractActionItems` enforces its body cap in bytes** (PARSE-013). The 100 KB cap checked UTF-8 byte length but truncated with a character-count `.slice()`, letting ~4× the bytes through for multibyte bodies. Truncation now slices a `Buffer` and decodes back.
- **`extractActionItems` dedup is punctuation-insensitive** (PARSE-018). The dedup key now also strips trailing `[.,;:!?]` so `Fix bug.` and `Fix bug!` collapse to one item.
- **`extractActionItems` recognizes more bullet markers** (PARSE-019). `BULLET_RE` now matches `‣ ▪ ◦ ◾ ○ ▶ →` and the em-dash `—` used as a dash bullet in Mac/Office plaintext.

### Notes
- PARSE-002 was resolved in v3.0.48; PARSE-014 is owned by the IMAP batch (lives in `simple-imap-service.ts`).
- PARSE-008/009 (`stripHtml` entity-decode order and HTML-comment stripping) also live in `simple-imap-service.ts` and are deferred to the IMAP batch — see audit annotations.

## [3.0.53] — 2026-05-29

### Fixed — tool-surface input hygiene (numeric + cast validation)

- **TOOL-001** `search_emails` now rejects a non-array `folders` arg with `McpError(InvalidParams)` instead of iterating a string per-character or silently falling through on an object.
- **TOOL-002** `request_permission_escalation` now requires a non-empty `reason` (as its schema declares) instead of logging a real escalation as "No reason provided".
- **TOOL-003** `get_contacts` clamps `limit` to `[1, maxEmailListResults]`; a negative value can no longer reach `Math.min`.
- **TOOL-004** `get_volume_trends` clamps `days` to `[1, 365]`; `-10`/`0`/`NaN`/`Infinity` no longer forward raw.
- **TOOL-005** `get_logs` collapses a `NaN` `limit` to the default instead of propagating `NaN` through `Math.trunc/min/max` into `logger.getLogs`.
- **TOOL-006** `alias_list` / `alias_get_activity` collapse a `NaN` `pageSize` to the default, so a non-finite value can no longer break the SimpleLogin caller-side pagination cap (`collected.length < pageSize`).
- **TOOL-007** `alias_create_custom` rejects empty/whitespace `aliasPrefix`/`signedSuffix` before calling SimpleLogin.
- **TOOL-008** `get_correspondence_profile` no longer falsely asserts "no prior correspondence"; when the analytics top-500 scan cap is hit it reports `exhaustive: false` and an honest "not among the top N" message.
- **TOOL-009** `fts_search` clamps `limit` to the documented `1–200` bound and rejects negative/`NaN` `sinceEpoch` at the handler boundary.
- **TOOL-025** `get_email_by_id` clones the email before truncating an oversized body so the truncation never persists into a service-cached object.
- Added shared `clampOptionalInt(raw, fallback, min, max)` and `requireNonEmptyString(raw, fieldName)` helpers in `src/utils/helpers.ts`.

## [3.0.52] — 2026-05-29

### Fixed
- **IMAP header search field/value were the only SEARCH inputs not sanitised** (IMAP-004 from the 2026-05-28 audit, Batch — IMAP service hardening). Every other criterion in `searchSingleFolder` ran through `sanitizeImapStr` (strip `"` and `\`), but `options.header.field` / `options.header.value` were passed through raw — a `value` containing `"` could close imapflow's quoted argument early, and a malformed `field` broke the `SEARCH HEADER <field-name> <value>` grammar (defence-in-depth gap reachable through the `search_emails` tool). The header value now goes through `sanitizeImapStr`, and the field name is validated against the RFC 5322 field-name grammar (`/^[A-Za-z][A-Za-z0-9-]*$/`) — a non-conforming field is rejected before any IMAP round-trip.
- **IDLE cache eviction mutated the cache Map mid-iteration and missed aliased INBOX paths** (IMAP-005). The `exists` / `expunge` IDLE handlers iterated `this.emailCache` directly while calling `evictCacheEntry` inside the loop, and matched the folder with an exact `=== 'INBOX'` string compare. A concurrent `setCacheEntry` from a parallel main-client fetch could race the eviction, and entries cached under an aliased path (`Inbox`, `inbox`) were never invalidated. Extracted a single `evictInboxCacheEntries()` helper that snapshots the keys (`Array.from(...keys())`) before deleting and matches the folder case-insensitively.
- **Array-shaped `to`/`cc` recipients silently disappeared** (IMAP-007). `mailparser` types `ParsedMail.to`/`.cc` as `AddressObject | AddressObject[] | undefined`; a message with multiple separate `To:` header lines (legal per RFC 5322 §3.6.3, emitted by Proton on bridged forwards) becomes an array, and the old `parsed.to?.text ? [parsed.to.text] : []` shape collapsed it to `[]` — recipients vanished from `getEmails`, `getEmailById`, and the attachment re-fetch path. New exported `normalizeAddressList()` flattens both shapes; applied at all three extraction sites.
- **`checkAndUpdateUidValidity` swallowed every error** (IMAP-010). A thrown comparison or mailbox getter (e.g. a reconnect race) left stale UID-keyed cache in place — exactly the silent-corruption class the v3.0.41 pass targeted, since UIDVALIDITY changes are precisely when the cache must be flushed. The `catch` now logs at warn with the error and conservatively clears the entire email cache.
- **`getEmails` returned an empty array on connection loss, hiding the failure** (IMAP-012). A model (or list view) could not distinguish "the folder is empty" from "the bridge is down" — `getEmails` caught the connection error and returned `[]` with an info log. It now throws a typed `IMAPNotConnectedError`, which the MCP dispatcher serialises as a structured error response. The legitimate empty-folder path (connection succeeded, `total === 0`) still returns `[]`.
- **`deleteFolder` / `renameFolder` protected-folder checks used literal English names only** (IMAP-014). The guard compared the input against `['INBOX','Sent','Drafts',…]` with no trim and no `specialUse` consultation, so `'INBOX  '` (trailing whitespace) slipped through and a localised special-use mailbox (e.g. `Papelera` for `\Trash`) was unprotected. New `isProtectedFolder()` helper trims+casefolds the input and, when folder discovery is available, also matches the server-reported `specialUse` attribute against the protected special-use set.
- **Bulk-delete fallback issued N serial EXPUNGEs that blocked IDLE** (IMAP-016). When a bulk `messageDelete(uidSet)` chunk failed, the per-UID fallback ran `messageDelete(id)` per UID — and each imapflow `messageDelete` is a full EXPUNGE round-trip held under the mailbox lock, so 1000 UIDs meant minutes of blocked reads/IDLE. The fallback now flags `\Deleted` per UID (cheap `STORE`) and runs exactly one trailing EXPUNGE of the flagged set via `chunkedBatchOp`'s new optional `finalize` callback (invoked only when the fallback actually ran), saving N−1 round-trips without changing delete semantics.
- **`downloadAttachment` had no upfront size guard** (PARSE-014). A large attachment was re-fetched as full RFC822 source then base64-encoded wholesale in memory (~raw + ~1.33× base64 + parser overhead held simultaneously) with no cap — a 50 MB PDF could OOM the process or return a 67 MB string. A bounded-size guard now rejects attachments over 25 MB (matching Proton's own limit) with a clear error before committing that memory. True streaming of the IMAP body part remains a follow-up refactor.

### Notes
- IMAP-012 changes a read-path contract (`getEmails` may now throw `IMAPNotConnectedError` where it previously returned `[]`). No `src/tools/` change was required: the central tool dispatcher already catches thrown errors and serialises them via `safeErrorMessage`, so callers see a structured error instead of a false "0 emails". The startup analytics warm-cache in `src/index.ts` (`getAnalyticsEmails`) previously caught only its `Sent` fetch; the `INBOX` fetch was uncaught and would now reject on a connection blip, so this batch adds a matching `.catch(() => [])` to it — the warm cache degrades to empty rather than throwing during startup.
- PARSE-014 is a proportionate bounded-cap fix, not full streaming. If a higher per-attachment ceiling is needed later, `MAX_ATTACHMENT_DOWNLOAD_BYTES` is the single knob; a streaming base64 transform would lift the cap entirely but is a larger change.

## [3.0.51] — 2026-05-29

### Fixed
- **`src/services/imap-operations.test.ts` default fetch mock made every UID look present in every folder** (TEST-001 + TEST-002 from the 2026-05-28 audit, Batch 7 of the 9-batch fix-pass). The pre-Batch-7 `defaultFetchMock()` yielded an `{uid}` message for every numeric token in any range passed to `client.fetch(...)`, so the UID-existence pre-flight inside `bulkMoveEmails` / `bulkDeleteEmails` / `bulkMarkRead` / `bulkStar` / `bulkCopyToFolder` / `setFlag` always returned "present" regardless of whether a test had seeded that UID. Worse, `messageMove` / `messageDelete` / `messageFlagsAdd` / `messageFlagsRemove` / `messageCopy` mocks accepted any UID in any folder — a test that locked INBOX could "successfully" move a UID that only lived in Sent. Net effect: the v3.0.41 bug class would have slipped past the legacy tests; only the newer sourceFolder regression block (added 2026-05-28) would have caught it. Replaced with a per-test `seedUids(client, folder, uids)` helper plus an in-mock `lockedFolder` tracker — `getMailboxLock(folder)` records the lock, `lock.release()` clears it, `fetch(range)` only yields UIDs that live in the locked folder, and the mutation mocks reject when the requested UID isn't in the locked folder's seed set. Default state is empty (no UIDs in any folder) — tests that previously relied on the permissive default now seed explicitly (40 tests updated). 138 imap-operations tests still pass with honest mocks.
- **`saveDraft` "sanitizes" tests never inspected the sanitized output** (TEST-003). The CRLF-injection coverage at `src/services/simple-imap-service.newfeatures.test.ts:292-346` only asserted `result.success === true` and `append.toHaveBeenCalled()`. If the sanitizer regex was commented out, both tests stayed green. Both tests now pull the raw MIME Buffer from `client.append.mock.calls[0][1]`, decode it, and assert that the injected text never appears as its own MIME header line (no `\r?\n\s*X-Injected:` and no `\r?\n\s*X-Evil:` patterns). The control character `\x01` smuggled into a `references` value is also asserted absent. The visible (post-sanitization) token portions of the filename and Message-ID are asserted present so the test still pins behaviour — not just absence.
- **`reminder-service.prune()` test relied on wall-clock date** (TEST-004). At `src/services/reminder-service.test.ts:108-116`, `prune(30)` compared records against `Date.now()`; the assertion `removed >= 1` only held when the system clock was past ~2026-03-03. Any CI lane stuck in early 2026, or a developer running with a faked clock, would see a spurious failure. Wrapped the test in `vi.useFakeTimers()` + `vi.setSystemTime("2026-03-15T00:00:00Z")` (cleanup in `finally`); the prune now consistently sees the old fired record as outside the 30-day window.
- **`src/security/keychain.test.ts` had zero positive-path coverage** (TEST-005). Every test ran in an environment where `@napi-rs/keyring` is absent, so only the "keychain unavailable → null/false" branch was exercised. The path where keychain IS available and `saveCredentials` / `loadCredentials` / `saveAuxiliaryCredentials` / `loadAuxiliaryCredentials` / `migrateFromConfig` / `deleteCredentials` round-trip successfully was unreachable. Added a parallel `describe('Keychain (positive-path with stub @napi-rs/keyring) — TEST-005', ...)` block that uses a fresh stub `Entry` backend per test (rebuilt in `beforeEach`) injected via a new `__setKeyringForTests()` hook on `keychain.ts` — `vi.mock('@napi-rs/keyring', …)` can't intercept the `new Function("specifier", "return import(specifier)")` dynamic load that the module uses to keep keytar an optional dep, so the explicit inject hook is the only way to guarantee fresh state without cross-test leak. Six new tests cover: `isKeychainAvailable=true` when the backend resolves; `saveCredentials → loadCredentials` round-trip with call-arg assertions; aux credential round-trip (CRED-001); full six-field `migrateFromConfig` migration with all on-disk fields blanked and `credentialStorage` promoted to `keychain`; idempotent overwrite-on-collision; `deleteCredentials` clears both entries and the in-stub store.
- **32 of 72 MCP tools had no E2E scenario coverage; the SMTP send path was the largest gap** (TEST-012). Added `test/e2e/scenarios/sending.e2e.test.ts` with four Greenmail-backed scenarios for `send_email` (plain text body cross-user delivery; To/Cc/Bcc header propagation + Bcc absence-from-wire verification; HTML body with `Content-Type: text/html` assertion) and `send_test_email` (probe-message delivery). Each scenario opens a second IMAP connection as Bob and asserts the message actually arrived — the property that catches false-success counters at the SMTP layer. To make this work against Greenmail's STARTTLS-less embedded SMTP, two minimal changes were needed: (a) `smtp-service.ts` drops `requireTLS` to `false` when `allowInsecureBridge` is set (mirroring the IMAP TLS-pinning opt-in; production deployments leave the flag unset so behaviour is unchanged), and (b) a new optional `MAILPOUCH_SMTP_FROM` env var lets the Greenmail harness supply a domain-qualified From address so nodemailer doesn't build `MAIL FROM:<>` from the bare Greenmail login (`alice`); production never sets this env var because real Bridge usernames are full emails. Both changes flow only when the explicit insecure-Bridge opt-in is active. The harness wires `MAILPOUCH_SMTP_FROM=alice@test.local` for the Greenmail mode only; bridge mode leaves it unset. Skip-with-reason stubs added for `alias_*` (gated on `MAILPOUCH_E2E_SIMPLELOGIN=1`) and `pass_*` (gated on `MAILPOUCH_E2E_PASS=1`), mirroring the existing Bridge-only skip pattern so the audit gap stays visible and future runs can drop the skip with one env flip. 11 E2E files / 65 passing tests / 11 skipped (9 Bridge-only + 2 new alias/pass placeholders).
- **Greenmail compose user provisioning unchanged** — the existing `alice:test-password@test.local,bob:test-password@test.local` format already creates the right user surface; no change was needed to the compose file.

### Notes
- No production-code regressions surfaced by the honest IMAP mocks — every legacy test that previously relied on the permissive `defaultFetchMock` was hiding test-side seeding gaps, not real bugs. The v3.0.41 / v3.0.44 / v3.0.45 fix passes had already plugged the production-side holes the audit flagged; Batch 7's job was just to make the test suite stop lying about that.
- New test-only injection hook on `keychain.ts`: `__setKeyringForTests(stub | null)` parallels the existing `__resetKeyringCacheForTests`. Both are exported only because the dynamic `new Function("specifier", "return import(specifier)")` load can't be intercepted by `vi.mock`. Production callers don't reference either.
- Minimal production touches: `smtp-service.ts` gains a `requireTLS: isLocalhost && !allowInsecure` derivation + a `MAILPOUCH_SMTP_FROM` env-var override (5 lines combined, both gated on the existing insecure-Bridge opt-in / env var). `keychain.ts` gains the `__setKeyringForTests` hook (10 lines). Net 15 production-code lines, all opt-in and inactive in default deployments.

## [3.0.50] — 2026-05-29

### Fixed
- **Escalation approval applied globally to every connected agent, not the requester** (PERM-002 from the 2026-05-28 audit). `approveEscalation` returned only `{ targetPreset }`; the settings-server then ran `cfg.permissions = buildPermissions(result.targetPreset)`. The challenge record never captured *which* OAuth client requested the escalation, so a human approving challenge X (intended for Agent A) silently widened the global preset ceiling for every connected agent — any other agent whose grant intersected with the new ceiling instantly gained the wider preset for free. `EscalationRecord` now carries `requestedByClientId` + `requestedByClientName` (both control-char-stripped + length-capped), captured at request time via the new `requestEscalation(..., { clientId, clientName })` option. The dispatcher threads the requesting agent's identity (or the literal string `"stdio"` for the local transport) into the escalation context. The deeper fix — only widening the per-agent grant rather than the global preset — is intentionally deferred to a follow-up; this batch closes the information asymmetry (the operator now sees *who* asked for the wider access on the approval card).
- **`bulk_delete` ↔ `bulk_delete_emails` had independent rate buckets, doubling destruction throughput** (PERM-003). Both names resolved to the same `bulkDeleteHandler`, but the permission gate keyed rate buckets by raw tool name — an agent in the `supervised` preset could delete 40 batches/hour (20 via each alias) against the operator's configured 20/hour cap. Added `TOOL_ALIASES` in `src/config/schema.ts` (centralized so it survives future alias additions) plus a `canonicalToolName()` resolver. The permission manager now canonicalizes before bucket lookup AND before the per-tool enabled flag — disabling `bulk_delete_emails` blocks the `bulk_delete` alias too. Same canonicalization applies at the destructive-confirm gate.
- **`move_email` / `bulk_move_emails` / `move_to_folder` bypassed destructive-confirm when `targetFolder: "Trash"` or `"Spam"`** (PERM-004). `DESTRUCTIVE_TOOLS` named `move_to_trash` and `move_to_spam` but NOT the generic mover variants — calling `move_email { emailId, targetFolder: "Trash" }` had the identical effect as `move_to_trash` but skipped the elicitation/confirmed:true gate entirely. New `MOVE_TOOLS_WITH_DESTRUCTIVE_TARGET` set + `DESTRUCTIVE_DESTINATIONS` (lowercase for case-insensitive comparison) — the gate now also fires when the move target itself is destructive, regardless of which mover tool was called.
- **DCR consent screen rendered attacker-supplied `client_name` raw** (XPORT-002). The DCR endpoint is public + unauthenticated; an attacker who reached `/oauth/register` could register a client named "Claude Desktop" with a redirect URI of `https://attacker.example/cb`, and the human admin would see the familiar name on the consent page and type the admin password. New `sanitizeDcrClientName()` strips ASCII control chars + ANSI escape sequences + length-caps at 100 chars at registration time. The consent page now shows a prominent "⚠ Untrusted client" badge for every DCR-registered client (token_endpoint_auth_method === "none") explaining the name is attacker-controlled. The page-level `esc()` was tightened from 3-replacement (missed `>` and `'`) to the strict 5-replacement form used elsewhere in the settings UI, and the same ANSI-first regex ordering was applied to `requestEscalation`'s control-char sanitizer (the old `[control-class]|<ANSI>` order let the control-char class eat the leading `\x1b` byte and leave the ANSI payload as visible text).
- 18 new tests: 3 for `canonicalToolName` + alias-aware rate-bucket + disabled-flag (PERM-003), 3 for the destructive-destination set shape (PERM-004), 3 for `requestEscalation` capturing/sanitizing the requester identity (PERM-002), 6 for `sanitizeDcrClientName` boundary cases including ANSI ordering + length cap + control-char-only stripping (XPORT-002), 3 for the supporting move-tool / destination invariants. Unit suite: 1685 passes.

## [3.0.49] — 2026-05-29

### Fixed
- **`prepare` script ran `simple-git-hooks` inside every downstream consumer's repo** (BUILD-001 from the 2026-05-28 audit). `"prepare": "npm run build && simple-git-hooks"` fires in two contexts npm cannot distinguish on the command line: a contributor running `npm install` at the repo root (intended), and any consumer running `npm i github:chandshy/mailpouch` or `pnpm add mailpouch` in their own project (not intended). The latter caused `simple-git-hooks` to write `.git/hooks/pre-push` into the consumer's repo with mailpouch's `npm run preship:fast` body — a silent surprise that would also run our preship gate in someone else's CI. `prepare` is now build-only; a new `postinstall` step delegates to `scripts/install-hooks.mjs`, which gates strictly: hooks install only when `process.env.INIT_CWD === process.cwd()` AND a `.git/` exists at the package root. Both conditions hold for a contributor cloning this repo; neither holds for a downstream tarball install. `scripts/install-hooks.mjs` was added to the published `files:` list so the postinstall command does not fail with `Cannot find module` after `npm pack`.
- **`npm publish` workflow ran transitive `postinstall` scripts with `NPM_TOKEN` and OIDC publish keys in scope** (BUILD-011). `.github/workflows/publish.yml`'s `npm ci` invocations (both the `publish-npm` and `publish-gpr` jobs) honored every dependency's `preinstall` / `install` / `postinstall` lifecycle. With `id-token: write` and `NPM_TOKEN` resolved into the job environment, a single compromised transitive (next `event-stream`-style hijack) could exfiltrate provenance signing material or the publish token via a stock `postinstall` shell. Both jobs now use `npm ci --ignore-scripts`, followed by an explicit `npm rebuild better-sqlite3 @napi-rs/keyring` — the only two natives mailpouch actually needs at runtime (one prod dep, one optionalDep). If a future native dep lands in `package.json`, that dep must be added to the rebuild line or its `.node` binary won't be built. CI's `ci.yml` and `preship.yml` `npm ci` calls are intentionally left untouched — they don't hold publish credentials, and the lifecycle scripts there are the same prebuild-install + native-build steps the consumer runs.
- **Every third-party action `uses:` line was pinned to a floating tag** (BUILD-012). `actions/checkout@v4`/`@v6`, `actions/setup-node@v4`/`@v6`, `actions/upload-artifact@v4`/`@v7`, and `dtolnay/rust-toolchain@stable` are all mutable refs — the action owner (or anyone who compromises their repo) can repoint the tag to a new commit, and GitHub Actions will silently fetch it on the next workflow run. The `@stable` branch ref on `dtolnay/rust-toolchain` is the weakest case (a branch, not even a tag). All 13 `uses:` lines across `ci.yml`, `preship.yml`, `publish.yml`, and `build-native-tray.yml` are now pinned to a 40-character commit SHA with a trailing `# <tag>` annotation so dependabot can still propose upgrades and humans can still tell at a glance which version we're on. SHA pins prevent silent action-tag-tampering supply-chain attacks: an attacker who repoints `actions/checkout@v6` no longer affects us — git verifies the SHA on fetch, and a mismatch fails the workflow. Versions were also standardized across workflows (preship.yml's `@v4` references were bumped to the same `@v6.0.2` / `@v6.4.0` / `@v7.0.1` SHAs the other workflows use).
- 1 new helper script added (`scripts/install-hooks.mjs`, 32 LOC of logic + commentary). No new dependencies. No source-tree behavior changes. Consumer-install smoke test (`npm pack` → install in scratch repo) verifies `.git/hooks/pre-push` is NOT written. Unit suite unchanged.

## [3.0.48] — 2026-05-29

### Fixed
- **`fts_search` returned snippets from every indexed folder regardless of the caller's folder allowlist** (PARSE-002 from the 2026-05-28 audit). `searchAll` ran `MATCH` across the whole index and returned BM25 hits plus highlighted `snippet(...)` text from every folder, including Trash, Spam, and Archive. The per-agent grant gate already blocks the `folder` *argument* against the grant's allowlist — but when the caller omitted `folder` entirely, the grant gate had nothing to compare and let the call through; the response then carried decrypted body text from folders the agent had no business seeing. A sub-agent granted only `fts_search` + INBOX could read snippets of trashed password resets, sent drafts, or anything else still indexed. `FtsIndexService.search()` now accepts an optional `allowedFolders?: string[]`: `undefined` preserves the existing whole-index behavior for trusted/internal callers, a non-empty array narrows results via `folder IN (?, ?, …)` with bound parameters (no string interpolation, no SQL-injection surface even if a malicious grant slipped through), and an explicit empty array short-circuits to zero hits. The `fts_search` MCP tool resolves the caller's allowlist via a new `GrantManager.resolveAllowedFolders(clientId)` accessor exposed on the tool context as `getCallerAllowedFolders()` — stdio/static-bearer callers and grants without a folder restriction return `undefined`, so single-user setups see no behavior change.
- Folder allowlist matching aligned with `GrantManager.checkFolderCondition` via `COLLATE NOCASE` so a grant stored as `inbox` returns hits from an index of `INBOX` — without this the agent passed the tool-side gate then silently read zero rows.
- 7 new regression tests in `src/services/fts-service.test.ts` covering the allowlist contract (no allowlist returns every folder; `["INBOX"]` returns INBOX only with no Trash/Sent content; `[]` returns zero hits; allowlist + `folder` intersect to the single folder; `folder` outside the allowlist returns zero hits; case-insensitive matching via NOCASE; a SQL-injection payload smuggled through a folder name does not execute and the FTS table survives). Unit suite: 1646 passes.

## [3.0.47] — 2026-05-29

### Fixed
- **Scheduler send-after-cancel race (SMTP-001 + SMTP-002 from the 2026-05-28 audit).** Two interacting bugs in `src/services/scheduler.ts` could persist the wrong terminal status for a scheduled email when a user called `cancel_scheduled_email` while the underlying SMTP `sendEmail()` was in flight. SMTP-002 was the first half: `cancel()` only checked `status === "pending"` and there was no intermediate state to represent "send already started", so a cancel landing after `processDue()` had entered the await would return `success:true` to the user even though Proton had already accepted the message. SMTP-001 was the second half: even if the cancel did flip the in-memory record to `"cancelled"` before the await returned, the post-await assignment `item.status = "sent"` (or `"failed"` on retry exhaustion) and the post-loop `persist()` would clobber the cancel back to the send-result state — leaving disk inconsistent with what the user just saw. Fix introduces a `"sending"` intermediate status that `processDue()` flips and persists immediately *before* the `await sendEmail(...)`. `cancel()` now returns a discriminated union (`{ ok: true } | { ok: false, error: "not_found" | "already_final" | "in_flight" }`) so callers can tell the three failure modes apart; for items already in `"sending"`, cancel still writes `"cancelled"` (the cooperative-stop signal) and returns `{ ok: false, error: "in_flight" }` so the tool surface can warn the user that the message may still be delivered. `processDue()`'s post-await branches now re-read `item.status` from the current in-memory state and only flip to `"sent"`/`"failed"`/`"pending"` if it's still `"sending"` — a concurrent cancel's `"cancelled"` write wins. The `cancel_scheduled_email` tool handler in `src/tools/drafts.ts` was updated to map the new return shape to user-facing messages. `ScheduledEmail.status` in `src/types/index.ts` gains the `"sending"` variant; the JSON-store validator's `VALID_STATUSES` set was widened to match. Three new regression tests in `src/services/scheduler.test.ts` use a never-resolving `sendEmail` promise + manual resolve/reject to deterministically reproduce both halves of the race (SMTP-001 cancel-before-resolve, SMTP-002 cancel-returns-in_flight, plus a parallel case where the send subsequently rejects). Unit suite: 1643 passes.

## [3.0.46] — 2026-05-29

### Fixed
- **`passAccessToken` and `simpleloginApiKey` lived in `~/.mailpouch.json` as plaintext even when `credentialStorage="keychain"`** (CRED-001 from the 2026-05-28 audit). The startup migration only inspected `password` + `smtpToken` + `remoteBearerToken` + `remoteOauthAdminPassword`. The Proton Pass PAT and SimpleLogin API key — both decrypted-secret-access-grade — round-tripped through the config file forever, so `credentialStorage: "keychain"` was a silent lie whenever either was set. New keychain entries `pass-pat` and `simplelogin-api-key` now hold them; `migrateFromConfig` migrates on startup; `saveConfigWithCredentials` routes them on settings save; `loadAuxiliaryCredentialsFromKeychain` rehydrates the in-process Pass and SimpleLogin clients at boot.
- **`_homeFile()` honored env-var overrides with zero containment check** (CRED-002). `getConfigPath()` (`src/config/loader.ts`) carefully forbids `MAILPOUCH_CONFIG` from pointing outside `$HOME`, but `_homeFile` — used for `MAILPOUCH_PASS_AUDIT`, `MAILPOUCH_SCHEDULER_STORE`, `MAILPOUCH_REMINDERS`, `MAILPOUCH_AGENT_AUDIT`, `MAILPOUCH_AGENTS`, `MAILPOUCH_FTS_DB` — returned `process.env[envName]` verbatim. An attacker who could set env could redirect the Pass audit log to `/etc/cron.d/foo`, the agent-grants store to `/var/www/html/grants.json`, etc. Extracted to `src/utils/home-path.ts`, applied the same `resolve + startsWith(home)` check; throws on out-of-home paths so startup fails loudly.
- **AES-GCM key derived via single SHA-256 over low-entropy inputs (no salt-stretching, no KDF)** (CRED-003). `deriveKey` built the 256-bit key from `sha256(machine-id || hostname || const-salt || platform)` — the "salt" was a hard-coded string, machine-id is world-readable on Linux. Anyone with disk access plus host knowledge could recompute the key with a single hash. Introduced **v3 blobs** with a per-blob random 16-byte salt and `scrypt(machine-id || hostname || platform, salt, N=16384, r=8, p=1, 32)` key derivation. v1 and v2 blobs remain readable for transparent migration; the next `encrypt()` call rewrites them as v3. The "encrypted-file" mode still only resists the bag-of-disks threat model — recommend keychain for multi-tenant hosts (documented in CRED-003's audit-doc annotation).
- **E2E Bridge-mode harness corrupted the durable bridge-test config on every test spawn** (uncovered when shipping v3.0.45). Mailpouch's startup migration (above) blanked the password on disk, so subsequent tests in the same `test:e2e:bridge` run threw "missing connection.password". The harness now clones the operator-supplied bridge-test config to a unique `~/.mailpouch-e2e-bridge-*.json` temp path per `startE2E()` call with `credentialStorage: "config"` baked in, mirroring the existing Greenmail pattern. Operator's durable config is no longer mutated.
- 17 new tests: 6 for `homeFile` containment (CRED-002), 7 for v3 scrypt + v2/v1 back-compat + salt-tampering (CRED-003), 4 for aux credential migration paths (CRED-001). Unit suite: 1657 passes.

## [3.0.45] — 2026-05-28

### Fixed
- **IMAP IDLE loop silently downgraded to insecure TLS when cert load failed** (IMAP-001 from the 2026-05-28 audit). `runIdleLoop` always fell through to `{ rejectUnauthorized: false }` whenever `readPinnedBridgeCert` threw or `bridgeCertPath` was absent — completely ignoring the `allowInsecureBridge` opt-in that the main `connect()` path enforces. An operator who pinned a cert (or never opted into the legacy localhost behaviour) would unknowingly run the IDLE socket downgraded forever. The IDLE loop now mirrors `connect()`'s contract: if `allowInsecureBridge` is unset and `MAILPOUCH_INSECURE_BRIDGE !== '1'`, a missing/broken cert is logged at error level and the IDLE loop refuses to start (`idleActive = false`).
- **Six bulk IMAP paths joined unbounded UID sets into a single command** (IMAP-002). `bulkMoveEmails`, `bulkDeleteEmails`, `bulkMarkRead`, `bulkStar`, `bulkCopyToFolder`, `bulkDeleteFromFolder`, and the pre-flight in `findExistingUidsInLockedFolder` all built `present.join(',')` with no upper bound — Proton Bridge caps IMAP command lines around 8 KB, so ~800 nine-digit UIDs already crashed the batch and forced the per-UID fallback (minutes of held mailbox lock for what should be one round-trip). New `chunkUidsForWire(uids, maxLen=7500)` helper splits the UID list into bytes-bounded chunks; new private `chunkedBatchOp(present, perChunk, perUid, …)` runs the chunked call and falls back per-UID only for the failing chunk. All six bulk methods and the existence pre-flight now route through these helpers.
- 9 new regression tests added (`chunkUidsForWire` boundary cases, `bulkDeleteEmails` 2000-UID splitting, per-chunk fallback isolation, IDLE TLS refusal for both no-cert and broken-cert paths). Unit suite: 1640 passes.

## [3.0.44] — 2026-05-28

### Fixed
- **`bulkMarkRead` / `bulkStar` / `bulkCopyToFolder` defaulted to INBOX on cache miss** (IMAP-003 from the 2026-05-28 audit) — the three sibling bulk methods missed by the v3.0.41 fix. When `sourceFolder` was absent and the UID wasn't cached, they silently grouped the UID under `'INBOX'`, recreating the false-success class for these three operations. They now mirror the `bulkMoveEmails` pattern: cache lookup, then `getEmailById()` discovery, then explicit failure if still not found.
- **`findExistingUidsInLockedFolder` silently lied about UID absence on transport errors** (IMAP-006). The pre-flight FETCH used to `catch (e) { logger.warn(...); return new Set(); }`, which collapsed network/BAD/command-too-long errors into "UIDs not found" — a flat-out misrepresentation. It now rethrows; every bulk caller wraps the call in its own catch that surfaces `UID X existence check failed in folder Y: <reason>` so callers can distinguish "definitely absent" from "couldn't verify."
- **`setFlag` was missed by the v3.0.41 fix entirely** (IMAP-008, IMAP-009). Now (a) accepts an optional `sourceFolder` parameter, locking it directly and skipping the all-folders scan; (b) runs the same pre-flight `findExistingUidsInLockedFolder` UID check as every other mutator, so silent IMAP STORE no-ops on missing UIDs surface as honest errors.
- **`getEmailById` accepted unvalidated `folderHint`** (VALID-001). Six reading/sending tool handlers (`get_email_by_id`, `get_thread`, `extract_action_items`, `extract_meeting`, `reply_to_email`, `forward_email`) forwarded `args.folder` raw via `as string | undefined`. The service now calls `validateFolderName(folderHint)` defensively, and the tool handlers route the arg through a new `optionalFolderHint()` helper in `src/utils/helpers.ts` that produces a clean `McpError(InvalidParams, …)` before the IMAP wire. Also closes the related VALID-009 sibling at the tool layer.
- 9 new regression tests added in `src/services/imap-operations.test.ts` covering each bullet above. Unit suite: 1631 passes. E2E Greenmail (CI mode) green.

## [3.0.43] — 2026-05-28

### Fixed
- **preship gate's `npm-audit` step was advisory, not hard** (DOCS-009 from the 2026-05-28 audit). `docs/preship.md` advertised HIGH/CRITICAL CVE findings as ship-blocking — and the v3.0.42 CHANGELOG said the same — but `scripts/preship.mjs` wrapped the step with `mode: "advisory"`, so the gate exited 0 even when `check-npm-audit.mjs` returned 1. Step is now `mode: "hard"` with `successWhen: code === 0 || code === 2` so MODERATE/LOW (exit 2) print as warnings without blocking and HIGH/CRITICAL (exit 1) block the gate as documented.
- **`PRESHIP_SKIP=1` bypass was documented but unimplemented** (BUILD-014). The merge-pr skill's Step 2 references it; `docs/preship.md`'s "Bypassing the gate" table promised it. Now implemented at the top of `scripts/preship.mjs` — short-circuits with a loud `BYPASS: PRESHIP_SKIP=1` line to stderr so the bypass leaves an audit trail.
- **`npm-version-free` advisory inverted on network failure** (BUILD-002). The previous `successWhen: code !== 0 || !output.trim()` declared "version not yet on npm" whenever `npm view` failed — including when the registry was unreachable. Now distinguishes E404 (truly free), explicit "version listed" (already published), and unknown failure (printed as "could not verify (registry unreachable?)").
- **`LICENSES.json` baseline recorded 11 prod deps as `(unknown)`, neutering drift detection** (BUILD-004). `npm ls --omit=dev --long` returns nodes without `version` for off-platform native optionals; recording them produced false add/remove churn on every install. Check now filters unresolved-version deps from both current and baseline sets and surfaces them in a "skipped" diagnostic. Baseline regenerated; 180 prod deps tracked, 11 skipped.
- **`check-licenses.mjs` first-run silently staged a baseline AND failed** (BUILD-005). First run now errors with `license-inv ERROR: no baseline. Generate with: PRESHIP_LICENSE_WRITE=1 …` without writing — operators review and commit the baseline explicitly.
- **`tarball-smoke` only validated `--version` and never exercised packed-files presence** (BUILD-006). `--version` short-circuits before tray load; a missing `native/tray/index.js` would not have surfaced. Smoke now additionally runs `tar -tzf` against the produced tarball and asserts five required paths (`package/native/tray/index.{js,d.ts}`, `package/dist/{index,settings-main,utils/tray}.js`) are present.
- **Audit doc shipped** at `docs/audit-2026-05-28.md` — 241 findings across 12 detective beats from the full-repo audit. This release closes 1 High + 5 Medium from the audit; the remaining 25 Critical+High items land in v3.0.44 … v3.0.51 per the plan at `~/.claude/plans/bright-stirring-gray.md`.

## [3.0.42] — 2026-05-28

### Added
- **E2E test harness (`test/e2e/`)** — two-phase end-to-end coverage that drives the real mailpouch MCP server over stdio: Phase 1 against Greenmail in Docker (`npm run test:e2e:local`, 62 passing tests across 10 scenario files), Phase 2 against live Proton Bridge (`npm run test:e2e:bridge`, opt-in via `MAILPOUCH_E2E_BRIDGE_CONFIG`). Each scenario asserts on actual IMAP state via `imapflow` rather than tool return values — the property that catches false-success counters like the 3.0.41 bug class. `ImapFixtures` helper, deterministic seed data, container lifecycle helper, orphan-cleanup script for Phase 2. Full docs at `test/e2e/README.md`.
- **Permanent ship-readiness gate (`npm run preship`)** — single-command audit that runs typecheck, lint, version/CHANGELOG/README sync, secret scan (gitleaks with grep fallback), `npm audit` (HIGH/CRITICAL blocking; MODERATE/LOW advisory), license inventory drift check, build, unit tests, `npm pack` install smoke, Greenmail E2E, and Bridge E2E in deterministic order with a clear pass/fail summary table. Three depth levels: `preship:fast` (<30 s, runs in pre-push hook), `preship` (~5 min, for `/ship`), `preship:release` (adds tag/changelog-body/npm-version checks; wired to `prepublishOnly` so `npm publish` cannot run without it). Five standalone check scripts (`npm run check:version-sync`, `:secrets`, `:npm-audit`, `:licenses`, `:tarball`) for debugging individual failures. `.preship-audit-allow.json` for acknowledging specific advisories; `LICENSES.json` is the committed prod-dep license baseline (regenerate with `PRESHIP_LICENSE_WRITE=1`). New `.github/workflows/preship.yml` runs the gate on every PR with Greenmail as a service container (Bridge is `PRESHIP_NO_BRIDGE=1`-skipped on hosted runners; documented in `docs/preship.md`). `simple-git-hooks` installs a pre-push hook running `preship:fast`. `merge-pr` skill picks up `npm run preship` as Step 2 — every `/ship` is gated by it unless `PRESHIP_SKIP=1` is set as an emergency escape hatch.
- **`mailpouch --version` / `-v`** — short-circuits before any side effects and prints `mailpouch vX.Y.Z`. Used by the `tarball-smoke` preship step and routinely by users to identify the installed binary.

### Fixed
- **`optionalSourceFolder()` validator mismatch (follow-up to 3.0.41)** — `src/tools/actions.ts` and `src/tools/deletion.ts` were calling `validateFolderName()` (leaf-only, rejects `/`) for the `sourceFolder` argument. Every `sourceFolder: "Folders/X"` would have returned `Invalid sourceFolder` — a self-inflicted bug in the 3.0.41 fix caught by the new E2E harness. Now uses `validateTargetFolder()` which allows full IMAP paths.

## [3.0.41] — 2026-05-28

### Fixed
- **Mutating tools silently no-op'd when UIDs lived outside INBOX (Bugs A/B/C from 2026-05-28 report)** — `bulk_move_emails`, `move_email`, `bulk_mark_read`, `bulk_star`, `bulk_move_to_label`, `bulk_remove_label`, `bulk_delete_emails`, `delete_email`, `mark_email_read`, `star_email`, `archive_email`, `move_to_trash`, `move_to_spam`, `move_to_folder`, and `move_to_label` resolved the source folder via a cache lookup that scanned every folder for a matching UID. IMAP UIDs are folder-scoped, so the wrong folder would be selected (or INBOX defaulted) and the IMAP UID MOVE/STORE/DELETE would silently no-op while the tool reported `{ success: N, failed: 0 }`. Added an optional `sourceFolder` parameter to every mutating tool; when supplied it skips the cache lookup and locks the explicit folder. Strongly recommended whenever the UIDs came from a folder other than INBOX.
- **Success counters lied (Observation O2)** — counters were incremented unconditionally after each IMAP call. Added a UID FETCH pre-flight inside the folder lock to determine which UIDs actually exist there; missing UIDs are now reported in `failed`/`errors` rather than counted as success. Affects every bulk and singular mutation.
- **`bulk_remove_label` / `remove_label` `targetFolder` argument removed** — the parameter was schemaed but never plumbed to the IMAP call. Tools now document that callers must pass label-folder UIDs (Proton Bridge's label folders have their own UID space).

## [3.0.40] — 2026-05-27

### Fixed
- **Settings UI: page hangs after header load** — unescaped apostrophe in a JS string literal inside the `buildShellHtml` template literal. `\'` inside a TS template literal produces `'` in output, breaking the generated JS string `'This removes the server's ability...'` with a syntax error. The entire `<script>` block failed to parse, so the IIFE never ran and the page never initialized. Fixed by using `\\'` to produce a properly escaped `\'` in the output.

## [3.0.39] — 2026-05-27

### Fixed
- **Settings UI: native alert()/confirm() dialogs replaced** — all 13 `alert()` and 7 `confirm()` calls in the settings UI replaced with styled alternatives. Informational alerts become `toast()` notifications (red for errors, green for success, orange for warnings). Destructive confirmations use a new shared confirm modal that matches the UI's dark-theme design and supports per-action titles, body text, and button labels.

## [3.0.38] — 2026-05-27

### Fixed
- **Settings UI: all buttons and tabs unresponsive** — CSP3 spec: when any nonce appears in `script-src`, `'unsafe-inline'` is completely ignored for ALL inline scripts in that directive — including `onclick=`, `oninput=`, and `onchange=` event handlers. Every interactive element in the settings UI used inline handlers, so nothing worked. Fixed by replacing all inline event handlers across `shell.ts` and all 7 tab files with `data-action`/`data-tab`/`data-change`/`data-input` attributes dispatched by a central delegated listener inside the nonce-protected `<script>` block. Also corrected the false code comment in `server.ts` that claimed `'unsafe-inline'` "still covers inline onclick handlers (browser carve-out)".

## [3.0.37] — 2026-05-27

### Fixed
- **Settings UI: inline styles blocked by CSP** — `style-src` included a nonce alongside `'unsafe-inline'`. Per CSP3 spec, when any nonce is present in a directive's source list, `'unsafe-inline'` is completely ignored for that directive — including `element.style.*` JavaScript assignments and `style=""` HTML attributes. This caused every show/hide operation in the settings UI to be silently blocked (modals, tab switches, status indicators all invisible). Fixed by removing the nonce from `style-src`; the nonce is only meaningful for `script-src` where it gates `<script>` block execution.

## [3.0.36] — 2026-05-27

### Documentation
- **`draft_in_my_voice` prompt documented** — the 6th built-in MCP prompt was registered in code but absent from all user-facing docs. Added to `README.md` (Key Features + MCP Prompts table), `README_FIRST_AI.md` (MCP Prompts section), and `HELP.md` (new MCP Prompts subsection).
- **`get_server_version` tool documented** — added to the System tools section in `README_FIRST_AI.md` (5th system tool, core tier).
- **Destructive tools lists updated** — `shutdown_server` and `restart_server` (added to `DESTRUCTIVE_TOOLS` in 3.0.35) were missing from agent and user docs. Added to: `llms.txt` key facts, `README_FIRST_AI.md` operating guidelines, `HELP.md` destructive-confirmation section.
- **Stale counts corrected** — `llms.txt` claimed 71 tools (→ 70); `README.md` claimed 5 MCP prompts (→ 6) and 1,649 tests (→ 1,611); `llms.txt` core tier claimed ~26 tools (→ ~27). npm version badge in `README.md` updated (3.0.27 → 3.0.35).

## [3.0.35] — 2026-05-27

### Fixed
- **`shutdown_server` / `restart_server` bypassed `requireDestructiveConfirm`** — both tools carry `destructiveHint: true` in their MCP annotations but were absent from `DESTRUCTIVE_TOOLS`. The CallTool gate checks that set, not the annotation, so when `requireDestructiveConfirm: true` was set these two operations silently skipped the `{ confirmed: true }` guard. Added to `DESTRUCTIVE_TOOLS`; also added a regression test.
- **`pass_get` annotation contradicted its destructive gate** — the tool was correctly listed in `DESTRUCTIVE_TOOLS` (credential retrieval warrants the confirm guard) but its MCP annotation was `readOnlyHint: true`, telling clients it was safe and non-modifying. Changed to `destructiveHint: true` to match the gate.
- **Stale tier-count comments** — `TOOL_CATEGORY_TIER` comments claimed "~26 / ~28" for core and "~50" for extended; actual cumulative counts are 27/29 and 64/66 respectively (aliases + pass were added to extended after the comments were written). Replaced the inline estimates with a precise breakdown table.
- **README tool count stale** — three mentions of "69 tools" updated to "70 tools" following the addition of `get_server_version` in 3.0.34.

## [3.0.34] — 2026-05-27

### Added
- **`get_server_version` tool** — agents can now query the running server version directly via MCP (`get_server_version` → `{ version: "3.0.34" }`). Belongs to the `system` / `core` tier so it is always available.
- **Version label in tray icon menu** — both the MCP server tray and the standalone settings-daemon tray now display the running version (e.g. `v3.0.34`) as a disabled menu item below the `mailpouch` header.

## [3.0.33] — 2026-05-27

### Fixed
- **Settings page completely non-interactive** — the CSP header used `style-src/script-src 'nonce-...'` without `'unsafe-inline'`. CSP3 nonces cover `<script>`/`<style>` block elements but do NOT cover (a) inline `onclick="..."` event handlers or (b) `style="..."` attributes on HTML elements. Effect: every button click was silently swallowed, and every `style="display:none"` attribute was ignored — causing the "Approve with conditions" grant modal and other hidden elements to render in normal document flow on top of the settings content. Added `'unsafe-inline'` to both directives; in CSP3 browsers the nonce still gates `<script>`/`<style>` blocks (nonce overrides unsafe-inline for those), while unsafe-inline covers event handlers and inline style attributes.
- **Wizard-view flash on load** — `#wizard-view` CSS had `display:flex` as its default, so an empty flex container was briefly visible before JavaScript ran. Changed default to `display:none`; the JS sets `display:flex` explicitly when the wizard is needed.

## [3.0.32] — 2026-05-27

### Fixed
- **Tray Quit now exits reliably** — `gracefulShutdown` previously called `imapService.disconnect()` and `smtpService.close()` on a dead TCP socket (Bridge off), which could hang indefinitely and prevent `process.exit()` from ever running. Fixed by: (1) destroying the tray icon before any async cleanup so the icon vanishes immediately on click; (2) adding a 5 s hard-exit timeout so the process always terminates even if IMAP/SMTP teardown stalls; (3) adding a 50 ms D-Bus flush pause after cleanup so the native SNI deregistration message lands before fds close.
- **Process stays alive after MCP client disconnect** — when Claude cowork (or any stdio MCP client) exits, stdin closes but the settings server + tray were keeping the event loop alive indefinitely. The process now listens for `stdin close` and calls `gracefulShutdown` automatically so the tray icon disappears when the client goes away.
- **Duplicate shutdown guard** — added `_shutdownInProgress` flag so concurrent SIGINT/SIGTERM/tray-quit signals don't race through multiple `gracefulShutdown` invocations.

## [3.0.31] — 2026-05-27

### Changed
- **Settings page tab lazy-loading** — the 5551-line `server.ts` monolith is split into focused modules: `shell.ts` (page shell + all JS), `styles.ts` (CSS), and `src/settings/tabs/{wizard,setup,permissions,accounts,agents,status,logs}.ts`. A new `GET /api/tab/:name` route serves each tab's HTML on first click; subsequent visits use the cached fragment. A broken tab shows an inline error without affecting other tabs. The route uses a `Set`-based allowlist to block prototype-pollution attempts (`__proto__`, `constructor`, etc.).
- **Concurrent tab-click deduplication** — rapid double-clicks on a tab now await the same in-flight fetch via a `_tabLoading` Map rather than launching duplicate requests.
- **Hardcoded colors replaced with CSS variables** — grant-approval modal and accounts modal no longer use literal `#1b1b1e`, `#222`, `#444`, etc.; all colors now reference `var(--surface)`, `var(--border)`, `var(--text)`, etc.

### Fixed
- **`validateAttachments` unbounded array** — `attachments` arrays are now capped at 50 items; previously an arbitrarily large array would pass validation and be forwarded to the MIME builder.
- **Bulk-op silent INBOX fallback now logged** — `bulkMarkRead`, `bulkStar`, and `bulkCopyToFolder` emit a `warn`-level log entry when a UID is not in the email cache and the operation falls back to INBOX, making the pre-existing design limitation observable.

## [3.0.30] — 2026-05-27

### Fixed
- **`parseEmails` now accepts "Display Name \<email\>" format** — previously `send_email` (and `schedule_email`) would silently drop any To/CC/BCC address passed as `"John Doe <john@example.com>"` because `isValidEmail` rejects spaces. The address portion inside angle brackets is now extracted before validation, so both bare-address and display-name formats are accepted.

## [3.0.29] — 2026-05-27

### Fixed
- **Remaining UID-scope holes in five tools** — `reply_to_email`, `forward_email`, `get_thread`, `extract_action_items`, and `extract_meeting` all called `getEmailById(uid)` without a folder hint, leaving them vulnerable to the same cross-folder UID collision fixed in 3.0.28. Each tool now accepts an optional `folder` parameter (schema + handler) that is forwarded as the `folderHint` to `getEmailById`.

## [3.0.28] — 2026-05-27

### Fixed
- **UID-scoping bug (root cause for Bugs 1, 2, 4)** — IMAP UIDs are per-mailbox, not globally unique. The email cache was keyed by bare UID, so UID 63 in Drafts collided with UID 63 in INBOX. Cache keys are now `${folder}:${uid}` throughout. A new `findCacheEntryByUid(uid)` linear-scan helper covers callers that don't know the folder in advance (single-email `setFlag`, `downloadAttachment`, bulk fallback paths).
- **`search_emails` deadlock / timeout (Bug 3)** — `searchSingleFolder` held the imapflow mailbox lock, then called `getEmailById` which attempted to acquire a second lock on the same connection. imapflow serializes lock acquisitions, so the inner lock request never resolved → MCP timeout (-32001). Fixed by fetching messages directly within the already-held lock instead of delegating to `getEmailById`.
- **`search_emails` folder-scope leak (Bug 2)** — because of the cache collision, a hit for UID 63 in the wrong folder was returned as a Drafts result. Eliminated by the UID-scoping fix above.
- **`get_email_by_id` wrong-folder result (Bug 1)** — same root cause. `get_email_by_id` now accepts an optional `folder` param; when provided, it constrains both the cache lookup and the IMAP search to that folder only.
- **`remind_if_no_reply` wrong-message + opaque error (Bug 4)** — now accepts an optional `folder` param (default "Sent") passed to `getEmailById`. Added `fireAt > now` guard to reject reminders that would fire immediately in the past. Wrapped fetch and persist steps in try/catch that surfaces the real exception instead of swallowing it as "An error occurred".
- **Destructive bulk operations UID safety** — `bulkMoveEmails`, `bulkDeleteEmails`, and `bulkDeleteFromFolder` no longer assume uncached emails live in INBOX. They now call `getEmailById` to discover the real folder before operating, and count "email not found" as a per-item failure rather than silently operating on the wrong folder.

## [3.0.27] — 2026-05-26

### Docs
- **`docs/proton-bridge-overview.md`** — new "Supported Bridge Versions" section pinning Bridge v3.24.x (Nescio, latest v3.24.2 2026-04-20) as the tested baseline. Calls out the IMAP connection limiting added in v3.24.0 and the label-endpoint mapping churn across v3.23.0 → v3.24.1 so future debugging has the upstream version context. No code changes.

## [3.0.26] — 2026-05-26

### Changed
- **Dependency bumps** (Dependabot, #117/#121/#122/#123/#124):
  - `better-sqlite3` 12.9.0 → 12.10.0 (patch)
  - `nodemailer` 8.0.7 → 8.0.8 (patch)
  - `@types/node` 25.6.0 → 25.9.1 (dev, minor)
  - `vitest` 4.1.5 → 4.1.7 (dev, patch)
  - `@vitest/coverage-v8` 4.1.5 → 4.1.7 (dev, patch)

## [3.0.25] — 2026-05-26

### Fixed
- **Remaining bulk handlers — single batched IMAP per folder** — `bulk_mark_read`, `bulk_star`, `bulk_move_to_label`, and `bulk_remove_label` no longer loop over single-email IMAP calls. New `ImapService` methods `bulkMarkRead`, `bulkStar`, `bulkCopyToFolder`, and `bulkDeleteFromFolder` each issue a single `UID STORE` / `UID COPY` per source folder, with a per-folder fallback to per-UID commands on batch error. Closes the same class of regression as #120 for the four handlers that were left as follow-up because no batch service method existed yet.
- **All bulk handlers post-filter guard** — all-invalid emailIds (after the `/^\d+$/` filter) now throws `InvalidParams` instead of silently returning `{success:0, failed:0, errors:[]}`.

## [3.0.24] — 2026-05-26

### Security
- **Credential encryption — per-system entropy (v2 blob format)** — the AES-256-GCM key for `passwordEncrypted` / `smtpTokenEncrypted` is now derived from `machine-id || hostname || salt || platform`. The previous v1 derivation used only `hostname || salt || platform`, so a VM/container clone (or any host sharing hostname + platform) could decrypt credentials from a sibling install. Machine secret resolved in priority order: `/etc/machine-id`, `/var/lib/dbus/machine-id`, macOS `IOPlatformUUID`, Windows `MachineGuid`, then a per-install `~/.mailpouch-machine-id` (mode 0600) as fallback. `MAILPOUCH_MACHINE_SECRET` env override for containers / tests.
- **Transparent v1 → v2 migration** — existing encrypted blobs continue to decrypt with the legacy key; `migrateCredentials()` (run at every startup) upgrades v1 blobs in place by decrypting with the old key and re-encrypting with the new key. Operators never have to re-enter credentials.

## [3.0.23] — 2026-05-26

### Security
- **`pass-cli` env hardening** — the Proton Pass subprocess now receives only `PATH`, `HOME`, `LANG`, `LC_ALL`, and `PROTON_PASS_PAT`. Previously it inherited the full parent `process.env`, so a compromised CLI binary would have read every other credential the server held.
- **`pass-cli` PATH resolution** — bare-name `passCliPath` is now resolved via `which` at startup and validated against a trusted prefix list (`/usr/bin`, `/usr/local/bin`, `/opt/`, `/bin/`, `/opt/homebrew/bin/`). Refuses agent-writable PATH directories like `~/.local/bin` that could shadow the real binary.
- **Bridge shutdown by PID** — `killProtonBridge()` now records the spawn PID and kills that PID directly (SIGTERM, then SIGKILL after 2 s). Replaces `pkill -f proton-bridge`, which matched the full command line and could kill any unrelated process whose argv contained that string.
- **Bridge TOCTOU** — dropped the `existsSync(bridgePath)` pre-check that opened a swap window between check and spawn.
- **Bridge cert pinning** — the configured CA cert is now hashed on first read; subsequent reads verify the hash and refuse the connection on mismatch. Closes the TLS-cert-swap TOCTOU.
- **AppleScript injection** — `escAppleScript()` strips ASCII control chars (0x00–0x1F + 0x7F) in addition to escaping `"` and `\`. Agent-supplied notification reasons can no longer break out of the `display notification … with title …` clause.
- **Windows toast XML injection** — new `escXml()` HTML-escapes `& < > " '` for all content embedded in the WinRT toast XML before the PowerShell single-quote layer.
- **Self-signed cert cleanup** — `tryGenerateSelfSignedCert()` now `rmSync`s its temp directory in a `finally{}` block. A crash no longer leaves the generated private key in `/tmp`.
- **OAuth admin password + bearer token encryption** — `remoteBearerToken` and `remoteOauthAdminPassword` are now migrated into the OS keychain on first run alongside `password`/`smtpToken`. Previously these two equally-valuable secrets were the only credentials still stored plaintext in `~/.mailpouch.json`.
- **Token revocation propagation** — outstanding OAuth access tokens are immediately invalidated when a grant transitions to revoked/denied/expired. Previously tokens stayed valid until the 24 h TTL.
- **Token IP pinning** — `IssuedToken` records the issuing client IP; `verifyToken()` rejects mismatched-IP requests. Closes the "issue from loopback, replay from remote" gap even when no per-agent `ipPins` are configured.
- **IPv6 X-Forwarded-For loopback gap** — the loopback check that gated XFF trust now accepts only exact `127.0.0.1` / `::1` / `::ffff:127.0.0.1`. Other IPv4-mapped IPv6 loopback variants (common in dual-stack containers) no longer admit a spoofed X-Forwarded-For.
- **Logger redaction expansion** — `cookie` and `oauth` field families now redacted alongside `password`, `token`, `secret`, etc.
- **Settings UI CSP nonces** — dropped `'unsafe-inline'` for both `script-src` and `style-src`. A fresh 128-bit nonce is generated per response and emitted on the CSP header and on every inline `<script>` / `<style>` tag.
- **Access token: header-only** — query-string `?token=` removed. Tokens in URLs leak into browser history, referer headers, and proxy logs.
- **HSTS** — upgraded to `max-age=31536000; includeSubDomains; preload`.
- **Mode 0600 sweep** — `~/.mailpouch.log` and `~/.mailpouch-fts.db` (plus `-wal` / `-shm` / `-journal` siblings) are now explicitly chmod'd to 0600 after creation.
- **PKCE strictness** — `code_challenge` and `code_verifier` are now validated as 43–128 chars of base64url alphabet (`[A-Za-z0-9_\-.~]`) before SHA-256, blocking short-verifier brute-force.
- **Authorization-code error opacity** — unknown code, wrong `client_id`, wrong `redirect_uri`, and PKCE-mismatch all return the same `invalid_grant: "Invalid authorization code."` message. No more client-id enumeration via error-string differences.
- **LAN origin: IPv6 ULA / link-local** — origin validation in LAN mode now admits `fc00::/7`, `fd00::/8`, and `fe80::/10` alongside IPv4 RFC-1918.
- **Tool-permissions allowlist** — POST `/api/config` now filters incoming `permissions.tools` keys against the canonical `ALL_TOOLS` set; an attacker can no longer plant a key for a future tool that doesn't yet ship.
- **Rate-limit LRU eviction** — bucket eviction switched from insertion-order to LRU by most-recent activity. Blocks the "rotate fake keys to force out legitimate clients" DoS-of-DoS pattern.
- **Folder allowlist fail-closed** — folder-scoped tools without a recognized folder argument now hit a `false` decision instead of being silently allowed. `FOLDER_AGNOSTIC_TOOLS` enumerates the tools that legitimately operate without a folder.
- **`sanitizeData()` recursion bounded** — logger sanitisation now caps at depth 100 with a `[depth-limit]` placeholder. Defeats stack-blow / CPU-burn via adversarial deeply-nested JSON.
- **State parameter length-capped** — OAuth `state` rejected if >500 chars (both GET and POST authorize).
- **Escalation reason log injection** — the audit log now records the same sanitized reason that's persisted to the pending file (control chars stripped, capped at 500). Agent-supplied `\r\n` can no longer inject fake JSONL lines.
- **SSE field sanitisation** — `event:` and `id:` SSE frame fields now strip `\r\n` before writing.
- **`credentialStorage` derived from observed state** — the badge in the settings UI is now computed from the actual presence of encrypted blobs / plaintext creds; a forged value in the config file can no longer hide plaintext-on-disk storage.
- **Dependency** — `qs` 6.15.0 → 6.15.2 via `npm audit fix` (GHSA-q8mj-m7cp-5q26 DoS).

## [3.0.22] — 2026-05-26

### Security
- **`safeConfig` credential leak** — `simpleloginApiKey` and `passAccessToken` are now redacted to `"••••••••"` before `GET /api/config` is sent to the browser. Previously both were returned in plaintext alongside `password`/`smtpToken`.
- **SSRF via `simpleloginBaseUrl`** — `validUrl` now enforces `http:`/`https:` scheme only. `file://`, `javascript:`, `ftp://`, and internal network addresses are rejected with HTTP 400 at save time.

### Fixed
- **SimpleLogin / Pass token revocation** — clearing the API key or PAT field in Settings and clicking Save now removes the stored value. Previously the truthy guard blocked empty-string writes, making revocation impossible from the UI.
- **Whitespace in pasted tokens** — `simpleloginApiKey` and `passAccessToken` are now `.trim()`'d before storage, preventing silent 401 failures from clipboard-pasted keys with trailing newlines.
- **`bulk_delete_emails` / `bulk_delete` performance** — replaced per-email loop with `imapService.bulkDeleteEmails()` (single batched IMAP UID STORE). Closes #120.
- **`bulk_move_emails` performance** — replaced per-email loop with `imapService.bulkMoveEmails()` (single batched IMAP UID COPY + expunge). Closes #120.
- **`sendProgress` restored** — `bulk_delete_emails` and `bulk_move_emails` now emit a completion progress notification when a `progressToken` is provided, honouring the documented contract.
- **Silent success on invalid email IDs** — if all IDs in a bulk call fail the numeric-UID filter, the handler now throws `InvalidParams` instead of returning `{success:0, failed:0, errors:[]}`.
- **`remoteMode` silent stdio fallback** — if `remoteMode` is set in config but no bearer token or OAuth credentials are configured, the server now exits with a clear error message instead of silently falling back to stdio (which caused invisible hangs under NSSM/systemd).
- **`settingsPort` out-of-range silent no-op** — values outside 1–65535 now return HTTP 400; previously the assignment was silently skipped.
- **`settingsPort` falsy-zero** — `parseInt(port) || 8765` replaced with `isNaN(p) ? 8765 : p` so port `0` is passed to the server for proper rejection rather than silently substituted.

### Added
- **`--no-tray` / `--no-settings-ui` CLI flags** — the `mailpouch` binary now accepts these flags for headless service deployments (NSSM, systemd) where no display is available. Partially addresses #119.

## [3.0.21] — 2026-05-08

### Added
- **Optional Integrations UI** — Settings → Setup tab now has a dedicated "Optional Integrations" card for SimpleLogin API key / base URL and Proton Pass PAT / CLI path. Previously these could only be set by editing `~/.mailpouch.json` directly.
- **Desktop notifications toggle** — Settings → Setup tab toggle to enable/disable native OS notifications for agent permission requests (default on). Previously the field existed in config but had no UI control.
- **HELP.md** — new comprehensive task-oriented help guide covering all features, configuration, and troubleshooting.
- **docs/index.md** — full documentation index with feature map.

### Fixed
- Settings UI → agent setup JSON (`/api/agent-setup`) was hardcoding port `8766` in the `settingsUi` URL instead of the actual running port.

## [3.0.17] — 2026-05-08

### Changed
- **Permission presets redesigned** — presets now follow a clear tiered model:
  - **Read-Only**: reading/analytics/system unlimited; all writes blocked
  - **Send-Only**: reading unlimited; send/forward/schedule 50/hr, `remind_if_no_reply` 100/hr; actions, deletion, folder writes, and bulk ops disabled; `sync_emails` and `get_contacts` added
  - **Supervised**: reading unlimited (no rate limits on read ops); sending 200/hr, `schedule_email` 100/hr, bulk actions 100/hr, deletion 20/hr, folder delete 20/hr, folder create/rename 100/hr, alias create 50/hr, alias delete 20/hr, server lifecycle 5/hr
  - **Full Access**: all tools, no limits (description now uses dynamic tool count)
- **Docs and help text updated** — README, README_FIRST_AI, SECURITY, TUI preset descriptions, loader comment block, and Settings UI wizard/table text all reflect new values

### Fixed
- `schedule_email` was missing its rate limit in Supervised (it's in the drafts category, not sending)
- Folder write tools (`create_folder`, `delete_folder`, `rename_folder`) had no rate limits in Supervised
- Full Access description hardcoded "47 tools" — now renders `ALL_TOOLS.length` dynamically
- Test assertions updated to match new Supervised rate limits

## [3.0.12] — 2026-05-01

### Fixed
- **Graceful update/restart lifecycle** — `POST /api/install-update` now triggers an automatic process restart after a successful npm install; tray icon is torn down and the settings web UI restarts cleanly in the new process. Browser polls `/api/status` and reloads when the server is back.
- **`restart_server` MCP tool** — removed the detached-spawn-with-`MAILPOUCH_RESPAWN` pattern that was leaving a zombie process with no tray and no settings UI. Now simply calls graceful shutdown; the MCP client reconnects and spawns a clean process with tray and settings server.
- **Standalone `mailpouch-settings` self-restart** — passing `--update` via the settings UI now tears down the tray before respawning, preventing duplicate icons.

## [3.0.11] — 2026-05-01

### Fixed
- `stripHtml`: decode `&amp;` last to prevent double-unescaping (`&amp;lt;` → `&lt;`, not `<`).

### Test
- Raise `tryGenerateSelfSignedCert` test timeout to 20 s to fix flaky Windows CI.

## [3.0.10] — 2026-05-01

### Chore
- Version bump and README badge sync.

## [3.0.9] — 2026-05-01

### Security
- **AES-256-GCM encrypted credential storage** — replaces broken OS keychain
  integration with encrypted-at-rest credentials stored directly in the config
  file. Key derived from `SHA256(hostname|salt|platform)` using Node.js built-in
  `crypto` only (no new dependencies). Credential priority chain on load:
  keychain → encrypted-file → plaintext (legacy migration). Existing plaintext
  passwords auto-migrate to encrypted-file on next startup when keychain is
  unavailable. `credentialStorage` field gains `"encrypted-file"` value;
  settings UI badge updated accordingly. Encrypted blobs never sent to the
  browser — `safeConfig()` strips them before responding.

### Added
- **Password visibility toggle** — all password and SMTP-token inputs now have
  an eye-icon button that switches between masked and visible. On page load the
  fields are blank (no placeholder ciphertext injected); clicking the eye simply
  reveals whatever the user has typed.

## [3.0.8] — 2026-05-01

### Security
- **`delete_folder` added to `DESTRUCTIVE_TOOLS`** — the tool had
  `destructiveHint: true` in its annotations but was missing from the
  confirmation-gate set, allowing a single unconfirmed call to permanently
  delete a folder and all its emails. Now requires `{ confirmed: true }` or
  MCP elicitation like `delete_email`.

### Fixed
- **`better-sqlite3` promoted to hard dependency** — moved from
  `optionalDependencies` to `dependencies`. FTS is a core feature; a missing
  native binding now surfaces immediately at the first FTS call rather than
  producing a silent degraded state.
- **FTS rebuild race condition** — concurrent `fts_rebuild` calls could
  interleave `clear()` and `upsertMany()`, leaving the index empty mid-rebuild.
  A module-level `_ftsRebuilding` flag returns `isError: true` immediately to
  any second caller.
- **`loadConfig()` per-call file reads eliminated** — was reading and parsing
  `~/.mailpouch.json` from disk on every tool dispatch. Now cached with a 15 s
  TTL; the cache is invalidated immediately on `saveConfig()` and detects
  external edits via mtime on the next TTL boundary.
- **Analytics `storageUsedMB` crash** (`body?.length ?? 0`) — `trimForAnalytics()`
  sets `body: undefined`; `get_email_stats` accessed `email.body.length`
  unconditionally. Harness test now asserts all numeric stat fields are present
  and non-negative.

## [3.0.7] — 2026-05-01

### Fixed
- **README accuracy audit** — corrected six stale or false claims: `any`
  annotation count, wizard step 3 label ("Credentials" → "Account"), keychain
  storage scope (Bridge password + SMTP token only), missing Accounts and
  Agents tabs in settings UI description, SMTP backoff code `451` → `454`.
- **`src/utils/tray.ts` comment** — updated committed prebuilt count from 4 to
  5 now that `linux-arm64-gnu` is built and shipped.

## [3.0.6] — 2026-05-01

### Fixed
- **Node 25 TLS SNI breakage on SMTP and IMAP** — Node 25 rejects IP literals
  as the TLS `servername` before `checkServerIdentity` runs. Extracted a shared
  `buildBridgeTlsOptions()` helper (`src/services/bridge-tls.ts`) that sets
  `servername: "localhost"` on all three Bridge TLS option blocks (SMTP +
  IMAP primary connect + IMAP idle reconnect). Four new unit tests added
  (`bridge-tls.test.ts`). Closes / expands on #104.
- **ReDoS in HTTP Bearer token regex** — greedy `.+` in
  `src/transports/http.ts` replaced with `\S+` on a pre-trimmed string.
- **`nodemailer` bumped** from `~8.0.2` → `~8.0.7` (#108) — picks up upstream
  CVE fixes.
- **aarch64 cross-compile CI** — Ubuntu 24 Noble split `libglib2.0-dev-bin`
  into two `Architecture: all` packages; added both as a pre-install step so
  the arm64 cross-dependency chain resolves cleanly.
- **Stale `glib` direct dependency removed** from `native/tray/Cargo.toml` —
  only `gtk` APIs are called; the explicit `glib = "0.18"` was unused and
  triggered a Dependabot alert.

### Changed
- **CI matrix** — dropped `macos-13` (GitHub retired the Intel hosted runner
  pool; jobs were queuing indefinitely). `macos-latest` (arm64) retained.
- **Dependabot / vitest** bumped `vitest` and `@vitest/coverage-v8` from
  4.1.4 → 4.1.5 (#105, #106).

## [3.0.5] — 2026-04-20

### Fixed
- **Update check now works in all GUI MCP client environments** (#102). The
  previous fix (#101) resolved the `npm` binary path, but `npm` is itself a
  shell script (`#!/usr/bin/env node`) that still needs `node` on `PATH`.
  Both `/api/check-update` and `/api/install-update` now inject
  `path.dirname(process.execPath)` at the front of the child process `PATH`
  so npm can always find its own Node runtime regardless of what the parent
  client passes.

## [3.0.4] — 2026-04-20

### Fixed
- **Volume trends bucket count was off by one near DST transitions** (#). The
  `calculateVolumeTrends` implementation used `setDate`/`getDate` (local time)
  to build bucket keys but `toISOString()` for the key string (UTC). Across a
  daylight-saving transition two adjacent local calendar days could produce the
  same UTC ISO date, collapsing 365 buckets to 364. Switched to pure UTC
  arithmetic (`Date.UTC` + ms-per-day offset) which is DST-safe and always
  produces exactly the requested number of buckets.

## [3.0.3] — 2026-04-20

### Fixed
- **Update check no longer fails with `spawn npm ENOENT`** (#101). The
  `/api/check-update` and `/api/install-update` settings endpoints called
  `spawn("npm", ...)` which fails when `PATH` is stripped by GUI MCP
  clients (Claude Desktop, VS Code). Both now derive the npm binary path
  from `path.dirname(process.execPath)` — npm is always co-located with
  the running node binary.

### Changed
- `imapflow` bumped from 1.3.1 → 1.3.2 (#100).
- CI: `actions/setup-node` bumped from v5 → v6 (#99).
- CI: `actions/upload-artifact` bumped from v4 → v7 (#98).

## [3.0.2] — 2026-04-20

### Fixed
- **Duplicate tray icons when cowork spawns multiple MCP subprocesses** (#97).
  Each MCP process called `_initTray()` independently, producing one icon per
  process. The first process to bind the settings port now owns the tray;
  subsequent processes detect `_settingsExternal = true` and skip tray init.

## [3.0.1] — 2026-04-20

### Fixed
- **Tray icon now appears when launched by GUI MCP clients** (#95). Claude
  Desktop and VS Code strip `DISPLAY` / `WAYLAND_DISPLAY` when spawning
  stdio subprocesses; the tray precondition check bailed with "no display
  environment" even on graphical hosts. Added `inheritDisplayFromParent()`
  which reads `/proc/<ppid>/environ` on Linux and copies the display vars
  into `process.env` before tray init. Also migrated the MCP's `_initTray()`
  from direct `systray2` usage to the shared `createTray()` facade so it
  picks the native tauri `tray-icon` backend on GNOME instead of the
  broken systray2 path (same facade the standalone `mailpouch-settings`
  daemon already used).
- Stale hardcoded `"2.2.0"` version literal in the `/agent-setup` JSON
  output — now derived from `package.json` like the MCP `serverInfo.version`,
  so agents always see the actual running version.

## [3.0.0] — 2026-04-20

### Security
- **Per-account Bridge passwords now route through the OS keychain on every
  save path** (#93). The Accounts-tab CRUD endpoints previously wrote
  plaintext passwords into `~/.mailpouch.json`; they now store them under
  `bridge-password:<acct-id>` / `smtp-token:<acct-id>` keychain entries
  (same `mailpouch` service name as the legacy single-account key) and
  scrub the on-disk JSON. Legacy installs with the suffix-less
  `bridge-password` key continue to work via a back-compat read path.
  The in-memory `AccountManager` is also refreshed on every save so the
  MCP reconnects immediately — no restart needed.
- CSRF session-expired responses carry a machine-readable `code:
  "session_expired"` and the settings-UI JS auto-reloads the page on
  403 instead of surfacing the cryptic raw error (#82).

### Added
- **Native system-tray binding** (`native/tray/`) via napi-rs around the
  `tauri-apps/tray-icon` Rust crate — the same crate Tauri ships in
  production. Renders correctly on modern GNOME, NSStatusBar, and
  Shell_NotifyIcon; replaces the `systray2` Go binary wherever a
  prebuilt is available. systray2 stays as a fallback on platforms
  without a committed prebuilt yet. (#88, #89, #90, #91, #92)
- Prebuilts for linux-x64-gnu, linux-arm64-gnu, darwin-arm64,
  win32-x64-msvc, and win32-arm64-msvc. darwin-x64 (Intel Mac) falls
  back to systray2 cleanly (the GNOME rendering bug doesn't affect
  macOS). CI workflow `.github/workflows/build-native-tray.yml`
  produces prebuilts for the full 6-target matrix on every push.
- Brand-matching tray icon generator (`src/utils/icon.ts`): 64×64 base
  with a `#6D4AFF` → `#9B6DFF` gradient + rounded corners, matching
  the settings-UI `.logo-icon` CSS byte-for-byte. Windows ICO packs
  16/32/48/64 sub-sizes for hi-DPI sharpness. (#88)
- **Persistent tray via `mailpouch-settings`** — the standalone
  entry point now carries its own tray icon for its lifetime. Users
  add it to their OS autostart (systemd user unit / LaunchAgent /
  Windows Startup folder) and get a tray that stays resident so
  clicking "Open Settings" anytime brings the UI back. The MCP's
  embedded tray coexists via a probe-then-reuse check (#86, #89).
- Bridge cert auto-detect + file-picker upload in the settings UI
  — every cert-path field on the Setup tab, first-run wizard, and
  Accounts form gets a **Detect** button (scans `~/Downloads`,
  `~/Documents`, `~/Desktop`, `~/`, and Bridge's per-OS in-place
  location) and a **📁 Browse** button (native file picker → POST
  to new `/api/upload-bridge-cert` → written to
  `~/.mailpouch-bridge-cert.pem` at mode 0600). No manual path
  typing required. (#83)
- `/api/search-bridge` now falls back to `which proton-bridge /
  protonmail-bridge / bridge` on POSIX when the hardcoded
  candidate list misses — catches Debian/Ubuntu's
  `/usr/bin/protonmail-bridge` and Homebrew/AUR/Flatpak installs.
  (#83)

### Changed
- `SMTPService` constructor no longer throws when the configured
  Bridge cert path is unreachable — the error is deferred to the
  first `sendEmail()` / `verifyConnection()` call. Previously a
  stale or wrong `bridgeCertPath` crashed the MCP at module load,
  before stdio came up, leaving no way to surface a structured
  error to the client. The new `SMTPService.initError` field
  carries the actionable message and `get_connection_status` now
  surfaces it in the `smtp.initError` response field. (#84)
- `AccountManager` gains `rebuildFromRegistryAsync()` + an
  `applyKeychainCredentials(password, smtpToken?)` method that
  the boot path and settings-save endpoints use to push fresh
  credentials into the per-account SMTP/IMAP services without
  an MCP restart. Closes a regression introduced by the
  multi-account registry rollout where keychain-stored
  credentials were never propagated to per-account services.
  (#87, #93)
- Settings-UI startup now **probes the configured port for an
  existing mailpouch instance** before retrying the bind. When a
  standalone `mailpouch-settings` daemon is already listening, the
  MCP logs "Reusing existing Settings UI at …" and silently shares
  the port instead of emitting a four-retry WARN cycle. Non-
  mailpouch listeners still get the actionable "another process is
  using this port" warning. (#86)

### Fixed
- Six detached-spawn sites (`.unref()` without a matching
  `.on('error', …)` listener) hardened against `ENOENT` crashes on
  hosts missing a target binary — including the "Restart Claude
  Desktop" tray action that previously took the settings server
  down on Linux (no Linux build of Claude Desktop exists). (#82)
- Platform-aware Claude-Desktop detection via `existsSync` on
  `/Applications/Claude.app`, `%LOCALAPPDATA%\AnthropicClaude\...`,
  etc.; returns a structured `{ok:false, error:…}` response when the
  binary isn't installed instead of crashing. (#82)
- `loadConfig()` preserves `settingsPort` and `credentialStorage`
  fields across load/save round-trips. The Settings-UI port field
  was previously reverting to `8765` after every save even though
  the intended value had persisted to disk; the read path was
  silently dropping top-level fields. Validation mirrors the
  `POST /api/config` merge path (`Math.round` → `[1, 65535]` range
  check). (#85)
- Tray icon click routing via napi-rs `ThreadsafeFunction` — the
  default `ErrorStrategy::CalleeHandled` invokes the JS callback
  Node-style as `(err, value)` so our `(id) => …` handler was
  receiving `null` as the first arg and silently no-op'ing every
  click. Switched to `ErrorStrategy::Fatal` so the id arrives as
  the single callback argument. (#91)

### Removed (breaking)
- Legacy env-var aliases `PM_BRIDGE_MCP_*` and `PROTONMAIL_MCP_*` — only
  `MAILPOUCH_*` is read now. Callers still setting the old names must update.
- Legacy file-path fallbacks (`~/.pm-bridge-mcp-*`, `~/.protonmail-mcp-*`)
  — the server now only reads/writes `~/.mailpouch*`. Installs that never
  ran v2.2.0 must rename any `~/.pm-bridge-mcp*` / `~/.protonmail-mcp*`
  files to the matching `~/.mailpouch*` name. This covers config,
  scheduler store, reminders, log file, audit log, pending escalations,
  pass audit, FTS database, and agent grants/audit files. (#80)
- One-shot keychain migration from `protonmail-mcp-server` / `pm-bridge-mcp`
  service entries to `mailpouch`. Users on those legacy entries must
  re-enter their Bridge password via the settings UI. (#80)

### Test-count + housekeeping
- 1,566 → 1,588 passing tests (+22 regression tests across spawn
  hardening, cert auto-detect, SMTP deferred-init, loader round-
  trip, CSRF session-reload, icon format, tray preconditions, and
  per-account keychain scrubbing).
- 2,927 lines of stale documentation removed (autonomous-cycle
  log, point-in-time audit snapshots, pre-rename design reviews).
  (#81)

## [2.2.0] — 2026-04-18
### Changed
- **Product renamed to `mailpouch`** — the name better reflects the product's
  positioning (a sealed, private pouch for mail in transit between your
  provider and your agent). The `pm-bridge-mcp` name was descriptive but
  trademark-adjacent; `mailpouch` is era-neutral and brand-safe.
- Package name, bin names, config path, env vars, log file, webhook
  signature header, MCP server name, and OS keychain service name all
  rename in lockstep.
### Added
- **One-shot keychain migration** at startup — existing installs carry
  their stored Bridge password forward from `protonmail-mcp-server` or
  `pm-bridge-mcp` service entries to `mailpouch`. No re-entry required.
- **Legacy env-var aliases honored** through v3.0: `MAILPOUCH_X` wins,
  but `PM_BRIDGE_MCP_X` and `PROTONMAIL_MCP_X` still read.
- **Legacy file-path aliases honored**: reads fall back to
  `~/.pm-bridge-mcp-*` and `~/.protonmail-mcp-*` if the new path is
  absent. Writes always use the new path.
### Breaking
- Webhook signature header renamed `X-PMBridge-Signature-256` →
  `X-Mailpouch-Signature-256`. Downstream verifiers must update. The
  CloudEvents `source` and `type` prefix changed too (`pm-bridge-mcp` →
  `mailpouch`, `com.pmbridge.*` → `com.mailpouch.*`), and the outbound
  `User-Agent` is now `mailpouch/1 (+https://github.com/chandshy/mailpouch)`.
- Binary names changed: `pm-bridge-mcp` → `mailpouch`,
  `pm-bridge-mcp-settings` → `mailpouch-settings`.

## [2.1.0] — 2026-04-18

Adds multi-account support, per-agent permission grants, a remote HTTP
transport with OAuth 2.1, local full-text search, and integrations with
SimpleLogin and Proton Pass. The product is renamed from
`protonmail-agentic-mcp` to `pm-bridge-mcp`. Tool count: 49 → 67.

### Added

- **Multi-account registry** (#63) — `accounts[]` + `activeAccountId` in
  the config; `AccountManager` owns one `{imap, smtp, spec}` per account
  and hot-swaps the module-level service symbols on `active-changed`
  events (no restart). Per-tool routing via an `account_id` arg. Accounts
  tab in the Settings UI. Legacy single-account configs auto-migrate to a
  "primary" account.
- **Per-agent permission grants** (#63) — per-caller gate with grants
  that progress pending → active → revoked/expired. Conditions:
  `expiresAt`, `folderAllowlist`, `ipPins`, `maxCallsPerHourByTool`,
  `accountId`, `toolOverrides`. Append-only audit log (hashed args only,
  never values; 10 MB rotation, 3 compressed generations). Approve / deny
  / revoke and approve-with-conditions modal in the Agents tab.
- **Notification channels** (#63) — `DesktopNotifier` (macOS `osascript`,
  Linux `notify-send`, Windows `powershell.exe` toast; no dep).
  `WebhookDispatcher` with CloudEvents 1.0 default, Slack/Discord
  auto-detection, HMAC-signed `X-PMBridge-Signature-256`, 8-attempt
  exponential backoff with ±20 % jitter. Triggered by a
  `NotificationBroker` that emits grant-created/approved/denied/revoked/
  expired events.
- **HTTP transport with OAuth 2.1** (#53) — `StreamableHTTPServerTransport`
  in remote mode. Either static bearer (`remoteBearerToken`) or the full
  OAuth suite: `/oauth/register` (RFC 7591 DCR), `/oauth/authorize` (PKCE
  S256 consent flow gated by admin password), `/oauth/token` (RFC 8707
  resource indicator validation), `/oauth/revoke`,
  `/.well-known/oauth-authorization-server` (RFC 8414),
  `/.well-known/oauth-protected-resource` (RFC 9728). Per-caller
  token-bucket rate limit (20 req/s sustained, 40 burst; 3× bucket for
  authenticated). Stdio transport unchanged for Claude Desktop.
- **Local FTS5 search index** (#52) — three tools (`fts_search`,
  `fts_rebuild`, `fts_status`) backed by `better-sqlite3` (optional
  native dep). BM25 ranking, FTS5 syntax (phrase, boolean, prefix, column
  filters), snippet output. Graceful degradation when `better-sqlite3`
  isn't installed — `fts_status` reports `available: false`, other tools
  return `InvalidRequest`; mail tools unaffected.
- **Proton Pass integration** (#51) — three tools: `pass_list`,
  `pass_search` (both safe), `pass_get` (destructive, audit-logged).
  Subprocess wrapper around `pass-cli` with a Personal Access Token.
  Every `pass_get` call is appended to
  `~/.pm-bridge-mcp-pass-audit.jsonl` (no arg values, no response
  bodies).
- **Reminder scheduler** (#50) — `remind_if_no_reply`,
  `list_pending_reminders`, `cancel_reminder`, `check_reminders`. JSONL
  persistence at `~/.pm-bridge-mcp-reminders.json`.
- **Content tools** (#49) — `get_thread` (IMAP
  `References`/`In-Reply-To` walk with a 200-message cap) and
  `get_correspondence_profile` (volume, first/last interaction, average
  response time for a single address).
- **Progressive tool tiering** (#48) — three tiers (`core` / `extended`
  / `complete`); `PM_BRIDGE_MCP_TIER` env var and `toolTier` config
  field control how many tools appear in ListTools. Reduces context
  bloat for agents that only need a subset.
- **MCP elicitation for destructive tools** (#47) — destructive tool
  calls trigger an elicitation request to the client before executing.
  Older clients without elicitation fall back to the
  `{ confirmed: true }` argument flow (preserves the pre-elicitation
  behavior).
- **SimpleLogin alias tools** (#46) — six tools for managing aliases on
  Proton-owned SimpleLogin (optional; requires API key). `alias_delete`
  is destructive.
- **"Works best with…" companion MCP servers** (#45) — README section
  listing complementary MCP servers that pair well with pm-bridge-mcp.

### Changed

- **Product rename** (#34) — `protonmail-agentic-mcp` → `pm-bridge-mcp`.
  Config path prefers `~/.pm-bridge-mcp.json`, falls back to the legacy
  `~/.protonmail-mcp.json`. npm binary and homepage URLs updated.
- **Bridge TLS hardening** (#31) — production default now requires a
  loaded Bridge TLS cert; localhost Bridge without a cert needs explicit
  `allowInsecureBridge` opt-in (config field or
  `PROTONMAIL_MCP_INSECURE_BRIDGE=1`). Bridge version floor bumped to
  v3.22.0 (detected via IMAP ID).
- **Compliance UX** (#33) — destructive-tool confirmation gate (on by
  default; `requireDestructiveConfirm`) + ToS §2.10 acknowledgement
  recorded on first launch.
- **SMTP abuse-signal backoff** (#35) — exponential backoff (base 5 s,
  cap 5 min, with jitter) when SMTP returns 421/450/454. Prevents
  accidental hammering of Bridge after Proton rate-limits us.
- **Build tooling** — TypeScript 5.9 → 6.0 (#13),
  `moduleResolution: NodeNext` switch.

### Fixed

- **`chore(deps)`** (#62) — resolved three transitive CVEs from
  `@modelcontextprotocol/sdk@1.29.0` via `package.json` `overrides`:
  `hono >=4.12.14` (6 moderate advisories),
  `@hono/node-server >=1.19.13` (moderate), `path-to-regexp >=8.4.2`
  (high ReDoS).
- **`TOOL_CATEGORY_TIER` gap** — the `aliases` category was missing from
  the tier map after #46 and #48 interleaved on main, leaving alias
  tools unreachable from `toolsForTier("complete")`. Fixed while
  rebasing #49.

### Dependency bumps (Dependabot)

- `@modelcontextprotocol/sdk` 1.27.1 → 1.29.0 (#19)
- `imapflow` 1.2.15 → 1.3.1 (#25)
- `mailparser` 3.9.4 → 3.9.8 (#27)
- `@types/nodemailer` 6.4.19 → 8.0.0
- `@types/node` 25.5.0 → 25.6.0 (#26)
- `vitest` 4.1.0 → 4.1.4 (#30)
- `@vitest/coverage-v8` 4.1.0 → 4.1.4 (#28)

### Coverage notes

- Test count: 1,021 → **1,525** across 41 files.
- Thresholds relaxed as new subsystems brought defensive error paths
  that are hard to exercise without stubbing native deps: statements
  95 → 94, branches 94 → 90, functions 94 → 93, lines 96 → 96.
  Backfilling these is a follow-up.

## [2.0.4] — 2026-03-19

### Improved

- **Test coverage** — 1,251 tests passing across 21 test files; branch coverage raised from ~84% to **95.4%** (threshold enforced at 95%); line coverage **96.3%**; `escalation.ts` and `analytics-service.ts` now at **100% branch coverage**
- **Coverage thresholds** — Vitest enforces statements ≥ 95%, branches ≥ 95%, functions ≥ 94%, lines ≥ 96%
- New test patterns: async-generator UID scan mocks, per-test `simpleParser` overrides, module-level `fs`/`os`/`imapflow`/`mailparser` mocks in isolated files

## Autonomous Improvement Cycles #1–#48 (2026-03-18)

### Security

- **`tray.ts` systray2 types** — ambient module declaration added (`src/types/systray2.d.ts`); all `any` type annotations in `tray.ts` replaced with proper types from the ambient module (`SysTrayConstructor`, `MenuItem`, `InstanceType<SysTrayConstructor>`); zero `any` type annotations remain anywhere in production TypeScript source (Cycle #43)
- **Email cache byte-size limit** — `MAX_EMAIL_CACHE_BYTES = 50 MB` enforced alongside the existing 500-entry count cap; `cacheByteEstimate` counter maintained; `evictCacheEntry()` / `clearCacheAll()` helpers ensure all 11 mutation sites update the counter atomically (Cycle #42)
- **`body` JSON parsers in settings server** typed as `Record<string, unknown>` instead of `any`; `permissions.preset` now validated against `PERMISSION_PRESETS` before assignment; credential spreads require `typeof === "string"` guard (Cycle #41)
- **IMAP search boolean flags** — `isStarred: false` was previously a no-op (unanswered/undraft fields silently ignored by imapflow); fixed to use `SearchObject` boolean API — `seen`/`answered`/`draft` now correctly pass `false` as "not set" (Cycle #40, bug fix)
- **`search_emails` multi-folder `folders[]`** — each entry now validated via `validateTargetFolder()` to prevent path traversal; service-level `validateFolderName()` also now checks for `..` sequences as defence-in-depth (Cycle #22)
- **`cancel_scheduled_email`** — UUID format guard added; non-UUID `id` values now return `McpError(InvalidParams)` (Cycle #22)
- **Settings UI HTML response** — added `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, and `Cache-Control` headers (Cycle #22)
- **`send_email` / `forward_email` / `reply_to_email`** — missing empty-string guard on required string fields added; empty `to`, `body` now return `McpError(InvalidParams)` instead of propagating to SMTP (Cycles #23–#24)
- **Bulk operations** — empty `emailIds` array now rejected with `McpError(InvalidParams)` rather than silently returning zero-result success (Cycle #23)
- **`saveDraft` `inReplyTo`** CRLF/NUL stripping added to IMAP path — previously only stripped in SMTP path; crafted `inReplyTo` values with `\r\n` could inject MIME headers (Cycle #28)
- **`forward_email` subject** capped at 998 chars (RFC 2822) matching all other send handlers (Cycle #29)
- **`rename_folder`** — same-name guard added; identical old/new name now returns `McpError(InvalidParams)` instead of issuing a spurious IMAP RENAME (Cycle #29)
- **`send_email` / `schedule_email` `replyTo`** validated via `isValidEmail()` at handler entry (Cycle #30)
- **Body max-length cap** (10 MB) added to `send_email`, `save_draft`, `schedule_email`, `reply_to_email`, `forward_email` (Cycles #33–#34)
- **`wipeString()` / `wipeObject()`** in `src/security/memory.ts` typed as `Record<string, unknown>` (was `any`) (Cycle #41)
- **Path traversal prevention** — `get_emails_by_label`, `move_to_folder`, `remove_label`, `bulk_remove_label` now validate label/folder args via `validateLabelName()` / `validateTargetFolder()` before use in IMAP paths (Cycle #1)
- **`decodeCursor` folder field** now validated via `validateTargetFolder()` — crafted cursors with traversal paths (e.g. `../../etc`) are rejected as invalid (Cycle #5)
- **`save_draft` attachment sanitization** — filename stripped of CRLF/NUL and truncated to 255 chars; contentType validated against type/subtype regex before MIME construction (Cycle #9)
- **`validateAttachments()` helper** added to `src/utils/helpers.ts`; called in `send_email`, `save_draft`, and `schedule_email` handlers — malformed attachment arrays now raise `McpError(InvalidParams)` at the handler boundary rather than propagating to nodemailer (Cycle #15)
- **`search_emails` free-text fields** (`from`, `to`, `subject`) capped at 500 characters to prevent oversized IMAP SEARCH commands (Cycle #6)
- **`move_email` / `bulk_move_emails`** now call `validateTargetFolder()` before IMAP move (Cycle #3)
- **`send_test_email`** validates recipient address via `isValidEmail()` at handler entry (Cycle #3)
- **`create_folder` / `delete_folder` / `rename_folder`** now call `validateFolderName()` at handler entry (Cycle #7)
- **`mark_email_read` / `star_email` / `move_to_label` / `remove_label`** now enforce numeric-only emailId guard (Cycles #7, #9)

### Added

- **`SimpleIMAPService.healthCheck()`** — NOOP-based live connection probe; returns `true`/`false`, never throws (Cycle #13)
- **`imap.healthy` field** in `get_connection_status` response — surfaces the NOOP probe result to agents (Cycle #14)
- **`requireNumericEmailId()` helper** in `src/utils/helpers.ts` — DRY extraction of the numeric-UID guard used across 12+ handlers (Cycle #13)
- **JSDoc coverage** — 14 public methods across `SimpleIMAPService` and `SmtpService` now documented (Cycle #11)
- **`validateAttachments()` helper** with 23 unit tests (Cycle #15)

### Changed

- **Type safety milestone (Cycles #37–#43)** — all `catch (e: any)` blocks replaced with `catch (e: unknown)` across entire codebase; `SearchObject` imported from imapflow replacing hand-rolled `ImapSearchCriteria`; `SendMailOptions` from nodemailer replacing `mailOptions: any`; `ImapBodyNode` interface for bodyStructure traversal; `body: any` JSON parsers in settings server replaced with `Record<string, unknown>`; `wipeString/wipeObject` parameters tightened; `tray.ts` fully typed via systray2 ambient module. Zero `any` catch blocks or avoidable `any` type annotations remain anywhere in production source.
- **Email cache dual-eviction policy** — `setCacheEntry()` now evicts on BOTH entry count (500) AND byte size (50 MB); prevents unbounded memory growth with very large email bodies (Cycle #42)
- **Parameter type guards** — comprehensive runtime type checks added across all 47 tool handlers for string, number, boolean, array, and enum fields; all guards throw `McpError(InvalidParams)` with actionable messages (Cycles #20–#36)
- **`imapSecure` flag** added to IMAP connection config (Cycle #21, implicit TLS support)
- **Type safety** — 9 avoidable `as any` casts removed from `src/index.ts`, `analytics-service.ts`, and `simple-imap-service.ts`; `AppendResult` local interface introduced to replace `(result as any).uid`; all production `as any` casts eliminated (Cycles #10–#12)
- **`move_to_label` / `bulk_move_to_label`** inline validation replaced with `validateLabelName()` helper calls (Cycle #14)
- **`SchedulerService.pruneHistory()`** added — drops non-pending records older than 30 days and caps list at 1 000 entries on load (Cycle #2)
- **`Analytics.getEmailStats()`** — `Math.min/max(...dates)` spread replaced with `reduce` pattern to avoid stack overflow on large arrays (Cycle #2)
- **`parseEmails()`** now logs a `warn` for each dropped invalid address instead of silently discarding (Cycle #3)
- **`sendTestEmail` body** uses plain ASCII — removed emoji from subject and body (Cycle #4)

### Fixed

- **IMAP `isStarred: false` search** — was silently ignored (imapflow non-existent `unflagged` field); now correctly passes `flagged: false` (Cycle #40)
- **`search_emails` date cross-validation** — `dateFrom > dateTo` now returns `McpError(InvalidParams)` instead of silently returning zero results (Cycle #25)
- **Test suite** — 854 tests pass (was 212 before Cycle #1); +642 tests added across Cycles #1–#43 covering all new validation paths, helpers, security guards, and cache byte-limit behaviour

### Added (Cycles #44–#48)

- **`list_proton_scheduled` tool** — reads the "All Scheduled" IMAP folder exposed by Proton Bridge to list emails natively scheduled via the Proton Mail web or mobile app; distinct from MCP-scheduled emails managed by `schedule_email` (tool count raised to 48)
- **folderCache TTL** — `getFolders()` returns cached data within a 5-minute TTL without an IMAP round-trip; `clearFolderCache()` helper resets the cache at all 5 mutation sites; 7 new tests (Cycle #44)
- **Vitest coverage thresholds** — statement/branch/function/line floors enforced in `vitest.config.ts`; raised progressively from 45/38/50/47 through to 62/54/72/63 across Cycles #44–#48 (Cycles #44, #47, #48)

### Changed (Cycles #44–#48)

- **Test count: 854 → 1,021** — +167 tests added across Cycles #44–#48 covering utils (helpers, logger, tracer), analytics, scheduler, escalation, settings/security, and folder-cache TTL (Cycles #44–#48)
- **`diagnosticErrorMessage` cast narrowed** — `error as any` replaced with `error as {code?: unknown; command?: unknown; responseCode?: unknown}` in `src/index.ts` (Cycle #45)
- **`get_logs` `level` parameter** — added `typeof !== "string"` type guard; non-string values now return `McpError(InvalidParams)` instead of silently falling back to all levels (Cycle #46)
- **MCP prompt handler hardening** — `triage_inbox` NaN limit guard + clamp to 1–100; `thread_summary` prompt now calls `requireNumericEmailId()` to prevent prompt injection via crafted `emailId`; `find_subscriptions` prompt now calls `validateTargetFolder()` to prevent prompt injection via crafted folder path (Cycle #46)
- **Coverage milestones** — `helpers.ts`, `logger.ts`, `tracer.ts`: 100%/100%/100%/100%; `analytics-service.ts`: 99%/99%/98%/100%; `escalation.ts`: 89%/78%/100%/99%; `scheduler.ts`: 92%/84%/90%/99%; `settings/security.ts`: 78%/78%/85%/79% (Cycles #47–#48)

### Documentation (Cycles #44–#48)

- **README** — rebuilt from scratch: corrected tool count from 47 to 48, fixed binary names (`protonmail-agentic-mcp-settings` not `protonmail-mcp-settings`), added `list_proton_scheduled`, `delete_folder` to folder tools table, updated MCP SDK badge to 1.27+, updated test count badge to 1,021 (Cycle #48 docs pass)
- **README_FIRST_AI.md** — added `triage_inbox` and `daily_briefing` to MCP Prompts section; added `list_proton_scheduled` to tool reference (Cycle #48 docs pass)

### Documentation (Cycles #1–#43)

- **README** — corrected tool count from 45 to 47 in tagline and Full Access preset description (Cycle #16)
- **README MCP Prompts** — expanded from 3-item list to full 5-row table covering all registered prompts: `compose_reply`, `thread_summary`, `find_subscriptions`, `triage_inbox`, `daily_briefing` (Cycle #17)
- **Settings UI** — corrected stale "40 tools" to "47 tools" in two locations within the embedded HTML (preset comparison table and setup wizard card) (Cycle #17)
- **`get_connection_status` outputSchema** — added 6 missing fields: `smtp.lastCheck`, `smtp.insecureTls`, `smtp.error`, `imap.insecureTls`, `settingsConfigured`, `settingsConfigPath` (Cycle #18)
- **`list_scheduled_emails` outputSchema** — added missing `retryCount` field to item properties (Cycle #18)
- **`get_email_analytics` outputSchema** — expanded 4 bare `{type:"object"}` entries (`topSenders`, `topRecipients`, `peakActivityHours`, `attachmentStats`) to full typed schemas matching the `EmailAnalytics` interface (Cycle #19)
- **`get_contacts` outputSchema** — added 4 missing `Contact` interface fields: `name`, `firstInteraction`, `averageResponseTime`, `isFavorite` (Cycle #19)

## [2.1.0] - 2026-03-17

### Added
- **5 new tools** (47 total): `save_draft`, `schedule_email`, `list_scheduled_emails`, `cancel_scheduled_email`, `download_attachment`
- `save_draft` — IMAP APPEND to Drafts folder; returns server-assigned UID
- `schedule_email` — queue email for delivery at a future time (60 s – 30 days); survives restarts
- `list_scheduled_emails` — list all scheduled emails with status and retry count
- `cancel_scheduled_email` — cancel a pending scheduled email by ID
- `download_attachment` — retrieve attachment content as base64 from cached email
- Retry logic for scheduled emails (up to 3 attempts before marking permanently failed)
- `--help` / `--version` flags for `npm run settings` entry point
- `insecureTls` field on `get_connection_status` SMTP and IMAP sub-objects — agents can now detect degraded TLS

### Changed
- `EmailMessage.headers` type widened to `Record<string, string | string[]>` (RFC 5322 multi-value headers)
- `ScheduledEmail` interface gains optional `retryCount` field
- `PERMISSION_PRESETS` is now an exported const in `schema.ts`; `loader.ts` and `security.ts` derive their valid-preset sets from it
- `settings-main.ts` validates `PROTONMAIL_MCP_CONFIG` env var stays within the home directory

### Security
- TLS cert-missing and cert-load-failure paths now log at `error` level (previously `warn`) and set `insecureTls = true` on the service instance — surface via `get_connection_status`
- Escalation `approveEscalation()` now re-checks expiry after finding the record (prevents TOCTOU race)
- Escalation `reason` field now strips ANSI/C0/C1 control codes before storage
- Scheduler `load()` validates each record's shape — malformed entries are skipped with a warning rather than poisoning the in-memory list
- Scheduler `persist()` uses atomic temp-file + rename to prevent partial writes
- Rate-limit denials now logged at `warn` level (previously silent)
- Logger sanitizer updated from `[\r\n\t]` to full C0/C1 range `[\x00-\x1f\x7f]`
- IMAP search strings (`from`, `to`, `subject`) sanitized against `"` and `\` to prevent SEARCH injection
- `dateFrom` / `dateTo` search parameters validated with `isNaN(Date.parse(...))` before use
- `references` items in `saveDraft` stripped of C0/C1 control characters
- Analytics cache now uses an in-flight promise to collapse concurrent stampede fetches
- Redundant per-tool `permissions.check()` calls removed from `save_draft` and `schedule_email` (already enforced centrally)
- Duplicate `'drafts'` entry removed from `pickDraftsFolder` fallback list

## [2.0.0] - 2026-03-17

### Added
- **40 tools** (up from 20 in v1.0.0) with structured output and MCP annotations
- **Permission system** with 4 presets: read_only (default), supervised, send_only, full
- **Per-tool rate limiting** with configurable limits per preset
- **Human-gated escalation system** — two-channel design with CSRF protection, 5-minute expiry, audit trail
- **Browser-based settings UI** at localhost:8765 with setup wizard, permissions, escalations, and status tabs
- **Terminal UI (TUI)** with auto-detection of environment capabilities
- **MCP Resources** — `email://` and `folder://` URI schemes for addressable data
- **MCP Prompts** — compose_reply, thread_summary, find_subscriptions workflow templates
- **Cursor-based pagination** for stable pagination across mailbox mutations
- **Progress notifications** for bulk operations (bulk_move, bulk_delete, bulk_move_to_label)
- **Tool annotations** — readOnlyHint, destructiveHint, idempotentHint on all tools

#### New Tools
- `get_unread_count` — fast per-folder unread count without fetching emails
- `reply_to_email` — threaded replies with proper In-Reply-To/References headers
- `archive_email` — convenience wrapper to move to Archive
- `move_to_label` — move email to Labels/ folder
- `bulk_move_to_label` — bulk move to label with progress notifications
- `bulk_move_emails` — bulk move with progress notifications
- `bulk_delete_emails` — bulk delete with progress notifications
- `request_permission_escalation` — agent requests temporary elevated permissions
- `check_escalation_status` — poll pending escalation status
- `sync_folders` — refresh folder list from IMAP server

### Changed
- Tool descriptions rewritten for agent token efficiency (no emojis)
- All tool responses now include `structuredContent` + `outputSchema`
- Config stored in `~/.protonmail-mcp.json` with mode 0600 and atomic writes
- `add_label` renamed to `move_to_label` for accurate semantics

### Security
- 10-layer defense-in-depth security model
- CSRF protection on all mutating settings API calls
- Origin/Referer validation on settings server
- Input sanitization (email addresses, folder names, attachment sizes, hostnames)
- CRLF injection prevention in SMTP headers
- Email cache capped at 500 entries, rate-limiter buckets capped at 10k
- Append-only audit log at `~/.protonmail-mcp.audit.jsonl`

## [1.0.0] - 2025-10-22

### Added
- Initial release of ProtonMail MCP Server
- Complete MCP server implementation with 20 tools
- SMTP email sending via ProtonMail with Nodemailer
- IMAP email reading via Proton Bridge with ImapFlow
- Advanced email analytics and statistics
- Email folder management and synchronization
- Email search with advanced filtering
- Contact interaction tracking
- Email volume trends analysis
- System logging and debugging tools
- Comprehensive documentation and examples
- Support for IPv4/IPv6 connections
- Self-signed certificate handling for Proton Bridge
- Environment variable configuration
- TypeScript implementation with full type safety

### Features

#### Email Sending
- Rich HTML/Text email composition
- Multiple recipients (TO, CC, BCC)
- File attachments with base64 encoding
- Priority levels and custom headers
- Custom reply-to addresses
- SMTP connection verification

#### Email Reading
- Full folder synchronization
- Advanced email search
- Message parsing and threading
- Attachment handling
- Read/unread status management
- Star/flag operations
- Email moving and organization

#### Analytics
- Email volume trends
- Contact interaction statistics
- Response time analysis
- Communication insights
- Storage usage tracking

#### System
- Connection status monitoring
- Cache management
- Comprehensive logging
- Error tracking and recovery

[2.0.0]: https://github.com/chandshy/protonmail-mcp-server/releases/tag/v2.0.0
[1.0.0]: https://github.com/chandshy/protonmail-mcp-server/releases/tag/v1.0.0
