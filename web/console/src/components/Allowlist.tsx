/** 执行员站点白名单：每行一个域名（或 android-app://包名）。空 = 不限制。接 /api/executor-allowlist。 */
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ApiError, api } from '@/lib/api';

export function Allowlist() {
  const [text, setText] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    api<{ sites?: string[] }>('GET', '/api/executor-allowlist')
      .then((r) => setText((r?.sites ?? []).join('\n')))
      .catch(() => setMsg('白名单暂时读不到'))
      .finally(() => setLoaded(true));
  }, []);

  async function save() {
    setMsg('');
    const sites = Array.from(new Set(text.split(/[\n,，\s]+/).map((s) => s.trim()).filter(Boolean)));
    try {
      const r = await api<{ sites: string[] }>('PUT', '/api/executor-allowlist', { sites });
      setText(r.sites.join('\n'));
      setMsg(r.sites.length === 0 ? '已保存：现在不限制站点' : `已保存：只允许这 ${r.sites.length} 个站点`);
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : '保存失败，请稍后再试');
    }
  }

  return (
    <section aria-labelledby="exec-allow" className="flex flex-col gap-2">
      <h2 id="exec-allow" className="text-[16px] font-semibold">
        允许的站点
      </h2>
      <p className="text-[var(--muted)]">每行一个域名。留空 = 不限制；填了以后，派任务给不在名单里的站点会被拒绝。</p>
      <textarea
        aria-label="站点列表"
        value={text}
        disabled={!loaded}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        className="min-h-11 w-full rounded-xl border border-[var(--border)] bg-transparent p-3 text-[14px]"
      />
      <div>
        <Button type="button" className="min-h-11" onClick={() => void save()} disabled={!loaded}>
          保存站点
        </Button>
      </div>
      {msg && <p role="status">{msg}</p>}
    </section>
  );
}
