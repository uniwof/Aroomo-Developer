import { defineConfig } from 'vitest/config';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// 控制台由 Core 在 /console 提供静态文件（D195）；开发时把 /api、/auth 转给本机 Core
const core = process.env.CORE_DEV_URL ?? 'http://127.0.0.1:8080';

export default defineConfig({
  base: '/console/',
  plugins: [react(), tailwindcss()],
  server: { proxy: { '/api': core, '/auth': core } },
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
  build: { outDir: 'dist', sourcemap: false },
  test: { environment: 'jsdom', setupFiles: ['./test/setup.ts'], globals: false },
});
