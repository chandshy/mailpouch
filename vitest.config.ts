import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./test/setup.ts'],
    // E2E suite is run by vitest.config.e2e.ts via npm run test:e2e:* —
    // exclude from the default unit-test run so `npm test` stays fast and
    // doesn't require Docker / Bridge.
    // `.claude/**` is a Claude Code internal artifact (agent worktrees,
    // session state) and never contains project tests — excluding so
    // background agents don't pollute local test runs.
    exclude: ['test/e2e/**', 'node_modules/**', 'dist/**', '.claude/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'json-summary', 'html'],
      exclude: [
        'node_modules/**',
        'dist/**',
        '**/*.d.ts',
        '**/*.config.*',
        '**/test/**',
      ],
      // The versioned repository baseline is checked after Vitest finishes by
      // scripts/check-coverage.mjs. Keeping the ratchet outside Vitest avoids
      // stale hard-coded thresholds becoming impossible after the source set
      // changes, while still rejecting regressions in CI.
    },
  },
});
