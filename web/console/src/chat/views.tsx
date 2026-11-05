/**
 * 资源库、工具、API 三个面板和设置里的个人资料 / 通用 / 家人与邀请（自审 A5 A7 A8 A9，负责人落地文档 8–11 章，照 sumus）。
 * - 同一套零件：分组列表（.group/.row）、原生弹窗（Dialog）、按钮（.btn）、表单标签在框上方（.form-field）。
 * - 空状态 = 一句话 + 一个动作；术语用大白话；只接 Core 已有接口，没有接口的功能不放按钮（缺的接口列在 #250 回报里）。
 * - Key 的完整值永远不回到浏览器：新增 / 替换用只写的密码框，提交后清空，不存本机。
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Plus, Search, Trash2 } from 'lucide-react';
import { ApiError, api, currentUser, logout, type Challenge, type Member } from '@/lib/api';
import { useUsage, worstRow, type UsageRow } from '@/lib/usage';
import { ACCESS_LABEL, KIND_LABEL, quotaText, trialText, type CapabilityAccess, type CapabilityKind } from '@/lib/capabilities';
import { Field, Group } from '@/pages/Settings';
import { ConfirmCard } from '@/components/ConfirmCard';
import { Dialog, useAsk } from '@/components/Dialog';
import { QuotaRing } from '@/components/brand';
import { Avatar } from './Avatar';
import { quotaState } from './Rail';

/** 资源库收藏的类型（D163） */
export const SAVED_KIND: Record<string, string> = {
  article: '文章',
  skill: '技能',
  method: '方法',
  material: '素材',
  tool: '工具线索',
  link: '链接',
  idea: '点子',
};
export interface LibraryEntry {
  id: string;
  kind: string;
  title: string;
  url: string | null;
  body: string;
  tags: string[];
  source: string;
  createdAt: string;
}
/** 外部工具（GET /api/capabilities 的 tools） */
export interface ToolItem {
  id: string;
  name: string;
  group: string;
  access: CapabilityAccess;
  status: string;
  quota: { used: number | null; limit: number | null; unit: string } | null;
  note: string | null;
}
export const STATUS_LABEL: Record<string, string> = {
  ready: '能用',
  unverified: '还没验证',
  failed: '验证没通过',
  missing: '还没填 Key',
  keyless: '能用（不用 Key）',
};
export function groupTools(tools: ToolItem[]): [string, ToolItem[]][] {
  const m = new Map<string, ToolItem[]>();
  for (const t of tools) m.set(t.group, [...(m.get(t.group) ?? []), t]);
  return [...m.entries()];
}

const errText = (e: unknown, fallback = '出错了，请稍后再试') => (e instanceof ApiError ? e.message : fallback);

/** 空状态：一句话 + 一个动作 */
export function Empty({ text, action }: { text: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty-text">{text}</p>
      {action}
    </div>
  );
}

/** 一组单选筛选（sumus 全站唯一那种分段筛选；这是筛选，不是标签页） */
function Filter<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v} type="button" role="radio" aria-checked={value === v} className="seg-item" onClick={() => onChange(v)}>
          {text}
        </button>
      ))}
    </div>
  );
}

function SearchBox({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="search2 toolbar-search">
      <Search aria-hidden="true" />
      <span className="sr-only">{label}</span>
      <input type="search" placeholder={label} value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

/** 弹窗底部：取消 + 主按钮 */
function DialogFoot({ onCancel, ok, busy }: { onCancel: () => void; ok: string; busy?: boolean }) {
  return (
    <div className="dlg-foot">
      <button type="button" className="btn btn-quiet" onClick={onCancel}>
        取消
      </button>
      <button type="submit" className="btn btn-primary" disabled={busy}>
        {busy ? '正在保存…' : ok}
      </button>
    </div>
  );
}

// ---------------- 添加成员（落地文档 8.2，照 sumus「New agent」弹窗） ----------------

const TAGS: [string, string][] = [
  ['text', '聊天'],
  ['long-context', '长文章'],
  ['reasoning', '推理'],
  ['code', '写代码'],
  ['image', '画图'],
  ['video', '做视频'],
  ['multimodal', '看图'],
  ['voice', '语音'],
];

/**
 * 添加成员：名字（= 模型名，Core 按名字配 Key）+ 擅长什么。
 * 一句话介绍、角色说明、模型下拉、岗位、家人可用：Core 成员接口还没有这些字段，先不放（已列入缺的接口）。
 */
export function AddMemberDialog({ open, preset, onClose, onAdded, onExplore }: { open: boolean; preset?: string; onClose: () => void; onAdded: (m: Member) => void; onExplore?: () => void }) {
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => setMsg(''), [open]);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    const name = String(d.get('name') ?? '').trim();
    if (!name) return setMsg('请填名字');
    const capabilityTags = d.getAll('tag').map(String);
    setBusy(true);
    setMsg('');
    try {
      const r = await api<{ member: Member }>('POST', '/api/members', { name, ...(capabilityTags.length ? { capabilityTags } : {}) });
      onAdded(r.member);
      onClose();
    } catch (err) {
      setMsg(errText(err, '添加失败，请稍后再试'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} title="添加成员" onClose={onClose}>
      <form className="dlg-form" onSubmit={(e) => void submit(e)} noValidate>
        {!preset && onExplore && (
          <button type="button" className="btn btn-quiet btn-link" onClick={onExplore}>
            去资源库挑一个
          </button>
        )}
        <label className="form-field">
          <span className="form-label">名字（必填）</span>
          <input name="name" required maxLength={200} defaultValue={preset ?? ''} aria-describedby="add-member-name-hint" aria-invalid={msg === '请填名字' || undefined} />
          <span id="add-member-name-hint" className="note">
            模型名，如 gpt-oss-20b
          </span>
        </label>
        <fieldset className="form-field form-fieldset">
          <legend className="form-label">擅长（可不选）</legend>
          <div className="check-grid">
            {TAGS.map(([v, label]) => (
              <label key={v} className="check-row">
                <input type="checkbox" className="check" name="tag" value={v} />
                <span>{label}</span>
              </label>
            ))}
          </div>
        </fieldset>
        {msg && (
          <p role="alert" className="note note-error">
            {msg}
          </p>
        )}
        <DialogFoot onCancel={onClose} ok="添加" busy={busy} />
      </form>
    </Dialog>
  );
}

// ---------------- 资源库（落地文档 8.1，照 sumus Agent Marketplace） ----------------

interface CapItem {
  id: string;
  name: string;
  kind: CapabilityKind;
  provider: string;
  access: CapabilityAccess;
  trialEndsAt?: string | null;
  trialDaysLeft?: number | null;
}

/** 收藏一条：链接或点子（D163 资源库原有功能，换成统一弹窗） */
function SaveDialog({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: (msg: string) => void }) {
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => setMsg(''), [open]);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    const text = String(d.get('text') ?? '').trim();
    if (!text) return setMsg('请填链接或点子');
    const isUrl = /^https?:\/\/\S+$/i.test(text);
    const title = String(d.get('title') ?? '').trim() || (isUrl ? text : text.slice(0, 40));
    const tags = String(d.get('tags') ?? '')
      .split(/[,，\s]+/)
      .filter(Boolean)
      .slice(0, 10);
    setBusy(true);
    setMsg('');
    try {
      const r = await api<{ existed: boolean }>('POST', '/api/library', isUrl ? { kind: 'link', title, url: text, tags } : { kind: 'idea', title, body: text, tags });
      onSaved(r.existed ? '这条已经收过了' : '已收进资源库');
      onClose();
    } catch (err) {
      setMsg(errText(err, '保存失败，请稍后再试'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} title="收藏一条" onClose={onClose}>
      <form className="dlg-form" onSubmit={(e) => void submit(e)} noValidate>
        <label className="form-field">
          <span className="form-label">链接或点子（必填）</span>
          <textarea name="text" rows={3} maxLength={20000} placeholder="https://…" aria-invalid={msg === '请填链接或点子' || undefined} />
        </label>
        <label className="form-field">
          <span className="form-label">标题（可不填）</span>
          <input name="title" maxLength={200} />
        </label>
        <label className="form-field">
          <span className="form-label">标签（可不填）</span>
          <input name="tags" placeholder="用空格或逗号分开" />
        </label>
        {msg && (
          <p role="alert" className="note note-error">
            {msg}
          </p>
        )}
        <DialogFoot onCancel={onClose} ok="收进来" busy={busy} />
      </form>
    </Dialog>
  );
}

export function LibraryView({ onAddMember }: { onAddMember: (preset?: string) => void }) {
  const [caps, setCaps] = useState<CapItem[] | null>(null);
  const [capErr, setCapErr] = useState('');
  const [saved, setSaved] = useState<LibraryEntry[] | null>(null);
  const [savedErr, setSavedErr] = useState('');
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<'all' | CapabilityKind | 'saved'>('all');
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  const ask = useAsk();

  useEffect(() => {
    let alive = true;
    api<{ items?: CapItem[] }>('GET', '/api/capabilities')
      .then((r) => alive && setCaps(r.items ?? []))
      .catch(() => alive && setCapErr('加载失败，请稍后再试'));
    return () => {
      alive = false;
    };
  }, []);
  const loadSaved = useCallback(() => {
    api<{ items: LibraryEntry[] }>('GET', '/api/library')
      .then((r) => setSaved(r.items))
      .catch((e) => {
        setSaved([]);
        setSavedErr(e instanceof ApiError && e.status === 404 ? '收藏还没上线' : '收藏加载失败，请稍后再试');
      });
  }, []);
  useEffect(loadSaved, [loadSaved]);

  const k = q.trim().toLowerCase();
  const shownCaps = kind === 'saved' ? [] : (caps ?? []).filter((c) => (kind === 'all' || c.kind === kind) && (!k || `${c.name} ${c.provider}`.toLowerCase().includes(k)));
  const showSaved = kind === 'all' || kind === 'saved';
  const shownSaved = (saved ?? []).filter((s) => !k || `${s.title} ${s.url ?? ''} ${s.body} ${s.tags.join(' ')}`.toLowerCase().includes(k));

  async function remove(it: LibraryEntry) {
    if (!(await ask.confirm({ title: `删除「${it.title}」？`, desc: '删了找不回来。', ok: '删除', danger: true }))) return;
    try {
      await api('DELETE', `/api/library/${it.id}`);
      setStatus(`已删除「${it.title}」`);
      loadSaved();
    } catch (e) {
      setStatus(errText(e, '删除失败，请稍后再试'));
    }
  }

  // 照 sumus Marketplace（Poke 12:19 转所有者意见 ④）：最上面搜索 + 两个动作，下面一排类型筛选，再下面是撑满宽度的结果网格；收藏是筛选里的一类
  return (
    <div className="panel panel-wide">
      {ask.node}
      <div className="toolbar">
        <SearchBox label="搜索资源" value={q} onChange={setQ} />
        <button type="button" className="btn btn-outline" onClick={() => setSaving(true)}>
          <Plus aria-hidden="true" />
          收藏一条
        </button>
        <button type="button" className="btn btn-primary" onClick={() => onAddMember()}>
          <Plus aria-hidden="true" />
          添加成员
        </button>
      </div>
      <Filter
        label="类型"
        value={kind}
        options={[
          ['all', '全部'],
          ['text', `能${KIND_LABEL.text}`],
          ['image', `能${KIND_LABEL.image}`],
          ['video', `能${KIND_LABEL.video}`],
          ['saved', '收藏'],
        ]}
        onChange={setKind}
      />
      <p role="status" className="note">
        {status}
      </p>

      {kind !== 'saved' && (
        <section className="group-block" aria-labelledby="lib-models">
          <h2 id="lib-models" className="group-title">
            可以添加的成员
          </h2>
          {capErr ? (
            <p role="alert" className="note note-error">
              {capErr}
            </p>
          ) : !caps ? (
            <p className="note">正在加载…</p>
          ) : shownCaps.length === 0 ? (
            <Empty text={k ? '没有找到。' : '这一类还没有。'} />
          ) : (
            <ul className="lib-grid" aria-label="可以添加的成员">
              {shownCaps.map((c) => {
                const trial = trialText(c);
                return (
                  <li key={c.id}>
                    <button type="button" className="lib-card" aria-label={`添加 ${c.name}，${c.provider}，${ACCESS_LABEL[c.access]}${trial ? `，${trial}` : ''}`} onClick={() => onAddMember(c.name)}>
                      <span className="lib-card-top">
                        <Avatar name={c.name} size="sm" />
                        <span className="lib-card-name">{c.name}</span>
                        {c.access === 'free' && <span className="badge badge-brand">免费</span>}
                      </span>
                      <span className="lib-card-desc">
                        {c.provider} · 能{KIND_LABEL[c.kind]}
                        {c.access !== 'free' && ` · ${trial ?? ACCESS_LABEL[c.access]}`}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      {showSaved && (
        <section className="group-block" aria-labelledby="lib-saved">
          <h2 id="lib-saved" className="group-title">
            收藏
          </h2>
          {savedErr ? (
            <p role="alert" className="note note-error">
              {savedErr}
            </p>
          ) : !saved ? (
            <p className="note">正在加载…</p>
          ) : saved.length === 0 ? (
            <Empty text="还没有收藏。" action={<button type="button" className="btn btn-outline" onClick={() => setSaving(true)}>收藏一条</button>} />
          ) : shownSaved.length === 0 ? (
            <Empty text="没有找到。" />
          ) : (
            <ul className="group" aria-label="收藏">
              {shownSaved.map((it) => (
                <li key={it.id} className="row">
                  <span className="row-text">
                    <span className="row-label">
                      {it.url ? (
                        <a href={it.url} target="_blank" rel="noreferrer noopener" className="link">
                          {it.title}
                        </a>
                      ) : (
                        it.title
                      )}
                    </span>
                    <span className="row-hint">
                      {SAVED_KIND[it.kind] ?? it.kind}
                      {it.tags.length > 0 && ` · ${it.tags.join(' ')}`}
                    </span>
                    {it.body && <span className="row-hint row-body">{it.body}</span>}
                  </span>
                  <button type="button" className="btn btn-quiet btn-icon hit" aria-label={`删除「${it.title}」`} onClick={() => void remove(it)}>
                    <Trash2 aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      <SaveDialog
        open={saving}
        onClose={() => setSaving(false)}
        onSaved={(m) => {
          setStatus(m);
          loadSaved();
        }}
      />
    </div>
  );
}

// ---------------- 工具（落地文档第 9 章，照 sumus Connectors 的行） ----------------

interface GatewayTool {
  name: string;
  description: string;
  risk: 'read' | 'write' | 'spend' | 'danger';
}
const RISK_LABEL: Record<GatewayTool['risk'], string> = { read: '只读', write: '会改东西', spend: '花钱前先问你', danger: '做之前先问你' };
const TOOL_NAME: Record<string, string> = { read_webpage: '读网页', browser_task_create: '派浏览器任务', browser_task_status: '查浏览器任务', browser_task_cancel: '取消浏览器任务' };
const usable = (s: string) => s === 'ready' || s === 'keyless';

export function ToolsView({ onGo }: { onGo: (k: 'keys') => void }) {
  const [tools, setTools] = useState<ToolItem[] | null>(null);
  const [gw, setGw] = useState<GatewayTool[] | null>(null);
  const [err, setErr] = useState('');
  const [f, setF] = useState<'all' | 'on' | 'off'>('all');
  useEffect(() => {
    let alive = true;
    api<{ tools?: ToolItem[] }>('GET', '/api/capabilities')
      .then((r) => alive && setTools(r.tools ?? []))
      .catch(() => alive && setErr('加载失败，请稍后再试'));
    api<{ tools?: GatewayTool[] }>('GET', '/api/gateway/tools')
      .then((r) => alive && setGw(r.tools ?? []))
      .catch(() => alive && setGw([]));
    return () => {
      alive = false;
    };
  }, []);
  const shown = (tools ?? []).filter((t) => f === 'all' || (f === 'on') === usable(t.status));
  const shownGw = f === 'off' ? [] : (gw ?? []);
  return (
    <div className="panel panel-wide">
      <Filter
        label="按状态筛选"
        value={f}
        options={[
          ['all', '全部'],
          ['on', '能用'],
          ['off', '还不能用'],
        ]}
        onChange={setF}
      />
      {err && (
        <p role="alert" className="note note-error">
          {err}
        </p>
      )}
      {!err && !tools && <p className="note">正在加载…</p>}
      {shownGw.length > 0 && (
        <Group title="成员直接能用">
          {shownGw.map((t) => (
            <div key={t.name} className="row">
              <span className="row-text">
                <span className="row-label">{TOOL_NAME[t.name] ?? t.name}</span>
                <span className="row-hint">{t.description}</span>
              </span>
              <span className="row-value">{RISK_LABEL[t.risk]}</span>
            </div>
          ))}
        </Group>
      )}
      {tools && shown.length === 0 && shownGw.length === 0 && (
        <Empty text={f === 'off' ? '工具都能用。' : '还没有能用的工具。'} action={f === 'off' ? undefined : <button type="button" className="btn btn-outline" onClick={() => onGo('keys')}>去 API</button>} />
      )}
      {groupTools(shown).map(([g, rows]) => (
        <Group key={g} title={g}>
          {rows.map((t) => (
            <div key={t.id} className="row">
              <span className="row-text">
                <span className="row-label">{t.name}</span>
                <span className="row-hint">
                  {ACCESS_LABEL[t.access]} · {quotaText(t.quota)}
                </span>
                {t.note && <span className="row-hint">{t.note}</span>}
              </span>
              <span className="row-value">{STATUS_LABEL[t.status] ?? t.status}</span>
            </div>
          ))}
        </Group>
      ))}
    </div>
  );
}

// ---------------- API（落地文档第 10 章：Key、模型、用量三组圆角卡片） ----------------

interface KeyItem {
  id: string;
  name: string;
  sourceUrl: string;
  last4: string;
  status: string;
  updatedAt: string;
}
const KEY_STATUS: Record<string, string> = { active: '正常', sync_failed: '没连上模型' };

function KeyDialog({ open, replace, onClose, onSaved }: { open: boolean; replace?: KeyItem; onClose: () => void; onSaved: (msg: string) => void }) {
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<{ challenge: Challenge; body: Record<string, string> } | null>(null);
  useEffect(() => {
    setMsg('');
    setConfirm(null);
  }, [open]);
  async function send(body: Record<string, string>, confirmToken?: string) {
    const b = confirmToken ? { ...body, confirmToken } : body;
    if (replace) await api('PATCH', `/api/keys/${replace.id}`, b);
    else await api('POST', '/api/keys', b);
    onSaved(replace ? `已替换「${replace.name}」的 Key` : '已保存');
    onClose();
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const d = new FormData(form);
    const body: Record<string, string> = {};
    for (const k of replace ? ['apiKey'] : ['name', 'sourceUrl', 'apiKey', 'model', 'apiBase']) {
      const v = String(d.get(k) ?? '').trim();
      if (v) body[k] = v;
    }
    const need = replace ? ['apiKey'] : ['name', 'sourceUrl', 'apiKey', 'model'];
    if (need.some((k) => !body[k])) return setMsg('有必填的没填');
    setBusy(true);
    setMsg('');
    try {
      await send(body);
      form.reset();
    } catch (err) {
      if (err instanceof ApiError && err.status === 428 && err.confirm) setConfirm({ challenge: err.confirm, body });
      else setMsg(errText(err, '保存失败，请稍后再试'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} title={replace ? `替换「${replace.name}」的 Key` : '添加 Key'} onClose={onClose}>
      {confirm ? (
        <ConfirmCard challenge={confirm.challenge} onCancel={() => setConfirm(null)} onToken={(t) => send(confirm.body, t)} />
      ) : (
        <form className="dlg-form" onSubmit={(e) => void submit(e)} noValidate autoComplete="off">
          {!replace && (
            <>
              <label className="form-field">
                <span className="form-label">名称（必填）</span>
                <input name="name" maxLength={64} placeholder="如 我的 OpenRouter" />
              </label>
              <label className="form-field">
                <span className="form-label">在哪儿申请的（网址，必填）</span>
                <input name="sourceUrl" type="url" placeholder="https://…" />
              </label>
            </>
          )}
          <label className="form-field">
            <span className="form-label">{replace ? '新的 Key（必填）' : 'Key（必填）'}</span>
            <input name="apiKey" type="password" autoComplete="new-password" />
          </label>
          {!replace && (
            <>
              <label className="form-field">
                <span className="form-label">模型（必填）</span>
                <input name="model" placeholder="如 openai/gpt-4o" />
              </label>
              <label className="form-field">
                <span className="form-label">接口地址（可不填）</span>
                <input name="apiBase" type="url" placeholder="https://…" />
              </label>
            </>
          )}
          {msg && (
            <p role="alert" className="note note-error">
              {msg}
            </p>
          )}
          <DialogFoot onCancel={onClose} ok={replace ? '替换' : '保存'} busy={busy} />
        </form>
      )}
    </Dialog>
  );
}

function memberState(m: Member): string {
  if (!m.enabled) return '已停用';
  if (m.status === 'candidate') return '候选';
  return (m.online ?? m.status === 'active') ? '在线' : '离线';
}

export function ApiView({ members }: { members: Member[] }) {
  const [keys, setKeys] = useState<KeyItem[] | null>(null);
  const [keyErr, setKeyErr] = useState('');
  const [status, setStatus] = useState('');
  const [dialog, setDialog] = useState<{ replace?: KeyItem } | null>(null);
  const [pending, setPending] = useState<{ key: KeyItem; challenge: Challenge } | null>(null);
  const { rows } = useUsage(120_000);
  const ask = useAsk();
  const load = useCallback(() => {
    api<{ keys: KeyItem[] }>('GET', '/api/keys')
      .then((r) => setKeys(r.keys))
      .catch((e) => setKeyErr(e instanceof ApiError && e.status === 403 ? '这个账号不能看 Key' : '加载失败，请稍后再试'));
  }, []);
  useEffect(load, [load]);

  async function remove(k: KeyItem, confirmToken?: string) {
    if (!confirmToken && !(await ask.confirm({ title: `删除 Key「${k.name}」？`, desc: '用这把 Key 的成员会答不出来。', ok: '删除', danger: true }))) return;
    setStatus('');
    try {
      await api('DELETE', `/api/keys/${k.id}`, confirmToken ? { confirmToken } : undefined);
      setPending(null);
      setStatus(`已删除「${k.name}」`);
      load();
    } catch (e) {
      if (e instanceof ApiError && e.status === 428 && e.confirm) setPending({ key: k, challenge: e.confirm });
      else if (confirmToken) throw e;
      else setStatus(errText(e, '删除失败，请稍后再试'));
    }
  }

  const total = rows?.reduce((s, r) => s + r.today.requests, 0) ?? 0;
  return (
    <div className="panel">
      {ask.node}
      <p role="status" className="note">
        {status}
      </p>
      <section className="group-block" aria-labelledby="api-keys">
        <div className="group-head">
          <h2 id="api-keys" className="group-title">
            Key
          </h2>
          {(keys?.length ?? 0) > 0 && (
            <button type="button" className="btn btn-outline" onClick={() => setDialog({})}>
              <Plus aria-hidden="true" />
              添加 Key
            </button>
          )}
        </div>
        {keyErr ? (
          <p role="alert" className="note note-error">
            {keyErr}
          </p>
        ) : !keys ? (
          <p className="note">正在加载…</p>
        ) : keys.length === 0 ? (
          <Empty text="还没有 Key。" action={<button type="button" className="btn btn-outline" onClick={() => setDialog({})}>添加 Key</button>} />
        ) : (
          <ul className="group" aria-label="Key">
            {keys.map((k) => (
              <li key={k.id}>
                <div className="row row-field">
                  <span className="row-text">
                    <span className="row-label">{k.name}</span>
                    <span className="row-hint">
                      {KEY_STATUS[k.status] ?? k.status} · 末尾 {k.last4}
                    </span>
                  </span>
                  <span className="row-actions">
                    <button type="button" className="btn btn-outline" aria-label={`替换「${k.name}」的 Key`} onClick={() => setDialog({ replace: k })}>
                      替换
                    </button>
                    <button type="button" className="btn btn-quiet btn-icon hit" aria-label={`删除 Key「${k.name}」`} onClick={() => void remove(k)}>
                      <Trash2 aria-hidden="true" />
                    </button>
                  </span>
                </div>
                {pending?.key.id === k.id && (
                  <div className="row row-stack">
                    <ConfirmCard challenge={pending.challenge} onCancel={() => setPending(null)} onToken={(t) => remove(pending.key, t)} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <Group title="模型">
        {members.length === 0 ? (
          <p className="row muted">还没有成员。</p>
        ) : (
          members.map((m) => (
            <div key={m.id} className="row">
              <Avatar name={m.name} size="sm" off={memberState(m) !== '在线'} />
              <span className="row-text">
                <span className="row-label">{m.name}</span>
              </span>
              <span className="row-value">{memberState(m)}</span>
            </div>
          ))
        )}
      </Group>

      <section className="group-block" id="api-usage" aria-labelledby="api-usage-t">
        <h2 id="api-usage-t" className="group-title">
          今天的用量
        </h2>
        <div className="group">
          {!rows ? (
            <p className="row muted">用量查不到。</p>
          ) : (
            <>
              <div className="row">
                <span className="row-text">
                  <span className="row-label">一共</span>
                </span>
                <span className="row-value">{total} 次</span>
              </div>
              {rows.map((r) => (
                <UsageRowLine key={r.memberId} row={r} />
              ))}
            </>
          )}
        </div>
      </section>
      <KeyDialog
        open={!!dialog}
        {...(dialog?.replace ? { replace: dialog.replace } : {})}
        onClose={() => setDialog(null)}
        onSaved={(m) => {
          setStatus(m);
          load();
        }}
      />
    </div>
  );
}

function UsageRowLine({ row }: { row: UsageRow }) {
  const q = quotaState(row);
  return (
    <div className="row">
      <QuotaRing used={row.quota.used} limit={row.quota.limit} size={20} />
      <span className="row-text">
        <span className="row-label">{row.name}</span>
        <span className="row-hint">
          今天 {row.today.requests} 次{row.today.errors ? `，出错 ${row.today.errors} 次` : ''}
        </span>
      </span>
      <span className="row-value">{q.label}</span>
    </div>
  );
}

// ---------------- 设置：个人资料、安全补充、通用、家人与邀请（落地文档 11.1 11.3 11.4 11.5） ----------------

interface Me {
  kind: string;
  user?: { id: string; email: string; displayName?: string; role: string; status?: string };
}
const ROLE_LABEL: Record<string, string> = { admin: '管理员', user: '家人', owner: '所有者' };

function useMe(): Me | null {
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => {
    let alive = true;
    api<Me>('GET', '/api/auth/me')
      .then((r) => alive && setMe(r))
      .catch(() => {
        const u = currentUser();
        if (alive) setMe(u ? { kind: 'user', user: { id: '', email: u.email, displayName: u.displayName, role: u.role } } : { kind: 'unknown' });
      });
    return () => {
      alive = false;
    };
  }, []);
  return me;
}

/** 个人资料：头像（名字首字）、名字、登录账号、身份。改名字 Core 还没有接口，先只读、不放保存键。 */
export function ProfileSection() {
  const me = useMe();
  if (!me) return <p className="note">正在加载…</p>;
  const u = me.user;
  const name = u?.displayName || (u ? u.email.split('@')[0]! : '所有者');
  return (
    <>
      <div className="profile">
        <Avatar name={name} kind="user" size="lg" />
        <div>
          <p className="profile-name">{name}</p>
          <p className="muted">{u ? (ROLE_LABEL[u.role] ?? u.role) : '所有者'}</p>
        </div>
      </div>
      <Group>
        <Field label="名字">
          <span>{name}</span>
        </Field>
        <Field label="登录账号">
          <span className="row-break">{u?.email ?? '用所有者密钥登录'}</span>
        </Field>
      </Group>
    </>
  );
}

/** 改密码（POST /api/auth/password）：只有账号登录时有；所有者密钥登录没有密码可改 */
export function PasswordRow() {
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState('');
  const [done, setDone] = useState('');
  const [busy, setBusy] = useState(false);
  if (!currentUser()) return null;
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    const currentPassword = String(d.get('current') ?? '');
    const newPassword = String(d.get('next') ?? '');
    if (!currentPassword || !newPassword) return setMsg('两栏都要填');
    if (newPassword.length < 10) return setMsg('新密码至少 10 位');
    setBusy(true);
    setMsg('');
    try {
      await api('POST', '/api/auth/password', { currentPassword, newPassword });
      setOpen(false);
      setDone('密码已改好');
    } catch (err) {
      setMsg(errText(err, '没改成，请稍后再试'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Field label="密码" {...(done ? { hint: done } : {})}>
        <button type="button" className="btn btn-outline" onClick={() => { setMsg(''); setOpen(true); }}>
          改密码
        </button>
      </Field>
      <Dialog open={open} title="改密码" onClose={() => setOpen(false)}>
        <form className="dlg-form" onSubmit={(e) => void submit(e)} noValidate>
          <label className="form-field">
            <span className="form-label">现在的密码</span>
            <input name="current" type="password" autoComplete="current-password" />
          </label>
          <label className="form-field">
            <span className="form-label">新密码</span>
            <input name="next" type="password" autoComplete="new-password" aria-describedby="pw-rule" />
            <span id="pw-rule" className="note">
              至少 10 位
            </span>
          </label>
          {msg && (
            <p role="alert" className="note note-error">
              {msg}
            </p>
          )}
          <DialogFoot onCancel={() => setOpen(false)} ok="改好了" busy={busy} />
        </form>
      </Dialog>
    </>
  );
}

/** 登录：退出所有设备（POST /api/auth/logout-all，包括这台）+ 退出登录。设备列表要 Core 会话列表接口，没有之前不显示。 */
export function SignOutGroup() {
  const ask = useAsk();
  const [msg, setMsg] = useState('');
  async function all() {
    if (!(await ask.confirm({ title: '退出所有设备？', desc: '包括这台。手机、别的电脑上的 Aroomo 都要重新登录。', ok: '全部退出', danger: true }))) return;
    try {
      await api('POST', '/api/auth/logout-all');
      await logout().catch(() => undefined);
    } catch (e) {
      setMsg(errText(e));
    }
  }
  return (
    <Group title="登录">
      {ask.node}
      {currentUser() && (
        <Field label="退出所有设备">
          <button type="button" className="btn btn-outline" onClick={() => void all()}>
            全部退出
          </button>
        </Field>
      )}
      <Field label="退出这台设备">
        <button type="button" className="btn btn-outline" onClick={() => void logout()}>
          退出登录
        </button>
      </Field>
      {msg && (
        <p role="alert" className="row-status">
          {msg}
        </p>
      )}
    </Group>
  );
}

interface UserRow {
  id: string;
  email: string;
  displayName?: string;
  role: string;
  status?: string;
  createdAt?: string;
}
function useUsers(): { users: UserRow[] | null; err: string } {
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let alive = true;
    api<{ users: UserRow[] }>('GET', '/api/users')
      .then((r) => alive && setUsers(r.users))
      .catch((e) => alive && setErr(e instanceof ApiError && e.status === 403 ? '这个账号不能看家人列表' : '家人列表加载失败'));
    return () => {
      alive = false;
    };
  }, []);
  return { users, err };
}

/** 通用（只有所有者）：空间名、身份、人数、总额度卡（圆环 + 一个词 + 看各成员用量） */
export function GeneralSection({ members, onUsage }: { members: Member[]; onUsage: () => void }) {
  const { users } = useUsers();
  const { rows } = useUsage(120_000);
  const worst = worstRow(rows);
  const q = quotaState(worst ?? undefined);
  const family = users?.filter((u) => u.role === 'user').length;
  const me = currentUser();
  return (
    <>
      <Group>
        <Field label="空间">
          <span>Aroomo</span>
        </Field>
        <Field label="你的身份">
          <span>{me ? (ROLE_LABEL[me.role] ?? me.role) : '所有者'}</span>
        </Field>
        <Field label="家人">
          <span>{family == null ? '—' : `${family} 位`}</span>
        </Field>
        <Field label="AI 成员">
          <span>{members.length} 位</span>
        </Field>
      </Group>
      <Group title="总额度">
        <div className="row">
          <QuotaRing used={worst?.quota.used} limit={worst?.quota.limit} size={28} />
          <span className="row-text">
            <span className="row-label">{rows ? q.label : '额度查不到'}</span>
            {rows && <span className="row-hint">今天一共 {rows.reduce((s, r) => s + r.today.requests, 0)} 次</span>}
          </span>
          <button type="button" className="btn btn-outline" onClick={onUsage}>
            看各成员用量 ↗
          </button>
        </div>
      </Group>
    </>
  );
}

/**
 * 家人与邀请（只有所有者）：家人 / 身份 / 状态。
 * 「添加家人」按负责人裁决：多用户隔离修好、两个账号测过之前不开放，所以先不放按钮；本期额度要 Core 按账号统计用量，暂不显示。
 */
export function FamilySection() {
  const { users, err } = useUsers();
  const list = useMemo(() => (users ?? []).filter((u) => u.role !== 'owner'), [users]);
  if (err) return <p role="alert" className="note note-error">{err}</p>;
  if (!users) return <p className="note">正在加载…</p>;
  if (list.length === 0) return <Empty text="还没有家人。" />;
  return (
    <ul className="group" aria-label="家人">
      {list.map((u) => (
        <li key={u.id} className="row">
          <Avatar name={u.displayName || u.email} kind="user" size="sm" />
          <span className="row-text">
            <span className="row-label">{u.displayName || u.email.split('@')[0]}</span>
            <span className="row-hint row-break">{u.email}</span>
          </span>
          <span className="row-value">
            {ROLE_LABEL[u.role] ?? u.role}
            {u.status === 'disabled' ? ' · 已停用' : ''}
          </span>
        </li>
      ))}
    </ul>
  );
}

