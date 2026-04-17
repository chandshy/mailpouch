import { describe, it, expect } from "vitest";
import {
  ALL_TOOLS,
  TOOL_CATEGORIES,
  CONFIG_VERSION,
  DEFAULT_RESPONSE_LIMITS,
  toolsForTier,
  parseToolTier,
  ALWAYS_AVAILABLE_TOOLS,
} from "./schema.js";

describe("ALL_TOOLS", () => {
  it("has exactly 49 entries", () => {
    expect(ALL_TOOLS).toHaveLength(49);
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
  it("has exactly 9 categories", () => {
    expect(Object.keys(TOOL_CATEGORIES)).toHaveLength(9);
  });

  it("has the expected category names", () => {
    const keys = Object.keys(TOOL_CATEGORIES).sort();
    expect(keys).toEqual(
      ["actions", "analytics", "bridge_control", "deletion", "drafts", "folders", "reading", "sending", "system"].sort(),
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

describe("CONFIG_VERSION", () => {
  it("is 2", () => {
    expect(CONFIG_VERSION).toBe(2);
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
