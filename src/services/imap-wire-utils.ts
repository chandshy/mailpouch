/**
 * Pure IMAP protocol helpers.
 *
 * Keeping wire-format arithmetic out of SimpleIMAPService makes the large
 * connection/cache service easier to reason about and lets callers test the
 * protocol boundaries without constructing an IMAP client.
 */

/**
 * Compare dotted numeric version strings ("3.22.1" vs "3.22.0").
 * Non-numeric segments and missing trailing segments compare as zero.
 */
export function compareSemver(a: string, b: string): number {
  const parse = (s: string) => s.split(".").map(part => parseInt(part, 10) || 0);
  const aa = parse(a);
  const bb = parse(b);
  const len = Math.max(aa.length, bb.length);
  for (let i = 0; i < len; i++) {
    const diff = (aa[i] ?? 0) - (bb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Split UIDs into comma-joined chunks that fit safely inside one IMAP command.
 * The 7.5 KB default leaves command/tag headroom below common 8 KB limits.
 */
export function chunkUidsForWire(uids: string[], maxLen = 7500): string[] {
  if (uids.length === 0) return [];
  const chunks: string[] = [];
  let current: string[] = [];
  let currentLength = 0;
  for (const uid of uids) {
    const separatorLength = current.length === 0 ? 0 : 1;
    if (current.length > 0 && currentLength + separatorLength + uid.length > maxLen) {
      chunks.push(current.join(","));
      current = [];
      currentLength = 0;
    }
    currentLength += (current.length === 0 ? 0 : 1) + uid.length;
    current.push(uid);
  }
  if (current.length > 0) chunks.push(current.join(","));
  return chunks;
}

/** Upper bound against an adversarial sequence set allocating unbounded memory. */
const MAX_EXPANDED_SEQUENCE = 10_000;

/** Expand an IMAP sequence-set (`1`, `1:5`, `1,3,7:9`) into individual UIDs. */
export function expandImapSequence(range: string): number[] {
  const values: number[] = [];
  for (const part of range.split(",")) {
    const segments = part.split(":");
    if (segments.length > 2) throw new Error(`Invalid IMAP sequence part: ${JSON.stringify(part)}`);
    const [start, end] = segments.map(Number);
    if (!Number.isInteger(start) || start < 1) {
      throw new Error(`Invalid IMAP sequence part: ${JSON.stringify(part)}`);
    }
    if (end === undefined) {
      values.push(start);
    } else {
      if (!Number.isInteger(end) || end < start) {
        throw new Error(`Invalid IMAP sequence range: ${JSON.stringify(part)}`);
      }
      if (values.length + (end - start + 1) > MAX_EXPANDED_SEQUENCE) {
        throw new Error(`IMAP sequence too large (> ${MAX_EXPANDED_SEQUENCE} UIDs): ${JSON.stringify(range)}`);
      }
      for (let value = start; value <= end; value++) values.push(value);
    }
    if (values.length > MAX_EXPANDED_SEQUENCE) {
      throw new Error(`IMAP sequence too large (> ${MAX_EXPANDED_SEQUENCE} UIDs): ${JSON.stringify(range)}`);
    }
  }
  return values;
}
