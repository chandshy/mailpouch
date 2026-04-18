import { describe, it, expect, vi } from "vitest";
import { createHmac } from "crypto";
import { WebhookDispatcher, detectFormat, buildPayload, isPrivateWebhookTarget } from "./webhooks.js";
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
});

describe("WebhookDispatcher.deliver — SSRF guard", () => {
  it("refuses a private target without delivering when allowPrivateTargets is false (default)", async () => {
    const fetcher = vi.fn() as unknown as typeof globalThis.fetch;
    const d = new WebhookDispatcher({ fetcher, sleep: () => Promise.resolve() });
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
    const d = new WebhookDispatcher({ fetcher, sleep: () => Promise.resolve(), allowPrivateTargets: true });
    const r = await d.deliver(
      { id: "w1", url: "http://192.168.1.50/hook", format: "cloudevents" },
      stubEvent("grant-created"),
    );
    expect(r.ok).toBe(true);
    expect(fetcher).toHaveBeenCalled();
  });
});

describe("WebhookDispatcher.deliver", () => {
  it("sends a POST with the payload, sets X-Mailpouch-Signature-256 when a secret is set, and advertises the mailpouch UA", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fetcher = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
      captured = { url: String(url), init };
      return new Response("", { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const d = new WebhookDispatcher({ fetcher, sleep: () => Promise.resolve() });
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
    const d = new WebhookDispatcher({ fetcher, sleep: () => Promise.resolve() });
    await d.deliver(
      { id: "w1", url: "https://hooks.example.com/x" },
      stubEvent("grant-created"),
    );
    const hdr = (captured!.init.headers as Record<string, string>)["X-Mailpouch-Signature-256"];
    expect(hdr).toBeUndefined();
  });

  it("retries on 5xx and eventually succeeds", async () => {
    let attempt = 0;
    const fetcher = vi.fn(async () => {
      attempt++;
      return attempt < 3
        ? new Response("", { status: 503 })
        : new Response("", { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const d = new WebhookDispatcher({ fetcher, sleep: () => Promise.resolve() });
    const r = await d.deliver(
      { id: "w", url: "https://hooks.example.com/x" },
      stubEvent(),
    );
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(3);
  });

  it("stops immediately on 4xx (permanent client error)", async () => {
    const fetcher = vi.fn(async () => new Response("", { status: 404 })) as unknown as typeof globalThis.fetch;
    const d = new WebhookDispatcher({ fetcher, sleep: () => Promise.resolve() });
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
    const d = new WebhookDispatcher({ fetcher, sleep: () => Promise.resolve() });
    const r = await d.deliver(
      { id: "w", url: "https://hooks.example.com/x" },
      stubEvent(),
    );
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(2);
  });

  it("gives up after 8 attempts", async () => {
    const fetcher = vi.fn(async () => new Response("", { status: 500 })) as unknown as typeof globalThis.fetch;
    const d = new WebhookDispatcher({ fetcher, sleep: () => Promise.resolve() });
    const r = await d.deliver(
      { id: "w", url: "https://hooks.example.com/x" },
      stubEvent(),
    );
    expect(r.ok).toBe(false);
    expect(r.attempts).toBe(8);
  });

  it("skips delivery when the event kind isn't subscribed", async () => {
    const fetcher = vi.fn();
    const d = new WebhookDispatcher({ fetcher: fetcher as unknown as typeof globalThis.fetch, sleep: () => Promise.resolve() });
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
    const d = new WebhookDispatcher({ fetcher, sleep: () => Promise.resolve() });
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
    const d = new WebhookDispatcher({ fetcher, sleep: () => Promise.resolve() });
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
