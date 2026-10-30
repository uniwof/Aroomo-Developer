/**
 * 手机任务（options.device = 'phone'）：交给云手机 / 安卓适配器（DroidRun）。
 * 白名单按应用包名；凭据按 secret id 交给 DroidRun 的 type_secret，模型看不到值；
 * 停在验证码 / 两步验证 / 付款时推接管卡，所有者处理后再跑一次。
 */

import { secretIdFor, type PhonePort } from '../adapters/droidrun.js';
import type { TakeoverReason } from '../protocol.js';
import { TaskFailed, type TaskContext, type TaskOutcome } from './context.js';

const DEFAULT_GOAL: Record<string, string> = {
  checkin: '打开应用，找到签到入口并完成今天的签到；如果今天已签到，说明已签到',
  login: '打开应用并登录账号',
  signup: '打开应用并注册新账号，填好必填项并提交',
  browse: '打开应用',
};

export function blockerFromReason(reason: string): Extract<TakeoverReason, 'captcha' | '2fa' | 'payment'> | null {
  const r = reason.toLowerCase();
  if (/captcha|滑块|人机验证/.test(r)) return 'captcha';
  if (/验证码|two-factor|两步验证|2fa|otp|verification code/.test(r)) return '2fa';
  if (/付款|支付|payment|checkout/.test(r)) return 'payment';
  return null;
}

export async function runPhoneTask(ctx: TaskContext, phone: PhonePort): Promise<TaskOutcome> {
  const allowed = ctx.allowlist.checkApp(ctx.task.site);
  if (!allowed.ok) {
    await ctx.takeover('not_allowed', `目标应用不在本机白名单：${allowed.reason}。请在执行员配置的 allowlist.apps 里加上它再重派。`).catch(() => undefined);
    throw new TaskFailed('NOT_ALLOWED', allowed.reason);
  }
  const credentials: Record<string, string> = {};
  for (const ref of ctx.task.secrets ?? []) credentials[secretIdFor(ref.field)] = await ctx.secret(ref);
  const ids = Object.keys(credentials);
  const base = ctx.task.instruction ?? DEFAULT_GOAL[ctx.task.kind] ?? '打开应用';
  const goal = [
    `${base}。应用包名：${allowed.host}。`,
    ids.length ? `需要输入账号信息时用 type_secret 动作，可用的 secret id：${ids.join(', ')}。` : '',
    '遇到验证码、短信验证码、两步验证或付款时，立刻停止并在结果里写明原因。',
  ].join('');

  for (let attempt = 0; attempt < 2; attempt++) {
    ctx.throwIfCancelled();
    await ctx.progress('phone', attempt === 0 ? '在手机上执行' : '你处理好了，继续在手机上执行');
    const r = await phone.run({ goal: attempt === 0 ? goal : `继续完成：${goal}`, credentials });
    if (r.success) return { summary: r.reason || '手机任务完成' };
    const b = blockerFromReason(r.reason);
    if (!b || attempt > 0) throw new TaskFailed('PHONE_FAILED', r.reason || '手机任务没有完成');
    await ctx.takeover(b, `手机上需要你处理：${r.reason}`);
  }
  throw new TaskFailed('PHONE_FAILED', '手机任务没有完成');
}
