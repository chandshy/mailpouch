import { defineConfig } from "vitest/config";
import { BRIDGE_HOOK_TIMEOUT_MS } from "./test/e2e/support/time-budgets.mjs";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/e2e/**/*.e2e.test.ts"],
    // No coverage thresholds for E2E — these tests are about server behavior,
    // not source coverage. Coverage is owned by the unit suite.
    testTimeout: 30_000,
    // Bridge projects folder/label/All Mail mutations asynchronously. Safe
    // teardown normally reconciles for up to 180 seconds on large profiles.
    // Setup owns a separate hard deadline for Bridge credential hydration,
    // full IMAP authentication/baseline capture, and MCP initialization. A
    // pre-dispatch send proof may then require a delivery plus convergence
    // window, followed by the independent baseline audit and shutdown margin.
    // Scenario beforeAll hooks inherit this value so they cannot abandon a
    // still-running setup failure cleanup.
    hookTimeout: BRIDGE_HOOK_TIMEOUT_MS,
    // Tests share Greenmail; disable file-level parallelism so files run
    // sequentially and don't trip over each other's IMAP state.
    fileParallelism: false,
    maxConcurrency: 1,
    pool: "forks",
    forks: { singleFork: true },
    retry: 0,
    // Bridge runs touch a persistent mailbox. Stop at the first scenario-file
    // failure so a failed cleanup cannot become part of later baselines.
    // Greenmail is disposable and keeps the existing all-failures behavior.
    bail: process.env.MAILPOUCH_E2E_BACKEND === "bridge" ? 1 : 0,
    reporters: ["default"],
  },
});
