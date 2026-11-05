/**
 * X-05 工具调用过程可见（功能补充 v1；数据见 docs/api/stream-parts.md §1）：放在回复正文上方，一行灰字，默认收起。
 * - 一个工具：「搜了网页 · 5 条结果」；几个工具：「用了 3 个工具 · 搜了网页、读了网页」。
 * - 点开（按钮，aria-expanded）逐个列出：做了什么、结果摘要；所有者还能看到 Core 脱敏过的参数和结果摘录，家人只有摘要。
 * - 静态文字和图标，不转圈、不做展开动画；点击区 ≥44px；读屏读作「工具调用：搜了网页 · 5 条结果，按钮，已收起」（名字就是看到的字）。
 */
import { useId, useState } from 'react';
import { ChevronDown, ChevronRight, Wrench } from 'lucide-react';
import type { ChatTool } from '../../store';
import './cards.css';

const STATE_TEXT: Record<ChatTool['state'], string> = { done: '完成', failed: '没拿到结果', unavailable: '没执行' };

/** 收起时那一行 */
export function toolLine(tools: ChatTool[]): string {
  if (tools.length === 1) return `${tools[0]!.label} · ${tools[0]!.summary}`;
  const labels = [...new Set(tools.map((t) => t.label))];
  return `用了 ${tools.length} 个工具 · ${labels.join('、')}`;
}

export function ToolCalls({ tools }: { tools: ChatTool[] }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  if (!tools.length) return null;
  const line = toolLine(tools);
  return (
    <div className="tool-calls">
      <button
        type="button"
        className="btn btn-quiet tool-toggle"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
      >
        <Wrench aria-hidden="true" />
        <span className="sr-only">工具调用：</span>
        <span className="tool-line">{line}</span>
        {open ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
      </button>
      {open && (
        <ol id={id} className="tool-list" aria-label="工具调用详情">
          {tools.map((t) => (
            <li key={t.index} className="tool-item">
              <p className="tool-item-head">
                <span className="tool-item-label">{t.label}</span>
                <span className="tool-item-state">{STATE_TEXT[t.state]}</span>
              </p>
              <p className="tool-item-summary">{t.summary}</p>
              {t.args && (
                <>
                  <p className="tool-item-title">参数（已隐藏密钥和网址参数）</p>
                  <pre className="tool-item-pre">{t.args}</pre>
                </>
              )}
              {t.result && (
                <>
                  <p className="tool-item-title">结果摘录</p>
                  <pre className="tool-item-pre">{t.result}</pre>
                </>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export default ToolCalls;
