import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

describe("production safety wiring", () => {
  it("routes every startup credential source through StartupCredentialAccess", () => {
    expect(source).toMatch(/startupCredentialAccess\.migrate\(migrateCredentials\)/);
    expect(source).toMatch(/refreshAuxiliaryServicesFromConfig\(startupCredentialAccess\)/);
    expect(source).toMatch(
      /startupCredentialAccess\.readMailbox\(\s*loadCredentialsFromConfigFile,\s*loadCredentialsFromKeychain,?\s*\)/,
    );
    expect(source).toMatch(/startupCredentialAccess\.readExternal\(loadRemoteSecrets\)/);
    expect(source).toMatch(
      /startupAccess\.readExternal\(loadAuxiliaryCredentialsFromKeychain\)/,
    );
  });

  // A destructive-confirm elicitation awaits user input for an unbounded time.
  // The grant store was re-read afterwards, but the global preset — the other
  // half of the authorization ceiling, and in a different file — was not, so
  // lowering the preset during the confirmation dialog did not take effect and
  // the call proceeded under the revoked, more permissive ceiling.
  it("re-reads the global preset after the destructive-confirm await, not just the grant", () => {
    // The final pre-dispatch check must consume a freshly-read preset...
    expect(source).toMatch(
      /const finalPreset = \(loadConfig\(\) \?\? defaultConfig\(\)\)\.permissions\.preset;/,
    );
    expect(source).toMatch(/globalPreset: finalPreset,\n\s*\}, \{ snapshot: grantSnapshot \}\)/);
    // ...and must NOT fall back to the value captured before the await.
    expect(source).not.toMatch(/globalPreset,\n\s*\}, \{ snapshot: grantSnapshot \}\)/);
  });

  it("binds the request-local mailbox identity around the real tool handler invocation", () => {
    expect(source).toMatch(
      /withE2EMailboxIdentity\(\s*args as Record<string, unknown>,\s*\(\) => handler\(ctx\),\s*\)/,
    );
  });

  it("threads MCP cancellation into an absolute routed mailbox-mutation deadline", () => {
    expect(source).toMatch(
      /setRequestHandler\(CallToolRequestSchema, async \(request, extra\) =>/,
    );
    expect(source).toMatch(
      /const mailboxMutationDeadlineAt = Date\.now\(\) \+ MAILBOX_MUTATION_DEADLINE_MS/,
    );
    expect(source).toMatch(/signal: extra\.signal/);
    expect(source).toMatch(
      /routedImapService\.abortPrimaryMutationTransport/,
    );
  });

  it("reconnects before every mailbox mutation handler and preserves deadline guidance", () => {
    expect(source).toMatch(
      /if \(MAILBOX_MUTATION_TOOLS\.has\(name\)\) \{\s*await routedImapService\.ensureMutationConnection\(\);\s*\}/,
    );
    expect(source).toMatch(
      /if \(error instanceof MailboxMutationDeadlineError\) return error\.message/,
    );
  });
});
