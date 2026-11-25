import { defineConfig } from 'vitest/config';

// Live tests: real Binance Spot TESTNET + real Neon. Run with `npm run test:integration`.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['apps/*/tests/**/*.live.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
