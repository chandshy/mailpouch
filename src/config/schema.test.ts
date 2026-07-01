import { describe, it, expect } from "vitest";
import {
  ALL_TOOLS,
  TOOL_CATEGORIES,
  DESTRUCTIVE_TOOLS,
  DESTRUCTIVE_DESTINATIONS,
  MOVE_TOOLS_WITH_DESTRUCTIVE_TARGET,
  TOOL_ALIASES,
  canonicalToolName,
  CONFIG_VERSION,
  DEFAULT_RESPONSE_LIMITS,
  toolsForTier,
  parseToolTier,
  ALWAYS_AVAILABLE_TOOLS,
} from "./schema.js";

describe("ALL_TOOLS", () => {
  it("has exactly 77 entries", () => {
    expect(ALL_TOOLS).toHaveLength(77);
  });

  it("contains no duplicates", () => {
    const unique = new Set(ALL_TOOLS);
    expect(unique.size).toBe(ALL_TOOLS.length);
  });

  it("includes specific expected tools", () => {
    const tools = new Set<string>(ALL_TOOLS);
    expect(tools.has("forward_email")).toBe(true);
    expect(tools.has("bulk_mark_read")).toBe(true);
    expect(tools.has("bulk_delete")).toBe(true);
    expect(tools.has("list_labels")).toBe(true);
    expect(tools.has("get_emails_by_label")).toBe(true);
    expect(tools.has("remove_label")).toBe(true);
    expect(tools.has("bulk_remove_label")).toBe(true);
    expect(tools.has("move_to_trash")).toBe(true);
    expect(tools.has("move_to_spam")).toBe(true);
    expect(tools.has("move_to_folder")).toBe(true);
    expect(tools.has("bulk_star")).toBe(true);
  });
});

describe("TOOL_CATEGORIES", () => {
  it("has exactly 11 categories", () => {
    expect(Object.keys(TOOL_CATEGORIES)).toHaveLength(11);
  });

  it("has the expected category names", () => {
    const keys = Object.keys(TOOL_CATEGORIES).sort();
    expect(keys).toEqual(
      ["actions", "aliases", "analytics", "bridge_control", "deletion", "drafts", "folders", "pass", "reading", "sending", "system"].sort(),
    );
  });

  it("every tool in ALL_TOOLS appears in exactly one category", () => {
    const toolToCategory = new Map<string, string>();
    for (const [cat, def] of Object.entries(TOOL_CATEGORIES)) {
      for (const tool of def.tools) {
        expect(toolToCategory.has(tool)).toBe(false); // no duplicates across categories
        toolToCategory.set(tool, cat);
      }
    }
    for (const tool of ALL_TOOLS) {
      expect(toolToCategory.has(tool)).toBe(true);
    }
  });

  it("every tool in TOOL_CATEGORIES is in ALL_TOOLS", () => {
    const allSet = new Set<string>(ALL_TOOLS);
    for (const def of Object.values(TOOL_CATEGORIES)) {
      for (const tool of def.tools) {
        expect(allSet.has(tool)).toBe(true);
      }
    }
  });

  it("has correct risk levels", () => {
    expect(TOOL_CATEGORIES.sending.risk).toBe("moderate");
    expect(TOOL_CATEGORIES.drafts.risk).toBe("moderate");
    expect(TOOL_CATEGORIES.reading.risk).toBe("safe");
    expect(TOOL_CATEGORIES.folders.risk).toBe("moderate");
    expect(TOOL_CATEGORIES.actions.risk).toBe("moderate");
    expect(TOOL_CATEGORIES.deletion.risk).toBe("destructive");
    expect(TOOL_CATEGORIES.analytics.risk).toBe("safe");
    expect(TOOL_CATEGORIES.system.risk).toBe("safe");
  });
});

describe("DESTRUCTIVE_TOOLS", () => {
  it("includes deletion, trash, spam, alias_delete, pass_get, and server lifecycle tools", () => {
    expect(DESTRUCTIVE_TOOLS.has("delete_email")).toBe(true);
    expect(DESTRUCTIVE_TOOLS.has("bulk_delete")).toBe(true);
    expect(DESTRUCTIVE_TOOLS.has("bulk_delete_emails")).toBe(true);
    expect(DESTRUCTIVE_TOOLS.has("delete_folder")).toBe(true);
    expect(DESTRUCTIVE_TOOLS.has("move_to_trash")).toBe(true);
    expect(DESTRUCTIVE_TOOLS.has("move_to_spam")).toBe(true);
    expect(DESTRUCTIVE_TOOLS.has("alias_delete")).toBe(true);
    expect(DESTRUCTIVE_TOOLS.has("pass_get")).toBe(true);
    expect(DESTRUCTIVE_TOOLS.has("shutdown_server")).toBe(true);
    expect(DESTRUCTIVE_TOOLS.has("restart_server")).toBe(true);
  });

  it("every DESTRUCTIVE_TOOL is in ALL_TOOLS", () => {
    const allSet = new Set<string>(ALL_TOOLS);
    for (const tool of DESTRUCTIVE_TOOLS) {
      expect(allSet.has(tool)).toBe(true);
    }
  });
});

describe("CONFIG_VERSION", () => {
  it("is 3", () => {
    expect(CONFIG_VERSION).toBe(3);
  });
});

describe("DEFAULT_RESPONSE_LIMITS", () => {
  it("has all required fields", () => {
    expect(DEFAULT_RESPONSE_LIMITS).toHaveProperty("maxResponseBytes");
    expect(DEFAULT_RESPONSE_LIMITS).toHaveProperty("maxEmailBodyChars");
    expect(DEFAULT_RESPONSE_LIMITS).toHaveProperty("maxEmailListResults");
    expect(DEFAULT_RESPONSE_LIMITS).toHaveProperty("maxAttachmentBytes");
    expect(DEFAULT_RESPONSE_LIMITS).toHaveProperty("warnOnLargeResponse");
  });

  it("maxResponseBytes is below the 1 MB client limit", () => {
    expect(DEFAULT_RESPONSE_LIMITS.maxResponseBytes).toBeLessThan(1_048_576);
    expect(DEFAULT_RESPONSE_LIMITS.maxResponseBytes).toBeGreaterThan(0);
  });

  it("maxEmailListResults is within the pagination ceiling", () => {
    expect(DEFAULT_RESPONSE_LIMITS.maxEmailListResults).toBeGreaterThanOrEqual(1);
    expect(DEFAULT_RESPONSE_LIMITS.maxEmailListResults).toBeLessThanOrEqual(200);
  });

  it("maxAttachmentBytes stays under the response ceiling", () => {
    expect(DEFAULT_RESPONSE_LIMITS.maxAttachmentBytes).toBeLessThanOrEqual(
      DEFAULT_RESPONSE_LIMITS.maxResponseBytes,
    );
  });

  it("warnOnLargeResponse defaults to true", () => {
    expect(DEFAULT_RESPONSE_LIMITS.warnOnLargeResponse).toBe(true);
  });
});

describe("Tool tiering", () => {
  describe("toolsForTier", () => {
    it("'core' returns only reading/sending/analytics/system tools + always-available ones", () => {
      const core = toolsForTier("core");
      expect(core.has("get_emails")).toBe(true);          // reading
      expect(core.has("send_email")).toBe(true);          // sending
      expect(core.has("get_email_stats")).toBe(true);     // analytics
      expect(core.has("get_connection_status")).toBe(true); // system
      expect(core.has("request_permission_escalation")).toBe(true); // always available
      expect(core.has("setup_status")).toBe(true);          // always available (CALL FIRST diagnostic)
      // Not in core:
      expect(core.has("delete_email")).toBe(false);       // deletion → complete
      expect(core.has("save_draft")).toBe(false);         // drafts → extended
      expect(core.has("create_folder")).toBe(false);      // folders → extended
      expect(core.has("start_bridge")).toBe(false);       // bridge_control → complete
    });

    it("'extended' adds drafts, folders, and actions to core", () => {
      const ext = toolsForTier("extended");
      expect(ext.has("save_draft")).toBe(true);
      expect(ext.has("create_folder")).toBe(true);
      expect(ext.has("mark_email_read")).toBe(true);
      expect(ext.has("move_to_trash")).toBe(true);
      // Still not extended: deletion / bridge control
      expect(ext.has("delete_email")).toBe(false);
      expect(ext.has("shutdown_server")).toBe(false);
    });

    it("'complete' exposes every tool in every registered category", () => {
      const full = toolsForTier("complete");
      for (const def of Object.values(TOOL_CATEGORIES)) {
        for (const tool of def.tools) {
          expect(full.has(tool)).toBe(true);
        }
      }
      for (const always of ALWAYS_AVAILABLE_TOOLS) {
        expect(full.has(always)).toBe(true);
      }
    });

    it("core tier is strictly smaller than extended; extended is strictly smaller than complete", () => {
      const core = toolsForTier("core");
      const ext = toolsForTier("extended");
      const full = toolsForTier("complete");
      expect(core.size).toBeLessThan(ext.size);
      expect(ext.size).toBeLessThan(full.size);
    });
  });

  describe("parseToolTier", () => {
    it("accepts the three known tier strings", () => {
      expect(parseToolTier("core")).toBe("core");
      expect(parseToolTier("extended")).toBe("extended");
      expect(parseToolTier("complete")).toBe("complete");
    });

    it("defaults to 'complete' for unknown, null, or undefined input", () => {
      expect(parseToolTier("bogus")).toBe("complete");
      expect(parseToolTier(undefined)).toBe("complete");
      expect(parseToolTier(null)).toBe("complete");
      expect(parseToolTier(42)).toBe("complete");
    });
  });
});

describe("PERM-003 tool aliases", () => {
  it("canonicalToolName resolves bulk_delete to bulk_delete_emails", () => {
    expect(canonicalToolName("bulk_delete")).toBe("bulk_delete_emails");
  });

  it("canonicalToolName is identity for unknown tool names", () => {
    expect(canonicalToolName("send_email")).toBe("send_email");
    expect(canonicalToolName("get_emails")).toBe("get_emails");
  });

  it("TOOL_ALIASES values are themselves real tools (no dangling aliases)", () => {
    for (const canonical of Object.values(TOOL_ALIASES)) {
      expect(ALL_TOOLS).toContain(canonical);
    }
  });
});

describe("PERM-004 move-to-destructive destinations", () => {
  it("MOVE_TOOLS_WITH_DESTRUCTIVE_TARGET names the three movers", () => {
    expect(MOVE_TOOLS_WITH_DESTRUCTIVE_TARGET.has("move_email")).toBe(true);
    expect(MOVE_TOOLS_WITH_DESTRUCTIVE_TARGET.has("bulk_move_emails")).toBe(true);
    expect(MOVE_TOOLS_WITH_DESTRUCTIVE_TARGET.has("move_to_folder")).toBe(true);
  });

  it("DESTRUCTIVE_DESTINATIONS is lowercase for case-insensitive comparison", () => {
    expect(DESTRUCTIVE_DESTINATIONS.has("trash")).toBe(true);
    expect(DESTRUCTIVE_DESTINATIONS.has("spam")).toBe(true);
    // The set stores lowercase; the gate calls .toLowerCase() on the arg.
    expect(DESTRUCTIVE_DESTINATIONS.has("Trash")).toBe(false);
    expect(DESTRUCTIVE_DESTINATIONS.has("Spam")).toBe(false);
  });

  it("every mover is in ALL_TOOLS (the gate should match against real tool names)", () => {
    for (const t of MOVE_TOOLS_WITH_DESTRUCTIVE_TARGET) {
      expect(ALL_TOOLS).toContain(t);
    }
  });
});
