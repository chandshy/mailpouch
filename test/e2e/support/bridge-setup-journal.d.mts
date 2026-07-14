export interface BridgeSetupJournalRecord {
  readonly version: 1;
  readonly token: string;
  readonly journalId: string;
  readonly createdAt: string;
  readonly recoveryConfigPath: string;
  readonly path: string;
}

export interface BridgeSetupJournalLocation {
  scopeRoot: string;
  token: string;
  recoveryConfigPath: string;
}

export function bridgeSetupJournalPath(scopeRoot: string, token: string): string;

export function createBridgeSetupJournal(
  options: BridgeSetupJournalLocation,
): BridgeSetupJournalRecord;

export function listBridgeSetupJournals(options: {
  scopeRoot: string;
  recoveryConfigRoot?: string;
}): BridgeSetupJournalRecord[];

export function retireBridgeSetupJournal(options: BridgeSetupJournalLocation & {
  journalId?: string;
  allowMissing?: boolean;
}): boolean;
