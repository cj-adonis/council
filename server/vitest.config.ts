import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Bound process contention on Windows while retaining timeouts for hung tests.
    maxWorkers: 4,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
