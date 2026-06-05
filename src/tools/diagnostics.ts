/**
 * `setup_status` — the always-available, ungated install/connect diagnostic.
 *
 * Like the escalation meta-tools, this tool is in ALWAYS_AVAILABLE_TOOLS
 * (config/schema.ts) and is dispatched PRE-GATE in src/index.ts: an agent with
 * no approved grant, no credentials, or no reachable Bridge can still call it to
 * learn exactly what is wrong and the single next action. It only reports — it
 * never grants access or mutates state. This module holds the definition only;
 * the handler lives in the pre-gate dispatcher because it reads live server
 * state (config snapshot + the caller's grant). See src/diagnostics/setup-status.ts.
 */

import type { ToolDef } from "./types.js";

export const defs: ToolDef[] = [
  {
    name: "setup_status",
    title: "Setup & Connection Status",
    description:
      "CALL THIS FIRST. Diagnoses the mailpouch install end-to-end and returns the single next " +
      "action to get connected: whether credentials are configured, whether Proton Bridge is " +
      "reachable, and whether this agent's access has been approved. Always available — works even " +
      "before the agent is approved or credentials are set. Use get_connection_status afterwards for " +
      "live IMAP/SMTP auth health.",
    annotations: { readOnlyHint: true },
    inputSchema: { type: "object", properties: {} },
    outputSchema: {
      type: "object",
      properties: {
        state: {
          type: "string",
          enum: ["unconfigured", "bridge-unreachable", "pending-approval", "revoked", "ready"],
          description: "Overall install state — pick the next step from this.",
        },
        configured: { type: "boolean", description: "A username and Bridge password are configured." },
        bridgeReachable: { type: "boolean", description: "Both IMAP and SMTP Bridge ports accept TCP connections." },
        configExists: { type: "boolean" },
        configPath: { type: "string", description: "Path to the config file (default ~/.mailpouch.json; overridable via the MAILPOUCH_CONFIG env var). Redacted to '~/.mailpouch.json' for callers whose grant is not yet active." },
        username: { type: ["string", "null"] },
        credentialStorage: { type: ["string", "null"], enum: ["keychain", "encrypted-file", "config", null] },
        imap: {
          type: "object",
          properties: { host: { type: "string" }, port: { type: "number" }, reachable: { type: "boolean" } },
        },
        smtp: {
          type: "object",
          properties: { host: { type: "string" }, port: { type: "number" }, reachable: { type: "boolean" } },
        },
        insecureTls: { type: "boolean", description: "TLS validation is disabled (no pinned Bridge cert)." },
        grantStatus: {
          type: ["string", "null"],
          enum: ["pending", "active", "revoked", "expired", null],
          description: "This agent's per-agent grant state, or null when the local-agent gate is off.",
        },
        nextStep: { type: "string", description: "The single most-important action to take next." },
      },
      required: ["state", "configured", "bridgeReachable", "nextStep"],
    },
  },
];

const mod = { defs, handlers: {} };
export default mod;
