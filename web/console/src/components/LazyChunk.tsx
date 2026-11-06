/**
 * 点开才下载的部分（#281）外面套这一层：下载时一句静态「正在加载…」（不转圈、无动画）；
 * 下载失败（多半是重新部署后旧分包没了、页面还是旧的）只在这里说一句 + 「刷新」，不让整页白屏（负责人 #300 必改）。
 */
import { Component, Suspense, type ReactNode } from 'react';

class ChunkBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" className="note note-error">
        <p>没加载出来。刷新一下页面再点。</p>
        <button type="button" className="btn btn-outline" onClick={() => window.location.reload()}>
          刷新
        </button>
      </div>
    );
  }
}

export function LazyChunk({ children }: { children: ReactNode }) {
  return (
    <ChunkBoundary>
      <Suspense fallback={<p role="status" className="note panel-loading">正在加载…</p>}>{children}</Suspense>
    </ChunkBoundary>
  );
}
