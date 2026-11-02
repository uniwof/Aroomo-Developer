/**
 * 任务类型（D173）：checkin 定时签到、login 登录、signup 注册、browse 通用浏览。
 * 不替所有者加用途限制；遇验证码 / 两步验证 / 付款一律推接管卡。
 */

import type { TaskKind } from '../protocol.js';
import { handleBlockers, safeGoto, secretFields, TaskFailed, type TaskHandler } from './context.js';

const LOGIN_FIELDS = ['username', 'email', 'phone', 'password'];
const SIGNUP_FIELDS = ['username', 'email', 'phone', 'password', 'nickname'];

/** 做完后让页面自己说结果，避免「点了按钮就算成功」；回答不明确时不当成失败 */
function failedReply(reply: string): string | null {
  const m = reply.trim().match(/^失败[:：]?\s*(.*)$/s);
  return m ? (m[1] ?? '').slice(0, 120) || '页面没有说明原因' : null;
}

export const checkin: TaskHandler = async (ctx, s) => {
  await ctx.progress('open', '打开网站');
  await safeGoto(ctx, s, ctx.task.site);
  await handleBlockers(ctx, s);
  // 登录状态由 ego lite 保存在本机；没登录时如果任务带了凭据就先登录
  if ((ctx.task.secrets ?? []).length > 0) {
    const fields = await secretFields(ctx, LOGIN_FIELDS);
    const needLogin = await s.act('如果页面显示未登录，返回「需要登录」；否则返回「已登录」');
    if (needLogin.includes('需要登录')) {
      await ctx.progress('login', '先登录');
      await s.fill(fields);
      await s.act('点击登录按钮');
      await handleBlockers(ctx, s);
    }
  }
  ctx.throwIfCancelled();
  await ctx.progress('act', '签到');
  const said = await s.act(ctx.task.instruction ?? '找到签到按钮并点击；如果今天已签到，说明已签到');
  await handleBlockers(ctx, s);
  const verdict = await s.act('判断签到结果，只回答「已签到」「今天已签到」「需要登录」「失败：原因」其中之一');
  if (verdict.includes('需要登录')) {
    await ctx.takeover('login_failed', '签到时发现还没登录，请在电脑浏览器里登录后点「我已处理」', await s.screenshot());
    await handleBlockers(ctx, s);
    const again = await s.act(ctx.task.instruction ?? '找到签到按钮并点击；如果今天已签到，说明已签到');
    return { summary: `签到完成：${again}`, screenshot: await s.screenshot() };
  }
  const why = failedReply(verdict);
  if (why) throw new TaskFailed('CHECKIN_FAILED', `签到没有成功：${why}`);
  const shot = await s.screenshot();
  return { summary: `签到完成：${said}`, screenshot: shot };
};

export const login: TaskHandler = async (ctx, s) => {
  await ctx.progress('open', '打开登录页');
  await safeGoto(ctx, s, ctx.task.site);
  await handleBlockers(ctx, s);
  const fields = await secretFields(ctx, LOGIN_FIELDS);
  if (fields.length === 0) throw new TaskFailed('NO_SECRET', '登录任务没有附带账号凭据');
  await ctx.progress('fill', '填写账号');
  await s.fill(fields);
  ctx.throwIfCancelled();
  const said = await s.act(ctx.task.instruction ?? '点击登录按钮并等待页面跳转');
  await handleBlockers(ctx, s);
  const check = await s.act('判断现在是否已登录成功，只回答「成功」或「失败：原因」');
  if (!check.startsWith('成功')) {
    await ctx.takeover('login_failed', `登录没有成功：${check}`, await s.screenshot());
  }
  return { summary: `登录完成：${said}`, screenshot: await s.screenshot() };
};

export const signup: TaskHandler = async (ctx, s) => {
  await ctx.progress('open', '打开注册页');
  await safeGoto(ctx, s, ctx.task.site);
  await handleBlockers(ctx, s);
  const fields = await secretFields(ctx, SIGNUP_FIELDS);
  await ctx.progress('fill', '填写注册信息');
  if (fields.length) await s.fill(fields);
  ctx.throwIfCancelled();
  const said = await s.act(ctx.task.instruction ?? '填好其余必填项，勾选必要的同意项，点击注册');
  await handleBlockers(ctx, s);
  const verdict = await s.act('判断注册结果，只回答「成功」「需要验证邮件或手机」「失败：原因」其中之一');
  if (/验证邮件|验证邮箱|邮箱验证|手机验证|短信/.test(verdict)) {
    await ctx.takeover('2fa', '注册需要验证邮件或手机，请在电脑上完成验证后点「我已处理」', await s.screenshot());
  } else {
    const why = failedReply(verdict);
    if (why) throw new TaskFailed('SIGNUP_FAILED', `注册没有成功：${why}`);
  }
  const tag = ctx.task.options?.markDisposable ? '（已按「封号即丢弃」登记）' : '';
  return { summary: `注册完成${tag}：${said}`, screenshot: await s.screenshot() };
};

export const browse: TaskHandler = async (ctx, s) => {
  await ctx.progress('open', '打开网站');
  await safeGoto(ctx, s, ctx.task.site);
  await handleBlockers(ctx, s);
  let said = '已打开';
  if (ctx.task.instruction) {
    await ctx.progress('act', '按说明操作');
    said = await s.act(ctx.task.instruction);
    await handleBlockers(ctx, s);
  }
  return { summary: said, screenshot: await s.screenshot() };
};

export const HANDLERS: Record<TaskKind, TaskHandler> = { checkin, login, signup, browse };
