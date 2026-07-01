/**
 * Tests for SimpleLoginService — REST client for the Proton-owned alias service.
 * Uses a hand-rolled fetch mock because we're calling a public HTTP endpoint
 * and don't want to couple to any particular fetch-mock library.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SimpleLoginService } from "./simplelogin-service.js";

function mockFetch(handler: (url: string, init: RequestInit) => { status: number; body: unknown }) {
  return vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : String(input);
    const { status, body } = handler(url, init);
    return Promise.resolve(
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  });
}

describe("SimpleLoginService", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("isConfigured", () => {
    it("returns false when instantiated without an API key", () => {
      expect(new SimpleLoginService("").isConfigured()).toBe(false);
    });

    it("returns true when an API key is supplied", () => {
      expect(new SimpleLoginService("sl-test-key").isConfigured()).toBe(true);
    });
  });

  describe("auth header + error handling", () => {
    it("throws with a clear message when called without an API key", async () => {
      const svc = new SimpleLoginService("");
      await expect(svc.listAliases()).rejects.toThrow(/no API key configured/);
    });

    it("sends the Authentication header (non-standard SimpleLogin spelling)", async () => {
      let capturedHeaders: HeadersInit | undefined;
      globalThis.fetch = mockFetch((_, init) => {
        capturedHeaders = init.headers;
        return { status: 200, body: { aliases: [] } };
      }) as unknown as typeof globalThis.fetch;

      const svc = new SimpleLoginService("sl-test-key");
      await svc.listAliases();

      const hdrs = capturedHeaders as Record<string, string>;
      expect(hdrs.Authentication).toBe("sl-test-key");
      expect(hdrs.Authorization).toBeUndefined();
    });

    it("surfaces the structured error message from SimpleLogin on 4xx/5xx", async () => {
      globalThis.fetch = mockFetch(() => ({ status: 403, body: { error: "alias quota exceeded" } })) as unknown as typeof globalThis.fetch;
      const svc = new SimpleLoginService("sl-key");
      await expect(svc.createRandomAlias()).rejects.toThrow(/alias quota exceeded/);
    });

    it("falls back to HTTP status text when the body isn't JSON", async () => {
      globalThis.fetch = mockFetch(() => ({ status: 500, body: "upstream boom" })) as unknown as typeof globalThis.fetch;
      const svc = new SimpleLoginService("sl-key");
      await expect(svc.listAliases()).rejects.toThrow(/500/);
    });

    // ── CRED-012 — secret-shaped substrings are scrubbed from error bodies ──
    it("redacts the configured API key if it appears in an upstream error", async () => {
      const apiKey = "sl_super_secret_api_key_value_1234567890";
      globalThis.fetch = mockFetch(() => ({ status: 400, body: { error: `invalid key '${apiKey}'` } })) as unknown as typeof globalThis.fetch;
      const svc = new SimpleLoginService(apiKey);
      const err = await svc.listAliases().catch((e: Error) => e);
      expect((err as Error).message).not.toContain(apiKey);
      expect((err as Error).message).toContain("[redacted]");
    });

    it("redacts opaque token-shaped substrings even when not the configured key", async () => {
      const leaked = "abcdef0123456789ABCDEFghij";  // 26-char opaque blob
      globalThis.fetch = mockFetch(() => ({ status: 400, body: { error: `token ${leaked} rejected` } })) as unknown as typeof globalThis.fetch;
      const svc = new SimpleLoginService("sl-key");
      const err = await svc.listAliases().catch((e: Error) => e);
      expect((err as Error).message).not.toContain(leaked);
      expect((err as Error).message).toContain("[redacted]");
    });
  });

  describe("listAliases", () => {
    it("paginates through empty results cleanly", async () => {
      globalThis.fetch = mockFetch(() => ({ status: 200, body: { aliases: [] } })) as unknown as typeof globalThis.fetch;
      const svc = new SimpleLoginService("sl-key");
      const aliases = await svc.listAliases();
      expect(aliases).toEqual([]);
    });

    it("aggregates paginated responses until the API returns an empty page", async () => {
      let page = 0;
      globalThis.fetch = mockFetch(() => {
        const batch = page < 2 ? [{ id: page * 10, email: `a${page}@sl`, enabled: true }] : [];
        page++;
        return { status: 200, body: { aliases: batch } };
      }) as unknown as typeof globalThis.fetch;

      const svc = new SimpleLoginService("sl-key");
      const aliases = await svc.listAliases(100);
      expect(aliases).toHaveLength(2);
      expect(aliases[0].email).toBe("a0@sl");
      expect(aliases[1].email).toBe("a1@sl");
    });

    it("respects the pageSize cap", async () => {
      globalThis.fetch = mockFetch(() => ({
        status: 200,
        body: { aliases: [{ id: 1, email: "x@sl", enabled: true }, { id: 2, email: "y@sl", enabled: true }] },
      })) as unknown as typeof globalThis.fetch;

      const svc = new SimpleLoginService("sl-key");
      const aliases = await svc.listAliases(1);
      expect(aliases).toHaveLength(1);
    });
  });

  describe("createRandomAlias", () => {
    it("posts to /api/alias/random/new with the expected body", async () => {
      let capturedBody: string | undefined;
      let capturedUrl = "";
      globalThis.fetch = mockFetch((url, init) => {
        capturedUrl = url;
        capturedBody = init.body as string;
        return { status: 201, body: { id: 42, email: "random@sl.local", enabled: true, note: "test" } };
      }) as unknown as typeof globalThis.fetch;

      const svc = new SimpleLoginService("sl-key");
      const alias = await svc.createRandomAlias({ mode: "word", note: "test", hostname: "example.com" });

      expect(capturedUrl).toContain("/api/alias/random/new");
      expect(capturedUrl).toContain("hostname=example.com");
      expect(JSON.parse(capturedBody!)).toEqual({ mode: "word", note: "test" });
      expect(alias.id).toBe(42);
    });

    it("defaults mode to 'uuid' when not specified", async () => {
      let capturedBody: string | undefined;
      globalThis.fetch = mockFetch((_, init) => {
        capturedBody = init.body as string;
        return { status: 201, body: { id: 1, email: "x@sl", enabled: true } };
      }) as unknown as typeof globalThis.fetch;

      const svc = new SimpleLoginService("sl-key");
      await svc.createRandomAlias();
      expect(JSON.parse(capturedBody!).mode).toBe("uuid");
    });
  });

  describe("createCustomAlias", () => {
    it("posts to /api/v3/alias/custom/new with alias_prefix / signed_suffix", async () => {
      let capturedBody: string | undefined;
      globalThis.fetch = mockFetch((_, init) => {
        capturedBody = init.body as string;
        return { status: 201, body: { id: 99, email: "custom@sl", enabled: true } };
      }) as unknown as typeof globalThis.fetch;

      const svc = new SimpleLoginService("sl-key");
      const alias = await svc.createCustomAlias({
        aliasPrefix: "news",
        signedSuffix: "signed-abc",
        mailboxIds: [1, 2],
        note: "n",
        name: "Newsletter",
      });
      const body = JSON.parse(capturedBody!);
      expect(body.alias_prefix).toBe("news");
      expect(body.signed_suffix).toBe("signed-abc");
      expect(body.mailbox_ids).toEqual([1, 2]);
      expect(alias.id).toBe(99);
    });
  });

  describe("toggle / delete / update / activities", () => {
    it("toggleAlias posts to /api/aliases/:id/toggle and returns enabled state", async () => {
      globalThis.fetch = mockFetch(() => ({ status: 200, body: { enabled: false } })) as unknown as typeof globalThis.fetch;
      const svc = new SimpleLoginService("sl-key");
      await expect(svc.toggleAlias(7)).resolves.toEqual({ enabled: false });
    });

    it("deleteAlias sends a DELETE", async () => {
      let capturedMethod = "";
      globalThis.fetch = mockFetch((_, init) => {
        capturedMethod = init.method ?? "GET";
        return { status: 200, body: "" };
      }) as unknown as typeof globalThis.fetch;
      const svc = new SimpleLoginService("sl-key");
      await svc.deleteAlias(5);
      expect(capturedMethod).toBe("DELETE");
    });

    it("updateAlias sends a PUT with the patch body", async () => {
      let capturedBody: string | undefined;
      globalThis.fetch = mockFetch((_, init) => {
        capturedBody = init.body as string;
        return { status: 200, body: "" };
      }) as unknown as typeof globalThis.fetch;
      const svc = new SimpleLoginService("sl-key");
      await svc.updateAlias(5, { name: "X", note: "y" });
      expect(JSON.parse(capturedBody!)).toEqual({ name: "X", note: "y" });
    });

    it("getAliasActivities paginates until an empty page", async () => {
      let page = 0;
      globalThis.fetch = mockFetch(() => {
        const batch = page === 0 ? [{ action: "forward", from: "a@x", to: "b@y", timestamp: 1 }] : [];
        page++;
        return { status: 200, body: { activities: batch } };
      }) as unknown as typeof globalThis.fetch;

      const svc = new SimpleLoginService("sl-key");
      const activities = await svc.getAliasActivities(5);
      expect(activities).toHaveLength(1);
      expect(activities[0].action).toBe("forward");
    });

    it("getAliasOptions forwards a hostname query and returns the suffix list", async () => {
      let capturedUrl = "";
      globalThis.fetch = mockFetch((url) => {
        capturedUrl = url;
        return {
          status: 200,
          body: {
            can_create: true,
            suffixes: [{ suffix: ".abc@sl", signed_suffix: "sig1", is_custom: false }],
            prefix_suggestion: "news",
          },
        };
      }) as unknown as typeof globalThis.fetch;

      const svc = new SimpleLoginService("sl-key");
      const opts = await svc.getAliasOptions("example.com");
      expect(capturedUrl).toContain("hostname=example.com");
      expect(opts.suffixes).toHaveLength(1);
    });
  });

  describe("reverse-alias contacts", () => {
    it("lists contacts, paginating until an empty page", async () => {
      const pages: Record<string, unknown> = {
        "page_id=0": { contacts: [
          { id: 1, contact: "a@ex.com", reverse_alias: "A <ra1@sl>", reverse_alias_address: "ra1@sl" },
          { id: 2, contact: "b@ex.com", reverse_alias: "B <ra2@sl>", reverse_alias_address: "ra2@sl" },
        ] },
        "page_id=1": { contacts: [] },
      };
      const urls: string[] = [];
      globalThis.fetch = mockFetch((url) => {
        urls.push(url);
        const key = url.includes("page_id=1") ? "page_id=1" : "page_id=0";
        return { status: 200, body: pages[key] };
      }) as unknown as typeof globalThis.fetch;

      const svc = new SimpleLoginService("sl-key");
      const contacts = await svc.listContacts(42);
      expect(contacts).toHaveLength(2);
      expect(contacts[0].reverse_alias_address).toBe("ra1@sl");
      expect(urls[0]).toContain("/api/aliases/42/contacts?page_id=0");
    });

    it("creates a contact and returns the reverse-alias address to send from", async () => {
      let capturedUrl = "", capturedMethod = "", capturedBody = "";
      globalThis.fetch = mockFetch((url, init) => {
        capturedUrl = url; capturedMethod = init.method ?? "GET"; capturedBody = String(init.body ?? "");
        return { status: 201, body: {
          id: 7, contact: "ext@ex.com", reverse_alias: "Ext <ra7@sl>", reverse_alias_address: "ra7@sl", existed: false,
        } };
      }) as unknown as typeof globalThis.fetch;

      const svc = new SimpleLoginService("sl-key");
      const c = await svc.createContact(42, "Name <ext@ex.com>");
      expect(capturedMethod).toBe("POST");
      expect(capturedUrl).toContain("/api/aliases/42/contacts");
      expect(JSON.parse(capturedBody)).toEqual({ contact: "Name <ext@ex.com>" });
      expect(c.reverse_alias_address).toBe("ra7@sl");
    });

    it("toggles a contact's block state via /api/contacts/:id/toggle", async () => {
      let capturedUrl = "", capturedMethod = "";
      globalThis.fetch = mockFetch((url, init) => {
        capturedUrl = url; capturedMethod = init.method ?? "GET";
        return { status: 200, body: { block_forward: true } };
      }) as unknown as typeof globalThis.fetch;

      const svc = new SimpleLoginService("sl-key");
      const r = await svc.toggleContact(7);
      expect(capturedMethod).toBe("POST");
      expect(capturedUrl).toContain("/api/contacts/7/toggle");
      expect(r.block_forward).toBe(true);
    });

    it("deletes a contact via DELETE /api/contacts/:id", async () => {
      let capturedUrl = "", capturedMethod = "";
      globalThis.fetch = mockFetch((url, init) => {
        capturedUrl = url; capturedMethod = init.method ?? "GET";
        return { status: 200, body: { deleted: true } };
      }) as unknown as typeof globalThis.fetch;

      const svc = new SimpleLoginService("sl-key");
      await svc.deleteContact(7);
      expect(capturedMethod).toBe("DELETE");
      expect(capturedUrl).toContain("/api/contacts/7");
    });
  });

  describe("baseUrl normalization", () => {
    it("strips trailing slashes from the base URL", async () => {
      let capturedUrl = "";
      globalThis.fetch = mockFetch((url) => {
        capturedUrl = url;
        return { status: 200, body: { aliases: [] } };
      }) as unknown as typeof globalThis.fetch;
      const svc = new SimpleLoginService("sl-key", "https://sl.example.com///");
      await svc.listAliases();
      expect(capturedUrl).toMatch(/^https:\/\/sl\.example\.com\/api\//);
    });
  });
});
