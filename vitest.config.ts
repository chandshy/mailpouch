import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
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
      // Current measured: statements 64%, branches 56%, functions 74%, lines 66%.
      thresholds: {
        statements: 62,
        branches: 54,
        functions: 72,
        lines: 63,
      },
    },
  },
});
