import { describe, it, expect } from "vitest";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { validateSearchInput } from "./search-input.js";

const MAX = 200;

describe("validateSearchInput", () => {
  it("builds options from valid args + clamps limit", () => {
    const o = validateSearchInput({ folder: "INBOX", from: "a@x.com", subject: "hi", limit: 9999 }, MAX);
    expect(o.folder).toBe("INBOX");
    expect(o.from).toBe("a@x.com");
    expect(o.limit).toBe(MAX); // clamped to maxEmailListResults
  });

  it("defaults folder to INBOX and limit to 50", () => {
    const o = validateSearchInput({}, MAX);
    expect(o.folder).toBe("INBOX");
    expect(o.limit).toBe(50);
  });

  it("multi-folder: leaves folder undefined, validates each, allows '*'", () => {
    const o = validateSearchInput({ folders: ["INBOX", "Sent"] }, MAX);
    expect(o.folder).toBeUndefined();
    expect(o.folders).toEqual(["INBOX", "Sent"]);
    expect(() => validateSearchInput({ folders: ["*"] }, MAX)).not.toThrow();
  });

  it("scopes every effective folder for a restricted caller", () => {
    const o = validateSearchInput(
      { folder: "inbox", folders: ["INBOX", "Sent"] },
      MAX,
      ["INBOX", "Sent"],
    );

    // Multi-folder precedence remains explicit: the redundant scalar cannot
    // shrink, expand, or otherwise replace the effective folder set.
    expect(o.folder).toBeUndefined();
    expect(o.folders).toEqual(["INBOX", "Sent"]);
  });

  it("rejects disallowed, wildcard, empty, and conflicting search folders for restricted callers", () => {
    const allowed = ["INBOX"];

    expect(() => validateSearchInput({ folder: "Archive" }, MAX, allowed))
      .toThrow(/outside this agent's folder allowlist/);
    expect(() => validateSearchInput({ folders: ["INBOX", "Archive"] }, MAX, allowed))
      .toThrow(/outside this agent's folder allowlist/);
    expect(() => validateSearchInput({ folders: ["*"] }, MAX, allowed))
      .toThrow(/wildcard folder searches/);
    expect(() => validateSearchInput({ folders: ["all"] }, MAX, allowed))
      .toThrow(/wildcard folder searches/);
    expect(() => validateSearchInput({ folders: [] }, MAX, allowed))
      .toThrow(/at least one explicit search folder/);
    expect(() => validateSearchInput({ folder: "INBOX", folders: ["Sent"] }, MAX, ["INBOX", "Sent"]))
      .toThrow(/conflicts with the effective 'folders'/);
  });

  it("rejects non-array folders, non-string from, oversized subject", () => {
    expect(() => validateSearchInput({ folders: "INBOX" }, MAX)).toThrow(McpError);
    expect(() => validateSearchInput({ from: 5 }, MAX)).toThrow(/'from' filter must be a string/);
    expect(() => validateSearchInput({ subject: "x".repeat(501) }, MAX)).toThrow(/must not exceed 500/);
  });

  it("TOOL-016: rejects negative/non-finite larger/smaller", () => {
    expect(() => validateSearchInput({ larger: -1 }, MAX)).toThrow(/non-negative finite/);
    expect(() => validateSearchInput({ smaller: Infinity }, MAX)).toThrow(/non-negative finite/);
  });

  it("TOOL-017: rejects unparseable sentBefore/sentSince; accepts valid", () => {
    expect(() => validateSearchInput({ sentBefore: {} }, MAX)).toThrow(/parseable date string/);
    const o = validateSearchInput({ sentSince: "2026-06-01" }, MAX);
    expect(o.sentSince).toBeInstanceOf(Date);
  });

  it("rejects dateFrom later than dateTo", () => {
    expect(() => validateSearchInput({ dateFrom: "2026-06-10", dateTo: "2026-06-01" }, MAX))
      .toThrow(/must not be later than/);
  });

  it("VALID-002: rejects non-string body/text/bcc filters", () => {
    expect(() => validateSearchInput({ body: 123 }, MAX)).toThrow(/'body' filter must be a string/);
    expect(() => validateSearchInput({ text: {} }, MAX)).toThrow(/'text' filter must be a string/);
    expect(() => validateSearchInput({ bcc: [] }, MAX)).toThrow(/'bcc' filter must be a string/);
    const o = validateSearchInput({ body: "hello" }, MAX);
    expect(o.body).toBe("hello");
  });

  it("TOOL-017: rejects unparseable dateFrom/dateTo; accepts valid", () => {
    expect(() => validateSearchInput({ dateFrom: "not-a-date" }, MAX)).toThrow(/parseable date string/);
    expect(() => validateSearchInput({ dateTo: "garbage" }, MAX)).toThrow(/parseable date string/);
    expect(() => validateSearchInput({ dateFrom: 1234 }, MAX)).toThrow(/parseable date string/);
    const o = validateSearchInput({ dateFrom: "2026-06-01", dateTo: "2026-06-10" }, MAX);
    expect(o.dateFrom).toBe("2026-06-01");
    expect(o.dateTo).toBe("2026-06-10");
  });
});
