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
      // Current measured: statements 49%, branches 42%, functions 57%, lines 51%.
      thresholds: {
        statements: 47,
        branches: 40,
        functions: 55,
        lines: 49,
      },
    },
  },
});
