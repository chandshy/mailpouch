export const BRIDGE_MUTATION_UID_BATCH_SIZE: number;
export function chunkUids(uids: number[], size: number): number[][];
export function bridgeMutationUidBatches(uids: number[]): number[][];
