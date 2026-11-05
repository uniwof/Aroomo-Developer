/**
 * X-11 快速回复（功能补充 v1，开关 FLAGS.quickReplies，默认关）。
 * 成员反问时给 2–3 个现成答案 + 固定最后一个「我自己写…」。点了立刻发出，所以按钮上写的就是会发出去的原话。
 * 发出一个以后整组换成一行静态文字「已回复：…」，不会重复发。外观照 sumus 的胶囊（高 36，点击区 44），无动画。
 */
import { useState } from 'react';
import './cards.css';

export const MAX_QUICK = 3;

export function QuickReplies({ options, onSend, onWrite, label = '快速回复' }: { options: string[]; onSend: (text: string) => void; onWrite: () => void; label?: string }) {
  const [sent, setSent] = useState<string | null>(null);
  // 去空、去重、最多 3 个（加上「我自己写…」一共不超过 4 个）
  const list = [...new Set(options.map((o) => o.trim()).filter(Boolean))].slice(0, MAX_QUICK);
  if (sent !== null) return <p className="quick-sent">已回复：{sent}</p>;
  return (
    <div className="quick" role="group" aria-label={label}>
      {list.map((o) => (
        <button
          key={o}
          type="button"
          className="quick-chip"
          aria-label={`快速回复：${o}`}
          onClick={() => {
            setSent(o);
            onSend(o);
          }}
        >
          {o}
        </button>
      ))}
      <button type="button" className="quick-chip quick-chip-write" onClick={onWrite}>
        我自己写…
      </button>
    </div>
  );
}
