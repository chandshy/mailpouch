# Releasing mailpouch

Publishing is **not** triggered by merging to `main`. `.github/workflows/publish.yml` fires
only on a **published GitHub Release** or a manual `workflow_dispatch`.

## The gates, in order

`publish.yml` runs `verify-release` before anything is published. It will refuse unless
**all** of these hold:

1. **Tag matches package and commit** — `scripts/check-release-ref.mjs`. The tag must be
   `v<package.json version>` and must point at the commit being built.
2. **Exact-SHA workflow attestations** — `scripts/check-release-attestations.mjs` requires a
   **successful run of `ci.yml` and `preship.yml` at that exact commit SHA**. A green run on
   a different commit does not count.
3. **Bridge E2E commit status** — a successful `bridge-e2e` commit status on that same SHA,
   written by `scripts/attest-bridge-e2e.mjs`.

Then `publish-npm` (npm registry) and `publish-gpr` (GitHub Packages) run.

## Bridge E2E attestation

```bash
MAILPOUCH_E2E_BRIDGE_CONFIG=/path/to/disposable-bridge-config.json \
  node scripts/attest-bridge-e2e.mjs
```

The script refuses to run against a dirty checkout, posts a `pending` status, runs the full
local Proton Bridge E2E, then posts `success`/`failure` for `HEAD`. It scrubs
`GH_TOKEN`/`NPM_TOKEN`/`SSH_AUTH_SOCK` and friends from the child environment first.

> **The current Bridge E2E is ownership-scoped and non-wiping.** It snapshots the existing
> mailbox folders, message identities, and flags before starting the MCP process. Test-created
> probes carry an exact run marker; teardown permanently deletes only messages proved to belong
> to that run, never pre-existing mail, and does not delete mailboxes. Teardown then verifies the
> original baseline is unchanged. The run still appends self-addressed probes to the configured
> account, so a disposable Proton account remains the recommended target.
>
> The v3.2.0 attestation run (2026-07-14), before this ownership-scoped harness, was pointed at
> the live mailbox and left 13 `mpE2E-*` scratch mailboxes behind; they were still there on
> 2026-07-30 and had to be cleaned up by hand. That incident is historical and does not describe
> the current suite's teardown behavior.
>
> A read-only audit on 2026-08-31 found 49 later `mpE2E-*` artifacts (40 cleanup-rescue folders
> and 9 labels), all empty. They are intentionally reconciled as manual cleanup rather than
> deleted by the harness; live cleanup never issues mailbox DELETE.

Note this is a **local, manual** step — there is no `bridge-e2e` workflow. A commit therefore
has *no* Bridge status until someone runs the script against that exact SHA. "Missing status"
means the E2E never ran for those bytes, which is different from the E2E failing.

### Waiving the Bridge E2E

When no disposable account is available, a release can be published without Bridge evidence —
but only as a deliberate, recorded act:

```bash
gh workflow run publish.yml -f release_tag=vX.Y.Z -f waive_bridge_e2e=true
```

The waiver is a **`workflow_dispatch` input only**. It is not a repo variable and not a
default, so it shows up in the run's inputs and cannot become ambient state that quietly
erodes the gate. The `release: published` trigger has no inputs, so the automatic path stays
strict. CI and preship attestations are **never** waivable.

Do **not** hand-POST a green `proton-bridge-e2e` status instead. That would make the gate look
satisfied while proving nothing, and would devalue every future release's attestation. Waiving
prints a loud `release-attestation WAIVED` line in the job log; forging prints `OK`.

## npm authentication — trusted publishing (OIDC)

The npm job authenticates with **OIDC trusted publishing**. There is deliberately **no
`NODE_AUTH_TOKEN`** in the publish step — a token in scope takes precedence over OIDC, so
leaving one set would silently keep using classic auth and skip the provenance attestation
that trusted publishing generates automatically.

Short-lived OIDC credentials cannot be exfiltrated from a compromised transitive dependency
the way a stored token can, and there is no token to rotate or to silently expire between
releases — which is exactly what happened before v3.2.1 (`npm whoami` → `401`).

**Configured 2026-07-30** for `chandshy/mailpouch` → `publish.yml`, allowed actions
*npm publish* + *npm stage publish*, package public.

The obsolete `NPM_TOKEN` repository secret was removed and its absence was reverified on
2026-08-31. Maintainers do not sign in to npm or run `npm publish` locally: publishing starts
from the GitHub release/tag workflow, which obtains short-lived OIDC credentials.

### Trusted-publisher registration (already completed)

This is account administration, not a release step. The current registration is documented
here only so it can be repaired if the repository or workflow name changes.

On <https://www.npmjs.com/package/mailpouch> → **Settings** → **Trusted Publisher** → choose
**GitHub Actions**, then enter:

| Field | Value |
|---|---|
| Organization or user | `chandshy` |
| Repository | `mailpouch` |
| Workflow filename | `publish.yml` — filename only, **not** a path |
| Environment name | *(leave empty — this workflow uses no GitHub environment)* |
| Allowed actions | **`npm publish`** (required for configs created after 2026-05-20) |

### Repo-side requirements — already satisfied

- `permissions: id-token: write` on the publish job ✅
- `package.json` `repository.url` resolves to `chandshy/mailpouch`, which **must** match the
  trusted publisher exactly ✅
- **Node 24.x in the publish job** ✅ — trusted publishing needs **npm ≥ 11.5.1 / Node ≥ 22.14.0**.
  A 22.x line below that patch ships an npm that silently falls back to token auth. This is
  the one change that is easy to miss.
- GitHub-hosted runner ✅ — self-hosted runners are not supported.

### Notes

- **Provenance is automatic.** Under trusted publishing npm generates and publishes provenance
  attestations without `--provenance`.
- **One trusted publisher per package**, so the workflow filename is effectively pinned. If
  `publish.yml` is ever renamed, update the npm setting in the same change or releases break.
- **No manual npm credentials:** release operators push the verified tag/package to GitHub;
  `publish.yml` is the only npm deployment path. Package-account controls are not release
  credentials and are not checked through a maintainer npm login.
- The **GitHub Packages** job (`publish-gpr`) is unaffected — it authenticates to
  `npm.pkg.github.com` with the built-in `GITHUB_TOKEN`.

## Release checklist

1. `main` green; `CHANGELOG.md` has a dated section for the version; `package.json` **and both
   `package-lock.json` version fields** agree (`npm run check:version-sync`).
2. `npm run preship:release` locally.
3. Confirm `ci.yml` **and** `preship.yml` are green **at the exact release SHA**.
4. Produce the `bridge-e2e` status for that SHA (disposable account).
5. Tag `v<version>` at that SHA and push it.
6. Publish the GitHub Release → `publish.yml` runs.

Never pipe `npm publish` through `tail` — it masks the exit code and a failed publish looks
like a success while the tag has already been pushed.
