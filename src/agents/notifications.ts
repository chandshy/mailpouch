/**
 * Minimal in-process event bus for agent-related notifications.
 *
 * Subscribers include:
 *   - the settings UI's SSE endpoint (live updates in the browser tab)
 *   - the tray icon updater (dynamic "Pending: N" item)
 *
 * The bus is deliberately simple: one event type ("grant-changed") carrying
 * a snapshot of the grant record. Consumers decide what to do with it.
 * Decoupling via events means the store doesn't need to know about either
 * the UI or the tray — they subscribe independently.
 */

import { EventEmitter } from "events";
import type { AgentGrant } from "./types.js";

export type NotificationKind =
  | "grant-created"    // new DCR → pending grant just created
  | "grant-approved"   // user approved in UI
  | "grant-denied"
  | "grant-revoked"
  | "grant-expired";   // grant manager flipped an expiry during a tool call

export interface GrantChangedEvent {
  kind: NotificationKind;
  grant: AgentGrant;
  /** Monotonic sequence so SSE clients can detect gaps. */
  seq: number;
}

class NotificationBroker extends EventEmitter {
  private sequence = 0;

  /** Emit a grant-changed event. All subscribers observe synchronously. */
  emitGrantChanged(kind: NotificationKind, grant: AgentGrant): void {
    this.sequence += 1;
    this.emit("grant-changed", { kind, grant, seq: this.sequence } as GrantChangedEvent);
  }

  subscribe(listener: (ev: GrantChangedEvent) => void): () => void {
    this.on("grant-changed", listener);
    return () => { this.off("grant-changed", listener); };
  }

  /** Current sequence, for health checks and gap detection. */
  get seq(): number { return this.sequence; }
}

// Module-scope singleton so both the settings server and the tray updater
// can subscribe without threading the broker through every call site.
export const notifications = new NotificationBroker();
