/**
 * 连接密码（M2 验收第①步）：给外部客户端（LobeHub、Claude、Cursor 等）新建连接密码、看列表、停用。
 * 接 POST/GET /api/clients、DELETE /api/clients/:id；后端按 scopeOf 隔离，每个账号只看到、只能停用自己的连接密码。
 * 连接密码明文只在新建成功后显示一次（只在本组件内存里，关掉就清掉；不写 storage、不打日志），列表里永远没有连接密码。
 */
import { useCallback, useEffect, useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ApiError, api } from '@/lib/api';

export interface ClientInfo {
  id: string;
  name: string;
  scopes: string[];
  rateLimitPerMin: number;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export const SCOPE_LABEL: Record<string, string> = {
  'tools:list': '查看工具列表',
  'tools:call': '调用工具',
  'bookmarks:read': '读书签',
  'library:read': '读资源库',
  'library:write': '写资源库',
  'memory:read': '读记忆',
  'brief:read': '读简报',
  'models:chat': '用模型对话',
  'tasks:pull': '领执行任务',
  'tasks:secret': '取任务凭据',
  'tasks:create': '新建任务',
  'tasks:read': '查看任务',
};

const DAYS = [
  { value: '', label: '不过期' },
  { value: '30', label: '30 天' },
  { value: '90', label: '90 天' },
  { value: '365', label: '1 年' },
];

function day(iso: string | null, empty: string): string {
  if (!iso) return empty;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('zh-CN', { hour12: false });
}

function errText(e: unknown): string {
  if (e instanceof ApiError && e.status === 403) return '这个账号不能管理连接密码';
  return e instanceof ApiError ? e.message : '出错了，请稍后再试';
}

export function ClientTokens() {
  const uid = useId();
  const [clients, setClients] = useState<ClientInfo[] | null>(null);
  const [available, setAvailable] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>([]);
  const [days, setDays] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [created, setCreated] = useState<{ name: string; token: string } | null>(null);
  const [confirm, setConfirm] = useState<ClientInfo | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<{ clients: ClientInfo[]; availableScopes: string[] }>('GET', '/api/clients');
      setClients(Array.isArray(r?.clients) ? r.clients : []);
      setAvailable(Array.isArray(r?.availableScopes) ? r.availableScopes : []);
    } catch (e) {
      setClients((v) => v ?? []);
      setMsg(errText(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  function toggle(s: string) {
    setScopes((v) => (v.includes(s) ? v.filter((x) => x !== s) : [...v, s]));
  }

  async function create() {
    setMsg('');
    if (!name.trim()) return setMsg('请先填一个名字，比如 我的 Cursor');
    if (scopes.length === 0) return setMsg('至少勾选一个范围');
    setBusy(true);
    try {
      const body: { name: string; scopes: string[]; expiresInDays?: number } = { name: name.trim(), scopes };
      if (days) body.expiresInDays = Number(days);
      const r = await api<{ token: string; client: ClientInfo }>('POST', '/api/clients', body);
      setCreated({ name: r.client.name, token: r.token });
      setName('');
      setScopes([]);
      setDays('');
      setMsg(`已新建「${r.client.name}」。连接密码只显示这一次，请现在复制。`);
      await load();
    } catch (e) {
      setMsg(errText(e));
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.token);
      setMsg('连接密码已复制。粘贴到那个软件里后，就可以关掉这张卡片了。');
    } catch {
      setMsg('这个浏览器不让自动复制，请长按连接密码文字手动复制。');
    }
  }

  async function revoke() {
    if (!confirm) return;
    const c = confirm;
    setConfirm(null);
    setMsg('');
    try {
      await api('DELETE', `/api/clients/${encodeURIComponent(c.id)}`);
      setMsg(`已停用「${c.name}」，它马上不能再连 Aroomo`);
      await load();
    } catch (e) {
      setMsg(errText(e));
    }
  }

  const active = (clients ?? []).filter((c) => !c.revokedAt);
  const inputCls = '';

  return (
    <div className="space-y-4 py-3">
      <div>
        <div className="font-medium">连接密码</div>
        <div className="text-[var(--muted)]">给别的 AI 软件连 Aroomo 用。只给它需要的范围；不用了就停用。</div>
      </div>

      <form
        className="space-y-3"
        aria-label="新建连接密码"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <label className="flex flex-col gap-1">
          <span>名字</span>
          <input value={name} maxLength={64} onChange={(e) => setName(e.target.value)} placeholder="如 我的 Cursor" className={inputCls} />
        </label>
        <fieldset className="space-y-1">
          <legend>允许它做什么（默认都不勾）</legend>
          <div className="flex flex-wrap gap-x-6 gap-y-1">
            {available.map((s) => (
              <label key={s} htmlFor={`${uid}-${s}`} className="flex min-h-12 items-center gap-2">
                <input id={`${uid}-${s}`} type="checkbox" className="size-5" checked={scopes.includes(s)} onChange={() => toggle(s)} />
                <span>
                  {/* 自审 B5：只显示大白话，不显示 bookmarks:read 这类代码 */}
                  {SCOPE_LABEL[s] ?? s}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <label className="flex flex-col gap-1">
          <span>有效期</span>
          <select value={days} onChange={(e) => setDays(e.target.value)} className={inputCls}>
            {DAYS.map((d) => (
              <option key={d.value} value={d.value}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" disabled={busy}>
          {busy ? '正在新建…' : '新建连接密码'}
        </Button>
      </form>

      <p role="status" aria-live="polite" className="text-[var(--muted)]">
        {msg}
      </p>

      {created && (
        <div role="region" aria-label="新连接密码（只显示一次）" className="card card-strong space-y-2">
          <div className="font-semibold">「{created.name}」的连接密码</div>
          <p>关掉就再也看不到了，请现在复制，粘贴到那个软件里。</p>
          <code aria-label="连接密码" className="row-pre block break-all">
            {created.token}
          </code>
          <div className="flex flex-wrap gap-4">
            <Button type="button" onClick={() => void copy()}>
              复制连接密码
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setCreated(null);
                setMsg('连接密码卡片已关闭。');
              }}
            >
              我已复制，关掉
            </Button>
          </div>
        </div>
      )}

      {confirm && (
        <div role="alertdialog" aria-labelledby={`${uid}-confirm`} className="card card-strong">
          <h3 id={`${uid}-confirm`} className="group-title">
            停用「{confirm.name}」？
          </h3>
          <p className="mt-1 text-[var(--muted)]">停用后这个软件马上不能再连 Aroomo，不能恢复；想再用要重新新建连接密码。</p>
          <div className="mt-3 flex gap-4">
            <Button type="button" onClick={() => void revoke()}>
              确认停用
            </Button>
            <Button type="button" variant="outline" onClick={() => setConfirm(null)}>
              先不了
            </Button>
          </div>
        </div>
      )}

      <section aria-label="我的连接密码" className="space-y-2">
        {clients === null && <p className="text-[var(--muted)]">正在加载…</p>}
        {clients !== null && active.length === 0 && <p className="text-[var(--muted)]">还没有可用的连接密码。</p>}
        <ul className="flex flex-col gap-2" aria-label="连接密码列表">
          {active.map((c) => (
            <li key={c.id} className="card">
              <div className="font-medium break-all">
                {c.name}
                {c.expiresAt && new Date(c.expiresAt).getTime() <= Date.now() ? '（已过期）' : ''}
              </div>
              <div className="break-all">范围：{c.scopes.join('、')}</div>
              <div className="text-[var(--muted)]">
                到期：{day(c.expiresAt, '不过期')} · 最近使用：{day(c.lastUsedAt, '还没用过')}
              </div>
              <Button type="button" variant="outline" className="mt-2" aria-label={`停用 ${c.name}`} onClick={() => setConfirm(c)}>
                停用
              </Button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
