/**
 * 模型规划器：经 Core 的 OpenAI 兼容接口 /v1/chat/completions（唯一模型来源，D189）规划下一步。
 *
 * - 设备令牌需要 models:chat scope（Core 已有该 scope）。
 * - 给模型的只有：动作说明、可填字段名、已脱敏的页面快照；从不包含要填写的值。
 * - 模型输出严格校验（op 白名单、引用格式），任何失败都退回规则规划器，任务不中断。
 */

import { RuleBasedPlanner, validatePlan, type PlanInput, type PlanStep, type Planner } from './planner.js';

export interface ModelPlannerOptions {
  baseUrl: string;
  getToken: () => string;
  /** 模型别名，默认 aroomo/auto（负责人自动选路） */
  model?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  fallback?: Planner;
  /** 快照最多给模型多少字符 */
  maxSnapshotChars?: number;
}

const SYSTEM = [
  '你是浏览器操作规划器。根据页面快照和动作说明，输出接下来要执行的步骤。',
  '只输出一个 JSON 对象：{"steps":[...]}，不要任何其他文字。',
  '每个步骤是以下之一：',
  '{"op":"fill","ref":"<快照里的元素引用>","valueKey":"<可填字段名之一>"}',
  '{"op":"click","ref":"<元素引用>"}',
  '{"op":"press","ref":"<元素引用>","key":"Enter"}',
  '{"op":"done","note":"<一句话说明结果>"}',
  '{"op":"blocked","blocker":"captcha|2fa|payment|other","note":"<原因>"}',
  '规则：引用必须原样来自快照；fill 只能用给出的字段名；遇到验证码、短信或两步验证、付款，必须输出 blocked；动作已完成就输出 done。',
].join('\n');

const OPS = new Set(['click', 'fill', 'press', 'done', 'blocked']);
const BLOCKERS = new Set(['captcha', '2fa', 'payment', 'other']);

export function parseModelPlan(text: string, availableFields: string[]): PlanStep[] {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('模型没有返回 JSON');
  const obj = JSON.parse(text.slice(start, end + 1)) as { steps?: unknown };
  if (!Array.isArray(obj.steps) || obj.steps.length === 0 || obj.steps.length > 10) throw new Error('steps 不合法');
  const steps: PlanStep[] = obj.steps.map((raw) => {
    const s = raw as Record<string, unknown>;
    const op = String(s.op);
    if (!OPS.has(op)) throw new Error(`不认识的 op ${op}`);
    const step: PlanStep = { op: op as PlanStep['op'] };
    if (typeof s.ref === 'string') step.ref = s.ref;
    if (typeof s.note === 'string') step.note = s.note.slice(0, 200);
    if (op === 'fill') {
      if (typeof s.valueKey !== 'string' || !availableFields.includes(s.valueKey)) throw new Error('fill 的字段名不在可填列表里');
      step.valueKey = s.valueKey;
    }
    if (op === 'press') step.key = typeof s.key === 'string' ? s.key : 'Enter';
    if (op === 'blocked') step.blocker = BLOCKERS.has(String(s.blocker)) ? (s.blocker as PlanStep['blocker']) : 'other';
    if ((op === 'click' || op === 'fill' || op === 'press') && !step.ref) throw new Error(`${op} 缺少 ref`);
    return step;
  });
  return validatePlan(steps);
}

export class ModelPlanner implements Planner {
  readonly name = 'model';
  readonly #o: ModelPlannerOptions;
  readonly #fallback: Planner;
  /** 最近一次是否退回了规则规划器（状态页 / 测试用） */
  lastFellBack = false;

  constructor(o: ModelPlannerOptions) {
    this.#o = { ...o, baseUrl: o.baseUrl.replace(/\/+$/, '') };
    this.#fallback = o.fallback ?? new RuleBasedPlanner();
  }

  async plan(input: PlanInput): Promise<PlanStep[]> {
    try {
      const steps = await this.#ask(input);
      this.lastFellBack = false;
      return steps;
    } catch {
      this.lastFellBack = true;
      return this.#fallback.plan(input);
    }
  }

  async #ask(input: PlanInput): Promise<PlanStep[]> {
    const snap = input.snapshot.slice(0, this.#o.maxSnapshotChars ?? 12_000);
    const user = [`动作说明：${input.instruction}`, `可填字段名：${input.availableFields.join(', ') || '（无）'}`, `第 ${input.round + 1} 轮`, '页面快照：', snap].join('\n');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.#o.timeoutMs ?? 45_000);
    try {
      const res = await (this.#o.fetchImpl ?? fetch)(`${this.#o.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.#o.getToken()}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.#o.model ?? 'aroomo/auto',
          temperature: 0,
          messages: [
            { role: 'system', content: SYSTEM },
            { role: 'user', content: user },
          ],
        }),
        signal: ctrl.signal,
        redirect: 'error',
      });
      if (!res.ok) throw new Error(`模型接口返回 ${res.status}`);
      const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const text = data.choices?.[0]?.message?.content ?? '';
      return parseModelPlan(text, input.availableFields);
    } finally {
      clearTimeout(timer);
    }
  }
}
