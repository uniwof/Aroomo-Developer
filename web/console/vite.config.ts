import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// 控制台由 Core 在 /console 提供静态文件（D195）；开发时把 /api、/auth 转给本机 Core
const core = process.env.CORE_DEV_URL ?? 'http://127.0.0.1:8080';

/**
 * 打开就是对话页：对话页的包（和它的 Markdown 引擎）在 index.html 里预加载，和入口脚本同时下载，
 * 不再等入口脚本跑完才开始下（实测去掉一整段串行等待，见 PR）。只是提前下载，执行时机不变；登录页也会顺带下好。
 * 只在构建时生效（开发服务器不打包）。
 */
function preloadChat(): Plugin {
  const lazyEntries = ['src/chat/ChatPage.tsx', 'src/chat/Markdown.tsx'];
  return {
    name: 'aroomo-preload-chat',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(_html, ctx) {
        const bundle = ctx.bundle;
        if (!bundle) return [];
        const base = '/console/';
        const entry = Object.values(bundle).find((c) => c.type === 'chunk' && c.isEntry);
        const inEntry = new Set(entry && entry.type === 'chunk' ? [entry.fileName, ...entry.imports] : []);
        const js = new Set<string>();
        const css = new Set<string>();
        for (const c of Object.values(bundle)) {
          if (c.type !== 'chunk' || !c.facadeModuleId || !lazyEntries.some((e) => c.facadeModuleId!.endsWith(e))) continue;
          for (const f of [c.fileName, ...c.imports]) if (!inEntry.has(f)) js.add(f);
          for (const f of c.viteMetadata?.importedCss ?? []) css.add(f);
        }
        return [
          ...[...js].map((f) => ({ tag: 'link', attrs: { rel: 'modulepreload', crossorigin: true, href: base + f }, injectTo: 'head' as const })),
          // 只预取不阻塞首屏：真正用到时 Vite 自己插 <link rel="stylesheet">，直接命中缓存
          ...[...css].map((f) => ({ tag: 'link', attrs: { rel: 'preload', as: 'style', crossorigin: true, href: base + f }, injectTo: 'head' as const })),
        ];
      },
    },
  };
}

export default defineConfig({
  base: '/console/',
  plugins: [react(), tailwindcss(), preloadChat()],
  server: { proxy: { '/api': core, '/auth': core } },
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
  build: { outDir: 'dist', sourcemap: false },
  test: { environment: 'jsdom', setupFiles: ['./test/setup.ts'], globals: false },
});
