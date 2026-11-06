/**
 * /work 项目与版本（docs/api/design-work-v1.md 切片 1，开关 FLAGS.work，只给所有者）。点开才下载，不进对话页包。
 * - 项目列表 /work：名字、状态、最新版本 + 来源状态、更新时间；按状态筛；空状态一句 +「添加项目」。
 * - 版本时间线 /work/<项目>：新在前；「同步」处理中锁住，结果读屏播报。
 * - 版本详情 /work/<项目>?v=<版本>：产物列表，链接新标签打开（读屏名字带「离开 Aroomo」）。
 * 只读 Core 的真实数据，没有就空着；GitHub 来源只显示来源状态，不显示审核按钮（切片 2 才有审核）。
 * 外观只用全站已有的类（.page、.group、.row、.btn、.note、.empty），不加样式、不加动画。
 * 跳过：参与者（列表接口切片 1 不给）、按项目改名/改状态/改来源（接口有，界面等她要再做）。
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ApiError, api } from '@/lib/api';
import { ErrorRetry } from '@/components/ErrorRetry';
import { Empty, errText } from '../../ui';

type ProjectStatus = 'active' | 'paused' | 'done';
type SourceState = 'published' | 'prerelease' | 'tagged' | 'none';
interface Project {
  id: string;
  name: string;
  status: ProjectStatus;
  sources: { type: 'github'; repo: string }[];
  updatedAt: string;
  latest?: { id: string; label: string; sourceState: SourceState; sourceAt: string | null } | null;
}
interface Artifact {
  type: 'page' | 'file';
  title: string;
  url: string | null;
  size: number | null;
}
interface Version {
  id: string;
  label: string;
  title: string | null;
  actor: { type: string; name: string } | null;
  artifacts: Artifact[];
  sourceState: SourceState;
  sourceAt: string | null;
  syncedAt: string;
}
interface SyncResult {
  added: number;
  /** 预发布转成正式发布的条数（旧版 Core 没有这个字段） */
  changed?: number;
  unchanged: number;
  failed: { source: string; reason: string }[];
}
export interface WorkGo {
  project?: string;
  version?: string;
}

const STATUS_LABEL: Record<ProjectStatus, string> = { active: '进行中', paused: '已暂停', done: '已完成' };
const STATE_LABEL: Record<SourceState, string> = { published: '已发布', prerelease: '预发布', tagged: '已打标签', none: '' };

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '');
export function sizeText(n: number | null): string {
  if (n === null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
const joinHint = (parts: (string | null | undefined | false)[]) => parts.filter(Boolean).join(' · ');
const enc = encodeURIComponent;

export function WorkPage({ project, version, onGo }: WorkGo & { onGo: (to: WorkGo) => void }) {
  if (project && version) return <VersionDetail id={version} onGo={onGo} />;
  if (project) return <Timeline id={project} onGo={onGo} />;
  return <ProjectList onGo={onGo} />;
}

/** 找不到（404）：说一句 + 回上一层；不给重试（再读也是没有） */
function Missing({ text, onBack }: { text: string; onBack: () => void }) {
  return (
    <div className="panel">
      <p className="note">{text}</p>
      <button type="button" className="btn btn-outline" onClick={onBack}>
        回到项目列表
      </button>
    </div>
  );
}

// ---------------- 项目列表 ----------------

function ProjectList({ onGo }: { onGo: (to: WorkGo) => void }) {
  const [rows, setRows] = useState<Project[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState('');
  const [adding, setAdding] = useState(false);
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    setFailed(false);
    setRows(null);
    try {
      setRows((await api<{ projects: Project[] }>('GET', '/api/work/projects')).projects);
    } catch {
      setFailed(true);
    }
  }, []);
  useEffect(() => void load(), [load]);

  const shown = (rows ?? []).filter((p) => !filter || p.status === filter);
  const add = (
    <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
      添加项目
    </button>
  );

  return (
    <section aria-labelledby="work-title" className="page">
      <div className="page-head">
        <h2 id="work-title" className="page-title">
          项目
        </h2>
        <p className="page-sub">每个项目有哪些版本、产物在哪。版本只从来源同步来，不能手改。</p>
      </div>
      <p role="status" aria-live="polite" className="note">
        {failed ? '' : rows === null ? '正在加载…' : note}
      </p>
      {failed && <ErrorRetry text="项目没读到。" what="项目" onRetry={() => void load()} />}
      {adding && (
        <AddProject
          onCancel={() => setAdding(false)}
          onAdded={(p) => {
            setAdding(false);
            setRows((r) => [p, ...(r ?? [])]);
            setNote(`已添加「${p.name}」`);
          }}
        />
      )}
      {rows !== null && rows.length === 0 && !adding && <Empty text="还没有项目。" action={add} />}
      {rows !== null && rows.length > 0 && (
        <>
          <div className="toolbar">
            <div className="toolbar-select">
              <span id="work-status-label" className="toolbar-select-label">
                状态
              </span>
              <select className="field-select" aria-labelledby="work-status-label" value={filter} onChange={(e) => setFilter(e.target.value)}>
                <option value="">全部</option>
                {(Object.keys(STATUS_LABEL) as ProjectStatus[]).map((k) => (
                  <option key={k} value={k}>
                    {STATUS_LABEL[k]}
                  </option>
                ))}
              </select>
            </div>
            {!adding && add}
          </div>
          {shown.length === 0 ? (
            <Empty text="没有这个状态的项目。" />
          ) : (
            <ul className="group" aria-label="项目">
              {shown.map((p) => {
                const hint = joinHint([
                  STATUS_LABEL[p.status],
                  p.latest ? `最新 ${p.latest.label}${STATE_LABEL[p.latest.sourceState] ? `（${STATE_LABEL[p.latest.sourceState]}）` : ''}` : '还没有版本',
                  `更新于 ${when(p.updatedAt)}`,
                ]);
                return (
                  <li key={p.id}>
                    <button type="button" className="row row-button" aria-label={`打开项目「${p.name}」：${hint}`} onClick={() => onGo({ project: p.id })}>
                      <span className="row-text">
                        <span className="row-label">{p.name}</span>
                        <span className="row-hint">{hint}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function AddProject({ onCancel, onAdded }: { onCancel: () => void; onAdded: (p: Project) => void }) {
  const [name, setName] = useState('');
  const [repo, setRepo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    const r = repo.trim();
    if (!n) return setError('项目名字要写');
    setBusy(true);
    setError('');
    try {
      const out = await api<{ project: Project }>('POST', '/api/work/projects', { name: n, ...(r ? { sources: [{ type: 'github', repo: r }] } : {}) });
      onAdded({ ...out.project, latest: null });
    } catch (err) {
      setError(errText(err, '没添加成，请稍后再试'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="dlg-form" aria-label="添加项目" onSubmit={(e) => void submit(e)} noValidate>
      <label className="form-field">
        <span className="form-label">项目名字（必填）</span>
        <input name="name" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="form-field">
        <span className="form-label">GitHub 公开仓库（可不填，写成 用户名/仓库名）</span>
        <input name="repo" maxLength={141} value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="octocat/hello-world" autoCapitalize="off" spellCheck={false} />
      </label>
      {error && (
        <p role="alert" className="note note-error">
          {error}
        </p>
      )}
      <div className="dlg-foot">
        <button type="button" className="btn btn-quiet" onClick={onCancel}>
          取消
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? '正在添加…' : '建好'}
        </button>
      </div>
    </form>
  );
}

// ---------------- 版本时间线 ----------------

function syncText(r: SyncResult): string {
  const head = [r.added && `新加 ${r.added} 个版本`, r.changed && `${r.changed} 个转成已发布`].filter(Boolean).join('，') || '没有新版本';
  return [head, ...r.failed.map((f) => `${f.source}：${f.reason}`)].join('；');
}

function Timeline({ id, onGo }: { id: string; onGo: (to: WorkGo) => void }) {
  const [project, setProject] = useState<Project | null>(null);
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [state, setState] = useState<'' | 'failed' | 'missing'>('');
  const [missing, setMissing] = useState('');
  const [busy, setBusy] = useState<'' | 'sync' | 'more'>('');
  const [note, setNote] = useState('');
  const [syncErr, setSyncErr] = useState('');

  const loadVersions = useCallback(async () => {
    const r = await api<{ versions: Version[]; nextCursor: string | null }>('GET', `/api/work/projects/${enc(id)}/versions`);
    setVersions(r.versions);
    setCursor(r.nextCursor);
  }, [id]);
  const load = useCallback(async () => {
    setState('');
    setVersions(null);
    try {
      const [p] = await Promise.all([api<{ project: Project }>('GET', `/api/work/projects/${enc(id)}`), loadVersions()]);
      setProject(p.project);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        setMissing(e.message);
        setState('missing');
      } else setState('failed');
    }
  }, [id, loadVersions]);
  useEffect(() => void load(), [load]);

  const sync = async () => {
    setBusy('sync');
    setNote('');
    setSyncErr('');
    try {
      const r = await api<SyncResult>('POST', `/api/work/projects/${enc(id)}/sync`, {});
      setNote(syncText(r));
      await loadVersions().catch(() => setSyncErr('同步好了，但版本列表没刷新出来，请稍后再打开'));
    } catch (e) {
      setSyncErr(errText(e, '没同步成，请稍后再试'));
    } finally {
      setBusy('');
    }
  };
  const more = async () => {
    if (!cursor) return;
    setBusy('more');
    setSyncErr('');
    try {
      const r = await api<{ versions: Version[]; nextCursor: string | null }>('GET', `/api/work/projects/${enc(id)}/versions?cursor=${enc(cursor)}`);
      setVersions((v) => [...(v ?? []), ...r.versions]);
      setCursor(r.nextCursor);
    } catch (e) {
      setSyncErr(errText(e, '更早的版本没读到，请稍后再试'));
    } finally {
      setBusy('');
    }
  };

  if (state === 'missing') return <Missing text={missing} onBack={() => onGo({})} />;
  const repos = project?.sources.map((s) => s.repo) ?? [];

  return (
    <section aria-labelledby="work-project-title" className="page">
      <div className="page-head">
        <h2 id="work-project-title" className="page-title">
          {project?.name ?? '项目'}
        </h2>
        {project && <p className="page-sub">{joinHint([STATUS_LABEL[project.status], repos.length ? `来源：GitHub ${repos.join('、')}` : '还没有来源'])}</p>}
      </div>
      {project && (
        <div className="panel-actions">
          <button type="button" className="btn btn-primary" disabled={!!busy} onClick={() => void sync()}>
            {busy === 'sync' ? '正在同步…' : '同步'}
          </button>
        </div>
      )}
      <p role="status" aria-live="polite" className="note">
        {state === 'failed' ? '' : versions === null ? '正在加载…' : note}
      </p>
      {syncErr && (
        <p role="alert" className="note note-error">
          {syncErr}
        </p>
      )}
      {state === 'failed' && <ErrorRetry text="版本没读到。" what="版本" onRetry={() => void load()} />}
      {versions !== null && versions.length === 0 && <Empty text={repos.length ? '还没有版本。点「同步」从 GitHub 拿已发布的版本。' : '还没有版本。这个项目还没有来源。'} />}
      {versions !== null && versions.length > 0 && (
        <ul className="group" aria-label="版本">
          {versions.map((v) => {
            const hint = joinHint([v.title, v.actor?.name, when(v.sourceAt), STATE_LABEL[v.sourceState], `${v.artifacts.length} 个产物`]);
            return (
              <li key={v.id}>
                <button type="button" className="row row-button" aria-label={`打开版本 ${v.label}：${hint}`} onClick={() => onGo({ project: id, version: v.id })}>
                  <span className="row-text">
                    <span className="row-label">{v.label}</span>
                    <span className="row-hint">{hint}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {cursor && (
        <button type="button" className="btn btn-outline" disabled={!!busy} onClick={() => void more()}>
          {busy === 'more' ? '正在加载…' : '更早的版本'}
        </button>
      )}
    </section>
  );
}

// ---------------- 版本详情 ----------------

function VersionDetail({ id, onGo }: { id: string; onGo: (to: WorkGo) => void }) {
  const [v, setV] = useState<Version | null>(null);
  const [state, setState] = useState<'' | 'failed' | 'missing'>('');
  const [missing, setMissing] = useState('');
  const load = useCallback(async () => {
    setState('');
    setV(null);
    try {
      setV((await api<{ version: Version }>('GET', `/api/work/versions/${enc(id)}`)).version);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        setMissing(e.message);
        setState('missing');
      } else setState('failed');
    }
  }, [id]);
  useEffect(() => void load(), [load]);

  if (state === 'missing') return <Missing text={missing} onBack={() => onGo({})} />;
  if (state === 'failed')
    return (
      <div className="panel">
        <ErrorRetry text="版本没读到。" what="版本" onRetry={() => void load()} />
      </div>
    );
  if (!v)
    return (
      <div className="panel">
        <p role="status" className="note">
          正在加载…
        </p>
      </div>
    );

  const meta: [string, string][] = [
    ['来源状态', STATE_LABEL[v.sourceState]],
    ['产出者', v.actor?.name ?? ''],
    ['来源时间', when(v.sourceAt)],
    ['同步时间', when(v.syncedAt)],
  ];
  return (
    <section aria-labelledby="work-version-title" className="page">
      <div className="page-head">
        <h2 id="work-version-title" className="page-title">
          {v.title ? `${v.label} · ${v.title}` : v.label}
        </h2>
        <p className="page-sub">来源状态由 GitHub 给出，这里只能看。</p>
      </div>
      <ul className="group" aria-label="版本信息">
        {meta
          .filter(([, val]) => val)
          .map(([k, val]) => (
            <li key={k} className="row">
              <span className="row-text">
                <span className="row-label">{k}</span>
              </span>
              <span className="row-value">{val}</span>
            </li>
          ))}
      </ul>
      <section className="group-block" aria-labelledby="work-artifacts-title">
        <h3 id="work-artifacts-title" className="group-title">
          产物
        </h3>
        {v.artifacts.length === 0 ? (
          <p className="note">这个版本没有产物。</p>
        ) : (
          <ul className="group" aria-label="产物">
            {v.artifacts.map((a, i) => (
              <li key={i} className="row">
                <span className="row-text">
                  <span className="row-label row-break">{a.title}</span>
                  <span className="row-hint">{joinHint([a.type === 'page' ? '页面' : '文件', sizeText(a.size)])}</span>
                </span>
                {a.url ? (
                  <a className="btn btn-outline" href={a.url} target="_blank" rel="noopener noreferrer" aria-label={`${a.title}：打开 GitHub，离开 Aroomo，在新标签页打开`}>
                    打开 GitHub ↗
                  </a>
                ) : (
                  <span className="row-value">链接不可用</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}

export default WorkPage;
