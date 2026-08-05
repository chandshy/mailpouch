import http from "node:http";

/**
 * Best-effort: does the listener on `port` look like a mailpouch settings UI?
 *
 * This answer controls ONE thing — whether "the configured port was occupied"
 * is logged as a warning or as debug noise. It is deliberately NOT an identity
 * check, and nothing security-relevant may be derived from it.
 *
 * That distinction is the whole point. This used to be an identity check: we
 * probed the port and, if the occupant looked like mailpouch, adopted its URL
 * as the one we advertise to the tray and to agents — the page that asks for
 * the user's Bridge password. Authenticating a loopback neighbour well enough
 * to hand it that responsibility took four rounds of security fixes (a forged
 * `hasConfig` boolean, a nonce echoed over an unauthenticated endpoint, pooled
 * sockets to untrusted listeners, and a proof that could be relayed to a real
 * instance on another port), and a fifth issue remained: we verified once at
 * startup and then trusted the URL for the process lifetime.
 *
 * So we stopped. We always bind our own port and only ever advertise a URL we
 * serve ourselves. Two settings UIs is mildly untidy; it is not a security
 * problem, and mixed-version installs already produce that outcome. All this
 * function does now is keep the logs quiet, which was the only benefit the
 * reuse path ever delivered.
 *
 * Because a wrong answer costs a log level and nothing else, a forgeable shape
 * check is entirely adequate here.
 */
export async function portOccupantLooksLikeMailpouch(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (v: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const req = http.request(
      {
        host: "127.0.0.1", port, path: "/api/status", method: "GET", timeout: 750,
        // One-shot: never pool a socket to a listener we do not control.
        agent: false,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
          if (body.length > 4096) { res.destroy(); finish(false); }
        });
        res.on("end", () => {
          try {
            const parsed = JSON.parse(body) as Record<string, unknown>;
            finish(typeof parsed.hasConfig === "boolean");
            return;
          } catch { /* not JSON — not a mailpouch UI */ }
          finish(false);
        });
        res.on("error",   () => finish(false));
        res.on("close",   () => finish(false));
        res.on("aborted", () => finish(false));
      },
    );
    req.on("error", () => finish(false));
    req.on("timeout", () => { req.destroy(); finish(false); });
    req.end();
  });
}
