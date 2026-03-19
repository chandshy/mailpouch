/**
 * Minimal ambient type declarations for the `systray2` package.
 * systray2 ships no TypeScript types.  Only the API surface used by
 * `src/tray.ts` is declared here; additional properties exist at runtime.
 */

declare module "systray2" {
  export interface MenuItem {
    title:    string;
    tooltip:  string;
    enabled:  boolean;
    checked?: boolean;
    items?:   MenuItem[];
  }

  export interface SysTrayOptions {
    menu:     SysTrayMenu;
    debug?:   boolean;
    copyDir?: boolean;
  }

  export type ClickAction = { item: MenuItem };

  export interface SysTrayMenu {
    icon:    string;
    title:   string;
    tooltip: string;
    items:   MenuItem[];
  }

  export interface SendActionUpdateMenu {
    type: "update-menu";
    menu: SysTrayMenu;
  }

  export interface SendActionUpdateItem {
    type: "update-item";
    item: MenuItem;
    seq_id?: number;
  }

  export type SendAction = SendActionUpdateMenu | SendActionUpdateItem;

  export default class SysTray {
    /** A pre-built separator menu item. */
    static readonly separator: MenuItem;

    constructor(options: SysTrayOptions);

    /** Resolves when the native tray binary is ready to receive commands. */
    ready(): Promise<void>;

    /** Register a click/activate handler (awaits ready() internally). */
    onClick(handler: (action: ClickAction) => void): Promise<this>;

    /** Push a live update to the tray (menu or item). */
    sendAction(action: SendAction): Promise<this>;

    /** Destroy the tray icon. Pass `false` to skip process.exit. */
    kill(exit: boolean): void;
  }
}
