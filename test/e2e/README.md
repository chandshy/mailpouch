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
- **Proton Bridge** running locally for Phase 2, with a dedicated test
  account or test folders you're comfortable having created/deleted.
- Node 20+ (matches the package's `engines` field).

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
# Create a config file pointing at your Bridge instance with credentials,
# then export the path:
export MAILPOUCH_E2E_BRIDGE_CONFIG=~/.mailpouch.bridge-test.json
npm run test:e2e:bridge
```

If `MAILPOUCH_E2E_BRIDGE_CONFIG` is unset or the file doesn't exist, every
Bridge-only `it.skip` stays skipped — the suite still runs against Greenmail
without errors.

> ⚠️ **`test:e2e:bridge` is DESTRUCTIVE — never point it at a real account.**
> Its per-test reset (`ImapFixtures.wipe()`) empties INBOX/Sent/Archive/Trash/
> Spam/Drafts and deletes every other folder. Use a **dedicated throwaway**
> Proton account, or use the safe gate below. `wipe()` now refuses to run
> unless `MAILPOUCH_E2E_ALLOW_WIPE=1` explicitly confirms a disposable target.

### Safe Bridge gate (non-destructive)

`test:e2e:bridge:safe` runs the Bridge-unique validations — the All-Mail
bulk-move "false-success" (Bug A) audit plus move/copy/label/flag/folder/search
— **creating its own emails/folders and deleting only those.** Everything lives
under a unique `mpE2E-<runid>` scratch namespace; a guard (`support/scratch.ts`,
`assertScratch`) makes it provably impossible to create, write, or delete
anything outside it, so it is safe against a **real** account.

```bash
export MAILPOUCH_E2E_BRIDGE_CONFIG=~/.mailpouch.bridge-test.json   # your Bridge config
npm run test:e2e:bridge:safe
```

It never wipes, never touches INBOX/system folders, and removes its scratch
folders on teardown. The only pre-existing folder it reads is "All Mail" (as a
move source, acting solely on one self-seeded message). Coverage proven on
Greenmail in the normal `test:e2e:local` run; the guard contract is unit-tested
in `test/scratch-guard.test.ts`.

```bash
# Clean up any orphan E2E folders/labels left behind by a crashed run.
npm run test:e2e:bridge:cleanup
```

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

## What's deferred to Phase 2 (Bridge)

A handful of scenarios are `it.skip`'d with `bridge-only` in the test name.
They fall into two buckets:

1. **Outbound SMTP**: Greenmail's SMTP doesn't speak STARTTLS and mailpouch
   forces STARTTLS for localhost. `send_email`, `reply_to_email`,
   `forward_email`, `send_test_email`, `schedule_email` actually firing,
   `remind_if_no_reply` round-trip — all bridge-only.
2. **Cross-connection cache propagation**: mailpouch's IMAP IDLE picks up
   external APPENDs and mailbox CREATEs from another client reliably on
   Bridge but not on Greenmail. Anything that seeds via ImapFixtures and
   then asserts via `get_emails` / `list_labels` / `get_folders`
   propagation is bridge-only.

The skipped tests are kept in the same file as their passing peers so the
suite is one read away from being complete coverage; the comment on each
`it.skip` calls out the specific reason.

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
    └── cleanup-bridge.mjs             # orphan-folder cleanup for Phase 2
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
- mailpouch's permission gate defaults to `read_only`. The harness writes
  `buildPermissions("full")` so every tool can run.
- All tests run with `MAILPOUCH_INSECURE_BRIDGE=1` to skip TLS pinning
  against the localhost Greenmail / Bridge.

## Troubleshooting

**"Connection not available" mid-test**: ImapFixtures auto-reconnects once
on this error. If it persists, Greenmail is likely overloaded — restart it:

```bash
docker compose -f test/e2e/fixtures/greenmail-compose.yml restart
```

**"Settings UI could not bind port 8765"**: harmless. mailpouch tries to
launch its settings UI on startup; the warning is logged but doesn't fail
the suite.

**Port 8080 conflict on `docker compose up`**: the compose file no longer
maps `8080:8080` for this reason. If you fork the file and re-add it,
make sure no other local service is on 8080.

**Greenmail STARTTLS error in logs**: expected — Greenmail doesn't advertise
STARTTLS by default and mailpouch forces it for localhost SMTP. The error
is logged at startup; only outbound-send tests depend on SMTP being
functional and those are bridge-only.
