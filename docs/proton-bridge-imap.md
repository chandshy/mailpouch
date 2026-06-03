# Proton Bridge — IMAP Reference

## Connection Parameters

| Parameter | Value |
|-----------|-------|
| Host | `127.0.0.1` or `localhost` |
| Port | `1143` (default; configurable) |
| Encryption | STARTTLS (default); switchable to implicit TLS (SSL) in Bridge settings |
| Authentication | PLAIN (as of Bridge v3.16.0+) or LOGIN |
| Username | Full Proton Mail email address |
| Password | Bridge password (same password used for SMTP; NOT your Proton login password) |

## imapflow Configuration

```javascript
import { ImapFlow } from 'imapflow';
import { readFileSync } from 'fs';

// Recommended: with exported Bridge certificate
const client = new ImapFlow({
  host: '127.0.0.1',
  port: 1143,
  secure: false,         // false = STARTTLS; true = implicit TLS
  auth: {
    user: 'you@protonmail.com',
    pass: '<bridge-password>',  // NOT your Proton login password
  },
  logger: false,
  tls: {
    ca: [readFileSync('/path/to/cert.pem')],  // Exported Bridge cert
    minVersion: 'TLSv1.2',
  },
});

// Fallback: without certificate (localhost-only acceptable but less secure)
const client = new ImapFlow({
  host: '127.0.0.1',
  port: 1143,
  secure: false,
  auth: { user: 'you@protonmail.com', pass: '<bridge-password>' },
  logger: false,
  tls: {
    rejectUnauthorized: false,
    minVersion: 'TLSv1.2',
  },
});
```

## Port Configuration

Default IMAP port: **1143**

To change the port in Bridge: Settings → Advanced settings → Default ports → Change (IMAP)

If port 1143 is occupied, increment by one (1144, 1145, etc.) until available.

## Authentication

Bridge supports the following SASL mechanisms for IMAP:
- **AUTHENTICATE PLAIN** — added in Bridge v3.16.0 (January 2025)
- **LOGIN** — standard mechanism

The username must be the full email address including domain. URL encoding of the `@` symbol may be required in some URL-format connection strings (e.g. `user%40protonmail.com`), but imapflow's `auth.user` field takes the plain email address without encoding.

The Bridge password is the same credential for both IMAP and SMTP. It is distinct from the Proton login password and is managed by Bridge internally, stored in the OS keychain.

## Folder Structure

Proton Mail uses a hybrid folder/label system internally. Bridge translates this to IMAP mailboxes using a specific naming convention.

### System Folders
These appear as top-level IMAP mailboxes with their IMAP special-use attributes set:

| Proton Folder | IMAP Path | Special-Use Attribute |
|--------------|-----------|----------------------|
| Inbox | `INBOX` | `\Inbox` |
| Sent | `Sent` | `\Sent` |
| Drafts | `Drafts` | `\Drafts` |
| Trash | `Trash` | `\Trash` |
| Spam | `Spam` | `\Junk` |
| Archive | `Archive` | `\Archive` |
| All Mail | `All Mail` | `\All` |
| Starred | `Starred` | `\Flagged` |

### User-Created Folders
Proton "folders" (which are exclusive — an email can only be in one folder) appear under the `Folders/` hierarchy:
- Example: A folder named "Work" → IMAP path `Folders/Work`
- Nested folders: A subfolder "Projects" inside "Work" → `Folders/Work/Projects`

### User-Created Labels
Proton "labels" (which are inclusive — an email can have multiple labels) appear under the `Labels/` hierarchy:
- Example: A label named "Important" → IMAP path `Labels/Important`
- Labels are flat (no nesting)

### Label Behavior in IMAP
When a label is applied to an email in Proton, the email appears in BOTH the `Labels/<name>` folder AND its primary Folder in IMAP. This causes apparent "duplication" in some IMAP clients that display all mailboxes.

When an email is moved to Trash, Bridge removes all labels from it (same behavior as Proton web/mobile clients).

### Important: Folder vs Label Distinction
- Moving an email to `Folders/Work` in IMAP sets its Proton folder to "Work" (exclusive)
- Moving an email to `Labels/Important` in IMAP applies the "Important" label (additive)
- Bridge's `LabelConflictManager` handles inconsistencies between the local Gluon SQLite state and the Proton API state

### How IMAP MOVE/COPY map to Proton label actions

Bridge translates IMAP mailbox membership into Proton **label** operations (DeepWiki, *IMAP Service*): `AddMessagesToMailbox` → Proton `LabelMessages`, `RemoveMessagesFromMailbox` → `UnlabelMessages`. So:

- An IMAP **COPY** to a mailbox = *add a label* (for `Folders/<x>`, the exclusive folder label; for `Labels/<x>`, an additive label).
- An IMAP **MOVE** = *add the target label* **+** *remove the source label*.

### The "All Mail" union — why you cannot MOVE out of it

`All Mail` (`\All`) is **not a real storage location** — it is a *union view* of every message in the account, independent of the folder/label a message actually carries. Every message appears in `All Mail`.

Because union membership is implicit (a message is in All Mail because it *exists*), **there is no "remove from All Mail" operation**. The *remove-from-source* half of a MOVE is therefore meaningless when the source is `All Mail`, and Bridge **accepts the MOVE but performs nothing** (a silent no-op), or rejects a MOVE into a system folder (`"IMAP operation failed"`). This is the field-observed "Bug A": `bulk_move_emails`/`move_email` with `sourceFolder:"All Mail"` returns *"accepted but could not be verified present in the target."*

**COPY still works from All Mail**, because it is only an *add-label* — no removal from the union is attempted. This is also why `bulk_move_to_label` (IMAP COPY to `Labels/<x>`) succeeds from All Mail while MOVE does not. It matches Proton's own guidance: *"copy the message to the folder instead of moving it."*

### Filing an "All-Mail-only" (archived) message into a folder

A message that lives **only** in the `All Mail` union (no Inbox/Sent/custom folder — a true archive) cannot be relocated with MOVE. The working path:

1. **COPY** the message (by its All Mail UID) to the destination `Folders/<name>` mailbox. This applies the folder label and files the message into that folder.
2. **Verify it landed** (UIDPLUS `COPYUID`, or Message-ID search) — never assume success; a union no-op must be reported as a failure.

This is the same `AddMessagesToMailbox` → `LabelMessages` mechanism as the label-COPY path that is already reliable from All Mail.

> **Verified 2026-06-03 against live Bridge** (non-destructive scratch test, UIDPLUS-confirmed):
> - `COPY` from `All Mail` → `Folders/<scratch>` **succeeds and the message lands** (server returns a `COPYUID` map).
> - `MOVE` from `All Mail` → `Folders/<scratch>` is **accepted but lands nothing** (the no-op).
>
> **Caveat — COPY adds, it does not atomically replace:** after a COPY-to-folder, the source message was observed *still present in its original folder* (checked +2 s). So COPY applies the target folder label without removing other folder labels at the IMAP layer; Proton's exclusivity is reconciled separately (and lazily). Implications for filing:
> - **All-Mail-only (archived) message** → COPY-to-folder files it cleanly (there is no other folder to leave behind). This is the #3 path.
> - **Message already in a real folder** → use a normal `MOVE` with the real `sourceFolder` (which works), *not* COPY-from-All-Mail — otherwise the message may transiently appear in two folders until Proton reconciles.
>
> This composes with finding #1: `get_email_by_id` now reports a message's real folder (or `All Mail` if it is archived), so a caller can choose MOVE-from-real-folder vs COPY-from-All-Mail correctly.

### Same-location moves are no-ops
Moving a message from/to the **identical** mailbox does nothing, and the All Mail union "accepts" such a move silently. The MCP server short-circuits `source == target` as a success no-op rather than issuing the operation (`isSameLocation` in `SimpleIMAPService`).

## Special Folder Handling for Drafts

Bridge handles draft messages distinctly:
- When an IMAP APPEND is performed to the Drafts folder with the `\Draft` flag, Bridge sends it to the Proton API as a proper draft
- This allows seamless draft editing across Bridge and Proton web/mobile clients
- The draft will sync and appear in Proton web interface immediately

The MCP server resolves the drafts folder path using this priority:
1. The folder with IMAP special-use `\Drafts` attribute
2. Case-insensitive match against names: `drafts`, `draft`, `[gmail]/drafts`
3. Fallback to literal string `Drafts`

## IMAP IDLE Support

Proton Bridge does NOT implement native IMAP IDLE server push. The IMAP service uses polling:
- Bridge polls the Proton API for new events every ~20 seconds
- Changes (new emails, flag updates, folder moves) appear in IMAP after the next poll cycle
- The older Bridge codebase (v1.x) had an IDLE handler; the current architecture (Gluon-based) uses polling

Practical implication for the MCP server:
- Do not use imapflow's IDLE capability expecting real-time delivery notifications
- Sync operations will reflect state as of the last poll (up to ~20 second delay)
- This is acceptable for an MCP server use-case where explicit sync is triggered on demand

## IMAP SEARCH Capabilities

Bridge implements standard IMAP SEARCH. The MCP server uses the following search criteria via imapflow:

| IMAP Criterion | MCP Server Usage |
|---------------|-----------------|
| `FROM <string>` | `options.from` |
| `TO <string>` | `options.to` |
| `SUBJECT <string>` | `options.subject` |
| `SINCE <date>` | `options.dateFrom` |
| `BEFORE <date>` | `options.dateTo` |
| `SEEN` / `UNSEEN` | `options.isRead` |
| `FLAGGED` | `options.isStarred` |
| `UID <range>` | Used internally for all UID-based operations |

**Limitations:**
- `BODY` (full-text search) is not implemented in the MCP server's search criteria
- `TEXT` (header + body) search is not implemented
- `X-GM-LABELS` (Gmail extension) is not supported by Bridge
- Search results are limited to the first N UIDs fetched; results are then enriched by individual `getEmailById` calls
- Multi-folder search works by searching each folder sequentially and merging results, capped at 20 folders

## IMAP UID Semantics

- Bridge assigns UIDs to messages via the Gluon database. UIDs are per-mailbox and monotonically increasing.
- UIDs are stable across sessions for the same mailbox — caching by UID is safe
- If a mailbox is deleted and recreated, UIDs start fresh (UIDVALIDITY changes)
- The MCP server uses UIDs (not sequence numbers) for all message operations, which is correct practice

## Synchronization Behavior

**Initial sync**: When Bridge first authenticates or a new account is added, it performs a full sync from the Proton API. This can take minutes to hours on large mailboxes. During this time, IMAP folders may be empty or partially populated.

**Ongoing sync**: Bridge uses a `userevents.Service` that polls the Proton API every ~20 seconds for events. The `SyncUpdateApplier` applies these events to the local Gluon database.

**Sync ordering**: Labels/folders must be synchronized before messages during initial sync to establish the mailbox hierarchy. If Bridge is interrupted during initial sync, the next startup resumes.

**Database health checks**: As of Bridge v3.21.1, startup includes database health checks; corrupted databases are detected earlier.

## Folder Operations via IMAP

Bridge supports full IMAP mailbox operations:
- `CREATE` — creates a new Proton folder (appears under `Folders/` hierarchy)
- `RENAME` — renames a folder (also renames all child folders)
- `DELETE` — deletes a folder (only allowed when empty; Bridge may enforce this depending on feature flags)
- `SELECT` / `EXAMINE` — opens a mailbox for reading
- `SUBSCRIBE` / `UNSUBSCRIBE` — manages subscription state

The MCP server protects system folders from deletion or renaming: `INBOX`, `Sent`, `Drafts`, `Trash`, `Spam`, `Archive`, `All Mail`.

## Flag Handling

Standard IMAP flags supported by Bridge:

| IMAP Flag | Meaning |
|-----------|---------|
| `\Seen` | Email has been read |
| `\Flagged` | Email is starred |
| `\Draft` | Email is a draft |
| `\Answered` | Email has been replied to |
| `\Forwarded` (or `$Forwarded`) | Email has been forwarded |
| `\Deleted` | Marked for deletion (expunged on EXPUNGE or CLOSE) |

Note: Bridge's Gluon implementation stores `\Answered` and forwarded state; these are synced to the Proton API.

## Unread Count

Proton Bridge's IMAP STATUS command reports:
- `MESSAGES` — total message count in the mailbox
- `UNSEEN` — count of messages without the `\Seen` flag

These are used by `getFolders()` in the MCP server to populate `totalMessages` and `unreadMessages` on each folder.

## Performance Characteristics

- **First open**: Very slow on large mailboxes. Bridge downloads messages on demand via the Proton API, but Gluon caches metadata locally. Fetching full message bodies triggers decryption.
- **Subsequent opens**: Fast — metadata is cached in SQLite; only new/changed messages need API calls.
- **Full message fetch (source)**: Each message requires a decrypt operation using the in-memory PGP key. This is CPU-bound but fast for individual messages.
- **Attachment downloads**: Attachments are encrypted separately and fetched on demand. Large attachments take time proportional to their size.
- **Batch fetching**: For inbox listing (`getEmails`), the MCP server fetches only the envelope, body structure, and the first body part (text preview) — it does NOT download full MIME source. Full source is fetched only when `getEmailById` is called. This avoids downloading attachment binaries during list views.

## Known Quirks and Issues

### 1. UID Scope is Per-Mailbox
IMAP UIDs are unique within a mailbox, not globally. A UID `12345` in INBOX is a different message than UID `12345` in Sent. The MCP server's `getEmailById` searches all folders to find a UID, which is a workaround for this limitation but adds latency. **The `All Mail` union is searched LAST** — because it contains every message, scanning it first would report `folder:"All Mail"` for messages that actually live in a real folder (the union masks the true location). Real folders win; All Mail is reported only for messages that exist nowhere else (true archive).

### 2. Label Duplication in IMAP
Emails with labels appear in multiple IMAP folders simultaneously (their primary folder AND all `Labels/x` folders). Clients that count all mailboxes will see duplicates. The MCP server exposes folder listing as-is without deduplication.

### 3. Initial Sync Latency
On first connect after installing Bridge or adding an account, IMAP will return empty or partial mailboxes until sync completes. There is no Bridge API to check sync progress.

### 4. No Body-Text IMAP SEARCH
Bridge does not index message content for IMAP SEARCH. `BODY` and `TEXT` search criteria return no results or fall back to a linear scan. Full-text search requires fetching and parsing message bodies locally.

### 5. IDLE Not Implemented (Polling Only)
Bridge does not push IMAP IDLE notifications. Any IDLE subscription silently degrades to polling. The ~20 second poll interval means new messages may not appear immediately.

### 6. Connection Drops on Bridge Restart
If Bridge is restarted while an IMAP connection is open, the TCP connection drops. imapflow will fire an `error` event and the `isConnected` flag will become stale. The MCP server handles this with `ensureConnection()` and `reconnect()`, but there is a window where operations fail before reconnection succeeds.

### 7. Folder Path Case Sensitivity
IMAP folder paths on Bridge are case-sensitive. `Sent` and `sent` are different paths. The MCP server uses exact paths as returned by the server's `LIST` command.

### 8. Combined Mode Hides Per-Address Segregation
In combined mode, all addresses share one IMAP mailbox. There is no way via standard IMAP to filter by which address a message was delivered to — all messages for all addresses appear together.

### 9. Labels Lost on Move to Trash
When an email is moved to Trash via Bridge/IMAP, all its Proton labels are removed. This is by design (matching Proton web behavior) but may surprise users who move emails to Trash and then restore them — the labels will not be restored.

### 10. Cannot MOVE Out of the "All Mail" Union (COPY Instead)
`All Mail` (`\All`) is a union view of every message, not a real location, and has no "remove" operation. A MOVE whose source is `All Mail` is accepted but silently does nothing (or errors into a system folder). To file an All-Mail-only (archived) message into a folder, **COPY** it to the `Folders/<name>` mailbox (which applies the exclusive folder label) and verify it landed. See "The 'All Mail' union" section above. Deleting mail is likewise a move-to-Trash, never an EXPUNGE from the union.

## Sources

- https://proton.me/support/labels-in-bridge
- https://deepwiki.com/ProtonMail/proton-bridge/3.1-imap-service
- https://protonmail.com/download/bridge/stable_releases.html
- https://proton.me/support/port-already-occupied-error
- https://man.sr.ht/~rjarry/aerc/providers/protonmail.md
- https://pkg.go.dev/github.com/ProtonMail/proton-bridge@v1.8.12/internal/imap/idle
- https://github.com/Foundry376/Mailspring/issues/429
- https://github.com/ProtonMail/gluon — Gluon IMAP server library (MOVE/UIDPLUS support; connector maps IMAP membership ↔ Proton labels)
- https://proton.me/blog/gluon-imap-library — Gluon snapshot model overview
