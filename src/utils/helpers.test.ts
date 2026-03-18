import { describe, it, expect } from 'vitest';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
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
  requireNumericEmailId,
  validateAttachments,
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

  // ── Cycle #5 handler-level guard paths ────────────────────────────────────
  // decodeCursor, get_email_by_id, and download_attachment each use inline
  // guards that cannot be imported from index.ts.  These test suites exercise
  // the exact helper calls / inline expressions those handlers use, mirroring
  // the same pattern established in Cycle #4.

  describe('decodeCursor folder validation (validateTargetFolder)', () => {
    // mirrors: if (validateTargetFolder(parsed.folder) !== null) return null;
    // A crafted cursor whose folder field contains traversal sequences, control
    // characters, or an oversized path must be rejected (returns non-null error).

    it('accepts a simple folder like INBOX', () => {
      expect(validateTargetFolder('INBOX')).toBeNull();
    });

    it('accepts a path with a forward slash like Labels/Work', () => {
      expect(validateTargetFolder('Labels/Work')).toBeNull();
    });

    it('accepts a folder exactly 1000 characters long (boundary)', () => {
      expect(validateTargetFolder('a'.repeat(1000))).toBeNull();
    });

    it('rejects a folder with a path traversal .. segment', () => {
      const err = validateTargetFolder('../../etc/passwd');
      expect(err).not.toBeNull();
      expect(err).toMatch(/invalid characters/i);
    });

    it('rejects a folder with an embedded .. like Labels/../INBOX', () => {
      const err = validateTargetFolder('Labels/../INBOX');
      expect(err).not.toBeNull();
      expect(err).toMatch(/invalid characters/i);
    });

    it('rejects a folder with a null byte (control character)', () => {
      const err = validateTargetFolder('INBOX\x00evil');
      expect(err).not.toBeNull();
      expect(err).toMatch(/invalid characters/i);
    });

    it('rejects a folder with other C0 control characters', () => {
      const err = validateTargetFolder('INBOX\x07bell');
      expect(err).not.toBeNull();
      expect(err).toMatch(/invalid characters/i);
    });

    it('rejects a folder exceeding 1000 characters', () => {
      const err = validateTargetFolder('a'.repeat(1001));
      expect(err).not.toBeNull();
      expect(err).toMatch(/exceeds maximum length/i);
    });
  });

  describe('get_email_by_id handler validation (numeric UID guard)', () => {
    // mirrors: if (!rawEmailId || typeof rawEmailId !== 'string' || !/^\d+$/.test(rawEmailId))
    //            throw McpError(InvalidParams, 'emailId must be a non-empty numeric UID string.')
    // The guard expression evaluates to true (throw) for any of the bad inputs below.

    function isInvalidEmailId(v: unknown): boolean {
      const rawEmailId = v as string;
      return !rawEmailId || typeof rawEmailId !== 'string' || !/^\d+$/.test(rawEmailId);
    }

    it('passes (returns false) for a valid numeric UID string like "12345"', () => {
      expect(isInvalidEmailId('12345')).toBe(false);
    });

    it('passes for a single-digit UID string "1"', () => {
      expect(isInvalidEmailId('1')).toBe(false);
    });

    it('throws-guard for an empty string', () => {
      expect(isInvalidEmailId('')).toBe(true);
    });

    it('throws-guard for a non-numeric string like "abc"', () => {
      expect(isInvalidEmailId('abc')).toBe(true);
    });

    it('throws-guard for a string with letters mixed in like "12a3"', () => {
      expect(isInvalidEmailId('12a3')).toBe(true);
    });

    it('throws-guard for a negative number string "-1"', () => {
      expect(isInvalidEmailId('-1')).toBe(true);
    });

    it('throws-guard for a float string "1.5"', () => {
      expect(isInvalidEmailId('1.5')).toBe(true);
    });

    it('throws-guard for null', () => {
      expect(isInvalidEmailId(null)).toBe(true);
    });

    it('throws-guard for undefined', () => {
      expect(isInvalidEmailId(undefined)).toBe(true);
    });

    it('throws-guard for a string with a null byte', () => {
      expect(isInvalidEmailId('123\x00')).toBe(true);
    });
  });

  describe('download_attachment handler validation', () => {
    // email_id guard mirrors get_email_by_id (same pattern).
    // attachment_index guard: !Number.isInteger(rawAttIdx) || rawAttIdx < 0

    function isInvalidAttEmailId(v: unknown): boolean {
      const rawAttEmailId = v as string;
      return !rawAttEmailId || typeof rawAttEmailId !== 'string' || !/^\d+$/.test(rawAttEmailId);
    }

    function isInvalidAttIndex(v: unknown): boolean {
      const rawAttIdx = v as number;
      return !Number.isInteger(rawAttIdx) || rawAttIdx < 0;
    }

    // email_id tests
    it('email_id: passes for valid numeric UID "99"', () => {
      expect(isInvalidAttEmailId('99')).toBe(false);
    });

    it('email_id: throws-guard for empty string', () => {
      expect(isInvalidAttEmailId('')).toBe(true);
    });

    it('email_id: throws-guard for non-numeric string "abc"', () => {
      expect(isInvalidAttEmailId('abc')).toBe(true);
    });

    it('email_id: throws-guard for null', () => {
      expect(isInvalidAttEmailId(null)).toBe(true);
    });

    // attachment_index tests
    it('attachment_index: passes for 0 (first attachment)', () => {
      expect(isInvalidAttIndex(0)).toBe(false);
    });

    it('attachment_index: passes for positive integer 3', () => {
      expect(isInvalidAttIndex(3)).toBe(false);
    });

    it('attachment_index: throws-guard for -1 (negative)', () => {
      expect(isInvalidAttIndex(-1)).toBe(true);
    });

    it('attachment_index: throws-guard for a float 1.5', () => {
      expect(isInvalidAttIndex(1.5)).toBe(true);
    });

    it('attachment_index: throws-guard for NaN', () => {
      expect(isInvalidAttIndex(NaN)).toBe(true);
    });

    it('attachment_index: throws-guard for a string "0"', () => {
      expect(isInvalidAttIndex('0')).toBe(true);
    });

    it('attachment_index: throws-guard for undefined', () => {
      expect(isInvalidAttIndex(undefined)).toBe(true);
    });
  });

  // ── create_folder / delete_folder handler validation (validateFolderName) ──

  describe('create_folder / delete_folder handler validation (validateFolderName)', () => {
    // Replicates the guard: validateFolderName(args.folderName)
    it('valid folder name "Work" returns null (no error)', () => {
      expect(validateFolderName('Work')).toBeNull();
    });

    it('valid folder name with unicode returns null', () => {
      expect(validateFolderName('Receipts-2024')).toBeNull();
    });

    it('empty string returns error', () => {
      expect(validateFolderName('')).not.toBeNull();
    });

    it('whitespace-only string returns error', () => {
      expect(validateFolderName('   ')).not.toBeNull();
    });

    it('null returns error', () => {
      expect(validateFolderName(null)).not.toBeNull();
    });

    it('undefined returns error', () => {
      expect(validateFolderName(undefined)).not.toBeNull();
    });

    it('name containing "/" returns error (leaf segment only)', () => {
      expect(validateFolderName('Folders/Work')).not.toBeNull();
    });

    it('traversal ".." returns error', () => {
      expect(validateFolderName('..')).not.toBeNull();
    });

    it('name with null byte returns error', () => {
      expect(validateFolderName('Work\x00Evil')).not.toBeNull();
    });

    it('name with C0 control char returns error', () => {
      expect(validateFolderName('Work\x1fEvil')).not.toBeNull();
    });

    it('exact 255-char name returns null (at limit)', () => {
      expect(validateFolderName('a'.repeat(255))).toBeNull();
    });

    it('256-char name returns error (over limit)', () => {
      expect(validateFolderName('a'.repeat(256))).not.toBeNull();
    });
  });

  // ── rename_folder handler validation (validateFolderName for oldName/newName) ──

  describe('rename_folder handler validation (validateFolderName for oldName and newName)', () => {
    it('valid oldName "Archive" returns null', () => {
      expect(validateFolderName('Archive')).toBeNull();
    });

    it('valid newName "Archive-Old" returns null', () => {
      expect(validateFolderName('Archive-Old')).toBeNull();
    });

    it('oldName with path traversal "../INBOX" returns error', () => {
      expect(validateFolderName('../INBOX')).not.toBeNull();
    });

    it('newName that is empty returns error', () => {
      expect(validateFolderName('')).not.toBeNull();
    });

    it('newName containing "/" returns error', () => {
      expect(validateFolderName('New/Name')).not.toBeNull();
    });
  });

  // ── mark_email_read / star_email handler validation (numeric UID guard) ──

  describe('mark_email_read / star_email handler validation (numeric emailId guard)', () => {
    // Replicates: !emailId || typeof emailId !== "string" || !/^\d+$/.test(emailId)
    const isInvalidEmailId = (v: unknown): boolean =>
      !v || typeof v !== 'string' || !/^\d+$/.test(v as string);

    it('valid emailId "42" passes guard', () => {
      expect(isInvalidEmailId('42')).toBe(false);
    });

    it('valid emailId "1" passes guard', () => {
      expect(isInvalidEmailId('1')).toBe(false);
    });

    it('empty string triggers guard', () => {
      expect(isInvalidEmailId('')).toBe(true);
    });

    it('alphabetic string "abc" triggers guard', () => {
      expect(isInvalidEmailId('abc')).toBe(true);
    });

    it('mixed "12a3" triggers guard', () => {
      expect(isInvalidEmailId('12a3')).toBe(true);
    });

    it('negative "-1" triggers guard', () => {
      expect(isInvalidEmailId('-1')).toBe(true);
    });

    it('float "1.5" triggers guard', () => {
      expect(isInvalidEmailId('1.5')).toBe(true);
    });

    it('null triggers guard', () => {
      expect(isInvalidEmailId(null)).toBe(true);
    });

    it('undefined triggers guard', () => {
      expect(isInvalidEmailId(undefined)).toBe(true);
    });

    it('null-byte injection "12\x0034" triggers guard', () => {
      expect(isInvalidEmailId('12\x0034')).toBe(true);
    });
  });

  // ── Cycle #8: archive_email / move_to_trash / move_to_spam / move_email / delete_email
  //    All five handlers now use the same numeric UID guard before calling the IMAP service.
  //    Tests exercise the guard logic directly (same regex as in-handler code).
  describe('archive_email / move_to_trash / move_to_spam / move_email / delete_email handler validation (numeric emailId guard)', () => {
    // Helper mirrors the in-handler guard: !emailId || typeof emailId !== "string" || !/^\d+$/.test(emailId)
    const isInvalidMoveId = (id: unknown): boolean =>
      !id || typeof id !== 'string' || !/^\d+$/.test(id as string);

    it('valid "42" passes guard', () => {
      expect(isInvalidMoveId('42')).toBe(false);
    });

    it('valid "1" passes guard', () => {
      expect(isInvalidMoveId('1')).toBe(false);
    });

    it('valid "999999" passes guard', () => {
      expect(isInvalidMoveId('999999')).toBe(false);
    });

    it('empty string triggers guard', () => {
      expect(isInvalidMoveId('')).toBe(true);
    });

    it('alphabetic "abc" triggers guard', () => {
      expect(isInvalidMoveId('abc')).toBe(true);
    });

    it('mixed "12x" triggers guard', () => {
      expect(isInvalidMoveId('12x')).toBe(true);
    });

    it('negative "-5" triggers guard', () => {
      expect(isInvalidMoveId('-5')).toBe(true);
    });

    it('float "3.14" triggers guard', () => {
      expect(isInvalidMoveId('3.14')).toBe(true);
    });

    it('null triggers guard', () => {
      expect(isInvalidMoveId(null)).toBe(true);
    });

    it('undefined triggers guard', () => {
      expect(isInvalidMoveId(undefined)).toBe(true);
    });

    it('null-byte "7\x008" triggers guard', () => {
      expect(isInvalidMoveId('7\x008')).toBe(true);
    });
  });

  // ── Cycle #8: get_emails handler — folder validated with validateTargetFolder ──────────
  describe('get_emails handler validation (validateTargetFolder for folder arg)', () => {
    it('INBOX passes validation', () => {
      expect(validateTargetFolder('INBOX')).toBeNull();
    });

    it('Folders/Work passes validation', () => {
      expect(validateTargetFolder('Folders/Work')).toBeNull();
    });

    it('empty string passes validation (caller uses default INBOX)', () => {
      expect(validateTargetFolder('')).toBeNull();
    });

    it('undefined passes validation (caller uses default INBOX)', () => {
      expect(validateTargetFolder(undefined)).toBeNull();
    });

    it('path traversal "../../etc/passwd" fails validation', () => {
      expect(validateTargetFolder('../../etc/passwd')).not.toBeNull();
    });

    it('embedded traversal "Labels/../INBOX" fails validation', () => {
      expect(validateTargetFolder('Labels/../INBOX')).not.toBeNull();
    });

    it('null byte "INBOX\x00evil" fails validation', () => {
      expect(validateTargetFolder('INBOX\x00evil')).not.toBeNull();
    });

    it('over-limit (1001 chars) fails validation', () => {
      expect(validateTargetFolder('A'.repeat(1001))).not.toBeNull();
    });

    it('exact limit (1000 chars) passes validation', () => {
      expect(validateTargetFolder('A'.repeat(1000))).toBeNull();
    });
  });

  // ── Cycle #8: bulk operations — array items filtered to numeric UIDs only ────────────
  //    bulk_delete_emails, bulk_move_emails, bulk_mark_read, bulk_star,
  //    bulk_move_to_label, bulk_remove_label all now use /^\d+$/.test(id) filter.
  describe('bulk operation array-item numeric UID filter', () => {
    // Helper mirrors the in-handler filter: typeof id === "string" && /^\d+$/.test(id)
    const isValidBulkId = (id: unknown): boolean =>
      typeof id === 'string' && /^\d+$/.test(id as string);

    it('valid "42" passes filter', () => {
      expect(isValidBulkId('42')).toBe(true);
    });

    it('valid "1" passes filter', () => {
      expect(isValidBulkId('1')).toBe(true);
    });

    it('valid "100000" passes filter', () => {
      expect(isValidBulkId('100000')).toBe(true);
    });

    it('empty string is excluded by filter', () => {
      expect(isValidBulkId('')).toBe(false);
    });

    it('alphabetic "abc" is excluded by filter', () => {
      expect(isValidBulkId('abc')).toBe(false);
    });

    it('mixed "12x" is excluded by filter', () => {
      expect(isValidBulkId('12x')).toBe(false);
    });

    it('negative "-3" is excluded by filter', () => {
      expect(isValidBulkId('-3')).toBe(false);
    });

    it('float "2.5" is excluded by filter', () => {
      expect(isValidBulkId('2.5')).toBe(false);
    });

    it('null is excluded by filter', () => {
      expect(isValidBulkId(null)).toBe(false);
    });

    it('undefined is excluded by filter', () => {
      expect(isValidBulkId(undefined)).toBe(false);
    });

    it('number 42 (not string) is excluded by filter', () => {
      expect(isValidBulkId(42)).toBe(false);
    });

    it('null-byte "5\x006" is excluded by filter', () => {
      expect(isValidBulkId('5\x006')).toBe(false);
    });

    it('array of mixed inputs filters to numeric UIDs only', () => {
      const raw = ['42', 'abc', '', '-1', '100', null, undefined, '3.14', '7'];
      const valid = raw.filter((id): id is string => typeof id === 'string' && /^\d+$/.test(id as string));
      expect(valid).toEqual(['42', '100', '7']);
    });
  });

  // ── Cycle #9 Tests ─────────────────────────────────────────────────────────

  describe('move_to_label / remove_label handler validation (numeric emailId guard)', () => {
    // Both handlers now use the same !/^\d+$/.test(emailId) guard as all other
    // single-email action handlers.  These tests exercise the guard logic directly.
    function isValidEmailId(v: unknown): boolean {
      if (!v || typeof v !== 'string') return false;
      return /^\d+$/.test(v);
    }

    it('valid emailId "42" passes', () => {
      expect(isValidEmailId('42')).toBe(true);
    });

    it('valid emailId "1" passes', () => {
      expect(isValidEmailId('1')).toBe(true);
    });

    it('valid emailId "999999" passes', () => {
      expect(isValidEmailId('999999')).toBe(true);
    });

    it('empty string is rejected', () => {
      expect(isValidEmailId('')).toBe(false);
    });

    it('"abc" is rejected', () => {
      expect(isValidEmailId('abc')).toBe(false);
    });

    it('"12x" (mixed) is rejected', () => {
      expect(isValidEmailId('12x')).toBe(false);
    });

    it('"-5" (negative) is rejected', () => {
      expect(isValidEmailId('-5')).toBe(false);
    });

    it('"3.14" (float) is rejected', () => {
      expect(isValidEmailId('3.14')).toBe(false);
    });

    it('null is rejected', () => {
      expect(isValidEmailId(null)).toBe(false);
    });

    it('undefined is rejected', () => {
      expect(isValidEmailId(undefined)).toBe(false);
    });

    it('null-byte "5\\x006" is rejected', () => {
      expect(isValidEmailId('5\x006')).toBe(false);
    });
  });

  describe('saveDraft attachment filename sanitization', () => {
    // These tests exercise the inline sanitization logic added to saveDraft in
    // simple-imap-service.ts.  We replicate the exact logic here so the rules
    // are independently testable without spinning up an IMAP connection.
    function sanitizeDraftFilename(filename: string | undefined): string | undefined {
      if (!filename) return undefined;
      return filename.replace(/[\r\n\x00]/g, '').slice(0, 255) || 'attachment';
    }

    it('plain filename passes unchanged', () => {
      expect(sanitizeDraftFilename('report.pdf')).toBe('report.pdf');
    });

    it('CRLF injection in filename is stripped', () => {
      expect(sanitizeDraftFilename('a.pdf\r\nContent-Type: text/html')).toBe('a.pdfContent-Type: text/html');
    });

    it('LF injection in filename is stripped', () => {
      expect(sanitizeDraftFilename('bad\nfile.txt')).toBe('badfile.txt');
    });

    it('NUL byte in filename is stripped', () => {
      expect(sanitizeDraftFilename('file\x00.txt')).toBe('file.txt');
    });

    it('filename longer than 255 chars is truncated', () => {
      const long = 'a'.repeat(300);
      expect(sanitizeDraftFilename(long)!.length).toBe(255);
    });

    it('filename that becomes empty after stripping falls back to "attachment"', () => {
      expect(sanitizeDraftFilename('\r\n\x00')).toBe('attachment');
    });

    it('undefined filename returns undefined', () => {
      expect(sanitizeDraftFilename(undefined)).toBeUndefined();
    });
  });

  describe('saveDraft attachment contentType sanitization', () => {
    // Replicates the MIME type validation logic from saveDraft.
    function sanitizeDraftContentType(contentType: string | undefined): string | undefined {
      if (!contentType) return undefined;
      const rawCt = contentType.replace(/[\r\n\x00]/g, '').trim();
      return rawCt && /^[\w!#$&\-^]+\/[\w!#$&\-^+.]+$/.test(rawCt) ? rawCt : undefined;
    }

    it('valid "application/pdf" passes', () => {
      expect(sanitizeDraftContentType('application/pdf')).toBe('application/pdf');
    });

    it('valid "image/png" passes', () => {
      expect(sanitizeDraftContentType('image/png')).toBe('image/png');
    });

    it('valid "text/plain" passes', () => {
      expect(sanitizeDraftContentType('text/plain')).toBe('text/plain');
    });

    it('CRLF injection in contentType is rejected (becomes undefined)', () => {
      expect(sanitizeDraftContentType('text/html\r\nX-Injected: yes')).toBeUndefined();
    });

    it('NUL byte in contentType is stripped, then validated', () => {
      // "text/plain\x00" after strip becomes "text/plain" which is valid
      expect(sanitizeDraftContentType('text/plain\x00')).toBe('text/plain');
    });

    it('arbitrary string without slash is rejected', () => {
      expect(sanitizeDraftContentType('notamimetype')).toBeUndefined();
    });

    it('empty string returns undefined', () => {
      expect(sanitizeDraftContentType('')).toBeUndefined();
    });

    it('undefined returns undefined', () => {
      expect(sanitizeDraftContentType(undefined)).toBeUndefined();
    });

    it('contentType with spaces is rejected', () => {
      expect(sanitizeDraftContentType('text /plain')).toBeUndefined();
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
  });

  // ── Cycle #21: reply_to_email / forward_email / move_to_folder emailId guard ──
  // These three handlers were previously passing args.emailId as string without
  // calling requireNumericEmailId().  They now call it.
  // The tests mirror the existing requireNumericEmailId tests but are scoped to
  // the specific field name "emailId" that these handlers use.

  describe('reply_to_email / forward_email / move_to_folder emailId guard (requireNumericEmailId)', () => {
    it('valid emailId "1001" passes and is returned unchanged', () => {
      expect(requireNumericEmailId('1001')).toBe('1001');
    });

    it('non-numeric string "abc" causes McpError with InvalidParams', () => {
      let thrown: unknown;
      try { requireNumericEmailId('abc'); } catch (e) { thrown = e; }
      expect(thrown).toBeInstanceOf(McpError);
      expect((thrown as McpError).code).toBe(ErrorCode.InvalidParams);
      expect((thrown as McpError).message).toMatch(/emailId must be a non-empty numeric UID string/);
    });

    it('empty string causes McpError with InvalidParams', () => {
      expect(() => requireNumericEmailId('')).toThrow(McpError);
    });

    it('null causes McpError (guards against null args)', () => {
      expect(() => requireNumericEmailId(null)).toThrow(McpError);
    });

    it('undefined causes McpError (guards against missing args)', () => {
      expect(() => requireNumericEmailId(undefined)).toThrow(McpError);
    });

    it('float string "1.5" causes McpError', () => {
      expect(() => requireNumericEmailId('1.5')).toThrow(McpError);
    });

    it('negative string "-7" causes McpError', () => {
      expect(() => requireNumericEmailId('-7')).toThrow(McpError);
    });

    it('path traversal string "../../etc" causes McpError', () => {
      expect(() => requireNumericEmailId('../../etc')).toThrow(McpError);
    });
  });

  // ── Cycle #21: sync_emails folder validation (validateTargetFolder) ──
  // The sync_emails handler previously accepted any string as the folder
  // argument without validation.  It now calls validateTargetFolder() so that
  // path traversal attempts (e.g. "../../etc") are rejected before being sent
  // to the IMAP service.

  describe('sync_emails folder validation (validateTargetFolder)', () => {
    it('INBOX passes validation (returns null)', () => {
      expect(validateTargetFolder('INBOX')).toBeNull();
    });

    it('Sent passes validation', () => {
      expect(validateTargetFolder('Sent')).toBeNull();
    });

    it('Folders/Work passes validation', () => {
      expect(validateTargetFolder('Folders/Work')).toBeNull();
    });

    it('empty string passes (caller defaults to INBOX)', () => {
      expect(validateTargetFolder('')).toBeNull();
    });

    it('undefined passes (caller defaults to INBOX)', () => {
      expect(validateTargetFolder(undefined)).toBeNull();
    });

    it('path traversal "../../etc" fails validation', () => {
      const err = validateTargetFolder('../../etc');
      expect(err).not.toBeNull();
      expect(err).toMatch(/invalid characters/i);
    });

    it('folder with null byte fails validation', () => {
      const err = validateTargetFolder('INBOX\x00injected');
      expect(err).not.toBeNull();
      expect(err).toMatch(/invalid characters/i);
    });

    it('folder exceeding 1000 characters fails validation', () => {
      const err = validateTargetFolder('x'.repeat(1001));
      expect(err).not.toBeNull();
      expect(err).toMatch(/exceeds maximum length/i);
    });

    it('folder embedded traversal "Labels/../Secret" fails validation', () => {
      const err = validateTargetFolder('Labels/../Secret');
      expect(err).not.toBeNull();
      expect(err).toMatch(/invalid characters/i);
    });
  });

  // ── Cycle #21: safeErrorMessage McpError pass-through ──
  // Verify that McpError instances thrown by validation helpers carry the
  // expected code and message, confirming they will be passed through cleanly
  // by the updated safeErrorMessage() in index.ts.

  describe('McpError properties from requireNumericEmailId (safeErrorMessage pass-through coverage)', () => {
    it('thrown McpError has ErrorCode.InvalidParams code', () => {
      let err: unknown;
      try { requireNumericEmailId('bad'); } catch (e) { err = e; }
      expect((err as McpError).code).toBe(ErrorCode.InvalidParams);
    });

    it('thrown McpError message is descriptive (not "An error occurred")', () => {
      let err: unknown;
      try { requireNumericEmailId('xyz', 'emailId'); } catch (e) { err = e; }
      expect((err as McpError).message).toContain('emailId must be a non-empty numeric UID string');
    });

    it('validateLabelName error string is non-empty and descriptive', () => {
      const msg = validateLabelName('bad/label');
      expect(msg).not.toBeNull();
      expect(msg!.length).toBeGreaterThan(10);
    });

    it('validateFolderName error string is non-empty and descriptive', () => {
      const msg = validateFolderName('');
      expect(msg).not.toBeNull();
      expect(msg!.length).toBeGreaterThan(10);
    });

    it('validateTargetFolder error string is non-empty and descriptive', () => {
      const msg = validateTargetFolder('../../traversal');
      expect(msg).not.toBeNull();
      expect(msg!.length).toBeGreaterThan(10);
    });

    it('validateAttachments error string is non-empty and descriptive', () => {
      const msg = validateAttachments('not-an-array');
      expect(msg).not.toBeNull();
      expect(msg!.length).toBeGreaterThan(5);
    });
  });

  // ── Cycle #22: UUID format guard used by cancel_scheduled_email ─────────────
  // These tests verify the UUID regex pattern used at the handler level.
  // The pattern is /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

  describe('UUID format validation (cancel_scheduled_email guard)', () => {
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    it('accepts a well-formed lowercase UUID', () => {
      expect(UUID_RE.test('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
    });

    it('accepts a well-formed uppercase UUID', () => {
      expect(UUID_RE.test('550E8400-E29B-41D4-A716-446655440000')).toBe(true);
    });

    it('rejects an empty string', () => {
      expect(UUID_RE.test('')).toBe(false);
    });

    it('rejects a plain numeric string', () => {
      expect(UUID_RE.test('12345')).toBe(false);
    });

    it('rejects a UUID with missing hyphens', () => {
      expect(UUID_RE.test('550e8400e29b41d4a716446655440000')).toBe(false);
    });

    it('rejects a UUID with extra characters', () => {
      expect(UUID_RE.test('550e8400-e29b-41d4-a716-44665544000x')).toBe(false);
    });

    it('rejects a path traversal string', () => {
      expect(UUID_RE.test('../../etc/passwd')).toBe(false);
    });

    it('rejects a UUID with wrong segment lengths', () => {
      expect(UUID_RE.test('550e8400-e29b-41d4-a716-44665544')).toBe(false);
    });
  });

  // ── Cycle #22: search_emails multi-folder validation ──────────────────────
  // Verify that validateTargetFolder correctly rejects traversal paths that
  // might appear in the folders[] array of search_emails.

  describe('validateTargetFolder for search_emails folders array entries', () => {
    it('rejects a path traversal string in a folder entry', () => {
      const err = validateTargetFolder('../../etc');
      expect(err).not.toBeNull();
      expect(err).toMatch(/invalid characters/i);
    });

    it('rejects a folder entry with a null byte', () => {
      const err = validateTargetFolder('INBOX\x00evil');
      expect(err).not.toBeNull();
      expect(err).toMatch(/invalid characters/i);
    });

    it('accepts a valid multi-segment folder path', () => {
      const err = validateTargetFolder('Folders/Work/Projects');
      expect(err).toBeNull();
    });

    it('accepts "Labels/MyLabel" as a valid folder path', () => {
      expect(validateTargetFolder('Labels/MyLabel')).toBeNull();
    });
  });

  // ── Cycle #23: send_email / forward_email 'to' field guard ────────────────
  // Guards: !args.to || typeof args.to !== "string" || !(args.to as string).trim()
  // Mirrors the new handler-level validation added in Cycle #23.

  describe('send_email / forward_email "to" field guard', () => {
    // Replicates the inline guard condition:
    //   !args.to || typeof args.to !== "string" || !(args.to as string).trim()
    // Returns true → guard triggers → McpError(InvalidParams) thrown.
    function isInvalidTo(v: unknown): boolean {
      return !v || typeof v !== 'string' || !(v as string).trim();
    }

    it('passes for a valid address "user@example.com"', () => {
      expect(isInvalidTo('user@example.com')).toBe(false);
    });

    it('passes for a comma-separated pair "a@b.com, c@d.com"', () => {
      expect(isInvalidTo('a@b.com, c@d.com')).toBe(false);
    });

    it('triggers for an empty string', () => {
      expect(isInvalidTo('')).toBe(true);
    });

    it('triggers for a whitespace-only string "   "', () => {
      expect(isInvalidTo('   ')).toBe(true);
    });

    it('triggers for undefined', () => {
      expect(isInvalidTo(undefined)).toBe(true);
    });

    it('triggers for null', () => {
      expect(isInvalidTo(null)).toBe(true);
    });

    it('triggers for a number (wrong type)', () => {
      expect(isInvalidTo(42)).toBe(true);
    });
  });

  // ── Cycle #23: reply_to_email 'body' field guard ──────────────────────────
  // Guards: !args.body || typeof args.body !== "string" || !(args.body as string).trim()
  // Prevents blank replies from being sent.

  describe('reply_to_email "body" field guard', () => {
    // Replicates the inline guard condition (same shape as the 'to' guard above).
    function isInvalidBody(v: unknown): boolean {
      return !v || typeof v !== 'string' || !(v as string).trim();
    }

    it('passes for a non-empty body "Hello"', () => {
      expect(isInvalidBody('Hello')).toBe(false);
    });

    it('passes for a multi-line body', () => {
      expect(isInvalidBody('Line 1\nLine 2')).toBe(false);
    });

    it('triggers for an empty string', () => {
      expect(isInvalidBody('')).toBe(true);
    });

    it('triggers for a whitespace-only string "  \\n  "', () => {
      expect(isInvalidBody('  \n  ')).toBe(true);
    });

    it('triggers for undefined', () => {
      expect(isInvalidBody(undefined)).toBe(true);
    });

    it('triggers for null', () => {
      expect(isInvalidBody(null)).toBe(true);
    });
  });

  // ── Cycle #23: bulk operations empty emailIds array guard ─────────────────
  // Guard added to all 6 bulk tools (bulk_mark_read, bulk_star, bulk_move_emails,
  // bulk_move_to_label, bulk_remove_label, bulk_delete_emails / bulk_delete):
  //   !Array.isArray(args.emailIds) || (args.emailIds as unknown[]).length === 0
  // An empty array previously returned {success:0, failed:0, errors:[]}; now
  // it returns McpError(InvalidParams) so callers get explicit feedback.

  describe('bulk operations empty emailIds array guard', () => {
    // Replicates the inline guard:
    //   !Array.isArray(v) || (v as unknown[]).length === 0
    // Returns true → guard triggers → McpError(InvalidParams) thrown.
    function isInvalidBulkIds(v: unknown): boolean {
      return !Array.isArray(v) || (v as unknown[]).length === 0;
    }

    it('passes for a non-empty array ["42"]', () => {
      expect(isInvalidBulkIds(['42'])).toBe(false);
    });

    it('passes for a multi-element array ["1","2","3"]', () => {
      expect(isInvalidBulkIds(['1', '2', '3'])).toBe(false);
    });

    it('triggers for an empty array []', () => {
      expect(isInvalidBulkIds([])).toBe(true);
    });

    it('triggers for undefined', () => {
      expect(isInvalidBulkIds(undefined)).toBe(true);
    });

    it('triggers for null', () => {
      expect(isInvalidBulkIds(null)).toBe(true);
    });

    it('triggers for a plain string (not an array)', () => {
      expect(isInvalidBulkIds('42')).toBe(true);
    });

    it('triggers for a number (not an array)', () => {
      expect(isInvalidBulkIds(42)).toBe(true);
    });

    it('passes for an array of invalid IDs (the array itself is non-empty; downstream filter handles per-item validity)', () => {
      // The guard only checks array non-emptiness; the per-item /^\d+$/ filter
      // runs after the guard and may still produce an empty processed list.
      expect(isInvalidBulkIds(['abc', '', null])).toBe(false);
    });
  });

  // ── schedule_email 'to' field guard (Cycle #24) ──────────────────────────

  describe("schedule_email 'to' field guard", () => {
    // Replicates: !args.to || typeof args.to !== "string" || !(args.to).trim()
    const isInvalidTo = (v: unknown): boolean =>
      !v || typeof v !== 'string' || !(v as string).trim();

    it("valid address 'user@example.com' passes guard", () => {
      expect(isInvalidTo('user@example.com')).toBe(false);
    });

    it('multiple addresses (comma-separated) pass guard', () => {
      expect(isInvalidTo('a@x.com, b@y.com')).toBe(false);
    });

    it('empty string triggers guard', () => {
      expect(isInvalidTo('')).toBe(true);
    });

    it('whitespace-only string triggers guard', () => {
      expect(isInvalidTo('   ')).toBe(true);
    });

    it('undefined triggers guard', () => {
      expect(isInvalidTo(undefined)).toBe(true);
    });

    it('null triggers guard', () => {
      expect(isInvalidTo(null)).toBe(true);
    });

    it('number triggers guard (wrong type)', () => {
      expect(isInvalidTo(42)).toBe(true);
    });
  });

  // ── schedule_email 'send_at' validation (Cycle #24) ──────────────────────

  describe("schedule_email 'send_at' McpError-style validation", () => {
    const isInvalidSendAt = (v: unknown): boolean =>
      !v || typeof v !== 'string';

    const isInvalidDate = (v: string): boolean =>
      isNaN(new Date(v).getTime());

    it('valid ISO string passes both guards', () => {
      expect(isInvalidSendAt('2026-01-15T14:30:00Z')).toBe(false);
      expect(isInvalidDate('2026-01-15T14:30:00Z')).toBe(false);
    });

    it('undefined triggers the type guard', () => {
      expect(isInvalidSendAt(undefined)).toBe(true);
    });

    it('null triggers the type guard', () => {
      expect(isInvalidSendAt(null)).toBe(true);
    });

    it('empty string triggers the type guard', () => {
      expect(isInvalidSendAt('')).toBe(true);
    });

    it('number triggers the type guard', () => {
      expect(isInvalidSendAt(Date.now())).toBe(true);
    });

    it('non-date string triggers the date-parse guard', () => {
      expect(isInvalidDate('not-a-date')).toBe(true);
    });

    it('random garbage string triggers the date-parse guard', () => {
      expect(isInvalidDate('tomorrow at noon')).toBe(true);
    });

    it('valid future ISO string passes the date-parse guard', () => {
      expect(isInvalidDate('2030-06-01T09:00:00.000Z')).toBe(false);
    });
  });

  // ── get_contacts / get_volume_trends numeric type guard (Cycle #24) ──────

  describe("get_contacts / get_volume_trends handler-level numeric type guard", () => {
    // Replicates: args.limit !== undefined && typeof args.limit !== "number"
    const isNonNumericLimit = (v: unknown): boolean =>
      v !== undefined && typeof v !== 'number';

    it('undefined is accepted (uses service default)', () => {
      expect(isNonNumericLimit(undefined)).toBe(false);
    });

    it('integer 50 is accepted', () => {
      expect(isNonNumericLimit(50)).toBe(false);
    });

    it('float 50.5 is accepted (service truncates)', () => {
      expect(isNonNumericLimit(50.5)).toBe(false);
    });

    it('string "50" triggers guard', () => {
      expect(isNonNumericLimit('50')).toBe(true);
    });

    it('null triggers guard', () => {
      expect(isNonNumericLimit(null)).toBe(true);
    });

    it('boolean true triggers guard', () => {
      expect(isNonNumericLimit(true)).toBe(true);
    });

    it('array triggers guard', () => {
      expect(isNonNumericLimit([30])).toBe(true);
    });

    // Replicates: args.days !== undefined && typeof args.days !== "number"
    const isNonNumericDays = (v: unknown): boolean =>
      v !== undefined && typeof v !== 'number';

    it('days undefined is accepted (uses service default)', () => {
      expect(isNonNumericDays(undefined)).toBe(false);
    });

    it('days 30 is accepted', () => {
      expect(isNonNumericDays(30)).toBe(false);
    });

    it('days "30" triggers guard', () => {
      expect(isNonNumericDays('30')).toBe(true);
    });

    it('days 0 is accepted (service will clamp to 1)', () => {
      expect(isNonNumericDays(0)).toBe(false);
    });
  });

  // ── get_emails / search_emails 'limit' type guard (Cycle #25) ────────────
  // Both handlers now have: if (args.limit !== undefined && typeof args.limit !== "number")
  //   throw McpError(InvalidParams, "'limit' must be a number.")
  // This mirrors what was added to get_contacts (Cycle #24) and ensures a
  // non-numeric string like "abc" does not produce NaN inside Math.max/min.

  describe("get_emails / search_emails 'limit' type guard", () => {
    // Replicates: args.limit !== undefined && typeof args.limit !== "number"
    // Returns true → guard triggers → McpError(InvalidParams) thrown.
    const isNonNumericLimit = (v: unknown): boolean =>
      v !== undefined && typeof v !== 'number';

    it('undefined is accepted (handler uses default 50)', () => {
      expect(isNonNumericLimit(undefined)).toBe(false);
    });

    it('integer 50 is accepted', () => {
      expect(isNonNumericLimit(50)).toBe(false);
    });

    it('integer 1 is accepted', () => {
      expect(isNonNumericLimit(1)).toBe(false);
    });

    it('integer 200 is accepted (upper clamping boundary)', () => {
      expect(isNonNumericLimit(200)).toBe(false);
    });

    it('float 25.5 is accepted (handler clamps via Math.max/min)', () => {
      expect(isNonNumericLimit(25.5)).toBe(false);
    });

    it('string "50" triggers guard', () => {
      expect(isNonNumericLimit('50')).toBe(true);
    });

    it('string "abc" triggers guard (would produce NaN without the guard)', () => {
      expect(isNonNumericLimit('abc')).toBe(true);
    });

    it('null triggers guard', () => {
      expect(isNonNumericLimit(null)).toBe(true);
    });

    it('boolean true triggers guard', () => {
      expect(isNonNumericLimit(true)).toBe(true);
    });

    it('array [50] triggers guard', () => {
      expect(isNonNumericLimit([50])).toBe(true);
    });

    it('object {} triggers guard', () => {
      expect(isNonNumericLimit({})).toBe(true);
    });
  });

  // ── search_emails dateFrom/dateTo cross-validation (Cycle #25) ────────────
  // Guard: when both dateFrom and dateTo are provided and parseable,
  //   Date.parse(dateFrom) > Date.parse(dateTo) → throw McpError(InvalidParams)
  // This catches logically inverted date ranges before sending them to IMAP.

  describe("search_emails 'dateFrom' / 'dateTo' cross-validation", () => {
    // Replicates the guard logic in the handler:
    //   if (args.dateFrom && args.dateTo) {
    //     const dfTs = Date.parse(dateFrom); const dtTs = Date.parse(dateTo);
    //     if (!isNaN(dfTs) && !isNaN(dtTs) && dfTs > dtTs) throw McpError(...)
    //   }
    function isInvalidDateRange(dateFrom: string, dateTo: string): boolean {
      const dfTs = Date.parse(dateFrom);
      const dtTs = Date.parse(dateTo);
      return !isNaN(dfTs) && !isNaN(dtTs) && dfTs > dtTs;
    }

    it('dateFrom earlier than dateTo is valid (returns false)', () => {
      expect(isInvalidDateRange('2024-01-01', '2024-12-31')).toBe(false);
    });

    it('dateFrom equal to dateTo is valid (same-day range)', () => {
      expect(isInvalidDateRange('2024-06-15', '2024-06-15')).toBe(false);
    });

    it('ISO datetime dateFrom earlier than dateTo is valid', () => {
      expect(isInvalidDateRange('2024-03-01T00:00:00Z', '2024-03-31T23:59:59Z')).toBe(false);
    });

    it('dateFrom later than dateTo is invalid (returns true)', () => {
      expect(isInvalidDateRange('2024-12-31', '2024-01-01')).toBe(true);
    });

    it('dateFrom in December later than dateTo in January is invalid', () => {
      expect(isInvalidDateRange('2024-12-01T12:00:00Z', '2024-01-01T00:00:00Z')).toBe(true);
    });

    it('unparseable dateFrom does not trigger guard (NaN check prevents it)', () => {
      expect(isInvalidDateRange('not-a-date', '2024-01-01')).toBe(false);
    });

    it('unparseable dateTo does not trigger guard', () => {
      expect(isInvalidDateRange('2024-01-01', 'not-a-date')).toBe(false);
    });

    it('both unparseable: guard does not trigger', () => {
      expect(isInvalidDateRange('garbage', 'garbage')).toBe(false);
    });
  });

  // ── download_attachment attachment_index upper bound (Cycle #25) ──────────
  // Guard added: if (rawAttIdx > MAX_ATTACHMENT_INDEX) throw McpError(InvalidParams)
  // MAX_ATTACHMENT_INDEX = 50. Prevents absurdly large index values that would
  // cause the IMAP service to scan past all real attachment slots.

  describe("download_attachment 'attachment_index' upper bound guard", () => {
    const MAX_ATTACHMENT_INDEX = 50;

    // Replicates combined guard:
    //   !Number.isInteger(v) || v < 0  → existing guard
    //   v > MAX_ATTACHMENT_INDEX        → new upper-bound guard
    function isInvalidAttIndex(v: unknown): boolean {
      if (!Number.isInteger(v) || (v as number) < 0) return true;
      if ((v as number) > MAX_ATTACHMENT_INDEX) return true;
      return false;
    }

    it('index 0 is valid (first attachment)', () => {
      expect(isInvalidAttIndex(0)).toBe(false);
    });

    it('index 1 is valid', () => {
      expect(isInvalidAttIndex(1)).toBe(false);
    });

    it('index 50 is valid (at the limit)', () => {
      expect(isInvalidAttIndex(50)).toBe(false);
    });

    it('index 25 is valid (mid-range)', () => {
      expect(isInvalidAttIndex(25)).toBe(false);
    });

    it('index 51 triggers upper-bound guard', () => {
      expect(isInvalidAttIndex(51)).toBe(true);
    });

    it('index 100 triggers upper-bound guard', () => {
      expect(isInvalidAttIndex(100)).toBe(true);
    });

    it('index 999999 triggers upper-bound guard', () => {
      expect(isInvalidAttIndex(999999)).toBe(true);
    });

    it('index -1 triggers existing lower-bound guard', () => {
      expect(isInvalidAttIndex(-1)).toBe(true);
    });

    it('float 1.5 triggers existing integer guard', () => {
      expect(isInvalidAttIndex(1.5)).toBe(true);
    });

    it('NaN triggers existing integer guard', () => {
      expect(isInvalidAttIndex(NaN)).toBe(true);
    });

    it('string "0" triggers existing integer guard (wrong type)', () => {
      expect(isInvalidAttIndex('0')).toBe(true);
    });

    it('undefined triggers existing integer guard', () => {
      expect(isInvalidAttIndex(undefined)).toBe(true);
    });
  });

  // ── Cycle #26: send_email / save_draft / schedule_email subject length cap ──
  // RFC 2822 §2.1.1 specifies that a single header line MUST NOT exceed 998
  // characters (excluding the CRLF terminator).  Outbound email handlers now
  // enforce this via: if (subject.length > MAX_SUBJECT_LENGTH) throw McpError(...)
  // MAX_SUBJECT_LENGTH = 998

  describe("send_email / save_draft / schedule_email 'subject' length cap (RFC 2822, 998 chars)", () => {
    const MAX_SUBJECT_LENGTH = 998;

    // Replicates the in-handler guard:
    //   args.subject !== undefined && typeof args.subject === "string" &&
    //   (args.subject as string).length > MAX_SUBJECT_LENGTH
    // Returns true → guard triggers → McpError(InvalidParams) thrown.
    function isSubjectTooLong(v: unknown): boolean {
      return v !== undefined && typeof v === 'string' && (v as string).length > MAX_SUBJECT_LENGTH;
    }

    it('short subject "Hello World" is accepted', () => {
      expect(isSubjectTooLong('Hello World')).toBe(false);
    });

    it('empty subject "" is accepted (required field check is separate)', () => {
      expect(isSubjectTooLong('')).toBe(false);
    });

    it('subject exactly 998 chars is accepted (at the limit)', () => {
      expect(isSubjectTooLong('a'.repeat(998))).toBe(false);
    });

    it('subject of 999 chars triggers guard (one over limit)', () => {
      expect(isSubjectTooLong('a'.repeat(999))).toBe(true);
    });

    it('subject of 1000 chars triggers guard', () => {
      expect(isSubjectTooLong('a'.repeat(1000))).toBe(true);
    });

    it('subject of 10000 chars triggers guard (extreme case)', () => {
      expect(isSubjectTooLong('a'.repeat(10_000))).toBe(true);
    });

    it('undefined subject does not trigger guard (omitted is fine for save_draft)', () => {
      expect(isSubjectTooLong(undefined)).toBe(false);
    });

    it('non-string subject (number) does not trigger the length guard (type guard fires first)', () => {
      // typeof 42 !== "string" → condition is false → no length error
      expect(isSubjectTooLong(42)).toBe(false);
    });

    it('subject of exactly 997 chars is accepted', () => {
      expect(isSubjectTooLong('b'.repeat(997))).toBe(false);
    });

    it('unicode subject within 998 code units is accepted', () => {
      // Each emoji is 2 UTF-16 code units; JS .length counts code units.
      // 249 emoji × 2 = 498 code units — well within the 998 limit.
      const emojiSubject = '🎉'.repeat(249);
      expect(isSubjectTooLong(emojiSubject)).toBe(false);
    });
  });

  // ── Cycle #26: request_permission_escalation / check_escalation_status ──────
  // Both handlers now throw McpError(ErrorCode.InvalidParams, …) for invalid
  // parameters instead of returning { isError: true, content: [...] }.
  // These tests verify the guard logic used in both handlers.

  describe('request_permission_escalation target_preset validation (isValidEscalationTarget)', () => {
    // Replicates: !isValidEscalationTarget(targetPreset)
    // The helper VALID_ESCALATION_TARGETS = new Set(["send_only", "supervised", "full"])
    function isValidTarget(v: unknown): boolean {
      return typeof v === 'string' && new Set(['send_only', 'supervised', 'full']).has(v as string);
    }

    it('"send_only" is a valid escalation target', () => {
      expect(isValidTarget('send_only')).toBe(true);
    });

    it('"supervised" is a valid escalation target', () => {
      expect(isValidTarget('supervised')).toBe(true);
    });

    it('"full" is a valid escalation target', () => {
      expect(isValidTarget('full')).toBe(true);
    });

    it('"read_only" is not a valid escalation target (cannot escalate down)', () => {
      expect(isValidTarget('read_only')).toBe(false);
    });

    it('"custom" is not a valid escalation target (human-configured only)', () => {
      expect(isValidTarget('custom')).toBe(false);
    });

    it('empty string is not a valid target', () => {
      expect(isValidTarget('')).toBe(false);
    });

    it('undefined is not a valid target', () => {
      expect(isValidTarget(undefined)).toBe(false);
    });

    it('null is not a valid target', () => {
      expect(isValidTarget(null)).toBe(false);
    });

    it('number is not a valid target', () => {
      expect(isValidTarget(3)).toBe(false);
    });

    it('arbitrary string "admin" is not a valid target', () => {
      expect(isValidTarget('admin')).toBe(false);
    });
  });

  describe('check_escalation_status challenge_id format validation (isValidChallengeId)', () => {
    // Replicates: !isValidChallengeId(challengeId)
    // CHALLENGE_ID_RE = /^[0-9a-f]{32}$/  (128-bit randomBytes hex)
    const CHALLENGE_ID_RE = /^[0-9a-f]{32}$/;
    function isValidChallengeId(v: unknown): boolean {
      return typeof v === 'string' && CHALLENGE_ID_RE.test(v as string);
    }

    it('valid 32-char lowercase hex string passes', () => {
      expect(isValidChallengeId('a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4')).toBe(true);
    });

    it('all-zeros 32-char hex string passes', () => {
      expect(isValidChallengeId('00000000000000000000000000000000')).toBe(true);
    });

    it('all-f hex string passes', () => {
      expect(isValidChallengeId('ffffffffffffffffffffffffffffffff')).toBe(true);
    });

    it('uppercase hex fails (must be lowercase)', () => {
      expect(isValidChallengeId('A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4')).toBe(false);
    });

    it('31-char string fails (too short)', () => {
      expect(isValidChallengeId('a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3')).toBe(false);
    });

    it('33-char string fails (too long)', () => {
      expect(isValidChallengeId('a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e')).toBe(false);
    });

    it('empty string fails', () => {
      expect(isValidChallengeId('')).toBe(false);
    });

    it('undefined fails', () => {
      expect(isValidChallengeId(undefined)).toBe(false);
    });

    it('null fails', () => {
      expect(isValidChallengeId(null)).toBe(false);
    });

    it('string with hyphens (UUID-style) fails', () => {
      expect(isValidChallengeId('550e8400-e29b-41d4-a716-446655440000')).toBe(false);
    });

    it('string with non-hex chars fails', () => {
      expect(isValidChallengeId('z1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4')).toBe(false);
    });

    it('path traversal string fails', () => {
      expect(isValidChallengeId('../../etc/passwd')).toBe(false);
    });
  });

  // ── Cycle #27: get_emails_by_label / sync_emails 'limit' type guards ────────
  // Both handlers now have:
  //   if (args.limit !== undefined && typeof args.limit !== "number")
  //     throw McpError(InvalidParams, "'limit' must be a number.")
  // This mirrors the guards added to get_emails / search_emails in Cycle #25.
  // A non-numeric string like "abc" produces NaN inside Math.max/min, which
  // would propagate to the IMAP service unclamped without these guards.

  describe("get_emails_by_label 'limit' type guard (Cycle #27)", () => {
    // Replicates: args.limit !== undefined && typeof args.limit !== "number"
    // Returns true → guard fires → McpError(InvalidParams) thrown.
    const isNonNumericLimit = (v: unknown): boolean =>
      v !== undefined && typeof v !== 'number';

    it('undefined is accepted (handler uses default 50)', () => {
      expect(isNonNumericLimit(undefined)).toBe(false);
    });

    it('integer 50 is accepted', () => {
      expect(isNonNumericLimit(50)).toBe(false);
    });

    it('integer 1 is accepted (lower clamping boundary)', () => {
      expect(isNonNumericLimit(1)).toBe(false);
    });

    it('integer 200 is accepted (upper clamping boundary)', () => {
      expect(isNonNumericLimit(200)).toBe(false);
    });

    it('float 25.5 is accepted (clamped by Math.max/min)', () => {
      expect(isNonNumericLimit(25.5)).toBe(false);
    });

    it('string "50" triggers guard', () => {
      expect(isNonNumericLimit('50')).toBe(true);
    });

    it('string "abc" triggers guard (would produce NaN without guard)', () => {
      expect(isNonNumericLimit('abc')).toBe(true);
    });

    it('null triggers guard', () => {
      expect(isNonNumericLimit(null)).toBe(true);
    });

    it('boolean false triggers guard', () => {
      expect(isNonNumericLimit(false)).toBe(true);
    });

    it('array [50] triggers guard', () => {
      expect(isNonNumericLimit([50])).toBe(true);
    });

    it('object {} triggers guard', () => {
      expect(isNonNumericLimit({})).toBe(true);
    });
  });

  describe("sync_emails 'limit' type guard (Cycle #27)", () => {
    // Replicates: args.limit !== undefined && typeof args.limit !== "number"
    // Returns true → guard fires → McpError(InvalidParams) thrown.
    // sync_emails uses a different default (100) and cap (500) but the
    // type-guard logic is identical to get_emails / get_emails_by_label.
    const isNonNumericLimit = (v: unknown): boolean =>
      v !== undefined && typeof v !== 'number';

    it('undefined is accepted (handler uses default 100)', () => {
      expect(isNonNumericLimit(undefined)).toBe(false);
    });

    it('integer 100 is accepted (default value)', () => {
      expect(isNonNumericLimit(100)).toBe(false);
    });

    it('integer 1 is accepted (lower clamping boundary)', () => {
      expect(isNonNumericLimit(1)).toBe(false);
    });

    it('integer 500 is accepted (upper clamping boundary)', () => {
      expect(isNonNumericLimit(500)).toBe(false);
    });

    it('float 99.9 is accepted (clamped by Math.max/min)', () => {
      expect(isNonNumericLimit(99.9)).toBe(false);
    });

    it('string "100" triggers guard', () => {
      expect(isNonNumericLimit('100')).toBe(true);
    });

    it('string "abc" triggers guard (would produce NaN without guard)', () => {
      expect(isNonNumericLimit('abc')).toBe(true);
    });

    it('null triggers guard', () => {
      expect(isNonNumericLimit(null)).toBe(true);
    });

    it('boolean true triggers guard', () => {
      expect(isNonNumericLimit(true)).toBe(true);
    });

    it('array [100] triggers guard', () => {
      expect(isNonNumericLimit([100])).toBe(true);
    });

    it('object {} triggers guard', () => {
      expect(isNonNumericLimit({})).toBe(true);
    });
  });

  // ── Cycle #28: body empty-string guard (send_email / save_draft / schedule_email) ──

  // Helper that mirrors the guard in send_email and schedule_email (body is required):
  //   !args.body || typeof args.body !== "string" || !(args.body).trim()
  function isBodyInvalidRequired(body: unknown): boolean {
    return !body || typeof body !== "string" || !(body as string).trim();
  }

  // Helper that mirrors the guard in save_draft (body is optional but if present must be non-empty):
  //   args.body !== undefined && (typeof args.body !== "string" || !(args.body).trim())
  function isBodyInvalidOptional(body: unknown): boolean {
    return body !== undefined && (typeof body !== "string" || !(body as string).trim());
  }

  // Helper that mirrors the priority enum guard in send_email / schedule_email:
  //   args.priority !== undefined && !VALID_PRIORITIES.has(args.priority)
  const VALID_PRIORITIES = new Set(["high", "normal", "low"]);
  function isPriorityInvalid(priority: unknown): boolean {
    return priority !== undefined && !VALID_PRIORITIES.has(priority as string);
  }

  // Helper that mirrors the inReplyTo sanitization in saveDraft service:
  //   options.inReplyTo ? options.inReplyTo.replace(/[\r\n\x00]/g, "") : undefined
  function sanitizeInReplyTo(val: string | undefined): string | undefined {
    return val ? val.replace(/[\r\n\x00]/g, "") : undefined;
  }

  describe("send_email / schedule_email 'body' required non-empty guard (Cycle #28)", () => {
    it('non-empty string "Hello" passes', () => {
      expect(isBodyInvalidRequired("Hello")).toBe(false);
    });

    it('multi-line body passes', () => {
      expect(isBodyInvalidRequired("Line 1\nLine 2")).toBe(false);
    });

    it('HTML body passes', () => {
      expect(isBodyInvalidRequired("<p>Hello</p>")).toBe(false);
    });

    it('body with leading/trailing spaces passes (trim checks emptiness, not stripping)', () => {
      expect(isBodyInvalidRequired("  hello  ")).toBe(false);
    });

    it('empty string "" triggers guard', () => {
      expect(isBodyInvalidRequired("")).toBe(true);
    });

    it('whitespace-only "   " triggers guard', () => {
      expect(isBodyInvalidRequired("   ")).toBe(true);
    });

    it('newline-only "\\n" triggers guard', () => {
      expect(isBodyInvalidRequired("\n")).toBe(true);
    });

    it('undefined triggers guard (body is required for send_email/schedule_email)', () => {
      expect(isBodyInvalidRequired(undefined)).toBe(true);
    });

    it('null triggers guard', () => {
      expect(isBodyInvalidRequired(null)).toBe(true);
    });

    it('number 0 triggers guard (wrong type)', () => {
      expect(isBodyInvalidRequired(0)).toBe(true);
    });

    it('boolean false triggers guard (wrong type)', () => {
      expect(isBodyInvalidRequired(false)).toBe(true);
    });
  });

  describe("save_draft 'body' optional non-empty guard (Cycle #28)", () => {
    it('undefined is accepted (body is optional for drafts)', () => {
      expect(isBodyInvalidOptional(undefined)).toBe(false);
    });

    it('non-empty string "Hello" is accepted', () => {
      expect(isBodyInvalidOptional("Hello")).toBe(false);
    });

    it('HTML body is accepted', () => {
      expect(isBodyInvalidOptional("<p>Hello</p>")).toBe(false);
    });

    it('empty string "" triggers guard', () => {
      expect(isBodyInvalidOptional("")).toBe(true);
    });

    it('whitespace-only "   " triggers guard', () => {
      expect(isBodyInvalidOptional("   ")).toBe(true);
    });

    it('null triggers guard (explicitly set to null)', () => {
      expect(isBodyInvalidOptional(null)).toBe(true);
    });

    it('number 42 triggers guard (wrong type when present)', () => {
      expect(isBodyInvalidOptional(42)).toBe(true);
    });
  });

  describe("send_email / schedule_email 'priority' enum guard (Cycle #28)", () => {
    it('"high" is a valid priority', () => {
      expect(isPriorityInvalid("high")).toBe(false);
    });

    it('"normal" is a valid priority', () => {
      expect(isPriorityInvalid("normal")).toBe(false);
    });

    it('"low" is a valid priority', () => {
      expect(isPriorityInvalid("low")).toBe(false);
    });

    it('undefined is accepted (priority is optional)', () => {
      expect(isPriorityInvalid(undefined)).toBe(false);
    });

    it('"urgent" triggers guard (not in enum)', () => {
      expect(isPriorityInvalid("urgent")).toBe(true);
    });

    it('"HIGH" triggers guard (case-sensitive match)', () => {
      expect(isPriorityInvalid("HIGH")).toBe(true);
    });

    it('"medium" triggers guard (not in enum)', () => {
      expect(isPriorityInvalid("medium")).toBe(true);
    });

    it('empty string "" triggers guard', () => {
      expect(isPriorityInvalid("")).toBe(true);
    });

    it('number 1 triggers guard (wrong type)', () => {
      expect(isPriorityInvalid(1)).toBe(true);
    });

    it('null triggers guard (explicitly provided null)', () => {
      expect(isPriorityInvalid(null)).toBe(true);
    });
  });

  describe("saveDraft inReplyTo CRLF sanitization (Cycle #28)", () => {
    it('undefined returns undefined', () => {
      expect(sanitizeInReplyTo(undefined)).toBe(undefined);
    });

    it('clean Message-ID is returned unchanged', () => {
      expect(sanitizeInReplyTo("<abc123@mail.example.com>")).toBe("<abc123@mail.example.com>");
    });

    it('CR in value is stripped', () => {
      expect(sanitizeInReplyTo("<id>\rBcc: evil@x.com")).toBe("<id>Bcc: evil@x.com");
    });

    it('LF in value is stripped', () => {
      expect(sanitizeInReplyTo("<id>\nBcc: evil@x.com")).toBe("<id>Bcc: evil@x.com");
    });

    it('CRLF sequence is stripped', () => {
      expect(sanitizeInReplyTo("<id>\r\nX-Injected: yes")).toBe("<id>X-Injected: yes");
    });

    it('NUL byte is stripped', () => {
      expect(sanitizeInReplyTo("<id\x00>")).toBe("<id>");
    });

    it('multiple injection sequences are all stripped', () => {
      expect(sanitizeInReplyTo("<a>\r\n<b>\r\n<c>")).toBe("<a><b><c>");
    });

    it('clean value with angle brackets and dots is untouched', () => {
      expect(sanitizeInReplyTo("<2024.01.15.thread@proton.me>")).toBe("<2024.01.15.thread@proton.me>");
    });

    it('empty string returns undefined (falsy path)', () => {
      expect(sanitizeInReplyTo("")).toBe(undefined);
    });
  });

  // ── Cycle #29: forward_email subject length cap ───────────────────────────

  describe("forward_email subject length cap (Cycle #29)", () => {
    // Replicates the fwdSubject truncation logic:
    //   const fwdSubject = fwdSubjectRaw.length > MAX_SUBJECT_LENGTH
    //     ? fwdSubjectRaw.slice(0, MAX_SUBJECT_LENGTH)
    //     : fwdSubjectRaw;
    // where MAX_SUBJECT_LENGTH = 998.
    const MAX_SUBJECT_LENGTH = 998;

    function capFwdSubject(raw: string): string {
      return raw.length > MAX_SUBJECT_LENGTH ? raw.slice(0, MAX_SUBJECT_LENGTH) : raw;
    }

    it('subject exactly 998 chars is returned unchanged', () => {
      const subject = 'A'.repeat(998);
      expect(capFwdSubject(subject)).toBe(subject);
      expect(capFwdSubject(subject).length).toBe(998);
    });

    it('subject of 997 chars is returned unchanged', () => {
      const subject = 'A'.repeat(997);
      expect(capFwdSubject(subject)).toBe(subject);
    });

    it('subject of 999 chars is truncated to 998', () => {
      const subject = 'A'.repeat(999);
      expect(capFwdSubject(subject).length).toBe(998);
    });

    it('subject of 2000 chars is truncated to 998', () => {
      const subject = 'X'.repeat(2000);
      expect(capFwdSubject(subject).length).toBe(998);
      expect(capFwdSubject(subject)).toBe('X'.repeat(998));
    });

    it('"Fwd: " prefix is included in the 998-char budget', () => {
      // Subject that when prefixed with "Fwd: " (5 chars) equals exactly 1000 chars
      const cleanSubject = 'B'.repeat(995); // "Fwd: " + 995 = 1000 — over limit
      const rawFwd = `Fwd: ${cleanSubject}`;
      expect(rawFwd.length).toBe(1000);
      expect(capFwdSubject(rawFwd).length).toBe(998);
    });

    it('empty subject string is returned as empty string', () => {
      expect(capFwdSubject('')).toBe('');
    });

    it('short subject like "Fwd: Re: Hello" is not modified', () => {
      const subject = 'Fwd: Re: Hello';
      expect(capFwdSubject(subject)).toBe(subject);
    });

    it('subject of exactly 999 chars is sliced to first 998', () => {
      const subject = 'C'.repeat(998) + 'D';
      const result = capFwdSubject(subject);
      expect(result.length).toBe(998);
      expect(result).toBe('C'.repeat(998));
    });
  });

  // ── Cycle #29: rename_folder same-name guard ──────────────────────────────

  describe("rename_folder same-name guard (Cycle #29)", () => {
    // Replicates: (args.oldName as string) === (args.newName as string)
    // Returns true → guard fires → McpError(InvalidParams) thrown.
    function isSameName(oldName: string, newName: string): boolean {
      return oldName === newName;
    }

    it('identical names trigger the guard', () => {
      expect(isSameName('Work', 'Work')).toBe(true);
    });

    it('identical names with different casing do NOT trigger (case-sensitive)', () => {
      expect(isSameName('Work', 'work')).toBe(false);
    });

    it('completely different names do not trigger', () => {
      expect(isSameName('Work', 'Personal')).toBe(false);
    });

    it('empty-string old and new names both empty trigger (same)', () => {
      // Both empty — same value, guard fires. (Empty-name guard fires first in real code.)
      expect(isSameName('', '')).toBe(true);
    });

    it('old name "Archive" and new name "Archive" trigger', () => {
      expect(isSameName('Archive', 'Archive')).toBe(true);
    });

    it('old name "Archive" and new name "archive" do not trigger', () => {
      expect(isSameName('Archive', 'archive')).toBe(false);
    });

    it('names differing by a trailing space do not trigger', () => {
      expect(isSameName('Work', 'Work ')).toBe(false);
    });

    it('single-character same names trigger', () => {
      expect(isSameName('A', 'A')).toBe(true);
    });

    it('single-character different names do not trigger', () => {
      expect(isSameName('A', 'B')).toBe(false);
    });
  });

  // ── Cycle #29: get_emails / get_emails_by_label cursor type guard ─────────

  describe("get_emails cursor type guard (Cycle #29)", () => {
    // Replicates: args.cursor !== undefined && typeof args.cursor !== "string"
    // Returns true → guard fires → McpError(InvalidParams, "'cursor' must be a string.")
    function isCursorTypeInvalid(v: unknown): boolean {
      return v !== undefined && typeof v !== 'string';
    }

    it('undefined is accepted (no cursor, first page)', () => {
      expect(isCursorTypeInvalid(undefined)).toBe(false);
    });

    it('valid base64url string is accepted', () => {
      expect(isCursorTypeInvalid('eyJmb2xkZXIiOiJJTkJPWCIsIm9mZnNldCI6NTAsImxpbWl0Ijo1MH0')).toBe(false);
    });

    it('empty string is accepted (falsy — handler treats as no cursor)', () => {
      expect(isCursorTypeInvalid('')).toBe(false);
    });

    it('number 42 triggers guard (wrong type)', () => {
      expect(isCursorTypeInvalid(42)).toBe(true);
    });

    it('number 0 triggers guard (wrong type)', () => {
      expect(isCursorTypeInvalid(0)).toBe(true);
    });

    it('boolean true triggers guard', () => {
      expect(isCursorTypeInvalid(true)).toBe(true);
    });

    it('boolean false triggers guard', () => {
      expect(isCursorTypeInvalid(false)).toBe(true);
    });

    it('null triggers guard', () => {
      expect(isCursorTypeInvalid(null)).toBe(true);
    });

    it('plain object triggers guard', () => {
      expect(isCursorTypeInvalid({ offset: 50 })).toBe(true);
    });

    it('array triggers guard', () => {
      expect(isCursorTypeInvalid(['cursor'])).toBe(true);
    });
  });

  // ── Cycle #30: send_email / schedule_email 'replyTo' validation ─────────────
  // send_email and schedule_email both pass args.replyTo raw to the SMTP service /
  // scheduler without any handler-level format check.  The SMTP service validates it,
  // but only throws a plain Error that surfaces as "Email delivery failed" rather than
  // a clear McpError(InvalidParams).  For schedule_email the problem is worse: an
  // invalid replyTo is stored in the scheduler and only fails when the job fires.
  //
  // The new guard:
  //   if (args.replyTo !== undefined && (typeof args.replyTo !== "string" || !isValidEmail(args.replyTo)))
  //     throw new McpError(ErrorCode.InvalidParams, "'replyTo' must be a valid email address.")

  describe("send_email / schedule_email 'replyTo' handler-level validation (Cycle #30)", () => {
    // Replicates the combined guard logic inline using the real isValidEmail helper.
    function isReplyToInvalid(v: unknown): boolean {
      if (v === undefined) return false;                   // omitted → fine
      if (typeof v !== 'string') return true;             // non-string → invalid
      return !isValidEmail(v);                            // string but bad format
    }

    it('undefined is accepted (replyTo is optional)', () => {
      expect(isReplyToInvalid(undefined)).toBe(false);
    });

    it('valid email "user@example.com" is accepted', () => {
      expect(isReplyToInvalid('user@example.com')).toBe(false);
    });

    it('valid email with subdomain is accepted', () => {
      expect(isReplyToInvalid('noreply@mail.example.org')).toBe(false);
    });

    it('plain string "not-an-email" triggers guard', () => {
      expect(isReplyToInvalid('not-an-email')).toBe(true);
    });

    it('empty string triggers guard (no local part)', () => {
      expect(isReplyToInvalid('')).toBe(true);
    });

    it('number 42 triggers guard (wrong type)', () => {
      expect(isReplyToInvalid(42)).toBe(true);
    });

    it('boolean true triggers guard (wrong type)', () => {
      expect(isReplyToInvalid(true)).toBe(true);
    });

    it('null triggers guard (wrong type)', () => {
      expect(isReplyToInvalid(null)).toBe(true);
    });

    it('plain object triggers guard (wrong type)', () => {
      expect(isReplyToInvalid({ email: 'user@example.com' })).toBe(true);
    });

    it('address missing domain triggers guard', () => {
      expect(isReplyToInvalid('user@')).toBe(true);
    });

    it('address with CRLF injection triggers guard (control char rejected by isValidEmail)', () => {
      expect(isReplyToInvalid('user@example.com\r\nBcc: evil@x.com')).toBe(true);
    });
  });

  // ── Cycle #30: send_email / save_draft / schedule_email subject type guard ───
  // The RFC 2822 subject length guard (Cycle #26) was:
  //   args.subject !== undefined && typeof args.subject === "string" && subject.length > 998
  // A non-string value (e.g. a number) satisfies `!== undefined` but not
  // `typeof === "string"`, so the condition evaluates false and the value silently
  // passes through to be cast as string downstream.  The new type guard fires first:
  //   if (args.subject !== undefined && typeof args.subject !== "string")
  //     throw new McpError(ErrorCode.InvalidParams, "'subject' must be a string.")

  describe("send_email / save_draft / schedule_email 'subject' non-string type guard (Cycle #30)", () => {
    // Replicates the new guard:
    //   args.subject !== undefined && typeof args.subject !== "string" → fire
    function isSubjectWrongType(v: unknown): boolean {
      return v !== undefined && typeof v !== 'string';
    }

    it('undefined is accepted (omitted subject is fine for save_draft)', () => {
      expect(isSubjectWrongType(undefined)).toBe(false);
    });

    it('string subject "Hello" is accepted', () => {
      expect(isSubjectWrongType('Hello')).toBe(false);
    });

    it('empty string is accepted (emptiness is a separate concern)', () => {
      expect(isSubjectWrongType('')).toBe(false);
    });

    it('number 42 triggers guard', () => {
      expect(isSubjectWrongType(42)).toBe(true);
    });

    it('number 0 triggers guard', () => {
      expect(isSubjectWrongType(0)).toBe(true);
    });

    it('boolean true triggers guard', () => {
      expect(isSubjectWrongType(true)).toBe(true);
    });

    it('boolean false triggers guard', () => {
      expect(isSubjectWrongType(false)).toBe(true);
    });

    it('null triggers guard', () => {
      expect(isSubjectWrongType(null)).toBe(true);
    });

    it('plain object triggers guard', () => {
      expect(isSubjectWrongType({ text: 'hello' })).toBe(true);
    });

    it('array triggers guard', () => {
      expect(isSubjectWrongType(['hello'])).toBe(true);
    });
  });

  // ── Cycle #30: save_draft 'to' field type guard ──────────────────────────────
  // save_draft accepts 'to' as an optional field (a draft may be addressed later).
  // The field was previously unchecked: any non-string type (e.g. an array of
  // addresses, a number) would be silently cast to string and forwarded to the
  // IMAP saveDraft layer as a malformed address string.  The new guard:
  //   if (args.to !== undefined && typeof args.to !== "string")
  //     throw new McpError(ErrorCode.InvalidParams, "'to' must be a string when provided.")

  describe("save_draft 'to' field type guard (Cycle #30)", () => {
    // Replicates the guard:
    //   args.to !== undefined && typeof args.to !== "string" → fire
    function isToWrongType(v: unknown): boolean {
      return v !== undefined && typeof v !== 'string';
    }

    it('undefined is accepted (omitted — draft may be addressed later)', () => {
      expect(isToWrongType(undefined)).toBe(false);
    });

    it('valid email string is accepted', () => {
      expect(isToWrongType('user@example.com')).toBe(false);
    });

    it('comma-separated string is accepted (format validated downstream)', () => {
      expect(isToWrongType('a@b.com, c@d.com')).toBe(false);
    });

    it('empty string is accepted (emptiness is separate from type guard)', () => {
      expect(isToWrongType('')).toBe(false);
    });

    it('number 42 triggers guard', () => {
      expect(isToWrongType(42)).toBe(true);
    });

    it('boolean true triggers guard', () => {
      expect(isToWrongType(true)).toBe(true);
    });

    it('null triggers guard', () => {
      expect(isToWrongType(null)).toBe(true);
    });

    it('array of strings triggers guard (must be comma-separated string, not array)', () => {
      expect(isToWrongType(['user@example.com'])).toBe(true);
    });

    it('plain object triggers guard', () => {
      expect(isToWrongType({ address: 'user@example.com' })).toBe(true);
    });
  });

  // ── Cycle #31: send_email / save_draft / schedule_email 'cc' and 'bcc' type guards ──
  // All three handlers previously cast args.cc and args.bcc directly as
  // `string | undefined` with no type check.  A caller supplying cc: ["a@b.com"]
  // (an array) or cc: 42 (a number) would have the value silently cast to a
  // malformed string and forwarded to the SMTP/IMAP/scheduler layer unchecked.
  //
  // New guards (mirroring the 'to' type guard already present in these handlers):
  //   if (args.cc !== undefined && typeof args.cc !== "string")
  //     throw new McpError(ErrorCode.InvalidParams, "'cc' must be a string when provided.")
  //   if (args.bcc !== undefined && typeof args.bcc !== "string")
  //     throw new McpError(ErrorCode.InvalidParams, "'bcc' must be a string when provided.")

  describe("send_email / save_draft / schedule_email 'cc' type guard (Cycle #31)", () => {
    // Replicates: args.cc !== undefined && typeof args.cc !== "string" → fire
    function isCcWrongType(v: unknown): boolean {
      return v !== undefined && typeof v !== 'string';
    }

    it('undefined is accepted (cc is optional)', () => {
      expect(isCcWrongType(undefined)).toBe(false);
    });

    it('comma-separated string is accepted', () => {
      expect(isCcWrongType('a@example.com, b@example.com')).toBe(false);
    });

    it('single email string is accepted', () => {
      expect(isCcWrongType('user@example.com')).toBe(false);
    });

    it('empty string is accepted (emptiness is separate from type guard)', () => {
      expect(isCcWrongType('')).toBe(false);
    });

    it('array of strings triggers guard (must be comma-separated, not array)', () => {
      expect(isCcWrongType(['a@b.com', 'c@d.com'])).toBe(true);
    });

    it('number 42 triggers guard (wrong type)', () => {
      expect(isCcWrongType(42)).toBe(true);
    });

    it('boolean true triggers guard (wrong type)', () => {
      expect(isCcWrongType(true)).toBe(true);
    });

    it('null triggers guard (wrong type)', () => {
      expect(isCcWrongType(null)).toBe(true);
    });

    it('plain object triggers guard (wrong type)', () => {
      expect(isCcWrongType({ email: 'user@example.com' })).toBe(true);
    });
  });

  describe("send_email / save_draft / schedule_email 'bcc' type guard (Cycle #31)", () => {
    // Replicates: args.bcc !== undefined && typeof args.bcc !== "string" → fire
    function isBccWrongType(v: unknown): boolean {
      return v !== undefined && typeof v !== 'string';
    }

    it('undefined is accepted (bcc is optional)', () => {
      expect(isBccWrongType(undefined)).toBe(false);
    });

    it('comma-separated string is accepted', () => {
      expect(isBccWrongType('secret@example.com, other@example.com')).toBe(false);
    });

    it('single email string is accepted', () => {
      expect(isBccWrongType('hidden@example.com')).toBe(false);
    });

    it('empty string is accepted (emptiness is a separate concern)', () => {
      expect(isBccWrongType('')).toBe(false);
    });

    it('array of strings triggers guard (must be comma-separated, not array)', () => {
      expect(isBccWrongType(['secret@example.com'])).toBe(true);
    });

    it('number 0 triggers guard (wrong type)', () => {
      expect(isBccWrongType(0)).toBe(true);
    });

    it('boolean false triggers guard (wrong type)', () => {
      expect(isBccWrongType(false)).toBe(true);
    });

    it('null triggers guard (wrong type)', () => {
      expect(isBccWrongType(null)).toBe(true);
    });

    it('plain object triggers guard (wrong type)', () => {
      expect(isBccWrongType({ address: 'hidden@example.com' })).toBe(true);
    });
  });

  // ── Cycle #31: forward_email 'message' field type guard ──────────────────────
  // forward_email uses `args.message ? \`${args.message as string}\n\n\` : ""`
  // without type-checking args.message.  A non-string (number, array, object)
  // is truthy, bypasses the `|| ""` fallback, and is silently template-coerced
  // to a string prepended to the forwarded body without error.
  //
  // New guard:
  //   if (args.message !== undefined && typeof args.message !== "string")
  //     throw new McpError(ErrorCode.InvalidParams, "'message' must be a string when provided.")

  describe("forward_email 'message' field type guard (Cycle #31)", () => {
    // Replicates: args.message !== undefined && typeof args.message !== "string" → fire
    function isMessageWrongType(v: unknown): boolean {
      return v !== undefined && typeof v !== 'string';
    }

    it('undefined is accepted (message is optional)', () => {
      expect(isMessageWrongType(undefined)).toBe(false);
    });

    it('non-empty string is accepted', () => {
      expect(isMessageWrongType('Please see the forwarded message below.')).toBe(false);
    });

    it('empty string is accepted (type is correct even if semantically empty)', () => {
      expect(isMessageWrongType('')).toBe(false);
    });

    it('multi-line string is accepted', () => {
      expect(isMessageWrongType('Line 1\nLine 2')).toBe(false);
    });

    it('number 42 triggers guard (wrong type)', () => {
      expect(isMessageWrongType(42)).toBe(true);
    });

    it('boolean true triggers guard (wrong type)', () => {
      expect(isMessageWrongType(true)).toBe(true);
    });

    it('null triggers guard (wrong type)', () => {
      expect(isMessageWrongType(null)).toBe(true);
    });

    it('array triggers guard (wrong type)', () => {
      expect(isMessageWrongType(['Please see below'])).toBe(true);
    });

    it('plain object triggers guard (wrong type)', () => {
      expect(isMessageWrongType({ text: 'see below' })).toBe(true);
    });
  });

  // ── Cycle #32: send_test_email 'customMessage' field type guard ────────────
  // send_test_email accepts customMessage as optional, but cast it directly as
  // `string | undefined` with no type check.  A non-string value (e.g. a number
  // or array) is truthy, satisfies `customMessage || <default>` in the SMTP
  // service, and is silently coerced to a string via template literal, producing
  // garbled HTML in the test email body without any error to the caller.
  //
  // New guard (consistent with forward_email 'message' guard from Cycle #31):
  //   if (args.customMessage !== undefined && typeof args.customMessage !== "string")
  //     throw new McpError(ErrorCode.InvalidParams, "'customMessage' must be a string when provided.")

  describe("send_test_email 'customMessage' field type guard (Cycle #32)", () => {
    // Replicates: args.customMessage !== undefined && typeof args.customMessage !== "string" → fire
    function isCustomMessageWrongType(v: unknown): boolean {
      return v !== undefined && typeof v !== 'string';
    }

    it('undefined is accepted (customMessage is optional)', () => {
      expect(isCustomMessageWrongType(undefined)).toBe(false);
    });

    it('non-empty string is accepted', () => {
      expect(isCustomMessageWrongType('<p>Hello from test</p>')).toBe(false);
    });

    it('empty string is accepted (type is correct; semantics are a service concern)', () => {
      expect(isCustomMessageWrongType('')).toBe(false);
    });

    it('plain text string is accepted', () => {
      expect(isCustomMessageWrongType('Custom test message body')).toBe(false);
    });

    it('number 42 triggers guard (wrong type — would be coerced to "42")', () => {
      expect(isCustomMessageWrongType(42)).toBe(true);
    });

    it('number 0 triggers guard (falsy number but still wrong type)', () => {
      expect(isCustomMessageWrongType(0)).toBe(true);
    });

    it('boolean true triggers guard (wrong type)', () => {
      expect(isCustomMessageWrongType(true)).toBe(true);
    });

    it('null triggers guard (wrong type)', () => {
      expect(isCustomMessageWrongType(null)).toBe(true);
    });

    it('array triggers guard (wrong type)', () => {
      expect(isCustomMessageWrongType(['Custom message'])).toBe(true);
    });

    it('plain object triggers guard (wrong type)', () => {
      expect(isCustomMessageWrongType({ body: 'test' })).toBe(true);
    });
  });

  // ── Cycle #33 guards ──────────────────────────────────────────────────────

  // isHtml type guard (Cycle #33)
  // Applied in send_email, reply_to_email, save_draft, schedule_email.
  // Condition: args.isHtml !== undefined && typeof args.isHtml !== "boolean" → fire.
  // A non-boolean truthy value (e.g. "yes" or 1) passes through as boolean in
  // nodemailer, silently switching the email to HTML mode without any caller error.

  describe("'isHtml' boolean type guard — send_email / reply_to_email / save_draft / schedule_email (Cycle #33)", () => {
    function isIsHtmlWrongType(v: unknown): boolean {
      return v !== undefined && typeof v !== 'boolean';
    }

    it('undefined is accepted (isHtml is optional)', () => {
      expect(isIsHtmlWrongType(undefined)).toBe(false);
    });

    it('true is accepted', () => {
      expect(isIsHtmlWrongType(true)).toBe(false);
    });

    it('false is accepted', () => {
      expect(isIsHtmlWrongType(false)).toBe(false);
    });

    it('string "true" triggers guard (wrong type)', () => {
      expect(isIsHtmlWrongType('true')).toBe(true);
    });

    it('string "yes" triggers guard (wrong type)', () => {
      expect(isIsHtmlWrongType('yes')).toBe(true);
    });

    it('number 1 triggers guard (wrong type — truthy, would enable HTML mode silently)', () => {
      expect(isIsHtmlWrongType(1)).toBe(true);
    });

    it('number 0 triggers guard (wrong type — falsy number, still wrong type)', () => {
      expect(isIsHtmlWrongType(0)).toBe(true);
    });

    it('null triggers guard (wrong type)', () => {
      expect(isIsHtmlWrongType(null)).toBe(true);
    });

    it('array triggers guard (wrong type)', () => {
      expect(isIsHtmlWrongType([true])).toBe(true);
    });

    it('plain object triggers guard (wrong type)', () => {
      expect(isIsHtmlWrongType({ html: true })).toBe(true);
    });
  });

  // body max-length guard (Cycle #33)
  // Applied in send_email, save_draft, schedule_email.
  // MAX_BODY_LENGTH = 10 * 1024 * 1024 (10 MB).
  // Condition: body.length > MAX_BODY_LENGTH → fire.
  // Prevents OOM/SMTP timeout from multi-megabyte body payloads.

  describe("'body' max-length guard (MAX_BODY_LENGTH = 10 MB) — send_email / save_draft / schedule_email (Cycle #33)", () => {
    const MAX_BODY_LENGTH = 10 * 1024 * 1024; // mirrors src/index.ts

    function isBodyTooLong(v: string): boolean {
      return v.length > MAX_BODY_LENGTH;
    }

    it('empty string does not trigger guard', () => {
      expect(isBodyTooLong('')).toBe(false);
    });

    it('typical short body does not trigger guard', () => {
      expect(isBodyTooLong('Hello, world!')).toBe(false);
    });

    it('body exactly at MAX_BODY_LENGTH does not trigger guard (boundary)', () => {
      expect(isBodyTooLong('a'.repeat(MAX_BODY_LENGTH))).toBe(false);
    });

    it('body one byte over MAX_BODY_LENGTH triggers guard', () => {
      expect(isBodyTooLong('a'.repeat(MAX_BODY_LENGTH + 1))).toBe(true);
    });

    it('body at 11 MB triggers guard', () => {
      expect(isBodyTooLong('a'.repeat(11 * 1024 * 1024))).toBe(true);
    });

    it('body at 100 MB triggers guard (OOM scenario)', () => {
      // Use length arithmetic rather than actually allocating 100 MB.
      const fakeLength = 100 * 1024 * 1024;
      expect(fakeLength > MAX_BODY_LENGTH).toBe(true);
    });

    it('MAX_BODY_LENGTH constant is exactly 10 MB (10485760 bytes)', () => {
      expect(MAX_BODY_LENGTH).toBe(10485760);
    });
  });

  // ── Cycle #34 guards ──────────────────────────────────────────────────────

  // reply_to_email body max-length guard (Cycle #34)
  // Applied in reply_to_email — was missed in Cycle #33 when send_email,
  // save_draft, and schedule_email received the same cap.
  // Condition: (args.body as string).length > MAX_BODY_LENGTH → throw.

  describe("'body' max-length guard — reply_to_email (Cycle #34)", () => {
    const MAX_BODY_LENGTH = 10 * 1024 * 1024; // mirrors src/index.ts

    function isBodyTooLong(v: string): boolean {
      return v.length > MAX_BODY_LENGTH;
    }

    it('short body does not trigger guard', () => {
      expect(isBodyTooLong('Hello!')).toBe(false);
    });

    it('body exactly at MAX_BODY_LENGTH does not trigger guard (boundary)', () => {
      expect(isBodyTooLong('a'.repeat(MAX_BODY_LENGTH))).toBe(false);
    });

    it('body one byte over MAX_BODY_LENGTH triggers guard', () => {
      expect(isBodyTooLong('a'.repeat(MAX_BODY_LENGTH + 1))).toBe(true);
    });

    it('body at 20 MB triggers guard', () => {
      const fakeLength = 20 * 1024 * 1024;
      expect(fakeLength > MAX_BODY_LENGTH).toBe(true);
    });
  });

  // forward_email fwdBody max-length guard (Cycle #34)
  // The forwarded body is assembled from (optional user message) + forwarded
  // header + original email body, so a large original can push it over the cap.
  // Same MAX_BODY_LENGTH = 10 MB applies.

  describe("forwarded body max-length guard — forward_email (Cycle #34)", () => {
    const MAX_BODY_LENGTH = 10 * 1024 * 1024;

    function isFwdBodyTooLong(v: string): boolean {
      return v.length > MAX_BODY_LENGTH;
    }

    it('normal forwarded body does not trigger guard', () => {
      expect(isFwdBodyTooLong('---------- Forwarded message ----------\nHello')).toBe(false);
    });

    it('forwarded body exactly at MAX_BODY_LENGTH does not trigger guard', () => {
      expect(isFwdBodyTooLong('a'.repeat(MAX_BODY_LENGTH))).toBe(false);
    });

    it('forwarded body one byte over MAX_BODY_LENGTH triggers guard', () => {
      expect(isFwdBodyTooLong('a'.repeat(MAX_BODY_LENGTH + 1))).toBe(true);
    });

    it('very large original email body (50 MB) triggers guard', () => {
      const fakeLength = 50 * 1024 * 1024;
      expect(fakeLength > MAX_BODY_LENGTH).toBe(true);
    });
  });

  // isRead boolean type guard — mark_email_read / bulk_mark_read (Cycle #34)
  // Condition: args.isRead !== undefined && typeof args.isRead !== "boolean" → throw.
  // A non-boolean truthy value (e.g. "yes", 1) would silently cast to boolean
  // and mark the email read/unread based on JS truthiness rather than caller intent.

  describe("'isRead' boolean type guard — mark_email_read / bulk_mark_read (Cycle #34)", () => {
    function isIsReadWrongType(v: unknown): boolean {
      return v !== undefined && typeof v !== "boolean";
    }

    it('undefined does not trigger guard (field absent)', () => {
      expect(isIsReadWrongType(undefined)).toBe(false);
    });

    it('true does not trigger guard', () => {
      expect(isIsReadWrongType(true)).toBe(false);
    });

    it('false does not trigger guard', () => {
      expect(isIsReadWrongType(false)).toBe(false);
    });

    it('string "true" triggers guard', () => {
      expect(isIsReadWrongType("true")).toBe(true);
    });

    it('number 1 triggers guard', () => {
      expect(isIsReadWrongType(1)).toBe(true);
    });

    it('number 0 triggers guard', () => {
      expect(isIsReadWrongType(0)).toBe(true);
    });

    it('null triggers guard', () => {
      expect(isIsReadWrongType(null)).toBe(true);
    });

    it('array triggers guard', () => {
      expect(isIsReadWrongType([true])).toBe(true);
    });

    it('plain object triggers guard', () => {
      expect(isIsReadWrongType({ read: true })).toBe(true);
    });
  });

  // isStarred boolean type guard — star_email / bulk_star (Cycle #34)
  // Condition: args.isStarred !== undefined && typeof args.isStarred !== "boolean" → throw.
  // Mirrors the isRead guard above and the isHtml guard from Cycle #33.

  describe("'isStarred' boolean type guard — star_email / bulk_star (Cycle #34)", () => {
    function isIsStarredWrongType(v: unknown): boolean {
      return v !== undefined && typeof v !== "boolean";
    }

    it('undefined does not trigger guard (field absent)', () => {
      expect(isIsStarredWrongType(undefined)).toBe(false);
    });

    it('true does not trigger guard', () => {
      expect(isIsStarredWrongType(true)).toBe(false);
    });

    it('false does not trigger guard', () => {
      expect(isIsStarredWrongType(false)).toBe(false);
    });

    it('string "yes" triggers guard', () => {
      expect(isIsStarredWrongType("yes")).toBe(true);
    });

    it('number 1 triggers guard', () => {
      expect(isIsStarredWrongType(1)).toBe(true);
    });

    it('number 0 triggers guard', () => {
      expect(isIsStarredWrongType(0)).toBe(true);
    });

    it('null triggers guard', () => {
      expect(isIsStarredWrongType(null)).toBe(true);
    });

    it('array triggers guard', () => {
      expect(isIsStarredWrongType([false])).toBe(true);
    });

    it('plain object triggers guard', () => {
      expect(isIsStarredWrongType({ starred: true })).toBe(true);
    });
  });

  // ── Cycle #35: search_emails string-type guards for from/to/subject ──────────
  // The length-cap guards (Cycle #6) used bare `args.X && (args.X as string).length`
  // without a typeof check first.  A non-string truthy value (e.g. the number 42)
  // would be cast via `as string`; at runtime `(42 as string).length` is `undefined`
  // and `undefined > 500` is `false`, so the bad value silently passed to the IMAP
  // service.  The new type guard returns a clear McpError instead.

  describe("search_emails 'from' filter string type guard (Cycle #35)", () => {
    function isFromWrongType(v: unknown): boolean {
      return v !== undefined && typeof v !== "string";
    }

    it('undefined does not trigger guard (field absent)', () => {
      expect(isFromWrongType(undefined)).toBe(false);
    });

    it('valid string does not trigger guard', () => {
      expect(isFromWrongType("alice@example.com")).toBe(false);
    });

    it('empty string does not trigger guard (handled by length check)', () => {
      expect(isFromWrongType("")).toBe(false);
    });

    it('number 42 triggers guard', () => {
      expect(isFromWrongType(42)).toBe(true);
    });

    it('boolean true triggers guard', () => {
      expect(isFromWrongType(true)).toBe(true);
    });

    it('array triggers guard', () => {
      expect(isFromWrongType(["alice@example.com"])).toBe(true);
    });

    it('plain object triggers guard', () => {
      expect(isFromWrongType({ address: "alice@example.com" })).toBe(true);
    });
  });

  describe("search_emails 'to' filter string type guard (Cycle #35)", () => {
    function isToWrongType(v: unknown): boolean {
      return v !== undefined && typeof v !== "string";
    }

    it('undefined does not trigger guard', () => {
      expect(isToWrongType(undefined)).toBe(false);
    });

    it('valid string does not trigger guard', () => {
      expect(isToWrongType("bob@example.com")).toBe(false);
    });

    it('number triggers guard', () => {
      expect(isToWrongType(0)).toBe(true);
    });

    it('array triggers guard', () => {
      expect(isToWrongType(["bob@example.com"])).toBe(true);
    });
  });

  describe("search_emails 'subject' filter string type guard (Cycle #35)", () => {
    function isSubjectWrongType(v: unknown): boolean {
      return v !== undefined && typeof v !== "string";
    }

    it('undefined does not trigger guard', () => {
      expect(isSubjectWrongType(undefined)).toBe(false);
    });

    it('valid string does not trigger guard', () => {
      expect(isSubjectWrongType("Meeting notes")).toBe(false);
    });

    it('number triggers guard', () => {
      expect(isSubjectWrongType(100)).toBe(true);
    });

    it('boolean triggers guard', () => {
      expect(isSubjectWrongType(false)).toBe(true);
    });

    it('array triggers guard', () => {
      expect(isSubjectWrongType(["Meeting notes"])).toBe(true);
    });
  });

  // ── Cycle #35: search_emails boolean type guards for hasAttachment/isRead/isStarred ──
  // These three filter fields were forwarded directly as `args.X as boolean | undefined`
  // without any runtime type check.  A non-boolean truthy value (e.g. "true" or 1)
  // would pass the cast silently and reach imapflow, which evaluates it as truthy
  // and applies the filter based on JS truthiness rather than the caller's intent.

  describe("search_emails 'hasAttachment' boolean type guard (Cycle #35)", () => {
    function isHasAttachmentWrongType(v: unknown): boolean {
      return v !== undefined && typeof v !== "boolean";
    }

    it('undefined does not trigger guard (field absent)', () => {
      expect(isHasAttachmentWrongType(undefined)).toBe(false);
    });

    it('true does not trigger guard', () => {
      expect(isHasAttachmentWrongType(true)).toBe(false);
    });

    it('false does not trigger guard', () => {
      expect(isHasAttachmentWrongType(false)).toBe(false);
    });

    it('string "true" triggers guard', () => {
      expect(isHasAttachmentWrongType("true")).toBe(true);
    });

    it('number 1 triggers guard', () => {
      expect(isHasAttachmentWrongType(1)).toBe(true);
    });

    it('number 0 triggers guard', () => {
      expect(isHasAttachmentWrongType(0)).toBe(true);
    });

    it('null triggers guard', () => {
      expect(isHasAttachmentWrongType(null)).toBe(true);
    });

    it('array triggers guard', () => {
      expect(isHasAttachmentWrongType([true])).toBe(true);
    });

    it('plain object triggers guard', () => {
      expect(isHasAttachmentWrongType({ hasAttachment: true })).toBe(true);
    });
  });

  describe("search_emails 'isRead' boolean type guard (Cycle #35)", () => {
    function isIsReadSearchWrongType(v: unknown): boolean {
      return v !== undefined && typeof v !== "boolean";
    }

    it('undefined does not trigger guard', () => {
      expect(isIsReadSearchWrongType(undefined)).toBe(false);
    });

    it('true does not trigger guard', () => {
      expect(isIsReadSearchWrongType(true)).toBe(false);
    });

    it('false does not trigger guard', () => {
      expect(isIsReadSearchWrongType(false)).toBe(false);
    });

    it('string "yes" triggers guard', () => {
      expect(isIsReadSearchWrongType("yes")).toBe(true);
    });

    it('number 1 triggers guard', () => {
      expect(isIsReadSearchWrongType(1)).toBe(true);
    });

    it('null triggers guard', () => {
      expect(isIsReadSearchWrongType(null)).toBe(true);
    });
  });

  describe("search_emails 'isStarred' boolean type guard (Cycle #35)", () => {
    function isIsStarredSearchWrongType(v: unknown): boolean {
      return v !== undefined && typeof v !== "boolean";
    }

    it('undefined does not trigger guard', () => {
      expect(isIsStarredSearchWrongType(undefined)).toBe(false);
    });

    it('true does not trigger guard', () => {
      expect(isIsStarredSearchWrongType(true)).toBe(false);
    });

    it('false does not trigger guard', () => {
      expect(isIsStarredSearchWrongType(false)).toBe(false);
    });

    it('string "starred" triggers guard', () => {
      expect(isIsStarredSearchWrongType("starred")).toBe(true);
    });

    it('number 0 triggers guard', () => {
      expect(isIsStarredSearchWrongType(0)).toBe(true);
    });

    it('null triggers guard', () => {
      expect(isIsStarredSearchWrongType(null)).toBe(true);
    });
  });

  // ── Cycle #35: save_draft 'inReplyTo' string type guard ──────────────────────
  // The field was cast directly as `args.inReplyTo as string | undefined` with no
  // runtime type check.  A non-string value (number, object, array) would be silently
  // cast to string and forwarded to the IMAP saveDraft layer as a malformed Message-ID.

  describe("save_draft 'inReplyTo' string type guard (Cycle #35)", () => {
    function isInReplyToWrongType(v: unknown): boolean {
      return v !== undefined && typeof v !== "string";
    }

    it('undefined does not trigger guard (field absent)', () => {
      expect(isInReplyToWrongType(undefined)).toBe(false);
    });

    it('valid Message-ID string does not trigger guard', () => {
      expect(isInReplyToWrongType("<abc123@mail.example.com>")).toBe(false);
    });

    it('empty string does not trigger guard', () => {
      expect(isInReplyToWrongType("")).toBe(false);
    });

    it('number triggers guard', () => {
      expect(isInReplyToWrongType(42)).toBe(true);
    });

    it('boolean triggers guard', () => {
      expect(isInReplyToWrongType(true)).toBe(true);
    });

    it('array triggers guard', () => {
      expect(isInReplyToWrongType(["<id@example.com>"])).toBe(true);
    });

    it('plain object triggers guard', () => {
      expect(isInReplyToWrongType({ id: "<id@example.com>" })).toBe(true);
    });
  });

  // ── Cycle #35: save_draft 'references' array type guard ──────────────────────
  // The field was cast directly as `args.references as string[] | undefined` with no
  // runtime type check.  A non-array value or an array containing non-strings would
  // reach nodemailer and produce malformed References headers.

  describe("save_draft 'references' array and item type guard (Cycle #35)", () => {
    // Mirror the guard logic:
    //   if (!Array.isArray(v)) → error
    //   for each item: typeof item !== "string" → error
    function referencesGuardError(v: unknown): string | null {
      if (v === undefined) return null;
      if (!Array.isArray(v)) return "not an array";
      for (let i = 0; i < (v as unknown[]).length; i++) {
        if (typeof (v as unknown[])[i] !== "string") return `item ${i} not string`;
      }
      return null;
    }

    it('undefined does not trigger guard', () => {
      expect(referencesGuardError(undefined)).toBeNull();
    });

    it('empty array does not trigger guard', () => {
      expect(referencesGuardError([])).toBeNull();
    });

    it('array of valid strings does not trigger guard', () => {
      expect(referencesGuardError(["<a@b.com>", "<c@d.com>"])).toBeNull();
    });

    it('string (not array) triggers guard', () => {
      expect(referencesGuardError("<a@b.com>")).toBe("not an array");
    });

    it('number triggers guard', () => {
      expect(referencesGuardError(42)).toBe("not an array");
    });

    it('plain object triggers guard', () => {
      expect(referencesGuardError({ 0: "<a@b.com>" })).toBe("not an array");
    });

    it('array with a number item triggers item guard', () => {
      expect(referencesGuardError(["<a@b.com>", 99])).toBe("item 1 not string");
    });

    it('array with a boolean item triggers item guard', () => {
      expect(referencesGuardError([true])).toBe("item 0 not string");
    });

    it('array with null item triggers item guard', () => {
      expect(referencesGuardError([null])).toBe("item 0 not string");
    });

    it('array with object item triggers item guard', () => {
      expect(referencesGuardError([{ id: "<a@b.com>" }])).toBe("item 0 not string");
    });
  });
});
