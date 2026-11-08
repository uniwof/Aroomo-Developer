/**
 * /work 切片 2：Aroomo 自己的两种版本来源（只读本账号，经各自 store 的 user_id 范围 + RLS）。
 * - 公共记忆：主题的每个版本（含当前版）。来源编号 = 主题@版本号@主题建立时间（毫秒）。
 *   负责人 #342 必改 2：不用「那一版的写入时间」——当前版读 updatedAt、历史版读 createdAt，同一版从当前变成历史时
 *   编号一旦对不上就会生出删不掉的重复快照。主题建立时间写新版、回滚都不变，只有删了再建才变：
 *   所以同一版本编号永远不变，删了再建的同名主题从第 1 版重新数，也不会被当成「已有」。
 *   没有作者，actor = null。旧版本超过 KEEP_VERSIONS 会被清理：快照留着，详情说「已清理」。
 * - 助手：每次成功（succeeded）的运行。标签 = 助手名字，标题 = 结果摘要第一行，时间 = 完成时间，产出者 = 这个助手。
 * 只用真实数据：拿不到的空着，不编。
 */
import type { AssistantStore } from '../assistants/types.js';
import type { PubMemStore } from '../pubmem/types.js';
import { TOPIC_RE } from '../pubmem/types.js';
import type { FetchResult } from './github.js';
import type { VersionInput, WorkVersion } from './types.js';

export interface SourceReaders {
  pubmem: Pick<PubMemStore, 'get' | 'versions'>;
  assistants: Pick<AssistantStore, 'getAssistant' | 'listRuns' | 'getRun'>;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const validTopic = (t: unknown): t is string => typeof t === 'string' && TOPIC_RE.test(t);
export const validAssistantId = (id: unknown): id is string => typeof id === 'string' && UUID_RE.test(id);

/** 一次同步最多看最近多少次运行。shortcut: 更早的成功运行不进 /work，真有人要再给助手运行加游标 */
export const RUNS_PER_SYNC = 100;
const MEMORY_GONE = '找不到这个公共记忆主题（可能已经删了）';
const ASSISTANT_GONE = '找不到这个助手（可能已经删了）';

/** born = 主题建立时间（MemoryEntry.createdAt），版本从当前变成历史时不变 */
const memRef = (topic: string, version: number, born: Date) => `${topic}@${version}@${born.getTime()}`;
function parseMemRef(ref: string): { topic: string; version: number; born: number } | null {
  const m = /^([a-z0-9][a-z0-9._-]{0,63})@(\d{1,9})@(\d{1,15})$/.exec(ref);
  return m ? { topic: m[1]!, version: Number(m[2]), born: Number(m[3]) } : null;
}

export async function memoryVersions(r: SourceReaders, userId: string, topic: string): Promise<FetchResult> {
  const cur = await r.pubmem.get(userId, topic);
  if (!cur) return { ok: false, reason: MEMORY_GONE };
  const all = [{ version: cur.version, title: cur.title, at: cur.updatedAt }, ...(await r.pubmem.versions(userId, topic)).map((h) => ({ version: h.version, title: h.title, at: h.createdAt }))];
  all.sort((a, b) => b.version - a.version);
  const versions: VersionInput[] = all.map((v) => ({
    sourceType: 'memory',
    sourceRef: memRef(topic, v.version, cur.createdAt),
    label: `第 ${v.version} 版`,
    title: v.title.slice(0, 300),
    actor: null,
    artifacts: [],
    sourceState: 'none',
    sourceAt: v.at,
  }));
  return { ok: true, versions };
}

export async function assistantVersions(r: SourceReaders, userId: string, assistantId: string): Promise<FetchResult> {
  const a = await r.assistants.getAssistant(userId, assistantId);
  if (!a) return { ok: false, reason: ASSISTANT_GONE };
  const runs = (await r.assistants.listRuns(userId, assistantId, RUNS_PER_SYNC)).filter((x) => x.status === 'succeeded' && x.finishedAt);
  runs.sort((x, y) => y.finishedAt!.getTime() - x.finishedAt!.getTime());
  const label = a.name.slice(0, 200);
  const versions: VersionInput[] = runs.map((run) => {
    const first = run.summary?.split('\n').find((l) => l.trim())?.trim() ?? '';
    return {
      sourceType: 'assistant_run',
      sourceRef: run.id,
      label,
      title: first ? first.slice(0, 300) : null,
      actor: { type: 'assistant', name: label, id: a.id },
      artifacts: [],
      sourceState: 'none',
      sourceAt: run.finishedAt,
    };
  });
  return { ok: true, versions };
}

/** 版本详情里「打开」的内容：公共记忆那一版的正文（被清理了 = null）；助手那次运行的完整摘要（运行删了 = null） */
export type OpenTarget =
  | { kind: 'memory'; topic: string; version: number; body: string | null }
  | { kind: 'assistant'; assistantId: string; runId: string; summary: string | null };

export async function openTarget(r: SourceReaders, userId: string, v: WorkVersion): Promise<OpenTarget | null> {
  if (v.sourceType === 'memory') {
    const ref = parseMemRef(v.sourceRef);
    if (!ref) return null;
    const out = { kind: 'memory' as const, topic: ref.topic, version: ref.version };
    const cur = await r.pubmem.get(userId, ref.topic);
    // 主题删了、或删了再建（建立时间变了）：这一版已不在
    if (!cur || cur.createdAt.getTime() !== ref.born) return { ...out, body: null };
    if (cur.version === ref.version) return { ...out, body: cur.body };
    const old = (await r.pubmem.versions(userId, ref.topic)).find((h) => h.version === ref.version);
    return { ...out, body: old?.body ?? null };
  }
  if (v.sourceType === 'assistant_run' && v.actor?.type === 'assistant') {
    const run = await r.assistants.getRun(userId, v.actor.id, v.sourceRef);
    return { kind: 'assistant', assistantId: v.actor.id, runId: v.sourceRef, summary: run?.summary ?? null };
  }
  return null;
}
