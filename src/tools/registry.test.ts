/**
 * Registry-level invariants. The wrapper applied in `allToolDefs()` widens
 * every served tool's inputSchema with an optional `account_id` field so
 * strict-schema MCP clients can reach the per-call multi-account routing
 * added in B1 (PR #60, shipped via PR #63).
 */

import { describe, it, expect } from "vitest";

import {
  ALL_TOOLS,
  ALWAYS_AVAILABLE_TOOLS,
  DESTRUCTIVE_TOOLS,
  MOVE_TOOLS_WITH_DESTRUCTIVE_TARGET,
} from "../config/schema.js";
import { allToolDefs, advertisedToolDefs } from "./registry.js";

interface SchemaShape {
  type?: string;
  properties?: Record<string, { type?: string; description?: string }>;
  required?: string[];
}

describe("allToolDefs — account_id surface", () => {
  const defs = allToolDefs();

  it("returns a non-empty registry", () => {
    expect(defs.length).toBeGreaterThan(0);
  });

  it("every tool advertises an optional account_id of type string", () => {
    const offenders: string[] = [];
    for (const def of defs) {
      const schema = (def.inputSchema ?? {}) as SchemaShape;
      const field = schema.properties?.account_id;
      if (!field || field.type !== "string") {
        offenders.push(def.name);
      }
    }
    expect(offenders, `tools missing account_id: ${offenders.join(", ")}`).toEqual([]);
  });

  it("does not add account_id to the required list (it must stay optional)", () => {
    const offenders: string[] = [];
    for (const def of defs) {
      const schema = (def.inputSchema ?? {}) as SchemaShape;
      if (schema.required?.includes("account_id")) {
        offenders.push(def.name);
      }
    }
    expect(offenders, `tools wrongly require account_id: ${offenders.join(", ")}`).toEqual([]);
  });

  it("preserves pre-existing per-tool inputSchema properties (e.g. folder, limit)", () => {
    // get_emails carries several fields — confirm the wrapper widened rather than replaced.
    const getEmails = defs.find((d) => d.name === "get_emails");
    expect(getEmails, "get_emails missing from registry").toBeDefined();
    const schema = (getEmails!.inputSchema ?? {}) as SchemaShape;
    expect(schema.properties?.folder).toBeDefined();
    expect(schema.properties?.limit).toBeDefined();
    expect(schema.properties?.account_id).toBeDefined();
  });

  it("widens previously-empty schemas (get_folders has no other properties)", () => {
    const getFolders = defs.find((d) => d.name === "get_folders");
    expect(getFolders, "get_folders missing from registry").toBeDefined();
    const schema = (getFolders!.inputSchema ?? {}) as SchemaShape;
    expect(Object.keys(schema.properties ?? {})).toEqual(["account_id"]);
  });

  it("contains every canonical and always-available tool exactly once", () => {
    const names = defs.map((def) => def.name);
    expect(new Set(names).size).toBe(names.length);
    expect(new Set(names)).toEqual(new Set([...ALL_TOOLS, ...ALWAYS_AVAILABLE_TOOLS]));
  });

  it("adds a confirmation field to every confirmation-gated definition", () => {
    const confirmationGated = new Set([...DESTRUCTIVE_TOOLS, ...MOVE_TOOLS_WITH_DESTRUCTIVE_TARGET]);
    for (const def of defs.filter((item) => confirmationGated.has(item.name))) {
      const schema = (def.inputSchema ?? {}) as SchemaShape;
      expect(schema.properties?.confirmed, `${def.name} is missing confirmed`).toMatchObject({ type: "boolean" });
    }
  });
});

describe("advertisedToolDefs — optional companions", () => {
  it("omits unconfigured SimpleLogin and Proton Pass tools", () => {
    const names = advertisedToolDefs({ simpleLogin: false, pass: false }).map((def) => def.name);
    expect(names.some((name) => name.startsWith("alias_"))).toBe(false);
    expect(names.some((name) => name.startsWith("pass_"))).toBe(false);
  });

  it("includes companions once configured", () => {
    const names = advertisedToolDefs({ simpleLogin: true, pass: true }).map((def) => def.name);
    expect(names).toContain("alias_list");
    expect(names).toContain("pass_list");
    expect(names).toHaveLength(86);
  });
});
