import http from "node:http";
import { newChallenge, instanceProofMatches } from "./instance-identity.js";

/**
 * Probe whether a mailpouch settings UI is already serving on `port`.
 * Returns the base URL if the port is occupied by another mailpouch UI
 * (proved by a `/api/status` response echoing the instance nonce published
 * beside the 0o600 config), or null if the port is free, occupied by
 * something else, or occupied by a listener that cannot prove identity.
 *
 * Used so we can defer to a user-run `mailpouch-settings` daemon instead
 * of retrying + warning — the common "standalone settings UI plus stdio
 * MCP in separate processes" setup was previously noisy.
 *
 * Lives here rather than in index.ts so it can be tested against a real
 * listener: index.ts calls main() at import time, so a test that imported
 * it would boot the whole MCP server. That is exactly why the identity
 * check went untested when it was first written — the helper had unit
 * tests, but the decision that *uses* it did not, so reverting this to the
 * old `typeof parsed.hasConfig === "boolean"` check left the suite green.
 */
export async function probeExistingMailpouchUi(port: number): Promise<string | null> {
  // Fresh per probe: a replayed proof from an earlier challenge is useless.
  const challenge = newChallenge();
  return new Promise<string | null>((resolve) => {
    let settled = false;
    const finish = (url: string | null): void => {
      if (settled) return;
      settled = true;
      resolve(url);
    };
    const req = http.request(
      {
        host: "127.0.0.1", port, path: `/api/status?challenge=${challenge}`,
        method: "GET", timeout: 750,
        // agent:false — one-shot connection, never pooled. Node 19+ made the
        // global agent keepAlive by default, so the default would leave a
        // live socket to whatever answered this probe, including a listener
        // we just decided NOT to trust, and would keep any server we probed
        // from closing until its keep-alive timeout expired.
        agent: false,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
          // Body-size cap: a legit /api/status payload is well under 256 B.
          // Anything >4 KB is either a chatty non-mailpouch listener or an
          // attempt to RAM-bomb the probe; either way, abort + resolve so
          // the Promise doesn't hang when we tear the socket down (res
          // destroy does not reliably emit 'end' on an abort path).
          if (body.length > 4096) { res.destroy(); finish(null); }
        });
        res.on("end", () => {
          try {
            const parsed = JSON.parse(body) as Record<string, unknown>;
            // Identity is proof-of-nonce, NOT the response shape. `hasConfig`
            // is a boolean any listener can echo; deferring on it let whoever
            // bound this port first become the URL we advertise to the tray
            // and to agents — i.e. the page that asks for the Bridge password.
            //
            // We verify a hash over the nonce, the challenge, and the port we
            // probed, rather than the nonce itself: /api/status is
            // unauthenticated in loopback mode, so echoing the nonce there
            // would hand the secret to the very process we are trying to
            // exclude. The port is in the hash because without it a squatter
            // on this port could relay our challenge to the real instance on
            // its fallback port and forward the answer back to us.
            if (instanceProofMatches(challenge, port, parsed.instanceProof)) {
              finish(`http://127.0.0.1:${port}`);
              return;
            }
          } catch { /* not JSON — not a mailpouch UI */ }
          finish(null);
        });
        res.on("error",   () => finish(null));
        res.on("close",   () => finish(null));
        res.on("aborted", () => finish(null));
      },
    );
    req.on("error", () => finish(null));
    req.on("timeout", () => { req.destroy(); finish(null); });
    req.end();
  });
}
