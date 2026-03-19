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
      // Current measured: statements 95.9%, branches 95.4%, functions 95.4%, lines 96.3%.
      thresholds: {
        statements: 95,
        branches: 95,
        functions: 94,
        lines: 96,
      },
    },
  },
});
