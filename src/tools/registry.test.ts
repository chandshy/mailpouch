/**
 * Registry-level invariants. The wrapper applied in `allToolDefs()` widens
 * every served tool's inputSchema with an optional `account_id` field so
 * strict-schema MCP clients can reach the per-call multi-account routing
 * added in B1 (PR #60, shipped via PR #63).
 */

import { describe, it, expect } from "vitest";

import { allToolDefs } from "./registry.js";

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
});
