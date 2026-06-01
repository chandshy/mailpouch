#!/usr/bin/env node
/**
 * check-bulk-live — a SAFE, self-scoped live-Bridge audit of the bulk
 * relocation tools (the v3.0.65 Bug-A "verified landing" fix).
 *
 * Why this exists: the bulk fix is proven against Greenmail (RFC-strict), but
 * the original false-success was BRIDGE-specific — Bridge can answer COPY/MOVE
 * from the "All Mail" union with OK while doing nothing. Greenmail can't
 * reproduce that. This script exercises the real SimpleIMAPService against your
 * real Proton Bridge to confirm bulk moves actually LAND (not just self-report
 * success), including a move out of the real "All Mail" union.
 *
 * SAFETY — read this before running:
 *   • It NEVER calls wipe() and NEVER deletes or empties any folder it did not
 *     create. It only creates uniquely-named `Folders/BulkLive*-<ts>` folders
 *     and its own `[bulklive-<ts>] …` test messages, and deletes ONLY those in
 *     a finally block.
 *   • It does not touch INBOX, Sent, Trash, or any of your existing mail.
 *   • It refuses to do anything destructive without --confirm: a bare run just
 *     prints the plan (the exact folders/subjects it would create).
 *
 * Usage (run when Bridge is quiet):
 *   npm run build                               # ensure dist/ is current
 *   node scripts/check-bulk-live.mjs            # dry run: prints the plan
 *   node scripts/check-bulk-live.mjs --confirm  # actually run the audit
 *
 * Credentials/host are read via the app's own loaders (loadConfig +
 * loadCredentialsFromKeychain), so a keychain-stored Bridge password works
 * without extra setup. Override the config path with MAILPOUCH_CONFIG=… if you
 * keep a dedicated test config.
 */

import { readFileSync } from "fs";
import { ImapFlow } from "imapflow";
import { loadConfig, loadCredentialsFromKeychain } from "../dist/config/loader.js";
import { SimpleIMAPService } from "../dist/services/simple-imap-service.js";

const CONFIRM = process.argv.includes("--confirm");
const ts = String(Date.now());
const TAG = `bulklive-${ts}`;
const SRC  = `Folders/BulkLiveSrc-${ts}`;
const DST  = `Folders/BulkLiveDst-${ts}`;
const DST2 = `Folders/BulkLiveAllMailDst-${ts}`;
const S = { a: `[${TAG}] alpha`, b: `[${TAG}] bravo`, c: `[${TAG}] charlie` };

const log  = (...a) => console.log(...a);
const line = () => log("─".repeat(64));

/** Flatten the loaded config's `connection` block into the fields we need. */
function resolveConn() {
  const cfg = loadConfig();
  if (!cfg || !cfg.connection) throw new Error("No config found (MAILPOUCH_CONFIG or ~/.mailpouch.json). Configure Bridge first.");
  const c = cfg.connection;
  return {
    host: c.imapHost, port: c.imapPort,
    username: c.username, password: c.password,
    bridgeCertPath: c.bridgeCertPath || "",
    allowInsecureBridge: c.allowInsecureBridge ?? false,
    // Bridge IMAP (localhost:1143) is STARTTLS, not implicit TLS.
    secure: false,
  };
}

async function resolvePassword(conn) {
  try {
    const kc = await loadCredentialsFromKeychain();
    if (kc && kc.storage !== "decrypt-failed" && kc.password) return kc.password;
  } catch { /* fall back to config-file value */ }
  return conn.password;
}

/** A raw imapflow client for seeding/verifying/cleanup, mirroring the service's
 *  localhost-Bridge TLS handling. */
function makeRawClient(conn, pass) {
  const tls = {};
  if (conn.bridgeCertPath) { try { tls.ca = readFileSync(conn.bridgeCertPath); } catch { /* ignore */ } }
  if (conn.allowInsecureBridge) tls.rejectUnauthorized = false;
  return new ImapFlow({
    host: conn.host, port: conn.port, secure: conn.secure,
    auth: { user: conn.username, pass }, tls, logger: false, disableAutoIdle: true,
  });
}

function seedMime(subject, user) {
  return [
    `From: <${user}>`,
    `To: <${user}>`,
    `Subject: ${subject}`,
    `Message-ID: <${TAG}.${subject.replace(/\W/g, "")}@bulklive.local>`,
    `Date: ${new Date().toUTCString()}`,
    "",
    "bulk-live-check test body — safe to delete.",
    "",
  ].join("\r\n");
}

async function subjectsIn(raw, folder) {
  const out = [];
  let lock;
  try { lock = await raw.getMailboxLock(folder); }
  catch { return out; }
  try {
    for await (const m of raw.fetch("1:*", { envelope: true }, { uid: true })) {
      if (m.envelope?.subject) out.push(m.envelope.subject);
    }
  } catch { /* empty mailbox */ }
  finally { lock.release(); }
  return out.sort();
}

async function findUidBySubject(raw, folder, subject) {
  let lock;
  try { lock = await raw.getMailboxLock(folder); } catch { return undefined; }
  try {
    const uids = await raw.search({ header: { subject } }, { uid: true });
    return Array.isArray(uids) && uids.length ? uids[uids.length - 1] : undefined;
  } catch { return undefined; }
  finally { lock.release(); }
}

async function findAllMailFolder(svc) {
  const folders = await svc.getFolders();
  const bySpecial = folders.find((f) => /\ball\b/i.test(String(f.specialUse || "")));
  if (bySpecial) return bySpecial.path;
  const byName = folders.find((f) => /all\s*mail/i.test(f.path) || /all\s*mail/i.test(f.name || ""));
  return byName ? byName.path : undefined;
}

const results = [];
const record = (name, verdict, detail) => { results.push({ name, verdict, detail }); log(`  [${verdict}] ${name}${detail ? " — " + detail : ""}`); };

async function run() {
  const conn = resolveConn();

  line();
  log(`check-bulk-live · target ${conn.host}:${conn.port} as ${conn.username}`);
  log(`Plan (creates & later deletes ONLY these):`);
  log(`  folders : ${SRC}, ${DST}, ${DST2}`);
  log(`  messages: ${S.a} | ${S.b} | ${S.c}`);
  log(`  it will NEVER touch existing mail and NEVER call wipe().`);
  line();

  if (!CONFIRM) {
    log("Dry run. Re-run with --confirm to execute the audit against live Bridge.");
    return;
  }
  const pass = await resolvePassword(conn);
  if (!pass) throw new Error("No IMAP password resolved from config or keychain.");

  const raw = makeRawClient(conn, pass);
  await raw.connect();
  const svc = new SimpleIMAPService();
  await svc.connect(conn.host, conn.port, conn.username, pass, conn.bridgeCertPath, conn.secure, conn.allowInsecureBridge);

  try {
    for (const f of [SRC, DST, DST2]) { try { await raw.mailboxCreate(f); } catch { /* exists */ } }

    // ── Check 1: bulk_move_emails from a non-INBOX source → target ──────────
    const u1 = (await raw.append(SRC, seedMime(S.a, conn.username), []))?.uid;
    const u2 = (await raw.append(SRC, seedMime(S.b, conn.username), []))?.uid;
    const u3 = (await raw.append(SRC, seedMime(S.c, conn.username), []))?.uid;
    const r1 = await svc.bulkMoveEmails([u1, u2, u3].filter(Boolean).map(String), DST, SRC);
    const dstSubs = await subjectsIn(raw, DST);
    const srcSubs = await subjectsIn(raw, SRC);
    const landed = [S.a, S.b, S.c].every((s) => dstSubs.includes(s));
    if (landed && srcSubs.length === 0 && r1.success === 3 && r1.failed === 0) {
      record("bulk_move_emails (custom source → target)", "PASS", "all 3 landed; source emptied; counts honest");
    } else if (r1.success > 0 && !landed) {
      record("bulk_move_emails (custom source → target)", "FALSE-SUCCESS", `reported ${r1.success} ok but target only has [${dstSubs.join(", ")}] — THE BUG`);
    } else {
      record("bulk_move_emails (custom source → target)", "FAIL", `success=${r1.success} failed=${r1.failed} dst=[${dstSubs.join(", ")}] src=[${srcSubs.join(", ")}] errors=${JSON.stringify(r1.errors)}`);
    }

    // ── Check 2: bulk_delete_emails removes exactly its own messages ─────────
    const d1 = (await raw.append(SRC, seedMime(S.a, conn.username), []))?.uid;
    const d2 = (await raw.append(SRC, seedMime(S.b, conn.username), []))?.uid;
    const r2 = await svc.bulkDeleteEmails([d1, d2].filter(Boolean).map(String), SRC);
    const afterDel = await subjectsIn(raw, SRC);
    if (r2.success === 2 && r2.failed === 0 && !afterDel.includes(S.a) && !afterDel.includes(S.b)) {
      record("bulk_delete_emails (custom source)", "PASS", "both removed; counts honest");
    } else {
      record("bulk_delete_emails (custom source)", "FAIL", `success=${r2.success} failed=${r2.failed} remaining=[${afterDel.join(", ")}]`);
    }

    // ── Check 3: move OUT of the real "All Mail" union (the live-only gap) ───
    const allMail = await findAllMailFolder(svc);
    if (!allMail) {
      record("bulk_move_emails (All Mail union → target)", "SKIP", "could not locate an All Mail folder via getFolders()");
    } else {
      const seedUid = (await raw.append(SRC, seedMime(S.c, conn.username), []))?.uid;
      await new Promise((r) => setTimeout(r, 1500)); // let the union reflect the append
      const amUid = await findUidBySubject(raw, allMail, S.c);
      if (!amUid) {
        record("bulk_move_emails (All Mail union → target)", "SKIP", `seed not visible in ${allMail} (union may lag); seedUid=${seedUid}`);
      } else {
        const r3 = await svc.bulkMoveEmails([String(amUid)], DST2, allMail);
        const dst2Subs = await subjectsIn(raw, DST2);
        const inTarget = dst2Subs.includes(S.c);
        if (inTarget && r3.success === 1) {
          record("bulk_move_emails (All Mail union → target)", "PASS", `message landed in ${DST2} from ${allMail}`);
        } else if (r3.success > 0 && !inTarget) {
          record("bulk_move_emails (All Mail union → target)", "FALSE-SUCCESS", `reported ${r3.success} ok but NOT in target — Bridge no-op'd the All Mail move (THE BUG)`);
        } else {
          record("bulk_move_emails (All Mail union → target)", "HONEST-FAIL", `reported failed (success=${r3.success} failed=${r3.failed}) — no data lie; acceptable. errors=${JSON.stringify(r3.errors)}`);
        }
      }
    }
  } finally {
    for (const f of [DST2, DST, SRC]) { try { await raw.mailboxDelete(f); } catch { /* best-effort */ } }
    try { await raw.logout(); } catch { /* ignore */ }
    try { await svc.disconnect(); } catch { /* ignore */ }
  }
}

run()
  .then(() => {
    if (!CONFIRM) { process.exit(0); }
    line();
    const bad = results.filter((r) => r.verdict === "FALSE-SUCCESS" || r.verdict === "FAIL");
    log(`Summary: ${results.length} checks — ` + results.map((r) => r.verdict).join(", "));
    if (bad.length) { log(`RESULT: PROBLEMS FOUND (${bad.length}). The bulk fix did not hold on live Bridge.`); process.exit(1); }
    log("RESULT: OK — bulk operations land correctly (or fail honestly) on live Bridge.");
    process.exit(0);
  })
  .catch((e) => { console.error("check-bulk-live ERROR:", e?.message || e); process.exit(2); });
