import { describe, it, expect } from "vitest";
import { notifications } from "./notifications.js";
import type { AgentGrant } from "./types.js";
import type { GrantChangedEvent } from "./notifications.js";

function stubGrant(clientId = "pmc_x"): AgentGrant {
  return {
    clientId,
    clientName: "Stub",
    status: "pending",
    preset: "read_only",
    createdAt: new Date().toISOString(),
    totalCalls: 0,
  };
}

describe("NotificationBroker", () => {
  it("emits a grant-changed event with a monotonic sequence", () => {
    const received: GrantChangedEvent[] = [];
    const unsub = notifications.subscribe(e => received.push(e));
    try {
      notifications.emitGrantChanged("grant-created", stubGrant("pmc_1"));
      notifications.emitGrantChanged("grant-approved", stubGrant("pmc_1"));
      expect(received).toHaveLength(2);
      expect(received[0].kind).toBe("grant-created");
      expect(received[1].kind).toBe("grant-approved");
      expect(received[1].seq).toBeGreaterThan(received[0].seq);
    } finally { unsub(); }
  });

  it("subscribe returns an unsubscribe function that stops delivery", () => {
    let count = 0;
    const unsub = notifications.subscribe(() => { count++; });
    notifications.emitGrantChanged("grant-created", stubGrant("pmc_u"));
    expect(count).toBe(1);
    unsub();
    notifications.emitGrantChanged("grant-created", stubGrant("pmc_u"));
    expect(count).toBe(1);
  });

  it("supports multiple concurrent subscribers", () => {
    const a: GrantChangedEvent[] = [];
    const b: GrantChangedEvent[] = [];
    const ua = notifications.subscribe(e => a.push(e));
    const ub = notifications.subscribe(e => b.push(e));
    try {
      notifications.emitGrantChanged("grant-denied", stubGrant("pmc_m"));
      expect(a).toHaveLength(1);
      expect(b).toHaveLength(1);
      expect(a[0].seq).toBe(b[0].seq);
    } finally { ua(); ub(); }
  });
});
