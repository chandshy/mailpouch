/**
 * Native desktop notifications by shelling out to per-platform binaries.
 *
 * No external dependency: the industry-standard `node-notifier` is
 * effectively abandoned (last publish April 2022), and its active fork
 * `toasted-notifier` does what this file does — subprocess to platform
 * tools — with similar footprint. Rolling our own keeps the surface tight
 * and makes the shell-escape behavior explicit.
 *
 * Platform matrix (April 2026):
 *
 *   macOS   → `osascript -e 'display notification …'`. Universal since
 *             10.8. No action buttons (AppleScript limitation).
 *   Linux   → `notify-send` (libnotify). Installed by default on most
 *             modern DEs; absent on minimal containers / WSL. We degrade
 *             to a log warning.
 *   Windows → `powershell.exe` invoking the built-in `[Windows.UI.Notifications]`
 *             WinRT API. No module install required on Win10+.
 *
 * All calls are fire-and-forget — a failed notifier should never break
 * the caller. Errors are logged at debug.
 */

import { spawn } from "child_process";
import { logger } from "../utils/logger.js";

export interface DesktopNotification {
  title: string;
  body: string;
  /** Optional subtitle shown under the title (macOS only). */
  subtitle?: string;
  /**
   * Sound name. macOS: system sound (e.g. "Glass", "Ping"). Linux:
   * ignored. Windows: true/false to enable default sound. Undefined
   * suppresses sound on platforms that support it.
   */
  sound?: boolean | string;
}

/** Escape a string for inclusion in an AppleScript double-quoted literal. */
function escAppleScript(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** PowerShell single-quoted literal: double internal single quotes. */
function escPowerShell(s: string): string {
  return s.replace(/'/g, "''");
}

export interface DesktopNotifierDeps {
  /** Inject the current platform — used for tests. */
  platform?: NodeJS.Platform;
  /** Inject the subprocess runner — used for tests to assert the command. */
  runner?: (cmd: string, args: string[]) => Promise<{ code: number }>;
}

function defaultRunner(cmd: string, args: string[]): Promise<{ code: number }> {
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: "ignore", detached: false });
      child.on("error", () => resolve({ code: -1 }));
      child.on("close", (code) => resolve({ code: code ?? 0 }));
    } catch {
      resolve({ code: -1 });
    }
  });
}

export class DesktopNotifier {
  private readonly platform: NodeJS.Platform;
  private readonly run: (cmd: string, args: string[]) => Promise<{ code: number }>;

  constructor(deps: DesktopNotifierDeps = {}) {
    this.platform = deps.platform ?? process.platform;
    this.run = deps.runner ?? defaultRunner;
  }

  /** Dispatch a notification. Resolves when the subprocess exits (fast). */
  async notify(n: DesktopNotification): Promise<{ ok: boolean; platform: string; reason?: string }> {
    try {
      if (this.platform === "darwin") return await this.notifyMac(n);
      if (this.platform === "linux")  return await this.notifyLinux(n);
      if (this.platform === "win32")  return await this.notifyWindows(n);
      return { ok: false, platform: this.platform, reason: "unsupported_platform" };
    } catch (err) {
      logger.debug("DesktopNotifier dispatch failed", "DesktopNotifier", err);
      return { ok: false, platform: this.platform, reason: (err as Error).message };
    }
  }

  private async notifyMac(n: DesktopNotification): Promise<{ ok: boolean; platform: string; reason?: string }> {
    // AppleScript: display notification "body" with title "title" [subtitle "sub"] [sound name "name"]
    let script = `display notification "${escAppleScript(n.body)}" with title "${escAppleScript(n.title)}"`;
    if (n.subtitle) script += ` subtitle "${escAppleScript(n.subtitle)}"`;
    if (typeof n.sound === "string") script += ` sound name "${escAppleScript(n.sound)}"`;
    const { code } = await this.run("osascript", ["-e", script]);
    return code === 0 ? { ok: true, platform: "darwin" } : { ok: false, platform: "darwin", reason: `osascript exit ${code}` };
  }

  private async notifyLinux(n: DesktopNotification): Promise<{ ok: boolean; platform: string; reason?: string }> {
    const args: string[] = ["--app-name=mailpouch"];
    if (n.subtitle) {
      // notify-send doesn't have a subtitle; fold it into the body.
      args.push(n.title, `${n.subtitle}\n\n${n.body}`);
    } else {
      args.push(n.title, n.body);
    }
    const { code } = await this.run("notify-send", args);
    if (code === 0) return { ok: true, platform: "linux" };
    if (code === -1) return { ok: false, platform: "linux", reason: "notify-send not available (libnotify not installed?)" };
    return { ok: false, platform: "linux", reason: `notify-send exit ${code}` };
  }

  private async notifyWindows(n: DesktopNotification): Promise<{ ok: boolean; platform: string; reason?: string }> {
    // Inline PowerShell script uses the built-in WinRT toast API. No
    // module install required on Windows 10+; the AppID is fine as a
    // generic label since we don't care about Action Center grouping
    // for a single mailpouch deployment.
    const xml =
      `<toast><visual><binding template='ToastGeneric'>` +
      `<text>${n.title}</text>` +
      (n.subtitle ? `<text>${n.subtitle}</text>` : "") +
      `<text>${n.body}</text>` +
      `</binding></visual>` +
      (n.sound === false ? `<audio silent='true'/>` : "") +
      `</toast>`;
    const ps =
      `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null;` +
      `$x = New-Object Windows.Data.Xml.Dom.XmlDocument;` +
      `$x.LoadXml('${escPowerShell(xml)}');` +
      `$t = [Windows.UI.Notifications.ToastNotification]::new($x);` +
      `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('mailpouch').Show($t);`;
    const { code } = await this.run("powershell.exe", ["-NoProfile", "-Command", ps]);
    return code === 0 ? { ok: true, platform: "win32" } : { ok: false, platform: "win32", reason: `powershell exit ${code}` };
  }
}
