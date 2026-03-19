/**
 * Type definitions for ProtonMail MCP Server
 */

export interface SMTPConfig {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  /** Optional SMTP token for direct smtp.protonmail.ch submission (paid plans only) */
  smtpToken?: string;
  /** Path to exported Proton Bridge TLS certificate for proper localhost cert trust */
  bridgeCertPath?: string;
}

export interface IMAPConfig {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  /** Path to exported Proton Bridge TLS certificate for proper localhost cert trust */
  bridgeCertPath?: string;
}

export interface ProtonMailConfig {
  smtp: SMTPConfig;
  imap: IMAPConfig;
  debug?: boolean;
  autoSync?: boolean;
  syncInterval?: number;
  autoStartBridge?: boolean;
  bridgePath?: string;
  settingsPort?: number;
}

export interface EmailMessage {
  id: string;
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  bodyPreview?: string; // Truncated preview of body (used in list views)
  isHtml: boolean;
  date: Date;
  folder: string;
  isRead: boolean;
  isStarred: boolean;
  hasAttachment: boolean;
  attachments?: EmailAttachment[];
  headers?: Record<string, string | string[]>;
  inReplyTo?: string;
  references?: string[];

  // IMAP flags
  isAnswered?: boolean;      // \Answered flag — has been replied to
  isForwarded?: boolean;     // \Forward flag (Bridge custom flag) — has been forwarded

  // MIME-level encryption/signature detection (parsed from content-type)
  isSignedPGP?: boolean;     // multipart/signed with protocol="application/pgp-signature"
  isEncryptedPGP?: boolean;  // multipart/encrypted with protocol="application/pgp-encrypted"

  // Proton-specific
  protonId?: string;         // X-Pm-Internal-Id header — stable Proton message ID (survives folder moves)
}

export interface EmailAttachment {
  filename: string;
  contentType: string;
  size: number;
  content?: Buffer | string;
  contentId?: string;
}

export interface EmailFolder {
  name: string;
  path: string;
  totalMessages: number;
  unreadMessages: number;
  specialUse?: string;
  /** Proton Bridge folder classification */
  folderType?: 'system' | 'user-folder' | 'label';
}

export interface EmailStats {
  totalEmails: number;
  unreadEmails: number;
  starredEmails: number;
  totalFolders: number;
  totalContacts: number;
  averageEmailsPerDay: number;
  mostActiveContact: string;
  mostUsedFolder: string;
  storageUsedMB: number;
}

export interface EmailAnalytics {
  volumeTrends: {
    date: string;
    received: number;
    sent: number;
  }[];
  topSenders: {
    email: string;
    count: number;
    lastContact: Date;
  }[];
  topRecipients: {
    email: string;
    count: number;
    lastContact: Date;
  }[];
  /** Null when there are no sent replies with matching received emails to measure against. */
  responseTimeStats: {
    average: number;
    median: number;
    fastest: number;
    slowest: number;
    sampleSize: number;
  } | null;
  peakActivityHours: {
    hour: number;
    count: number;
  }[];
  attachmentStats: {
    totalAttachments: number;
    totalSizeMB: number;
    averageSizeMB: number;
    mostCommonTypes: {
      type: string;
      count: number;
    }[];
  };
}

export interface Contact {
  email: string;
  name?: string;
  emailsSent: number;
  emailsReceived: number;
  lastInteraction: Date;
  firstInteraction: Date;
  averageResponseTime?: number;
  isFavorite?: boolean;
}

export interface SendEmailOptions {
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  subject: string;
  body: string;
  isHtml?: boolean;
  priority?: "high" | "normal" | "low";
  replyTo?: string;
  attachments?: EmailAttachment[];
  inReplyTo?: string;
  references?: string[];
  headers?: Record<string, string>;
}

export interface SearchEmailOptions {
  /** @deprecated Use body or text for full-text search instead. */
  query?: string;
  folder?: string;
  /** Search across multiple folders. Use ["*"] to search all folders (capped at 20). */
  folders?: string[];
  from?: string;
  to?: string;
  subject?: string;
  hasAttachment?: boolean;
  isRead?: boolean;
  isStarred?: boolean;
  dateFrom?: string;
  dateTo?: string;
  limit?: number;

  // Full-text search (Bridge does decrypt messages locally, BODY search works)
  body?: string;        // IMAP BODY <string> — searches message body content
  text?: string;        // IMAP TEXT <string> — searches headers + body

  // Additional header filters
  bcc?: string;         // IMAP BCC <string>
  header?: { field: string; value: string };  // IMAP HEADER <field> <value>

  // Flag filters
  answered?: boolean;   // IMAP ANSWERED / UNANSWERED
  isDraft?: boolean;    // IMAP DRAFT / UNDRAFT

  // Size filters
  larger?: number;      // IMAP LARGER <n> (bytes)
  smaller?: number;     // IMAP SMALLER <n> (bytes)

  // Sent-date filters (Date: header, not internal date)
  sentBefore?: Date;    // IMAP SENTBEFORE <date>
  sentSince?: Date;     // IMAP SENTSINCE <date>
}

/** Options for saving an email as a draft (all fields optional — drafts can be incomplete). */
export interface SaveDraftOptions {
  to?: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  subject?: string;
  body?: string;
  isHtml?: boolean;
  attachments?: EmailAttachment[];
  inReplyTo?: string;
  references?: string[];
}

/** A scheduled email queued for future delivery. */
export interface ScheduledEmail {
  id: string;
  scheduledAt: string; // ISO 8601
  options: SendEmailOptions;
  status: "pending" | "sent" | "failed" | "cancelled";
  createdAt: string; // ISO 8601
  error?: string;
  retryCount?: number;
}

export interface ConnectionStatus {
  smtp: {
    connected: boolean;
    host: string;
    port: number;
    lastCheck: Date;
    error?: string;
  };
  imap: {
    connected: boolean;
    host: string;
    port: number;
    lastCheck: Date;
    error?: string;
  };
}

export interface LogEntry {
  timestamp: Date;
  level: "debug" | "info" | "warn" | "error";
  context: string;
  message: string;
  data?: unknown;
}
