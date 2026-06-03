import { describe, it, expect } from "vitest";
import { buildSettingsTrayMenu, buildLauncherTrayMenu, type TrayMenuState } from "./tray-menu.js";

const base: TrayMenuState = {
  version: "9.9.9",
  connected: true,
  account: "user@example.com",
  pendingCount: 0,
  activeCount: 0,
  settingsEnabled: false,
  settingsUrl: "",
};

/** Find a menu item by id. */
const byId = (items: ReturnType<typeof buildSettingsTrayMenu>["items"], id: string) =>
  items.find((i) => i.id === id);

describe("buildSettingsTrayMenu — Settings-UI enable/disable toggle", () => {
  it("shows 'Enable Settings UI' (id=enable) and NO 'Open Settings' when the UI is off", () => {
    const { items } = buildSettingsTrayMenu({ ...base, settingsEnabled: false, settingsUrl: "" });
    const toggle = byId(items, "enable");
    expect(toggle).toBeDefined();
    expect(toggle?.label).toBe("Enable Settings UI");
    expect(byId(items, "disable")).toBeUndefined();
    expect(byId(items, "open")).toBeUndefined(); // can't open a UI that's off
  });

  it("shows 'Disable Settings UI' (id=disable) and 'Open Settings' when the UI is on", () => {
    const { items } = buildSettingsTrayMenu({
      ...base, settingsEnabled: true, settingsUrl: "http://localhost:8766",
    });
    const toggle = byId(items, "disable");
    expect(toggle).toBeDefined();
    expect(toggle?.label).toBe("Disable Settings UI");
    expect(byId(items, "enable")).toBeUndefined();
    const open = byId(items, "open");
    expect(open?.label).toBe("Open Settings");
  });

  it("surfaces the unavailable reason in the tooltip + a disabled item when the UI is off with a reason", () => {
    const { items, tooltip } = buildSettingsTrayMenu({
      ...base, settingsEnabled: false, settingsUrl: "", settingsUnavailableReason: "port 8765 in use",
    });
    expect(tooltip).toContain("Settings UI off: port 8765 in use");
    const note = byId(items, "settings-unavailable");
    expect(note?.enabled).toBe(false);
    expect(note?.label).toContain("port 8765 in use");
    expect(byId(items, "open")).toBeUndefined();
  });

  it("does NOT show the unavailable note when the UI is up, even if a stale reason is passed", () => {
    const { items, tooltip } = buildSettingsTrayMenu({
      ...base, settingsEnabled: true, settingsUrl: "http://localhost:8766", settingsUnavailableReason: "stale",
    });
    expect(byId(items, "settings-unavailable")).toBeUndefined();
    expect(tooltip).not.toContain("Settings UI off");
  });

  it("UI-005/UI-007: never offers 'Open Settings' for an enabled-but-urlless state", () => {
    // The _settingsEnabled === !!_settingsUrl invariant should hold upstream, but
    // the menu must fail safe even if it's momentarily violated.
    const { items } = buildSettingsTrayMenu({ ...base, settingsEnabled: true, settingsUrl: "" });
    expect(byId(items, "open")).toBeUndefined();
  });

  it("toggling enabled flips exactly the toggle item id/label (and Open Settings visibility)", () => {
    const off = buildSettingsTrayMenu({ ...base, settingsEnabled: false, settingsUrl: "" }).items;
    const on  = buildSettingsTrayMenu({ ...base, settingsEnabled: true, settingsUrl: "http://localhost:8766" }).items;
    expect(byId(off, "enable")?.label).toBe("Enable Settings UI");
    expect(byId(on, "disable")?.label).toBe("Disable Settings UI");
    // mutually exclusive ids
    expect(byId(off, "disable")).toBeUndefined();
    expect(byId(on, "enable")).toBeUndefined();
    // Open Settings tracks the enabled state
    expect(byId(off, "open")).toBeUndefined();
    expect(byId(on, "open")).toBeDefined();
  });

  it("always includes header, account, and a Quit item; account falls back when unset", () => {
    const { items } = buildSettingsTrayMenu({ ...base, account: "" });
    expect(byId(items, "header")?.label).toBe("mailpouch");
    expect(byId(items, "account")?.label).toBe("Not configured");
    expect(byId(items, "quit")?.label).toBe("Quit");
  });

  it("surfaces pending/active agent badges only when non-zero, and the pending tooltip", () => {
    const none = buildSettingsTrayMenu({ ...base, pendingCount: 0, activeCount: 0 });
    expect(byId(none.items, "pending")).toBeUndefined();
    expect(byId(none.items, "active")).toBeUndefined();
    expect(none.tooltip).toBe("mailpouch");

    const some = buildSettingsTrayMenu({ ...base, pendingCount: 2, activeCount: 1 });
    expect(byId(some.items, "pending")?.label).toContain("2 agent(s) pending");
    expect(byId(some.items, "active")?.label).toContain("1 agent(s) active");
    expect(some.tooltip).toContain("2 agent(s) awaiting approval");
  });
});

describe("buildLauncherTrayMenu — standalone mailpouch-settings tray (toggle parity)", () => {
  it("off: 'Enable Settings UI' (id=enable), no 'Open Settings'", () => {
    const items = buildLauncherTrayMenu({ version: "1.2.3", settingsEnabled: false, settingsUrl: "" });
    expect(byId(items, "enable")?.label).toBe("Enable Settings UI");
    expect(byId(items, "disable")).toBeUndefined();
    expect(byId(items, "open")).toBeUndefined();
    expect(byId(items, "quit")?.label).toBe("Quit");
    expect(byId(items, "version")?.label).toBe("v1.2.3");
  });

  it("on: 'Disable Settings UI' (id=disable) + 'Open Settings'", () => {
    const items = buildLauncherTrayMenu({ version: "1.2.3", settingsEnabled: true, settingsUrl: "http://localhost:8766" });
    expect(byId(items, "disable")?.label).toBe("Disable Settings UI");
    expect(byId(items, "enable")).toBeUndefined();
    expect(byId(items, "open")?.label).toBe("Open Settings");
  });

  it("fails safe: enabled-but-urlless never offers 'Open Settings'", () => {
    const items = buildLauncherTrayMenu({ version: "1.2.3", settingsEnabled: true, settingsUrl: "" });
    expect(byId(items, "open")).toBeUndefined();
    expect(byId(items, "disable")?.label).toBe("Disable Settings UI");
  });

  it("has no MCP-only items (status/account/agent badges)", () => {
    const items = buildLauncherTrayMenu({ version: "1.2.3", settingsEnabled: true, settingsUrl: "http://x" });
    expect(byId(items, "status")).toBeUndefined();
    expect(byId(items, "account")).toBeUndefined();
    expect(byId(items, "pending")).toBeUndefined();
  });
});
