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
  /** 前几轮已做过的动作（只有字段名与动作，不含值），多轮规划时给模型参考 */
  history?: string[];
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

/** 快照行里的角色（ego：`@3 link "x"`；Playwright MCP：`- link "x" [ref=e3]`），认不出返回空串 */
function lineRole(line: string): string {
  const m = line.match(/@\d{1,6}\s+([a-z]+)\s+"/i) ?? line.match(/-\s+([a-z]+)\s+"/i);
  return (m?.[1] ?? '').toLowerCase();
}

/** 导航类行（链接、菜单、标签）里的字样不算障碍，例如菜单里的「支付设置」 */
const NAV_ROLES = new Set(['link', 'menuitem', 'tab', 'listitem', 'navigation', 'treeitem']);

const CAPTCHA_RE =
  /captcha|滑块|拖动.{0,6}验证|人机验证|安全验证|verify you are human|are you a robot|just a moment|checking your browser|performing security verification|cf-turnstile|turnstile|正在验证您|确认您是真人|请稍候.{0,8}验证/;
const TWOFA_RE =
  /one-time|verification code|security code|authentication code|passcode|\botp\b|验证码|动态口令|短信验证|two-factor|两步验证|二次验证|2fa|authenticator/;
const PAYMENT_RE = /payment|信用卡|card number|cvv|cvc|付款|立即支付|确认支付|pay now|place order|checkout.*pay/;

export function detectBlockerInSnapshot(snapshot: string): PlanStep | null {
  const captcha = snapshot.toLowerCase();
  if (CAPTCHA_RE.test(captcha)) return { op: 'blocked', blocker: 'captcha', note: '页面需要验证码' };
  // 两步验证、付款只看非导航行，避免菜单里的字样误报
  const body = snapshot
    .split(/\r?\n/)
    .filter((l) => !NAV_ROLES.has(lineRole(l)))
    .join('\n')
    .toLowerCase();
  if (TWOFA_RE.test(body)) return { op: 'blocked', blocker: '2fa', note: '页面需要两步验证' };
  if (PAYMENT_RE.test(body)) return { op: 'blocked', blocker: 'payment', note: '页面进入付款环节' };
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
