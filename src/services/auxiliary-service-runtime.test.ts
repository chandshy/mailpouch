import { afterEach, describe, expect, it, vi } from "vitest";

import {
  disableAuxiliaryServices,
  registerAuxiliaryServiceDisabler,
  refreshAuxiliaryServices,
  registerAuxiliaryServiceRefresher,
} from "./auxiliary-service-runtime.js";

describe("auxiliary service runtime bridge", () => {
  afterEach(() => {
    registerAuxiliaryServiceRefresher(null);
    registerAuxiliaryServiceDisabler(null);
  });

  it("reports no live runtime when settings runs standalone", async () => {
    registerAuxiliaryServiceRefresher(null);

    await expect(refreshAuxiliaryServices()).resolves.toBe(false);
  });

  it("awaits the registered MCP runtime refresher", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    registerAuxiliaryServiceRefresher(refresh);

    await expect(refreshAuxiliaryServices()).resolves.toBe(true);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("uses a separate fail-closed reset hook instead of refreshing persisted state", async () => {
    const disable = vi.fn().mockResolvedValue(undefined);
    registerAuxiliaryServiceDisabler(disable);

    await expect(disableAuxiliaryServices()).resolves.toBe(true);
    expect(disable).toHaveBeenCalledTimes(1);
  });

  it("reports no live runtime to disable when settings runs standalone", async () => {
    registerAuxiliaryServiceDisabler(null);

    await expect(disableAuxiliaryServices()).resolves.toBe(false);
  });
});
