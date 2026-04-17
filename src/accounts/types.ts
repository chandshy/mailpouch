/**
 * Multi-account data model.
 *
 * Each AccountSpec is a self-contained mail-server definition: provider
 * type, IMAP/SMTP host+port, credentials, optional TLS cert. The overall
 * server picks one "active" account to wire into the singleton IMAP/SMTP
 * services. Switching the active account currently requires a server
 * restart — a full service-layer refactor that lets a single running
 * process speak to multiple accounts concurrently is tracked as future
 * work (would let tools take an optional `account_id` argument).
 *
 * The shape is deliberately similar to the existing top-level
 * ConnectionSettings so migration is mechanical.
 */

export type AccountProviderType = "proton-bridge" | "imap";

export interface AccountSpec {
  /** Stable ID, user-editable. Used in notifications and audit rows. */
  id: string;
  /** Human-readable display name. */
  name: string;
  /** What kind of mail server this points at. Controls UI hints + defaults. */
  providerType: AccountProviderType;
  smtpHost: string;
  smtpPort: number;
  imapHost: string;
  imapPort: number;
  username: string;
  /** Stored in the config file (mode 0600) or keychain when available. */
  password: string;
  /** Optional direct-SMTP submission token (Proton paid-plan feature). */
  smtpToken?: string;
  /** Path to a pinned TLS certificate (required for Bridge; generally unused for public IMAP). */
  bridgeCertPath?: string;
  /** Legacy opt-out to allow insecure-TLS connections. Default false. */
  allowInsecureBridge?: boolean;
  /** Which TLS mode to use on the SMTP side. */
  tlsMode?: "starttls" | "ssl";
  /** For Bridge accounts only: auto-start the binary if not reachable. */
  autoStartBridge?: boolean;
  /** For Bridge accounts only: override the binary path. */
  bridgePath?: string;
  /** ISO-8601 timestamp of the last successful connection test. */
  lastCheckedAt?: string;
  /** Last connection-test result ("ok" | error message). */
  lastCheckResult?: string;
}

export interface AccountRegistry {
  /** 0+ accounts. The primary/default is picked by `activeAccountId`. */
  accounts: AccountSpec[];
  /** Which account drives the singleton IMAP/SMTP services. */
  activeAccountId: string;
}

/** Runtime-visible status (not persisted). */
export interface AccountStatus {
  id: string;
  name: string;
  providerType: AccountProviderType;
  isActive: boolean;
  lastCheckedAt?: string;
  lastCheckResult?: string;
}
