import { describe, it, expect } from 'vitest';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import {
  parseEmails,
  parseEmailsDetailed,
  formatDate,
  parseDate,
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
  requireNumericEmailId,
  requireNumericEmailIds,
  validateAttachments,
  validateAttachmentLimits,
  validateImapPath,
  sanitizeAttachments,
  attachmentByteSize,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_COUNT,
  clampOptionalInt,
  requireNonEmptyString,
  validateLeafName,
  validateRequiredTargetFolder,
  optionalSourceFolder,
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

    it('should extract address from "Display Name <email>" format', () => {
      expect(parseEmails('John Doe <john@example.com>')).toEqual(['john@example.com']);
    });

    it('should handle mixed bare and display-name addresses', () => {
      expect(parseEmails('alice@example.com, Bob Smith <bob@example.com>')).toEqual([
        'alice@example.com',
        'bob@example.com',
      ]);
    });

    it('should drop display-name entries with invalid inner address', () => {
      expect(parseEmails('Bad Guy <not-an-email>')).toEqual([]);
    });
  });

  describe('parseEmailsDetailed (SMTP-014)', () => {
    it('reports both valid and dropped addresses on partial failure', () => {
      const { valid, dropped } = parseEmailsDetailed('alice@x.com, bogus, bob@y.com');
      expect(valid).toEqual(['alice@x.com', 'bob@y.com']);
      expect(dropped).toEqual(['bogus']);
    });

    it('reports no drops when all addresses are valid', () => {
      const { valid, dropped } = parseEmailsDetailed('a@x.com, b@y.com');
      expect(valid).toEqual(['a@x.com', 'b@y.com']);
      expect(dropped).toEqual([]);
    });

    it('parseEmails remains backward-compatible (valid only)', () => {
      expect(parseEmails('alice@x.com, bogus, bob@y.com')).toEqual(['alice@x.com', 'bob@y.com']);
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

    it('rejects email exceeding 320 total characters (RFC 5321)', () => {
      // 64 chars local + @ + 253 chars domain = 318, +3 more = 321 total
      const local = 'a'.repeat(64);
      const domain = 'b'.repeat(253) + '.com'; // 257 chars (still > 253)
      expect(isValidEmail(`${local}@${'x'.repeat(254)}.com`)).toBe(false);
    });

    it('rejects email with domain exceeding 253 characters (RFC 5321)', () => {
      const local = 'user';
      const domain = 'x'.repeat(250) + '.com'; // 254 chars
      expect(isValidEmail(`${local}@${domain}`)).toBe(false);
    });

    it('rejects email with control characters', () => {
      expect(isValidEmail('test\x00@example.com')).toBe(false);
      expect(isValidEmail('test\n@example.com')).toBe(false);
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

    it('returns an error when targetFolder is a non-string (e.g. number)', () => {
      expect(validateTargetFolder(42)).toMatch(/must be a string/i);
    });

    it('returns an error when targetFolder is an object', () => {
      expect(validateTargetFolder({ folder: 'INBOX' })).toMatch(/must be a string/i);
    });
  });

  describe('requireNumericEmailId', () => {
    // Valid cases — helper should return the string unchanged.
    it('returns "42" unchanged', () => {
      expect(requireNumericEmailId('42')).toBe('42');
    });

    it('returns "1" unchanged', () => {
      expect(requireNumericEmailId('1')).toBe('1');
    });

    it('returns "999999" unchanged', () => {
      expect(requireNumericEmailId('999999')).toBe('999999');
    });

    // Custom fieldName is reflected in the error message.
    it('uses custom fieldName in error message', () => {
      expect(() => requireNumericEmailId('bad', 'email_id')).toThrowError(
        'email_id must be a non-empty numeric UID string.'
      );
    });

    it('defaults fieldName to "emailId" when not supplied', () => {
      expect(() => requireNumericEmailId('abc')).toThrowError(
        'emailId must be a non-empty numeric UID string.'
      );
    });

    // Error cases — helper should throw McpError(InvalidParams, …).
    it('throws McpError with ErrorCode.InvalidParams for empty string', () => {
      const err = (() => { try { requireNumericEmailId(''); } catch (e) { return e; } })();
      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).code).toBe(ErrorCode.InvalidParams);
    });

    it('throws for alphabetic string "abc"', () => {
      expect(() => requireNumericEmailId('abc')).toThrow(McpError);
    });

    it('throws for mixed string "12x"', () => {
      expect(() => requireNumericEmailId('12x')).toThrow(McpError);
    });

    it('throws for negative string "-5"', () => {
      expect(() => requireNumericEmailId('-5')).toThrow(McpError);
    });

    it('throws for float string "3.14"', () => {
      expect(() => requireNumericEmailId('3.14')).toThrow(McpError);
    });

    it('accepts the 32-bit unsigned max (4294967295)', () => {
      expect(requireNumericEmailId('4294967295')).toBe('4294967295');
    });

    it('throws for a 10-digit value above the 32-bit max ("9999999999")', () => {
      expect(() => requireNumericEmailId('9999999999')).toThrow(McpError);
    });

    it('throws for null', () => {
      expect(() => requireNumericEmailId(null)).toThrow(McpError);
    });

    it('throws for undefined', () => {
      expect(() => requireNumericEmailId(undefined)).toThrow(McpError);
    });

    it('throws for numeric type (not a string)', () => {
      expect(() => requireNumericEmailId(42)).toThrow(McpError);
    });

    it('throws for null-byte string "5\\x006"', () => {
      expect(() => requireNumericEmailId('5\x006')).toThrow(McpError);
    });
  });

  describe('requireNumericEmailIds', () => {
    it('keeps valid UIDs, skips malformed entries, and honors the batch cap', () => {
      expect(requireNumericEmailIds(['1', 'bad', '2', '3'], 2)).toEqual(['1', '2']);
    });

    it('rejects an empty or wholly-invalid bulk request', () => {
      expect(() => requireNumericEmailIds([], 10)).toThrow(McpError);
      expect(() => requireNumericEmailIds(['bad', '-1'], 10)).toThrow(McpError);
    });

    it('applies the single-UID range guard to bulk requests', () => {
      expect(() => requireNumericEmailIds(['9999999999'], 10)).toThrow(McpError);
    });
  });

  // ── Cycle #15: validateAttachments ─────────────────────────────────────────

  describe('validateAttachments', () => {
    // null / undefined — attachment field is optional
    it('returns null for undefined (omitted field)', () => {
      expect(validateAttachments(undefined)).toBeNull();
    });

    it('returns null for null (omitted field)', () => {
      expect(validateAttachments(null)).toBeNull();
    });

    // non-array
    it('returns error for a plain object (not an array)', () => {
      expect(validateAttachments({ filename: 'x.txt', content: 'abc' })).not.toBeNull();
    });

    it('returns error for a string', () => {
      expect(validateAttachments('file.txt')).not.toBeNull();
    });

    it('returns error for a number', () => {
      expect(validateAttachments(42)).not.toBeNull();
    });

    // empty array — valid (no attachments)
    it('returns null for an empty array', () => {
      expect(validateAttachments([])).toBeNull();
    });

    // well-formed attachments
    it('returns null for a valid attachment with string content', () => {
      expect(validateAttachments([
        { filename: 'report.pdf', content: 'base64data==', contentType: 'application/pdf' },
      ])).toBeNull();
    });

    it('returns null for a valid attachment with Buffer content', () => {
      expect(validateAttachments([
        { filename: 'image.png', content: Buffer.from('data'), contentType: 'image/png' },
      ])).toBeNull();
    });

    it('returns null when contentType is omitted', () => {
      expect(validateAttachments([
        { filename: 'data.bin', content: 'abc123' },
      ])).toBeNull();
    });

    it('returns null for multiple valid attachments', () => {
      expect(validateAttachments([
        { filename: 'a.txt', content: 'hello' },
        { filename: 'b.pdf', content: Buffer.from('pdf'), contentType: 'application/pdf' },
      ])).toBeNull();
    });

    // malformed array items
    it('returns error for a primitive item in array (string)', () => {
      const err = validateAttachments(['not-an-object']);
      expect(err).not.toBeNull();
      expect(err).toMatch(/attachments\[0\]/);
    });

    it('returns error for a null item in array', () => {
      const err = validateAttachments([null]);
      expect(err).not.toBeNull();
      expect(err).toMatch(/attachments\[0\]/);
    });

    it('returns error for a number item in array', () => {
      expect(validateAttachments([42])).not.toBeNull();
    });

    // missing/invalid filename
    it('returns error when filename is missing', () => {
      const err = validateAttachments([{ content: 'abc' }]);
      expect(err).not.toBeNull();
      expect(err).toMatch(/filename/);
    });

    it('returns error when filename is an empty string', () => {
      const err = validateAttachments([{ filename: '', content: 'abc' }]);
      expect(err).not.toBeNull();
      expect(err).toMatch(/filename/);
    });

    it('returns error when filename is a number', () => {
      const err = validateAttachments([{ filename: 123, content: 'abc' }]);
      expect(err).not.toBeNull();
      expect(err).toMatch(/filename/);
    });

    // missing/invalid content
    it('returns error when content is missing', () => {
      const err = validateAttachments([{ filename: 'file.txt' }]);
      expect(err).not.toBeNull();
      expect(err).toMatch(/content/);
    });

    it('returns error when content is null', () => {
      const err = validateAttachments([{ filename: 'file.txt', content: null }]);
      expect(err).not.toBeNull();
      expect(err).toMatch(/content/);
    });

    it('returns error when content is a number', () => {
      const err = validateAttachments([{ filename: 'file.txt', content: 42 }]);
      expect(err).not.toBeNull();
      expect(err).toMatch(/content/);
    });

    it('returns error when content is a plain object (stream-like)', () => {
      const err = validateAttachments([{ filename: 'file.txt', content: { pipe: () => {} } }]);
      expect(err).not.toBeNull();
      expect(err).toMatch(/content/);
    });

    // invalid contentType
    it('returns error when contentType is a number', () => {
      const err = validateAttachments([{ filename: 'file.txt', content: 'abc', contentType: 42 }]);
      expect(err).not.toBeNull();
      expect(err).toMatch(/contentType/);
    });

    it('returns error when contentType is an object', () => {
      const err = validateAttachments([{ filename: 'file.txt', content: 'abc', contentType: {} }]);
      expect(err).not.toBeNull();
      expect(err).toMatch(/contentType/);
    });

    // error index is correctly reported for second item
    it('reports the correct index when the second attachment is malformed', () => {
      const err = validateAttachments([
        { filename: 'good.txt', content: 'ok' },
        { filename: 'bad.txt', content: 99 },
      ]);
      expect(err).not.toBeNull();
      expect(err).toMatch(/attachments\[1\]/);
    });

    // VALID-006 — per-file and aggregate byte caps
    it('VALID-006: rejects a single attachment whose decoded size exceeds the per-file cap', () => {
      // base64 length ~= bytes / 0.75; build a string just over the cap
      const bigBase64 = 'A'.repeat(Math.ceil((MAX_ATTACHMENT_BYTES + 1) / 0.75) + 8);
      const err = validateAttachments([{ filename: 'huge.bin', content: bigBase64 }]);
      expect(err).not.toBeNull();
      expect(err).toMatch(/too large/i);
    });

    it('VALID-006: rejects when the aggregate size exceeds the total cap', () => {
      // Two files each ~60% of the cap → individually fine, together over.
      const halfish = 'A'.repeat(Math.ceil((MAX_ATTACHMENT_BYTES * 0.6) / 0.75));
      const err = validateAttachments([
        { filename: 'a.bin', content: halfish },
        { filename: 'b.bin', content: halfish },
      ]);
      expect(err).not.toBeNull();
      expect(err).toMatch(/total attachment size/i);
    });

    it('VALID-005/006: count cap is now MAX_ATTACHMENT_COUNT (20), matching the send path', () => {
      const many = Array.from({ length: MAX_ATTACHMENT_COUNT + 1 }, (_, i) => ({ filename: `f${i}`, content: 'x' }));
      const err = validateAttachments(many);
      expect(err).not.toBeNull();
      expect(err).toMatch(new RegExp(`${MAX_ATTACHMENT_COUNT}`));
    });
  });

  // ── VALID-003: unified full-path validator ─────────────────────────────────
  describe('validateImapPath (VALID-003)', () => {
    it('accepts a plain folder name', () => {
      expect(validateImapPath('INBOX')).toBeNull();
    });
    it('accepts a path with separators (full path)', () => {
      expect(validateImapPath('Folders/Work')).toBeNull();
    });
    it('rejects empty / whitespace', () => {
      expect(validateImapPath('')).toMatch(/non-empty/i);
      expect(validateImapPath('   ')).toMatch(/non-empty/i);
    });
    it('rejects path traversal', () => {
      expect(validateImapPath('Folders/../etc')).toMatch(/invalid characters/i);
    });
    it('rejects C0 control characters', () => {
      expect(validateImapPath('Work\x00hack')).toMatch(/invalid characters/i);
      expect(validateImapPath('Work\r\nA1 LOGOUT')).toMatch(/invalid characters/i);
    });
    it('rejects > 1000 chars, allows 1000', () => {
      expect(validateImapPath('c'.repeat(1001))).toMatch(/exceeds maximum length/i);
      expect(validateImapPath('c'.repeat(1000))).toBeNull();
    });
    it('rejects non-strings', () => {
      expect(validateImapPath(42)).toMatch(/non-empty string/i);
    });
  });

  // ── VALID-015: attachment shape sanitisation ───────────────────────────────
  describe('sanitizeAttachments (VALID-015)', () => {
    it('returns undefined for omitted attachments', () => {
      expect(sanitizeAttachments(undefined)).toBeUndefined();
      expect(sanitizeAttachments(null)).toBeUndefined();
    });
    it('strips attacker-controlled extra keys (path/href/raw/encoding)', () => {
      const out = sanitizeAttachments([
        { filename: 'x.txt', content: 'abc', contentType: 'text/plain',
          path: '/etc/passwd', href: 'http://evil', raw: 'X', encoding: 'binary' },
      ]);
      expect(out).toHaveLength(1);
      const a = out![0] as Record<string, unknown>;
      expect(a.filename).toBe('x.txt');
      expect(a.content).toBe('abc');
      expect(a.contentType).toBe('text/plain');
      expect(a.path).toBeUndefined();
      expect(a.href).toBeUndefined();
      expect(a.raw).toBeUndefined();
      expect(a.encoding).toBeUndefined();
    });
    it('preserves contentId when present', () => {
      const out = sanitizeAttachments([{ filename: 'x', content: 'y', contentId: 'cid1' }]);
      expect(out![0].contentId).toBe('cid1');
    });
  });

  describe('attachmentByteSize', () => {
    it('sizes a Buffer exactly', () => {
      expect(attachmentByteSize(Buffer.alloc(100))).toBe(100);
    });
    it('estimates base64 string at ~3/4 length', () => {
      expect(attachmentByteSize('A'.repeat(100))).toBe(75);
    });
    it('returns null for non-string/non-Buffer', () => {
      expect(attachmentByteSize({ pipe() {} })).toBeNull();
    });
  });

  // ─── parseDate ──────────────────────────────────────────────────────────────

  describe('parseDate', () => {
    it('parses a valid ISO date string', () => {
      const d = parseDate('2024-01-15T10:30:00.000Z');
      expect(d).toBeInstanceOf(Date);
      expect(d.toISOString()).toBe('2024-01-15T10:30:00.000Z');
    });

    it('parses a date-only string', () => {
      const d = parseDate('2024-06-01');
      expect(d).toBeInstanceOf(Date);
      expect(isNaN(d.getTime())).toBe(false);
    });

    it('returns an invalid Date for a bad string (consistent with new Date())', () => {
      const d = parseDate('not-a-date');
      expect(isNaN(d.getTime())).toBe(true);
    });
  });

  describe('clampOptionalInt', () => {
    it('returns the clamped fallback for undefined/null/non-number', () => {
      expect(clampOptionalInt(undefined, 100, 1, 500)).toBe(100);
      expect(clampOptionalInt(null, 100, 1, 500)).toBe(100);
      expect(clampOptionalInt('50', 100, 1, 500)).toBe(100);
    });
    it('collapses NaN/Infinity/-Infinity to the fallback', () => {
      expect(clampOptionalInt(Number.NaN, 100, 1, 500)).toBe(100);
      expect(clampOptionalInt(Infinity, 100, 1, 500)).toBe(100);
      expect(clampOptionalInt(-Infinity, 100, 1, 500)).toBe(100);
    });
    it('clamps a negative finite value up to min', () => {
      expect(clampOptionalInt(-50, 100, 1, 500)).toBe(1);
    });
    it('clamps an over-large value down to max', () => {
      expect(clampOptionalInt(99999, 100, 1, 500)).toBe(500);
    });
    it('truncates toward zero before clamping', () => {
      expect(clampOptionalInt(42.9, 100, 1, 500)).toBe(42);
    });
    it('clamps the fallback itself into range', () => {
      expect(clampOptionalInt(undefined, 9999, 1, 200)).toBe(200);
    });
  });

  describe('requireNonEmptyString', () => {
    it('returns the trimmed value for a valid string', () => {
      expect(requireNonEmptyString('  hi  ', 'field')).toBe('hi');
    });
    it('throws on empty/whitespace/non-string', () => {
      expect(() => requireNonEmptyString('', 'reason')).toThrow(McpError);
      expect(() => requireNonEmptyString('   ', 'reason')).toThrow(McpError);
      expect(() => requireNonEmptyString(undefined, 'reason')).toThrow(McpError);
      expect(() => requireNonEmptyString(42, 'reason')).toThrow(McpError);
    });
  });

  // ── v3.0.62 low-severity validator sweep ───────────────────────────────────

  describe('validateLeafName (VALID-004 shared core)', () => {
    it('uses the provided field name in the error', () => {
      expect(validateLeafName('', 'widget')).toMatch(/widget must be a non-empty/i);
    });
    it('rejects slash, traversal and control chars', () => {
      expect(validateLeafName('a/b', 'x')).toMatch(/invalid characters/i);
      expect(validateLeafName('..', 'x')).toMatch(/invalid characters/i);
      expect(validateLeafName('a\x00b', 'x')).toMatch(/invalid characters/i);
    });
    it('accepts a plain leaf', () => {
      expect(validateLeafName('Work', 'x')).toBeNull();
    });
  });

  describe('VALID-007 — leaf/path validators reject DEL and C1 controls', () => {
    it('validateLabelName rejects DEL (0x7f) and C1 (0x80-0x9f)', () => {
      expect(validateLabelName('a\x7fb')).toMatch(/invalid characters/i);
      expect(validateLabelName('a\x85b')).toMatch(/invalid characters/i);
    });
    it('validateFolderName rejects DEL and C1', () => {
      expect(validateFolderName('a\x7fb')).toMatch(/invalid characters/i);
      expect(validateFolderName('a\x9fb')).toMatch(/invalid characters/i);
    });
    it('validateTargetFolder and validateImapPath reject DEL', () => {
      expect(validateTargetFolder('Folders/a\x7fb')).toMatch(/invalid characters/i);
      expect(validateImapPath('Folders/a\x7fb')).toMatch(/invalid characters/i);
    });
  });

  describe('VALID-008 — requireNumericEmailId bounds', () => {
    it('accepts a normal UID', () => {
      expect(requireNumericEmailId('12345')).toBe('12345');
    });
    it('accepts the literal "0"', () => {
      expect(requireNumericEmailId('0')).toBe('0');
    });
    it('rejects leading zeros', () => {
      expect(() => requireNumericEmailId('0000001')).toThrow(McpError);
    });
    it('rejects over-length numeric strings (>10 digits)', () => {
      expect(() => requireNumericEmailId('123456789012345')).toThrow(McpError);
    });
  });

  describe('VALID-010 — parseEmails per-token cap', () => {
    it('drops a pathologically long token but keeps valid neighbours', () => {
      const huge = 'x'.repeat(5000) + '@example.com';
      expect(parseEmails(`good@example.com, ${huge}`)).toEqual(['good@example.com']);
    });
  });

  describe('VALID-011 — validateRequiredTargetFolder', () => {
    it('returns the trimmed name', () => {
      expect(validateRequiredTargetFolder('  Folders/Work  ', 'folderName')).toBe('Folders/Work');
    });
    it('throws on empty/whitespace/non-string', () => {
      expect(() => validateRequiredTargetFolder('', 'folderName')).toThrow(McpError);
      expect(() => validateRequiredTargetFolder('   ', 'folderName')).toThrow(McpError);
      expect(() => validateRequiredTargetFolder(undefined, 'folderName')).toThrow(McpError);
    });
    it('throws on invalid chars', () => {
      expect(() => validateRequiredTargetFolder('a..b', 'folderName')).toThrow(McpError);
    });
  });

  describe('VALID-012 — validateImapPath rejects edge whitespace', () => {
    it('rejects leading/trailing whitespace', () => {
      expect(validateImapPath(' INBOX')).toMatch(/whitespace/i);
      expect(validateImapPath('INBOX ')).toMatch(/whitespace/i);
    });
    it('accepts a clean path', () => {
      expect(validateImapPath('Folders/Work')).toBeNull();
    });
  });

  describe('VALID-018 — validateAttachments filename hardening', () => {
    it('rejects path separators and traversal in filename', () => {
      expect(validateAttachments([{ filename: '../../etc/passwd', content: 'aGk=' }])).toMatch(/path separators/i);
      expect(validateAttachments([{ filename: 'a\\b', content: 'aGk=' }])).toMatch(/path separators/i);
    });
    it('rejects an over-length filename', () => {
      expect(validateAttachments([{ filename: 'x'.repeat(300), content: 'aGk=' }])).toMatch(/maximum length/i);
    });
    it('accepts a clean filename', () => {
      expect(validateAttachments([{ filename: 'report.pdf', content: 'aGk=' }])).toBeNull();
    });
  });

  describe('VALID-021 — optionalSourceFolder (shared)', () => {
    it('returns undefined for omitted/empty', () => {
      expect(optionalSourceFolder(undefined)).toBeUndefined();
      expect(optionalSourceFolder('')).toBeUndefined();
    });
    it('returns a valid full path', () => {
      expect(optionalSourceFolder('Folders/Work')).toBe('Folders/Work');
    });
    it('throws on non-string and invalid path', () => {
      expect(() => optionalSourceFolder(42)).toThrow(McpError);
      expect(() => optionalSourceFolder('a..b')).toThrow(McpError);
    });
    it('rejects leading/trailing whitespace so the gate matches the service', () => {
      // validateImapPath (what the service uses) rejects " INBOX"; the tool gate
      // must agree and throw a clean McpError rather than passing it through.
      expect(() => optionalSourceFolder(' INBOX')).toThrow(McpError);
      expect(() => optionalSourceFolder('INBOX ')).toThrow(McpError);
    });
  });

  describe('PARSE-020 — extractEmailAddress anchoring', () => {
    it('extracts the trailing address, not the first bracket pair', () => {
      expect(extractEmailAddress('<bogus> "Alice" <real@x.com>')).toBe('real@x.com');
    });
    it('still handles a normal display-name form', () => {
      expect(extractEmailAddress('Alice <alice@x.com>')).toBe('alice@x.com');
    });
    it('falls back to the trimmed input when no bracket pair matches', () => {
      expect(extractEmailAddress('  plain@x.com  ')).toBe('plain@x.com');
    });
  });

  describe('validateAttachmentLimits (service-layer count/size caps)', () => {
    const big = 'a'.repeat(35 * 1024 * 1024); // ~26MB base64 -> over 25MB/file
    it('accepts a normal attachment set', () => {
      expect(validateAttachmentLimits([{ filename: 'a.pdf', content: 'aGVsbG8=' }])).toBeNull();
      expect(validateAttachmentLimits([])).toBeNull();
    });
    it('rejects too many attachments', () => {
      const many = Array.from({ length: 21 }, () => ({ content: 'aa' }));
      expect(validateAttachmentLimits(many)).toMatch(/Too many attachments/);
    });
    it('rejects a single oversized attachment', () => {
      expect(validateAttachmentLimits([{ filename: 'big', content: big }])).toMatch(/is too large/);
    });
    it('rejects when the total exceeds the cap', () => {
      const half = 'a'.repeat(20 * 1024 * 1024);
      expect(validateAttachmentLimits([{ content: half }, { content: half }])).toMatch(/Total attachment size/);
    });
    it('rejects non-Buffer/non-string content (e.g. a stream)', () => {
      expect(validateAttachmentLimits([{ filename: 'x', content: {} as unknown }])).toMatch(/must be a Buffer or base64 string/);
    });
  });

});
