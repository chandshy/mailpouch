/**
 * AsyncLocalStorage-backed carrier for the current request's caller
 * identity. The HTTP transport populates this on every authenticated
 * request; the tool dispatcher reads it to decide which grant to
 * consult and to tag audit rows. Stdio callers (the Claude Desktop
 * default) don't populate it — the dispatcher treats a missing context
 * as the local/trusted caller and bypasses the grant gate.
 *
 * AsyncLocalStorage propagates through awaited async calls within the
 * same request, so the dispatcher can read the context without needing
 * it threaded through every function.
 */

import { AsyncLocalStorage } from "async_hooks";
import { createHash } from "crypto";

/**
 * Derive a stable per-agent id for a LOCAL (stdio) client from its self-reported
 * MCP client name. Local agents have no OAuth client_id, so we key their grant
 * on the name (lowercased) — this is a local-trust convenience ("remember this
 * client across relaunches"), NOT a cryptographic identity (the name is
 * self-reported and could be spoofed by another local process). The `stdio:`
 * prefix namespaces it from OAuth ids (`pmc_…`) in the shared grant store.
 */
export function localAgentId(clientName: string): string {
  const id = (clientName ?? "").trim().toLowerCase() || "(unnamed local client)";
  return "stdio:" + createHash("sha256").update(id).digest("hex").slice(0, 16);
}

export interface CallerContext {
  /** OAuth client_id of the caller (DCR `pmc_…` for interactive agents and
   *  service accounts, `stdio:…` for local stdio agents). Always a real,
   *  per-agent identity — there is no shared-bearer pseudo-client. */
  clientId: string;
  /** Human-readable display name (from DCR/service-account client_name or synthesized). */
  clientName: string;
  /** Remote IP when known; undefined for stdio callers. */
  ip?: string;
}

const storage = new AsyncLocalStorage<CallerContext>();

export function runWithCaller<T>(ctx: CallerContext, fn: () => T | Promise<T>): T | Promise<T> {
  return storage.run(ctx, fn);
}

export function currentCaller(): CallerContext | undefined {
  return storage.getStore();
}
