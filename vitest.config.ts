import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts'],
    // The default worker-thread pool intermittently dies on Windows; forks are
    // marginally slower but do not flake, and a flaky suite is worse than a
    // slow one.
    pool: 'forks',
  },
});
