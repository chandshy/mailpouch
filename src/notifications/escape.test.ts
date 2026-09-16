import { describe, expect, it } from "vitest";
import { escAppleScript, escPowerShell } from "./escape.js";

describe("escPowerShell", () => {
  it.each(["'", "‘", "’", "‚", "‛"])("doubles single-quote delimiter %s", (q) => {
    expect(escPowerShell(`a${q}b`)).toBe(`a${q}${q}b`);
  });

  it("leaves no unpaired quote delimiter in a smart-quote breakout payload", () => {
    const escaped = escPowerShell("x’);Start-Process calc;(‘");
    // Inside a single-quoted literal every delimiter must appear in pairs.
    for (const run of escaped.match(/['‘’‚‛]+/g) ?? []) {
      expect(run.length % 2).toBe(0);
    }
  });

  it("strips control characters", () => {
    expect(escPowerShell("a\nb\x00c")).toBe("a b c");
  });
});

describe("escAppleScript", () => {
  it("escapes backslash and double quote and strips control characters", () => {
    expect(escAppleScript('a\\b"c\nd')).toBe('a\\\\b\\"c d');
  });
});
