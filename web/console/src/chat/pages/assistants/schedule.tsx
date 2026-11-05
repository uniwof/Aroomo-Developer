/**
 * X-02 定时列表整页「全部计划」（功能补充 v1，开关 FLAGS.schedulePage，默认关；等 GET /api/assistants）。
 * 这一页只有这一张表，不做成标签页。桌面是表格；窄屏（手机 / 字号放大）同一份数据一行变一张卡（CSS 容器查询，读屏仍按表格读）。
 * 列：成员头像叠放、助手名、目标（任务说明第一句）、指令摘要（两行）、什么时候跑（人话）、时区、下次运行、上次结果、启用开关。
 * 启用开关的接口（pause / resume）由调用方传进来；没传就不显示开关，避免死按钮。
 */
import { Avatar } from '../../Avatar';
import { scheduleText, splitInstructions, whenText, zoneText, type ScheduleKind, type ScheduleSpec } from './schedule-text';
import '../../thread/cards/cards.css';

/** 和指南附录 C assistant_runs.status 对齐 */
export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'waiting_confirmation' | 'cancelled';
export const RUN_LABEL: Record<RunStatus, string> = {
  queued: '排队中',
  running: '进行中',
  succeeded: '完成',
  failed: '失败',
  skipped: '跳过',
  waiting_confirmation: '等你确认',
  cancelled: '已取消',
};

export interface ScheduleRow {
  id: string;
  name: string;
  members: string[];
  instructions: string;
  scheduleKind: ScheduleKind;
  scheduleSpec: ScheduleSpec;
  timezone: string;
  nextRunAt: string | null;
  lastRun: { status: RunStatus; summary?: string; finishedAt?: string } | null;
  enabled: boolean;
}

function Stack({ names }: { names: string[] }) {
  const shown = names.slice(0, 3);
  return (
    <span className="av-stack" aria-label={names.length ? `成员：${names.join('、')}` : '还没有成员'}>
      {shown.map((n) => (
        <Avatar key={n} name={n} size="xs" />
      ))}
      {names.length > 3 && <span className="av-more" aria-hidden="true">+{names.length - 3}</span>}
    </span>
  );
}

export function lastText(r: ScheduleRow['lastRun']): string {
  if (!r) return '还没跑过';
  return r.summary ? `${RUN_LABEL[r.status]}：${r.summary}` : RUN_LABEL[r.status];
}

export function SchedulePage({ rows, error, onToggle, onOpen }: { rows: ScheduleRow[] | null; error?: string; onToggle?: (id: string, on: boolean) => void; onOpen?: (id: string) => void }) {
  if (error)
    return (
      <p role="alert" className="note note-error">
        {error}
      </p>
    );
  if (!rows) return <p className="note">正在加载…</p>;
  if (rows.length === 0)
    return (
      <div className="empty">
        <p className="empty-text">还没有定时的助手。</p>
      </div>
    );
  return (
    <div className="sched-wrap">
      <table className="sched" role="table" aria-label="全部计划">
        <thead role="rowgroup">
          <tr role="row">
            {['成员', '助手', '目标', '指令摘要', '什么时候跑', '时区', '下次运行', '上次结果', ...(onToggle ? ['启用'] : [])].map((h) => (
              <th key={h} role="columnheader" scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody role="rowgroup">
          {rows.map((r) => {
            const { goal, rest } = splitInstructions(r.instructions);
            return (
              <tr key={r.id} role="row">
                <td role="cell" data-label="成员">
                  <Stack names={r.members} />
                </td>
                <td role="cell" data-label="助手" className="sched-name">
                  {onOpen ? (
                    <button type="button" className="link-btn" onClick={() => onOpen(r.id)}>
                      {r.name}
                    </button>
                  ) : (
                    r.name
                  )}
                </td>
                <td role="cell" data-label="目标">
                  {goal}
                </td>
                <td role="cell" data-label="指令摘要">
                  <span className="sched-clamp">{rest || '—'}</span>
                </td>
                <td role="cell" data-label="什么时候跑">
                  {scheduleText(r.scheduleKind, r.scheduleSpec)}
                </td>
                <td role="cell" data-label="时区">
                  {zoneText(r.timezone)}
                </td>
                <td role="cell" data-label="下次运行">
                  {r.enabled && r.scheduleKind !== 'manual' ? whenText(r.nextRunAt, r.timezone) : r.enabled ? '—' : '已暂停'}
                </td>
                <td role="cell" data-label="上次结果" className={r.lastRun && (r.lastRun.status === 'failed' || r.lastRun.status === 'waiting_confirmation') ? 'sched-strong' : undefined}>
                  {lastText(r.lastRun)}
                </td>
                {onToggle && (
                  <td role="cell" data-label="启用">
                    <button type="button" role="switch" aria-checked={r.enabled} aria-label={`启用「${r.name}」`} className="switch" onClick={() => onToggle(r.id, !r.enabled)}>
                      <span className="switch-knob" />
                    </button>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
