import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SimpleIMAPService } from './simple-imap-service.js';

// Mock ImapFlow
vi.mock('imapflow', () => {
  const ImapFlow = vi.fn(function() {
    return {
      connect: vi.fn().mockResolvedValue(undefined),
      logout: vi.fn().mockResolvedValue(undefined),
      mailboxCreate: vi.fn().mockImplementation(async (path: string) => ({ path, created: true })),
      mailboxDelete: vi.fn().mockResolvedValue(undefined),
      mailboxRename: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(), // enables client.on('close'/'error') event handler registration
      list: vi.fn().mockResolvedValue([
        { path: 'INBOX', name: 'INBOX', delimiter: '/', flags: new Set() },
        { path: 'Sent', name: 'Sent', delimiter: '/', flags: new Set() },
      ]),
      // getFolders fans STATUS out per folder; isProtectedFolder relies on a
      // working getFolders to resolve specialUse (fail-closed), so the mock must
      // answer STATUS.
      status: vi.fn().mockResolvedValue({ messages: 0, unseen: 0 }),
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

    it('should throw a clear "already exists" error on an IMAP ALREADYEXISTS', async () => {
      const mockClient = (service as any).client;
      mockClient.mailboxCreate.mockRejectedValueOnce({
        responseText: 'ALREADYEXISTS',
      });

      await expect(service.createFolder('INBOX')).rejects.toThrow(
        /already exists/
      );
    });

    it('rejects ImapFlow created:false instead of claiming an existing mailbox', async () => {
      const mockClient = (service as any).client;
      mockClient.mailboxCreate.mockResolvedValueOnce({ path: 'Existing', created: false });

      await expect(service.createFolder('Existing')).rejects.toThrow(/already exists/i);
    });

    it('rejects an unconfirmed mailbox creation result', async () => {
      const mockClient = (service as any).client;
      mockClient.mailboxCreate.mockResolvedValueOnce(undefined);
      mockClient.list.mockResolvedValueOnce([
        { path: 'INBOX', name: 'INBOX', delimiter: '/', flags: new Set() },
      ]);

      await expect(service.createFolder('Unconfirmed')).rejects.toThrow(/not confirmed/i);
    });

    it('surfaces the Proton 409 (Code=2500) cross-namespace collision as "already exists"', async () => {
      const mockClient = (service as any).client;
      // Bridge can return the Proton message without the uppercase IMAP token.
      mockClient.mailboxCreate.mockRejectedValueOnce({
        responseText: 'NO Label or folder with this name already exists (Code=2500)',
      });

      await expect(service.createFolder('Labels/Tech')).rejects.toThrow(
        /already exists.*Proton shares one namespace/
      );
    });

    it('should throw error if not connected', async () => {
      const disconnectedService = new SimpleIMAPService();
      await expect(disconnectedService.createFolder('Test')).rejects.toThrow(
        'IMAP client not connected'
      );
    });

    it('should re-throw unrecognised errors from mailboxCreate (line 1710)', async () => {
      const mockClient = (service as any).client;
      mockClient.mailboxCreate.mockRejectedValueOnce(new Error('Quota exceeded'));

      await expect(service.createFolder('MyFolder')).rejects.toThrow('Quota exceeded');
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

    it('should re-throw unrecognised errors from mailboxDelete (line 1750)', async () => {
      const mockClient = (service as any).client;
      const genericError = new Error('Server internal error');
      mockClient.mailboxDelete.mockRejectedValueOnce(genericError);

      await expect(service.deleteFolder('MyFolder')).rejects.toThrow('Server internal error');
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
        "A folder or label named 'ExistingName' already exists"
      );
    });

    it('should throw error if not connected', async () => {
      const disconnectedService = new SimpleIMAPService();
      await expect(
        disconnectedService.renameFolder('Old', 'New')
      ).rejects.toThrow('IMAP client not connected');
    });

    it('should re-throw unrecognised errors from mailboxRename (line 1791)', async () => {
      const mockClient = (service as any).client;
      const genericError = new Error('Internal server error');
      mockClient.mailboxRename.mockRejectedValueOnce(genericError);

      await expect(service.renameFolder('OldName', 'NewName')).rejects.toThrow('Internal server error');
    });
  });

  describe('Bridge-semantics protections (Phase 1 ultra-review)', () => {
    it('protects a LOCALISED system mailbox by specialUse, not just English name', async () => {
      const mockClient = (service as any).client;
      // Spanish Trash: name check misses it; specialUse \Trash must still protect it.
      mockClient.list.mockResolvedValueOnce([
        { path: 'Papelera', name: 'Papelera', delimiter: '/', flags: new Set(), specialUse: '\\Trash' },
      ]);
      await expect(service.deleteFolder('Papelera')).rejects.toThrow(
        'Cannot delete protected folder: Papelera'
      );
      expect(mockClient.mailboxDelete).not.toHaveBeenCalled();
    });

    it('fails CLOSED: refuses delete when folder discovery fails (no silent destroy)', async () => {
      const mockClient = (service as any).client;
      mockClient.list.mockRejectedValueOnce(new Error('discovery down'));
      // A non-English name can't be ruled out as a localised system mailbox when
      // discovery fails — the delete must throw, never proceed.
      await expect(service.deleteFolder('Folders/Maybe')).rejects.toThrow();
      expect(mockClient.mailboxDelete).not.toHaveBeenCalled();
    });

    it('refuses renaming a folder INTO a reserved system name', async () => {
      const mockClient = (service as any).client;
      await expect(service.renameFolder('Folders/Work', 'Inbox')).rejects.toThrow(
        'Cannot rename to a protected folder name: Inbox'
      );
      expect(mockClient.mailboxRename).not.toHaveBeenCalled();
    });

    it('detects a cross-namespace rename collision even when the server omits ALREADYEXISTS text', async () => {
      const mockClient = (service as any).client;
      // Labels/Tech already exists; renaming Folders/Tech collides on the shared
      // leaf name. Server returns a generic error with no alreadyexists text →
      // the listing-based isNameInUse fallback must still catch it.
      mockClient.list.mockResolvedValue([
        { path: 'INBOX', name: 'INBOX', delimiter: '/', flags: new Set() },
        { path: 'Labels/Tech', name: 'Tech', delimiter: '/', flags: new Set() },
      ]);
      mockClient.mailboxRename.mockRejectedValueOnce(new Error('generic failure'));
      await expect(service.renameFolder('Folders/Tech', 'Labels/Tech')).rejects.toThrow(
        "A folder or label named 'Labels/Tech' already exists"
      );
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

    it('should classify non-system, non-label folders as user-folder (line 520)', async () => {
      const mockClient = (service as any).client;
      // Override list to return a custom user folder (no specialUse, not a system path)
      mockClient.list.mockResolvedValueOnce([
        { path: 'MyCustomFolder', name: 'MyCustomFolder', delimiter: '/', flags: new Set(), specialUse: undefined },
      ]);
      mockClient.status = vi.fn().mockResolvedValue({ messages: 5, unseen: 1 });
      (service as any).folderCachedAt = 0;
      (service as any).folderCache.clear();

      const result = await service.getFolders();
      const customFolder = result.find(f => f.path === 'MyCustomFolder');
      expect(customFolder).toBeDefined();
      expect(customFolder!.folderType).toBe('user-folder');
    });
  });
});

// ─── validateFolderName (private) ────────────────────────────────────────────

describe('validateFolderName edge cases', () => {
  it('throws when folder name is empty (line 240)', async () => {
    const svc = new SimpleIMAPService();
    await svc.connect('localhost', 1143, 'user', 'pass');
    // VALID-003: message now comes from the shared validateImapPath().
    await expect(svc.createFolder('')).rejects.toThrow(/non-empty string/i);
  });

  it('throws when folder name exceeds 1000 chars (line 244)', async () => {
    const svc = new SimpleIMAPService();
    await svc.connect('localhost', 1143, 'user', 'pass');
    await expect(svc.createFolder('a'.repeat(1001))).rejects.toThrow(/exceeds maximum length/i);
  });
});

// ─── connect() TLS / event-handler paths ─────────────────────────────────────

describe('SimpleIMAPService.connect() paths', () => {
  it('uses full TLS validation for non-localhost hosts (line 353)', async () => {
    const svc = new SimpleIMAPService();
    // Connecting to a non-localhost host should NOT disable cert validation
    await svc.connect('mail.example.com', 993, 'user', 'pass');
    expect((svc as any).insecureTls).toBeFalsy();
    expect((svc as any).isConnected).toBe(true);
  });

  it('catches and re-throws when client.connect() rejects (lines 391-393)', async () => {
    const { ImapFlow } = await import('imapflow');
    // Override next ImapFlow construction to return a failing connect
    (ImapFlow as ReturnType<typeof vi.fn>).mockImplementationOnce(function () {
      return {
        connect: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
        on: vi.fn(),
      };
    });

    const svc = new SimpleIMAPService();
    await expect(svc.connect('localhost', 1143, 'user', 'pass')).rejects.toThrow('ECONNREFUSED');
    expect((svc as any).isConnected).toBe(false);
  });

  it("fires 'close' event handler to set isConnected=false (lines 376-377)", async () => {
    const { ImapFlow } = await import('imapflow');
    const registeredHandlers: Record<string, Function> = {};
    (ImapFlow as ReturnType<typeof vi.fn>).mockImplementationOnce(function () {
      return {
        connect: vi.fn().mockResolvedValue(undefined),
        logout: vi.fn().mockResolvedValue(undefined),
        on: vi.fn((event: string, handler: Function) => { registeredHandlers[event] = handler; }),
      };
    });

    const svc = new SimpleIMAPService();
    await svc.connect('localhost', 1143, 'user', 'pass');
    expect((svc as any).isConnected).toBe(true);

    // Simulate IMAP 'close' event
    registeredHandlers['close']();
    expect((svc as any).isConnected).toBe(false);
  });

  it("uses explicit secure=true flag (line 358 branch 0: secure !== undefined)", async () => {
    const svc = new SimpleIMAPService();
    // Passing secure=true explicitly — should use that value, not derive from isLocalhost
    await svc.connect("localhost", 1143, "user", "pass", undefined, true);
    expect((svc as any).isConnected).toBe(true);
    // connectionConfig should record the explicit value
    expect((svc as any).connectionConfig.secure).toBe(true);
  });

  it("connects without credentials (line 364 branch 1: no username/password)", async () => {
    const svc = new SimpleIMAPService();
    // Passing no username/password — auth should be undefined
    await svc.connect("mail.example.com", 993);
    expect((svc as any).isConnected).toBe(true);
  });

  it("skips event handler registration when client has no 'on' method (line 374 branch 1)", async () => {
    const { ImapFlow } = await import("imapflow");
    (ImapFlow as ReturnType<typeof vi.fn>).mockImplementationOnce(function () {
      return {
        connect: vi.fn().mockResolvedValue(undefined),
        logout: vi.fn().mockResolvedValue(undefined),
        // No 'on' method → typeof this.client.on !== 'function' → branch 1 (false)
      };
    });

    const svc = new SimpleIMAPService();
    await svc.connect("localhost", 1143, "user", "pass");
    expect((svc as any).isConnected).toBe(true);
  });

  it("fires 'error' event handler to set isConnected=false (lines 381-382)", async () => {
    const { ImapFlow } = await import('imapflow');
    const registeredHandlers: Record<string, Function> = {};
    (ImapFlow as ReturnType<typeof vi.fn>).mockImplementationOnce(function () {
      return {
        connect: vi.fn().mockResolvedValue(undefined),
        logout: vi.fn().mockResolvedValue(undefined),
        on: vi.fn((event: string, handler: Function) => { registeredHandlers[event] = handler; }),
      };
    });

    const svc = new SimpleIMAPService();
    await svc.connect('localhost', 1143, 'user', 'pass');

    // Simulate IMAP 'error' event
    registeredHandlers['error'](new Error('network error'));
    expect((svc as any).isConnected).toBe(false);
  });
});
