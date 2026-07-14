/** Keep replayable live-Bridge MOVE/DELETE mutations deliberately small. A multi-UID MOVE can leave
 * Proton Bridge's command watcher occupied long after the client disconnects,
 * preventing new sessions from authenticating. All Mail COPY is separately a
 * durable one-shot operation and must not be split without per-UID crash state. */
export const BRIDGE_MUTATION_UID_BATCH_SIZE = 1;

/** Split a validated set of positive IMAP UIDs into bounded operands. */
export function chunkUids(uids, size) {
  if (!Number.isSafeInteger(size) || size < 1) {
    throw new TypeError("UID batch size must be a positive safe integer");
  }
  if (!Array.isArray(uids) || uids.some((uid) => !Number.isSafeInteger(uid) || uid < 1)) {
    throw new TypeError("UID batches require positive safe integers");
  }
  const chunks = [];
  for (let offset = 0; offset < uids.length; offset += size) {
    chunks.push(uids.slice(offset, offset + size));
  }
  return chunks;
}

export function bridgeMutationUidBatches(uids) {
  if (!Array.isArray(uids)) return chunkUids(uids, BRIDGE_MUTATION_UID_BATCH_SIZE);
  return chunkUids(
    [...new Set(uids)].sort((left, right) => left - right),
    BRIDGE_MUTATION_UID_BATCH_SIZE,
  );
}
