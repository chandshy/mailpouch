# Optional integrations compatibility study

Research snapshot: 2026-08-31. This is a research-only artifact; it does not authorize implementation or reverse engineering.

## Decision

SimpleLogin is close to usable but needs one confirmed request fix and live contract tests. Proton Pass is not currently production-compatible with the official CLI: the wrapper omits the required PAT login lifecycle and parses the current JSON shapes incorrectly. Public documentation and open source were sufficient for this conclusion, so disassembly is neither needed nor authorized.

## Evidence baseline

- SimpleLogin API: [`docs/api.md` at `ec20d5ac`](https://github.com/simple-login/app/blob/ec20d5ac5360351dc0428d9a775a2dd4c3a4a264/docs/api.md) (2026-03-13).
- Proton Pass CLI: signed tag [`2.3.3`](https://github.com/protonpass/pass-cli/releases/tag/2.3.3), source commit [`51a4c9b`](https://github.com/protonpass/pass-cli/tree/51a4c9b110a0ffe6e81f4f5d3877b9e5a0c24112) (2026-08-25).
- Proton Pass CLI command and PAT documentation: [item](https://protonpass.github.io/pass-cli/commands/item/), [login](https://protonpass.github.io/pass-cli/commands/login/), and [configuration](https://protonpass.github.io/pass-cli/get-started/configuration/).

No live SimpleLogin account or installed `pass-cli` was available. Findings below are therefore source-contract findings, not live-service attestations.

## SimpleLogin

### What matches

- Authentication uses the `Authentication` header with an account API key. Invalid keys return 401.
- Alias pagination is zero-based and returns at most 20 aliases per page; MailPouch's bounded pagination follows that contract.
- Custom aliases, alias updates/toggles/deletion, activities, contacts, mailboxes, and custom-domain listing use documented endpoints and core fields.
- The optional base URL supports self-hosted SimpleLogin deployments.
- API failures are documented as 4xx responses with `{ "error": "..." }`; MailPouch preserves the status/message while redacting secret-shaped values.

### Confirmed mismatch and gaps

- `alias_create_random` sends `mode` in the JSON body. The pinned API contract defines `mode=uuid|word` in the query string and only `note` in the body. The current mode selection can therefore be ignored in favor of the account default.
- MailPouch has no tools for documented alias detail, mailbox update/default selection, custom-domain update/trash, account settings/domain selection, notifications, or exports. These are product gaps, not regressions in the advertised 16-tool surface.
- The official API document publishes no 429, `Retry-After`, quota, or retry contract. MailPouch times out after 15 seconds and does not retry. Do not invent retry behavior until a live black-box test or an official contract establishes it.
- Response behavior is unit-tested with mocks only; the existing opt-in E2E placeholders have no service-backed fixture.

## Proton Pass

### Current official contract

- PATs start with no access. Each vault or item grant has a `viewer`, `editor`, or `manager` role and an expiry.
- A PAT is supplied to `pass-cli login` through `PROTON_PASS_PERSONAL_ACCESS_TOKEN`; the resulting PAT session lasts two hours and cannot use a session lock.
- `item list` requires a vault/share selector unless the CLI has a default vault. JSON is an object containing `items`, not a top-level array. Current 2.3.3 summaries use `title`, `item_type`, `share_id`, `vault_id`, `create_time`, and `modify_time`.
- `item view` and `item totp` require both a vault/share selector and an item selector, or one `pass://` URI. JSON view output is the CLI's full item wrapper. TOTP JSON is a map keyed by actual field names, not reliably `{ code, totp }`.
- Official documentation publishes no explicit rate-limit guarantee.

### Confirmed MailPouch incompatibilities

- MailPouch passes the PAT environment variable directly to `item` commands but never runs `pass-cli login` or manages the two-hour session. Official tooling performs login before invoking item commands.
- `pass_list` expects a top-level JSON array, so it rejects the current `{ items: [...] }` output.
- The summary model expects `name`, `type`, `vault`, and `updatedAt`, which do not match the current CLI fields.
- `pass_get` and `pass_totp` pass only `--item-id`; the current CLI also requires a vault/share selector unless a default is configured.
- `pass_get` treats the full CLI wrapper as a flat MailPouch item, and the TOTP schema cannot represent arbitrary field names.
- Errors are collapsed into raw exit text. Authentication expiry, missing grants, not-found, policy denial, network failure, and any future rate-limit response cannot yet be handled distinctly.
- `pass-cli` is not installed on the development host, so mocked subprocess tests cannot prove the integration.

## Implementation plan requiring separate approval

1. Pin and install an official `pass-cli` release in a disposable environment; record sanitized JSON fixtures for list, view, TOTP, expired PAT, missing grant, and not-found cases.
2. Add a minimal session lifecycle: isolated session directory, `info` preflight, PAT login when absent/expired, and one bounded re-login on an authentication-expiry error.
3. Require a vault/share selector in MailPouch Pass tools and normalize official 2.3.3 output into stable MCP schemas without returning extra secret fields.
4. Fix SimpleLogin random mode placement and add disposable-account black-box tests for all 16 advertised tools, including destructive cleanup ownership checks.
5. Add retry/backoff only for an officially documented or empirically confirmed transient/rate-limit signal. Keep all other failures fail-closed.
6. Re-run the full permission, audit-log, secret-redaction, and live integration suites before enabling either integration by default.

Reverse engineering remains a separate gate. If official docs, public source, and permitted black-box behavior cannot answer a required question, stop and obtain explicit approval before any disassembly.
