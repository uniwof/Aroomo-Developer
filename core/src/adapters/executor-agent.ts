/**
 * 本机执行员适配器：让 LobeHub / 外部 MCP 客户端经工具网关给本机执行员派任务（签到、登录、注册、浏览）。
 * 任务只带 secret id（凭据由执行员运行时按 id 现取，网关与模型都看不到明文）。
 */
import type { TaskRecord } from '../executor/types.js';
import { TASK_KINDS } from '../executor/types.js';
import { type ToolAdapter, type ToolCtx, type ToolResult, type ToolRisk, type ToolSpec, maxRisk, textResult } from './types.js';

/** 只依赖 ExecutorService 的这三个方法 */
export interface TaskPort {
  create(
    userId: string,
    input: {
      kind: string;
      site: string;
      instruction?: string;
      secrets?: { secretId: string; field: string }[];
      options?: Record<string, unknown>;
    },
    audit: ToolCtx['audit'],
  ): Promise<TaskRecord>;
  get(userId: string, id: string): Promise<TaskRecord>;
  cancel(userId: string, id: string, audit: ToolCtx['audit']): Promise<TaskRecord>;
}

/** 登记任务引用的 secret 前确认属于该用户（VaultService.exists） */
export type SecretExists = (userId: string, secretId: string) => Promise<boolean>;

const SPECS: ToolSpec[] = [
  {
    name: 'browser_task_create',
    description:
      '给所有者电脑上的本机执行员派一个浏览器任务：checkin 签到 / login 登录 / signup 注册 / browse 浏览。遇到验证码、两步验证、付款会推接管卡等所有者处理。凭据只传 secret id。',
    risk: 'write',
    inputSchema: {
      type: 'object',
      required: ['kind', 'site'],
      properties: {
        kind: { type: 'string', enum: [...TASK_KINDS] },
        site: { type: 'string', description: 'https:// 网址，或 android-app://包名' },
        instruction: { type: 'string', maxLength: 4000 },
        secrets: {
          type: 'array',
          maxItems: 10,
          items: {
            type: 'object',
            required: ['secretId', 'field'],
            properties: { secretId: { type: 'string' }, field: { type: 'string', description: 'username / password 等字段名' } },
          },
        },
        options: { type: 'object' },
      },
    },
  },
  {
    name: 'browser_task_status',
    description: '查任务进度与结果（只返回摘要，不含任何凭据或验证码）。',
    risk: 'read',
    inputSchema: { type: 'object', required: ['taskId'], properties: { taskId: { type: 'string' } } },
  },
  {
    name: 'browser_task_cancel',
    description: '取消排队中或进行中的任务。',
    risk: 'write',
    inputSchema: { type: 'object', required: ['taskId'], properties: { taskId: { type: 'string' } } },
  },
];

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export class ExecutorAgentAdapter implements ToolAdapter {
  readonly id = 'executor';
  constructor(
    private readonly tasks: TaskPort,
    private readonly secretExists: SecretExists = async () => true,
  ) {}

  tools(): ToolSpec[] {
    return SPECS.map((s) => ({ ...s }));
  }

  /** 引用了凭据的任务（登录/注册，或任何带 secrets 的）按 danger：每次走重要确认（D199 红线 2） */
  riskOf(tool: string, args: Record<string, unknown>): ToolRisk {
    const base = SPECS.find((s) => s.name === tool)?.risk ?? 'danger';
    if (tool !== 'browser_task_create') return base;
    const usesSecrets = Array.isArray(args.secrets) && args.secrets.length > 0;
    const kind = str(args.kind);
    return usesSecrets || kind === 'login' || kind === 'signup' ? maxRisk(base, 'danger') : base;
  }

  async call(tool: string, args: Record<string, unknown>, ctx: ToolCtx): Promise<ToolResult> {
    switch (tool) {
      case 'browser_task_create':
        return this.#create(args, ctx);
      case 'browser_task_status': {
        const t = await this.tasks.get(ctx.userId, str(args.taskId));
        return textResult(JSON.stringify(summary(t)));
      }
      case 'browser_task_cancel': {
        const t = await this.tasks.cancel(ctx.userId, str(args.taskId), ctx.audit);
        return textResult(JSON.stringify(summary(t)));
      }
      default:
        return textResult(`不认识的工具：${tool}`, true);
    }
  }

  async #create(args: Record<string, unknown>, ctx: ToolCtx): Promise<ToolResult> {
    const secrets: { secretId: string; field: string }[] = [];
    if (args.secrets !== undefined) {
      if (!Array.isArray(args.secrets)) return textResult('secrets 必须是数组', true);
      for (const s of args.secrets as unknown[]) {
        const o = (s ?? {}) as Record<string, unknown>;
        const secretId = str(o.secretId);
        const field = str(o.field);
        if (!secretId || !field) return textResult('secrets 每项都要有 secretId 和 field', true);
        // 网关调用者只能引用自己保险箱里的 secret
        if (!(await this.secretExists(ctx.userId, secretId))) return textResult('找不到这个凭据', true);
        secrets.push({ secretId, field });
      }
    }
    const t = await this.tasks.create(
      ctx.userId,
      {
        kind: str(args.kind),
        site: str(args.site),
        instruction: str(args.instruction),
        secrets,
        options: typeof args.options === 'object' && args.options !== null ? (args.options as Record<string, unknown>) : {},
      },
      ctx.audit,
    );
    return textResult(JSON.stringify(summary(t)));
  }
}

/** 给模型 / 客户端看的任务摘要：不含 secrets、instruction 全文之类 */
function summary(t: TaskRecord) {
  return {
    taskId: t.id,
    kind: t.kind,
    site: t.site,
    status: t.status,
    stage: t.lastStage,
    message: t.lastMessage,
    result: t.resultSummary,
    error: t.resultError,
  };
}
