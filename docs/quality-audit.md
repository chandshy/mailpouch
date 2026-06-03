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

### PR #192 reviewer fixes (CodeQL + Copilot)
- `stripHtml` block-strip now matches `</script\s*>` / `</style\s*>` (trailing
  whitespace close tag could bypass the strip — CodeQL bad-HTML-filtering).
- `connect()` `isLocalhost` now includes IPv6 loopback `::1`, matching
  `buildBridgeTlsConfig` (host `::1` previously got a localhost TLS config but a
  non-localhost implicit-TLS `secure` default).
- Removed now-unused `ParsedMail`/`AddressObject` type imports from the service.
