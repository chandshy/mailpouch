import type { SearchObject } from "imapflow";

export function buildOwnershipDiscoveryQuery(
  headerName: string,
  token: string,
  messageIds?: readonly string[],
  subjects?: readonly string[],
): SearchObject;
