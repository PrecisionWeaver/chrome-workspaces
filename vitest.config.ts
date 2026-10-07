import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['helper/test/**/*.test.ts', 'scripts/**/*.test.ts'],
    pool: 'forks',
    testTimeout: 10_000,
  },
});
