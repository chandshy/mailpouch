/**
 * Central registry for all per-category tool modules.
 *
 * ListTools output order is load-bearing — it affects client-side system
 * prompts. The ORDER below exactly matches the definition order of
 * src/index.ts prior to the split:
 *
 *   Sending → Reading(early) → Folders → Actions → Deletion → Analytics →
 *   System → Bridge → Aliases → Pass → Drafts → Reading(late) → Escalation
 *
 * The reading module exposes its defs as two ordered arrays
 * (`defsEarly` / `defsLate`) so this registry can splice them into the
 * historically-correct positions.
 */

import * as sending    from "./sending.js";
import * as reading    from "./reading.js";
import * as folders    from "./folders.js";
import * as actions    from "./actions.js";
import * as deletion   from "./deletion.js";
import * as analytics  from "./analytics.js";
import * as system     from "./system.js";
import * as bridge     from "./bridge.js";
import * as aliases    from "./aliases.js";
import * as pass       from "./pass.js";
import * as drafts     from "./drafts.js";
import * as diagnostics from "./diagnostics.js";
import * as escalation from "./escalation.js";

import type { ToolDef, ToolHandler } from "./types.js";
import type { EscalationHandler } from "./escalation.js";

/** Ordered ListTools definitions. */
export function allToolDefs(): ToolDef[] {
  return [
    ...sending.defs,
    ...reading.defsEarly,
    ...folders.defs,
    ...actions.defs,
    ...deletion.defs,
    ...analytics.defs,
    ...system.defs,
    ...bridge.defs,
    ...aliases.defs,
    ...pass.defs,
    ...drafts.defs,
    ...reading.defsLate,
    ...diagnostics.defs,
    ...escalation.defs,
  ];
}

/** Tool-name-keyed dispatch table for the (post-gate) CallTool handlers. */
export function allHandlers(): Record<string, ToolHandler> {
  return {
    ...sending.handlers,
    ...reading.handlers,
    ...folders.handlers,
    ...actions.handlers,
    ...deletion.handlers,
    ...analytics.handlers,
    ...system.handlers,
    ...bridge.handlers,
    ...aliases.handlers,
    ...pass.handlers,
    ...drafts.handlers,
  };
}

/**
 * Pre-gate handlers (ALWAYS_AVAILABLE_TOOLS). Invoked by the CallTool
 * dispatcher BEFORE account routing / agent-grant / permission / destructive
 * gates run, so an over-restricted agent can always ask for more access.
 */
export function escalationHandlers(): Record<string, EscalationHandler> {
  return { ...escalation.handlers };
}

export { describeRequestEscalation } from "./escalation.js";
