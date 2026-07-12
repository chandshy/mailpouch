import { homedir } from "os";
import nodePath from "path";
import { createHash } from "crypto";
import { chmodSync, mkdirSync, realpathSync } from "fs";

/**
 * Resolve symlinks in a path, or in its deepest existing parent.
 *
 * This intentionally mirrors config-loader's path canonicalization without
 * importing it: loader depends on home-path consumers indirectly, so an import
 * here would create a circular startup dependency. Resolving a parent also
 * keeps a new config file below a symlinked directory in the same profile
 * before and after its first save.
 */
function canonicalizePathOrExistingParent(path: string): string {
  let ancestor = nodePath.resolve(nodePath.normalize(path));
  const suffix: string[] = [];

  while (true) {
    try {
      return nodePath.join(realpathSync(ancestor), ...suffix);
    } catch {
      const parent = nodePath.dirname(ancestor);
      if (parent === ancestor) return ancestor;
      suffix.unshift(nodePath.basename(ancestor));
      ancestor = parent;
    }
  }
}

/**
 * Resolve a runtime data-file path under $HOME, with an optional env-var
 * override. CRED-002 (audit 2026-05-28): the override path is resolved
 * and required to stay within $HOME, mirroring `getConfigPath()`'s
 * containment check in src/config/loader.ts. Without this, env-driven
 * path traversal (e.g. `MAILPOUCH_PASS_AUDIT=../../etc/cron.d/foo`) would
 * redirect credential-bearing writes outside the home directory.
 *
 * Throws on a bad override path so callers fail loudly at startup rather
 * than silently writing into attacker-controlled locations.
 */
export function homeFile(envName: string, basename: string): string {
  const envPath = process.env[envName];
  if (envPath) {
    const resolved = nodePath.resolve(nodePath.normalize(envPath));
    const home = homedir();
    if (!resolved.startsWith(home + nodePath.sep) && resolved !== home) {
      throw new Error(
        `${envName} must point to a path within the home directory (${home}). Got: ${resolved}`
      );
    }
    return resolved;
  }
  return nodePath.join(homedir(), basename);
}

/**
 * Resolve state that belongs to one configuration profile.
 *
 * A custom `MAILPOUCH_CONFIG` can run beside the default profile (and has its
 * own singleton lock).  Reusing global scheduler, reminder, FTS, OAuth, and
 * agent files in that case lets one profile treat the other's account IDs as
 * stale and overwrite or quarantine its state.  Keep the historic filenames
 * for the default profile, while custom profiles receive an opaque directory
 * derived from their resolved config path.  Explicit data-file overrides keep
 * their documented exact-path semantics.
 */
export function profileHomeFile(envName: string, basename: string, configPath: string): string {
  if (process.env[envName]) return homeFile(envName, basename);

  const home = homedir();
  // getConfigPath() returns a physical path. Compare it to the physical
  // default path too, so a default config symlink (or a symlinked $HOME) keeps
  // using the historic global state filenames instead of silently moving into
  // a custom-profile hash directory. Keep the returned legacy filename under
  // the normal $HOME spelling for compatibility with existing installs.
  const resolvedConfig = canonicalizePathOrExistingParent(configPath);
  const defaultConfig = canonicalizePathOrExistingParent(nodePath.join(home, ".mailpouch.json"));
  if (resolvedConfig === defaultConfig) return nodePath.join(home, basename);

  const profileHash = createHash("sha256")
    .update(resolvedConfig)
    .digest("hex")
    .slice(0, 24);
  return nodePath.join(home, ".mailpouch-profiles", profileHash, basename);
}

/** Ensure a profile-state parent directory cannot be read by other users. */
export function ensurePrivateParentDirectory(filePath: string): void {
  const dir = nodePath.dirname(filePath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* best effort on platforms without POSIX modes */ }
}
