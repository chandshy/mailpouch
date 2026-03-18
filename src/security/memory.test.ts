import { describe, it, expect } from 'vitest';
import {
  SecureBuffer,
  wipeString,
  wipeObject,
  wipeEmailCache,
  wipeEmailArray,
} from './memory.js';
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

describe('SecureBuffer', () => {
  it('should store and retrieve a secret', () => {
    const sb = new SecureBuffer('my-secret-password');
    expect(sb.toString()).toBe('my-secret-password');
    expect(sb.isWiped).toBe(false);
  });

  it('should zero the buffer on wipe', () => {
    const sb = new SecureBuffer('sensitive');
    sb.wipe();
    expect(sb.isWiped).toBe(true);
  });

  it('should throw when reading a wiped buffer', () => {
    const sb = new SecureBuffer('secret');
    sb.wipe();
    expect(() => sb.toString()).toThrow('SecureBuffer has been wiped');
  });

  it('should be idempotent on multiple wipes', () => {
    const sb = new SecureBuffer('data');
    sb.wipe();
    sb.wipe();
    expect(sb.isWiped).toBe(true);
  });
});

describe('wipeString', () => {
  it('should overwrite and delete a string property', () => {
    const obj = { password: 'secret123', name: 'test' };
    wipeString(obj, 'password');
    expect(obj.password).toBeUndefined();
    expect(obj.name).toBe('test');
  });

  it('should handle missing properties gracefully', () => {
    const obj = { name: 'test' };
    wipeString(obj, 'nonexistent');
    expect(obj).toEqual({ name: 'test' });
  });

  it('should skip non-string properties', () => {
    const obj = { count: 42 } as any;
    wipeString(obj, 'count');
    expect(obj.count).toBe(42);
  });
});

describe('wipeObject', () => {
  it('should wipe multiple keys', () => {
    const obj = { password: 'secret', token: 'abc', name: 'test' };
    wipeObject(obj, ['password', 'token']);
    expect(obj.password).toBeUndefined();
    expect(obj.token).toBeUndefined();
    expect(obj.name).toBe('test');
  });
});

describe('wipeEmailCache', () => {
  it('should scrub all emails and clear the map', () => {
    const cache = new Map<string, EmailMessage>();
    cache.set('1', makeEmail({ body: 'Confidential info' }));
    cache.set('2', makeEmail({ body: 'More secrets', subject: 'Secret Subject' }));

    wipeEmailCache(cache);

    expect(cache.size).toBe(0);
  });

  it('should overwrite body and subject before clearing', () => {
    const email = makeEmail({ body: 'Sensitive body', subject: 'Sensitive subject' });
    const cache = new Map<string, EmailMessage>();
    cache.set('1', email);

    wipeEmailCache(cache);

    // The email object itself should have been scrubbed
    expect(email.body).toBe('');
    expect(email.subject).toBe('');
  });
});

describe('wipeEmailArray', () => {
  it('should scrub all emails and return empty array', () => {
    const emails = [
      makeEmail({ body: 'Body 1' }),
      makeEmail({ body: 'Body 2' }),
    ];

    const result = wipeEmailArray(emails);

    expect(result).toEqual([]);
    expect(emails.length).toBe(0);
  });

  it('should overwrite body and subject of each email', () => {
    const email = makeEmail({ body: 'Private', subject: 'Private Subject' });
    const emails = [email];

    wipeEmailArray(emails);

    expect(email.body).toBe('');
    expect(email.subject).toBe('');
  });
});
