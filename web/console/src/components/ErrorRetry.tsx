/**
 * 读取失败时的一句话 + 「重试」（Poke 行为规范切片 14 / 验收清单 3：错误要有恢复动作）。
 * 只给读数据（GET）用：重试只是再读一次，不会重复改东西。用全站已有的 .note-error / .btn，不另起样式。
 * what：读屏听到的「重新加载什么」（一页上可能有两个重试，要分得清）。
 */
export function ErrorRetry({ text, what, onRetry }: { text: string; what: string; onRetry: () => void }) {
  return (
    <div role="alert" className="note note-error">
      <p>{text}</p>
      <button type="button" className="btn btn-outline" aria-label={`重试，重新加载${what}`} onClick={onRetry}>
        重试
      </button>
    </div>
  );
}
