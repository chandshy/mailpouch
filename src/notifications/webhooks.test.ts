import { describe, it, expect, vi } from "vitest";
import { createHmac } from "crypto";
import { createServer } from "http";
import type { AddressInfo } from "net";
import {
  WebhookDispatcher,
  detectFormat,
  buildPayload,
  isPrivateWebhookTarget,
  type WebhookDispatcherDeps,
} from "./webhooks.js";
import type { GrantChangedEvent } from "../agents/notifications.js";
import type { AgentGrant } from "../agents/types.js";

function stubEvent(kind: GrantChangedEvent["kind"] = "grant-created"): GrantChangedEvent {
  const grant: AgentGrant = {
    clientId: "pmc_abc",
    clientName: "Claude Desktop",
    status: kind === "grant-approved" ? "active" : kind === "grant-created" ? "pending" : "revoked",
    preset: "read_only",
    createdAt: new Date().toISOString(),
    totalCalls: 0,
  };
  return { kind, grant, seq: 1 };
}

const resolvePublicHostname = async () => [{ address: "8.8.8.8", family: 4 }];

function createDispatcher(deps: WebhookDispatcherDeps = {}): WebhookDispatcher {
  return new WebhookDispatcher({ resolveHostname: resolvePublicHostname, ...deps });
}

describe("isPrivateWebhookTarget", () => {
  it("flags loopback / RFC-1918 / link-local / ULA / metadata", () => {
    for (const u of [
      "http://127.0.0.1/x",
      "http://10.0.0.1/x",
      "http://172.16.0.1/x",
      "http://172.31.255.254/x",
      "http://192.168.1.1/x",
      "http://169.254.169.254/latest",
      "http://0.0.0.0/x",
      "http://localhost/x",
      "http://foo.localhost/x",
      "http://metadata.google.internal/computeMetadata",
      "http://[::1]/x",
      "http://[fe80::1]/x",
      "http://[fd00::1]/x",
      "http://[::ffff:7f00:1]/x",
      "http://100.64.0.1/x",
      "http://198.18.0.1/x",
      "http://192.0.2.1/x",
      "http://example.local/x",
      "http://router.home.arpa/x",
    ]) expect(isPrivateWebhookTarget(u)).toBe(true);
  });

  it("rejects non-http(s) schemes and malformed URLs", () => {
    expect(isPrivateWebhookTarget("file:///etc/passwd")).toBe(true);
    expect(isPrivateWebhookTarget("ftp://example.com/")).toBe(true);
    expect(isPrivateWebhookTarget("not a url")).toBe(true);
  });

  it("allows public http(s) destinations", () => {
    expect(isPrivateWebhookTarget("https://hooks.slack.com/services/X/Y/Z")).toBe(false);
    expect(isPrivateWebhookTarget("https://example.com/hook")).toBe(false);
    expect(isPrivateWebhookTarget("http://172.32.0.1/")).toBe(false); // just outside RFC-1918
  });
});

describe("detectFormat", () => {
  it("picks slack for hooks.slack.com URLs", () => {
    expect(detectFormat("https://hooks.slack.com/services/XXX/YYY/ZZZ")).toBe("slack");
  });

  it("picks discord for discord.com and discordapp.com", () => {
    expect(detectFormat("https://discord.com/api/webhooks/1/abc")).toBe("discord");
    expect(detectFormat("https://discordapp.com/api/webhooks/1/abc")).toBe("discord");
  });

  it("defaults to cloudevents for everything else", () => {
    expect(detectFormat("https://hooks.example.com/endpoint")).toBe("cloudevents");
  });

  it("defaults to cloudevents for malformed URLs", () => {
    expect(detectFormat("not a url")).toBe("cloudevents");
  });
});

describe("buildPayload", () => {
  it("produces a CloudEvents 1.0 envelope", () => {
    const p = buildPayload(stubEvent("grant-created"), "cloudevents");
    expect(p.specversion).toBe("1.0");
    expect(p.type).toBe("com.mailpouch.grant.created");
    expect(p.source).toBe("mailpouch");
    expect((p.data as Record<string, unknown>).clientId).toBe("pmc_abc");
  });

  it("produces a slack-shaped body", () => {
    const p = buildPayload(stubEvent("grant-created"), "slack");
    expect(p.text).toContain("Claude Desktop");
    expect(p.text).toContain("requested access");
  });

  it("produces a discord-shaped body", () => {
    const p = buildPayload(stubEvent("grant-approved"), "discord");
    expect(p.content).toContain("Claude Desktop");
    expect(p.content).toContain("was approved");
  });

  it("produces the raw grant envelope when format=raw", () => {
    const p = buildPayload(stubEvent("grant-denied"), "raw");
    expect(p.kind).toBe("grant-denied");
    expect(p.grant).toBeTruthy();
  });

  it("UI-017 — neutralizes Slack/Discord mentions in a hostile clientName", () => {
    const ev = stubEvent("grant-created");
    ev.grant.clientName = "@here <https://evil/|click>";
    const slack = buildPayload(ev, "slack");
    const discord = buildPayload(ev, "discord");
    // No live @here ping and no clickable <url|label> link survive.
    expect(slack.text).not.toContain("@here ");
    expect(String(slack.text)).not.toMatch(/<https:\/\/evil\/\|click>/);
    expect(discord.content).not.toContain("@here ");
    expect(String(discord.content)).not.toMatch(/<https:\/\/evil\/\|click>/);
  });
});

describe("WebhookDispatcher.deliver — SSRF guard", () => {
  it("refuses a private target without delivering when allowPrivateTargets is false (default)", async () => {
    const fetcher = vi.fn() as unknown as typeof globalThis.fetch;
    const d = createDispatcher({ fetcher, sleep: () => Promise.resolve() });
    const r = await d.deliver(
      { id: "w1", url: "http://127.0.0.1:6379/", format: "cloudevents" },
      stubEvent("grant-created"),
    );
    expect(r.ok).toBe(false);
    expect(r.attempts).toBe(0);
    expect(r.lastError).toBe("private_target_rejected");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("delivers to a private target when allowPrivateTargets=true (opt-in for LAN routers)", async () => {
    const fetcher = vi.fn(async () => new Response("", { status: 200 })) as unknown as typeof globalThis.fetch;
    const d = createDispatcher({ fetcher, sleep: () => Promise.resolve(), allowPrivateTargets: true });
    const r = await d.deliver(
      { id: "w1", url: "http://192.168.1.50/hook", format: "cloudevents" },
      stubEvent("grant-created"),
    );
    expect(r.ok).toBe(true);
    expect(fetcher).toHaveBeenCalled();
  });

  it("rejects a hostname that resolves to a private address before posting", async () => {
    const fetcher = vi.fn() as unknown as typeof globalThis.fetch;
    const resolveHostname = vi.fn(async () => [{ address: "169.254.169.254", family: 4 }]);
    const d = createDispatcher({ fetcher, resolveHostname, sleep: () => Promise.resolve() });
    const r = await d.deliver({ id: "w1", url: "https://webhook.example.test/hook" }, stubEvent());
    expect(r).toMatchObject({ ok: false, attempts: 1, lastError: "private_target_rejected" });
    expect(resolveHostname).toHaveBeenCalledWith("webhook.example.test");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("re-resolves a hostname before every retry", async () => {
    const resolveHostname = vi.fn(async () => [{ address: "8.8.8.8", family: 4 }]);
    let calls = 0;
    const fetcher = vi.fn(async () => {
      calls++;
      return new Response("", { status: calls === 3 ? 200 : 503 });
    }) as unknown as typeof globalThis.fetch;
    const d = createDispatcher({ fetcher, resolveHostname, sleep: () => Promise.resolve() });
    const r = await d.deliver({ id: "w1", url: "https://webhook.example.test/hook" }, stubEvent());
    expect(r).toMatchObject({ ok: true, attempts: 3 });
    expect(resolveHostname).toHaveBeenCalledTimes(3);
  });

  it("bounds a stalled DNS lookup as part of each attempt", async () => {
    const fetcher = vi.fn() as unknown as typeof globalThis.fetch;
    const resolveHostname = vi.fn(() => new Promise<ReadonlyArray<{ address: string; family: number }>>(() => {
      // Deliberately unresolved: the dispatcher owns the deadline.
    }));
    const d = createDispatcher({ fetcher, resolveHostname, sleep: () => Promise.resolve(), attemptTimeoutMs: 1 });
    const r = await d.deliver({ id: "w1", url: "https://webhook.example.test/hook" }, stubEvent());
    expect(r).toMatchObject({ ok: false, attempts: 8, lastError: "attempt_timeout" });
    expect(resolveHostname).toHaveBeenCalledTimes(8);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps the explicit private-target opt-in for DNS-resolved LAN endpoints", async () => {
    const fetcher = vi.fn(async () => new Response("", { status: 200 })) as unknown as typeof globalThis.fetch;
    const resolveHostname = vi.fn(async () => [{ address: "192.168.1.50", family: 4 }]);
    const d = createDispatcher({ fetcher, resolveHostname, allowPrivateTargets: true, sleep: () => Promise.resolve() });
    const r = await d.deliver({ id: "w1", url: "https://router.example.test/hook" }, stubEvent());
    expect(r.ok).toBe(true);
    expect(resolveHostname).toHaveBeenCalledWith("router.example.test");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not let allowPrivateTargets permit non-HTTP URLs", async () => {
    const fetcher = vi.fn() as unknown as typeof globalThis.fetch;
    const d = createDispatcher({ fetcher, allowPrivateTargets: true, sleep: () => Promise.resolve() });
    const r = await d.deliver({ id: "w1", url: "file:///etc/passwd" }, stubEvent());
    expect(r).toMatchObject({ ok: false, attempts: 0, lastError: "invalid_target_rejected" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("pins production delivery to the checked DNS address", async () => {
    let hostHeader = "";
    const server = createServer((request, response) => {
      hostHeader = request.headers.host ?? "";
      response.writeHead(204);
      response.end();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    try {
      const port = (server.address() as AddressInfo).port;
      const resolveHostname = vi.fn(async () => [{ address: "127.0.0.1", family: 4 }]);
      const d = new WebhookDispatcher({ resolveHostname, allowPrivateTargets: true, attemptTimeoutMs: 500 });
      const r = await d.deliver({ id: "w1", url: `http://pinned.webhook.test:${port}/hook` }, stubEvent());
      expect(r).toMatchObject({ ok: true, attempts: 1, status: 204 });
      expect(resolveHostname).toHaveBeenCalledWith("pinned.webhook.test");
      // If delivery used fetch's own DNS lookup, this nonexistent hostname
      // would fail. The Host header must still name the configured endpoint.
      expect(hostHeader).toBe(`pinned.webhook.test:${port}`);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it("times out a stalled pinned request on every retry", async () => {
    const server = createServer(() => {
      // Keep the response open: the dispatcher must enforce its own deadline.
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    try {
      const port = (server.address() as AddressInfo).port;
      const d = new WebhookDispatcher({
        resolveHostname: async () => [{ address: "127.0.0.1", family: 4 }],
        allowPrivateTargets: true,
        attemptTimeoutMs: 10,
        sleep: () => Promise.resolve(),
      });
      const r = await d.deliver({ id: "w1", url: `http://timeout.webhook.test:${port}/hook` }, stubEvent());
      expect(r).toMatchObject({ ok: false, attempts: 8, lastError: "attempt_timeout" });
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});

describe("WebhookDispatcher.deliver", () => {
  it("sends a POST with the payload, sets X-Mailpouch-Signature-256 when a secret is set, and advertises the mailpouch UA", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fetcher = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
      captured = { url: String(url), init };
      return new Response("", { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const d = createDispatcher({ fetcher, sleep: () => Promise.resolve() });
    const r = await d.deliver(
      { id: "w1", url: "https://hooks.example.com/x", secret: "shh", format: "cloudevents" },
      stubEvent("grant-created"),
    );
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(1);
    expect(captured).not.toBeNull();
    const hdrs = captured!.init.headers as Record<string, string>;
    const hdr = hdrs["X-Mailpouch-Signature-256"];
    expect(hdr).toMatch(/^sha256=[a-f0-9]{64}$/);
    // The prior pm-bridge header name must no longer appear.
    expect(hdrs["X-PMBridge-Signature-256"]).toBeUndefined();
    expect(hdrs["User-Agent"]).toMatch(/^mailpouch\/1 /);
    // Verify the HMAC matches.
    const expected = createHmac("sha256", "shh").update(String(captured!.init.body), "utf-8").digest("hex");
    expect(hdr).toBe(`sha256=${expected}`);
  });

  it("omits the signature header when no secret is set", async () => {
    let captured: { init: RequestInit } | null = null;
    const fetcher = vi.fn(async (_url: unknown, init: RequestInit = {}) => {
      captured = { init };
      return new Response("", { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const d = createDispatcher({ fetcher, sleep: () => Promise.resolve() });
    await d.deliver(
      { id: "w1", url: "https://hooks.example.com/x" },
      stubEvent("grant-created"),
    );
    const hdr = (captured!.init.headers as Record<string, string>)["X-Mailpouch-Signature-256"];
    expect(hdr).toBeUndefined();
  });

  it("does not follow redirects and rejects a 3xx response immediately", async () => {
    let captured: RequestInit | undefined;
    const fetcher = vi.fn(async (_url: unknown, init: RequestInit = {}) => {
      captured = init;
      return new Response("", { status: 302, headers: { location: "https://127.0.0.1/internal" } });
    }) as unknown as typeof globalThis.fetch;
    const d = createDispatcher({ fetcher, sleep: () => Promise.resolve() });
    const r = await d.deliver({ id: "w", url: "https://hooks.example.com/x" }, stubEvent());
    expect(r).toMatchObject({ ok: false, status: 302, attempts: 1, lastError: "redirect_rejected" });
    expect(captured?.redirect).toBe("manual");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("aborts a stalled attempt at the configured timeout", async () => {
    const fetcher = vi.fn((_url: unknown, init: RequestInit = {}) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    })) as unknown as typeof globalThis.fetch;
    // Leave enough budget for the literal-target setup before exercising the
    // fetch abort itself. A 1 ms deadline can expire between the synchronous
    // target check and fetch call on a busy CI worker, producing a retry that
    // correctly times out but never invokes the fetch mock.
    const d = createDispatcher({ fetcher, sleep: () => Promise.resolve(), attemptTimeoutMs: 10 });
    // A literal public IP keeps this test focused on fetch cancellation; DNS
    // deadline behavior is covered separately above.
    const r = await d.deliver({ id: "w", url: "https://8.8.8.8/x" }, stubEvent());
    expect(r).toMatchObject({ ok: false, attempts: 8, lastError: "attempt_timeout" });
    expect(fetcher).toHaveBeenCalledTimes(8);
  });

  it("cancels unneeded response bodies instead of consuming endpoint-controlled data", async () => {
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({ cancel: () => { canceled = true; } });
    const fetcher = vi.fn(async () => new Response(body, { status: 200 })) as unknown as typeof globalThis.fetch;
    const d = createDispatcher({ fetcher, sleep: () => Promise.resolve() });
    const r = await d.deliver({ id: "w", url: "https://hooks.example.com/x" }, stubEvent());
    await Promise.resolve();
    expect(r.ok).toBe(true);
    expect(canceled).toBe(true);
  });

  it("retries on 5xx and eventually succeeds", async () => {
    let attempt = 0;
    const fetcher = vi.fn(async () => {
      attempt++;
      return attempt < 3
        ? new Response("", { status: 503 })
        : new Response("", { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const d = createDispatcher({ fetcher, sleep: () => Promise.resolve() });
    const r = await d.deliver(
      { id: "w", url: "https://hooks.example.com/x" },
      stubEvent(),
    );
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(3);
  });

  it("stops immediately on 4xx (permanent client error)", async () => {
    const fetcher = vi.fn(async () => new Response("", { status: 404 })) as unknown as typeof globalThis.fetch;
    const d = createDispatcher({ fetcher, sleep: () => Promise.resolve() });
    const r = await d.deliver(
      { id: "w", url: "https://hooks.example.com/x" },
      stubEvent(),
    );
    expect(r.ok).toBe(false);
    expect(r.attempts).toBe(1);
    expect(r.status).toBe(404);
  });

  it("retries 429 and 408 (soft client errors)", async () => {
    let attempt = 0;
    const fetcher = vi.fn(async () => {
      attempt++;
      return attempt < 2
        ? new Response("", { status: 429 })
        : new Response("", { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const d = createDispatcher({ fetcher, sleep: () => Promise.resolve() });
    const r = await d.deliver(
      { id: "w", url: "https://hooks.example.com/x" },
      stubEvent(),
    );
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(2);
  });

  it("gives up after 8 attempts", async () => {
    const fetcher = vi.fn(async () => new Response("", { status: 500 })) as unknown as typeof globalThis.fetch;
    const d = createDispatcher({ fetcher, sleep: () => Promise.resolve() });
    const r = await d.deliver(
      { id: "w", url: "https://hooks.example.com/x" },
      stubEvent(),
    );
    expect(r.ok).toBe(false);
    expect(r.attempts).toBe(8);
  });

  it("skips delivery when the event kind isn't subscribed", async () => {
    const fetcher = vi.fn();
    const d = createDispatcher({ fetcher: fetcher as unknown as typeof globalThis.fetch, sleep: () => Promise.resolve() });
    const r = await d.deliver(
      { id: "w", url: "https://x/y", subscribe: ["grant-approved"] },
      stubEvent("grant-created"),
    );
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(0);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("auto-selects slack format from URL when format isn't set", async () => {
    let captured: { init: RequestInit } | null = null;
    const fetcher = vi.fn(async (_url: unknown, init: RequestInit = {}) => {
      captured = { init };
      return new Response("", { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const d = createDispatcher({ fetcher, sleep: () => Promise.resolve() });
    await d.deliver(
      { id: "w", url: "https://hooks.slack.com/services/abc" },
      stubEvent("grant-created"),
    );
    const body = JSON.parse(String(captured!.init.body)) as { text: string };
    expect(body.text).toContain("Claude Desktop");
  });
});

describe("WebhookDispatcher.deliverAll", () => {
  it("fires all enabled endpoints in parallel and skips disabled ones", async () => {
    let calls = 0;
    const fetcher = vi.fn(async () => {
      calls++;
      return new Response("", { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const d = createDispatcher({ fetcher, sleep: () => Promise.resolve() });
    const results = await d.deliverAll(
      [
        { id: "a", url: "https://x/1", enabled: true },
        { id: "b", url: "https://x/2", enabled: false },
        { id: "c", url: "https://x/3" },
      ],
      stubEvent(),
    );
    expect(results).toHaveLength(2);
    expect(calls).toBe(2);
  });
});
