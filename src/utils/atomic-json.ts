import { randomBytes } from "crypto";
import { renameSync, writeFileSync } from "fs";

/** Write JSON through a same-directory, owner-only temporary file. */
export function writeOwnerOnlyJsonAtomically(path: string, value: unknown): void {
  const tmp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: "utf-8", mode: 0o600 });
  renameSync(tmp, path);
}
