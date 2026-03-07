import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 60_000, // GDB-based decode can take time
    include: ['src/test/**/*.test.ts'],
  },
});
