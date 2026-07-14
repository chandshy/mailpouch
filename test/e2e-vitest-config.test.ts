import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("E2E Vitest bail policy", () => {
  it("bails after one failure only for the explicit Bridge backend", async () => {
    vi.stubEnv("MAILPOUCH_E2E_BACKEND", "bridge");
    const bridge = (await import("../vitest.config.e2e.js")).default as {
      test?: { bail?: number };
    };
    expect(bridge.test?.bail).toBe(1);

    vi.resetModules();
    vi.stubEnv("MAILPOUCH_E2E_BACKEND", "greenmail");
    // A source Bridge config may intentionally remain in the environment;
    // backend selection, not config presence, determines persistent-mailbox
    // fail-fast behavior.
    vi.stubEnv("MAILPOUCH_E2E_BRIDGE_CONFIG", "/unused/source-config.json");
    const greenmail = (await import("../vitest.config.e2e.js")).default as {
      test?: { bail?: number };
    };
    expect(greenmail.test?.bail).toBe(0);
  });
});
