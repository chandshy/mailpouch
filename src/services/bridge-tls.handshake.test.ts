/**
 * Non-destructive handshake validation of the Bridge TLS handling — the exact
 * scenario that blocked the live-Bridge E2E (and that a naive IMAP client trips
 * on). NO IMAP server, NO mailbox, NO wipe: it stands up a bare TLS server with
 * a Bridge-shaped self-signed cert and exercises the real handshake. Runs in
 * the normal unit suite (`npm test`), so it can never touch a real account.
 *
 * Proton Bridge serves TLS with a self-signed cert whose CN/SAN is the bare IP
 * `127.0.0.1`, while clients connect by host name `localhost`. A naive client
 * fails twice — DEPTH_ZERO_SELF_SIGNED_CERT (untrusted), then
 * ERR_TLS_CERT_ALTNAME_INVALID (host localhost ≠ cert CN 127.0.0.1). Production
 * `buildBridgeTlsOptions` pins the exact cert as the CA (MITM-safe) and skips
 * the hostname check, so the handshake succeeds. The committed fixture cert
 * (test/fixtures/tls/bridge-like-cert.pem) is a throwaway with the same shape.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import tls from "node:tls";
import net from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildBridgeTlsOptions } from "./bridge-tls.js";

const CERT = readFileSync(join(process.cwd(), "test/fixtures/tls/bridge-like-cert.pem"));
const KEY = readFileSync(join(process.cwd(), "test/fixtures/tls/bridge-like-key.pem"));

let server: tls.Server;
let port: number;

beforeAll(async () => {
  // Accept the handshake then close — we only care about TLS, not IMAP.
  server = tls.createServer({ cert: CERT, key: KEY }, (sock) => sock.end());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as net.AddressInfo).port;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

/** Connect BY HOSTNAME "localhost" (cert is CN 127.0.0.1) with extra TLS opts. */
function connect(extra: Record<string, unknown>): Promise<{ ok: boolean; authorized?: boolean; code?: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: { ok: boolean; authorized?: boolean; code?: string }) => { if (!settled) { settled = true; resolve(r); } };
    const sock = tls.connect({ host: "localhost", port, ...extra }, () => {
      const authorized = sock.authorized;
      sock.end();
      done({ ok: true, authorized });
    });
    sock.on("error", (e: NodeJS.ErrnoException) => done({ ok: false, code: e.code }));
    sock.setTimeout(5000, () => { sock.destroy(); done({ ok: false, code: "TIMEOUT" }); });
  });
}

describe("Bridge TLS handshake — self-signed 127.0.0.1 cert reached via hostname localhost", () => {
  it("succeeds with production buildBridgeTlsOptions (pinned cert, hostname check skipped)", async () => {
    const r = await connect(buildBridgeTlsOptions(CERT));
    expect(r.ok).toBe(true);
    expect(r.authorized).toBe(true); // trusted via the pinned CA — not blind-trust
  });

  it("a naive client (no ca) fails self-signed — first failure layer the e2e hit", async () => {
    const r = await connect({});
    expect(r.ok).toBe(false);
    expect(r.code).toBe("DEPTH_ZERO_SELF_SIGNED_CERT");
  });

  it("trusting the cert but keeping the hostname check fails ALTNAME — the exact e2e-fixture bug", async () => {
    const r = await connect({ ca: [CERT] }); // localhost ≠ cert CN 127.0.0.1
    expect(r.ok).toBe(false);
    expect(r.code).toBe("ERR_TLS_CERT_ALTNAME_INVALID");
  });

  it("is genuine pinning, not blind trust: the same options with an empty CA still fail", async () => {
    const r = await connect({ ...buildBridgeTlsOptions(CERT), ca: [] });
    expect(r.ok).toBe(false); // checkServerIdentity is bypassed, but the chain is still verified against ca
  });
});
