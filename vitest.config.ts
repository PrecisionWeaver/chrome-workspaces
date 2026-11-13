import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tests sit beside the module they test; shared test helpers live in each root's testing/ folder.
    include: ['**/*.test.ts'],
    exclude: ['**/node_modules/**', 'extension/dist/**'],
    pool: 'forks',
    testTimeout: 10_000,
    coverage: {
      provider: 'v8',
      include: ['shared/**', 'helper/src/**', 'extension/src/**'],
      // Tests and their helpers, entry points that only wire modules together, and hook scripts that tests run as subprocesses (v8 cannot see those).
      exclude: ['**/*.test.ts', '**/testing/**', 'helper/src/main.ts', 'helper/src/native-host.ts'],
      reporter: ['text-summary', 'html'],
      // A floor just under the current figures, so a regression fails CI. Raise it as coverage grows.
      thresholds: { statements: 95, branches: 89, functions: 93, lines: 97 },
    },
  },
});
