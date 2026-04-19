/**
 * Cross-platform tray-icon preflight helpers shared by the MCP server
 * (src/index.ts) and the standalone settings daemon (src/settings-main.ts).
 *
 * The native systray2 runtime has two known footguns that every tray
 * entry point has to guard against on every boot:
 *
 *   1. The binaries ship at mode 0644 inside the npm tarball, so
 *      `spawn()` on Linux/macOS fails with EACCES. systray2's own
 *      attempt to chmod uses fs-extra's `chmod(path, '+x')` — a string
 *      mode that modern fs-extra treats as a no-op.
 *   2. systray2 copies the binary to `~/.cache/node-systray/<version>/`
 *      and executes from there, so chmoding only the source in
 *      `node_modules/` doesn't help on subsequent runs — the cache copy
 *      keeps the mode it was at when systray2 copied it.
 *
 * `preflightTrayBinary()` fixes both. `trayPreconditionSkip()` returns
 * a one-line reason when the host can't show a tray at all (headless
 * Linux, arm64 without a matching binary) so the caller can skip the
 * spawn and log DEBUG rather than emit a scary WARN.
 */
import { existsSync, chmodSync } from "fs";
import { homedir } from "os";
import nodePath from "path";
import { createRequire } from "module";

const _require = createRequire(import.meta.url);

function _binaryBasename(platform: NodeJS.Platform): string {
  return platform === "win32"  ? "tray_windows_release.exe"
       : platform === "darwin" ? "tray_darwin_release"
       :                         "tray_linux_release";
}

/**
 * Resolve + chmod 0755 the systray2 native binary in both possible
 * locations (package source, runtime cache). Idempotent; no-op on
 * Windows. Returns the source path inside node_modules, or null when
 * systray2 isn't installed / isn't resolvable.
 */
export function preflightTrayBinary(platform: NodeJS.Platform = process.platform): string | null {
  const basename = _binaryBasename(platform);
  let resolvedSource: string | null = null;
  try {
    const moduleDir = nodePath.dirname(_require.resolve("systray2/package.json"));
    const srcPath = nodePath.join(moduleDir, "traybin", basename);
    if (existsSync(srcPath)) {
      resolvedSource = srcPath;
      if (platform !== "win32") {
        try { chmodSync(srcPath, 0o755); } catch { /* non-fatal */ }
      }
    }
  } catch { /* systray2 not installed */ }
  if (platform !== "win32") {
    try {
      const pkg = _require("systray2/package.json") as { version?: string };
      const version = pkg.version ?? "0";
      const cachePath = nodePath.join(
        homedir(), ".cache", "node-systray", version, basename,
      );
      if (existsSync(cachePath)) {
        try { chmodSync(cachePath, 0o755); } catch { /* non-fatal */ }
      }
    } catch { /* non-fatal */ }
  }
  return resolvedSource;
}

/**
 * Return a one-line DEBUG reason to skip tray startup, or null if the
 * host looks capable. Callers should log the reason and return before
 * spawning systray2 to avoid blocked reads / scary WARNs on headless
 * hosts.
 */
export function trayPreconditionSkip(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY) {
    return "no display environment (DISPLAY / WAYLAND_DISPLAY unset) — tray skipped";
  }
  if ((platform === "darwin" || platform === "linux") && arch === "arm64") {
    const bin = preflightTrayBinary(platform);
    if (!bin) {
      return `arm64 ${platform} host — systray2 ships x86_64 binaries only; tray disabled (run via Rosetta, or see systray2 upstream for arm64 builds)`;
    }
  }
  return null;
}
