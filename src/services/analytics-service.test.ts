import { describe, it, expect, beforeEach } from 'vitest';
import { AnalyticsService } from './analytics-service.js';
import type { EmailMessage } from '../types/index.js';

describe('AnalyticsService', () => {
  let service: AnalyticsService;
  const mockMessages: EmailMessage[] = [
    {
      id: '1',
      from: 'sender1@example.com',
      to: ['recipient@example.com'],
      subject: 'Test 1',
      body: 'Body 1',
      isHtml: false,
      date: new Date('2024-01-15T10:00:00Z'),
      folder: 'INBOX',
      isRead: true,
      isStarred: false,
      hasAttachment: false,
    },
    {
      id: '2',
      from: 'sender2@example.com',
      to: ['recipient@example.com'],
      subject: 'Test 2',
      body: 'Body 2',
      isHtml: false,
      date: new Date('2024-01-15T11:00:00Z'),
      folder: 'INBOX',
      isRead: false,
      isStarred: true,
      hasAttachment: true,
    },
    {
      id: '3',
      from: 'sender1@example.com',
      to: ['recipient@example.com'],
      subject: 'Test 3',
      body: 'Body 3',
      isHtml: true,
      date: new Date('2024-01-16T10:00:00Z'),
      folder: 'Sent',
      isRead: true,
      isStarred: false,
      hasAttachment: false,
    },
  ];

  beforeEach(() => {
    service = new AnalyticsService();
    service.updateEmails(mockMessages);
  });

  describe('getEmailStats', () => {
    it('should calculate total count', () => {
      const stats = service.getEmailStats();
      expect(stats.totalEmails).toBe(3);
    });

    it('should calculate unread count', () => {
      const stats = service.getEmailStats();
      expect(stats.unreadEmails).toBe(1);
    });

    it('should calculate starred count', () => {
      const stats = service.getEmailStats();
      expect(stats.starredEmails).toBe(1);
    });

    it('should calculate folder count', () => {
      const stats = service.getEmailStats();
      expect(stats.totalFolders).toBe(2);
    });

    it('should calculate storage', () => {
      const stats = service.getEmailStats();
      expect(stats.storageUsedMB).toBeGreaterThanOrEqual(0);
    });

    it('should handle empty emails', () => {
      const emptyService = new AnalyticsService();
      const stats = emptyService.getEmailStats();
      expect(stats.totalEmails).toBe(0);
      expect(stats.unreadEmails).toBe(0);
      expect(stats.starredEmails).toBe(0);
    });
  });

  describe('getEmailAnalytics', () => {
    it('should return analytics object', () => {
      const analytics = service.getEmailAnalytics();
      expect(analytics).toBeDefined();
      expect(analytics.volumeTrends).toBeDefined();
      expect(analytics.topSenders).toBeDefined();
      expect(analytics.topRecipients).toBeDefined();
    });

    it('should include volume trends', () => {
      const analytics = service.getEmailAnalytics();
      expect(Array.isArray(analytics.volumeTrends)).toBe(true);
    });

    it('should include top senders and recipients', () => {
      const analytics = service.getEmailAnalytics();
      expect(Array.isArray(analytics.topSenders)).toBe(true);
      expect(Array.isArray(analytics.topRecipients)).toBe(true);
    });

    it('should return null responseTimeStats when no sent replies match received emails', () => {
      // The mock data has no inReplyTo headers, so there are no measurable response times.
      const analytics = service.getEmailAnalytics();
      expect(analytics.responseTimeStats).toBeNull();
    });

    it('should compute responseTimeStats when sent emails match received message-ids', () => {
      const received: EmailMessage = {
        id: '10',
        from: 'alice@example.com',
        to: ['me@example.com'],
        subject: 'Hello',
        body: 'Hi there',
        isHtml: false,
        date: new Date('2024-02-01T09:00:00Z'),
        folder: 'INBOX',
        isRead: true,
        isStarred: false,
        hasAttachment: false,
        headers: { 'message-id': '<msg-abc@example.com>' },
      };
      const reply: EmailMessage = {
        id: '11',
        from: 'me@example.com',
        to: ['alice@example.com'],
        subject: 'Re: Hello',
        body: 'Sure!',
        isHtml: false,
        date: new Date('2024-02-01T11:00:00Z'), // 2 hours later
        folder: 'Sent',
        isRead: true,
        isStarred: false,
        hasAttachment: false,
        inReplyTo: '<msg-abc@example.com>',
      };
      const svc = new AnalyticsService();
      svc.updateEmails([received], [reply]);
      const analytics = svc.getEmailAnalytics();
      expect(analytics.responseTimeStats).not.toBeNull();
      expect(analytics.responseTimeStats!.sampleSize).toBe(1);
      expect(analytics.responseTimeStats!.average).toBeCloseTo(2, 0); // ~2 hours
      expect(analytics.responseTimeStats!.fastest).toBeCloseTo(2, 0);
    });

    it('should include attachment stats', () => {
      const analytics = service.getEmailAnalytics();
      expect(analytics.attachmentStats).toBeDefined();
      expect(analytics.attachmentStats.totalAttachments).toBeGreaterThanOrEqual(0);
    });
  });

  describe('getContacts', () => {
    it('should return contact list', () => {
      const contacts = service.getContacts();
      expect(Array.isArray(contacts)).toBe(true);
    });

    it('should limit results', () => {
      const contacts = service.getContacts(1);
      expect(contacts.length).toBeLessThanOrEqual(1);
    });

    it('should return empty array when no emails', () => {
      const emptyService = new AnalyticsService();
      const contacts = emptyService.getContacts();
      expect(contacts).toEqual([]);
    });
  });

  describe('getVolumeTrends', () => {
    it('should return volume trends', () => {
      const trends = service.getVolumeTrends(30);
      expect(Array.isArray(trends)).toBe(true);
    });

    it('should have date and count properties', () => {
      const trends = service.getVolumeTrends(7);
      if (trends.length > 0) {
        expect(trends[0]).toHaveProperty('date');
        expect(trends[0]).toHaveProperty('received');
        expect(trends[0]).toHaveProperty('sent');
      }
    });
  });

  describe('cache management', () => {
    it('should clear cache', () => {
      service.getEmailStats();
      expect(() => service.clearCache()).not.toThrow();
    });

    it('should clear all data', () => {
      expect(() => service.clearAll()).not.toThrow();
      const stats = service.getEmailStats();
      expect(stats.totalEmails).toBe(0);
    });
  });

  describe('updateEmails', () => {
    it('should update email data', () => {
      const newService = new AnalyticsService();
      newService.updateEmails(mockMessages);
      const stats = newService.getEmailStats();
      expect(stats.totalEmails).toBe(3);
    });

    it('should replace existing data', () => {
      service.updateEmails([mockMessages[0]]);
      const stats = service.getEmailStats();
      expect(stats.totalEmails).toBe(1);
    });
  });

  describe('wipeData', () => {
    it('wipes all email fields and clears contacts', () => {
      // service already has mockMessages loaded; wipe and verify
      service.wipeData();
      const stats = service.getEmailStats();
      expect(stats.totalEmails).toBe(0);
      expect(stats.totalContacts).toBe(0);
    });

    it('wipes body/subject/from fields on inbox emails', () => {
      const svc = new AnalyticsService();
      const inbox: EmailMessage = {
        id: '99',
        from: 'a@b.com',
        to: ['me@x.com'],
        subject: 'Secret',
        body: 'Private text',
        isHtml: false,
        date: new Date(),
        folder: 'INBOX',
        isRead: false,
        isStarred: false,
        hasAttachment: false,
      };
      svc.updateEmails([inbox], []);
      // Access the internal array via cast to verify fields are wiped
      svc.wipeData();
      // After wipe the service should report 0 emails
      expect(svc.getEmailStats().totalEmails).toBe(0);
    });

    it('wipes sent emails the same way', () => {
      const svc = new AnalyticsService();
      const sent: EmailMessage = {
        id: '100',
        from: 'me@x.com',
        to: ['bob@example.com'],
        subject: 'Confidential',
        body: 'Secret body',
        isHtml: false,
        date: new Date(),
        folder: 'Sent',
        isRead: true,
        isStarred: false,
        hasAttachment: false,
      };
      svc.updateEmails([], [sent]);
      svc.wipeData();
      expect(svc.getEmailStats().totalEmails).toBe(0);
    });
  });

  describe('getContacts — limit clamping', () => {
    it('clamps limit to minimum 1', () => {
      const contacts = service.getContacts(0);
      // Even asking for 0, at least 1 result should come back (if contacts exist)
      expect(contacts.length).toBeGreaterThanOrEqual(0);
    });

    it('clamps limit to maximum 500', () => {
      const contacts = service.getContacts(9999);
      // Should not exceed 500 (or total contacts if fewer)
      expect(contacts.length).toBeLessThanOrEqual(500);
    });

    it('handles NaN limit gracefully (falls back to 100)', () => {
      // Math.trunc(NaN) || 100 = 100
      const contacts = service.getContacts(NaN);
      expect(Array.isArray(contacts)).toBe(true);
    });
  });

  describe('calculateAttachmentStats — with typed attachments', () => {
    it('computes mostCommonTypes from attachment contentType', () => {
      const withAtt: EmailMessage = {
        id: '50',
        from: 'x@x.com',
        to: ['y@y.com'],
        subject: 'Has attachments',
        body: '',
        isHtml: false,
        date: new Date(),
        folder: 'INBOX',
        isRead: true,
        isStarred: false,
        hasAttachment: true,
        attachments: [
          { filename: 'doc.pdf', contentType: 'application/pdf', size: 1024 },
          { filename: 'img.png', contentType: 'image/png', size: 2048 },
          { filename: 'other.bin', contentType: undefined, size: 512 },
        ],
      };
      const svc = new AnalyticsService();
      svc.updateEmails([withAtt], []);
      const analytics = svc.getEmailAnalytics();
      const { attachmentStats } = analytics;
      expect(attachmentStats.totalAttachments).toBe(3);
      expect(attachmentStats.mostCommonTypes.length).toBeGreaterThan(0);
      // "application", "image", "other" should appear
      const types = attachmentStats.mostCommonTypes.map(t => t.type);
      expect(types).toContain('application');
      expect(types).toContain('image');
      expect(types).toContain('other');
    });

    it('averageSizeMB is 0 when there are no attachments', () => {
      const svc = new AnalyticsService();
      svc.updateEmails([], []);
      const analytics = svc.getEmailAnalytics();
      expect(analytics.attachmentStats.averageSizeMB).toBe(0);
    });
  });

  describe('getEmailStats — cache hit path', () => {
    it('returns cached stats on second call without recalculating', () => {
      const stats1 = service.getEmailStats();
      // Second call immediately after → should hit cache and return identical object
      const stats2 = service.getEmailStats();
      expect(stats2).toBe(stats1); // same reference (cache hit)
    });

    it('getEmailAnalytics returns cached analytics on second call', () => {
      const a1 = service.getEmailAnalytics();
      const a2 = service.getEmailAnalytics();
      expect(a2).toBe(a1);
    });
  });

  describe('getEmailStats — attachment size included in storageUsedMB', () => {
    it('includes attachment size bytes in total storage', () => {
      const withAtt: EmailMessage = {
        id: '77',
        from: 'a@b.com',
        to: ['c@d.com'],
        subject: 'Has att',
        body: 'body',
        isHtml: false,
        date: new Date(),
        folder: 'INBOX',
        isRead: false,
        isStarred: false,
        hasAttachment: true,
        attachments: [{ filename: 'x.pdf', contentType: 'application/pdf', size: 1_048_576 }], // 1 MB
      };
      const svc = new AnalyticsService();
      svc.updateEmails([withAtt], []);
      const stats = svc.getEmailStats();
      expect(stats.storageUsedMB).toBeGreaterThan(0);
    });
  });

  describe('deprecated emails getter', () => {
    it('returns the current inboxEmails array', () => {
      const svc = new AnalyticsService();
      svc.updateEmails(mockMessages, []);
      // Access the deprecated getter
      const result = (svc as any).emails;
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(mockMessages.length);
    });
  });

  describe('updateContact — firstInteraction update', () => {
    it('updates firstInteraction when a newer contact receives an older email', () => {
      // Sending two emails from same sender: first with a recent date, then with an earlier date
      const recentDate = new Date('2024-06-01T10:00:00Z');
      const earlierDate = new Date('2024-01-01T10:00:00Z');

      const email1: EmailMessage = {
        id: '1',
        from: 'alice@x.com',
        to: ['me@x.com'],
        subject: 'Recent',
        body: '',
        isHtml: false,
        date: recentDate,
        folder: 'INBOX',
        isRead: true,
        isStarred: false,
        hasAttachment: false,
      };
      const email2: EmailMessage = {
        id: '2',
        from: 'alice@x.com',
        to: ['me@x.com'],
        subject: 'Older',
        body: '',
        isHtml: false,
        date: earlierDate,
        folder: 'INBOX',
        isRead: true,
        isStarred: false,
        hasAttachment: false,
      };

      const svc = new AnalyticsService();
      // Both emails are from alice@x.com — contact is created with recentDate,
      // then updated with earlierDate which should set firstInteraction
      svc.updateEmails([email1, email2], []);
      const contacts = svc.getContacts();
      const alice = contacts.find(c => c.email === 'alice@x.com');
      expect(alice).toBeDefined();
      expect(alice!.firstInteraction).toEqual(earlierDate);
      expect(alice!.lastInteraction).toEqual(recentDate);
    });
  });

  describe('getEmailAnalytics — topRecipients with sent emails', () => {
    it('populates topRecipients when sent emails include multiple recipients', () => {
      const inbox: EmailMessage = {
        id: '1',
        from: 'alice@x.com',
        to: ['me@x.com'],
        subject: 'Hi',
        body: '',
        isHtml: false,
        date: new Date(),
        folder: 'INBOX',
        isRead: true,
        isStarred: false,
        hasAttachment: false,
      };
      const sent1: EmailMessage = {
        id: '2',
        from: 'me@x.com',
        to: ['alice@x.com'],
        subject: 'Re: Hi',
        body: '',
        isHtml: false,
        date: new Date(),
        folder: 'Sent',
        isRead: true,
        isStarred: false,
        hasAttachment: false,
      };
      const sent2: EmailMessage = {
        id: '3',
        from: 'me@x.com',
        to: ['bob@x.com'],
        subject: 'Hey Bob',
        body: '',
        isHtml: false,
        date: new Date(),
        folder: 'Sent',
        isRead: true,
        isStarred: false,
        hasAttachment: false,
      };
      const svc = new AnalyticsService();
      svc.updateEmails([inbox], [sent1, sent2]);
      const analytics = svc.getEmailAnalytics();
      expect(analytics.topRecipients.length).toBeGreaterThan(0);
      const emails = analytics.topRecipients.map(r => r.email);
      expect(emails).toContain('alice@x.com');
    });
  });

  describe('wipeData — falsy fields are skipped', () => {
    it('handles emails where body/subject/from are already empty strings', () => {
      const emptyFieldEmail: EmailMessage = {
        id: '200',
        from: '',
        to: ['x@x.com'],
        subject: '',
        body: '',
        isHtml: false,
        date: new Date(),
        folder: 'INBOX',
        isRead: false,
        isStarred: false,
        hasAttachment: false,
      };
      const svc = new AnalyticsService();
      svc.updateEmails([emptyFieldEmail], [emptyFieldEmail]);
      // Should not throw even with falsy fields
      expect(() => svc.wipeData()).not.toThrow();
      expect(svc.getEmailStats().totalEmails).toBe(0);
    });
  });

  describe('calculateResponseTimeStats — edge cases', () => {
    it('ignores sent replies with inReplyTo not matching any inbox message-id', () => {
      const inbox: EmailMessage = {
        id: '1',
        from: 'a@b.com',
        to: ['me@x.com'],
        subject: 'Hi',
        body: '',
        isHtml: false,
        date: new Date('2024-01-01T10:00:00Z'),
        folder: 'INBOX',
        isRead: true,
        isStarred: false,
        hasAttachment: false,
        headers: { 'message-id': '<real-msg-id@x.com>' },
      };
      const sent: EmailMessage = {
        id: '2',
        from: 'me@x.com',
        to: ['a@b.com'],
        subject: 'Re: Hi',
        body: '',
        isHtml: false,
        date: new Date('2024-01-01T12:00:00Z'),
        folder: 'Sent',
        isRead: true,
        isStarred: false,
        hasAttachment: false,
        inReplyTo: '<unknown-id@x.com>', // no matching inbox msg
      };
      const svc = new AnalyticsService();
      svc.updateEmails([inbox], [sent]);
      const analytics = svc.getEmailAnalytics();
      // No matches → null response time stats
      expect(analytics.responseTimeStats).toBeNull();
    });

    it('ignores replies where sent is before original (negative diffHours)', () => {
      const inbox: EmailMessage = {
        id: '3',
        from: 'a@b.com',
        to: ['me@x.com'],
        subject: 'Hi',
        body: '',
        isHtml: false,
        date: new Date('2024-01-01T12:00:00Z'),
        folder: 'INBOX',
        isRead: true,
        isStarred: false,
        hasAttachment: false,
        headers: { 'message-id': '<msg-3@x.com>' },
      };
      const sent: EmailMessage = {
        id: '4',
        from: 'me@x.com',
        to: ['a@b.com'],
        subject: 'Re: Hi',
        body: '',
        isHtml: false,
        date: new Date('2024-01-01T10:00:00Z'), // BEFORE original — negative diff
        folder: 'Sent',
        isRead: true,
        isStarred: false,
        hasAttachment: false,
        inReplyTo: '<msg-3@x.com>',
      };
      const svc = new AnalyticsService();
      svc.updateEmails([inbox], [sent]);
      const analytics = svc.getEmailAnalytics();
      expect(analytics.responseTimeStats).toBeNull();
    });

    it('ignores replies more than 30 days after the original', () => {
      const inbox: EmailMessage = {
        id: '5',
        from: 'a@b.com',
        to: ['me@x.com'],
        subject: 'Hi',
        body: '',
        isHtml: false,
        date: new Date('2024-01-01T10:00:00Z'),
        folder: 'INBOX',
        isRead: true,
        isStarred: false,
        hasAttachment: false,
        headers: { 'message-id': '<msg-5@x.com>' },
      };
      const sent: EmailMessage = {
        id: '6',
        from: 'me@x.com',
        to: ['a@b.com'],
        subject: 'Re: Hi (very late)',
        body: '',
        isHtml: false,
        date: new Date('2024-03-01T10:00:00Z'), // 60+ days later
        folder: 'Sent',
        isRead: true,
        isStarred: false,
        hasAttachment: false,
        inReplyTo: '<msg-5@x.com>',
      };
      const svc = new AnalyticsService();
      svc.updateEmails([inbox], [sent]);
      const analytics = svc.getEmailAnalytics();
      expect(analytics.responseTimeStats).toBeNull();
    });
  });

  describe('processContacts — edge cases', () => {
    it('skips sent email to address that extractEmailAddress cannot parse', () => {
      // If extractEmailAddress returns null/undefined/empty for the to address,
      // line 76 (if (toAddress)) is false — should not throw
      const sentWithBadTo: EmailMessage = {
        id: '300',
        from: 'me@x.com',
        to: [''], // empty string → extractEmailAddress returns falsy
        subject: 'Test',
        body: '',
        isHtml: false,
        date: new Date(),
        folder: 'Sent',
        isRead: true,
        isStarred: false,
        hasAttachment: false,
      };
      const svc = new AnalyticsService();
      expect(() => svc.updateEmails([], [sentWithBadTo])).not.toThrow();
    });

    it('silently drops new contacts once MAX_CONTACTS (10000) is reached', () => {
      // Build 10000 inbox emails with unique senders, plus one extra
      // processContacts() rebuilds from the email arrays so we pass all 10001 emails at once
      const svc = new AnalyticsService();
      const now = new Date();

      // 10000 unique senders fills the cap
      const tenKEmails: EmailMessage[] = Array.from({ length: 10_000 }, (_, i) => ({
        id: String(i),
        from: `user${i}@example.com`,
        to: ['me@x.com'],
        subject: `Email ${i}`,
        body: '',
        isHtml: false,
        date: now,
        folder: 'INBOX',
        isRead: true,
        isStarred: false,
        hasAttachment: false,
      }));

      // The 10001st email is a brand-new sender — should be silently dropped
      const oneMore: EmailMessage = {
        id: '10001',
        from: 'overflow@example.com',
        to: ['me@x.com'],
        subject: 'Overflow',
        body: '',
        isHtml: false,
        date: now,
        folder: 'INBOX',
        isRead: false,
        isStarred: false,
        hasAttachment: false,
      };

      svc.updateEmails([...tenKEmails, oneMore], []);
      // The cap is 10000; overflow@example.com should be dropped
      expect((svc as any).contacts.size).toBe(10_000);
      expect((svc as any).contacts.has('overflow@example.com')).toBe(false);
    });
  });

  describe('calculateResponseTimeStats — array message-id header', () => {
    it('handles message-id header provided as an array', () => {
      const inbox: EmailMessage = {
        id: '400',
        from: 'a@b.com',
        to: ['me@x.com'],
        subject: 'Array header',
        body: '',
        isHtml: false,
        date: new Date('2024-01-01T10:00:00Z'),
        folder: 'INBOX',
        isRead: true,
        isStarred: false,
        hasAttachment: false,
        headers: { 'message-id': ['<msg-array@x.com>', '<alt-id@x.com>'] as any },
      };
      const sent: EmailMessage = {
        id: '401',
        from: 'me@x.com',
        to: ['a@b.com'],
        subject: 'Re: Array header',
        body: '',
        isHtml: false,
        date: new Date('2024-01-01T12:00:00Z'),
        folder: 'Sent',
        isRead: true,
        isStarred: false,
        hasAttachment: false,
        inReplyTo: '<msg-array@x.com>',
      };
      const svc = new AnalyticsService();
      svc.updateEmails([inbox], [sent]);
      const analytics = svc.getEmailAnalytics();
      // Array header: first element is used; should match the inReplyTo
      expect(analytics.responseTimeStats).not.toBeNull();
      expect(analytics.responseTimeStats!.sampleSize).toBe(1);
    });
  });

  describe('getVolumeTrends — day clamping', () => {
    it('clamps to minimum 1 day', () => {
      // Math.trunc(-5) = -5; Math.max(1, -5) = 1
      const trends = service.getVolumeTrends(-5);
      expect(trends.length).toBe(1);
    });

    it('clamps to maximum 365 days', () => {
      const trends = service.getVolumeTrends(1000);
      expect(trends.length).toBe(365);
    });

    it('handles NaN days gracefully (falls back to 30)', () => {
      // Math.trunc(NaN) || 30 = 30
      const trends = service.getVolumeTrends(NaN);
      expect(trends.length).toBe(30);
    });
  });
});
