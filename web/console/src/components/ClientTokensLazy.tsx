/**
 * 连接密码（外部接入）点开才下载（#281：对话页包 ≤150 KB gz）。设置 › 外部接入、资源库 › 外部接入、旧设置页共用。
 * 下载时一句静态文字，不转圈、无动画。
 */
import { lazy, Suspense } from 'react';

const ClientTokens = lazy(() => import('./ClientTokens').then((m) => ({ default: m.ClientTokens })));

export function ClientTokensLazy() {
  return (
    <Suspense fallback={<p role="status" className="note panel-loading">正在加载…</p>}>
      <ClientTokens />
    </Suspense>
  );
}
