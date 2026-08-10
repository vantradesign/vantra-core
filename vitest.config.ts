import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Fixture repos are parsed as *data* by the tests, never executed or type-checked.
    exclude: ['node_modules', 'dist', 'tests/fixtures/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      // Only the public barrel is excluded: it is pure re-exports. The three
      // feature `index.ts` files hold real logic and must be measured.
      exclude: ['src/index.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 70,
        statements: 80,
      },
    },
  },
})
