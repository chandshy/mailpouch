import { describe, expect, it } from "vitest";

import { buildGrantApprovalBody, buildShellHtml, grantModalState } from "./shell.js";
import { buildSetupHtml } from "./tabs/setup.js";

describe("account activation UI", () => {
  it("keeps the restart-required fallback instead of always promising a live switch", () => {
    const html = buildShellHtml("csrf-test-token", 8765);

    expect(html).toContain("const result = await r.json().catch(() => null);");
    expect(html).toContain("if (result?.restartRequired !== false)");
    expect(html).toContain("Restart the MCP server to apply it");
  });
});

describe("LAN settings session UI", () => {
  it("explains how to recover when the server-side browser session expires", () => {
    const html = buildShellHtml("csrf-test-token", 8765);

    expect(html).toContain("lan_session_required");
    expect(html).toContain("Reopen the secure settings URL shown by mailpouch.");
  });
});

describe("auxiliary credential clear UI", () => {
  it("keeps blank undisclosed fields non-destructive and sends clear flags only after Clear", () => {
    const html = buildShellHtml("csrf-test-token", 8765);
    const setupHtml = buildSetupHtml({
      safeConfigPath: "/tmp/mailpouch.json",
      certBrowsePlaceholderAttr: "/tmp/cert.pem",
      certPlatformHint: "certificate hint",
      runningPort: 8765,
    });

    expect(setupHtml).toContain("data-action=\"clearAuxiliarySecret\"");
    expect(html).toContain("pendingAuxiliarySecretClears.simpleloginApiKey && !simpleloginApiKey.trim()");
    expect(html).toContain("clearSimpleloginApiKey: true");
    expect(html).toContain("pendingAuxiliarySecretClears.passAccessToken && !passAccessToken.trim()");
    expect(html).toContain("clearPassAccessToken: true");
  });
});

describe("reset cleanup UI", () => {
  it("requires manual keychain cleanup before suggesting a restart", () => {
    const html = buildShellHtml("csrf-test-token", 8765);

    expect(html).toContain("manualKeychainCleanupRequired");
    expect(html).toContain("Delete them manually before restarting");
  });

  it("echoes the reset generation on settings, permission, preset, and account form saves", () => {
    const html = buildShellHtml("csrf-test-token", 8765);

    expect(html.match(/configResetGeneration: cfg\?\.configResetGeneration \?\? 0/g)?.length).toBeGreaterThanOrEqual(7);
  });
});

describe("agent grant edit UI", () => {
  it("round-trips an unchanged active grant without widening or truncating it", () => {
    const grant = {
      preset: "custom" as const,
      conditions: {
        expiresAt: "2026-12-15T17:42:37.123Z",
        folderAllowlist: ["INBOX", "Folders/Finance"],
        ipPins: ["127.0.0.1", "192.168.1.50"],
        maxCallsPerHourByTool: { get_emails: 17 },
        accountId: "primary",
        accountIdentity: "mailbox-fingerprint",
      },
      toolOverrides: {
        delete_email: false,
        bulk_delete_emails: true,
        send_email: false,
        reply_to_email: false,
        forward_email: false,
        get_emails: true,
      },
      note: "  preserve this note exactly  ",
    };

    expect(buildGrantApprovalBody(grant, grantModalState(grant))).toEqual(grant);
  });
});
