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

const describeMaybe = sqliteAvailable() ? describe : describe.skip;

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
});
