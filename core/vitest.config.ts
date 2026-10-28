import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // PGlite（WASM Postgres）在 CI 上首次建库偶尔超过默认 5 秒（#51 的 KeyStore 用例 5.25 秒超时），放宽到 30 秒
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
