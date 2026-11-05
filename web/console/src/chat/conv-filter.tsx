/**
 * X-27 会话列表「全部 / 未读 / 进行中」筛选 + X-22 进行中的会话排最前（功能补充 v1，开关 FLAGS.convFilter，默认关）。
 * 未读、进行中要等会话存进 Core 才有真数据：本机会话没有这两个状态，所以只挂在「助手」列表上（未读、进行中由 /api/assistants 给）。
 * 筛选是筛选不是标签页：三个胶囊，高 28、点击区 44；「进行中」用静态小标，不转圈。
 */
import './thread/cards/cards.css';

export type ConvFilterValue = 'all' | 'unread' | 'running';
export interface Filterable {
  unread?: boolean;
  running?: boolean;
}

/** 先按筛选留下，再把进行中的排到最前（同类之间保持原来的顺序） */
export function applyConvFilter<T extends Filterable>(rows: T[], f: ConvFilterValue): T[] {
  const kept = rows.filter((r) => f === 'all' || (f === 'unread' ? r.unread : r.running));
  return [...kept.filter((r) => r.running), ...kept.filter((r) => !r.running)];
}

const OPTIONS: [ConvFilterValue, string][] = [
  ['all', '全部'],
  ['unread', '未读'],
  ['running', '进行中'],
];

export function ConvFilter({ value, onChange, label = '筛选对话' }: { value: ConvFilterValue; onChange: (v: ConvFilterValue) => void; label?: string }) {
  return (
    <div className="pill-filter" role="radiogroup" aria-label={label}>
      {OPTIONS.map(([v, text]) => (
        <button key={v} type="button" role="radio" aria-checked={value === v} className="pill" onClick={() => onChange(v)}>
          {text}
        </button>
      ))}
    </div>
  );
}

/** X-22：名字旁边的静态「进行中」小标（读屏读得到，不只靠颜色） */
export function RunningTag() {
  return <span className="tag-running">进行中</span>;
}
