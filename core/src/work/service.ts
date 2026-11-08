/**
 * /work 项目与版本 v1（切片 1 + 2）。只给所有者（路由层挡）；数据只来自真实信号：项目是她建的，版本只由来源同步产生
 * （GitHub 公开仓库、本账号的公共记忆主题、本账号助手的成功运行）。
 * 同步：每个项目 10 分钟最多一次（先占用 last_sync_at，失败也算一次），同一项目同时只跑一次（409）。
 */
import type { AuditFn } from '../audit/types.js';
import { badRequest, conflict, HttpError, notFound } from '../http/errors.js';
import { fetchGithubVersions, validRepo } from './github.js';
import { assistantVersions, memoryVersions, openTarget, validAssistantId, validTopic, type OpenTarget, type SourceReaders } from './sources.js';
import type { Cursor, ProjectPatch, WorkStore } from './store.js';
import { MAX_PROJECTS, MAX_SOURCES, PROJECT_STATUSES, SYNC_INTERVAL_MS, SYNC_PER_HOUR, VERSION_PAGE, type ProjectStatus, type WorkProject, type WorkSource, type WorkVersion } from './types.js';

export interface SyncResult {
  added: number;
  /** 已有的版本里，来源从预发布转成正式发布的条数 */
  changed: number;
  unchanged: number;
  failed: { source: string; reason: string; retryAt?: string }[];
}

export function normalizeName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (name.length < 1 || name.length > 80) throw badRequest('项目名要 1–80 个字');
  return name;
}
const BAD_SOURCE = '来源格式不对。GitHub 写成「用户名/仓库名」，公共记忆写主题名，助手选一个已有的助手';
const sourceKey = (s: WorkSource) => (s.type === 'github' ? `g:${s.repo.toLowerCase()}` : s.type === 'memory' ? `m:${s.topic}` : `a:${s.assistantId.toLowerCase()}`);
/** 只认三种形状，多一个键都不行；公共记忆主题、助手必须属于本账号（按本账号读，别人的和不存在的一样答「找不到」） */
export async function normalizeSources(raw: unknown, userId: string, readers: SourceReaders): Promise<WorkSource[]> {
  if (!Array.isArray(raw)) throw badRequest('来源格式不对');
  if (raw.length > MAX_SOURCES) throw badRequest(`一个项目最多 ${MAX_SOURCES} 个来源`);
  const out: WorkSource[] = [];
  for (const s of raw as Record<string, unknown>[]) {
    const keys = s && typeof s === 'object' ? Object.keys(s).sort().join(',') : '';
    let src: WorkSource;
    if (s?.type === 'github' && keys === 'repo,type' && typeof s.repo === 'string' && validRepo(s.repo)) src = { type: 'github', repo: s.repo };
    else if (s?.type === 'memory' && keys === 'topic,type' && validTopic(s.topic)) {
      if (!(await readers.pubmem.get(userId, s.topic))) throw badRequest(`找不到公共记忆主题「${s.topic}」`, 'BAD_SOURCE');
      src = { type: 'memory', topic: s.topic };
    } else if (s?.type === 'assistant' && keys === 'assistantId,type' && validAssistantId(s.assistantId)) {
      if (!(await readers.assistants.getAssistant(userId, s.assistantId))) throw badRequest('找不到这个助手', 'BAD_SOURCE');
      src = { type: 'assistant', assistantId: s.assistantId };
    } else throw badRequest(BAD_SOURCE, 'BAD_SOURCE');
    if (!out.some((x) => sourceKey(x) === sourceKey(src))) out.push(src);
  }
  return out;
}

/** 游标 = 上一页最后一条的（来源时间，没有就空, 写入先后） */
const encodeCursor = (v: WorkVersion) => Buffer.from(`${v.sourceAt ? v.sourceAt.toISOString() : ''}|${v.seq}`).toString('base64url');
function decodeCursor(raw: string | undefined): Cursor | undefined {
  if (!raw) return undefined;
  // 只认自己发出去的样子：规范 base64url、正好两段（负责人 #323 建议）
  const parts = Buffer.from(raw, 'base64url').toString().split('|');
  const [iso, seq] = parts;
  const at = iso ? new Date(iso) : null;
  if (parts.length !== 2 || Buffer.from(raw, 'base64url').toString('base64url') !== raw || !seq || (at && Number.isNaN(at.getTime())) || !/^\d{1,15}$/.test(seq)) throw badRequest('翻页参数不对');
  return { at, seq: Number(seq) };
}

export class WorkService {
  readonly #running = new Set<string>();
  /** 每个账号最近一小时的同步时间（负责人 #323 建议）。shortcut: 只记在进程里，重启清零；真要跨进程再落库 */
  readonly #recent = new Map<string, number[]>();
  constructor(
    private readonly store: WorkStore,
    private readonly now: () => Date,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly readers: SourceReaders,
  ) {}

  async list(userId: string): Promise<{ project: WorkProject; latest: WorkVersion | null }[]> {
    const [projects, latest] = await Promise.all([this.store.listProjects(userId), this.store.latestByProject(userId)]);
    return projects.map((p) => ({ project: p, latest: latest.get(p.id) ?? null }));
  }

  async get(userId: string, id: string): Promise<WorkProject> {
    const p = await this.store.getProject(userId, id);
    if (!p) throw notFound('找不到这个项目');
    return p;
  }

  async create(userId: string, body: { name?: unknown; sources?: unknown }, audit: AuditFn): Promise<WorkProject> {
    const name = normalizeName(body.name);
    const sources = body.sources === undefined ? [] : await normalizeSources(body.sources, userId, this.readers);
    const r = await this.store.createProject(userId, name, sources, this.now(), MAX_PROJECTS);
    if (!r.ok) throw r.reason === 'name_taken' ? conflict('已经有同名的项目了', 'NAME_TAKEN') : conflict(`最多 ${MAX_PROJECTS} 个项目`, 'TOO_MANY');
    await audit('work.project.create', { type: 'work_project', id: r.project.id }, 'ok', `sources=${sources.length}`);
    return r.project;
  }

  async update(userId: string, id: string, body: { name?: unknown; status?: unknown; sources?: unknown }, audit: AuditFn): Promise<WorkProject> {
    const patch: ProjectPatch = {};
    if (body.name !== undefined) patch.name = normalizeName(body.name);
    if (body.status !== undefined) {
      if (!PROJECT_STATUSES.includes(body.status as ProjectStatus)) throw badRequest('状态只能是 进行中 / 暂停 / 完成');
      patch.status = body.status as ProjectStatus;
    }
    if (body.sources !== undefined) patch.sources = await normalizeSources(body.sources, userId, this.readers);
    const r = await this.store.updateProject(userId, id, patch, this.now());
    if (r === 'name_taken') throw conflict('已经有同名的项目了', 'NAME_TAKEN');
    if (!r) throw notFound('找不到这个项目');
    await audit('work.project.update', { type: 'work_project', id }, 'ok', Object.keys(patch).join(','));
    return r;
  }

  async sync(userId: string, id: string, audit: AuditFn): Promise<SyncResult> {
    const project = await this.get(userId, id);
    const key = `${userId}:${id}`;
    if (this.#running.has(key)) throw conflict('这个项目正在同步，等它做完', 'SYNC_RUNNING');
    const now = this.now();
    const hourAgo = now.getTime() - 60 * 60 * 1000;
    const recent = (this.#recent.get(userId) ?? []).filter((t) => t > hourAgo);
    if (recent.length >= SYNC_PER_HOUR) {
      const wait = Math.max(1, Math.ceil((recent[0]! - hourAgo) / 1000));
      throw new HttpError(429, 'SYNC_HOURLY_LIMIT', `每小时最多同步 ${SYNC_PER_HOUR} 次，${Math.ceil(wait / 60)} 分钟后再试`, { retryAfterSeconds: wait });
    }
    const last = await this.store.claimSync(userId, id, now, new Date(now.getTime() - SYNC_INTERVAL_MS));
    if (last) {
      const wait = Math.max(1, Math.ceil((last.getTime() + SYNC_INTERVAL_MS - now.getTime()) / 1000));
      throw new HttpError(429, 'SYNC_TOO_SOON', `刚同步过，${Math.ceil(wait / 60)} 分钟后再试`, { retryAfterSeconds: wait });
    }
    recent.push(now.getTime());
    this.#recent.set(userId, recent);
    this.#running.add(key);
    try {
      const out: SyncResult = { added: 0, changed: 0, unchanged: 0, failed: [] };
      for (const s of project.sources) {
        const r =
          s.type === 'github'
            ? await fetchGithubVersions(this.fetchImpl, s.repo)
            : s.type === 'memory'
              ? await memoryVersions(this.readers, userId, s.topic)
              : await assistantVersions(this.readers, userId, s.assistantId);
        if (!r.ok) {
          const source = s.type === 'github' ? s.repo : s.type === 'memory' ? `公共记忆 ${s.topic}` : '助手';
          out.failed.push({ source, reason: r.reason, ...(r.retryAt ? { retryAt: r.retryAt.toISOString() } : {}) });
          continue;
        }
        const { added, changed } = await this.store.addVersions(userId, id, r.versions, now);
        out.added += added;
        out.changed += changed;
        out.unchanged += r.versions.length - added - changed;
      }
      await audit('work.sync', { type: 'work_project', id }, out.failed.length ? 'failed' : 'ok', `added=${out.added} changed=${out.changed} unchanged=${out.unchanged} failed=${out.failed.length}`);
      return out;
    } finally {
      this.#running.delete(key);
    }
  }

  async versions(userId: string, projectId: string, cursor?: string): Promise<{ versions: WorkVersion[]; nextCursor: string | null }> {
    await this.get(userId, projectId);
    const rows = await this.store.listVersions(userId, projectId, VERSION_PAGE + 1, decodeCursor(cursor));
    const page = rows.slice(0, VERSION_PAGE);
    return { versions: page, nextCursor: rows.length > VERSION_PAGE ? encodeCursor(page[page.length - 1]!) : null };
  }

  /** 单个版本 + 公共记忆 / 助手来源要「打开」的内容（每次现读来源，不存副本） */
  async version(userId: string, id: string): Promise<{ version: WorkVersion; open: OpenTarget | null }> {
    const v = await this.store.getVersion(userId, id);
    if (!v) throw notFound('找不到这个版本');
    return { version: v, open: await openTarget(this.readers, userId, v) };
  }
}
