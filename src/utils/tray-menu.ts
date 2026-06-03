/**
 * Pure builder for the MCP server's system-tray menu.
 *
 * Extracted from index.ts so the enable/disable-Settings-UI state machine is
 * unit-testable in isolation (index.ts itself is the stdio entry point and not
 * importable without side effects). The invariants this encodes:
 *
 *   • the toggle item reads "Enable Settings UI" when the UI is OFF and
 *     "Disable Settings UI" when it is ON, with a stable id ("enable"/"disable")
 *     the click handler switches on;
 *   • "Open Settings" appears ONLY when the UI is enabled AND has a live URL
 *     (the UI-005/UI-007 fix — never offer to open a dead/empty URL);
 *   • pending/active agent badges appear only when non-zero.
 */
import type { TrayItem } from "./tray.js";

export interface TrayMenuState {
  version: string;
  connected: boolean;
  account: string;
  pendingCount: number;
  activeCount: number;
  settingsEnabled: boolean;
  settingsUrl: string;
  /** Why the settings UI is unavailable (e.g. "port 8766 in use"), shown in
   *  the tray when settingsEnabled is false so the missing "Open Settings"
   *  entry isn't silent. Omitted when the UI is up or was disabled on purpose. */
  settingsUnavailableReason?: string;
}

export function buildSettingsTrayMenu(s: TrayMenuState): { items: TrayItem[]; tooltip: string } {
  const statusLabel = s.connected ? "\u25CF Connected" : "\u25CB Disconnected";
  const accountLabel = s.account || "Not configured";
  const showUnavailable = !s.settingsEnabled && !!s.settingsUnavailableReason;
  const tooltip = showUnavailable
    ? `mailpouch · Settings UI off: ${s.settingsUnavailableReason}`
    : s.pendingCount > 0
      ? `mailpouch · ${s.pendingCount} agent(s) awaiting approval`
      : "mailpouch";

  const items: TrayItem[] = [
    { id: "header",  label: "mailpouch", enabled: false },
    { id: "version", label: `v${s.version}`, enabled: false },
    { id: "sep1",    label: "",          separator: true },
    { id: "status",  label: statusLabel, enabled: false },
    { id: "account", label: accountLabel, enabled: false },
    ...(s.pendingCount > 0
      ? [{ id: "pending", label: `\u26A0 ${s.pendingCount} agent(s) pending`, enabled: false }]
      : []),
    ...(s.activeCount > 0
      ? [{ id: "active",  label: `\u25CF ${s.activeCount} agent(s) active`,   enabled: false }]
      : []),
    { id: "sep2",    label: "", separator: true },
    // UI-005/UI-007: only offer "Open Settings" when the UI is actually up.
    ...(s.settingsEnabled && s.settingsUrl
      ? [{ id: "open", label: "Open Settings" }]
      : []),
    ...(showUnavailable
      ? [{ id: "settings-unavailable", label: `\u26A0 Settings UI off: ${s.settingsUnavailableReason}`, enabled: false }]
      : []),
    { id: "sep3",    label: "", separator: true },
    {
      id:    s.settingsEnabled ? "disable" : "enable",
      label: s.settingsEnabled ? "Disable Settings UI" : "Enable Settings UI",
    },
    { id: "sep4",    label: "", separator: true },
    { id: "quit",    label: "Quit" },
  ];
  return { items, tooltip };
}

export interface LauncherTrayState {
  version: string;
  settingsEnabled: boolean;
  settingsUrl: string;
}

/**
 * Menu for the standalone `mailpouch-settings` launcher tray. Spartan vs. the
 * MCP tray (no agent/connection state to surface), but mirrors the same
 * enable/disable-Settings-UI toggle and "Open Settings" gating: on the launcher
 * "disable" stops the HTTP server while keeping the tray alive, and "enable"
 * brings it back — so the icon stays an always-available control point.
 */
export function buildLauncherTrayMenu(s: LauncherTrayState): TrayItem[] {
  return [
    { id: "header",  label: "mailpouch", enabled: false },
    { id: "version", label: `v${s.version}`, enabled: false },
    { id: "sep1",    label: "", separator: true },
    ...(s.settingsEnabled && s.settingsUrl
      ? [{ id: "open", label: "Open Settings" }]
      : []),
    { id: "sep2",    label: "", separator: true },
    {
      id:    s.settingsEnabled ? "disable" : "enable",
      label: s.settingsEnabled ? "Disable Settings UI" : "Enable Settings UI",
    },
    { id: "sep3",    label: "", separator: true },
    { id: "quit",    label: "Quit" },
  ];
}
