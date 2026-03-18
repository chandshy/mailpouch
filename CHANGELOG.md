# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - 2026-03-17

### Added
- **29 tools** (up from 20 in v1.0.0) with structured output and MCP annotations
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
