import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./src/test-setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/**',
        'dist/**',
        '**/*.d.ts',
        '**/*.config.*',
        '**/test/**',
      ],
      // Minimum coverage thresholds — CI will fail if these are not met.
      // Set conservatively below current measured levels; raise as coverage improves.
      // Measured after agent-grants / audit additions: 94.7 / 91.6 / 95.4 / 96.1.
      // Branches keep dipping with each new service that carries defensive
      // error paths (native-dep crashes, FS rotation failures, malformed
      // bodies from untrusted clients). A follow-up PR can re-tighten with
      // targeted node-internal stubs.
      thresholds: {
        statements: 94,
        branches: 91,
        functions: 94,
        lines: 96,
      },
    },
  },
});
