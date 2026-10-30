#!/usr/bin/env node
// D189 V1–V3 只读验证：对已部署的 LobeHub 只发 GET，不写入、不打印任何凭据。
// 用法：LOBE_URL=https://... [LOBE_TOKEN=...] node scripts/verify-d189.mjs [--json]
// 退出码：0 全过；1 有不过；2 缺少必要配置（结果为「待测」，不算通过）。
const base = (process.env.LOBE_URL || '').replace(/\/$/, '');
const token = process.env.LOBE_TOKEN || '';
const asJson = process.argv.includes('--json');
const results = [];
const add = (id, status, note) => results.push({ id, status, note });

async function get(path) {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(base + path, { headers, signal: ctl.signal, redirect: 'manual' });
    const text = await r.text();
    return { status: r.status, text };
  } catch (e) {
    return { status: 0, text: String(e.message || e) };
  } finally { clearTimeout(t); }
}

export function judgeModels(list) {
  const ids = (list?.data ?? []).map((m) => m.id);
  return { ok: ids.length >= 3, ids };
}

if (!base) {
  add('V1', 'pending', '未设置 LOBE_URL');
  add('V2', 'pending', '未设置 LOBE_URL');
  add('V3', 'pending', '未设置 LOBE_URL');
} else {
  // V1：群组/任务/设备/外部智能体的页面能否打开（不被付费开关挡住）
  const pages = { 群组: '/community', 任务: '/task', 设备: '/settings/device', 外部智能体: '/settings/agent' };
  const bad = [];
  for (const [name, p] of Object.entries(pages)) {
    const r = await get(p);
    if (![200, 304, 307, 308, 302].includes(r.status) || /upgrade|subscribe|付费/i.test(r.text.slice(0, 4000))) bad.push(`${name}:${r.status}`);
  }
  add('V1', bad.length ? 'fail' : 'pass', bad.length ? `页面异常 ${bad.join(', ')}（仍需界面实测复核）` : '四类页面可打开且无付费提示（仍需界面实测复核）');
  // V2：Core /v1/models 至少 3 个不同别名可供群组成员各选其一
  if (!token) add('V2', 'pending', '需要 LOBE_TOKEN 读取 /v1/models；成员模型是否保持要看请求日志');
  else {
    const r = await get('/v1/models');
    let j = null; try { j = JSON.parse(r.text); } catch {}
    const m = judgeModels(j);
    add('V2', m.ok ? 'pass' : 'fail', m.ok ? `可用别名 ${m.ids.length} 个（请求日志 model 字段仍需对照）` : `只有 ${m.ids.length} 个模型可选，或接口返回 ${r.status}`);
  }
  // V3：@ 分派行为属于对话行为，只读接口测不了
  add('V3', 'pending', '@成员/不@监督者属对话行为，只读调用无法判定，走 CI 假模型界面测试');
}
const failed = results.some((r) => r.status === 'fail');
const pending = results.some((r) => r.status === 'pending');
if (asJson) console.log(JSON.stringify(results, null, 2));
else for (const r of results) console.log(`${r.id}\t${r.status}\t${r.note}`);
process.exit(failed ? 1 : pending ? 2 : 0);
