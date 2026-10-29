import { defineConfig } from 'vitest/config'
import { testWorkers } from './test/databases'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['test/**/*.test.ts'],
    // Every file resets its database, so the files run side by side only because each worker has its own
    // (test/databases.ts), made before the run.
    globalSetup: ['test/globalSetup.ts'],
    maxWorkers: testWorkers(),
    minWorkers: 1,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
