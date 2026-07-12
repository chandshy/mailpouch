import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

const mocks = vi.hoisted(() => ({
  manager: null as {
    rebuildFromRegistryAsync: () => Promise<void>;
    activeAccountId: () => string;
    connectAccount: (accountId: string) => Promise<void>;
  } | null,
  readRegistry: vi.fn(),
  createAccount: vi.fn(),
  updateAccount: vi.fn(),
  deleteAccount: vi.fn(),
  setActiveAccount: vi.fn(),
}));

vi.mock("../accounts/registry.js", () => ({
  readRegistry: mocks.readRegistry,
  createAccount: mocks.createAccount,
  updateAccount: mocks.updateAccount,
  deleteAccount: mocks.deleteAccount,
  setActiveAccount: mocks.setActiveAccount,
}));

vi.mock("../accounts/manager.js", () => ({
  getAccountManager: () => mocks.manager,
}));

let createSettingsServer: typeof import("./server.js").createSettingsServer;

beforeAll(async () => {
  ({ createSettingsServer } = await import("./server.js"));
});

beforeEach(() => {
  mocks.manager = null;
  mocks.readRegistry.mockReset();
  mocks.readRegistry.mockReturnValue({ accounts: [{ id: "account-a" }], activeAccountId: "account-a" });
  mocks.createAccount.mockReset();
  mocks.updateAccount.mockReset();
  mocks.deleteAccount.mockReset();
  mocks.setActiveAccount.mockReset();
  mocks.setActiveAccount.mockResolvedValue({ id: "account-b", password: "" });
});

function listen(server: http.Server): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        close: () => server.close(),
      });
    });
  });
}

function request(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function csrfFrom(port: number): Promise<string> {
  const response = await request(port, "GET", "/");
  return /<meta name="csrf-token" content="([^"]+)">/.exec(response.body)![1];
}

async function activate(port: number, csrf: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await request(port, "POST", "/api/accounts/account-b/activate", {
    "x-csrf-token": csrf,
    origin: `http://127.0.0.1:${port}`,
  });
  return { status: response.status, body: JSON.parse(response.body) as Record<string, unknown> };
}

describe("active-account activation", () => {
  it("reports restartRequired when no in-process daemon can rebind services", async () => {
    const server = createSettingsServer({ port: 8765, lan: false, accessToken: null, scheme: "http" });
    const { port, close } = await listen(server);
    try {
      const result = await activate(port, await csrfFrom(port));
      expect(result.status).toBe(200);
      expect(result.body.restartRequired).toBe(true);
    } finally {
      close();
    }
  });

  it("reports a live switch only after the manager rebuilt the selected account", async () => {
    const rebuildFromRegistryAsync = vi.fn().mockResolvedValue(undefined);
    mocks.manager = {
      rebuildFromRegistryAsync,
      activeAccountId: () => "account-b",
      connectAccount: vi.fn().mockResolvedValue(undefined),
    };
    const server = createSettingsServer({ port: 8765, lan: false, accessToken: null, scheme: "http" });
    const { port, close } = await listen(server);
    try {
      const result = await activate(port, await csrfFrom(port));
      expect(result.status).toBe(200);
      expect(result.body.restartRequired).toBe(false);
      expect(rebuildFromRegistryAsync).toHaveBeenCalledTimes(1);
    } finally {
      close();
    }
  });
});

describe("account mutations refresh scoped services", () => {
  const account = {
    id: "account-b",
    name: "Mailbox B",
    providerType: "imap",
    smtpHost: "smtp.example.test",
    smtpPort: 587,
    imapHost: "imap.example.test",
    imapPort: 993,
    username: "b@example.test",
    password: "",
  };

  function createBody(source: typeof account): Record<string, unknown> {
    const { id: _id, ...body } = source;
    return body;
  }

  function managerMock() {
    const rebuildFromRegistryAsync = vi.fn().mockResolvedValue(undefined);
    const connectAccount = vi.fn().mockResolvedValue(undefined);
    mocks.manager = {
      rebuildFromRegistryAsync,
      activeAccountId: () => "account-a",
      connectAccount,
    };
    return { rebuildFromRegistryAsync, connectAccount };
  }

  async function accountRequest(
    port: number,
    csrf: string,
    method: "POST" | "PATCH" | "DELETE",
    path: string,
    body?: Record<string, unknown>,
  ) {
    const response = await request(port, method, path, {
      "x-csrf-token": csrf,
      origin: `http://127.0.0.1:${port}`,
      ...(body ? { "content-type": "application/json" } : {}),
    }, body ? JSON.stringify(body) : undefined);
    return { status: response.status, body: JSON.parse(response.body) as Record<string, unknown> };
  }

  it("rebuilds even a credential-free created account, then connects only it", async () => {
    const { rebuildFromRegistryAsync, connectAccount } = managerMock();
    mocks.createAccount.mockResolvedValue(account);
    const server = createSettingsServer({ port: 8765, lan: false, accessToken: null, scheme: "http" });
    const { port, close } = await listen(server);
    try {
      const result = await accountRequest(port, await csrfFrom(port), "POST", "/api/accounts", createBody(account));
      expect(result.status).toBe(201);
      expect(result.body.restartRequired).toBe(false);
      expect(rebuildFromRegistryAsync).toHaveBeenCalledTimes(1);
      expect(connectAccount).toHaveBeenCalledWith("account-b");
      expect(rebuildFromRegistryAsync.mock.invocationCallOrder[0]).toBeLessThan(connectAccount.mock.invocationCallOrder[0]);
    } finally {
      close();
    }
  });

  it("rebuilds and reconnects only the patched account", async () => {
    const { rebuildFromRegistryAsync, connectAccount } = managerMock();
    mocks.updateAccount.mockResolvedValue(account);
    const server = createSettingsServer({ port: 8765, lan: false, accessToken: null, scheme: "http" });
    const { port, close } = await listen(server);
    try {
      const result = await accountRequest(port, await csrfFrom(port), "PATCH", "/api/accounts/account-b", { username: "new@example.test" });
      expect(result.status).toBe(200);
      expect(result.body.restartRequired).toBe(false);
      expect(rebuildFromRegistryAsync).toHaveBeenCalledTimes(1);
      expect(connectAccount).toHaveBeenCalledWith("account-b");
    } finally {
      close();
    }
  });

  it("rebuilds after deletion without reconnecting another account", async () => {
    const { rebuildFromRegistryAsync, connectAccount } = managerMock();
    mocks.deleteAccount.mockResolvedValue(true);
    const server = createSettingsServer({ port: 8765, lan: false, accessToken: null, scheme: "http" });
    const { port, close } = await listen(server);
    try {
      const result = await accountRequest(port, await csrfFrom(port), "DELETE", "/api/accounts/account-b");
      expect(result.status).toBe(200);
      expect(result.body.restartRequired).toBe(false);
      expect(rebuildFromRegistryAsync).toHaveBeenCalledTimes(1);
      expect(connectAccount).not.toHaveBeenCalled();
    } finally {
      close();
    }
  });

  it("does not claim an immediate patch when the in-process rebuild fails", async () => {
    const rebuildFromRegistryAsync = vi.fn().mockRejectedValue(new Error("registry unavailable"));
    const connectAccount = vi.fn().mockResolvedValue(undefined);
    mocks.manager = {
      rebuildFromRegistryAsync,
      activeAccountId: () => "account-a",
      connectAccount,
    };
    mocks.updateAccount.mockResolvedValue(account);
    const server = createSettingsServer({ port: 8765, lan: false, accessToken: null, scheme: "http" });
    const { port, close } = await listen(server);
    try {
      const result = await accountRequest(port, await csrfFrom(port), "PATCH", "/api/accounts/account-b", { username: "new@example.test" });
      expect(result.status).toBe(200);
      expect(result.body.restartRequired).toBe(true);
      expect(connectAccount).not.toHaveBeenCalled();
    } finally {
      close();
    }
  });

  it("never returns password or SMTP-token plaintext from account endpoints", async () => {
    const secretAccount = {
      ...account,
      password: "account-password-secret",
      smtpToken: "account-smtp-token-secret",
    };
    mocks.readRegistry.mockReturnValue({ accounts: [secretAccount], activeAccountId: "account-b" });
    const { rebuildFromRegistryAsync } = managerMock();
    mocks.createAccount.mockResolvedValue(secretAccount);
    const server = createSettingsServer({ port: 8765, lan: false, accessToken: null, scheme: "http" });
    const { port, close } = await listen(server);
    try {
      const listed = await request(port, "GET", "/api/accounts");
      expect(listed.status).toBe(200);
      expect(listed.body).not.toContain("account-password-secret");
      expect(listed.body).not.toContain("account-smtp-token-secret");
      expect(JSON.parse(listed.body).accounts[0]).toMatchObject({
        password: "••••••••",
        smtpToken: "••••••••",
      });

      const created = await accountRequest(port, await csrfFrom(port), "POST", "/api/accounts", createBody(secretAccount));
      expect(created.status).toBe(201);
      expect(JSON.stringify(created.body)).not.toContain("account-password-secret");
      expect(JSON.stringify(created.body)).not.toContain("account-smtp-token-secret");
      expect((created.body.account as Record<string, unknown>).smtpToken).toBe("••••••••");
      expect(rebuildFromRegistryAsync).toHaveBeenCalledTimes(1);
    } finally {
      close();
    }
  });

  it("rejects unknown, server-owned, and malformed account fields before persistence", async () => {
    const server = createSettingsServer({ port: 8765, lan: false, accessToken: null, scheme: "http" });
    const { port, close } = await listen(server);
    try {
      const csrf = await csrfFrom(port);
      const unknown = await accountRequest(port, csrf, "PATCH", "/api/accounts/account-b", {
        id: "attacker-selected-id",
        lastCheckResult: "ok",
      });
      expect(unknown.status).toBe(400);

      const badPort = await accountRequest(port, csrf, "POST", "/api/accounts", {
        ...createBody(account),
        smtpPort: 65_536,
      });
      expect(badPort.status).toBe(400);

      const placeholderSecret = await accountRequest(port, csrf, "POST", "/api/accounts", {
        ...createBody(account),
        password: "••••••••",
      });
      expect(placeholderSecret.status).toBe(400);

      const blankUsername = await accountRequest(port, csrf, "POST", "/api/accounts", {
        ...createBody(account),
        username: "   ",
      });
      expect(blankUsername.status).toBe(400);

      const badHost = await accountRequest(port, csrf, "PATCH", "/api/accounts/account-b", {
        imapHost: "imap.example.test\r\nInjected: yes",
      });
      expect(badHost.status).toBe(400);

      const badPolicy = await accountRequest(port, csrf, "PATCH", "/api/accounts/account-b", {
        autoStartBridge: "yes",
      });
      expect(badPolicy.status).toBe(400);
      expect(mocks.createAccount).not.toHaveBeenCalled();
      expect(mocks.updateAccount).not.toHaveBeenCalled();
    } finally {
      close();
    }
  });
});
