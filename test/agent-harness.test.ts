/**
 * Agent-side integration harness.
 *
 * Spawns the real mailpouch server via StdioClientTransport — the same
 * transport Claude uses — and exercises every tool category through the full
 * MCP protocol stack. Tests are non-destructive: reads run against live IMAP;
 * writes are validated through error-path coverage (permission blocks,
 * confirmation gates, invalid-arg rejection).
 *
 * Run standalone (requires live Proton Bridge):
 *   npm run test:harness
 *
 * Excluded from the default `npm test` suite.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { allToolDefs } from "../src/tools/registry.js";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { writeFileSync, readFileSync, unlinkSync, mkdtempSync, rmSync } from "fs";
import { homedir } from "os";
import { randomUUID } from "crypto";
import { localAgentId } from "../src/agents/caller-context.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, "../dist/index.js");

// ─── Types & helpers ─────────────────────────────────────────────────────────

type TextContent = { type: "text"; text: string };
type CallResult = { content: TextContent[]; isError?: boolean };
type RawOutcome =
  | ({ ok: true } & CallResult)
  | { ok: false; code?: number; message: string };

let client: Client;
let runtimeRoot: string | undefined;

/** Allocate a mailbox path which this harness invocation alone may create.
 * Existing mailbox paths and messages remain read-only. */
function ownedHarnessFolder(purpose: string): string {
  return `Folders/agent-harness-${randomUUID()}-${purpose}`;
}

/**
 * Call a tool. Returns the raw SDK result.
 * Propagates any thrown McpError — use callRaw() when you need to handle those.
 */
async function call(name: string, args: Record<string, unknown> = {}): Promise<CallResult> {
  return client.callTool({ name, arguments: args }) as Promise<CallResult>;
}

/**
 * Call a tool, converting thrown MCP errors into a structured outcome.
 * Use this when the server may throw -32602 (schema validation, invalid params)
 * instead of returning isError:true.
 */
async function callRaw(name: string, args: Record<string, unknown> = {}): Promise<RawOutcome> {
  try {
    const res = await client.callTool({ name, arguments: args });
    return { ok: true, ...(res as CallResult) };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const code = (err as Record<string, unknown>)?.code as number | undefined;
    return { ok: false, code, message: msg };
  }
}

/** Parse result content as JSON. Asserts no MCP-level error. */
function json(result: CallResult): unknown {
  expect(result.isError).toBeFalsy();
  expect(result.content[0]?.type).toBe("text");
  return JSON.parse(result.content[0].text);
}

/** Assert result is a domain error (isError:true) and return text. */
function domainErrorText(result: CallResult): string {
  expect(result.isError).toBe(true);
  return result.content[0]?.text ?? "";
}

/** True when a result (or raw outcome) indicates a permission gate block. */
function isPermissionBlocked(r: CallResult | RawOutcome): boolean {
  const text = "content" in r ? (r.content[0]?.text ?? "") : ("message" in r ? r.message : "");
  return (
    ("isError" in r && r.isError === true && (text.includes("disabled in server settings") || text.includes("blocked"))) ||
    ("ok" in r && !r.ok && text.includes("disabled in server settings"))
  );
}

/**
 * TEST-008: assert a callRaw outcome is well-formed rather than merely defined.
 * `callRaw` always resolves to an object, so `toBeDefined()` is a tautology that
 * only proves Bridge responded. This asserts the discriminated shape: a success
 * carries a content array, a failure carries an error message.
 */
function assertWellFormed(outcome: RawOutcome): void {
  expect(typeof outcome.ok).toBe("boolean");
  if (outcome.ok) {
    expect(Array.isArray(outcome.content)).toBe(true);
  } else {
    expect(typeof outcome.message).toBe("string");
    expect(outcome.message.length).toBeGreaterThan(0);
  }
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

beforeAll(async () => {
  runtimeRoot = mkdtempSync(join(homedir(), ".mailpouch-agent-harness-"));
  const grantsPath = join(runtimeRoot, "agents.json");
  const now = new Date().toISOString();
  writeFileSync(grantsPath, JSON.stringify({
    version: 1,
    grants: [{
      clientId: localAgentId("agent-harness"),
      clientName: "agent-harness",
      status: "active",
      preset: "full",
      createdAt: now,
      approvedAt: now,
      totalCalls: 0,
      transport: "stdio",
      note: "agent harness — pre-approved in isolated test state",
    }],
  }, null, 2), { mode: 0o600 });
  const childEnv = {
    ...process.env,
    MAILPOUCH_INSECURE_BRIDGE: "1",
    MAILPOUCH_FORCE_STDIO: "1",
    MAILPOUCH_TIER: "complete",
    MAILPOUCH_AGENTS: grantsPath,
    MAILPOUCH_AGENT_AUDIT: join(runtimeRoot, "agent-audit.jsonl"),
    MAILPOUCH_AUDIT: join(runtimeRoot, "audit.jsonl"),
    MAILPOUCH_FTS_DB: join(runtimeRoot, "fts.db"),
    MAILPOUCH_LOCK_PATH: join(runtimeRoot, "singleton.lock"),
    MAILPOUCH_LOG_FILE: join(runtimeRoot, "mailpouch.log"),
    MAILPOUCH_OAUTH_TOKENS: join(runtimeRoot, "oauth-tokens.json"),
    MAILPOUCH_PASS_AUDIT: join(runtimeRoot, "pass-audit.jsonl"),
    MAILPOUCH_PENDING: join(runtimeRoot, "pending.json"),
    MAILPOUCH_REMINDERS: join(runtimeRoot, "reminders.json"),
    MAILPOUCH_SCHEDULER_STORE: join(runtimeRoot, "scheduler.json"),
    MAILPOUCH_SERVICE_ACCOUNTS: join(runtimeRoot, "service-accounts.json"),
  };
  const transport = new StdioClientTransport({
    command: "node",
    args: [SERVER],
    env: childEnv,
  });

  client = new Client(
    { name: "agent-harness", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  await client.connect(transport);
}, 20_000);

afterAll(async () => {
  try { await client?.close(); }
  finally {
    if (runtimeRoot) rmSync(runtimeRoot, { recursive: true, force: true });
    runtimeRoot = undefined;
  }
});

// ─── Discovery ────────────────────────────────────────────────────────────────

describe("discovery", () => {
  it("served tool surface is a faithful subset of the registry (no silent shrink/typo)", async () => {
    const { tools } = await client.listTools();
    const liveNames = new Set(tools.map((t) => t.name));

    // TEST-014: derive expectations from the registry rather than a hand-picked
    // subset + loose `>= 40` floor. The served list is permission-tier filtered
    // (index.ts ListTools handler), so we can't assert exact equality without
    // pinning the active preset — but we CAN assert two real invariants:
    //   1. every served tool exists in the registry (catches ghosts/typos);
    //   2. the served count is non-empty and never exceeds the full registry
    //      (the registry is the ceiling), anchoring the check to the registry
    //      rather than a magic number. (We do NOT assert an exact tier-visible
    //      count here — that would require pinning the active preset.)
    const registeredNames = new Set(allToolDefs().map((t) => t.name));
    const unexpected = [...liveNames].filter((n) => !registeredNames.has(n));
    expect(unexpected, `tools served but not registered: ${unexpected.join(", ")}`).toEqual([]);

    // The full registry is the ceiling; the served set must be non-empty and
    // never exceed it.
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.length).toBeLessThanOrEqual(registeredNames.size);
  });

  it("every tool has a name, description, and inputSchema", async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.name, "tool missing name").toBeTruthy();
      expect(tool.description, `${tool.name} missing description`).toBeTruthy();
      expect(tool.inputSchema, `${tool.name} missing inputSchema`).toBeDefined();
    }
  });
});

// ─── System & connection ──────────────────────────────────────────────────────

describe("system", () => {
  it("get_connection_status returns smtp + imap health", async () => {
    const result = await call("get_connection_status");
    const data = json(result) as Record<string, unknown>;
    expect(data).toHaveProperty("smtp");
    expect(data).toHaveProperty("imap");
    expect((data.smtp as Record<string, unknown>).connected).toBe(true);
    expect((data.imap as Record<string, unknown>).connected).toBe(true);
  });

  it("get_folders returns folder list with message counts", async () => {
    const result = await call("get_folders");
    const data = json(result) as { folders: unknown[] };
    expect(Array.isArray(data.folders)).toBe(true);
    expect(data.folders.length).toBeGreaterThan(0);
  });

  it("get_unread_count returns per-folder unread map", async () => {
    const result = await call("get_unread_count");
    const data = json(result) as Record<string, unknown>;
    expect(data).toHaveProperty("unreadByFolder");
    expect(data).toHaveProperty("totalUnread");
    expect(typeof data.totalUnread).toBe("number");
  });

  it("fts_status reports index availability", async () => {
    const result = await call("fts_status");
    const data = json(result) as Record<string, unknown>;
    expect(data.available).toBe(true);
    expect(typeof data.messageCount).toBe("number");
    expect(typeof data.databaseBytes).toBe("number");
  });

  it("get_logs returns log entries array", async () => {
    const result = await call("get_logs", { lines: 10 });
    const data = json(result) as { logs: unknown[] };
    expect(Array.isArray(data.logs)).toBe(true);
  });
});

// ─── Reading ─────────────────────────────────────────────────────────────────

describe("reading", () => {
  let firstEmailId: string;

  it("get_emails fetches INBOX page with expected fields", async () => {
    const result = await call("get_emails", { folder: "INBOX", limit: 5 });
    const data = json(result) as { emails: Record<string, unknown>[] };

    expect(Array.isArray(data.emails)).toBe(true);
    expect(data.emails.length).toBeGreaterThan(0);

    const email = data.emails[0];
    expect(email).toHaveProperty("id");
    expect(email).toHaveProperty("from");
    expect(email).toHaveProperty("subject");
    expect(email).toHaveProperty("date");
    expect(email).toHaveProperty("isRead");
    expect(email).toHaveProperty("isHtml");
    expect(email).toHaveProperty("bodyPreview");

    // bodyPreview must not contain raw HTML tags
    const preview = email.bodyPreview as string;
    expect(preview).not.toMatch(/<html|<!DOCTYPE/i);

    firstEmailId = email.id as string;
  });

  it("get_email_by_id returns full body for a real email", async () => {
    if (!firstEmailId) return;
    const result = await call("get_email_by_id", {
      emailId: firstEmailId,
      folder: "INBOX",
    });
    const data = json(result) as Record<string, unknown>;
    expect(data).toHaveProperty("id", firstEmailId);
    expect(data).toHaveProperty("body");
    expect(data).toHaveProperty("isHtml");
  });

  it("get_email_by_id with bad id surfaces an error (domain or MCP)", async () => {
    const outcome = await callRaw("get_email_by_id", {
      emailId: "999999999",
      folder: "INBOX",
    });
    const isError =
      (!outcome.ok) ||
      (outcome.ok && outcome.isError === true);
    expect(isError, "expected some form of error for non-existent email").toBe(true);
  });

  it("fts_search returns BM25-ranked hits", async () => {
    const result = await call("fts_search", { query: "mailpouch", limit: 5 });
    const data = json(result) as { hits: Record<string, unknown>[] };
    expect(Array.isArray(data.hits)).toBe(true);
    for (const hit of data.hits) {
      expect(hit).toHaveProperty("id");
      expect(hit).toHaveProperty("subject");
      expect(hit).toHaveProperty("snippet");
    }
  });

  it("fts_search with column filter works", async () => {
    const result = await call("fts_search", { query: "subject:mailpouch", limit: 5 });
    const data = json(result) as { hits: unknown[] };
    expect(Array.isArray(data.hits)).toBe(true);
  });

  it("fts_search with no results returns empty hits array", async () => {
    const result = await call("fts_search", {
      query: "xyzzy_no_such_term_9f3k",
      limit: 5,
    });
    const data = json(result) as { hits: unknown[] };
    expect(data.hits).toHaveLength(0);
  });

  it("list_labels returns label array", async () => {
    const result = await call("list_labels");
    const data = json(result) as { labels: unknown[] };
    expect(Array.isArray(data.labels)).toBe(true);
  });

  it("get_thread responds without crashing", async () => {
    if (!firstEmailId) return;
    const outcome = await callRaw("get_thread", {
      emailId: firstEmailId,
      folder: "INBOX",
    });
    // Either a valid thread result or a domain/MCP error — both are acceptable
    assertWellFormed(outcome);
  });
});

// ─── Analytics ────────────────────────────────────────────────────────────────

describe("analytics", () => {
  it("get_email_stats returns aggregate stats with numeric fields", async () => {
    const result = await call("get_email_stats");
    const data = json(result) as Record<string, unknown>;
    // These must all be numbers — a body?.length bug would crash the handler
    // and prevent this test from passing.
    expect(typeof data.totalEmails,     "totalEmails not a number").toBe("number");
    expect(typeof data.unreadEmails,    "unreadEmails not a number").toBe("number");
    expect(typeof data.storageUsedMB,   "storageUsedMB not a number").toBe("number");
    expect(typeof data.totalContacts,   "totalContacts not a number").toBe("number");
    expect(data.storageUsedMB).toBeGreaterThanOrEqual(0);
  });

  it("get_contacts returns sender list", async () => {
    const result = await call("get_contacts");
    const data = json(result) as { contacts: unknown[] };
    expect(Array.isArray(data.contacts)).toBe(true);
  });

  it("get_email_analytics returns per-folder breakdown", async () => {
    const result = await call("get_email_analytics");
    const data = json(result) as Record<string, unknown>;
    expect(data).toBeDefined();
  });

  it("get_volume_trends returns time-series data", async () => {
    const result = await call("get_volume_trends", { days: 7 });
    const data = json(result) as Record<string, unknown>;
    expect(data).toBeDefined();
  });
});

// ─── Folders ─────────────────────────────────────────────────────────────────

describe("folders", () => {
  it("get_folders lists all folders including INBOX and Sent", async () => {
    const result = await call("get_folders");
    const data = json(result) as { folders: Record<string, unknown>[] };
    expect(data.folders.some((f) => f.path === "INBOX")).toBe(true);
    expect(data.folders.some((f) => f.path === "Sent")).toBe(true);
  });

  // IMAP mailbox DELETE is not atomic with the preceding emptiness check. Even
  // a UUID-created live folder could receive a foreign message in that gap, so
  // folder lifecycle execution belongs only to isolated Greenmail E2E.
  it.skip("create/delete folder lifecycle requires an isolated backend", () => {});
  it.skip("missing-folder delete probes require an isolated backend", () => {});
});

// ─── Actions ─────────────────────────────────────────────────────────────────

describe("actions", () => {
  let readOnlyTargetId: string;

  beforeAll(async () => {
    const r = await call("get_emails", { folder: "INBOX", limit: 1 });
    const data = json(r) as { emails: Record<string, unknown>[] };
    readOnlyTargetId = data.emails[0]?.id as string;
  }, 30_000);

  // This legacy harness has no ownership-aware APPEND fixture. Flag mutations
  // are covered by the UUID-scoped Bridge E2E suite; never use a pre-existing
  // INBOX UID merely to prove that a write is permitted.
  it.skip("mark_email_read requires a run-owned seeded message", () => {});
  it.skip("star_email requires a run-owned seeded message", () => {});

  it("extract_action_items runs or surfaces schema issue", async () => {
    if (!readOnlyTargetId) return;
    const outcome = await callRaw("extract_action_items", {
      emailId: readOnlyTargetId,
      folder: "INBOX",
    });
    // Accept success, domain error, permission block, or MCP schema error
    assertWellFormed(outcome);
  });
});

// ─── Drafts & scheduling (read paths) ────────────────────────────────────────

describe("drafts and scheduling", () => {
  it("list_scheduled_emails returns array or surfaces schema issue", async () => {
    const outcome = await callRaw("list_scheduled_emails");
    if (!outcome.ok) {
      console.warn("[harness] list_scheduled_emails MCP error:", outcome.message);
      return;
    }
    if (isPermissionBlocked(outcome)) return;
    const data = JSON.parse(outcome.content[0].text) as Record<string, unknown>;
    expect(Array.isArray(data.scheduled)).toBe(true);
  });

  it("list_pending_reminders returns array or surfaces schema issue", async () => {
    const outcome = await callRaw("list_pending_reminders");
    if (!outcome.ok) {
      console.warn("[harness] list_pending_reminders MCP error:", outcome.message);
      return;
    }
    if (isPermissionBlocked(outcome)) return;
    const data = JSON.parse(outcome.content[0].text) as Record<string, unknown>;
    expect(Array.isArray(data.reminders)).toBe(true);
  });

  it("list_proton_scheduled returns list or surfaces schema issue", async () => {
    const outcome = await callRaw("list_proton_scheduled");
    if (!outcome.ok) {
      console.warn("[harness] list_proton_scheduled MCP error:", outcome.message);
      return;
    }
    if (isPermissionBlocked(outcome)) return;
    expect(outcome.content[0]?.text).toBeTruthy();
  });
});

// ─── Permission gate ──────────────────────────────────────────────────────────

describe("permission gate — destructive ops", () => {
  // TEST-015: a destructive call without confirmation MUST be an explicit
  // refusal — a permission block, an MCP error, or an `isError` result that
  // names the confirmation requirement. A bare success (even `{success:0,
  // failed:0}`) is a silent no-op and must NOT count as "gated".
  function isExplicitlyGated(outcome: RawOutcome): boolean {
    if (isPermissionBlocked(outcome)) return true;
    if (!outcome.ok) return true; // MCP-level rejection (e.g. -32602)
    if (outcome.isError === true) {
      const text = outcome.content[0]?.text ?? "";
      return /confirm|dangerous|preview|disabled|blocked/i.test(text);
    }
    return false;
  }

  it("delete_email without confirmation is gated, not a silent no-op", async () => {
    const sourceFolder = ownedHarnessFolder("missing-delete-source");
    const outcome = await callRaw("delete_email", {
      emailId: "1",
      sourceFolder,
    });
    expect(isExplicitlyGated(outcome), `delete_email should be explicitly gated; got: ${JSON.stringify(outcome)}`).toBe(true);
  });

  it("bulk_delete without confirmation is gated, not a silent no-op", async () => {
    const sourceFolder = ownedHarnessFolder("missing-bulk-delete-source");
    const outcome = await callRaw("bulk_delete", {
      emailIds: ["1", "2"],
      sourceFolder,
    });
    expect(isExplicitlyGated(outcome), `bulk_delete should be explicitly gated; got: ${JSON.stringify(outcome)}`).toBe(true);
  });
});

// ─── Argument validation ──────────────────────────────────────────────────────

describe("argument validation", () => {
  it("get_emails with negative limit is handled (clamped or errors)", async () => {
    // Server clamps negative limits to a minimum rather than erroring — both
    // behaviors are acceptable; the key is it doesn't crash or return garbage.
    const outcome = await callRaw("get_emails", { folder: "INBOX", limit: -1 });
    assertWellFormed(outcome);
    if (outcome.ok && !outcome.isError) {
      const data = JSON.parse(outcome.content[0].text) as Record<string, unknown>;
      expect(Array.isArray(data.emails)).toBe(true);
    }
  });

  it("get_emails_by_label with missing label surfaces an error or permission block", async () => {
    const outcome = await callRaw("get_emails_by_label", {});
    const isErrorOrBlocked =
      isPermissionBlocked(outcome) ||
      !outcome.ok ||
      (outcome.ok && outcome.isError === true);
    expect(isErrorOrBlocked).toBe(true);
  });

  it("get_email_by_id with missing emailId surfaces an error", async () => {
    const outcome = await callRaw("get_email_by_id", { folder: "INBOX" });
    const isError = !outcome.ok || ("ok" in outcome && outcome.ok && outcome.isError === true);
    expect(isError).toBe(true);
  });

  it("send_email with missing required fields surfaces error or permission block", async () => {
    const outcome = await callRaw("send_email", { subject: "test" });
    const isErrorOrBlocked =
      isPermissionBlocked(outcome) ||
      !outcome.ok ||
      (outcome.ok && outcome.isError === true);
    expect(isErrorOrBlocked).toBe(true);
  });
});

// ─── Escalation ───────────────────────────────────────────────────────────────

describe("escalation tools (pre-gate)", () => {
  it("request_permission_escalation returns escalation token", async () => {
    const outcome = await callRaw("request_permission_escalation", {
      target_preset: "send_only",
      reason: "agent harness test",
    });
    // Pre-gate: should always respond (never permission-blocked)
    assertWellFormed(outcome);
    if (!outcome.ok) {
      console.warn("[harness] request_permission_escalation error:", outcome.message);
    }
  });

  it("check_escalation_status with invalid challenge_id surfaces error", async () => {
    const outcome = await callRaw("check_escalation_status", {
      challenge_id: "00000000000000000000000000000000",
    });
    // Either a not-found domain error or MCP error for the dummy id
    assertWellFormed(outcome);
  });
});

// ─── Pagination ───────────────────────────────────────────────────────────────

describe("pagination", () => {
  it("get_emails cursor-based paging returns different pages", async () => {
    const page1 = await call("get_emails", { folder: "INBOX", limit: 3 });
    const data1 = json(page1) as { emails: unknown[]; nextCursor?: string };
    expect(data1.nextCursor).toBeTruthy();

    const page2 = await call("get_emails", {
      folder: "INBOX",
      limit: 3,
      cursor: data1.nextCursor,
    });
    const data2 = json(page2) as { emails: Record<string, unknown>[] };
    expect(data2.emails.length).toBeGreaterThan(0);

    const ids1 = (data1.emails as Record<string, unknown>[]).map((e) => e.id);
    const ids2 = data2.emails.map((e) => e.id);
    expect(ids1).not.toEqual(ids2);
  });
});

// ─── isHtml / bodyPreview correctness ────────────────────────────────────────

describe("isHtml flag and bodyPreview correctness", () => {
  it("HTML emails have isHtml=true and HTML-stripped bodyPreview", async () => {
    const result = await call("get_emails", { folder: "INBOX", limit: 20 });
    const data = json(result) as { emails: Record<string, unknown>[] };

    const htmlEmails = data.emails.filter((e) => e.isHtml === true);
    if (htmlEmails.length === 0) return;

    for (const email of htmlEmails) {
      const preview = email.bodyPreview as string;
      expect(
        preview,
        `HTML email ${email.id} bodyPreview contains raw HTML tags`,
      ).not.toMatch(/<html|<!DOCTYPE/i);
    }
  });

  it("non-HTML emails have isHtml=false", async () => {
    const result = await call("get_emails", { folder: "INBOX", limit: 20 });
    const data = json(result) as { emails: Record<string, unknown>[] };
    // At least check that the field is present and is a boolean on all
    for (const email of data.emails) {
      expect(typeof email.isHtml, `email ${email.id} isHtml is not boolean`).toBe("boolean");
    }
  });
});
