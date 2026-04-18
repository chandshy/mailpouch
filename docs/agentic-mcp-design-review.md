# Agentic MCP Design Review — pm-bridge-mcp

**Researched:** 2026-03-17 | **Updated:** 2026-03-17 | **Sources:** modelcontextprotocol.io specification (2025-11-25)

---

## MCP Primitive Coverage

The MCP protocol has four first-class primitives. This server uses **three of four**:

| Primitive | Control | Purpose | This server |
|---|---|---|---|
| **Tools** | Model-controlled | Actions & queries | ✅ 49 tools (+ 2 always-available escalation meta-tools) with structured output, annotations, and permission gating |
| **Resources** | App-driven | Addressable data via URI | ✅ `email://` and `folder://` URI schemes |
| **Prompts** | User-controlled | Workflow templates / slash commands | ✅ 5 prompts (triage_inbox, compose_reply, daily_briefing, find_subscriptions, thread_summary) |
| **Sampling** | Server-initiated | Server requests LLM completions | ❌ Not implemented (low priority — no current use case) |

### Additional protocol features implemented:
- ✅ `structuredContent` + `outputSchema` on tool results
- ✅ Progress notifications for bulk operations
- ✅ Cursor-based pagination (opaque cursors, stable across mutations)
- ✅ Tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`)
- ✅ Clean, emoji-free tool descriptions optimized for agent token efficiency

---

## Architecture Summary

### Permission Model (Defense-in-Depth)

```
Default (no config): read_only
  ↓
User runs: npm run settings
  ↓
Settings UI (browser or TUI)
  ↓
Choose preset or configure per-tool
  ↓
Config saved to ~/.pm-bridge-mcp.json (mode 0600)
  ↓
MCP server reloads every 15s → takes effect immediately
```

**Presets:**
| Preset | Scope | Use case |
|---|---|---|
| **Read-Only** | Reading, analytics, system tools only | Safe default — no writes |
| **Supervised** | All tools; deletion ≤5/hr, sending ≤20/hr | Day-to-day agent use |
| **Send-Only** | Reading + sending only | Drafting and sending without destructive access |
| **Full Access** | All 49 tools, no rate limits | Trusted workflows with full autonomy |

### Security Layers (10 total)
1. Permission gate — every tool checked against config (15s refresh)
2. Rate limiting — per-tool limits enforced in MCP server
3. Escalation gate — privilege increases require explicit human approval (separate channel)
4. Audit log — append-only at `~/.pm-bridge-mcp.audit.jsonl`
5. CSRF protection — all mutating API calls require session token
6. Origin validation — settings server checks Origin/Referer headers
7. Input validation — email addresses, folder names, attachment sizes, hostnames
8. Injection prevention — CRLF stripped from SMTP headers, subjects, filenames
9. Config file isolation — atomic writes at mode 0600, validated on load
10. Memory safety — email cache capped at 500 entries, rate-limiter buckets capped at 10k

### Escalation System
- Two-channel design: agent requests via MCP, human approves via browser/terminal
- CSRF-protected with human confirmation (type "APPROVE" before button activates)
- One-time use + 5-minute expiry
- Rate-limited: max 5 requests/hr, max 1 pending at a time
- Full audit trail

---

## Tool Classification

### Tool Annotations

| Category | Tools | readOnly | destructive | idempotent |
|---|---|---|---|---|
| **Reading** | `get_emails`, `get_email_by_id`, `search_emails`, `get_unread_count`, `get_folders` | true | — | — |
| **Analytics** | `get_email_stats`, `get_email_analytics`, `get_contacts`, `get_volume_trends` | true | — | — |
| **System** | `get_connection_status`, `get_logs` | true | — | — |
| **Cache/Sync** | `sync_emails`, `sync_folders`, `clear_cache` | false | false | true |
| **Flags** | `mark_email_read`, `star_email` | false | false | true |
| **Sending** | `send_email`, `reply_to_email`, `send_test_email` | false | false | false |
| **Organization** | `move_email`, `bulk_move_emails`, `archive_email`, `create_folder`, `rename_folder` | false | false | false |
| **Labeling** | `move_to_label`, `bulk_move_to_label`, `remove_label`, `bulk_remove_label` (COPY semantics — email stays in original folder, copy appears in Labels/) | false | false | false |
| **Deletion** | `delete_email`, `bulk_delete_emails`, `delete_folder` | false | **true** | false |
| **Escalation** | `request_permission_escalation`, `check_escalation_status` | false | false | true |

---

## Data Format Summary for Agents

### Response shapes by tool category

**List tools** (`get_emails`, `search_emails`):
```json
{
  "emails": [
    { "id": "12345", "from": "alice@example.com", "subject": "Hello", "date": "2026-03-17T10:00:00Z",
      "isRead": false, "isStarred": false, "hasAttachment": false, "folder": "INBOX",
      "bodyPreview": "First 150 chars of body..." }
  ],
  "total": 142,
  "nextCursor": "<opaque>"
}
```

**Single item** (`get_email_by_id`):
```json
{
  "id": "12345", "from": "alice@example.com", "to": ["me@proton.me"],
  "subject": "Hello", "body": "Full body here", "isHtml": false,
  "date": "2026-03-17T10:00:00Z", "folder": "INBOX",
  "isRead": true, "isStarred": false, "hasAttachment": true,
  "attachments": [{ "filename": "doc.pdf", "contentType": "application/pdf", "size": 12345 }]
}
```

**Action tools** (`send_email`, `delete_email`, `move_email`, etc.):
```json
{ "success": true, "messageId": "abc@proton.me" }
```

**Bulk action tools** (with progress notifications):
```json
{ "success": 47, "failed": 3, "errors": ["Email 999 not found", "..."] }
```

**Status tools** (`get_connection_status`, `get_unread_count`):
```json
{
  "smtp": { "connected": true, "host": "127.0.0.1", "port": 1025 },
  "imap": { "connected": true, "host": "127.0.0.1", "port": 1143 },
  "unreadByFolder": { "INBOX": 12, "Spam": 0 }
}
```

---

## Future Enhancements

| Enhancement | Effort | Impact | Notes |
|---|---|---|---|
| **Sampling** | ~4h | Medium | Server-initiated LLM calls for auto-triage or smart categorization |
| **`listChanged` capability** | ~30min | Low | Dynamic tool discovery when permissions change |
| **Additional prompts** | ~2h | Medium | `triage_inbox` and `daily_briefing` workflow templates |

---

## Key References

- [MCP Tools Spec](https://modelcontextprotocol.io/docs/concepts/tools) — structuredContent, outputSchema, annotations
- [MCP Resources Spec](https://modelcontextprotocol.io/docs/concepts/resources) — URI templates, subscriptions, annotations
- [MCP Prompts Spec](https://modelcontextprotocol.io/docs/concepts/prompts) — workflow templates, slash commands
- [MCP Sampling](https://modelcontextprotocol.io/docs/concepts/sampling) — server-initiated LLM calls
- [MCP Pagination](https://modelcontextprotocol.io/specification/2025-11-25/server/utilities/pagination.md) — cursor-based pagination spec
- [MCP Progress](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/progress.md) — streaming progress notifications
- [MCP Security Best Practices](https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices.md)
