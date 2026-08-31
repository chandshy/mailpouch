# Continuous Improvement Loop

`mailpouch` uses a persistent, one-item-at-a-time loop for autonomous or
agent-assisted code improvement. It records an audit → implement → validate →
re-audit cycle without allowing a broad review to become an unverified batch of
changes.

The runner owns durable transitions and evidence. An engineer or coding agent
still performs the review and implementation work: it is not an unattended
code-changing daemon.

## Durable files

| Path | Purpose |
|---|---|
| `.improvement-loop/snapshot.json` | The canonical, atomically replaced state and backlog snapshot |
| `.improvement-loop/history.jsonl` | Sequenced, fsynced event history; a pending event is recovered on the next command |
| `.improvement-loop/audits/` | Regular JSON audit artifacts that seed imports and re-audits |
| `.improvement-loop/loop.lock/` | Token-owned, short-lived mutation lock; never edit it during a live command |

Only `init` creates the loop layout. Other commands fail closed if a snapshot,
history file, or audit directory is missing or corrupt; they never silently
create a blank replacement.

Version-1 `state.json` and `backlog.json` files are migrated by `init` into the
v2 snapshot. The files are retained as historical input, but are no longer
canonical. A migrated active item receives an explicit legacy provenance marker
and **its prior validation is discarded**: it must pass the new item-spec and
workspace-fingerprint validation before completion.

Never store credentials, mailbox content, raw request bodies, or full test
output in an audit artifact, backlog item, completion summary, or history.

## Standard cycle

```bash
# Create the durable layout (or migrate a v1 loop once).
node scripts/improvement-loop.mjs init
node scripts/improvement-loop.mjs status

# Place an independently reviewed JSON artifact under .improvement-loop/audits/.
# Importing argv checks requires an explicit acknowledgement of the trust boundary.
node scripts/improvement-loop.mjs import .improvement-loop/audits/2026-07-11-audit.json --approve-commands
node scripts/improvement-loop.mjs re-audit \
  --audit .improvement-loop/audits/2026-07-11-audit.json \
  --summary "Independent security, lifecycle, and test audits completed."

# Exactly one queued item may be active.
node scripts/improvement-loop.mjs begin ISSUE-001

# Write the focused regression, implement, then run every declared check.
node scripts/improvement-loop.mjs validate ISSUE-001
node scripts/improvement-loop.mjs complete ISSUE-001 --summary "Regression and required gates passed."

# Completion requires a new hashed audit before another item starts.
node scripts/improvement-loop.mjs re-audit \
  --audit .improvement-loop/audits/2026-07-12-follow-up.json \
  --summary "Follow-up audit completed; newly confirmed findings imported."
node scripts/improvement-loop.mjs status
```

`status` is a brief report of the active item, next queued item, counts, current
validation, latest audit, and latest validation result. The JSON form is useful
for a scheduled status reporter:

```bash
node scripts/improvement-loop.mjs status --json
```

## Audit and command trust boundary

Audit artifacts must be regular, non-symlink JSON files below the repository's
`.improvement-loop/audits/` directory. The runner stores each artifact's
SHA-256 in the item and re-audit record, then verifies it before every command.
Changing a referenced artifact fails the loop closed; create a new reviewed
artifact and import/re-audit it instead.

Validation commands are argv arrays and are launched without a shell, which
prevents shell-string interpolation. That does **not** make their executable or
arguments safe: a validation command is still local code execution. Therefore
the runner refuses to import validation commands until the operator explicitly
passes `--approve-commands`. Only approve audit artifacts that were independently
reviewed and are trusted at the same level as repository test scripts. Run
untrusted repositories or AI-generated audit input in an isolated environment.

## Fresh validation guarantee

Each validation run records:

- an immutable hash of the active item's title, criteria, validation commands,
  and audit provenance; and
- a workspace fingerprint of Git-tracked and untracked source content.

The fingerprint deliberately excludes `.improvement-loop/` itself, so recording
status and history never invalidates the work it is documenting. It includes
tracked and untracked source content; non-Git directories use a deterministic
tree hash with the same loop-metadata exclusion. A result is discarded if the
item changes while checks run, and completion recomputes the fingerprint to
reject changes made after validation.

Validation checks default to a 15-minute timeout. A check may set `timeoutMs`
between 1 second and 4 hours. The runner records a validation run under the
lock, releases the lock while checks execute, and conditionally records the
result afterward. This allows a material blocker to be recorded while a slow
check is running; its late result is discarded.

## Lock recovery

The lock is a token-owned directory. It intentionally **does not** automatically
reclaim a dead or malformed lock: automatic stale-lock deletion can race another
contender and admit two writers. If a command reports a stale lock, first verify
that no `improvement-loop.mjs` process is running for that repository, then
manually remove only that repository's `.improvement-loop/loop.lock/` directory
and rerun the command. This is a deliberate fail-closed recovery step.

## Backlog item format

Audit artifacts contain either an array of queued items or an object with an
`items` array. Lifecycle fields are runner-owned: imported items must be queued,
have non-empty acceptance criteria and validation checks, and cannot set
`startedAt`, `completedAt`, `attempts`, `completionSummary`, `blockedReason`, or
audit provenance.

```json
{
  "items": [
    {
      "id": "SEC-001",
      "priority": "P1",
      "title": "Short outcome-oriented title",
      "area": "settings/reset",
      "source": "Independent review 2026-07-11",
      "summary": "Concrete defect, impact, and intended change.",
      "acceptanceCriteria": [
        "The vulnerable behavior is impossible.",
        "A regression test covers the prior failure path."
      ],
      "validation": [
        {
          "label": "targeted regression",
          "command": ["npx", "vitest", "run", "src/example.test.ts"],
          "timeoutMs": 900000
        },
        {
          "label": "typecheck",
          "command": ["npm", "run", "typecheck", "--", "--pretty", "false"]
        }
      ],
      "status": "queued",
      "createdAt": "2026-07-11T00:00:00.000Z"
    }
  ]
}
```

The CLI rejects unknown flags, duplicate flags, missing required values, empty
validation arrays, malformed lifecycle states, and replacement of an active or
otherwise lifecycle-managed item. A completed item is never replaced; create a
follow-up item instead.

Priority convention:

- `P0`: active data loss, credential disclosure, authorization bypass, or
  release-blocking correctness failure.
- `P1`: high-impact correctness/security/availability defect.
- `P2`: bounded quality, determinism, or maintainability improvement.
- `P3`: low-risk cleanup or deferred optimization.

## Agent operating contract

For every selected item, an agent must:

1. Confirm the problem against the current source and classify its impact.
2. Add or tighten a regression test before declaring the implementation done.
3. Make the smallest coherent change that meets every acceptance criterion.
4. Run the declared checks plus appropriate repository gates.
5. Record an evidence-based completion summary only after the fresh validation.
6. Place an independent follow-up audit artifact under `audits/`, import newly
   confirmed findings, and record the hashed re-audit before selecting again.

The loop does not authorize publishing, external messaging, destructive Git
operations, or broad refactors without a matching reviewed backlog item.
