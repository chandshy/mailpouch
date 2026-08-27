# mailpouch E2E test harness

> **See also:** [`docs/preship.md`](../../docs/preship.md) — the ship-readiness gate
> (`npm run preship`) runs this harness as one of its hard-required steps. If
> you're trying to ship, that's the doc you want.

End-to-end coverage that drives the real mailpouch MCP server over stdio,
talks IMAP back-to-back via Greenmail (Phase 1) or Proton Bridge (Phase 2),
and asserts on **actual IMAP state** after each tool call — not just the
tool's return value. That's the property that catches false-success bugs
like the v3.0.40 UID-resolution defect.

The harness is split from `test/agent-harness.test.ts` (the original
Bridge-only smoke suite, still present) and lives entirely under
`test/e2e/`. Vitest's default `npm test` excludes it.

## Prerequisites

- **Docker** for Phase 1 (Greenmail in a container).
- **Proton Bridge** running locally for Phase 2. The Bridge lane is scoped to
  run-owned messages and UUID-namespaced folders, so it can use an existing
  mailbox without erasing or modifying pre-existing mail.
- Node 22+ (matches the package's `engines` field).

## Quick start (Phase 1 — Greenmail)

```bash
# One-shot: brings the Greenmail container up, runs the suite, tears it down.
npm run test:e2e:local

# Keep the container running between iterations (faster dev loop).
docker compose -f test/e2e/fixtures/greenmail-compose.yml up -d
npm run test:e2e:local:keep
# ... iterate ...
docker compose -f test/e2e/fixtures/greenmail-compose.yml down
```

## Phase 2 — Proton Bridge

```bash
# Point at an existing mailpouch config. The harness reads only the selected
# mailbox credential once, encrypts it into a private temporary clone, and the
# spawned MCP child never reads or writes the operator's keychain.
export MAILPOUCH_E2E_BRIDGE_CONFIG=~/.mailpouch.json
npm run test:e2e:bridge
```

If `MAILPOUCH_E2E_BRIDGE_CONFIG` is unset or missing, Bridge mode refuses to
start. The command never falls back to a destructive mailbox-wide reset.

Every E2E child, including disposable Greenmail, uses an exact-token
config-only credential profile and a private runtime-state directory. Test
processes therefore cannot read or write the operator's keychain, logs, audit
files, scheduler, reminders, OAuth tokens, FTS database, or singleton lock.

### Bridge safety model

`test:e2e:bridge` runs the complete suite without wiping the mailbox:

- read-only tools may inspect existing mail;
- every test-created message carries an exact UUID-backed ownership marker;
- SMTP/draft calls persist a token-constrained pending proof before dispatch,
  so a transport crash after creation cannot leave an untracked test message;
- live Bridge scenarios never create, rename, or delete mailboxes;
  folder-lifecycle coverage runs only against the disposable Greenmail backend.
  Crash cleanup may create one exact-token rescue folder solely to COPY an
  otherwise stranded owned All Mail record; it never deletes that folder;
- a central guard rejects mutations unless every source UID is proven to
  belong to the current run and every destination is an explicitly admitted
  existing system folder;
- teardown permanently deletes only exact current-run messages and fails if
  any owned message residue remains; foreign mail is never a cleanup operand;
- live cleanup never issues IMAP mailbox `DELETE`; positively-created empty
  folders are retained and named in the teardown/recovery warning for manual
  deletion, avoiding a final-check-to-delete race with foreign delivery;
- startup snapshots pre-existing folders, message identities, and flags before
  the MCP process starts; teardown requires that baseline to remain unchanged;
- Bridge cleanup reconciles delayed folder/Trash/All Mail views and carries
  ownership across COPY/MOVE only through UIDPLUS mappings bound to the
  destination mailbox's UIDVALIDITY;
- ownership hints are combined into one SEARCH per mailbox scan, while fetched
  headers and complete manifest proofs remain the only destructive authority;
- credential loading, full IMAP authentication/baseline capture, MCP startup,
  cleanup, and baseline verification have independent absolute deadlines which
  close live IMAP/MCP transports on expiry and retain any recovery manifest;
- if Bridge returns an ambiguous result for one exact-owned cleanup mutation,
  teardown closes the poisoned session and makes one shell-free recovery
  attempt in a fresh process; optional peer-run recovery authority is stripped,
  and success requires zero exit plus removal of the exact manifest and
  encrypted recovery clone;
- before the encrypted config clone is published, a credential-free setup
  journal is fsynced in the private mailbox authority scope; every later
  harness refuses interrupted journals, exact manifest/config recovery pairs,
  and pre-journal same-mailbox clones, so a crash cannot hide credential or
  teardown state from the next baseline;
- an exclusive owner-recorded lease is held for the complete live harness
  lifetime in a scope derived from normalized IMAP endpoint and username,
  preventing distinct configs or worktrees targeting the same mailbox from
  both passing preflight; a crash-surviving lease is never reclaimed by age or
  PID and must be removed manually only after confirming no E2E/cleanup process
  remains;
- inherited Greenmail plaintext/insecure transport overrides are stripped from
  every live Bridge child process;
- Bridge mode cannot enable `ImapFixtures.wipe()` through an environment flag.

The focused `test:e2e:bridge:safe` command remains available for the smaller
Bridge-specific All-Mail/move/flag/search audit, but it uses the same ownership
model as the full command and verifies that live folder creation is refused.

```bash
export MAILPOUCH_E2E_BRIDGE_CONFIG=~/.mailpouch.json   # your Bridge config
npm run test:e2e:bridge:safe
```

Both commands may append self-owned probes to existing system folders to
exercise default-folder behavior, but no mutation is dispatched until the
probe UID's exact run marker and current mailbox UIDVALIDITY are verified.
Pre-existing UIDs are read-only.

```bash
# Clean one crashed run. Use the canonical operator config, exact encrypted
# clone, and token printed by the failed run. The v2 manifest is resolved from
# ~/.mailpouch-e2e-authority/v2/<mailbox-hash>/, outside the checkout.
export MAILPOUCH_E2E_AUTHORITY_CONFIG=~/.mailpouch.json
export MAILPOUCH_E2E_BRIDGE_CONFIG=~/.mailpouch-e2e-bridge-mpE2E-00000000-0000-4000-8000-000000000000.json
export MAILPOUCH_E2E_RUN_TOKEN=mpE2E-00000000-0000-4000-8000-000000000000
npm run test:e2e:bridge:cleanup
```

Crash cleanup refuses a missing/legacy manifest, waits the full delivery grace
when a send was in flight, and verifies the persisted UIDVALIDITY/UID/flags plus
hashed Message-ID baseline before removing the manifest. Standalone recovery
removes only exact owned messages. It never issues mailbox `DELETE`; any empty
folder positively created by an older interrupted run is retained and reported
for manual cleanup. Recovery also bounds its full IMAP connect/authentication
phase before reconciliation.

If the retained manifest reports `create-pending`, `copy-pending`,
`payload-observed`, or `complete` with exact-owned All Mail residue, an operator
may authorize one rescue CREATE/COPY attempt with a fresh 256-bit nonce:

```bash
export MAILPOUCH_E2E_REARM_RESCUE_COPY="$MAILPOUCH_E2E_RUN_TOKEN"
export MAILPOUCH_E2E_REARM_RESCUE_COPY_NONCE="$(openssl rand -hex 32)"
npm run test:e2e:bridge:cleanup
unset MAILPOUCH_E2E_REARM_RESCUE_COPY MAILPOUCH_E2E_REARM_RESCUE_COPY_NONCE
```

The token and nonce must be supplied together. The nonce hash is durably
consumed before an authorized CREATE retry or COPY, so rerunning the same
command cannot replay an ambiguous wire result. A fresh nonce is a new,
explicit operator authorization. Cleanup
still requires two observations from fresh authenticated sessions: an existing
rescue must be empty and baseline-absent before its UIDVALIDITY can be adopted,
while an absent `create-pending` rescue must remain absent before CREATE can be
retried. Initial automatic All Mail rescue also requires the same exact
Message-ID set to remain stable for 30 seconds after the last concrete mutation
or failed safety scan. Automatic recovery and MCP children strip both rearm
variables.

The harness invokes that same cleanup program automatically only for an
ambiguous exact-owned mutation after the MCP child has stopped. All other
failures remain manual and retain the exact config/manifest pair. A subsequent
Bridge harness stops before opening a live connection until that pair is
resolved with the command above. A pre-journal clone is never auto-deleted:
first verify that no matching legacy manifest or E2E process remains, then
durably remove only the exact clone named by preflight.

A successful manual cleanup leaves its encrypted clone, ownership manifest,
setup journal, and manual lease absent. An automatic child leaves the delegated
parent lease until parent finalization. Any positively-created empty rescue
folder remains intentionally and is printed with its exact path for manual
mailbox deletion; its presence is not message residue.

If an older interrupted run captured messages created by another still-pending
E2E run in its baseline, name that exact peer run explicitly before recovery:

```bash
export MAILPOUCH_E2E_RECOVERY_PEER_TOKENS=mpE2E-11111111-1111-4111-8111-111111111111
npm run test:e2e:bridge:cleanup
```

This exception is deliberately narrow. Every named peer must still have its
exact v2 manifest in the same private mailbox authority scope, and a finalized, token-constrained
Message-ID proof may explain at most one baseline record per mailbox
projection. Pending sends, subjects alone, and unhashed baseline records grant
no authority.

Old fixture APPENDs were recorded only as Message-ID search hints. Naming a
peer does not elevate those hints. A one-time historical recovery must also
allowlist each exact peer and SHA-256 hash explicitly:

```bash
export MAILPOUCH_E2E_RECOVERY_APPEND_HASHES=mpE2E-11111111-1111-4111-8111-111111111111:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
```

The hash must uniquely belong to that peer's header hints, be absent from the
peer's own pre-run baseline, and occur in the active run's baseline. Historical
append evidence alone can classify only a truly disappeared record. A virtual
All Mail record is considered disappeared only when its hash is absent at every
flag state, and a concrete record is not disappeared if that Message-ID is
found at another UID.

A surviving same-UID/same-Message-ID record may explain flag-only drift only
when it currently carries the exact peer run header. All Mail additionally
requires exactly one baseline record and one current same-hash projection.
Missing, wrong, or duplicate run headers, a replaced Message-ID, UIDVALIDITY
drift, mailbox drift, and ambiguous duplicate projections remain errors.
Recover dependent runs before removing the peer's manifest, then unset both
recovery variables.

The live suite's outer test-hook budget is intentionally larger than setup,
reconciliation, baseline verification, finalization, and shutdown margin, so
the runner cannot abandon a still-active fail-closed phase.

## What runs against Greenmail

Greenmail is RFC-compliant for the IMAP semantics that matter for the
bug class we're guarding against (folder-scoped UIDs, UID FETCH on missing
UIDs returning empty, UID MOVE / EXPUNGE), so the **core regressions for
Bugs A/B/C from the 2026-05-28 report run against it cleanly**. Specifically:

- `bulk_move_emails` with explicit `sourceFolder` to a custom folder
- `bulk_mark_read` / `bulk_star` flag toggles against a custom folder
- `bulk_remove_label` honest counts when UIDs don't live in the label
- Singular `mark_email_read`, `star_email`, `archive_email`, `delete_email`
- The destructive gate on `move_to_trash`, `delete_email`, `bulk_delete_emails`,
  `delete_folder`

Plus a representative slice of the rest of the tool surface: `get_folders`,
`get_email_by_id`, `create_folder`, `rename_folder`, `delete_folder`,
`save_draft`, `sync_emails`, `sync_folders`, `get_server_version`,
`get_connection_status`, `clear_cache`, `get_logs`, `fts_status`,
`search_emails` (subject + folder scope), analytics endpoints.

## Backend-specific coverage

Greenmail runs with a disposable SMTP/IMAP account, a config-only test
credential, and a test-only plaintext SMTP override, so it covers `send_email`
and `send_test_email` delivery plus
multi-recipient header behavior. The Bridge lane self-addresses every outbound
probe and disables CC/BCC coverage so a live run cannot contact third parties.

Several cross-connection propagation cases run only on Bridge because its IMAP
IDLE behavior reliably observes external APPEND and mailbox CREATE operations.
SimpleLogin and Proton Pass are disabled in the live Bridge child so E2E cannot
read the operator's auxiliary keychain slots; their placeholder scenarios run
only in disposable/isolated lanes. Reply/forward and scheduled/reminder
delivery still require dedicated ownership-aware scenarios; they are not
claimed by this suite.

## Layout

```
test/e2e/
├── README.md                          # this file
├── mcp-client.ts                      # startE2E() — spawn mailpouch + helpers
├── fixtures/
│   ├── imap-fixtures.ts               # ImapFixtures class (raw IMAP assertions)
│   ├── greenmail-compose.yml          # Greenmail container definition
│   └── seed-data.ts                   # canonical test emails
├── scenarios/
│   ├── smoke.e2e.test.ts              # harness boots + round-trips
│   ├── actions.e2e.test.ts            # Bugs A/B/C regression coverage ★
│   ├── deletion.e2e.test.ts           # destructive-gate + UID delete
│   ├── folders.e2e.test.ts            # create / rename / delete / list
│   ├── labels.e2e.test.ts             # list_labels, get_emails_by_label
│   ├── reading.e2e.test.ts            # get_email_by_id, get_emails, get_thread, …
│   ├── search.e2e.test.ts             # search_emails + fts_*
│   ├── analytics.e2e.test.ts          # get_email_stats / analytics / volume / contacts
│   ├── drafts.e2e.test.ts             # save_draft + introspection
│   └── system.e2e.test.ts             # version / status / cache / logs
└── support/
    ├── docker.ts                      # Greenmail lifecycle (up / down / restart)
    ├── mime-builder.ts                # RFC 5322 emitter for seeds
    └── cleanup-bridge.mjs             # exact-token crash recovery for Bridge
```

## Implementation notes

- `vitest.config.e2e.ts` runs e2e files **serially** (`fileParallelism: false`,
  `singleFork: true`). Multiple parallel files would race on Greenmail.
- Each scenario file calls `docker.restart()` in `beforeAll`. Greenmail
  accumulates UID counters and stale folders between files; the restart
  gives every file a guaranteed clean Greenmail.
- `ImapFixtures.reconnect()` is called inside `getFlags()` / `listUids()`
  to force a fresh `SELECT`. Without this, the persistent ImapFixtures
  session can show stale `EXISTS` counts after mailpouch mutates the same
  mailbox on its own connection.
- Bridge teardown also uses fresh sessions and requires two consecutive
  whole-mailbox scans with no exact-owned messages or unclassified scratch
  folders. Verified-empty folders from legacy runs may remain only when they
  are explicitly reported for manual cleanup.
- mailpouch's permission gate defaults to `read_only`. The harness writes
  `buildPermissions("full")` so every tool can run.
- Greenmail uses test-only insecure/plaintext overrides. Live Bridge uses the
  configured pinned certificate and does not receive those overrides.
- The live Bridge child forces stdio, disables its settings UI/tray, and routes
  scheduler, index, OAuth, audit, and other runtime state into a UUID-scoped
  directory that teardown removes.

## Troubleshooting

**"Connection not available" mid-test**: ImapFixtures auto-reconnects once
on this error. If it persists, Greenmail is likely overloaded — restart it:

```bash
docker compose -f test/e2e/fixtures/greenmail-compose.yml restart
```

**Port 8080 conflict on `docker compose up`**: the compose file no longer
maps `8080:8080` for this reason. If you fork the file and re-add it,
make sure no other local service is on 8080.

**Greenmail STARTTLS error in logs**: expected — Greenmail doesn't advertise
STARTTLS by default and mailpouch forces it for localhost SMTP. The error
is logged at startup. The Greenmail lane enables a test-only plaintext SMTP
override and verifies `send_email` and `send_test_email` delivery; outbound
sends are also exercised safely in the live Bridge lane.
