import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SimpleIMAPService } from './simple-imap-service.js';

// Mock ImapFlow
vi.mock('imapflow', () => {
  const ImapFlow = vi.fn(function() {
    return {
      connect: vi.fn().mockResolvedValue(undefined),
      logout: vi.fn().mockResolvedValue(undefined),
      mailboxCreate: vi.fn().mockResolvedValue(undefined),
      mailboxDelete: vi.fn().mockResolvedValue(undefined),
      mailboxRename: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([
        { path: 'INBOX', delimiter: '/', flags: new Set() },
        { path: 'Sent', delimiter: '/', flags: new Set() },
      ]),
    };
  });

  return { ImapFlow };
});

// Mock mailparser
vi.mock('mailparser', () => ({
  simpleParser: vi.fn(),
}));

describe('Folder Management', () => {
  let service: SimpleIMAPService;

  beforeEach(async () => {
    service = new SimpleIMAPService();
    // Connect to mock IMAP server
    await service.connect('localhost', 1143, 'test@example.com', 'password');
  });

  describe('createFolder', () => {
    it('should create a new folder', async () => {
      const result = await service.createFolder('MyFolder');
      expect(result).toBe(true);
    });

    it('should throw error if folder already exists', async () => {
      const mockClient = (service as any).client;
      mockClient.mailboxCreate.mockRejectedValueOnce({
        responseText: 'ALREADYEXISTS',
      });

      await expect(service.createFolder('INBOX')).rejects.toThrow(
        "Folder 'INBOX' already exists"
      );
    });

    it('should throw error if not connected', async () => {
      const disconnectedService = new SimpleIMAPService();
      await expect(disconnectedService.createFolder('Test')).rejects.toThrow(
        'IMAP client not connected'
      );
    });
  });

  describe('deleteFolder', () => {
    it('should delete a folder', async () => {
      const result = await service.deleteFolder('MyFolder');
      expect(result).toBe(true);
    });

    it('should prevent deletion of system folders', async () => {
      const systemFolders = ['INBOX', 'Sent', 'Drafts', 'Trash', 'Spam'];

      for (const folder of systemFolders) {
        await expect(service.deleteFolder(folder)).rejects.toThrow(
          `Cannot delete protected folder: ${folder}`
        );
      }
    });

    it('should throw error if folder does not exist', async () => {
      const mockClient = (service as any).client;
      mockClient.mailboxDelete.mockRejectedValueOnce({
        responseText: 'NONEXISTENT',
      });

      await expect(service.deleteFolder('NonExistent')).rejects.toThrow(
        "Folder 'NonExistent' does not exist"
      );
    });

    it('should throw error if folder is not empty', async () => {
      const mockClient = (service as any).client;
      mockClient.mailboxDelete.mockRejectedValueOnce({
        responseText: 'HASCHILDREN',
      });

      await expect(service.deleteFolder('MyFolder')).rejects.toThrow(
        "Folder 'MyFolder' is not empty"
      );
    });

    it('should throw error if not connected', async () => {
      const disconnectedService = new SimpleIMAPService();
      await expect(disconnectedService.deleteFolder('Test')).rejects.toThrow(
        'IMAP client not connected'
      );
    });
  });

  describe('renameFolder', () => {
    it('should rename a folder', async () => {
      const result = await service.renameFolder('OldName', 'NewName');
      expect(result).toBe(true);
    });

    it('should prevent renaming of system folders', async () => {
      const systemFolders = ['INBOX', 'Sent', 'Drafts', 'Trash'];

      for (const folder of systemFolders) {
        await expect(service.renameFolder(folder, 'NewName')).rejects.toThrow(
          `Cannot rename protected folder: ${folder}`
        );
      }
    });

    it('should throw error if old folder does not exist', async () => {
      const mockClient = (service as any).client;
      mockClient.mailboxRename.mockRejectedValueOnce({
        responseText: 'NONEXISTENT',
      });

      await expect(service.renameFolder('NonExistent', 'NewName')).rejects.toThrow(
        "Folder 'NonExistent' does not exist"
      );
    });

    it('should throw error if new folder name already exists', async () => {
      const mockClient = (service as any).client;
      mockClient.mailboxRename.mockRejectedValueOnce({
        responseText: 'ALREADYEXISTS',
      });

      await expect(service.renameFolder('OldName', 'ExistingName')).rejects.toThrow(
        "Folder 'ExistingName' already exists"
      );
    });

    it('should throw error if not connected', async () => {
      const disconnectedService = new SimpleIMAPService();
      await expect(
        disconnectedService.renameFolder('Old', 'New')
      ).rejects.toThrow('IMAP client not connected');
    });
  });

  describe('folder cache management', () => {
    it('should clear folder cache after creating folder', async () => {
      const clearSpy = vi.spyOn((service as any).folderCache, 'clear');
      await service.createFolder('NewFolder');
      expect(clearSpy).toHaveBeenCalled();
    });

    it('should clear folder cache after deleting folder', async () => {
      const clearSpy = vi.spyOn((service as any).folderCache, 'clear');
      await service.deleteFolder('MyFolder');
      expect(clearSpy).toHaveBeenCalled();
    });

    it('should clear folder cache after renaming folder', async () => {
      const clearSpy = vi.spyOn((service as any).folderCache, 'clear');
      await service.renameFolder('OldName', 'NewName');
      expect(clearSpy).toHaveBeenCalled();
    });

    it('should reset folderCachedAt to 0 after createFolder', async () => {
      // Simulate a warm cache
      (service as any).folderCachedAt = Date.now();
      await service.createFolder('AnotherFolder');
      expect((service as any).folderCachedAt).toBe(0);
    });

    it('should reset folderCachedAt to 0 after deleteFolder', async () => {
      (service as any).folderCachedAt = Date.now();
      await service.deleteFolder('MyFolder');
      expect((service as any).folderCachedAt).toBe(0);
    });

    it('should reset folderCachedAt to 0 after renameFolder', async () => {
      (service as any).folderCachedAt = Date.now();
      await service.renameFolder('OldName', 'NewName');
      expect((service as any).folderCachedAt).toBe(0);
    });

    it('should reset folderCachedAt to 0 after clearCache()', () => {
      (service as any).folderCachedAt = Date.now();
      service.clearCache();
      expect((service as any).folderCachedAt).toBe(0);
    });
  });

  describe('getFolders TTL cache', () => {
    it('should return cached folders without IMAP call when TTL is not expired', async () => {
      // Seed the folder cache with a folder
      const mockClient = (service as any).client;
      (service as any).folderCache.set('INBOX', {
        name: 'INBOX', path: 'INBOX', totalMessages: 5, unreadMessages: 2,
        specialUse: undefined, folderType: 'system',
      });
      // Set a recent timestamp
      (service as any).folderCachedAt = Date.now();

      const listCallsBefore = mockClient.list.mock.calls.length;
      const result = await service.getFolders();
      // list() should NOT have been called again
      expect(mockClient.list.mock.calls.length).toBe(listCallsBefore);
      expect(result).toHaveLength(1);
      expect(result[0].path).toBe('INBOX');
    });

    it('should fetch from IMAP when folderCachedAt is 0 (cold cache)', async () => {
      const mockClient = (service as any).client;
      mockClient.status = vi.fn().mockResolvedValue({ messages: 10, unseen: 3 });
      (service as any).folderCachedAt = 0;
      (service as any).folderCache.clear();

      await service.getFolders();
      expect(mockClient.list).toHaveBeenCalled();
    });

    it('should fetch from IMAP when TTL is expired and update folderCachedAt', async () => {
      const mockClient = (service as any).client;
      mockClient.status = vi.fn().mockResolvedValue({ messages: 10, unseen: 3 });
      // Set an expired timestamp
      (service as any).folderCachedAt = Date.now() - 10 * 60 * 1000; // 10 min ago
      (service as any).folderCache.set('INBOX', {
        name: 'INBOX', path: 'INBOX', totalMessages: 5, unreadMessages: 2,
        specialUse: undefined, folderType: 'system',
      });
      const listCallsBefore = mockClient.list.mock.calls.length;

      await service.getFolders();
      expect(mockClient.list.mock.calls.length).toBeGreaterThan(listCallsBefore);
      // folderCachedAt should be updated to a recent timestamp
      expect((service as any).folderCachedAt).toBeGreaterThan(Date.now() - 5000);
    });
  });
});
