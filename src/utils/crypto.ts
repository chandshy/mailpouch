/**
 * Shared cryptographic helpers.
 *
 * Keep this module tiny — anything larger belongs in its own file. We
 * reach for node:crypto directly rather than a wrapper library so the
 * provenance of every primitive is auditable.
 */

import { Buffer } from "buffer";
import { timingSafeEqual } from "crypto";

/**
 * Constant-time string equality, safe against both content-difference
 * and length-difference timing side-channels. Returns false when either
 * input is empty, so callers don't accidentally authenticate as "".
 *
 * Implementation notes:
 *  - Encodes each string as UTF-8 before comparing, so equal logical
 *    strings compare equal regardless of JS engine internal reps.
 *  - When lengths differ, still performs a padded timingSafeEqual
 *    against a zero buffer of the expected length. This keeps the
 *    cost path consistent whether the lengths match or not, which
 *    avoids leaking the expected length via early-exit timing.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  const aa = Buffer.from(a, "utf-8");
  const bb = Buffer.from(b, "utf-8");
  if (aa.length !== bb.length) {
    const pad = Buffer.alloc(bb.length);
    try { timingSafeEqual(pad, bb); } catch { /* ignore */ }
    return false;
  }
  return timingSafeEqual(aa, bb);
}
