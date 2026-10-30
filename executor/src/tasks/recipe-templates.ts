/**
 * 配方模板：一条命令给某个网站装上「登录 + 签到」配方（不用手写 JSON）。
 *   aroomo-executor recipe add happycoding.xyz            （默认模板 newapi）
 *   aroomo-executor recipe add example.com generic
 *   aroomo-executor recipe list / remove <网站>
 * 模板只写字段名和中文操作说明，凭据值永远在运行时按 secret id 现取（parseRecipes 会再校验一遍）。
 * 模板失败时自动退回规划器兜底（onFail 默认 fallback），所以写得宽松即可。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { siteEntryFrom } from '../siteconfig.js';
import { parseRecipes, type Recipe } from './recipes.js';

export const TEMPLATE_NAMES = ['newapi', 'generic'] as const;
export type TemplateName = (typeof TEMPLATE_NAMES)[number];

type Raw = { id: string; site: string; kind: string; steps: unknown[] };

function loginSteps(origin: string, loginPath: string): unknown[] {
  return [
    { do: 'goto', url: `${origin}${loginPath}` },
    { do: 'fill', fields: ['username', 'password'] },
    { do: 'act', text: '点击登录按钮' },
    { do: 'blockers' },
    { do: 'expect', question: '现在是否已登录（看得到账号、控制台或退出入口）', ok: '已登录' },
  ];
}

/** newapi：New API / One API 系公益站（/login、/console/personal 里有「签到」） */
function newapi(host: string): Raw[] {
  const origin = `https://${host}`;
  return [
    { id: `${host}-login`, site: host, kind: 'login', steps: loginSteps(origin, '/login') },
    {
      id: `${host}-checkin`,
      site: host,
      kind: 'checkin',
      steps: [
        ...loginSteps(origin, '/login'),
        { do: 'goto', url: `${origin}/console/personal` },
        { do: 'act', text: '找到「签到」按钮或每日签到入口并点击；如果页面显示今天已经签到，就说明已签到' },
        { do: 'blockers' },
        { do: 'screenshot' },
      ],
    },
  ];
}

/** generic：普通网站，进首页登录，再找签到入口 */
function generic(host: string): Raw[] {
  const origin = `https://${host}`;
  return [
    { id: `${host}-login`, site: host, kind: 'login', steps: [{ do: 'goto', url: `${origin}/` }, { do: 'act', text: '打开登录页面' }, ...loginSteps(origin, '/').slice(1)] },
    {
      id: `${host}-checkin`,
      site: host,
      kind: 'checkin',
      steps: [
        { do: 'goto', url: `${origin}/` },
        { do: 'act', text: '如果还没登录，先打开登录页面' },
        { do: 'fill', fields: ['username', 'password'] },
        { do: 'act', text: '点击登录按钮；如果已经登录就什么都不做' },
        { do: 'blockers' },
        { do: 'act', text: '找到签到入口并点击；如果今天已经签到，就说明已签到' },
        { do: 'blockers' },
        { do: 'screenshot' },
      ],
    },
  ];
}

export function buildTemplate(siteInput: string, template: TemplateName = 'newapi'): Recipe[] {
  const entry = siteEntryFrom(siteInput);
  if (entry.startsWith('*') || entry.includes('android-app')) throw new Error('模板只能用于具体的网站，不能用通配或手机应用');
  const raw = template === 'generic' ? generic(entry) : newapi(entry);
  return parseRecipes({ recipes: raw });
}

function readFileRecipes(file: string): Recipe[] {
  if (!existsSync(file)) return [];
  return parseRecipes(JSON.parse(readFileSync(file, 'utf8')));
}

function writeAtomic(file: string, recipes: Recipe[]): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ recipes }, null, 2)}\n`);
  renameSync(tmp, file);
}

/** 装上某网站的配方：同站点同类型的旧配方被替换，其余原样保留 */
export function addTemplate(file: string, siteInput: string, template: TemplateName = 'newapi'): { added: string[]; total: number } {
  const fresh = buildTemplate(siteInput, template);
  const old = readFileRecipes(file).filter((r) => !fresh.some((f) => f.site === r.site && f.kind === r.kind));
  const all = [...old, ...fresh];
  writeAtomic(file, all);
  return { added: fresh.map((r) => r.id), total: all.length };
}

export function removeSite(file: string, siteInput: string): { removed: string[]; total: number } {
  const site = siteEntryFrom(siteInput);
  const all = readFileRecipes(file);
  const removed = all.filter((r) => r.site === site).map((r) => r.id);
  if (removed.length > 0) writeAtomic(file, all.filter((r) => r.site !== site));
  return { removed, total: all.length - removed.length };
}

export function listRecipes(file: string): Array<{ id: string; site: string; kind: string; steps: number }> {
  return readFileRecipes(file).map((r) => ({ id: r.id, site: r.site, kind: r.kind, steps: r.steps.length }));
}
