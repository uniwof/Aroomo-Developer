/**
 * /work 项目与版本 v1 切片 1。只给所有者（路由层挡）；数据只来自真实信号：项目是她建的，版本只由 GitHub 同步产生。
 * 同步：每个项目 10 分钟最多一次（先占用 last_sync_at，失败也算一次），同一项目同时只跑一次（409）。
 */
import type { AuditFn } from '../audit/types.js';
import { badRequest, conflict, HttpError, notFound } from '../http/errors.js';
import { fetchGithubVersions, validRepo } from './github.js';
import type { Cursor, ProjectPatch, WorkStore } from './store.js';
import { sortAt } from './store.js';
import { MAX_PROJECTS, MAX_SOURCES, PROJECT_STATUSES, SYNC_INTERVAL_MS, VERSION_PAGE, type ProjectStatus, type WorkProject, type WorkSource, type WorkVersion } from './types.js';

export interface SyncResult {
  added: number;
  unchanged: number;
  failed: { source: string; reason: string; retryAt?: string }[];
}

export function normalizeName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (name.length < 1 || name.length > 80) throw badRequest('项目名要 1–80 个字');
  return name;
}
export function normalizeSources(raw: unknown): WorkSource[] {
  if (!Array.isArray(raw)) throw badRequest('来源格式不对');
  if (raw.length > MAX_SOURCES) throw badRequest(`一个项目最多 ${MAX_SOURCES} 个来源`);
  const out: WorkSource[] = [];
  for (const s of raw) {
    const repo = (s as { repo?: unknown })?.repo;
    if ((s as { type?: unknown })?.type !== 'github' || typeof repo !== 'string' || !validRepo(repo)) {
      throw badRequest('GitHub 来源要写成「用户名/仓库名」，比如 octocat/hello-world', 'BAD_SOURCE');
    }
    if (!out.some((x) => x.repo.toLowerCase() === repo.toLowerCase())) out.push({ type: 'github', repo });
  }
  return out;
}

const encodeCursor = (v: WorkVersion) => Buffer.from(`${sortAt(v).toISOString()}|${v.id}`).toString('base64url');
function decodeCursor(raw: string | undefined): Cursor | undefined {
  if (!raw) return undefined;
  // 只认自己发出去的样子：规范 base64url、正好两段（负责人 #323 建议）
  const parts = Buffer.from(raw, 'base64url').toString().split('|');
  const [iso, id] = parts;
  const at = new Date(iso ?? '');
  if (parts.length !== 2 || Buffer.from(raw, 'base64url').toString('base64url') !== raw || !id || Number.isNaN(at.getTime()) || !/^[0-9a-f-]{36}$/i.test(id)) throw badRequest('翻页参数不对');
  return { at, id };
}

export class WorkService {
  readonly #running = new Set<string>();
  constructor(
    private readonly store: WorkStore,
    private readonly now: () => Date,
    private readonly fetchImpl: typeof fetch = fetch,
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
    const sources = body.sources === undefined ? [] : normalizeSources(body.sources);
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
    if (body.sources !== undefined) patch.sources = normalizeSources(body.sources);
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
    const last = await this.store.claimSync(userId, id, now, new Date(now.getTime() - SYNC_INTERVAL_MS));
    if (last) {
      const wait = Math.max(1, Math.ceil((last.getTime() + SYNC_INTERVAL_MS - now.getTime()) / 1000));
      throw new HttpError(429, 'SYNC_TOO_SOON', `刚同步过，${Math.ceil(wait / 60)} 分钟后再试`, { retryAfterSeconds: wait });
    }
    this.#running.add(key);
    try {
      const out: SyncResult = { added: 0, unchanged: 0, failed: [] };
      for (const s of project.sources) {
        const r = await fetchGithubVersions(this.fetchImpl, s.repo);
        if (!r.ok) {
          out.failed.push({ source: s.repo, reason: r.reason, ...(r.retryAt ? { retryAt: r.retryAt.toISOString() } : {}) });
          continue;
        }
        const added = await this.store.addVersions(userId, id, r.versions, now);
        out.added += added;
        out.unchanged += r.versions.length - added;
      }
      await audit('work.sync', { type: 'work_project', id }, out.failed.length ? 'failed' : 'ok', `added=${out.added} unchanged=${out.unchanged} failed=${out.failed.length}`);
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

  async version(userId: string, id: string): Promise<WorkVersion> {
    const v = await this.store.getVersion(userId, id);
    if (!v) throw notFound('找不到这个版本');
    return v;
  }
}
