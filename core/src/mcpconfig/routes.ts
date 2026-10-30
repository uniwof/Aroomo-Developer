import type { FastifyInstance } from 'fastify';
import { guard } from '../auth/plugin.js';

/**
 * GET /api/mcp/config：给控制台「复制 MCP 连接配置」用（D195）。
 * 只返回地址和头名，令牌占位符固定为 <YOUR_ARC_TOKEN>，绝不含明文令牌（令牌另走客户端令牌的一次性显示）。
 */
export function registerMcpConfigRoutes(app: FastifyInstance): void {
  app.get('/api/mcp/config', guard('members:read', { user: true }), async (req) => {
    const proto = String(req.headers['x-forwarded-proto'] ?? 'https').split(',')[0]?.trim() === 'http' ? 'http' : 'https';
    const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost').split(',')[0]?.trim() ?? 'localhost';
    const url = `${proto}://${host.replace(/[^A-Za-z0-9.:[\]-]/g, '')}/mcp`;
    return {
      url,
      headerName: 'Authorization',
      headerValueTemplate: 'Bearer <YOUR_ARC_TOKEN>',
      config: { mcpServers: { aroomo: { url, headers: { Authorization: 'Bearer <YOUR_ARC_TOKEN>' } } } },
    };
  });
}
