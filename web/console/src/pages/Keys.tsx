/** Key 与接入：列表与新增（/api/keys）。只显示末 4 位，Key 原文提交后不再回显。删除/换 Key 需要两步确认卡，待确认卡组件完成后接入。 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { ApiError, api } from '@/lib/api';

interface KeyItem {
  id: string;
  name: string;
  sourceUrl: string;
  last4: string;
  status: string;
  updatedAt: string;
}

const field = 'min-h-11 w-full rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3';

export function Keys() {
  const [keys, setKeys] = useState<KeyItem[] | null>(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<{ keys: KeyItem[] }>('GET', '/api/keys')
      .then((r) => setKeys(r.keys))
      .catch((e) => setMsg(e instanceof ApiError && e.status === 403 ? '这个账号还不能查看 Key' : '加载失败，请稍后再试'));
  }, []);
  useEffect(load, [load]);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const d = new FormData(form);
    const body: Record<string, string> = {};
    for (const k of ['name', 'sourceUrl', 'apiKey', 'model', 'apiBase']) {
      const v = String(d.get(k) ?? '').trim();
      if (v) body[k] = v;
    }
    setBusy(true);
    setMsg('');
    try {
      await api('POST', '/api/keys', body);
      form.reset();
      setMsg('已保存');
      load();
    } catch (err) {
      setMsg(err instanceof ApiError ? err.message : '保存失败，请稍后再试');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">Key 与接入</h1>
      {msg && <p role="status">{msg}</p>}
      <ul className="flex flex-col gap-2">
        {keys === null && <li className="text-[var(--muted)]">正在加载…</li>}
        {keys?.length === 0 && <li className="text-[var(--muted)]">还没有 Key</li>}
        {keys?.map((k) => (
          <li key={k.id} className="rounded-xl border border-[var(--border)] p-3">
            <div className="font-medium">{k.name}</div>
            <div className="text-[var(--muted)]">
              ••••{k.last4} · {k.status}
            </div>
          </li>
        ))}
      </ul>
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
        <h2 className="font-medium">新增 Key</h2>
        <input name="name" required maxLength={64} placeholder="名称" aria-label="名称" className={field} />
        <input name="sourceUrl" required type="url" placeholder="获取网址" aria-label="获取网址" className={field} />
        <input name="apiKey" required type="password" autoComplete="off" placeholder="Key" aria-label="Key" className={field} />
        <input name="model" required placeholder="模型，如 openai/gpt-4o" aria-label="模型" className={field} />
        <input name="apiBase" type="url" placeholder="接口地址（可选）" aria-label="接口地址" className={field} />
        <Button type="submit" disabled={busy} className="min-h-11">
          保存
        </Button>
      </form>
    </div>
  );
}
