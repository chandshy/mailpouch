/**
 * Tests for the local FTS5 index. Uses an in-memory tmp DB so we don't
 * pollute the real home directory. better-sqlite3 is an optional dep; the
 * tests skip themselves cleanly if it isn't installed.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import { FtsIndexService, FtsUnavailableError, openFtsIndex } from "./fts-service.js";

// Quick liveness check — if better-sqlite3 is missing we skip all tests.
function sqliteAvailable(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("better-sqlite3");
    return true;
  } catch {
    return false;
  }
}

// TEST-013: locally, a missing native better-sqlite3 build skips the suite so
// the dev loop isn't blocked. In CI (where the runner provisions build deps)
// a missing sqlite is a real coverage hole — fail loudly instead of silently
// skipping the entire FTS surface.
const SQLITE_AVAILABLE = sqliteAvailable();
if (!SQLITE_AVAILABLE && process.env.CI) {
  throw new Error(
    "FTS suite cannot run: better-sqlite3 is unavailable but CI is set. " +
      "Install native build deps so the FTS coverage isn't silently skipped.",
  );
}
const describeMaybe = SQLITE_AVAILABLE ? describe : describe.skip;

function tmpDb(): string {
  return join(tmpdir(), `mailpouch-fts-${randomBytes(6).toString("hex")}.db`);
}

function sampleRecord(overrides: Partial<Parameters<FtsIndexService["upsert"]>[0]> = {}) {
  return {
    id: `m-${randomBytes(4).toString("hex")}`,
    subject: "Project update",
    from: "alice@example.com",
    to: "chuck@proton.me",
    folder: "INBOX",
    body: "We should sync on the roadmap next week. Talk to Bob about the deployment.",
    dateEpoch: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

describeMaybe("FtsIndexService", () => {
  let dbPath: string;
  let svc: FtsIndexService;

  beforeEach(() => {
    dbPath = tmpDb();
    svc = openFtsIndex(dbPath);
  });

  afterEach(() => {
    svc.close();
    for (const ext of ["", "-wal", "-shm"]) {
      const p = `${dbPath}${ext}`;
      if (existsSync(p)) rmSync(p, { force: true });
    }
  });

  it("upsert + search returns the inserted record", () => {
    svc.upsert(sampleRecord({ body: "Quarterly revenue spreadsheet attached." }));
    const hits = svc.search({ query: "revenue" });
    expect(hits).toHaveLength(1);
    expect(hits[0].snippet).toMatch(/\[\[revenue\]\]/i);
  });

  it("ranks more-relevant hits first (BM25)", () => {
    svc.upsertMany([
      sampleRecord({ id: "strong",  subject: "Quarterly revenue", body: "Revenue revenue revenue Q1 numbers." }),
      sampleRecord({ id: "weak",    subject: "Misc",              body: "Mentioned revenue once. That's it." }),
    ]);
    const hits = svc.search({ query: "revenue" });
    expect(hits.map(h => h.id)).toEqual(["strong", "weak"]);
    // Lower score = better rank in BM25 (implementations differ; ensure ordering property)
    expect(hits[0].score).toBeLessThanOrEqual(hits[1].score);
  });

  it("scopes searches by folder when provided", () => {
    svc.upsertMany([
      sampleRecord({ id: "i-1", folder: "INBOX",  subject: "Invoice #12" }),
      sampleRecord({ id: "s-1", folder: "Sent",   subject: "Invoice reply" }),
    ]);
    const inbox = svc.search({ query: "invoice", folder: "INBOX" });
    expect(inbox.map(h => h.id)).toEqual(["i-1"]);
    const sent = svc.search({ query: "invoice", folder: "Sent" });
    expect(sent.map(h => h.id)).toEqual(["s-1"]);
  });

  it("filters by sinceEpoch", () => {
    const base = 1_700_000_000; // fixed reference
    svc.upsertMany([
      sampleRecord({ id: "old", dateEpoch: base,          body: "quarterly update" }),
      sampleRecord({ id: "new", dateEpoch: base + 10_000, body: "quarterly update" }),
    ]);
    const hits = svc.search({ query: "quarterly", sinceEpoch: base + 5_000 });
    expect(hits.map(h => h.id)).toEqual(["new"]);
  });

  it("applies sinceEpoch BEFORE the limit (no under-return)", () => {
    const base = 1_700_000_000;
    // 5 old (excluded) then 5 recent (included). With the date floor applied
    // post-LIMIT, a limit of 5 would fill with the 5 old rows and then filter to
    // ZERO. Applied in the WHERE (pre-LIMIT), it must return the 5 recent ones.
    svc.upsertMany([
      ...Array.from({ length: 5 }, (_, i) => sampleRecord({ id: `old${i}`, dateEpoch: base, body: `ping ${i}` })),
      ...Array.from({ length: 5 }, (_, i) => sampleRecord({ id: `new${i}`, dateEpoch: base + 10_000, body: `ping ${i}` })),
    ]);
    const hits = svc.search({ query: "ping", sinceEpoch: base + 5_000, limit: 5 });
    expect(hits).toHaveLength(5);
    expect(hits.every(h => h.id.startsWith("new"))).toBe(true);
  });

  it("respects the limit cap (1-200)", () => {
    const many = Array.from({ length: 30 }, (_, i) => sampleRecord({ id: `m${i}`, body: `ping ${i}` }));
    svc.upsertMany(many);
    const hits = svc.search({ query: "ping", limit: 5 });
    expect(hits).toHaveLength(5);
  });

  it("supports phrase and boolean FTS5 syntax", () => {
    svc.upsertMany([
      sampleRecord({ id: "p1", body: "project kickoff" }),
      sampleRecord({ id: "p2", body: "project status update on kickoff details" }),
      sampleRecord({ id: "p3", body: "project meeting" }),
    ]);
    // phrase — "project kickoff" in order, adjacent → only p1 matches.
    const phrase = svc.search({ query: `"project kickoff"` });
    expect(phrase.map(h => h.id)).toEqual(["p1"]);
    // boolean AND
    const booleanAnd = svc.search({ query: "project AND meeting" });
    expect(booleanAnd.map(h => h.id)).toEqual(["p3"]);
  });

  it("upsert replaces an existing row for the same id", () => {
    svc.upsert(sampleRecord({ id: "same", body: "original content" }));
    svc.upsert(sampleRecord({ id: "same", body: "new content revenue" }));
    expect(svc.search({ query: "original" })).toEqual([]);
    expect(svc.search({ query: "revenue" })).toHaveLength(1);
  });

  it("remove drops a record", () => {
    svc.upsert(sampleRecord({ id: "doomed", body: "to be removed" }));
    expect(svc.remove("doomed")).toBe(true);
    expect(svc.remove("doomed")).toBe(false);
    expect(svc.search({ query: "removed" })).toEqual([]);
  });

  it("clear empties the index", () => {
    svc.upsertMany([sampleRecord(), sampleRecord()]);
    svc.clear();
    expect(svc.stats().messageCount).toBe(0);
  });

  it("stats() returns the row count and a db path", () => {
    svc.upsertMany([sampleRecord(), sampleRecord(), sampleRecord()]);
    const s = svc.stats();
    expect(s.messageCount).toBe(3);
    expect(s.dbPath).toBe(dbPath);
    expect(s.databaseBytes).toBeGreaterThan(0);
  });

  it("upsertMany with an empty array is a no-op", () => {
    expect(svc.upsertMany([])).toBe(0);
  });

  it("FtsUnavailableError has the right name for instanceof checks", () => {
    const err = new FtsUnavailableError("nope");
    expect(err).toBeInstanceOf(FtsUnavailableError);
    expect(err.name).toBe("FtsUnavailableError");
  });

  // ── PARSE-002: allowlist scoping ──────────────────────────────────────
  // searchAll used to leak hits and snippet() text from every indexed
  // folder, including Trash/Spam/Archive, when the caller had a
  // folder-restricted grant but didn't pass `folder`. These tests pin the
  // new opts.allowedFolders contract: undefined = unchanged, non-empty =
  // restrict via bound `folder IN (?, ?, …)`, empty = zero hits.
  describe("PARSE-002 folder allowlist", () => {
    function seedAcrossFolders(): void {
      svc.upsertMany([
        sampleRecord({ id: "inbox-1", folder: "INBOX", subject: "password reset for the dashboard" }),
        sampleRecord({ id: "sent-1",  folder: "Sent",  subject: "your password reset confirmation" }),
        sampleRecord({ id: "trash-1", folder: "Trash", subject: "old password reset email" }),
      ]);
    }

    it("with no allowlist, returns hits from every folder", () => {
      seedAcrossFolders();
      const hits = svc.search({ query: "password" });
      expect(hits.map(h => h.folder).sort()).toEqual(["INBOX", "Sent", "Trash"]);
    });

    it("with allowedFolders=['INBOX'], returns only INBOX hits", () => {
      seedAcrossFolders();
      const hits = svc.search({ query: "password", allowedFolders: ["INBOX"] });
      expect(hits.map(h => h.id)).toEqual(["inbox-1"]);
      // Critical: snippet content from Trash/Sent must NOT appear in the response.
      for (const h of hits) {
        expect(h.folder).toBe("INBOX");
        expect(["sent-1", "trash-1"]).not.toContain(h.id);
      }
    });

    it("with allowedFolders=[], returns zero hits", () => {
      seedAcrossFolders();
      const hits = svc.search({ query: "password", allowedFolders: [] });
      expect(hits).toEqual([]);
    });

    it("with allowedFolders + folder, intersects to the single folder", () => {
      seedAcrossFolders();
      // Caller is allowed INBOX + Sent, but asked for only Sent.
      const hits = svc.search({
        query: "password",
        folder: "Sent",
        allowedFolders: ["INBOX", "Sent"],
      });
      expect(hits.map(h => h.id)).toEqual(["sent-1"]);
    });

    it("with allowedFolders + folder outside the allowlist, returns zero hits", () => {
      seedAcrossFolders();
      // Caller is allowed INBOX only, but asked for Trash. The grant gate
      // should have blocked the call upstream; defense-in-depth requires
      // searchAll to still return zero hits.
      const hits = svc.search({
        query: "password",
        folder: "Trash",
        allowedFolders: ["INBOX"],
      });
      expect(hits).toEqual([]);
    });

    it("matches folder names case-insensitively to align with GrantManager (NOCASE)", () => {
      seedAcrossFolders();
      // GrantManager.checkFolderCondition compares via toLowerCase(); the
      // FTS filter mirrors that with COLLATE NOCASE so a grant stored as
      // "inbox" still returns hits against an index of "INBOX". Without
      // this, the agent passes the tool-side gate but reads zero — silent
      // data scoping drop.
      const hits = svc.search({ query: "password", allowedFolders: ["inbox"] });
      expect(hits.length).toBeGreaterThan(0);
      for (const h of hits) expect(h.folder.toLowerCase()).toBe("inbox");
    });

    it("does not execute a SQL-injection payload smuggled through a folder name", () => {
      seedAcrossFolders();
      // The payload is bound as a parameter, not concatenated into SQL.
      // Expected behavior: zero hits (no folder literally named this) AND
      // the messages table still exists afterward.
      const payload = "INBOX'; DROP TABLE messages--";
      const hits = svc.search({ query: "password", allowedFolders: [payload] });
      expect(hits).toEqual([]);
      // Table must still be alive: a follow-up unrestricted search succeeds.
      const followup = svc.search({ query: "password" });
      expect(followup.length).toBeGreaterThan(0);
      // And stats() still reports the seeded rows.
      expect(svc.stats().messageCount).toBe(3);
    });
  });

  // ─── audit-2026-05-28 parser/analytics hardening (v3.0.54) ─────────────────

  describe("PARSE-001 — malformed FTS5 query returns empty, does not throw", () => {
    it("swallows an unterminated-quote query", () => {
      svc.upsert(sampleRecord({ subject: "hello world" }));
      expect(() => svc.search({ query: '"unterminated' })).not.toThrow();
      expect(svc.search({ query: '"unterminated' })).toEqual([]);
    });

    it("swallows a bare unbalanced paren / column-filter garbage", () => {
      svc.upsert(sampleRecord());
      expect(() => svc.search({ query: "foo (((" })).not.toThrow();
      expect(svc.search({ query: "foo (((" })).toEqual([]);
      // Also exercise the allowedFolders SQL path.
      expect(svc.search({ query: '"bad', allowedFolders: ["INBOX"] })).toEqual([]);
    });

    it("still returns hits for a well-formed query", () => {
      svc.upsert(sampleRecord({ subject: "roadmap sync" }));
      expect(svc.search({ query: "roadmap" }).length).toBeGreaterThan(0);
    });
  });

  describe("PARSE-003 — rebuild is atomic", () => {
    it("repopulates the index in a single transaction", () => {
      svc.upsert(sampleRecord({ id: "old", subject: "stale entry" }));
      const indexed = svc.rebuild([
        sampleRecord({ id: "n1", subject: "fresh one" }),
        sampleRecord({ id: "n2", subject: "fresh two" }),
      ]);
      expect(indexed).toBe(2);
      expect(svc.stats().messageCount).toBe(2);
      // Old record is gone; new ones are searchable.
      expect(svc.search({ query: "stale" })).toEqual([]);
      expect(svc.search({ query: "fresh" }).length).toBe(2);
    });

    it("leaves the prior index intact when a record throws mid-rebuild", () => {
      svc.upsert(sampleRecord({ id: "keep", subject: "keep me" }));
      // A record whose body is a non-string Buffer makes upsert's bound write
      // throw; the transaction must roll back the DELETE.
      const bad = sampleRecord({ id: "bad" });
      (bad as { body: unknown }).body = Symbol("not bindable");
      expect(() => svc.rebuild([bad])).toThrow();
      expect(svc.stats().messageCount).toBe(1);
      expect(svc.search({ query: "keep" }).length).toBe(1);
    });
  });
});
