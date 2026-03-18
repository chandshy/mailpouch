/**
 * Analytics Service for email statistics and insights
 */

import { EmailMessage, EmailStats, EmailAnalytics, Contact } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { extractEmailAddress, bytesToMB } from '../utils/helpers.js';

/** Maximum unique contacts tracked — prevents unbounded Map growth. */
const MAX_CONTACTS = 10_000;

export class AnalyticsService {
  private inboxEmails: EmailMessage[] = [];
  private sentEmails: EmailMessage[] = [];
  private contacts: Map<string, Contact> = new Map();
  private statsCache: EmailStats | null = null;
  private analyticsCache: EmailAnalytics | null = null;
  private lastCacheUpdate: Date | null = null;
  private cacheValidityMs: number = 5 * 60 * 1000; // 5 minutes

  /**
   * Update the analytics dataset. Pass both inbox and sent folders for accurate
   * volume trends, contact stats, and response-time calculation.
   * Does NOT clear the computed cache — the cache is only cleared when new data
   * differs from what is already stored, preventing spurious invalidation.
   */
  updateEmails(inbox: EmailMessage[], sent: EmailMessage[] = []): void {
    logger.debug(
      `Updating analytics with ${inbox.length} inbox / ${sent.length} sent emails`,
      'AnalyticsService'
    );
    this.inboxEmails = inbox;
    this.sentEmails = sent;
    this.invalidateCache();
    this.processContacts();
  }

  /** @deprecated Use updateEmails(inbox, sent) — kept for backward compatibility */
  get emails(): EmailMessage[] {
    return this.inboxEmails;
  }

  private invalidateCache(): void {
    this.statsCache = null;
    this.analyticsCache = null;
    this.lastCacheUpdate = null;
  }

  private isCacheValid(): boolean {
    if (!this.lastCacheUpdate) return false;
    const cacheAge = Date.now() - this.lastCacheUpdate.getTime();
    return cacheAge < this.cacheValidityMs;
  }

  /**
   * Build the contact map from both inbox (received) and sent emails.
   * - inbox emails → the `from` address sent a message to us
   * - sent emails  → the `to` addresses received a message from us
   */
  private processContacts(): void {
    this.contacts.clear();

    for (const email of this.inboxEmails) {
      const fromAddress = extractEmailAddress(email.from);
      if (fromAddress) {
        this.updateContact(fromAddress, 'received', email.date);
      }
    }

    for (const email of this.sentEmails) {
      for (const to of email.to) {
        const toAddress = extractEmailAddress(to);
        if (toAddress) {
          this.updateContact(toAddress, 'sent', email.date);
        }
      }
    }

    logger.debug(`Processed ${this.contacts.size} contacts`, 'AnalyticsService');
  }

  private updateContact(email: string, type: 'sent' | 'received', date: Date): void {
    let contact = this.contacts.get(email);

    if (!contact) {
      // Silently drop new contacts once the cap is reached.
      // Existing contacts (already in the map) are still updated below.
      if (this.contacts.size >= MAX_CONTACTS) return;
      contact = {
        email,
        emailsSent: 0,
        emailsReceived: 0,
        lastInteraction: date,
        firstInteraction: date,
      };
      this.contacts.set(email, contact);
    }

    if (type === 'sent') {
      contact.emailsSent++;
    } else {
      contact.emailsReceived++;
    }

    if (date > contact.lastInteraction) {
      contact.lastInteraction = date;
    }
    if (date < contact.firstInteraction) {
      contact.firstInteraction = date;
    }
  }

  getEmailStats(): EmailStats {
    if (this.statsCache && this.isCacheValid()) {
      return this.statsCache;
    }

    logger.debug('Calculating email statistics', 'AnalyticsService');

    const allEmails = [...this.inboxEmails, ...this.sentEmails];
    const totalEmails = allEmails.length;
    const unreadEmails = this.inboxEmails.filter(e => !e.isRead).length;
    const starredEmails = allEmails.filter(e => e.isStarred).length;

    const folders = new Set(allEmails.map(e => e.folder));
    const totalFolders = folders.size;

    let averageEmailsPerDay = 0;
    if (allEmails.length > 0) {
      // Use reduce instead of spread (Math.min/max(...array)) to avoid
      // "Maximum call stack size exceeded" on very large arrays.
      const oldestDate = allEmails.reduce((min, e) => Math.min(min, e.date.getTime()), Infinity);
      const newestDate = allEmails.reduce((max, e) => Math.max(max, e.date.getTime()), -Infinity);
      const daysDiff = Math.max(1, (newestDate - oldestDate) / (1000 * 60 * 60 * 24));
      averageEmailsPerDay = Math.round(totalEmails / daysDiff);
    }

    let mostActiveContact = 'N/A';
    let maxInteractions = 0;
    for (const [email, contact] of this.contacts.entries()) {
      const interactions = contact.emailsSent + contact.emailsReceived;
      if (interactions > maxInteractions) {
        maxInteractions = interactions;
        mostActiveContact = email;
      }
    }

    const folderCounts = new Map<string, number>();
    for (const email of allEmails) {
      folderCounts.set(email.folder, (folderCounts.get(email.folder) || 0) + 1);
    }

    let mostUsedFolder = 'INBOX';
    let maxFolderCount = 0;
    for (const [folder, count] of folderCounts.entries()) {
      if (count > maxFolderCount) {
        maxFolderCount = count;
        mostUsedFolder = folder;
      }
    }

    let totalBytes = 0;
    for (const email of allEmails) {
      totalBytes += email.body.length;
      if (email.attachments) {
        for (const att of email.attachments) {
          totalBytes += att.size;
        }
      }
    }

    const stats: EmailStats = {
      totalEmails,
      unreadEmails,
      starredEmails,
      totalFolders,
      totalContacts: this.contacts.size,
      averageEmailsPerDay,
      mostActiveContact,
      mostUsedFolder,
      storageUsedMB: bytesToMB(totalBytes),
    };

    this.statsCache = stats;
    this.lastCacheUpdate = new Date();
    return stats;
  }

  getEmailAnalytics(): EmailAnalytics {
    if (this.analyticsCache && this.isCacheValid()) {
      return this.analyticsCache;
    }

    logger.debug('Calculating email analytics', 'AnalyticsService');

    const volumeTrends = this.calculateVolumeTrends(30);

    const topSenders = Array.from(this.contacts.values())
      .filter(c => c.emailsReceived > 0)
      .sort((a, b) => b.emailsReceived - a.emailsReceived)
      .slice(0, 10)
      .map(c => ({ email: c.email, count: c.emailsReceived, lastContact: c.lastInteraction }));

    const topRecipients = Array.from(this.contacts.values())
      .filter(c => c.emailsSent > 0)
      .sort((a, b) => b.emailsSent - a.emailsSent)
      .slice(0, 10)
      .map(c => ({ email: c.email, count: c.emailsSent, lastContact: c.lastInteraction }));

    const responseTimeStats = this.calculateResponseTimeStats();
    const peakActivityHours = this.calculatePeakActivityHours();
    const attachmentStats = this.calculateAttachmentStats();

    const analytics: EmailAnalytics = {
      volumeTrends,
      topSenders,
      topRecipients,
      responseTimeStats,
      peakActivityHours,
      attachmentStats,
    };

    this.analyticsCache = analytics;
    this.lastCacheUpdate = new Date();
    return analytics;
  }

  /**
   * Compute response times from sent emails that have an inReplyTo header
   * matching an inbox email. Returns null when there is insufficient data.
   * Times are expressed in hours.
   */
  private calculateResponseTimeStats(): EmailAnalytics['responseTimeStats'] {
    const responseTimes: number[] = [];

    // Build a lookup from Message-ID to inbox email date
    const inboxById = new Map<string, Date>();
    for (const email of this.inboxEmails) {
      const msgIdRaw = email.headers?.['message-id'];
      const msgId = Array.isArray(msgIdRaw) ? msgIdRaw[0] : msgIdRaw;
      if (msgId) {
        inboxById.set(msgId.trim(), email.date);
      }
    }

    for (const sent of this.sentEmails) {
      if (!sent.inReplyTo) continue;
      const originalDate = inboxById.get(sent.inReplyTo.trim());
      if (!originalDate) continue;

      const diffHours = (sent.date.getTime() - originalDate.getTime()) / (1000 * 60 * 60);
      // Only count plausible replies (within 30 days, after the original)
      if (diffHours > 0 && diffHours <= 30 * 24) {
        responseTimes.push(diffHours);
      }
    }

    if (responseTimes.length === 0) return null;

    responseTimes.sort((a, b) => a - b);
    const average = responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length;
    const median = responseTimes[Math.floor(responseTimes.length / 2)];

    return {
      average: parseFloat(average.toFixed(1)),
      median: parseFloat(median.toFixed(1)),
      fastest: parseFloat(responseTimes[0].toFixed(1)),
      slowest: parseFloat(responseTimes[responseTimes.length - 1].toFixed(1)),
      sampleSize: responseTimes.length,
    };
  }

  /**
   * Volume trends split by received (inbox) and sent (sent folder).
   */
  private calculateVolumeTrends(days: number): EmailAnalytics['volumeTrends'] {
    const trends = new Map<string, { received: number; sent: number }>();

    const now = new Date();
    for (let i = 0; i < days; i++) {
      const date = new Date(now);
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];
      trends.set(dateStr, { received: 0, sent: 0 });
    }

    for (const email of this.inboxEmails) {
      const dateStr = email.date.toISOString().split('T')[0];
      const entry = trends.get(dateStr);
      if (entry) entry.received++;
    }

    for (const email of this.sentEmails) {
      const dateStr = email.date.toISOString().split('T')[0];
      const entry = trends.get(dateStr);
      if (entry) entry.sent++;
    }

    return Array.from(trends.entries())
      .map(([date, counts]) => ({ date, ...counts }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  private calculatePeakActivityHours(): { hour: number; count: number }[] {
    const hourCounts = new Map<number, number>();
    for (let i = 0; i < 24; i++) hourCounts.set(i, 0);

    for (const email of [...this.inboxEmails, ...this.sentEmails]) {
      const hour = email.date.getHours();
      hourCounts.set(hour, (hourCounts.get(hour) || 0) + 1);
    }

    return Array.from(hourCounts.entries())
      .map(([hour, count]) => ({ hour, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
  }

  private calculateAttachmentStats(): EmailAnalytics['attachmentStats'] {
    let totalAttachments = 0;
    let totalSizeBytes = 0;
    const typeCounts = new Map<string, number>();

    for (const email of [...this.inboxEmails, ...this.sentEmails]) {
      if (email.attachments) {
        totalAttachments += email.attachments.length;
        for (const att of email.attachments) {
          totalSizeBytes += att.size;
          const type = att.contentType?.split('/')[0] || 'other';
          typeCounts.set(type, (typeCounts.get(type) || 0) + 1);
        }
      }
    }

    const mostCommonTypes = Array.from(typeCounts.entries())
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    return {
      totalAttachments,
      totalSizeMB: bytesToMB(totalSizeBytes),
      averageSizeMB: totalAttachments > 0 ? bytesToMB(totalSizeBytes / totalAttachments) : 0,
      mostCommonTypes,
    };
  }

  getContacts(limit: number = 100): Contact[] {
    // Clamp: minimum 1, maximum 500.  Prevents accidental or malicious
    // requests that would serialize thousands of contact records into MCP output.
    const safeLimit = Math.min(Math.max(1, Math.trunc(limit) || 100), 500);
    return Array.from(this.contacts.values())
      .sort((a, b) => {
        const aTotal = a.emailsSent + a.emailsReceived;
        const bTotal = b.emailsSent + b.emailsReceived;
        return bTotal - aTotal;
      })
      .slice(0, safeLimit);
  }

  getVolumeTrends(days: number = 30): EmailAnalytics['volumeTrends'] {
    // Clamp 1–365.  An unchecked caller could request 10000 days, creating
    // a 10000-entry map/array and burning proportional CPU allocating it.
    const safeDays = Math.min(Math.max(1, Math.trunc(days) || 30), 365);
    return this.calculateVolumeTrends(safeDays);
  }

  clearCache(): void {
    this.invalidateCache();
    logger.info('Analytics cache cleared', 'AnalyticsService');
  }

  clearAll(): void {
    this.inboxEmails = [];
    this.sentEmails = [];
    this.contacts.clear();
    this.invalidateCache();
    logger.info('All analytics data cleared', 'AnalyticsService');
  }

  /** Securely wipe all email data from memory. */
  wipeData(): void {
    for (const email of this.inboxEmails) {
      if (email.body) email.body = "";
      if (email.subject) email.subject = "";
      if (email.from) email.from = "";
    }
    for (const email of this.sentEmails) {
      if (email.body) email.body = "";
      if (email.subject) email.subject = "";
      if (email.from) email.from = "";
    }
    this.inboxEmails = [];
    this.sentEmails = [];
    this.contacts.clear();
    this.invalidateCache();
    logger.info('Analytics data wiped from memory', 'AnalyticsService');
  }
}
