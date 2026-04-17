/**
 * Module-scoped singletons for the agent system.
 *
 * The MCP server and the settings HTTP server run in the same Node
 * process, so they can share these instances directly. The instances
 * are populated by the bootstrap path in index.ts and read from the
 * settings server's route handlers. Access is synchronous and returns
 * undefined when the bootstrap hasn't run yet (e.g. unit tests that
 * instantiate the settings server in isolation).
 */

import type { AgentGrantStore } from "./grant-store.js";
import type { AgentAuditLog } from "./audit.js";

let _grants: AgentGrantStore | null = null;
let _audit: AgentAuditLog | null = null;

export function registerAgentServices(grants: AgentGrantStore, audit: AgentAuditLog): void {
  _grants = grants;
  _audit = audit;
}

export function getAgentGrantStore(): AgentGrantStore | null {
  return _grants;
}

export function getAgentAuditLog(): AgentAuditLog | null {
  return _audit;
}
