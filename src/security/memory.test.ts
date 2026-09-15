import { describe, it, expect } from 'vitest';
import { scrubEmail } from './memory.js';
import type { EmailMessage } from '../types/index.js';

function makeEmail(overrides: Partial<EmailMessage> = {}): EmailMessage {
  return {
    id: '1',
    from: 'sender@example.com',
    to: ['recipient@example.com'],
    subject: 'Test Subject',
    body: 'Test Body with sensitive content',
    isHtml: false,
    date: new Date(),
    folder: 'INBOX',
    isRead: false,
    isStarred: false,
    hasAttachment: false,
    ...overrides,
  };
}

describe('scrubEmail', () => {
  it('should overwrite body and subject ', () => {
    const email = makeEmail({ body: 'Sensitive body', subject: 'Sensitive subject' });
    scrubEmail(email);

    expect(email.body).toBe('');
    expect(email.subject).toBe('');
  });

  it('scrubs attachments with Buffer content (fills zeros and clears filename)', () => {
    const content = Buffer.from('sensitive attachment data');
    const email = makeEmail({
      attachments: [
        { filename: 'secret.pdf', content, size: content.length, contentType: 'application/pdf' },
      ],
      hasAttachment: true,
    });
    scrubEmail(email);

    // Buffer was zeroed by fill(0)
    expect(content.every((b) => b === 0)).toBe(true);
    // att.content set to undefined and filename cleared
    expect(email.attachments![0].content).toBeUndefined();
    expect(email.attachments![0].filename).toBe('');
  });

  it('handles attachments with non-Buffer content (string base64)', () => {
    const email = makeEmail({
      attachments: [
        { filename: 'doc.txt', content: 'base64encodedstring', size: 20, contentType: 'text/plain' },
      ],
      hasAttachment: true,
    });
    expect(() => scrubEmail(email)).not.toThrow();
    expect(email.attachments![0].content).toBeUndefined();
    expect(email.attachments![0].filename).toBe('');
  });

  it('handles emails with empty/falsy body, subject, and from fields without error', () => {
    // Exercises the "if (email.body)" false branch in scrubEmail
    const email = makeEmail({ body: '', subject: '', from: '' });
    expect(() => scrubEmail(email)).not.toThrow();
    // Fields remain empty (no-op assignment skipped)
    expect(email.body).toBe('');
    expect(email.subject).toBe('');
  });
});
