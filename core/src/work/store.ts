/** /work 存储：内存版（开发 / 测试）和 PostgreSQL 版（0033，RLS 按 user_id；版本只插不改）。 */
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/db.js';
import { userScoped } from '../db/scope.js';
import type { ProjectStatus, VersionInput, WorkProject, WorkSource, WorkVersion } from './types.js';

export interface ProjectPatch {
  name?: string;
  status?: ProjectStatus;
  sources?: WorkSource[];
}
/** 时间线游标：上一页最后一条的（来源时间，tag 没有 = null, 写入先后） */
export interface Cursor {
  at: Date | null;
  seq: number;
}
/** 同步写入的结果：新加几条、几条从预发布转成已发布 */
export interface AddResult {
  added: number;
  changed: number;
}
export type CreateResult = { ok: true; project: WorkProject } | { ok: false; reason: 'name_taken' | 'too_many' };

export interface WorkStore {
  createProject(userId: string, name: string, sources: WorkSource[], now: Date, max: number): Promise<CreateResult>;
  listProjects(userId: string): Promise<WorkProject[]>;
  getProject(userId: string, id: string): Promise<WorkProject | null>;
  /** null = 找不到；'name_taken' = 改成的名字已有 */
  updateProject(userId: string, id: string, patch: ProjectPatch, now: Date): Promise<WorkProject | null | 'name_taken'>;
  /** 占用同步时间：上次同步早于 notAfter 才写 now 并返回 null；否则返回上次同步时间（限频） */
  claimSync(userId: string, id: string, now: Date, notAfter: Date): Promise<Date | null>;
  /**
   * 按 (项目, 来源类型, 来源编号) 幂等插入。versions 按来源给的先后（新在前），倒着插，最新的写入号最大。
   * 已有的只做一件事：来源从预发布转成正式发布时把 source_state 改成 published（库层触发器只放行这一种改动）。
   */
  addVersions(userId: string, projectId: string, versions: VersionInput[], now: Date): Promise<AddResult>;
  /** 时间线（新在前）。同一项目里已经有同名 release 的 tag 行不列（负责人 #323 必改 3），数据照留 */
  listVersions(userId: string, projectId: string, limit: number, after?: Cursor): Promise<WorkVersion[]>;
  getVersion(userId: string, id: string): Promise<WorkVersion | null>;
  /** 每个项目最新一条（排序同时间线） */
  latestByProject(userId: string): Promise<Map<string, WorkVersion>>;
}

/**
 * 时间线顺序（负责人 #323 小事）：只拿同一种时间比。有来源时间的按来源时间新在前；没有时间的（tag）排在它们后面，
 * 按写入先后（= GitHub 给的先后）新在前。不再用 coalesce(source_at, synced_at)：那会拿 tag 的同步时间和别的版本的来源时间比。
 * 和 PG 的 ORDER BY source_at DESC NULLS LAST, seq DESC 一致。
 */
const ms = (d: Date | null) => (d ? d.getTime() : null);
const newerFirst = (a: WorkVersion, b: WorkVersion) => {
  const x = ms(a.sourceAt);
  const y = ms(b.sourceAt);
  if (x !== y) return x === null ? 1 : y === null ? -1 : y - x;
  return b.seq - a.seq;
};
/** v 排在游标那一条之后 */
const before = (v: WorkVersion, c: Cursor) => newerFirst({ sourceAt: c.at, seq: c.seq } as WorkVersion, v) < 0;
/** 已经有同名 release 的 tag：时间线、最新里不列 */
const shadowed = (all: WorkVersion[], v: WorkVersion) =>
  v.sourceType === 'github_tag' && all.some((r) => r.projectId === v.projectId && r.sourceType === 'github_release' && r.label === v.label);

export class MemoryWorkStore implements WorkStore {
  readonly #projects: (WorkProject & { deletedAt: Date | null })[] = [];
  readonly #versions: WorkVersion[] = [];
  #seq = 0;
  #live(userId: string) {
    return this.#projects.filter((p) => p.userId === userId && !p.deletedAt);
  }
  async createProject(userId: string, name: string, sources: WorkSource[], now: Date, max: number): Promise<CreateResult> {
    const live = this.#live(userId);
    if (live.some((p) => p.name.toLowerCase() === name.toLowerCase())) return { ok: false, reason: 'name_taken' };
    if (live.length >= max) return { ok: false, reason: 'too_many' };
    const p = { id: randomUUID(), userId, name, status: 'active' as const, sources, lastSyncAt: null, createdAt: now, updatedAt: now, deletedAt: null };
    this.#projects.push(p);
    return { ok: true, project: strip(p) };
  }
  async listProjects(userId: string): Promise<WorkProject[]> {
    return this.#live(userId)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || (a.id < b.id ? 1 : -1))
      .map(strip);
  }
  async getProject(userId: string, id: string): Promise<WorkProject | null> {
    const p = this.#live(userId).find((x) => x.id === id);
    return p ? strip(p) : null;
  }
  async updateProject(userId: string, id: string, patch: ProjectPatch, now: Date): Promise<WorkProject | null | 'name_taken'> {
    const p = this.#live(userId).find((x) => x.id === id);
    if (!p) return null;
    if (patch.name !== undefined && this.#live(userId).some((x) => x.id !== id && x.name.toLowerCase() === patch.name!.toLowerCase())) return 'name_taken';
    Object.assign(p, patch, { updatedAt: now });
    return strip(p);
  }
  async claimSync(userId: string, id: string, now: Date, notAfter: Date): Promise<Date | null> {
    const p = this.#live(userId).find((x) => x.id === id);
    if (!p) return null;
    if (p.lastSyncAt && p.lastSyncAt.getTime() > notAfter.getTime()) return p.lastSyncAt;
    p.lastSyncAt = now;
    return null;
  }
  async addVersions(userId: string, projectId: string, versions: VersionInput[], now: Date): Promise<AddResult> {
    const out = { added: 0, changed: 0 };
    for (const v of [...versions].reverse()) {
      const had = this.#versions.find((x) => x.projectId === projectId && x.sourceType === v.sourceType && x.sourceRef === v.sourceRef);
      if (had) {
        if (had.sourceState === 'prerelease' && v.sourceState === 'published') {
          had.sourceState = 'published';
          out.changed++;
        }
        continue;
      }
      this.#versions.push(structuredClone({ ...v, id: randomUUID(), userId, projectId, syncedAt: now, seq: ++this.#seq }));
      out.added++;
    }
    return out;
  }
  async listVersions(userId: string, projectId: string, limit: number, after?: Cursor): Promise<WorkVersion[]> {
    return this.#versions
      .filter((v) => v.userId === userId && v.projectId === projectId && !shadowed(this.#versions, v) && (!after || before(v, after)))
      .sort(newerFirst)
      .slice(0, limit)
      .map((v) => structuredClone(v));
  }
  async getVersion(userId: string, id: string): Promise<WorkVersion | null> {
    const v = this.#versions.find((x) => x.userId === userId && x.id === id);
    return v ? structuredClone(v) : null;
  }
  async latestByProject(userId: string): Promise<Map<string, WorkVersion>> {
    const out = new Map<string, WorkVersion>();
    for (const v of this.#versions.filter((x) => x.userId === userId && !shadowed(this.#versions, x)).sort(newerFirst)) if (!out.has(v.projectId)) out.set(v.projectId, structuredClone(v));
    return out;
  }
}

function strip(p: WorkProject & { deletedAt?: Date | null }): WorkProject {
  return { id: p.id, userId: p.userId, name: p.name, status: p.status, sources: structuredClone(p.sources), lastSyncAt: p.lastSyncAt, createdAt: p.createdAt, updatedAt: p.updatedAt };
}

interface ProjectRow {
  id: string;
  user_id: string;
  name: string;
  status: ProjectStatus;
  sources: WorkSource[];
  last_sync_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}
interface VersionRow {
  id: string;
  user_id: string;
  project_id: string;
  source_type: WorkVersion['sourceType'];
  source_ref: string;
  label: string;
  title: string | null;
  actor: WorkVersion['actor'];
  artifacts: WorkVersion['artifacts'];
  source_state: WorkVersion['sourceState'];
  source_at: Date | string | null;
  synced_at: Date | string;
  seq: string | number;
}
const d = (v: Date | string | null): Date | null => (v === null ? null : new Date(v));
const P_COLS = 'id, user_id, name, status, sources, last_sync_at, created_at, updated_at';
const V_COLS = 'id, user_id, project_id, source_type, source_ref, label, title, actor, artifacts, source_state, source_at, synced_at, seq';
/** 已经有同名 release 的 tag 行不列（负责人 #323 必改 3）；v 是外层 work_versions 的别名 */
const NOT_SHADOWED = `NOT (v.source_type = 'github_tag' AND EXISTS (
  SELECT 1 FROM work_versions r WHERE r.user_id = v.user_id AND r.project_id = v.project_id AND r.source_type = 'github_release' AND r.label = v.label))`;
const toProject = (r: ProjectRow): WorkProject => ({
  id: r.id,
  userId: r.user_id,
  name: r.name,
  status: r.status,
  sources: r.sources,
  lastSyncAt: d(r.last_sync_at),
  createdAt: new Date(r.created_at),
  updatedAt: new Date(r.updated_at),
});
const toVersion = (r: VersionRow): WorkVersion => ({
  id: r.id,
  userId: r.user_id,
  projectId: r.project_id,
  sourceType: r.source_type,
  sourceRef: r.source_ref,
  label: r.label,
  title: r.title,
  actor: r.actor,
  artifacts: r.artifacts,
  sourceState: r.source_state,
  sourceAt: d(r.source_at),
  syncedAt: new Date(r.synced_at),
  seq: Number(r.seq),
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUniqueViolation = (e: unknown) => (e as { code?: string })?.code === '23505';

export class PgWorkStore implements WorkStore {
  constructor(private readonly db: Db) {}
  async createProject(userId: string, name: string, sources: WorkSource[], now: Date, max: number): Promise<CreateResult> {
    return userScoped(this.db, userId).tx(async (q) => {
      // 同一账号建项目串行（数个数 + 插入不被并发穿透）
      await q.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`work:${userId}`]);
      const { rows: c } = await q.query<{ n: string | number }>('SELECT count(*) AS n FROM work_projects WHERE user_id = $1 AND deleted_at IS NULL', [userId]);
      if (Number(c[0]?.n ?? 0) >= max) return { ok: false, reason: 'too_many' } as const;
      try {
        const { rows } = await q.query<ProjectRow>(
          `INSERT INTO work_projects (id, user_id, name, sources, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$5) RETURNING ${P_COLS}`,
          [randomUUID(), userId, name, JSON.stringify(sources), now],
        );
        return { ok: true, project: toProject(rows[0]!) } as const;
      } catch (e) {
        if (isUniqueViolation(e)) return { ok: false, reason: 'name_taken' } as const;
        throw e;
      }
    });
  }
  async listProjects(userId: string): Promise<WorkProject[]> {
    const { rows } = await userScoped(this.db, userId).query<ProjectRow>(
      `SELECT ${P_COLS} FROM work_projects WHERE user_id = $1 AND deleted_at IS NULL ORDER BY updated_at DESC, id DESC`,
      [userId],
    );
    return rows.map(toProject);
  }
  async getProject(userId: string, id: string): Promise<WorkProject | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await userScoped(this.db, userId).query<ProjectRow>(`SELECT ${P_COLS} FROM work_projects WHERE user_id = $1 AND id = $2 AND deleted_at IS NULL`, [userId, id]);
    return rows[0] ? toProject(rows[0]) : null;
  }
  async updateProject(userId: string, id: string, patch: ProjectPatch, now: Date): Promise<WorkProject | null | 'name_taken'> {
    if (!UUID.test(id)) return null;
    try {
      const { rows } = await userScoped(this.db, userId).query<ProjectRow>(
        `UPDATE work_projects SET name = coalesce($3, name), status = coalesce($4, status), sources = coalesce($5::jsonb, sources), updated_at = $6
          WHERE user_id = $1 AND id = $2 AND deleted_at IS NULL RETURNING ${P_COLS}`,
        [userId, id, patch.name ?? null, patch.status ?? null, patch.sources ? JSON.stringify(patch.sources) : null, now],
      );
      return rows[0] ? toProject(rows[0]) : null;
    } catch (e) {
      if (isUniqueViolation(e)) return 'name_taken';
      throw e;
    }
  }
  async claimSync(userId: string, id: string, now: Date, notAfter: Date): Promise<Date | null> {
    return userScoped(this.db, userId).tx(async (q) => {
      const { rows } = await q.query<{ last_sync_at: Date | string | null }>(
        'SELECT last_sync_at FROM work_projects WHERE user_id = $1 AND id = $2 AND deleted_at IS NULL FOR UPDATE',
        [userId, id],
      );
      if (!rows[0]) return null;
      const last = d(rows[0].last_sync_at);
      if (last && last.getTime() > notAfter.getTime()) return last;
      await q.query('UPDATE work_projects SET last_sync_at = $3 WHERE user_id = $1 AND id = $2', [userId, id, now]);
      return null;
    });
  }
  async addVersions(userId: string, projectId: string, versions: VersionInput[], now: Date): Promise<AddResult> {
    if (versions.length === 0) return { added: 0, changed: 0 };
    return userScoped(this.db, userId).tx(async (q) => {
      const out = { added: 0, changed: 0 };
      for (const v of [...versions].reverse()) {
        const { rows } = await q.query<{ id: string }>(
          `INSERT INTO work_versions (id, user_id, project_id, source_type, source_ref, label, title, actor, artifacts, source_state, source_at, synced_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (project_id, source_type, source_ref) DO NOTHING RETURNING id`,
          [randomUUID(), userId, projectId, v.sourceType, v.sourceRef, v.label, v.title, v.actor ? JSON.stringify(v.actor) : null, JSON.stringify(v.artifacts), v.sourceState, v.sourceAt, now],
        );
        if (rows.length) {
          out.added++;
          continue;
        }
        if (v.sourceState !== 'published') continue;
        const up = await q.query<{ id: string }>(
          `UPDATE work_versions SET source_state = 'published'
            WHERE user_id = $1 AND project_id = $2 AND source_type = $3 AND source_ref = $4 AND source_state = 'prerelease' RETURNING id`,
          [userId, projectId, v.sourceType, v.sourceRef],
        );
        out.changed += up.rows.length;
      }
      return out;
    });
  }
  async listVersions(userId: string, projectId: string, limit: number, after?: Cursor): Promise<WorkVersion[]> {
    if (!UUID.test(projectId)) return [];
    const params: unknown[] = [userId, projectId, limit];
    let cond = '';
    if (after?.at) {
      params.push(after.at, after.seq);
      cond = 'AND (v.source_at IS NULL OR (v.source_at, v.seq) < ($4, $5::bigint))';
    } else if (after) {
      params.push(after.seq);
      cond = 'AND v.source_at IS NULL AND v.seq < $4::bigint';
    }
    const { rows } = await userScoped(this.db, userId).query<VersionRow>(
      `SELECT ${V_COLS} FROM work_versions v WHERE v.user_id = $1 AND v.project_id = $2 AND ${NOT_SHADOWED} ${cond}
        ORDER BY v.source_at DESC NULLS LAST, v.seq DESC LIMIT $3`,
      params,
    );
    return rows.map(toVersion);
  }
  async getVersion(userId: string, id: string): Promise<WorkVersion | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await userScoped(this.db, userId).query<VersionRow>(`SELECT ${V_COLS} FROM work_versions WHERE user_id = $1 AND id = $2`, [userId, id]);
    return rows[0] ? toVersion(rows[0]) : null;
  }
  async latestByProject(userId: string): Promise<Map<string, WorkVersion>> {
    const { rows } = await userScoped(this.db, userId).query<VersionRow>(
      `SELECT DISTINCT ON (v.project_id) ${V_COLS} FROM work_versions v WHERE v.user_id = $1 AND ${NOT_SHADOWED}
        ORDER BY v.project_id, v.source_at DESC NULLS LAST, v.seq DESC`,
      [userId],
    );
    return new Map(rows.map((r) => [r.project_id, toVersion(r)]));
  }
}
