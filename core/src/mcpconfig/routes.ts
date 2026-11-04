import type { FastifyInstance } from 'fastify';
import { guard } from '../auth/plugin.js';

/**
 * GET /api/mcp/config：给控制台「复制 MCP 连接配置」用（D195）。
 * 只返回地址和头名，令牌占位符固定为 <YOUR_ARC_TOKEN>，绝不含明文令牌（令牌另走客户端令牌的一次性显示）。
 */
export function registerMcpConfigRoutes(app: FastifyInstance, lobehubUrl: string | undefined = process.env.CORE_MCP_LOBEHUB_URL): void {
  // LobeHub 服务端自己去连的地址（内部固定 IP，由 LobeHub 的 SSRF 白名单放行）；外部客户端仍用 url
  const lobeUrl = lobehubUrl && /^http:\/\/[A-Za-z0-9.:[\]-]+\/mcp$/.test(lobehubUrl.trim()) ? lobehubUrl.trim() : undefined;
  app.get('/api/mcp/config', guard('members:read', { user: true }), async (req) => {
    const proto = String(req.headers['x-forwarded-proto'] ?? 'https').split(',')[0]?.trim() === 'http' ? 'http' : 'https';
    const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost').split(',')[0]?.trim() ?? 'localhost';
    const url = `${proto}://${host.replace(/[^A-Za-z0-9.:[\]-]/g, '')}/mcp`;
    return {
      url,
      headerName: 'Authorization',
      headerValueTemplate: 'Bearer <YOUR_ARC_TOKEN>',
      config: { mcpServers: { aroomo: { url, headers: { Authorization: 'Bearer <YOUR_ARC_TOKEN>' } } } },
      ...(lobeUrl
        ? {
            lobehubUrl: lobeUrl,
            lobehubConfig: { mcpServers: { aroomo: { url: lobeUrl, headers: { Authorization: 'Bearer <YOUR_ARC_TOKEN>' } } } },
          }
        : {}),
    };
  });
}
