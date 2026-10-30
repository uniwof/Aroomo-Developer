/** 资源库（D163）：丢链接/点子、关键词搜索、删除。接 /api/library（后台线 #114）。 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { ApiError, api } from '@/lib/api';

export const KIND_LABEL: Record<string, string> = {
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

const field = 'min-h-11 w-full rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3';

export function Library() {
  const [items, setItems] = useState<LibraryEntry[] | null>(null);
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const load = useCallback(() => {
    const p = new URLSearchParams();
    if (q.trim()) p.set('q', q.trim());
    if (kind) p.set('kind', kind);
    const qs = p.toString();
    api<{ items: LibraryEntry[] }>('GET', '/api/library' + (qs ? `?${qs}` : ''))
      .then((r) => setItems(r.items))
      .catch((e) => {
        setItems([]);
        setMsg(e instanceof ApiError && e.status === 404 ? '资源库还没上线，稍后再来' : '加载失败，请稍后再试');
      });
  }, [q, kind]);
  useEffect(load, [load]);

  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const d = new FormData(form);
    const text = String(d.get('text') ?? '').trim();
    if (!text) return;
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
      form.reset();
      setMsg(r.existed ? '这条已经收过了' : '已收进资源库');
      load();
    } catch (err) {
      setMsg(err instanceof ApiError ? err.message : '保存失败，请稍后再试');
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (confirmId !== id) {
      setConfirmId(id);
      return;
    }
    setConfirmId(null);
    try {
      await api('DELETE', `/api/library/${id}`);
      setMsg('已删除');
      load();
    } catch (err) {
      setMsg(err instanceof ApiError ? err.message : '删除失败');
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">资源库</h1>
      <form onSubmit={(e) => void add(e)} className="flex flex-col gap-3" aria-label="收进资源库">
        <textarea name="text" required rows={2} maxLength={20000} placeholder="粘贴链接，或写一个点子" aria-label="链接或点子" className={field + ' py-2'} />
        <input name="title" maxLength={200} placeholder="标题（可不填）" aria-label="标题" className={field} />
        <input name="tags" placeholder="标签，用空格或逗号分开（可不填）" aria-label="标签" className={field} />
        <Button type="submit" disabled={busy} className="min-h-11">
          收进来
        </Button>
      </form>
      {msg && <p role="status">{msg}</p>}
      <div className="flex flex-col gap-2">
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索标题、标签、链接、正文" aria-label="搜索资源库" className={field} />
        <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="按类型筛选" className={field}>
          <option value="">全部类型</option>
          {Object.entries(KIND_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </div>
      <ul className="flex flex-col gap-2">
        {items === null && <li className="text-[var(--muted)]">正在加载…</li>}
        {items?.length === 0 && <li className="text-[var(--muted)]">{q || kind ? '没有找到' : '还没有内容'}</li>}
        {items?.map((it) => (
          <li key={it.id} className="rounded-xl border border-[var(--border)] p-3">
            <div className="font-medium">
              {it.url ? (
                <a href={it.url} target="_blank" rel="noreferrer" className="underline">
                  {it.title}
                </a>
              ) : (
                it.title
              )}
            </div>
            <div className="text-[var(--muted)]">
              {KIND_LABEL[it.kind] ?? it.kind}
              {it.tags.length > 0 && ` · ${it.tags.join(' ')}`}
            </div>
            {it.body && <p className="mt-1 break-words">{it.body}</p>}
            <Button type="button" variant="outline" className="mt-2 min-h-11" onClick={() => void remove(it.id)} aria-label={confirmId === it.id ? `确认删除 ${it.title}` : `删除 ${it.title}`}>
              {confirmId === it.id ? '再点一次确认删除' : '删除'}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
