/**
 * 错误边界（Poke 行为规范切片 7 / 审计 G1）：面板渲染出错时不再整页白屏，只在出错的地方说一句话 + 「回到对话」。
 * 只用全站已有的空状态零件（.empty / .btn），不另起样式；读屏用 role="alert" 播报。
 */
import { Component, type ReactNode } from 'react';

export class ErrorBoundary extends Component<{ children: ReactNode; onReset: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="empty" role="alert">
        <p className="empty-text">这一页出错了，没打开。别的地方不受影响。</p>
        <button
          type="button"
          className="btn btn-outline"
          onClick={() => {
            this.setState({ failed: false });
            this.props.onReset();
          }}
        >
          回到对话
        </button>
      </div>
    );
  }
}
