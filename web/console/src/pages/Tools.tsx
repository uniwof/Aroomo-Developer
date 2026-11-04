/** 工具页：算力、沙盒、云手机等（取自 /api/capabilities 的 tools，按分组显示；额度查不到显示「未知」）。 */
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { ACCESS_LABEL, quotaText, type CapabilityAccess } from '@/lib/capabilities';

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
  ready: '可用',
  unverified: '未验证',
  failed: '验证失败',
  missing: '未填 Key',
  keyless: '免 Key',
};

export function groupTools(tools: ToolItem[]): [string, ToolItem[]][] {
  const m = new Map<string, ToolItem[]>();
  for (const t of tools) m.set(t.group, [...(m.get(t.group) ?? []), t]);
  return [...m.entries()];
}

export function Tools() {
  const [tools, setTools] = useState<ToolItem[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    api<{ tools?: ToolItem[] }>('GET', '/api/capabilities')
      .then((r) => alive && setTools(r.tools ?? []))
      .catch(() => alive && setError('加载失败，请稍后再试'));
    return () => {
      alive = false;
    };
  }, []);

  // 分组列表（#250 重设计）：一组一个小标题；每行名称 + 一行状态；权限写成行尾文字，不用胶囊和空圆环
  return (
    <section className="page" aria-labelledby="tools-title">
      <h1 id="tools-title" className="page-title">
        工具
      </h1>
      {error && <p role="alert">{error}</p>}
      {!error && !tools && <p className="muted">正在加载…</p>}
      {tools?.length === 0 && <p className="muted">还没有工具。</p>}
      {tools &&
        groupTools(tools).map(([g, rows]) => (
          <section key={g} aria-label={g} className="group-block">
            <h2 className="group-title">
              {g}（{rows.length}）
            </h2>
            <ul className="group">
              {rows.map((t) => (
                <li key={t.id} className="row">
                  <div className="row-text">
                    <div className="row-label">{t.name}</div>
                    <div className="row-hint">
                      {STATUS_LABEL[t.status] ?? t.status} · {quotaText(t.quota)}
                    </div>
                    {t.note && <div className="row-hint">{t.note}</div>}
                  </div>
                  <span className="row-value">{ACCESS_LABEL[t.access]}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
    </section>
  );
}
