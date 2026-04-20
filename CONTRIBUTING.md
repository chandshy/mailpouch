# Contributing to mailpouch

Thank you for your interest in contributing to mailpouch! This document provides guidelines and information for contributors.

## Getting Started

### Prerequisites

- Node.js 20.0.0 or higher
- npm 9.0.0 or higher
- Proton Mail account with Proton Bridge installed
- Git

### Development Setup

1. Fork the repository on GitHub
2. Clone your fork locally:
   ```bash
   git clone https://github.com/YOUR_USERNAME/mailpouch.git
   cd mailpouch
   ```

3. Install dependencies:
   ```bash
   npm install
   ```

4. Configure credentials via the settings UI:
   ```bash
   npm run build
   npm run settings    # opens http://localhost:8765
   ```
   Complete the setup wizard to save credentials to `~/.mailpouch.json`. Alternatively, create that file directly with the required `connection` fields (see `src/config/schema.ts` for the shape).

5. Build the project:
   ```bash
   npm run build
   ```

## Development Workflow

### Making Changes

1. Create a new branch for your feature/fix:
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. Make your changes following the code style guidelines

3. Test your changes:
   ```bash
   npm test
   npm run lint
   npm run build
   ```

4. Commit your changes:
   ```bash
   git add <specific-files>
   git commit -m "feat: description of your changes"
   ```

5. Push to your fork:
   ```bash
   git push origin feature/your-feature-name
   ```

6. Create a Pull Request on GitHub

### Code Style

- Use TypeScript for all new code
- Follow existing code formatting
- Use meaningful variable and function names
- Add comments for complex logic
- Keep functions focused and small
- No emojis in tool descriptions (wastes agent tokens)

### Commit Messages

Use [Conventional Commits](https://www.conventionalcommits.org/) format:

- `feat:` — new feature
- `fix:` — bug fix
- `docs:` — documentation changes
- `chore:` — maintenance tasks
- `refactor:` — code restructuring

Keep the first line under 72 characters. Add detailed description if needed.

Example:
```
feat: add email filtering by date range

- Implement dateFrom and dateTo parameters
- Update search_emails tool schema
- Add validation for date formats
```

## Project Structure

```
src/
├── index.ts                    # Unified daemon: MCP server (69 tools, Resources, Prompts) + settings HTTP server + system tray
├── settings-main.ts            # Standalone settings-UI CLI entry point — hosts the persistent tray icon via mailpouch-settings
├── accounts/
│   ├── registry.ts             # Multi-account CRUD + per-account keychain routing
│   ├── manager.ts              # Hot-swappable per-account SMTP/IMAP service pool
│   └── types.ts                # AccountSpec + registry types
├── config/
│   ├── schema.ts               # Tool list, categories, permission types
│   └── loader.ts               # Config load/save, preset builder, keychain migration
├── permissions/
│   ├── manager.ts              # Permission + rate-limit enforcement
│   └── escalation.ts           # Human-gated escalation challenge system
├── security/
│   ├── keychain.ts             # OS keychain integration (@napi-rs/keyring) — single-account + per-account helpers
│   └── memory.ts               # Credential wipe helpers
├── settings/
│   ├── security.ts             # Rate limiting, CSRF, origin validation, TLS
│   ├── server.ts               # Browser-based settings UI (localhost:8765)
│   └── tui.ts                  # Terminal UI for settings
├── services/
│   ├── smtp-service.ts         # SMTP email sending (Nodemailer), deferred-init pattern
│   ├── simple-imap-service.ts  # IMAP email reading (ImapFlow)
│   ├── scheduler.ts            # Scheduled email delivery
│   └── analytics-service.ts   # Email analytics computation
├── types/
│   └── index.ts                # Shared TypeScript types
└── utils/
    ├── helpers.ts              # ID generation, email validation, log sanitisation
    ├── icon.ts                 # Pure-Node PNG/ICO generator for the brand-matching tray icon
    ├── tray.ts                 # Unified tray facade — native backend → systray2 fallback
    ├── logger.ts               # Structured log store
    └── tracer.ts               # Lightweight request tracing

native/
└── tray/                       # Rust/napi-rs binding around tauri-apps/tray-icon
    ├── src/lib.rs              # ~280-line Rust addon, threaded event loop, click tsfn
    ├── Cargo.toml              # tray-icon + muda + napi + napi-derive
    ├── index.js / index.d.ts   # napi-rs generated JS loader + types
    └── index.<platform>.node   # Committed prebuilts: linux-x64-gnu, linux-arm64-gnu, darwin-arm64, win32-x64/arm64-msvc

docs/
├── proton-bridge-imap.md
├── proton-bridge-overview.md
├── proton-bridge-security-model.md
├── proton-bridge-smtp.md
├── proton-bridge-tls.md
└── smtp-imap-config-reference.md
```

## Testing Guidelines

### Running Tests

```bash
npm test              # Run all tests
npm run test:watch    # Watch mode
npm run test:coverage # With coverage report
```

### Manual Testing

1. Start Proton Bridge
2. Build and run the MCP server
3. Test with Claude Desktop or MCP Inspector
4. Verify all affected tools work correctly

### Test Coverage

When adding new features:
- Test all success paths
- Test error conditions
- Test edge cases (empty inputs, null values, etc.)
- Test with Proton Bridge running and stopped

## Adding New Features

### Adding a New Tool

1. Add the tool name to `ALL_TOOLS` in `src/config/schema.ts`
2. Add it to the appropriate category in `TOOL_CATEGORIES`
3. Define the tool schema in `src/index.ts` with annotations:
   ```typescript
   {
     name: "new_tool_name",
     description: "Clear description. Returns {output summary}.",
     inputSchema: {
       type: "object",
       properties: { /* parameters */ },
       required: ["required_params"]
     },
     outputSchema: {
       type: "object",
       properties: { /* output shape */ }
     },
     annotations: {
       readOnlyHint: true,       // or false for mutations
       destructiveHint: false,   // true for deletions
       idempotentHint: true      // true if safe to retry
     }
   }
   ```

4. Implement the handler with permission check and structuredContent:
   ```typescript
   case "new_tool_name": {
     permissionManager.check("new_tool_name");
     const result = { /* ... */ };
     return {
       content: [{ type: "text", text: JSON.stringify(result) }],
       structuredContent: result
     };
   }
   ```

5. Update `src/config/loader.ts` to include the tool in appropriate presets:
   - Add the tool to the `read_only` allowed-set if it is a read-only operation
   - Add rate-limit overrides in `supervised` / `send_only` sections as appropriate
   - Verify the tool is correctly toggled by running `buildPermissions("read_only")` in a test
6. Add tests
7. Update README.md and CONTRIBUTING.md tool counts

### Adding a New Service

1. Create a new file in `src/services/`
2. Define TypeScript interfaces in `src/types/index.ts`
3. Implement the service class
4. Import and use in `src/index.ts`
5. Add tests
6. Document in README.md

## Pull Request Process

1. Ensure your code builds without errors
2. All tests pass (`npm test`)
3. Update documentation as needed
4. Add a clear description of changes in the PR
5. Link any related issues

### PR Checklist

- [ ] Code builds successfully (`npm run build`)
- [ ] Linter passes (`npm run lint`)
- [ ] Tests pass (`npm test`)
- [ ] Tested manually with Claude Desktop
- [ ] Documentation updated
- [ ] Commit messages follow conventional format
- [ ] No sensitive data in commits

## Security

### Reporting Security Issues

If you discover a security vulnerability:
1. **Do NOT** open a public issue
2. Email the maintainer at chandshy@gmail.com
3. Provide details about the vulnerability
4. Allow time for a fix before public disclosure

### Security Best Practices

- Never commit credentials or API keys
- Store credentials in `~/.mailpouch.json` (mode 0600) or OS keychain — never in env vars or source code
- Validate all user inputs
- Handle errors securely
- Follow principle of least privilege
- All mutating tools must go through the permission manager
- Destructive tools must have `destructiveHint: true` annotation

## Questions?

- Open a GitHub Discussion for general questions
- Open an [Issue](https://github.com/chandshy/mailpouch/issues) for bug reports or feature requests
- Check existing issues and discussions first

## License

By contributing, you agree that your contributions will be licensed under the MIT License.

## Code of Conduct

- Be respectful and inclusive
- Welcome newcomers
- Focus on constructive feedback
- Assume good intentions
- Respect different viewpoints and experiences

Thank you for contributing!
