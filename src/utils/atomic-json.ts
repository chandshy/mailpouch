import { randomBytes } from "crypto";
import { renameSync, unlinkSync, writeFileSync } from "fs";

/** Write JSON through a same-directory, owner-only temporary file. */
export function writeOwnerOnlyJsonAtomically(path: string, value: unknown): void {
  const tmp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: "utf-8", mode: 0o600 });
    renameSync(tmp, path);
  } finally {
    // rename removes the source on success. On any write/rename failure, do
    // not leave a credential-bearing temporary sibling behind.
    try { unlinkSync(tmp); } catch { /* already renamed or never created */ }
  }
}
