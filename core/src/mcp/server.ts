/**
 * Core 对外 MCP（HUB.md 第 4 节，M2）：POST /mcp，Streamable HTTP 的 JSON 应答形式，JSON-RPC 2.0。
 * 只实现 initialize、notifications/initialized、ping、tools/list、tools/call。
 * 鉴权同 /api：Authorization: Bearer（所有者 / 账号 / arc_ 客户端令牌）。
 * tools/list 按范围动态返回；没有范围的工具对 tools/call 表现为「不存在」，不泄露存在性。
 * 本版工具：资源库（搜索 / 取条目 / 收进）与公共记忆（只读）。花钱 / 危险的外部工具走工具网关（下一步），不在这里。
 */
import type { FastifyInstance } from 'fastify';
import { redactSecrets } from '../audit/redact.js';
import type { AuditFn } from '../audit/types.js';
import { scopeOf } from '../auth/plugin.js';
import type { Principal } from '../auth/tokens.js';
import { HttpError } from '../http/errors.js';
import { type ExecutorService, taskJson } from '../executor/service.js';
import { TASK_KINDS } from '../executor/types.js';
import type { LibraryService } from '../library/service.js';
import { LIBRARY_KINDS, type LibraryItem, type LibraryKind } from '../library/types.js';
import type { PubMemService } from '../pubmem/service.js';

export const MCP_PROTOCOL = '2025-03-26';
const SUPPORTED = new Set(['2025-06-18', '2025-03-26', '2024-11-05']);

interface Ctx {
  userId: string;
  audit: AuditFn;
}
interface Tool {
  name: string;
  description: string;
  /** 所需范围；人（所有者 / 账号）登录会话拥有全部范围 */
  scope: string;
  inputSchema: Record<string, unknown>;
  run(ctx: Ctx, args: Record<string, unknown>): Promise<string>;
}

type Json = Record<string, unknown>;
interface RpcReq {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Json;
}

const str = (v: unknown, max = 2000): string | undefined => (typeof v === 'string' && v.length <= max ? v : undefined);
const line = (i: LibraryItem) => `- [${i.kind}] ${i.title}${i.url ? ` ${i.url}` : ''}${i.tags.length ? ` #${i.tags.join(' #')}` : ''}（id: ${i.id}）${i.body ? `\n  ${i.body.replace(/\s+/g, ' ').slice(0, 160)}` : ''}`;

/** 北京时间的日期（定时签到「同 kind+site+当天」去重用） */
const cstDay = (d: Date) => new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 10);

function taskLine(t: ReturnType<typeof taskJson>): string {
  const tail = t.resultSummary ? `：${t.resultSummary}` : t.resultError ? `（失败：${t.resultError}）` : t.lastMessage ? `（${t.lastMessage}）` : '';
  return `- ${t.kind} ${t.site} 状态 ${t.status}${tail}（id: ${t.id}）`;
}

function taskTools(ex: ExecutorService, now: () => Date): Tool[] {
  return [
    {
      name: 'create_task',
      description: '派一个任务给用户电脑上的本机执行员（签到 checkin、登录 login、注册 signup、浏览 browse）。同一网站同一类型当天已派过就不重复派。secrets 只写保险箱条目 id 和字段名，不写值。',
      scope: 'tasks:create',
      inputSchema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: [...TASK_KINDS] },
          site: { type: 'string', description: 'https:// 网址，或 android-app://包名' },
          instruction: { type: 'string' },
          secrets: { type: 'array', maxItems: 10, items: { type: 'object', properties: { secretId: { type: 'string' }, field: { type: 'string' } }, required: ['secretId', 'field'] } },
          options: { type: 'object' },
        },
        required: ['kind', 'site'],
      },
      async run(ctx, a) {
        const kind = str(a.kind, 16) ?? '';
        const site = str(a.site, 2048) ?? '';
        const today = cstDay(now());
        const dup = (await ex.list(ctx.userId)).find((t) => t.kind === kind && t.site === site && t.status !== 'cancelled' && t.status !== 'failed' && cstDay(t.createdAt) === today);
        if (dup) return `今天已经派过这个任务，不重复派。
${taskLine(taskJson(dup))}`;
        const secrets = Array.isArray(a.secrets)
          ? a.secrets.flatMap((s) => {
              const o = s as Json;
              const secretId = str(o?.secretId, 64);
              const field = str(o?.field, 64);
              return secretId && field ? [{ secretId, field }] : [];
            })
          : [];
        const options = a.options && typeof a.options === 'object' && !Array.isArray(a.options) ? (a.options as Record<string, unknown>) : undefined;
        const t = await ex.create(ctx.userId, { kind, site, ...(str(a.instruction, 4000) ? { instruction: str(a.instruction, 4000)! } : {}), secrets, ...(options ? { options } : {}) }, ctx.audit);
        return `已派给本机执行员。
${taskLine(taskJson(t))}`;
      },
    },
    {
      name: 'get_task',
      description: '按 id 查一个任务的进度和结果。',
      scope: 'tasks:read',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      async run(ctx, a) {
        return taskLine(taskJson(await ex.get(ctx.userId, str(a.id, 64) ?? '')));
      },
    },
    {
      name: 'list_tasks',
      description: '列出最近的任务，可按状态筛选（queued/running/succeeded/failed/cancelled）。',
      scope: 'tasks:read',
      inputSchema: { type: 'object', properties: { status: { type: 'string', enum: ['queued', 'running', 'succeeded', 'failed', 'cancelled'] } } },
      async run(ctx, a) {
        const status = str(a.status, 16);
        const rows = (await ex.list(ctx.userId)).filter((t) => !status || t.status === status).slice(0, 20);
        return rows.length ? rows.map((t) => taskLine(taskJson(t))).join('\n') : '没有符合的任务。';
      },
    },
    {
      name: 'cancel_task',
      description: '取消一个排队中或进行中的任务。',
      scope: 'tasks:create',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      async run(ctx, a) {
        return taskLine(taskJson(await ex.cancel(ctx.userId, str(a.id, 64) ?? '', ctx.audit)));
      },
    },
  ];
}

export function buildTools(lib: LibraryService, mem: PubMemService, ex?: ExecutorService, now: () => Date = () => new Date()): Tool[] {
  return [
    ...(ex ? taskTools(ex, now) : []),
    {
      name: 'search_library',
      description: '在资源库里按关键词搜索文章、技能、方法、素材、工具线索、链接和点子。多个词要同时命中。',
      scope: 'library:read',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', description: '关键词，空格分隔' }, kind: { type: 'string', enum: [...LIBRARY_KINDS] }, limit: { type: 'integer', minimum: 1, maximum: 20 } },
        required: ['query'],
      },
      async run(ctx, a) {
        const kind = LIBRARY_KINDS.includes(a.kind as LibraryKind) ? (a.kind as LibraryKind) : undefined;
        const limit = typeof a.limit === 'number' ? a.limit : 8;
        const items = await lib.list(ctx.userId, { q: str(a.query, 200) ?? '', ...(kind ? { kind } : {}), limit });
        return items.length ? items.map(line).join('\n') : '资源库里没有找到相关内容。';
      },
    },
    {
      name: 'get_library_item',
      description: '按 id 取资源库里一条资源的完整内容。',
      scope: 'library:read',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      async run(ctx, a) {
        const i = await lib.get(ctx.userId, str(a.id, 64) ?? '');
        return `${line(i)}\n\n${i.body}`.trim();
      },
    },
    {
      name: 'submit_resource',
      description: '把一个链接或一段笔记收进资源库（用途不明就收进去）。同一个链接不会重复收。不要放密码或 Key。',
      scope: 'library:write',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          title: { type: 'string' },
          note: { type: 'string' },
          kind: { type: 'string', enum: [...LIBRARY_KINDS] },
          tags: { type: 'array', items: { type: 'string' }, maxItems: 10 },
        },
      },
      async run(ctx, a) {
        const kind = LIBRARY_KINDS.includes(a.kind as LibraryKind) ? (a.kind as LibraryKind) : undefined;
        const tags = Array.isArray(a.tags) ? a.tags.filter((t): t is string => typeof t === 'string' && t.length <= 40).slice(0, 10) : undefined;
        const url = str(a.url);
        const title = str(a.title, 200);
        const body = str(a.note, 20_000);
        const { existed } = await lib.add(
          ctx.userId,
          { ...(url ? { url } : {}), ...(title ? { title } : {}), ...(body ? { body } : {}), ...(kind ? { kind } : {}), ...(tags ? { tags } : {}), source: 'mcp' },
          ctx.audit,
        );
        return existed ? '资源库里已经有这条了。' : '已收进资源库。';
      },
    },
    {
      name: 'list_memory_topics',
      description: '列出公共记忆里的主题（偏好、背景、规矩）。',
      scope: 'memory:read',
      inputSchema: { type: 'object', properties: {} },
      async run(ctx) {
        const t = await mem.list(ctx.userId);
        return t.length ? t.map((e) => `- ${e.topic}：${e.title}`).join('\n') : '公共记忆还是空的。';
      },
    },
    {
      name: 'get_memory',
      description: '读取公共记忆里一个主题的内容。',
      scope: 'memory:read',
      inputSchema: { type: 'object', properties: { topic: { type: 'string' } }, required: ['topic'] },
      async run(ctx, a) {
        const e = await mem.get(ctx.userId, str(a.topic, 64) ?? '');
        return `# ${e.title}\n\n${e.body}`;
      },
    },
  ];
}

const hasScope = (p: Principal, scope: string): boolean => (p.type === 'client' ? (p.scopes as ReadonlySet<string>).has(scope) : p.type === 'owner' || p.type === 'user');

const ok = (id: RpcReq['id'], result: unknown) => ({ jsonrpc: '2.0', id: id ?? null, result });
const fail = (id: RpcReq['id'], code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

export function registerMcpRoutes(app: FastifyInstance, lib: LibraryService, mem: PubMemService, ex?: ExecutorService, now: () => Date = () => new Date()): void {
  const tools = buildTools(lib, mem, ex, now);
  const byName = new Map(tools.map((t) => [t.name, t]));

  async function handle(req: RpcReq, p: Principal, userId: string, audit: AuditFn): Promise<unknown | null> {
    const id = req.id;
    const isNotification = id === undefined;
    switch (req.method) {
      case 'initialize': {
        const asked = str(req.params?.protocolVersion, 20);
        return ok(id, {
          protocolVersion: asked && SUPPORTED.has(asked) ? asked : MCP_PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'aroomo-core', version: '1' },
          instructions: 'Aroomo 的资源库与公共记忆。search_library 搜资源，submit_resource 收链接。',
        });
      }
      case 'ping':
        return ok(id, {});
      case 'tools/list':
        return ok(id, { tools: tools.filter((t) => hasScope(p, t.scope)).map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      case 'tools/call': {
        const name = str(req.params?.name, 100) ?? '';
        const tool = byName.get(name);
        // 没有范围 = 不存在（不泄露存在性），同样写审计
        if (!tool || !hasScope(p, tool.scope)) {
          await audit('mcp.call', { type: 'mcp-tool', id: name.slice(0, 64) }, 'denied', '工具不存在或没有范围');
          return fail(id, -32602, `未知工具：${name.slice(0, 64)}`);
        }
        const args = req.params?.arguments && typeof req.params.arguments === 'object' ? (req.params.arguments as Json) : {};
        try {
          const text = await tool.run({ userId, audit }, args);
          await audit('mcp.call', { type: 'mcp-tool', id: name }, 'ok');
          return ok(id, { content: [{ type: 'text', text: redactSecrets(text) }] });
        } catch (e) {
          const msg = e instanceof HttpError ? e.message : '工具执行失败';
          await audit('mcp.call', { type: 'mcp-tool', id: name }, 'failed', msg.slice(0, 120));
          // 工具自身的失败按 MCP 约定放在结果里（isError），协议错误才用 error
          return ok(id, { content: [{ type: 'text', text: redactSecrets(msg) }], isError: true });
        }
      }
      default:
        if (isNotification) return null;
        return fail(id, -32601, `不支持的方法：${String(req.method).slice(0, 64)}`);
    }
  }

  app.post<{ Body: RpcReq | RpcReq[] }>(
    '/mcp',
    { config: { userRoute: true, clientMcp: true }, bodyLimit: 256 * 1024 },
    async (req, reply) => {
      const p = req.principal;
      if (!p) throw new HttpError(401, 'UNAUTHORIZED', '请先登录');
      const userId = scopeOf(req);
      const body = req.body;
      if (!body || typeof body !== 'object') return reply.code(400).send(fail(null, -32700, '请求不是 JSON-RPC'));
      const list = Array.isArray(body) ? body : [body];
      if (!list.length || list.length > 20) return reply.code(400).send(fail(null, -32600, '请求数量不对'));
      const out: unknown[] = [];
      for (const r of list) {
        if (!r || typeof r !== 'object' || r.jsonrpc !== '2.0' || typeof r.method !== 'string') {
          out.push(fail((r as RpcReq | undefined)?.id, -32600, '不是有效的 JSON-RPC 2.0 请求'));
          continue;
        }
        const res = await handle(r, p, userId, req.audit);
        if (res !== null) out.push(res);
      }
      if (!out.length) return reply.code(202).send();
      return reply.send(Array.isArray(body) ? out : out[0]);
    },
  );

  // 不提供服务端推送流；明确告诉客户端不支持（Streamable HTTP 允许 405）
  app.get('/mcp', { config: { userRoute: true, clientMcp: true } }, async (_req, reply) => reply.code(405).header('allow', 'POST').send({ error: { code: 'METHOD_NOT_ALLOWED', message: '只支持 POST' } }));
}
