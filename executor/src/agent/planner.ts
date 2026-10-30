/**
 * 规划器端口：把「自然语言动作 + 页面快照」变成一串驱动原语。
 * 真实实现调用 Core 的 /v1（LobeHub 之外唯一模型来源），在后续 PR 接入；
 * 现在给一个基于规则的本地规划器（不需要模型），覆盖登录 / 签到 / 点击 / 填写这些常见动作，
 * 同时让任务逻辑和合同测试不依赖外部模型。
 */

import { assertRef } from '../ports/driver.js';

export interface PlanStep {
  op: 'click' | 'fill' | 'press' | 'done' | 'blocked';
  ref?: string;
  /** fill 的值由处理器注入；规划器只产出 valueKey，指向 secretFields 的字段名 */
  valueKey?: string;
  key?: string;
  /** done/blocked 的说明 */
  note?: string;
  /** blocked 的类别 */
  blocker?: 'captcha' | '2fa' | 'payment' | 'other';
}

export interface PlanInput {
  instruction: string;
  snapshot: string;
  /** 本任务可填的字段名（username/password/...），值不传给规划器 */
  availableFields: string[];
  /** 已经做过的步骤数，防止死循环 */
  round: number;
}

export interface Planner {
  readonly name: string;
  plan(input: PlanInput): Promise<PlanStep[]>;
}

/** 从快照里找第一个匹配关键词的可交互引用。快照形如：`@12 button "登录"` */
export function findRef(snapshot: string, kinds: string[], keywords: string[]): string | null {
  const lines = snapshot.split(/\r?\n/);
  for (const line of lines) {
    let ref: string, role: string, text: string;
    const ego = line.match(/@(\d{1,6})\s+([a-z]+)\s+"([^"]*)"/i);
    // Playwright MCP 快照（YAML）：- button "登录" [ref=e3]
    const pw = line.match(/-\s+([a-z]+)\s+"([^"]*)"[^\n]*\[ref=([A-Za-z0-9]{1,16})\]/i);
    if (ego) [, ref, role, text] = [ego[0], `@${ego[1]}`, ego[2] as string, ego[3] as string];
    else if (pw) [, ref, role, text] = [pw[0], pw[3] as string, pw[1] as string, pw[2] as string];
    else continue;
    const roleOk = kinds.length === 0 || kinds.includes(role.toLowerCase());
    const textOk = keywords.length === 0 || keywords.some((k) => text.includes(k));
    if (roleOk && textOk) return ref;
  }
  return null;
}

export function detectBlockerInSnapshot(snapshot: string): PlanStep | null {
  const s = snapshot.toLowerCase();
  if (/captcha|滑块|人机验证|verify you are human|recaptcha|hcaptcha/.test(s)) return { op: 'blocked', blocker: 'captcha', note: '页面需要验证码' };
  if (/one-time|verification code|验证码|two-factor|两步验证|2fa|authenticator/.test(s)) return { op: 'blocked', blocker: '2fa', note: '页面需要两步验证' };
  if (/payment|信用卡|card number|付款|checkout.*pay/.test(s)) return { op: 'blocked', blocker: 'payment', note: '页面进入付款环节' };
  return null;
}

const FIELD_KEYWORDS: Record<string, string[]> = {
  username: ['用户名', '账号', 'username', 'account'],
  email: ['邮箱', 'email', 'e-mail'],
  phone: ['手机', '电话', 'phone', 'mobile'],
  password: ['密码', 'password'],
  nickname: ['昵称', 'nickname', '显示名'],
};

/**
 * 规则规划器：
 * - 先查障碍 → blocked；
 * - 对每个可填字段，若快照里有对应输入框 → fill；
 * - 否则找登录/签到/提交类按钮 → click；
 * - 找不到动作 → done。
 */
export class RuleBasedPlanner implements Planner {
  readonly name = 'rule-based';

  async plan(input: PlanInput): Promise<PlanStep[]> {
    const blocked = detectBlockerInSnapshot(input.snapshot);
    if (blocked) return [blocked];

    const steps: PlanStep[] = [];
    if (input.round === 0) {
      for (const field of input.availableFields) {
        const ref = findRef(input.snapshot, ['textbox', 'input', 'searchbox'], FIELD_KEYWORDS[field] ?? [field]);
        if (ref) steps.push({ op: 'fill', ref, valueKey: field });
      }
    }

    const wantClick = pickButtonKeywords(input.instruction);
    const btn = findRef(input.snapshot, ['button', 'link'], wantClick);
    if (btn) {
      steps.push({ op: 'click', ref: btn });
      return steps;
    }
    if (steps.length > 0) return steps;
    return [{ op: 'done', note: '快照里没有可执行的下一步' }];
  }
}

function pickButtonKeywords(instruction: string): string[] {
  const i = instruction.toLowerCase();
  if (i.includes('签到') || i.includes('checkin') || i.includes('check in')) return ['签到', '打卡', 'check'];
  if (i.includes('登录') || i.includes('login') || i.includes('sign in')) return ['登录', '登 录', 'login', 'sign in'];
  if (i.includes('注册') || i.includes('signup') || i.includes('register')) return ['注册', 'register', 'sign up'];
  return ['提交', '确定', 'submit', 'ok', '继续', 'next'];
}

/** 校验规划器产出的引用格式，拦掉乱编的引用 */
export function validatePlan(steps: PlanStep[]): PlanStep[] {
  for (const s of steps) if ((s.op === 'click' || s.op === 'fill' || s.op === 'press') && s.ref) assertRef(s.ref);
  return steps;
}
