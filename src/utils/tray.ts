/**
 * Cross-platform tray-icon facade shared by the MCP server (src/index.ts)
 * and the standalone settings daemon (src/settings-main.ts).
 *
 * Two backends with automatic selection:
 *
 *   1. **Native** — a tauri-apps/tray-icon Rust crate wrapped via
 *      napi-rs (`native/tray/`). Renders correctly on modern GNOME
 *      (proper IconThemePath + .png file extension), macOS NSStatusBar,
 *      and Win32 Shell_NotifyIcon. Preferred when a prebuilt for the
 *      current platform is present.
 *   2. **systray2 (legacy)** — Go-binary fallback. Has a known GNOME
 *      rendering bug (3-dot ellipsis instead of the icon) but works on
 *      macOS / Windows when the native prebuilt isn't available.
 *
 * Selection is automatic in `createTray()`: try native, fall back to
 * systray2 on `require()` failure or on a `loadError`. systray2's
 * boot hygiene (chmod the binary, skip headless hosts) lives in
 * `preflightTrayBinary()` / `trayPreconditionSkip()` below — those
 * helpers are still exported for direct callers that want to gate
 * tray init themselves.
 */
import { existsSync, chmodSync } from "fs";
import { homedir } from "os";
import nodePath from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";

const _require = createRequire(import.meta.url);

// ─── Native backend (tauri-apps/tray-icon via napi-rs) ───────────────────

/**
 * Generic tray handle returned by `createTray()`. Same shape regardless
 * of which backend is in use, so callers don't branch on backend type.
 */
export interface TrayHandle {
  /**
   * Update the menu items in place.
   *
   * Native backend: real implementation — atomically swaps the menu
   * the user sees on next click.
   *
   * systray2 backend: best-effort no-op. The legacy backend's
   * stdin-protocol menu update is fragile across the systray2 Go
   * binary's restart/redraw paths, and in practice the standalone
   * settings daemon (the only systray2 user today) never mutates its
   * menu after construction. Don't rely on `setMenu()` taking effect
   * when `backend === "systray2"`; check the field if it matters.
   */
  setMenu(items: TrayItem[]): void;
  /** Replace the tray icon (PNG bytes for native; ICO on Windows for systray2). */
  setIcon(pngBytes: Buffer): void;
  /** Update the hover tooltip. */
  setTooltip(tooltip: string): void;
  /** Tear down the tray. Idempotent. */
  destroy(): void;
  /** Diagnostic label — "native" or "systray2". */
  readonly backend: "native" | "systray2";
}

export interface TrayItem {
  id: string;
  label: string;
  enabled?: boolean;
  separator?: boolean;
}

export interface CreateTrayOptions {
  /**
   * Raw PNG bytes for the icon. The native backend takes this as-is
   * and re-rasters internally for hi-DPI. The systray2 backend on
   * Windows would historically prefer a multi-resolution ICO for
   * crisp DPI scaling — supply that via `iconLegacyOverride` if you
   * need it; otherwise the same PNG is used for both backends and
   * Windows downsamples per the platform's default rules.
   */
  iconPng: Buffer;
  /**
   * Optional override sent to the systray2 backend instead of
   * `iconPng`. Use to ship a Windows multi-resolution ICO (via
   * `makeTrayIconBytes("win32")`) when you care about hi-DPI tray
   * sharpness on the legacy backend. Ignored for the native
   * backend, which only accepts PNG.
   */
  iconLegacyOverride?: Buffer;
  tooltip: string;
  items: TrayItem[];
  /** Called with the activated item's `id` whenever the user clicks. */
  onClick: (id: string) => void;
}

interface NativeTrayConstructor {
  new (
    iconPng: Buffer,
    tooltip: string,
    items: TrayItem[],
    onClick: (id: string) => void,
  ): NativeTrayInstance;
}
interface NativeTrayInstance {
  setMenu(items: TrayItem[]): void;
  setIcon(png: Buffer): void;
  setTooltip(tooltip: string): void;
  destroy(): void;
}
interface NativeTrayModule { Tray: NativeTrayConstructor }

/**
 * Try to load the native tray addon. Returns null if unavailable —
 * happens when no `.node` prebuilt for the current platform/arch is
 * present in `native/tray/`.
 *
 * Current packaging: the four committed prebuilts (linux-x64-gnu,
 * darwin-arm64, win32-x64-msvc, win32-arm64-msvc) ship inside the
 * main mailpouch npm package via `package.json`'s `files` field.
 * Targets that haven't been built yet (linux-arm64-gnu, darwin-x64)
 * fall through to the systray2 backend. A future PR may switch to
 * the napi-rs-standard pattern of one `@mailpouch/tray-native-*`
 * subpackage per target wired via `optionalDependencies` — keeping
 * the install size small for end users — but for now everything
 * lives in-tree for simpler CI plumbing.
 *
 * Module location resolution:
 *   1. `@mailpouch/tray-native` — present only if a future PR splits
 *      prebuilts into subpackages
 *   2. `../../native/tray` relative to compiled `dist/utils/tray.js`
 *      — the in-repo build (cargo + napi build produce index.js +
 *      the per-platform .node sibling)
 */
function _loadNativeTray(): NativeTrayModule | null {
  const candidates = [
    "@mailpouch/tray-native",
    // dist/utils/tray.js — go up two to reach the project root, then
    // into native/tray. Three `..` would over-shoot to /mnt/data/Code/.
    nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), "..", "..", "native", "tray"),
  ];
  for (const id of candidates) {
    try {
      const mod = _require(id) as NativeTrayModule;
      if (mod && typeof mod.Tray === "function") return mod;
    } catch { /* try the next candidate */ }
  }
  return null;
}

// ─── systray2 (legacy backend) preflight helpers ────────────────────────

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
 * Generic, backend-agnostic skip check — returns a one-line DEBUG
 * reason when the host can't show a system tray at all (headless
 * Linux with no X11/Wayland), or null when a tray is feasible.
 *
 * Use this BEFORE calling `createTray()` since it applies regardless
 * of which backend wins. The `systray2`-specific arm64 / x86_64-only
 * concerns live in `systray2PreconditionSkip` below.
 */
export function trayPreconditionSkip(
  platform: NodeJS.Platform = process.platform,
  _arch: string = process.arch,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY) {
    return "no display environment (DISPLAY / WAYLAND_DISPLAY unset) — tray skipped";
  }
  return null;
}

/**
 * systray2-specific skip check. Used by the createTray fallback path
 * to decide whether the systray2 backend is even worth attempting on
 * this host — the native backend may have already covered an arm64
 * platform that systray2 can't.
 */
export function systray2PreconditionSkip(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | null {
  if ((platform === "darwin" || platform === "linux") && arch === "arm64") {
    const bin = preflightTrayBinary(platform);
    if (!bin) {
      return `arm64 ${platform} host — systray2 ships x86_64 binaries only; tray disabled (run via Rosetta, or see systray2 upstream for arm64 builds)`;
    }
  }
  return null;
}

// ─── Unified tray facade ────────────────────────────────────────────────

/**
 * Create a system-tray icon. Picks the best available backend:
 *   1. Native (tauri-apps/tray-icon via napi-rs) when the prebuilt is
 *      installed for this platform — proper rendering on modern GNOME,
 *      retina-aware on macOS, hi-DPI on Windows.
 *   2. systray2 fallback when the native prebuilt isn't available
 *      (happens during development before CI publishes prebuilts, or
 *      on niche platforms we haven't built for).
 *
 * Throws when neither backend can be used (headless host with no
 * display, ARM Mac without Rosetta, etc.). Callers should treat the
 * tray as a nice-to-have and catch the error to log + continue
 * without it.
 */
export function createTray(opts: CreateTrayOptions): TrayHandle {
  const native = _loadNativeTray();
  if (native) {
    const inst = new native.Tray(opts.iconPng, opts.tooltip, opts.items, opts.onClick);
    return {
      backend: "native",
      setMenu: (items) => inst.setMenu(items),
      setIcon: (bytes) => inst.setIcon(bytes),
      setTooltip: (s) => inst.setTooltip(s),
      destroy: () => inst.destroy(),
    };
  }
  return _createSystray2Fallback(opts);
}

/**
 * Adapter that wraps the legacy systray2 module behind the unified
 * TrayHandle interface. Kept here (not exposed) so all the
 * platform-quirky systray2 nuances stay isolated to one file.
 */
function _createSystray2Fallback(opts: CreateTrayOptions): TrayHandle {
  // Apply systray2's boot hygiene (chmod the binary, etc.) before
  // construction. The systray2-specific arm64 / x86_64-only check
  // lives in `systray2PreconditionSkip` — if it returns a reason,
  // the systray2 backend can't start on this host.
  const skip = systray2PreconditionSkip();
  if (skip) {
    throw new Error(`Tray cannot start: ${skip}`);
  }
  preflightTrayBinary();

  // systray2 uses platform-format bytes (multi-res ICO on Windows for
  // crisp DPI scaling, PNG elsewhere). Caller can override; otherwise
  // we accept the PNG and let Windows downsample.
  const initialBytes = opts.iconLegacyOverride ?? opts.iconPng;

  type SystrayMenuItem = { title: string; tooltip: string; checked: boolean; enabled: boolean };
  type SystrayCtor = new (config: {
    menu: { icon: string; title: string; tooltip: string; items: SystrayMenuItem[] };
    debug: boolean;
    copyDir: boolean;
  }) => SystrayInst;
  interface SystrayInst {
    ready(): Promise<void>;
    onClick(cb: (action: { item: SystrayMenuItem }) => void): Promise<void>;
    sendAction(action: unknown): Promise<void>;
    kill(graceful: boolean): void;
    separator: SystrayMenuItem;
  }
  type SystrayMod = { default: SystrayCtor & { separator: SystrayMenuItem } };

  let SysTray: SystrayCtor & { separator: SystrayMenuItem };
  try {
    SysTray = (_require("systray2") as SystrayMod).default;
  } catch (e) {
    throw new Error(
      `No tray backend available: native prebuilt not installed AND systray2 not loadable (${(e as Error).message}). ` +
      `Either ship a @mailpouch/tray-native-<platform> prebuilt or install systray2 to enable the tray.`,
    );
  }

  // Map our generic items to systray2's shape. Track id↔title for the
  // click callback — systray2 dispatches by visible title, not by id.
  const titleToId = new Map<string, string>();
  const sysItems: SystrayMenuItem[] = opts.items.map((i) => {
    if (i.separator) return SysTray.separator;
    titleToId.set(i.label, i.id);
    return { title: i.label, tooltip: "", checked: false, enabled: i.enabled !== false };
  });

  // Track current icon + tooltip so partial updates (setIcon without
  // touching tooltip, or vice-versa) don't clobber the other field.
  // systray2's `update-menu` action replaces the WHOLE menu config, so
  // every send has to include both values; without local state we'd
  // revert to the original `opts.iconPng` / `opts.tooltip` on each
  // update call.
  let currentIconB64 = initialBytes.toString("base64");
  let currentTooltip = opts.tooltip;

  const tray = new SysTray({
    menu: {
      icon: currentIconB64,
      title: "",
      tooltip: currentTooltip,
      items: sysItems,
    },
    debug: false,
    copyDir: true,
  });

  tray.ready().then(() =>
    tray.onClick((action) => {
      const id = titleToId.get(action.item.title);
      if (id) opts.onClick(id);
    }),
  ).catch(() => { /* ignore — best-effort fallback */ });

  const sendUpdate = (): void => {
    void tray.sendAction({
      type: "update-menu",
      menu: { icon: currentIconB64, title: "", tooltip: currentTooltip, items: sysItems },
    });
  };

  return {
    backend: "systray2",
    setMenu: (_items) => {
      // Documented on the TrayHandle interface — silent no-op on
      // this backend. Real menu updates require a native restart of
      // the systray2 binary which the wrapper isn't set up for.
    },
    setIcon: (bytes) => {
      currentIconB64 = bytes.toString("base64");
      sendUpdate();
    },
    setTooltip: (s) => {
      currentTooltip = s;
      sendUpdate();
    },
    destroy: () => { try { tray.kill(false); } catch { /* already gone */ } },
  };
}
