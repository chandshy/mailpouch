# mailpouch — Documentation Index

| Document | Audience | Contents |
|---|---|---|
| [README.md](../README.md) | Users & operators | Installation, full feature overview, configuration reference, environment variables |
| [HELP.md](../HELP.md) | Users | Task-oriented how-tos: setup, presets, optional integrations, FTS, scheduling, troubleshooting |
| [README_FIRST_AI.md](../README_FIRST_AI.md) | AI agents | Complete MCP tool API reference, permission presets, operating guidelines |
| [SECURITY.md](../SECURITY.md) | Security reviewers | Threat model, rate limiting, escalation design, remote agent authentication (OAuth / service accounts), audit trail, credential storage |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | Contributors | Build setup, test suite, PR guidelines |
| [improvement-loop.md](improvement-loop.md) | Maintainers & coding agents | Persistent audit → implement → validate → re-audit workflow |
| [releasing.md](releasing.md) | Maintainers | Release gates (tag/SHA attestations, Bridge E2E status), npm **trusted publishing (OIDC)** setup, release checklist |
| [audit-2026-07-30.md](audit-2026-07-30.md) | Maintainers & security reviewers | Data-loss/safety audit; the `remove_label` survival invariant and why it is bridge-lane only; upstream Proton API & product status |
| [audit-2026-05-28.md](audit-2026-05-28.md) | Maintainers & security reviewers | Earlier security audit findings (XPORT-*, PERM-*, CRED-* IDs referenced throughout the code) |
| [quality-audit.md](quality-audit.md) | Maintainers | Per-finding ledger from the Bridge-capability program; grep for `Resolved`/`Acknowledged` |
| [CHANGELOG.md](../CHANGELOG.md) | All | Version history |

## Technical Reference (Proton Bridge)

| Document | Contents |
|---|---|
| [proton-bridge-overview.md](proton-bridge-overview.md) | Architecture, ports, TLS, authentication methods, combined vs split mode |
| [proton-bridge-imap.md](proton-bridge-imap.md) | IMAP implementation details, IDLE, UID stability |
| [proton-bridge-smtp.md](proton-bridge-smtp.md) | SMTP submission, direct mode, SMTP tokens |
| [proton-bridge-tls.md](proton-bridge-tls.md) | TLS cert export, STARTTLS vs SSL, Node.js integration |
| [proton-bridge-security-model.md](proton-bridge-security-model.md) | Bridge security model, key storage, upstream pinning |
| [smtp-imap-config-reference.md](smtp-imap-config-reference.md) | Quick-reference config values for all supported modes |

## Feature Map

| Feature | Tools | Config | Docs |
|---|---|---|---|
| Email reading | `get_emails`, `get_email_by_id`, `get_thread`, `search_emails`, `get_unread_count`, `list_labels`, `get_emails_by_label`, `download_attachment`, `get_correspondence_profile`, `extract_action_items`, `extract_meeting` | Setup tab | HELP §2, README_FIRST_AI |
| Sending | `send_email`, `reply_to_email`, `forward_email`, `send_test_email` | Setup tab, Permissions tab | HELP §2, README_FIRST_AI |
| Drafts & scheduling | `save_draft`, `schedule_email`, `list_scheduled_emails`, `cancel_scheduled_email`, `list_proton_scheduled`, `remind_if_no_reply`, `list_pending_reminders`, `cancel_reminder`, `check_reminders` | none | HELP §7, README_FIRST_AI |
| Full-text search | `fts_search`, `fts_rebuild`, `fts_status` | none (auto index) | HELP §6, README_FIRST_AI |
| Labels & folders | `list_labels`, `get_emails_by_label`, `move_to_label`, `bulk_move_to_label`, `remove_label`, `bulk_remove_label`, `get_folders`, `sync_folders`, `create_folder`, `rename_folder`, `delete_folder` | none | HELP §8, README_FIRST_AI |
| Email actions | `mark_email_read`, `star_email`, `move_email`, `archive_email`, `move_to_trash`, `move_to_spam`, `move_to_folder`, `bulk_mark_read`, `bulk_star`, `bulk_move_emails` | Permissions tab | README_FIRST_AI |
| Deletion | `delete_email`, `bulk_delete_emails`, `empty_trash` | Permissions tab | HELP §3, README_FIRST_AI |
| Analytics | `get_email_stats`, `get_email_analytics`, `get_volume_trends`, `get_contacts` | none | HELP §9, README_FIRST_AI |
| SimpleLogin aliases | `alias_*` (16 tools, listed only when configured) | Setup → Optional Integrations | HELP §4, README_FIRST_AI |
| Proton Pass | `pass_list`, `pass_search`, `pass_get`, `pass_totp` (listed only when configured) | Setup → Optional Integrations | HELP §4, README_FIRST_AI |
| System / Bridge | `get_connection_status`, `sync_emails`, `clear_cache`, `get_logs`, `get_server_version`, `start_bridge`, `shutdown_server`, `restart_server` | Setup tab | README_FIRST_AI |
| Permissions | presets, per-tool rate limits, custom | Permissions tab | HELP §3, README |
| Per-agent grants | — | Agents tab | HELP §10, README |
| Service accounts (headless OAuth `client_credentials`) | `mailpouch agent issue` / `list` / `revoke` (CLI) | Agents tab "+ Service account" | HELP §13, README, SECURITY §11 |
| Escalation | `request_permission_escalation`, `check_escalation_status` | Agents tab | HELP §11, README_FIRST_AI |
| Multi-account | — | Accounts tab | HELP §12, README |
| Remote HTTP mode | — | `~/.mailpouch.json` (direct edit) | HELP §13, README |
| Desktop notifications | — | Setup tab toggle | HELP §5 |
| Response limits | — | Status tab | HELP §14, README |
