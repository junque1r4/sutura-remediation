import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    passWithNoTests: true,
    include: [
      'packages/**/tests/**/*.test.ts',
      'packages/**/__tests__/**/*.test.ts',
      'apps/**/tests/**/*.test.ts',
      'apps/**/__tests__/**/*.test.{ts,tsx}',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['packages/*/src/**', 'apps/*/src/**'],
      exclude: ['**/types/**', '**/index.ts'],
    },
  },
});
