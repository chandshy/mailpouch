import { describe, it, expect } from 'vitest';
import {
  parseEmails,
  formatDate,
  truncate,
  isValidEmail,
  extractEmailAddress,
  extractName,
  sanitizeForLog,
  formatBytes,
  bytesToMB,
  validateLabelName,
  validateFolderName,
  validateTargetFolder,
} from './helpers.js';

describe('helpers', () => {
  describe('parseEmails', () => {
    it('should parse single email', () => {
      expect(parseEmails('test@example.com')).toEqual(['test@example.com']);
    });

    it('should parse comma-separated emails', () => {
      expect(parseEmails('test1@example.com, test2@example.com')).toEqual([
        'test1@example.com',
        'test2@example.com',
      ]);
    });

    it('should filter invalid emails', () => {
      expect(parseEmails('valid@example.com, invalid')).toEqual(['valid@example.com']);
    });

    it('should filter empty strings', () => {
      expect(parseEmails('test@example.com,  , ')).toEqual(['test@example.com']);
    });

    it('should handle empty input', () => {
      expect(parseEmails('')).toEqual([]);
    });
  });

  describe('formatDate', () => {
    it('should format date to ISO string', () => {
      const date = new Date('2024-01-15T10:30:00Z');
      expect(formatDate(date)).toBe('2024-01-15T10:30:00.000Z');
    });
  });

  describe('truncate', () => {
    it('should not truncate text shorter than limit', () => {
      expect(truncate('Hello', 10)).toBe('Hello');
    });

    it('should truncate text longer than limit', () => {
      expect(truncate('Hello World', 5)).toBe('He...');
    });

    it('should handle empty string', () => {
      expect(truncate('', 10)).toBe('');
    });
  });

  describe('isValidEmail', () => {
    it('should validate correct email', () => {
      expect(isValidEmail('test@example.com')).toBe(true);
    });

    it('should validate email with subdomain', () => {
      expect(isValidEmail('test@mail.example.com')).toBe(true);
    });

    it('should validate email with plus addressing', () => {
      expect(isValidEmail('test+label@example.com')).toBe(true);
    });

    it('should reject email without @', () => {
      expect(isValidEmail('testexample.com')).toBe(false);
    });

    it('should reject email without domain', () => {
      expect(isValidEmail('test@')).toBe(false);
    });

    it('should reject email without username', () => {
      expect(isValidEmail('@example.com')).toBe(false);
    });

    it('should reject empty string', () => {
      expect(isValidEmail('')).toBe(false);
    });

    it('should reject email with spaces', () => {
      expect(isValidEmail('test @example.com')).toBe(false);
    });
  });

  describe('extractEmailAddress', () => {
    it('should extract email from formatted string', () => {
      expect(extractEmailAddress('John Doe <john@example.com>')).toBe('john@example.com');
    });

    it('should return plain email if no brackets', () => {
      expect(extractEmailAddress('john@example.com')).toBe('john@example.com');
    });

    it('should handle whitespace', () => {
      expect(extractEmailAddress('  john@example.com  ')).toBe('john@example.com');
    });
  });

  describe('extractName', () => {
    it('should extract name from formatted string', () => {
      expect(extractName('John Doe <john@example.com>')).toBe('John Doe');
    });

    it('should return undefined if no name', () => {
      expect(extractName('john@example.com')).toBeUndefined();
    });
  });

  describe('sanitizeForLog', () => {
    it('should remove newlines and tabs', () => {
      expect(sanitizeForLog('Hello\nWorld\tTest')).toBe('Hello World Test');
    });

    it('should truncate long strings', () => {
      const longText = 'a'.repeat(150);
      const result = sanitizeForLog(longText, 50);
      expect(result).toHaveLength(53); // 50 + '...'
    });

    it('should handle empty string', () => {
      expect(sanitizeForLog('')).toBe('');
    });
  });

  describe('formatBytes', () => {
    it('should format zero bytes', () => {
      expect(formatBytes(0)).toBe('0 Bytes');
    });

    it('should format bytes', () => {
      expect(formatBytes(1024)).toBe('1 KB');
    });

    it('should format kilobytes', () => {
      expect(formatBytes(1024 * 1024)).toBe('1 MB');
    });
  });

  describe('bytesToMB', () => {
    it('should convert bytes to MB', () => {
      expect(bytesToMB(1024 * 1024)).toBe(1);
    });

    it('should handle zero', () => {
      expect(bytesToMB(0)).toBe(0);
    });
  });

  // ── validateLabelName ──────────────────────────────────────────────────────
  // These tests cover the validation added in Cycle #1 to prevent IMAP path
  // traversal attacks in get_emails_by_label, move_to_label, and bulk_move_to_label.

  describe('validateLabelName', () => {
    it('returns null for a valid label name', () => {
      expect(validateLabelName('Work')).toBeNull();
    });

    it('returns null for a label with spaces and hyphens', () => {
      expect(validateLabelName('My Important-Label')).toBeNull();
    });

    it('returns an error for an empty string', () => {
      expect(validateLabelName('')).toMatch(/non-empty/i);
    });

    it('returns an error for a whitespace-only string', () => {
      expect(validateLabelName('   ')).toMatch(/non-empty/i);
    });

    it('returns an error for a null value', () => {
      expect(validateLabelName(null)).toMatch(/non-empty/i);
    });

    it('returns an error when label contains a forward slash', () => {
      expect(validateLabelName('Work/Personal')).toMatch(/invalid characters/i);
    });

    it('returns an error for a directory traversal with ..', () => {
      expect(validateLabelName('../INBOX')).toMatch(/invalid characters/i);
    });

    it('returns an error when label contains a null byte (control character)', () => {
      expect(validateLabelName('Work\x00Hack')).toMatch(/invalid characters/i);
    });

    it('returns an error when label contains other C0 control characters', () => {
      expect(validateLabelName('Work\x1fHack')).toMatch(/invalid characters/i);
    });

    it('returns an error when label exceeds 255 characters', () => {
      expect(validateLabelName('a'.repeat(256))).toMatch(/exceeds maximum length/i);
    });

    it('returns null for a label exactly 255 characters long', () => {
      expect(validateLabelName('a'.repeat(255))).toBeNull();
    });
  });

  // ── validateFolderName ─────────────────────────────────────────────────────
  // These tests cover the validation added in Cycle #1 for move_to_folder.

  describe('validateFolderName', () => {
    it('returns null for a valid folder name', () => {
      expect(validateFolderName('Projects')).toBeNull();
    });

    it('returns an error for an empty string', () => {
      expect(validateFolderName('')).toMatch(/non-empty/i);
    });

    it('returns an error for a whitespace-only string', () => {
      expect(validateFolderName('   ')).toMatch(/non-empty/i);
    });

    it('returns an error when folder contains a forward slash', () => {
      expect(validateFolderName('Work/Q1')).toMatch(/invalid characters/i);
    });

    it('returns an error for a directory traversal with ..', () => {
      expect(validateFolderName('../INBOX')).toMatch(/invalid characters/i);
    });

    it('returns an error when folder contains control characters', () => {
      expect(validateFolderName('Work\x00')).toMatch(/invalid characters/i);
    });

    it('returns an error when folder name exceeds 255 characters', () => {
      expect(validateFolderName('b'.repeat(256))).toMatch(/exceeds maximum length/i);
    });

    it('returns null for a folder exactly 255 characters long', () => {
      expect(validateFolderName('b'.repeat(255))).toBeNull();
    });
  });

  // ── validateTargetFolder ───────────────────────────────────────────────────
  // Covers remove_label and bulk_remove_label targetFolder validation (Cycle #1).
  // Unlike label/folder, slashes are allowed (full IMAP path), but .. is rejected.

  describe('validateTargetFolder', () => {
    it('returns null when targetFolder is omitted (undefined)', () => {
      expect(validateTargetFolder(undefined)).toBeNull();
    });

    it('returns null when targetFolder is empty string (caller uses default)', () => {
      expect(validateTargetFolder('')).toBeNull();
    });

    it('returns null for a plain folder like INBOX', () => {
      expect(validateTargetFolder('INBOX')).toBeNull();
    });

    it('returns null for a path with a forward slash like Folders/Work', () => {
      expect(validateTargetFolder('Folders/Work')).toBeNull();
    });

    it('returns an error for a path traversal with ..', () => {
      expect(validateTargetFolder('../INBOX')).toMatch(/invalid characters/i);
    });

    it('returns an error for embedded .. in path', () => {
      expect(validateTargetFolder('Folders/../INBOX')).toMatch(/invalid characters/i);
    });

    it('returns an error when targetFolder contains control characters', () => {
      expect(validateTargetFolder('INBOX\x00hack')).toMatch(/invalid characters/i);
    });

    it('returns an error when targetFolder exceeds 1000 characters', () => {
      expect(validateTargetFolder('c'.repeat(1001))).toMatch(/exceeds maximum length/i);
    });

    it('returns null for a targetFolder exactly 1000 characters long', () => {
      expect(validateTargetFolder('c'.repeat(1000))).toBeNull();
    });
  });

  // ── Handler-level validation paths (Cycle #3) ─────────────────────────────
  // The handlers move_email, bulk_move_emails, and send_test_email each call
  // one of the helpers below at the start of their execution.  Since index.ts
  // cannot be imported in tests (it reads process.env and calls process.exit),
  // these test cases exercise the exact helper call + expected error message
  // for each of the three new handler guard paths added in Cycle #3.

  describe('move_email handler validation (validateTargetFolder)', () => {
    // mirrors: const mvValidErr = validateTargetFolder(args.targetFolder);
    //          if (mvValidErr) throw new McpError(ErrorCode.InvalidParams, mvValidErr);

    it('returns null (no error) for a valid targetFolder like INBOX', () => {
      expect(validateTargetFolder('INBOX')).toBeNull();
    });

    it('returns null for a path with slashes like Folders/Archive', () => {
      expect(validateTargetFolder('Folders/Archive')).toBeNull();
    });

    it('returns an error for a traversal payload like ../../etc', () => {
      const err = validateTargetFolder('../../etc');
      expect(err).not.toBeNull();
      expect(err).toMatch(/invalid characters/i);
    });

    it('returns an error for a null-byte injection in targetFolder', () => {
      const err = validateTargetFolder('INBOX\x00payload');
      expect(err).not.toBeNull();
      expect(err).toMatch(/invalid characters/i);
    });

    it('returns an error for a targetFolder that is too long', () => {
      const err = validateTargetFolder('x'.repeat(1001));
      expect(err).not.toBeNull();
      expect(err).toMatch(/exceeds maximum length/i);
    });

    it('returns null when targetFolder is omitted (undefined) — handler uses its own default', () => {
      // move_email always provides args.targetFolder as a string; bulk_move_emails
      // also always has targetFolder from its schema.  This guard tests the helper
      // contract, not the handler schema.
      expect(validateTargetFolder(undefined)).toBeNull();
    });
  });

  describe('bulk_move_emails handler validation (validateTargetFolder)', () => {
    // mirrors: const bmValidErr = validateTargetFolder(args.targetFolder);
    //          if (bmValidErr) throw new McpError(ErrorCode.InvalidParams, bmValidErr);
    // Note: this handler fails fast BEFORE iterating emailIds, so a bad targetFolder
    // means NO emails are moved.

    it('returns null for a valid destination folder', () => {
      expect(validateTargetFolder('Spam')).toBeNull();
    });

    it('returns an error for a path traversal in targetFolder', () => {
      const err = validateTargetFolder('Folders/../INBOX');
      expect(err).not.toBeNull();
      expect(err).toMatch(/invalid characters/i);
    });

    it('returns an error for control characters in targetFolder', () => {
      const err = validateTargetFolder('INBOX\x1f');
      expect(err).not.toBeNull();
      expect(err).toMatch(/invalid characters/i);
    });
  });

  describe('send_test_email handler validation (isValidEmail)', () => {
    // mirrors: if (!isValidEmail(args.to as string))
    //            throw new McpError(ErrorCode.InvalidParams, `Invalid recipient email address: ${args.to}`);

    it('returns true for a valid recipient address', () => {
      expect(isValidEmail('user@example.com')).toBe(true);
    });

    it('returns false for an address missing the domain', () => {
      expect(isValidEmail('user@')).toBe(false);
    });

    it('returns false for an address missing the @ symbol', () => {
      expect(isValidEmail('notanemail')).toBe(false);
    });

    it('returns false for an address with a null byte', () => {
      expect(isValidEmail('user\x00@example.com')).toBe(false);
    });

    it('returns false for an address with a newline (header injection attempt)', () => {
      expect(isValidEmail('user\n@example.com')).toBe(false);
    });

    it('returns false for an empty string', () => {
      expect(isValidEmail('')).toBe(false);
    });

    it('returns false for a local part exceeding 64 characters', () => {
      const longLocal = 'a'.repeat(65);
      expect(isValidEmail(`${longLocal}@example.com`)).toBe(false);
    });
  });
});
