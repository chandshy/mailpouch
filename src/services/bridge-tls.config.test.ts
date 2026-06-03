import { describe, it, expect, beforeEach } from "vitest";
import { join } from "path";
import { buildBridgeTlsConfig, _resetBridgeCertPinsForTests } from "./bridge-tls.js";

const CERT = join(process.cwd(), "test/fixtures/tls/bridge-like-cert.pem");

describe("buildBridgeTlsConfig", () => {
  beforeEach(() => _resetBridgeCertPinsForTests());

  it("non-localhost → standard validation, secure", () => {
    const r = buildBridgeTlsConfig("mail.example.com", undefined, false);
    expect(r.insecure).toBe(false);
    expect(r.tlsOptions).toEqual({ minVersion: "TLSv1.2" });
  });

  it("localhost + valid pinned cert → trusts it, secure, info log", () => {
    const r = buildBridgeTlsConfig("localhost", CERT, false);
    expect(r.insecure).toBe(false);
    expect(Array.isArray((r.tlsOptions as { ca?: unknown[] }).ca)).toBe(true);
    expect((r.tlsOptions as { checkServerIdentity?: unknown }).checkServerIdentity).toBeTypeOf("function");
    expect(r.logs.some((l) => l.level === "info")).toBe(true);
  });

  it("localhost + no cert + strict → throws", () => {
    expect(() => buildBridgeTlsConfig("localhost", undefined, false)).toThrow(/No Bridge certificate configured/);
  });

  it("localhost + no cert + allowInsecure → disabled validation, insecure=true, warn log", () => {
    const r = buildBridgeTlsConfig("127.0.0.1", undefined, true);
    expect(r.insecure).toBe(true);
    expect((r.tlsOptions as { rejectUnauthorized?: boolean }).rejectUnauthorized).toBe(false);
    expect(r.logs.some((l) => l.level === "warn")).toBe(true);
  });

  it("localhost + bad cert path + strict → throws 'could not be loaded'", () => {
    expect(() => buildBridgeTlsConfig("localhost", "/no/such/cert.pem", false))
      .toThrow(/could not be loaded and allowInsecureBridge is not set/);
  });

  it("localhost + bad cert path + allowInsecure → insecure fallback", () => {
    const r = buildBridgeTlsConfig("localhost", "/no/such/cert.pem", true);
    expect(r.insecure).toBe(true);
    expect((r.tlsOptions as { rejectUnauthorized?: boolean }).rejectUnauthorized).toBe(false);
  });
});
