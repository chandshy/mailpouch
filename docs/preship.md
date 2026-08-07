# preship — the ship-readiness gate

Every ship runs through `npm run preship`. The gate exists because correctness checks that depend on a human remembering to run them eventually don't get run. preship makes the full set non-bypassable.

## TL;DR

```bash
# Before you ship: full gate (~5 minutes; requires Bridge running)
npm run preship

# Quick gate (< 30 s; runs on every `git push` via pre-push hook)
npm run preship:fast

# Release-grade gate (before `npm publish`)
npm run preship:release

# After the release commit is clean and pushed, run Bridge and attach its
# exact-SHA status (uses `gh auth` or GH_TOKEN for commit-status write access)
MAILPOUCH_E2E_BRIDGE_CONFIG=/path/to/config.json node scripts/attest-bridge-e2e.mjs
```

`npm publish` is wired to refuse to run unless `preship:release` is green (`prepublishOnly`).

## What runs

### preship:fast — < 30 s

| Step | What it checks | Hard fail? |
|------|----------------|-----------|
| `typecheck` | `tsc --noEmit` | yes |
| `lint` | Currently aliases typecheck (placeholder until a real linter is wired) | yes |
| `version-sync` | `package.json` version matches the README badge and the latest `CHANGELOG.md` heading | yes |
| `secrets` | gitleaks (if installed) or grep heuristic for AWS keys / OpenAI keys / Slack tokens / GitHub PATs / PEM private keys | yes |
| `npm-audit` | `npm audit --omit=dev`; HIGH/CRITICAL block, MODERATE/LOW are advisory | yes on HIGH/CRITICAL |
| `license-inv` | Prod-dep license inventory at `LICENSES.json` is up to date | yes on drift |
| `build` | `tsc` produces a working `dist/` | yes |
| `unit` | `vitest run` (excludes `test/agent-harness.test.ts`) | yes |

### preship — adds, after preship:fast

| Step | What it checks | Hard fail? |
|------|----------------|-----------|
| `tarball-smoke` | `npm pack` → install in temp dir → `mailpouch --version` boots and prints the right version | yes |
| `e2e:greenmail` | Phase-1 E2E suite via Greenmail Docker container | yes |
| `e2e:bridge` | Phase-2 E2E suite via real Proton Bridge | yes (locally); CI sets `PRESHIP_NO_BRIDGE=1` to skip |

### preship:release — adds, after preship

| Step | What it checks | Hard fail? |
|------|----------------|-----------|
| `build:clean` | Full clean build (catches stale-dist regressions) | yes |
| `changelog-has-entry` | Latest `## [X.Y.Z]` CHANGELOG entry has non-empty body | yes |
| `git-tag-free` | No existing `vX.Y.Z` tag (sanity check before tagging) | yes |
| `npm-version-free` | `mailpouch@X.Y.Z` isn't already on npm. Reports "not yet published" only when the registry explicitly returns E404; on registry unreachable, reports "could not verify" without claiming the version is free | advisory |

## Running individual checks

Every check is also exposed as its own npm script — handy when debugging a single failure without re-running the whole gate.

```bash
npm run check:version-sync
npm run check:secrets
npm run check:npm-audit
npm run check:licenses
npm run check:tarball
```

Each exits 0 on pass, non-zero on failure, and prints actionable detail.

## When something fails

The gate prints which step failed and the captured stdout/stderr. Common ones:

### `version-sync` failed

```
Version sync FAILED (package.json 3.0.42):
  - README.md badge is v3.0.41 but package.json is 3.0.42. Update README.md.
```

Bump the README badge and the CHANGELOG to match. The single source of truth is `package.json`.

### `secrets` failed

If `gitleaks` flagged something, the path + line + rule is in the output. If you're using the grep fallback (no gitleaks installed), the literal match line is printed.

**Real secret**: rotate it, scrub history (`git filter-repo`), then re-stage without the secret. Don't just delete in a new commit.

**False positive in test fixtures**: move the example to a fixture file that matches the path-exclude list in `scripts/check-secrets.mjs:30` (currently excludes `dist/`, `node_modules/`, `package-lock.json`, `LICENSES.json`, `CHANGELOG.md`, `scripts/check-secrets.mjs` itself, `docs/preship.md`).

### `npm-audit` failed on HIGH/CRITICAL

```
npm-audit FAILED: 1 HIGH/CRITICAL finding(s):
  - [HIGH] some-dep  (advisory 1234)  Prototype pollution in some-dep
```

First try `npm audit fix`. If that doesn't resolve it (no patch available), and the advisory genuinely doesn't apply to mailpouch (e.g. server-side dep used only at build time), add it to `.preship-audit-allow.json`:

```json
{
  "allow": [
    { "id": 1234, "reason": "false positive — runtime path not reachable; see PR #999" }
  ]
}
```

### `license-inv` drift

```
license-inv DRIFT detected:
  + 2 added:
      some-new-dep@1.0.0  MIT
```

Expected after `npm install` adds a dep. Regenerate the baseline and commit:

```bash
PRESHIP_LICENSE_WRITE=1 node scripts/check-licenses.mjs
git add LICENSES.json
```

### `tarball-smoke` failed

Usually one of:
- `mailpouch --version` produced no output → `bin` mis-wired in `package.json`
- File missing → `files` in `package.json` doesn't include the path that `dist/index.js` imports
- `Permission denied` → shebang missing on `dist/index.js`

### `e2e:greenmail` / `e2e:bridge` failed

See [`test/e2e/README.md`](../test/e2e/README.md) for the harness layout, the
two-phase model, and Greenmail vs Bridge quirks.

## Bypassing the gate

Don't, in normal operation. For emergencies:

| Surface | Bypass |
|---------|--------|
| Pre-push hook | `git push --no-verify` |
| Ship skill (`/ship`) | `PRESHIP_SKIP=1 /ship` |
| Any `npm run preship*` invocation | `PRESHIP_SKIP=1 npm run preship` (short-circuits at the top of `scripts/preship.mjs` with a loud `BYPASS: PRESHIP_SKIP=1` line to stderr) |
| Local `npm publish` | Not bypassable. `prepublishOnly` runs preship:release; remove the script line only as part of an explicit rescue plan and revert immediately. |
| GitHub release publication | Not bypassable in the workflow. The immutable tag commit must have successful exact-SHA CI, preship, and Proton Bridge E2E evidence. |

Every bypass logs to stderr so a reader can see it happened (and `BYPASS:` lines are grep-able from CI logs).

## Installing gitleaks (recommended)

The grep fallback covers ~5 high-confidence credential patterns. gitleaks ships ~50 detectors plus history scanning.

```bash
# macOS
brew install gitleaks

# Linux (Go)
go install github.com/gitleaks/gitleaks/v8@latest

# Verify
gitleaks version
npm run check:secrets   # should now say "gitleaks: 0 findings"
```

## CI carve-out: Bridge is local-only

Proton Bridge is a desktop application and cannot run on GitHub-hosted runners. The CI workflow (`.github/workflows/preship.yml`) sets `PRESHIP_NO_BRIDGE=1`, which makes the `e2e:bridge` step print `SKIPPED — PRESHIP_NO_BRIDGE=1` and exit 0.

On a developer machine, Bridge is **hard-required** by `npm run preship`. Set `MAILPOUCH_E2E_BRIDGE_CONFIG=<path-to-bridge-config.json>` to enable Bridge tests; without it, the step fails with a clear message pointing here. The Bridge suite is non-wiping: existing mail is read-only, and destructive message operations and cleanup are restricted to UUID-marked messages created by that E2E run. Live scenarios never create, rename, or delete folders, so folder lifecycle coverage runs only against disposable Greenmail. Crash cleanup may create one exact-token rescue folder to COPY otherwise stranded owned All Mail residue, but never deletes a mailbox and reports the verified-empty rescue for manual deletion.

Live-run leases, setup journals, and ownership manifests are stored under the
user-private `~/.mailpouch-e2e-authority/v2/<mailbox-hash>/` scope. The hash is
derived from normalized IMAP endpoint and username, so distinct config files
targeting one mailbox serialize together without disclosing the account name.
Pre-journal encrypted clones from older harnesses block preflight until an
operator verifies that no matching legacy manifest/process remains and retires
only those exact files; uncertain artifacts are never age-reclaimed or deleted
automatically.

## Exact-SHA publication evidence

Publishing from `.github/workflows/publish.yml` is gated on the immutable commit
resolved from the release tag. Before either registry job can start, the gate
requires all of the following evidence on that exact 40-character SHA:

- the newest `CI` workflow run succeeded (the supported OS and Node matrix);
- the newest `preship` workflow run succeeded (including Greenmail E2E and the
  installed-bin tarball smoke test);
- the newest `mailpouch/proton-bridge-e2e` commit status is successful.

An older success does not mask a newer queued, running, cancelled, or failed
run. Evidence attached to a branch name, tag name, or another commit is refused.
The publish job then reruns `preship:fast`, performs a clean build, checks the
non-empty changelog entry, and verifies that the tag points at that same commit.
The post-tag ref check replaces `preship:release`'s pre-tag-only
`git-tag-free` check.

Because Proton Bridge cannot run on a hosted runner, create its status from a
clean checkout of the pushed release commit:

```bash
git status --short                     # must print nothing
export MAILPOUCH_E2E_BRIDGE_CONFIG=/path/to/bridge-config.json
node scripts/attest-bridge-e2e.mjs
```

The attester posts `pending` before starting, replaces `node_modules` from the
exact lockfile with `npm ci --ignore-scripts`, and then explicitly rebuilds only
`better-sqlite3` and `@napi-rs/keyring`. Install, rebuild, typecheck, build, and
the full Bridge E2E all run without inherited GitHub, npm, OIDC, SSH-agent, or
askpass credentials; the live Bridge config remains available to the E2E. This
prevents a stale dependency tree or an untrusted transitive lifecycle script
from influencing release evidence. The attester then verifies that HEAD and the
worktree did not change and posts `success` only after every command exits zero.
A failed, interrupted, or drifting run therefore cannot leave fresh success
evidence. It uses `GH_TOKEN`/`GITHUB_TOKEN` in the parent when supplied,
otherwise the token from `gh auth token`; that credential needs permission to
write commit statuses.

### Baseline verification scope

The Bridge suite snapshots pre-existing mailbox state and verifies it survived.
Verification is **scoped to mailboxes the run could have mutated**, derived from
durable manifest state: `INBOX` (sends land there), All Mail (the virtual union
containing everything the run creates), mailboxes the run positively created,
and any folder named by a pending-ownership proof.

Discrepancies inside that scope are **fatal**. Outside it they are reported as
drift and do not fail the run — those mailboxes are never written to, so drift
there cannot have been caused by the suite.

**This is a deliberate reduction in coverage.** A bug that wrote to a mailbox
outside the scope would no longer be caught by the baseline audit. It is
accepted because the alternative was worse in practice: against a live personal
account, Proton's own Spam auto-purge and ordinary mail movement produced
baseline failures on folders the suite never touches, each one retaining a run
that blocked every later run — so the release gate failed for reasons unrelated
to mailpouch.

Note the scope still includes All Mail, which is the one genuinely unstable
mailbox on a busy account. **Running against a disposable Bridge account rather
than a live personal mailbox removes the ambiguity entirely and is strongly
preferred**; the narrowed scope reduces the failure rate but does not eliminate
it.

### Releasing without live Bridge evidence

If no disposable Bridge account is available for a release, the Bridge E2E
attestation can be waived — but only by an explicit act recorded on the release
itself. There are two channels, and no ambient/default one:

- **`release: published`** — put `[bridge-e2e: waived]` anywhere in the GitHub
  release notes. Matching is case- and space-tolerant; the brackets are
  required, so prose that merely mentions the gate does not waive it.
- **`workflow_dispatch`** — set the `waive_bridge_e2e: true` input.

Either way the Publish run prints a `release-attestation WAIVED` line and writes
a ⚠️ block to the run summary. CI and preship attestations are never waivable.

The commit status is fetched and classified *before* the waiver is consulted, so
a waiver covers absent evidence and never failed evidence:

| Bridge status on the release SHA | Waived | Result |
|---|---|---|
| `success` | either | publishes on real evidence |
| `failure` / `error` | either | **hard-fails** — a waiver cannot suppress a red run |
| absent, or `pending` | yes | publishes, loudly waived |
| absent, or `pending` | no | hard-fails |

Prefer running `attest-bridge-e2e.mjs` over waiving. Waiving means no live
Proton Bridge evidence exists for those published bytes, and the release notes
will say so permanently.

> The release-notes channel exists because `release: published` accepts no
> inputs. Before it, a waived release had to be published by manual dispatch,
> after which the release event fired a second Publish run that could not waive
> and always failed — minutes after the package was already on npm. Releases
> 3.2.0, 3.2.1 and 4.0.0 all shipped that way, making a red Publish run the
> normal outcome of a successful release.

The registry jobs retain `npm publish --ignore-scripts` so dependency lifecycle
code never executes with registry credentials or OIDC authority. This is not a
test bypass: publishing is downstream of the exact-SHA verification job, and
each registry job installs with scripts disabled, rebuilds only the explicitly
trusted native dependencies, and rebuilds the package before publishing.

## Files involved

- `scripts/preship.mjs` — orchestrator
- `scripts/lib/preship-runner.mjs` — sequential runner + summary formatter
- `scripts/check-*.mjs` — five individual checks
- `scripts/check-release-attestations.mjs` — exact-SHA hosted/Bridge evidence gate
- `scripts/attest-bridge-e2e.mjs` — clean-checkout local Bridge status writer
- `scripts/smoke-tarball.mjs`
- `LICENSES.json` — committed license-inventory baseline (regenerated with `PRESHIP_LICENSE_WRITE=1`)
- `.preship-audit-allow.json` — committed acknowledgement list (starts empty)
- `.github/workflows/preship.yml` — CI gate
- `.github/workflows/publish.yml` — immutable-tag publication gate
- `package.json` — `simple-git-hooks` block pins the pre-push hook to `preship:fast`
