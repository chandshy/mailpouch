import { mkdtempSync, readFileSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";

import { writeOwnerOnlyJsonAtomically } from "./atomic-json.js";

let dir: string | undefined;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("writeOwnerOnlyJsonAtomically", () => {
  it("replaces the target without leaving a temporary file", () => {
    dir = mkdtempSync(join(tmpdir(), "mailpouch-atomic-json-"));
    const path = join(dir, "state.json");

    writeOwnerOnlyJsonAtomically(path, { enabled: true, count: 2 });

    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ enabled: true, count: 2 });
    expect(readdirSync(dir)).toEqual(["state.json"]);
  });
});
