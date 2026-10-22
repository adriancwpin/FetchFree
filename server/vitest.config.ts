import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
    // Tests stub global fetch; undo it after every test so nothing leaks between them.
    unstubGlobals: true,
    restoreMocks: true,
  },
})
