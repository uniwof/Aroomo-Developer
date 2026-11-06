/**
 * GitHub 公开仓库来源（不带令牌）。只请求 https://api.github.com/repos/<repo>/{releases,tags}：
 * 固定主机、不跟重定向、5 秒超时、每页 30 条、最多 3 页、响应体 ≤1 MB。
 * 草稿 release 不收（不带令牌本来也看不到）；预发布照收。没有任何 release 时用 tag：已打标签，产出者、时间空着。
 * 产物链接只留 https + GitHub 主机（safeGithubUrl），别的记 url=null。
 */
import type { Artifact, VersionInput } from './types.js';

export const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]{1,100}$/;
export function validRepo(repo: string): boolean {
  if (!REPO_RE.test(repo)) return false;
  const name = repo.split('/')[1]!;
  return name !== '.' && name !== '..';
}

const ARTIFACT_HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com', 'codeload.github.com']);
/** 只收 https、GitHub 下载用的几个主机，不带账号密码、不带端口；其余返回 null */
export function safeGithubUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2000) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || !ARTIFACT_HOSTS.has(u.hostname)) return null;
  return raw;
}

export const MAX_PAGES = 3;
const PER_PAGE = 30;
const BODY_MAX = 1024 * 1024;
const TIMEOUT_MS = 5000;

export type FetchResult = { ok: true; versions: VersionInput[] } | { ok: false; reason: string; retryAt?: Date };

class SourceError extends Error {
  constructor(
    message: string,
    readonly retryAt?: Date,
  ) {
    super(message);
  }
}

async function getPage(f: typeof fetch, url: string): Promise<unknown[]> {
  let res: Response;
  try {
    res = await f(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'Aroomo-Work/1', 'x-github-api-version': '2022-11-28' },
    });
  } catch {
    throw new SourceError('连不上 GitHub（超时或网络不通），稍后再试');
  }
  if (res.status >= 300 && res.status < 400) throw new SourceError('仓库搬家或改名了，请把项目来源改成新的 owner/仓库名');
  if (res.status === 404) throw new SourceError('找不到这个仓库（不存在，或是私有仓库——v1 只支持公开仓库）');
  if (res.status === 403 || res.status === 429) {
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    const retryAt = Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000) : undefined;
    throw new SourceError('GitHub 限流，稍后再试', retryAt);
  }
  if (!res.ok) throw new SourceError(`GitHub 回了错误（${res.status}），稍后再试`);
  const len = Number(res.headers.get('content-length'));
  if (Number.isFinite(len) && len > BODY_MAX) throw new SourceError('GitHub 返回的内容太大，没有读');
  const text = await res.text();
  if (text.length > BODY_MAX) throw new SourceError('GitHub 返回的内容太大，没有读');
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new SourceError('GitHub 返回的内容看不懂');
  }
  if (!Array.isArray(body)) throw new SourceError('GitHub 返回的内容看不懂');
  return body;
}

async function pages(f: typeof fetch, repo: string, kind: 'releases' | 'tags'): Promise<unknown[]> {
  const out: unknown[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const rows = await getPage(f, `https://api.github.com/repos/${repo}/${kind}?per_page=${PER_PAGE}&page=${page}`);
    out.push(...rows);
    if (rows.length < PER_PAGE) break;
  }
  return out;
}

const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.length > 0 ? v.slice(0, max) : null);
const date = (v: unknown): Date | null => {
  if (typeof v !== 'string') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

function fromRelease(r: Record<string, unknown>): VersionInput | null {
  if (r.draft === true) return null;
  const id = typeof r.id === 'number' || typeof r.id === 'string' ? String(r.id) : null;
  const tag = str(r.tag_name, 200);
  if (!id || !tag) return null;
  const login = str((r.author as { login?: unknown } | null)?.login, 100);
  const assets = Array.isArray(r.assets) ? (r.assets as Record<string, unknown>[]).slice(0, 20) : [];
  const artifacts: Artifact[] = [
    { type: 'page', title: 'GitHub 发布页', url: safeGithubUrl(r.html_url), size: null },
    ...assets.map((a) => ({
      type: 'file' as const,
      title: str(a.name, 200) ?? '附件',
      url: safeGithubUrl(a.browser_download_url),
      size: typeof a.size === 'number' && Number.isFinite(a.size) && a.size >= 0 ? a.size : null,
    })),
  ];
  return {
    sourceType: 'github_release',
    sourceRef: id,
    label: tag,
    title: str(r.name, 300),
    actor: login ? { type: 'github', name: login } : null,
    artifacts,
    sourceState: r.prerelease === true ? 'prerelease' : 'published',
    sourceAt: date(r.published_at),
  };
}

function fromTag(repo: string, t: Record<string, unknown>): VersionInput | null {
  const name = str(t.name, 200);
  if (!name) return null;
  return {
    sourceType: 'github_tag',
    sourceRef: name,
    label: name,
    title: null,
    actor: null,
    artifacts: [{ type: 'page', title: 'GitHub 标签', url: safeGithubUrl(`https://github.com/${repo}/tree/${encodeURIComponent(name)}`), size: null }],
    sourceState: 'tagged',
    sourceAt: null,
  };
}

export async function fetchGithubVersions(f: typeof fetch, repo: string): Promise<FetchResult> {
  try {
    const rels = (await pages(f, repo, 'releases'))
      .map((r) => (r && typeof r === 'object' ? fromRelease(r as Record<string, unknown>) : null))
      .filter((v): v is VersionInput => v !== null);
    if (rels.length > 0) return { ok: true, versions: rels };
    const tags = (await pages(f, repo, 'tags'))
      .map((t) => (t && typeof t === 'object' ? fromTag(repo, t as Record<string, unknown>) : null))
      .filter((v): v is VersionInput => v !== null);
    return { ok: true, versions: tags };
  } catch (e) {
    if (e instanceof SourceError) return { ok: false, reason: e.message, ...(e.retryAt ? { retryAt: e.retryAt } : {}) };
    throw e;
  }
}
