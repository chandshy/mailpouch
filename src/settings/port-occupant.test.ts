/**
 * portOccupantLooksLikeMailpouch decides a LOG LEVEL and nothing else.
 *
 * These tests pin that scope as much as the behaviour: a forgeable shape check
 * is correct here precisely because a wrong answer costs a warning line. The
 * moment anything security-relevant is derived from this function, it becomes
 * the identity check that took four rounds of fixes to get right and was then
 * deleted — see the module comment.
 */

import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Socket } from "node:net";
import { portOccupantLooksLikeMailpouch } from "./port-occupant.js";

async function listener(payload: string): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = http.createServer((req, res) => {
    if ((req.url ?? "").split("?")[0] !== "/api/status") { res.statusCode = 404; res.end(); return; }
    res.setHeader("content-type", "application/json");
    res.end(payload);
  });
  server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((resolve) => {
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    }),
  };
}

describe("port occupant check (log level only)", () => {
  let stop: (() => Promise<void>) | null = null;
  afterEach(async () => { if (stop) { await stop(); stop = null; } });

  it("recognises a mailpouch-shaped status response", async () => {
    const l = await listener(JSON.stringify({ hasConfig: true, version: "3.2.1" }));
    stop = l.close;
    expect(await portOccupantLooksLikeMailpouch(l.port)).toBe(true);
  });

  it("does not recognise a stray non-mailpouch listener", async () => {
    const l = await listener("<html>python -m http.server</html>");
    stop = l.close;
    expect(await portOccupantLooksLikeMailpouch(l.port)).toBe(false);
  });

  it("does not recognise JSON without a boolean hasConfig", async () => {
    const l = await listener(JSON.stringify({ hasConfig: "yes" }));
    stop = l.close;
    expect(await portOccupantLooksLikeMailpouch(l.port)).toBe(false);
  });

  it("returns false rather than hanging on a flood", async () => {
    const l = await listener(" ".repeat(8192) + JSON.stringify({ hasConfig: true }));
    stop = l.close;
    expect(await portOccupantLooksLikeMailpouch(l.port)).toBe(false);
  });

  it("returns false when nothing is listening", async () => {
    const l = await listener("{}");
    const freePort = l.port;
    await l.close();
    expect(await portOccupantLooksLikeMailpouch(freePort)).toBe(false);
  });
});
