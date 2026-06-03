/**
 * Native on-screen approval dialog (Approve / Deny) shown on the machine where
 * mailpouch runs — so the operator can decide right at the screen instead of
 * going to the Agents tab in a browser. Shells out to a per-platform dialog
 * tool, exactly like DesktopNotifier, with no external dependency.
 *
 * Platform matrix:
 *   macOS   → osascript `display dialog … buttons {"Deny","Approve"}`
 *   Linux   → `zenity --question` (GNOME) → `kdialog --yesno` (KDE) fallback
 *   Windows → PowerShell `[System.Windows.Forms.MessageBox]` Yes/No
 *
 * Result is read from the process EXIT CODE (0 = approve, 1 = deny), so the
 * subprocess can stay stdio-ignored. Returns "unavailable" when no dialog tool
 * is present (headless / minimal host) or the prompt times out — the caller
 * then falls back to the browser approval window, and the pending grant's
 * 5-minute TTL still applies.
 */

import { spawn } from "child_process";
import { logger } from "../utils/logger.js";

export type ApprovalChoice = "approve" | "deny" | "unavailable";

export interface ApprovalPrompt {
  title: string;
  message: string;
  /** Max time to wait for the user (default 5 min, matching the pending TTL). */
  timeoutMs?: number;
}

export interface DesktopPromptDeps {
  platform?: NodeJS.Platform;
  /** Injected for tests. Resolves an exit code: 0 approve, 1 deny, -1 spawn
   *  error (tool missing), -2 timeout. */
  runner?: (cmd: string, args: string[], timeoutMs: number) => Promise<number>;
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

/** Strip control chars; dialog args are passed as argv (no shell) so this is
 *  belt-and-suspenders against a crafted client name breaking the dialog. */
function clean(s: string): string {
  return (s ?? "").replace(/[\x00-\x1f\x7f]/g, " ");
}
function escAppleScript(s: string): string {
  return clean(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
function escPowerShell(s: string): string {
  return clean(s).replace(/'/g, "''");
}

function defaultRunner(cmd: string, args: string[], timeoutMs: number): Promise<number> {
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: "ignore", detached: false });
      let settled = false;
      const done = (code: number): void => { if (settled) return; settled = true; clearTimeout(timer); resolve(code); };
      const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } done(-2); }, timeoutMs);
      timer.unref?.();
      child.on("error", () => done(-1));      // ENOENT etc. — tool not installed
      child.on("close", (code) => done(code ?? 0));
    } catch {
      resolve(-1);
    }
  });
}

export class DesktopPrompt {
  private readonly platform: NodeJS.Platform;
  private readonly run: (cmd: string, args: string[], timeoutMs: number) => Promise<number>;

  constructor(deps: DesktopPromptDeps = {}) {
    this.platform = deps.platform ?? process.platform;
    this.run = deps.runner ?? defaultRunner;
  }

  async prompt(p: ApprovalPrompt): Promise<ApprovalChoice> {
    const timeoutMs = p.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    try {
      if (this.platform === "darwin") return await this.promptMac(p, timeoutMs);
      if (this.platform === "linux")  return await this.promptLinux(p, timeoutMs);
      if (this.platform === "win32")  return await this.promptWindows(p, timeoutMs);
      return "unavailable";
    } catch (err) {
      logger.debug("DesktopPrompt failed", "DesktopPrompt", err);
      return "unavailable";
    }
  }

  private map(code: number): ApprovalChoice {
    if (code === 0) return "approve";
    if (code === 1) return "deny";
    return "unavailable"; // -1 missing tool, -2 timeout, other
  }

  private async promptMac(p: ApprovalPrompt, timeoutMs: number): Promise<ApprovalChoice> {
    // Approve = default button (exit 0). Deny = cancel button → osascript exits
    // non-zero (1), so the exit code carries the choice.
    const script =
      `display dialog "${escAppleScript(p.message)}" with title "${escAppleScript(p.title)}" ` +
      `buttons {"Deny","Approve"} default button "Approve" cancel button "Deny" with icon caution`;
    return this.map(await this.run("osascript", ["-e", script], timeoutMs));
  }

  private async promptLinux(p: ApprovalPrompt, timeoutMs: number): Promise<ApprovalChoice> {
    // zenity: OK(Approve)=0, Cancel(Deny)=1, missing→-1. Fall back to kdialog.
    const z = await this.run("zenity", [
      "--question", "--title", clean(p.title), "--text", clean(p.message),
      "--ok-label=Approve", "--cancel-label=Deny", "--no-wrap",
    ], timeoutMs);
    if (z !== -1) return this.map(z);
    const k = await this.run("kdialog", ["--title", clean(p.title), "--yesno", clean(p.message)], timeoutMs);
    return this.map(k);
  }

  private async promptWindows(p: ApprovalPrompt, timeoutMs: number): Promise<ApprovalChoice> {
    // MessageBox Yes/No → exit 0 for Yes(Approve), 1 for No(Deny).
    const ps =
      `Add-Type -AssemblyName System.Windows.Forms | Out-Null;` +
      `$r=[System.Windows.Forms.MessageBox]::Show('${escPowerShell(p.message)}','${escPowerShell(p.title)}','YesNo','Warning');` +
      `if($r -eq 'Yes'){exit 0}else{exit 1}`;
    return this.map(await this.run("powershell.exe", ["-NoProfile", "-Command", ps], timeoutMs));
  }
}
