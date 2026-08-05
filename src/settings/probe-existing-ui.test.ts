/**
 * These tests exist because the *helper* being tested was not enough.
 *
 * instanceIdMatches() had unit tests from the day the nonce check landed, but
 * nothing exercised the probe that calls it. Reverting the call site to the
 * original `typeof parsed.hasConfig === "boolean"` left the whole suite green
 * while restoring the vulnerability: whoever bound the settings port first
 * became the URL mailpouch advertises to the tray and to agents — the page
 * where the user is asked to type their Bridge password.
 *
 * So each test here stands up a REAL listener on a real port and asserts what
 * the probe decides about it. Reverting the identity check turns the first
 * test red, which is the only property that makes this suite worth running.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { probeExistingMailpouchUi } from "./probe-existing-ui.js";
import { publishInstanceId, clearInstanceId, answerChallenge } from "./instance-identity.js";

/** Stand up a listener that answers GET /api/status with `payload`. */
async function listener(
  payload: string | ((challenge: string) => string),
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://localhost");
    if (u.pathname !== "/api/status") { res.statusCode = 404; res.end(); return; }
    res.setHeader("content-type", "application/json");
    const challenge = u.searchParams.get("challenge") ?? "";
    res.end(typeof payload === "function" ? payload(challenge) : payload);
  });
  // Track sockets so close() cannot hang on a lingering connection — a test
  // server that outlives its test slows every later file in the worker.
  const sockets = new Set<import("node:net").Socket>();
  server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () => new Promise<void>((resolve) => {
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    }),
  };
}

describe("settings-UI probe identity", () => {
  let directory: string;
  let previousConfigPath: string | undefined;
  let stop: (() => Promise<void>) | null = null;

  beforeEach(() => {
    directory = mkdtempSync(join(homedir(), ".mailpouch-probe-test-"));
    previousConfigPath = process.env.MAILPOUCH_CONFIG;
    process.env.MAILPOUCH_CONFIG = join(directory, ".mailpouch.json");
  });

  afterEach(async () => {
    if (stop) { await stop(); stop = null; }
    clearInstanceId();
    if (previousConfigPath === undefined) delete process.env.MAILPOUCH_CONFIG;
    else process.env.MAILPOUCH_CONFIG = previousConfigPath;
    rmSync(directory, { recursive: true, force: true });
  });

  // THE regression test. This is the exact payload the original bug accepted.
  it("refuses a squatter that echoes hasConfig but has no nonce", async () => {
    publishInstanceId(); // a real UI is registered, but not the squatter
    const l = await listener(JSON.stringify({ hasConfig: true, version: "3.2.1" }));
    stop = l.close;
    expect(await probeExistingMailpouchUi(l.port)).toBeNull();
  });

  it("refuses a squatter that guesses a wrong proof", async () => {
    publishInstanceId();
    const l = await listener(JSON.stringify({ hasConfig: true, instanceProof: "f".repeat(64) }));
    stop = l.close;
    expect(await probeExistingMailpouchUi(l.port)).toBeNull();
  });

  // The genuine UI answers the challenge the way the real server does.
  it("accepts the genuine UI answering the challenge", async () => {
    publishInstanceId();
    const l = await listener((challenge) =>
      JSON.stringify({ hasConfig: true, instanceProof: answerChallenge(challenge, l.port) }));
    stop = l.close;
    expect(await probeExistingMailpouchUi(l.port)).toBe(`http://127.0.0.1:${l.port}`);
  });

  // The regression test for the leak: a squatter that harvested the raw nonce
  // from the old unauthenticated /api/status must still be refused, because
  // the probe now wants a proof bound to a fresh challenge.
  it("refuses a squatter replaying a harvested raw nonce", async () => {
    const id = publishInstanceId();
    const l = await listener(JSON.stringify({ hasConfig: true, instanceId: id, instanceProof: id }));
    stop = l.close;
    expect(await probeExistingMailpouchUi(l.port)).toBeNull();
  });

  // THE relay test. A squatter on the probed port forwards our challenge to
  // the real instance on its fallback port — /api/status is unauthenticated,
  // so the real instance answers anyone — and echoes the reply back. Before
  // the proof was bound to the port, that won. Now the relayed proof answers
  // for the wrong port and is refused.
  it("refuses a squatter relaying the challenge to a real instance on another port", async () => {
    publishInstanceId();

    // The real instance, on a different port, answering honestly for itself.
    const real = await listener((challenge) =>
      JSON.stringify({ hasConfig: true, instanceProof: answerChallenge(challenge, real.port) }));

    // The squatter: forwards whatever challenge it is given to `real`, and
    // returns the real instance's proof verbatim.
    const squatter = await listener((challenge) =>
      JSON.stringify({ hasConfig: true, instanceProof: answerChallenge(challenge, real.port) }));

    stop = async () => { await squatter.close(); await real.close(); };

    expect(await probeExistingMailpouchUi(squatter.port)).toBeNull();
    // Sanity: the real instance on its own port still verifies, so the test
    // is proving port-binding rather than a blanket failure.
    expect(await probeExistingMailpouchUi(real.port)).toBe(`http://127.0.0.1:${real.port}`);
  });

  // A proof is bound to the challenge it answered; a stale one is worthless.
  it("refuses a squatter replaying a proof from an earlier challenge", async () => {
    publishInstanceId();
    const stale = answerChallenge("an-old-challenge", 8766);
    const l = await listener(JSON.stringify({ hasConfig: true, instanceProof: stale }));
    stop = l.close;
    expect(await probeExistingMailpouchUi(l.port)).toBeNull();
  });

  it("refuses a listener that is not serving JSON at all", async () => {
    publishInstanceId();
    const l = await listener("<html>not mailpouch</html>");
    stop = l.close;
    expect(await probeExistingMailpouchUi(l.port)).toBeNull();
  });

  it("refuses a listener that floods the probe with a huge body", async () => {
    publishInstanceId();
    // Valid proof, but buried past the 4 KB cap — the cap must win.
    const l = await listener((challenge) =>
      " ".repeat(8192) + JSON.stringify({ instanceProof: answerChallenge(challenge, l.port) }));
    stop = l.close;
    expect(await probeExistingMailpouchUi(l.port)).toBeNull();
  });

  it("returns null when nothing is listening on the port", async () => {
    publishInstanceId();
    // Bind and immediately release, so the port is almost certainly free.
    const l = await listener("{}");
    const freePort = l.port;
    await l.close();
    expect(await probeExistingMailpouchUi(freePort)).toBeNull();
  });

  it("refuses even a correct-looking response when no instance has published", async () => {
    // No publishInstanceId() — nothing legitimate is running.
    const l = await listener(JSON.stringify({ hasConfig: true, instanceProof: "a".repeat(64) }));
    stop = l.close;
    expect(await probeExistingMailpouchUi(l.port)).toBeNull();
  });
});
