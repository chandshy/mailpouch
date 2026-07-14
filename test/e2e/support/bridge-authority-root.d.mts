export interface BridgeAuthorityScopeOptions {
  authorityConfigPath?: string;
  mailboxScopeKey?: string;
  homeRoot?: string;
}

export interface BridgeAuthorityScope {
  readonly authorityConfigPath: string;
  readonly mailboxScopeKey: string;
  readonly homeRoot: string;
  readonly baseRoot: string;
  readonly scopeId: string;
  readonly scopeRoot: string;
  readonly leasePath: string;
}

export interface BridgeLeaseOwner {
  version: 1;
  pid: number;
  token: string;
  createdAt: string;
}

export const BRIDGE_RUN_LEASE_FILENAME: string;

export function bridgeMailboxScopeKeyFromConfig(config: unknown): string;

export function resolveBridgeAuthorityScope(
  options?: BridgeAuthorityScopeOptions,
): BridgeAuthorityScope;

export function assertBridgeCleanupLeaseAccess(
  options?: BridgeAuthorityScopeOptions & {
    scope?: BridgeAuthorityScope;
    ownerToken?: string;
  },
): Readonly<{
  scope: BridgeAuthorityScope;
  leasePresent: boolean;
  delegated: boolean;
  owner?: BridgeLeaseOwner;
}>;

export function acquireBridgeCleanupLeaseAccess(
  options?: BridgeAuthorityScopeOptions & {
    scope?: BridgeAuthorityScope;
    ownerToken?: string;
  },
): Readonly<{
  scope: BridgeAuthorityScope;
  leasePresent: true;
  delegated: boolean;
  owner: BridgeLeaseOwner;
  release(): void;
}>;
