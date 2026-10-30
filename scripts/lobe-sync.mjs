#!/usr/bin/env node
// D191：把 Core 的成员同步成 LobeHub 智能体 + 群组，只走官方 CLI（lh，外部工具，不进依赖树），绝不碰 LobeHub 数据库。
// 用法：LOBEHUB_SERVER=https://… LOBEHUB_CLI_API_KEY=（LobeHub 设置→API 密钥，只放环境变量，不打印）
//       CORE_URL=http://127.0.0.1:8080 CORE_TOKEN=（主人令牌）LH_BIN=/path/to/lh node scripts/lobe-sync.mjs [--dry-run]
// 幂等：按名称查，已存在的跳过。模型：Core /v1 目前只有 aroomo（Core 内部按 @ 点名路由）；
// 后台线露出成员别名（/v1/models 里有 aroomo/<名字>）后，每个成员智能体自动改用自己的别名。
import { execFileSync } from 'node:child_process';

const dry = process.argv.includes('--dry-run');
const lh = process.env.LH_BIN || 'lh';
const core = (process.env.CORE_URL || '').replace(/\/$/, '');
const GROUP = 'Aroomo';

function run(args) {
  if (dry) { console.log('[dry-run] lh', args.join(' ')); return '[]'; }
  return execFileSync(lh, args, { encoding: 'utf8', env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
}
const json = (args) => { try { return JSON.parse(run([...args, '--json'])); } catch { return []; } };

export function planAgents(members, modelIds) {
  return members
    .filter((m) => m.enabled && m.status === 'active')
    .map((m) => ({
      title: m.name,
      model: modelIds.find((id) => id === `aroomo/${m.name}`) ?? 'aroomo',
      role: `你是 ${m.name}，Aroomo 群组成员。${(m.capabilityTags ?? []).length ? '擅长：' + m.capabilityTags.join('、') + '。' : ''}`,
    }));
}

async function main() {
  if (!core || !process.env.CORE_TOKEN) { console.error('缺少 CORE_URL / CORE_TOKEN'); process.exit(2); }
  const h = { authorization: `Bearer ${process.env.CORE_TOKEN}` };
  const members = (await (await fetch(`${core}/api/members`, { headers: h })).json()).members ?? [];
  let modelIds = [];
  if (process.env.CORE_CHAT_TOKEN) {
    const r = await fetch(`${core}/v1/models`, { headers: { authorization: `Bearer ${process.env.CORE_CHAT_TOKEN}` } });
    modelIds = ((await r.json()).data ?? []).map((m) => m.id);
  }
  const plan = planAgents(members, modelIds);
  const have = new Set(json(['agent', 'list', '-L', '200']).map?.((a) => a.title ?? a.name) ?? []);
  const ids = [];
  for (const a of plan) {
    if (have.has(a.title)) { console.log('skip  ', a.title); continue; }
    run(['agent', 'create', '-t', a.title, '-m', a.model, '-p', 'openai', '-s', a.role]);
    console.log('create', a.title, a.model);
  }
  const groups = json(['agent-group', 'list']);
  const g = Array.isArray(groups) ? groups.find((x) => (x.title ?? x.name) === GROUP) : null;
  if (!g) { run(['agent-group', 'create', '-t', GROUP, '-d', 'Aroomo 成员群组；不 @ 时由负责人（aroomo）回答']); console.log('create group', GROUP); }
  else console.log('skip   group', GROUP);
  console.log(`done: ${plan.length} 个成员智能体${ids.length ? '' : ''}。把成员加进群组：lh agent-group add-agents <群组ID> --agent-ids <ID,ID>`);
}
if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
