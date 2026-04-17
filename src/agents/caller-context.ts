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

export interface CallerContext {
  /** OAuth client_id of the caller, or "bearer:static" for the static-bearer path. */
  clientId: string;
  /** Human-readable display name (from DCR client_name or synthesized). */
  clientName: string;
  /** Remote IP when known; undefined for stdio callers. */
  ip?: string;
  /** True when the caller authenticated with the static bearer token (no OAuth). */
  staticBearer?: boolean;
}

const storage = new AsyncLocalStorage<CallerContext>();

export function runWithCaller<T>(ctx: CallerContext, fn: () => T | Promise<T>): T | Promise<T> {
  return storage.run(ctx, fn);
}

export function currentCaller(): CallerContext | undefined {
  return storage.getStore();
}
