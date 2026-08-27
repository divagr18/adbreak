import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts'],
    // The worker pools die intermittently on Windows, especially while the
    // plant and a gate run are competing for CPU. The suite is small and runs
    // in ~2s single-forked; a flaky suite is worse than a slow one.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
  },
});
