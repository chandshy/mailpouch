import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { expectedReleaseTag, validateReleaseRef } from "../scripts/lib/release-ref.mjs";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

describe("release ref validation", () => {
  it("derives the only accepted tag from package.version", () => {
    expect(expectedReleaseTag("3.2.0")).toBe("v3.2.0");
  });

  it("rejects a branch-like or mismatched release ref", () => {
    expect(() => validateReleaseRef({
      tag: "main",
      version: "3.2.0",
      headSha: SHA_A,
      tagSha: SHA_A,
    })).toThrow(/does not match package version/);
    expect(() => validateReleaseRef({
      tag: "v3.1.0",
      version: "3.2.0",
      headSha: SHA_A,
      tagSha: SHA_A,
    })).toThrow(/does not match package version/);
  });

  it("rejects a validly named tag pointing at another commit", () => {
    expect(() => validateReleaseRef({
      tag: "v3.2.0",
      version: "3.2.0",
      headSha: SHA_A,
      tagSha: SHA_B,
    })).toThrow(/does not point at the checked-out commit/);
  });

  it("accepts only the matching package tag at HEAD", () => {
    expect(validateReleaseRef({
      tag: "v3.2.0",
      version: "3.2.0",
      headSha: SHA_A,
      tagSha: SHA_A,
    })).toBe("v3.2.0");
  });

  it("keeps the event tag out of shell source and publishes the verified immutable SHA", () => {
    const workflow = readFileSync(".github/workflows/publish.yml", "utf8");
    const tagExpression = "${{ github.event.release.tag_name || inputs.release_tag }}";
    const expressionLines = workflow
      .split("\n")
      .filter(line => line.includes(tagExpression))
      .map(line => line.trim());

    // The mutable tag is data only: checkout resolves it once and the checker
    // receives it through env, where shell metacharacters cannot become code.
    expect(expressionLines).toEqual([
      `ref: ${tagExpression}`,
      `RELEASE_TAG: ${tagExpression}`,
    ]);
    expect(workflow).toContain('node scripts/check-release-ref.mjs "$RELEASE_TAG"');
    expect(workflow).toContain('echo "commit_sha=$(git rev-parse HEAD)" >> "$GITHUB_OUTPUT"');

    // Both publishers consume the commit proven by verify-release. Re-reading
    // the tag in either job would reopen a force-move TOCTOU window.
    const immutableCheckout = "ref: ${{ needs.verify-release.outputs.commit_sha }}";
    expect(workflow.split(immutableCheckout)).toHaveLength(3);
    expect(workflow).toContain("commit_sha: ${{ steps.release_ref.outputs.commit_sha }}");
  });
});
