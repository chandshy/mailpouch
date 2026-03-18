import { describe, it, expect } from "vitest";
import { join } from "path";
import { homedir } from "os";
import { buildPermissions, defaultConfig, getConfigPath } from "./loader.js";
import { ALL_TOOLS, TOOL_CATEGORIES } from "./schema.js";

describe("buildPermissions", () => {
  describe("read_only", () => {
    const perms = buildPermissions("read_only");

    it("enables reading, analytics, and system tools", () => {
      for (const tool of TOOL_CATEGORIES.reading.tools) {
        expect(perms.tools[tool].enabled).toBe(true);
      }
      for (const tool of TOOL_CATEGORIES.analytics.tools) {
        expect(perms.tools[tool].enabled).toBe(true);
      }
      for (const tool of TOOL_CATEGORIES.system.tools) {
        expect(perms.tools[tool].enabled).toBe(true);
      }
    });

    it("enables get_folders", () => {
      expect(perms.tools.get_folders.enabled).toBe(true);
    });

    it("disables sending tools", () => {
      for (const tool of TOOL_CATEGORIES.sending.tools) {
        expect(perms.tools[tool].enabled).toBe(false);
      }
    });

    it("disables deletion tools", () => {
      for (const tool of TOOL_CATEGORIES.deletion.tools) {
        expect(perms.tools[tool].enabled).toBe(false);
      }
    });

    it("disables actions tools (except those in allowed set)", () => {
      for (const tool of TOOL_CATEGORIES.actions.tools) {
        expect(perms.tools[tool].enabled).toBe(false);
      }
    });
  });

  describe("full", () => {
    const perms = buildPermissions("full");

    it("enables all tools", () => {
      for (const tool of ALL_TOOLS) {
        expect(perms.tools[tool].enabled).toBe(true);
      }
    });

    it("has no rate limits on any tool", () => {
      for (const tool of ALL_TOOLS) {
        expect(perms.tools[tool].rateLimit).toBeNull();
      }
    });
  });

  describe("supervised", () => {
    const perms = buildPermissions("supervised");

    it("enables all tools", () => {
      for (const tool of ALL_TOOLS) {
        expect(perms.tools[tool].enabled).toBe(true);
      }
    });

    it("rate-limits deletion tools to 5", () => {
      for (const tool of TOOL_CATEGORIES.deletion.tools) {
        expect(perms.tools[tool].rateLimit).toBe(5);
      }
    });

    it("rate-limits sending tools to 20", () => {
      for (const tool of TOOL_CATEGORIES.sending.tools) {
        expect(perms.tools[tool].rateLimit).toBe(20);
      }
    });

    it("rate-limits bulk action tools to 10", () => {
      const bulkActions = TOOL_CATEGORIES.actions.tools.filter((t) =>
        t.startsWith("bulk_"),
      );
      expect(bulkActions.length).toBeGreaterThan(0);
      for (const tool of bulkActions) {
        expect(perms.tools[tool].rateLimit).toBe(10);
      }
    });
  });

  describe("send_only", () => {
    const perms = buildPermissions("send_only");

    it("enables sending tools", () => {
      for (const tool of TOOL_CATEGORIES.sending.tools) {
        expect(perms.tools[tool].enabled).toBe(true);
      }
    });

    it("enables reading tools", () => {
      for (const tool of TOOL_CATEGORIES.reading.tools) {
        expect(perms.tools[tool].enabled).toBe(true);
      }
    });

    it("enables get_folders, get_connection_status, and get_logs", () => {
      expect(perms.tools.get_folders.enabled).toBe(true);
      expect(perms.tools.get_connection_status.enabled).toBe(true);
      expect(perms.tools.get_logs.enabled).toBe(true);
    });

    it("disables deletion tools", () => {
      for (const tool of TOOL_CATEGORIES.deletion.tools) {
        expect(perms.tools[tool].enabled).toBe(false);
      }
    });

    it("disables actions tools", () => {
      for (const tool of TOOL_CATEGORIES.actions.tools) {
        expect(perms.tools[tool].enabled).toBe(false);
      }
    });
  });
});

describe("defaultConfig", () => {
  const config = defaultConfig();

  it("uses read_only preset", () => {
    expect(config.permissions.preset).toBe("read_only");
  });

  it("has correct default SMTP port", () => {
    expect(config.connection.smtpPort).toBe(1025);
  });

  it("has correct default IMAP port", () => {
    expect(config.connection.imapPort).toBe(1143);
  });
});

describe("getConfigPath", () => {
  it("returns default path when no env var is set", () => {
    const saved = process.env.PROTONMAIL_MCP_CONFIG;
    delete process.env.PROTONMAIL_MCP_CONFIG;
    try {
      expect(getConfigPath()).toBe(join(homedir(), ".protonmail-mcp.json"));
    } finally {
      if (saved !== undefined) {
        process.env.PROTONMAIL_MCP_CONFIG = saved;
      }
    }
  });

  it("respects PROTONMAIL_MCP_CONFIG env var when path is within home dir", () => {
    const saved = process.env.PROTONMAIL_MCP_CONFIG;
    const customPath = join(homedir(), "custom-config.json");
    process.env.PROTONMAIL_MCP_CONFIG = customPath;
    try {
      expect(getConfigPath()).toBe(customPath);
    } finally {
      if (saved !== undefined) {
        process.env.PROTONMAIL_MCP_CONFIG = saved;
      } else {
        delete process.env.PROTONMAIL_MCP_CONFIG;
      }
    }
  });

  it("throws when PROTONMAIL_MCP_CONFIG points outside home dir", () => {
    const saved = process.env.PROTONMAIL_MCP_CONFIG;
    process.env.PROTONMAIL_MCP_CONFIG = "/tmp/evil-config.json";
    try {
      expect(() => getConfigPath()).toThrow("must point to a path within the home directory");
    } finally {
      if (saved !== undefined) {
        process.env.PROTONMAIL_MCP_CONFIG = saved;
      } else {
        delete process.env.PROTONMAIL_MCP_CONFIG;
      }
    }
  });
});
