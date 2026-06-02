import { describe, it, expect } from "vitest";
import { chooseTransport, forceStdioFromEnv } from "./select.js";

describe("chooseTransport", () => {
  it("defaults to stdio when remoteMode is off", () => {
    expect(chooseTransport({})).toBe("stdio");
    expect(chooseTransport({ remoteMode: false })).toBe("stdio");
  });

  it("uses http when remoteMode is on", () => {
    expect(chooseTransport({ remoteMode: true })).toBe("http");
  });

  it("forceStdio overrides remoteMode", () => {
    expect(chooseTransport({ remoteMode: true, forceStdio: true })).toBe("stdio");
    expect(chooseTransport({ remoteMode: false, forceStdio: true })).toBe("stdio");
  });

  it("forceHttp runs http even when remoteMode is off", () => {
    expect(chooseTransport({ remoteMode: false, forceHttp: true })).toBe("http");
    expect(chooseTransport({ forceHttp: true })).toBe("http");
  });

  it("forceStdio wins over forceHttp (an explicit stdio spawn never becomes a daemon)", () => {
    expect(chooseTransport({ forceStdio: true, forceHttp: true })).toBe("stdio");
  });
});

describe("forceStdioFromEnv", () => {
  it.each(["1", "true", "TRUE", "True"])("treats %s as force-stdio", (v) => {
    expect(forceStdioFromEnv(v)).toBe(true);
  });

  it.each([undefined, "", "0", "false", "no", "yes"])("treats %s as not-forced", (v) => {
    expect(forceStdioFromEnv(v)).toBe(false);
  });
});
