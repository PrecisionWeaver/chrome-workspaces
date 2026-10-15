import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['helper/test/**/*.test.ts', 'extension/test/**/*.test.ts', 'scripts/**/*.test.ts'],
    pool: 'forks',
    testTimeout: 10_000,
    coverage: {
      provider: 'v8',
      include: ['shared/**', 'helper/src/**', 'extension/src/**'],
      // Entry points that only wire modules together, and hook scripts that tests run as subprocesses (v8 cannot see those).
      exclude: ['helper/src/main.ts', 'helper/src/native-host.ts'],
      reporter: ['text-summary', 'html'],
      // A floor just under the current figures, so a regression fails CI. Raise it as coverage grows.
      thresholds: { statements: 95, branches: 89, functions: 93, lines: 97 },
    },
  },
});
