import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const runner = resolve(process.cwd(), "scripts/improvement-loop.mjs");
const temporaryRoots: string[] = [];

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "mailpouch-improvement-loop-"));
  temporaryRoots.push(root);
  return root;
}

function run(root: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [runner, "--root", root, ...args], { encoding: "utf8" });
  if (result.error) throw result.error;
  return result;
}

function runAsync(root: string, ...args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [runner, "--root", root, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += String(chunk); });
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    child.once("error", rejectRun);
    child.once("close", code => resolveRun({ code, stdout, stderr }));
  });
}

function runGit(root: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.error) throw result.error;
  expect(result.status).toBe(0);
}

function expectOk(result: ReturnType<typeof run>) {
  expect(`${result.stdout}\n${result.stderr}`).toBeDefined();
  expect(result.status).toBe(0);
}

function auditPath(name: string): string {
  return join(".improvement-loop", "audits", name);
}

function makeItem(id: string, command = [process.execPath, "-e", "process.exit(0)"]) {
  return {
    id,
    priority: "P1",
    title: `Improve ${id}`,
    area: "test",
    summary: `Exercise ${id} safely.`,
    acceptanceCriteria: ["A focused regression passes."],
    validation: [{ label: "check", command, timeoutMs: 1_000 }],
    status: "queued",
    createdAt: "2026-07-11T00:00:00.000Z",
  };
}

function writeAudit(root: string, name: string, items: unknown): string {
  const relativePath = auditPath(name);
  writeFileSync(join(root, relativePath), JSON.stringify({ items }, null, 2));
  return relativePath;
}

function readSnapshot(root: string): any {
  return JSON.parse(readFileSync(join(root, ".improvement-loop", "snapshot.json"), "utf8"));
}

async function waitFor(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition.");
    await new Promise(resolveWait => setTimeout(resolveWait, 20));
  }
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("improvement-loop runner", () => {
  it("uses a v2 snapshot, audited imports, fresh validation, and a hashed re-audit", () => {
    const root = createRoot();
    expectOk(run(root, "init"));
    expect(existsSync(join(root, ".improvement-loop", "snapshot.json"))).toBe(true);
    expect(existsSync(join(root, ".improvement-loop", "audits"))).toBe(true);
    expect(existsSync(join(root, ".improvement-loop", "state.json"))).toBe(false);

    const initialAudit = writeAudit(root, "initial.json", [makeItem("LOOP-001"), makeItem("LOOP-002", [process.execPath, "-e", "process.exit(1)"])]);
    expect(run(root, "re-audit", "--summary", "missing artifact").status).not.toBe(0);
    expectOk(run(root, "re-audit", "--audit", initialAudit, "--summary", "Initial independent audit."));
    expect(run(root, "import", initialAudit).status).not.toBe(0);
    expectOk(run(root, "import", initialAudit, "--approve-commands"));
    expectOk(run(root, "status"));
    expect(run(root, "status", "--unknown").status).not.toBe(0);

    expectOk(run(root, "begin", "LOOP-001"));
    expect(run(root, "complete", "LOOP-001", "--summary", "too early").status).not.toBe(0);
    expectOk(run(root, "validate", "LOOP-001"));
    expectOk(run(root, "complete", "LOOP-001", "--summary", "Focused regression and checks passed."));

    const status = run(root, "status", "--json");
    expectOk(status);
    expect(JSON.parse(status.stdout)).toMatchObject({ auditRequired: true, counts: { completed: 1 } });
    const snapshot = readSnapshot(root);
    expect(snapshot.schemaVersion).toBe(2);
    expect(snapshot.state.lastAudit.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.backlog.items[0].audit.commandsApproved).toBe(true);
    const history = readFileSync(join(root, ".improvement-loop", "history.jsonl"), "utf8");
    expect(history).toContain('"action":"re_audited"');
    expect(history).toContain('"action":"validated"');
    expect(history).toContain('"sequence"');
  });

  it("rejects lifecycle-bearing imports and prevents stale spec or workspace validation from completing", () => {
    const root = createRoot();
    expectOk(run(root, "init"));
    writeFileSync(join(root, "source.txt"), "before\n");
    const audit = writeAudit(root, "initial.json", [makeItem("LOOP-001")]);
    const malformed = writeAudit(root, "malformed.json", [{ ...makeItem("LOOP-ORPHAN"), status: "in_progress", startedAt: "2026-07-11T00:00:00.000Z", attempts: 1 }]);
    expectOk(run(root, "re-audit", "--audit", audit, "--summary", "Initial audit."));
    expect(run(root, "import", malformed, "--approve-commands").status).not.toBe(0);
    expectOk(run(root, "import", audit, "--approve-commands"));
    expectOk(run(root, "begin", "LOOP-001"));
    expectOk(run(root, "validate", "LOOP-001"));

    const changedSpec = writeAudit(root, "changed-spec.json", [{ ...makeItem("LOOP-001"), summary: "A materially changed acceptance contract." }]);
    expect(run(root, "import", changedSpec, "--approve-commands", "--replace").status).not.toBe(0);

    writeFileSync(join(root, "source.txt"), "after\n");
    expect(run(root, "complete", "LOOP-001", "--summary", "stale workspace").status).not.toBe(0);
    expectOk(run(root, "validate", "LOOP-001"));
    expectOk(run(root, "complete", "LOOP-001", "--summary", "Fresh workspace validation passed."));
  });

  it("recovers a pending history event, refuses missing layout recreation, and fails closed for malformed locks", () => {
    const root = createRoot();
    expectOk(run(root, "init"));
    const snapshotPath = join(root, ".improvement-loop", "snapshot.json");
    const snapshot = readSnapshot(root);
    snapshot.historySequence += 1;
    snapshot.pendingHistoryEvent = {
      sequence: snapshot.historySequence,
      event: { sequence: snapshot.historySequence, at: "2026-07-11T00:00:00.000Z", action: "recovered_test_event" },
    };
    writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));
    expectOk(run(root, "status"));
    expect(readFileSync(join(root, ".improvement-loop", "history.jsonl"), "utf8")).toContain("recovered_test_event");
    expect(readSnapshot(root).pendingHistoryEvent).toBeNull();

    const lock = join(root, ".improvement-loop", "loop.lock");
    mkdirSync(lock);
    expect(run(root, "status").status).not.toBe(0);
    expect(existsSync(lock)).toBe(true);
    const old = new Date(Date.now() - 20_000);
    utimesSync(lock, old, old);
    expect(run(root, "status").status).not.toBe(0);
    expect(existsSync(lock)).toBe(true);

    rmSync(lock, { recursive: true, force: true });
    rmSync(snapshotPath);
    expect(run(root, "status").status).not.toBe(0);
    expect(existsSync(snapshotPath)).toBe(false);
  });

  it("migrates legacy state with a documented trusted marker and requires fresh v2 validation", () => {
    const root = createRoot();
    const loop = join(root, ".improvement-loop");
    mkdirSync(join(loop, "audits"), { recursive: true });
    const item = { ...makeItem("LOOP-001"), status: "in_progress", startedAt: "2026-07-11T00:00:00.000Z", attempts: 1 };
    writeFileSync(join(loop, "audits", "initial.json"), JSON.stringify({ items: [item] }));
    writeFileSync(join(loop, "state.json"), JSON.stringify({
      schemaVersion: 1,
      initializedAt: "2026-07-11T00:00:00.000Z",
      auditGeneration: 1,
      auditRequired: false,
      activeItemId: "LOOP-001",
      lastAudit: { at: "2026-07-11T00:00:00.000Z", summary: "Legacy initial audit." },
      lastValidation: { itemId: "LOOP-001", ok: true },
    }));
    writeFileSync(join(loop, "backlog.json"), JSON.stringify({ schemaVersion: 1, items: [item] }));
    writeFileSync(join(loop, "history.jsonl"), "");

    expectOk(run(root, "init"));
    const snapshot = readSnapshot(root);
    expect(snapshot.state.activeItemId).toBe("LOOP-001");
    expect(snapshot.state.lastValidation).toBeNull();
    expect(snapshot.backlog.items[0].audit.migrated).toBe(true);
    expect(run(root, "complete", "LOOP-001", "--summary", "legacy validation should not count").status).not.toBe(0);
    expectOk(run(root, "validate", "LOOP-001"));
    expectOk(run(root, "complete", "LOOP-001", "--summary", "Fresh v2 validation passed."));
  });

  it("releases the state lock while validation runs, so a material blocker can win safely", async () => {
    const root = createRoot();
    expectOk(run(root, "init"));
    const slow = [process.execPath, "-e", "setTimeout(() => process.exit(0), 1500)"];
    const audit = writeAudit(root, "slow.json", [makeItem("LOOP-001", slow)]);
    expectOk(run(root, "re-audit", "--audit", audit, "--summary", "Initial audit."));
    expectOk(run(root, "import", audit, "--approve-commands"));
    expectOk(run(root, "begin", "LOOP-001"));

    const validating = runAsync(root, "validate", "LOOP-001");
    await waitFor(() => Boolean(readSnapshot(root).state.validationRun));
    expectOk(run(root, "block", "LOOP-001", "--summary", "External dependency is unavailable."));
    const result = await validating;
    expect(result.code).not.toBe(0);
    expect(readSnapshot(root).backlog.items[0].status).toBe("blocked");
    expect(readSnapshot(root).state.validationRun).toBeNull();
  });

  it("records a timed-out check as failed validation", () => {
    const root = createRoot();
    expectOk(run(root, "init"));
    const neverFinishes = [process.execPath, "-e", "setTimeout(() => process.exit(0), 5000)"];
    const audit = writeAudit(root, "timeout.json", [makeItem("LOOP-001", neverFinishes)]);
    expectOk(run(root, "re-audit", "--audit", audit, "--summary", "Initial audit."));
    expectOk(run(root, "import", audit, "--approve-commands"));
    expectOk(run(root, "begin", "LOOP-001"));
    expect(run(root, "validate", "LOOP-001").status).not.toBe(0);
    const validation = readSnapshot(root).state.lastValidation;
    expect(validation.ok).toBe(false);
    expect(validation.checks[0].timedOut).toBe(true);
  });

  it("fails closed if a recorded audit artifact changes after import", () => {
    const root = createRoot();
    expectOk(run(root, "init"));
    const initial = writeAudit(root, "initial.json", [makeItem("LOOP-001")]);
    expectOk(run(root, "re-audit", "--audit", initial, "--summary", "Initial audit."));
    expectOk(run(root, "import", initial, "--approve-commands"));

    writeAudit(root, "initial.json", [{ ...makeItem("LOOP-001"), summary: "The artifact was changed after import." }]);
    const status = run(root, "status");
    expect(status.status).not.toBe(0);
    expect(`${status.stdout}\n${status.stderr}`).toContain("has changed");
  });

  it("excludes tracked loop metadata from the workspace freshness fingerprint", () => {
    const root = createRoot();
    expectOk(run(root, "init"));
    writeFileSync(join(root, "source.txt"), "stable source\n");
    const initial = writeAudit(root, "initial.json", [makeItem("LOOP-001")]);
    runGit(root, "init");
    runGit(root, "config", "user.email", "loop@example.test");
    runGit(root, "config", "user.name", "Improvement Loop Test");
    runGit(root, "add", ".");
    runGit(root, "commit", "-m", "track loop metadata");

    expectOk(run(root, "re-audit", "--audit", initial, "--summary", "Initial audit."));
    expectOk(run(root, "import", initial, "--approve-commands"));
    expectOk(run(root, "begin", "LOOP-001"));
    expectOk(run(root, "validate", "LOOP-001"));
    expectOk(run(root, "complete", "LOOP-001", "--summary", "Tracked loop metadata did not invalidate source validation."));
  });
});
