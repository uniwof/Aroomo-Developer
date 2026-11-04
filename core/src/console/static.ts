/**
 * 控制台静态文件（D195）：Core 在 /console 提供 web/console 的构建产物。
 * 控制台线唯一的 Core 改动点；不含业务逻辑，不需要令牌（页面本身不含数据，数据都走 /api）。
 * 目录：CONSOLE_DIR（默认 <工作目录>/console）。不存在时 /console 返回 404 提示。
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

// 只允许同源脚本；样式允许内联属性（React style={}），图片允许 https（成员头像地址）
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

/** /console/<rel> → 磁盘路径；越界返回 null */
export function resolveConsolePath(root: string, rel: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const file = path.resolve(root, '.' + path.posix.normalize('/' + decoded));
  return file === root || file.startsWith(root + path.sep) ? file : null;
}

export function registerConsole(app: FastifyInstance, dir: string = process.env.CONSOLE_DIR ?? path.resolve('console')): void {
  const root = path.resolve(dir);
  const index = path.join(root, 'index.html');

  async function send(reply: FastifyReply, file: string, cache: string, head: boolean) {
    const st = await stat(file);
    reply
      .header('content-type', MIME[path.extname(file)] ?? 'application/octet-stream')
      .header('content-length', String(st.size))
      .header('cache-control', cache)
      .header('x-content-type-options', 'nosniff')
      .header('referrer-policy', 'no-referrer')
      .header('x-frame-options', 'DENY')
      .header('content-security-policy', CSP);
    if (head) return reply.send();
    return reply.send(createReadStream(file));
  }

  const handler = async (req: { url: string; method: string }, reply: FastifyReply) => {
    const head = req.method === 'HEAD';
    const pathname = req.url.split('?')[0] ?? '';
    if (pathname === '/console') return reply.redirect('/console/', 302);
    if (!(await isFile(index))) {
      return reply.code(404).send({ error: { code: 'CONSOLE_NOT_BUILT', message: '控制台还没有构建（CONSOLE_DIR 下没有 index.html）' } });
    }
    const rel = pathname.slice('/console/'.length);
    const file = rel ? resolveConsolePath(root, rel) : null;
    if (rel && !file) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '找不到' } });
    if (file && (await isFile(file))) {
      // Vite 产物文件名带内容哈希，可长期缓存
      const immutable = rel.startsWith('assets/');
      return send(reply, file, immutable ? 'public, max-age=31536000, immutable' : 'no-cache', head);
    }
    // 资源文件不存在就 404；页面路径（无扩展名）交给前端路由
    if (path.extname(pathname)) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '找不到' } });
    return send(reply, index, 'no-store', head);
  };

  app.get('/console', handler);
  app.get('/console/*', handler);
}
