/**
 * 站点配方（D173 任务模板）：对常用网站，所有者可以写死一串步骤，比让模型每次现想更快更稳。
 * 配方出错（找不到按钮、没登录成功等）时自动退回通用处理器（规划器兜底）；
 * 但取消、白名单外、验证码多次未过这类「不该重试」的失败原样抛出，不兜底。
 *
 * 配方文件：与 config.json 同目录的 recipes.json。
 * 安全：配方里只写字段名（username / password …），值永远在运行时按 secret id 现取；
 * 文字步骤里不允许出现 {{ }} 占位或疑似密码的字段，配置不合格整份拒绝加载。
 */

import { existsSync, readFileSync } from 'node:fs';
import { normalizeSiteEntry } from '../allowlist.js';
import { TASK_KINDS, type TaskKind } from '../protocol.js';
import {
  assertStillAllowed,
  handleBlockers,
  safeGoto,
  secretFields,
  TaskCancelled,
  TaskFailed,
  type TaskContext,
  type TaskHandler,
} from './context.js';

export type RecipeStep =
  | { do: 'goto'; url: string }
  | { do: 'fill'; fields: string[] }
  | { do: 'act'; text: string }
  | { do: 'expect'; question: string; ok: string }
  | { do: 'blockers' }
  | { do: 'screenshot' };

export interface Recipe {
  id: string;
  /** 主机名，写法同白名单：example.com 或 *.example.com */
  site: string;
  kind: TaskKind;
  steps: RecipeStep[];
  /** fallback（默认）：配方失败退回通用处理器；fail：直接失败 */
  onFail?: 'fallback' | 'fail';
}

const FIELD_RE = /^[a-z][a-z0-9_]{0,31}$/;
const MAX_STEPS = 40;
const MAX_TEXT = 300;

function text(v: unknown, name: string): string {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${name} 必须是非空文字`);
  if (v.length > MAX_TEXT) throw new Error(`${name} 太长（最多 ${MAX_TEXT} 字）`);
  if (v.includes('{{') || v.includes('${')) throw new Error(`${name} 里不能放占位符；凭据只能用 fill 步骤按字段名取`);
  return v.trim();
}

function parseStep(raw: unknown, where: string): RecipeStep {
  if (!raw || typeof raw !== 'object') throw new Error(`${where} 不是对象`);
  const s = raw as Record<string, unknown>;
  switch (s.do) {
    case 'goto': {
      const url = text(s.url, `${where}.url`);
      new URL(url);
      return { do: 'goto', url };
    }
    case 'fill': {
      if (!Array.isArray(s.fields) || s.fields.length === 0) throw new Error(`${where}.fields 必须是字段名列表`);
      for (const f of s.fields) if (typeof f !== 'string' || !FIELD_RE.test(f)) throw new Error(`${where}.fields 里有不合格的字段名`);
      if ('value' in s || 'values' in s) throw new Error(`${where} 不能写死值；凭据只按 secret id 现取`);
      return { do: 'fill', fields: s.fields as string[] };
    }
    case 'act':
      return { do: 'act', text: text(s.text, `${where}.text`) };
    case 'expect':
      return { do: 'expect', question: text(s.question, `${where}.question`), ok: text(s.ok, `${where}.ok`) };
    case 'blockers':
      return { do: 'blockers' };
    case 'screenshot':
      return { do: 'screenshot' };
    default:
      throw new Error(`${where} 的 do 只能是 goto/fill/act/expect/blockers/screenshot`);
  }
}

export function parseRecipes(raw: unknown): Recipe[] {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { recipes?: unknown }).recipes)) throw new Error('recipes.json 需要 {"recipes":[…]}');
  const out: Recipe[] = [];
  const ids = new Set<string>();
  for (const [i, r] of ((raw as { recipes: unknown[] }).recipes).entries()) {
    const where = `recipes[${i}]`;
    if (!r || typeof r !== 'object') throw new Error(`${where} 不是对象`);
    const o = r as Record<string, unknown>;
    const id = text(o.id, `${where}.id`);
    if (ids.has(id)) throw new Error(`${where}.id 重复：${id}`);
    ids.add(id);
    const site = normalizeSiteEntry(text(o.site, `${where}.site`));
    if (typeof o.kind !== 'string' || !(TASK_KINDS as readonly string[]).includes(o.kind)) throw new Error(`${where}.kind 不对`);
    if (!Array.isArray(o.steps) || o.steps.length === 0 || o.steps.length > MAX_STEPS) throw new Error(`${where}.steps 需要 1–${MAX_STEPS} 步`);
    if (o.onFail !== undefined && o.onFail !== 'fallback' && o.onFail !== 'fail') throw new Error(`${where}.onFail 只能是 fallback 或 fail`);
    out.push({
      id,
      site,
      kind: o.kind as TaskKind,
      steps: o.steps.map((s, j) => parseStep(s, `${where}.steps[${j}]`)),
      ...(o.onFail ? { onFail: o.onFail } : {}),
    });
  }
  return out;
}

/** 文件不存在 = 没有配方（不是错误） */
export function loadRecipes(path: string): Recipe[] {
  if (!existsSync(path)) return [];
  return parseRecipes(JSON.parse(readFileSync(path, 'utf8')));
}

function hostMatches(pattern: string, host: string): boolean {
  return pattern.startsWith('*.') ? host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1 : host === pattern;
}

export function findRecipe(recipes: Recipe[], kind: TaskKind, site: string): Recipe | undefined {
  let host: string;
  try {
    host = new URL(site).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  // 精确主机名优先于通配
  return recipes.filter((r) => r.kind === kind && hostMatches(r.site, host)).sort((a, b) => Number(a.site.startsWith('*')) - Number(b.site.startsWith('*')))[0];
}

/** 配方步骤失败（可兜底） */
export class RecipeStepFailed extends Error {
  constructor(
    readonly recipeId: string,
    readonly step: number,
    message: string,
  ) {
    super(message);
    this.name = 'RecipeStepFailed';
  }
}

export const recipeHandler = (recipe: Recipe): TaskHandler => async (ctx: TaskContext, s) => {
  let said = '';
  for (const [i, st] of recipe.steps.entries()) {
    ctx.throwIfCancelled();
    try {
      switch (st.do) {
        case 'goto':
          await safeGoto(ctx, s, st.url);
          break;
        case 'fill': {
          const fields = await secretFields(ctx, st.fields);
          if (fields.length === 0) throw new RecipeStepFailed(recipe.id, i, '任务没有带这一步要用的凭据字段');
          await s.fill(fields);
          break;
        }
        case 'act':
          await ctx.progress('act', `配方 ${recipe.id}：第 ${i + 1} 步`);
          said = await s.act(st.text);
          await assertStillAllowed(ctx, s);
          break;
        case 'expect': {
          const a = await s.act(`${st.question}（只用一句话回答）`);
          if (!a.includes(st.ok)) throw new RecipeStepFailed(recipe.id, i, `第 ${i + 1} 步检查没通过`);
          break;
        }
        case 'blockers':
          await handleBlockers(ctx, s);
          break;
        case 'screenshot':
          await s.screenshot();
          break;
      }
    } catch (e) {
      // 不该重试的失败原样抛出
      if (e instanceof TaskCancelled || e instanceof TaskFailed || e instanceof RecipeStepFailed) throw e;
      throw new RecipeStepFailed(recipe.id, i, `第 ${i + 1} 步出错`);
    }
  }
  return { summary: `${recipe.kind === 'checkin' ? '签到' : '完成'}（配方 ${recipe.id}）${said ? `：${said}` : ''}`, screenshot: await s.screenshot() };
};

/**
 * 给处理器表套上配方：任务命中配方就先走配方；配方失败按 onFail 退回通用处理器。
 * 错误信息只带步骤序号，不带页面内容（页面可能回显填过的值）。
 */
export function withRecipes(base: Record<TaskKind, TaskHandler>, recipes: Recipe[]): Record<TaskKind, TaskHandler> {
  if (recipes.length === 0) return base;
  const wrap = (kind: TaskKind): TaskHandler => async (ctx, s) => {
    const r = findRecipe(recipes, kind, ctx.task.site);
    if (!r) return base[kind](ctx, s);
    try {
      return await recipeHandler(r)(ctx, s);
    } catch (e) {
      if (!(e instanceof RecipeStepFailed)) throw e;
      if (r.onFail === 'fail') throw new TaskFailed('RECIPE_FAILED', `配方 ${r.id} 第 ${e.step + 1} 步没成功`);
      await ctx.progress('fallback', `配方 ${r.id} 第 ${e.step + 1} 步没成功，改用通用办法`);
      return base[kind](ctx, s);
    }
  };
  return { checkin: wrap('checkin'), login: wrap('login'), signup: wrap('signup'), browse: wrap('browse') };
}
