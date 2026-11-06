// #316：新建群聊不常开，从 panels 拆出来点开才下载（对话页包 ≤150 KB gz，#281）
import { useState } from 'react';
import type { Member } from '@/lib/api';
import { Avatar } from './Avatar';
import { Empty } from './ui';

/**
 * 挑选成员新建（所有者 11-05 12:15）：默认的新对话是全员；这里自己挑。
 * 挑一位 = 和 TA 单聊；挑几位 = 这几位一起回答，对话里 @ 只列这几位。
 */
export function GroupNewPanel({ members, onStart, onAdd }: { members: Member[]; onStart: (names: string[]) => void; onAdd?: () => void }) {
  const [pick, setPick] = useState<string[]>([]);
  const all = members.length > 0 && pick.length === members.length;
  // 空状态直达添加成员（审计 M3）
  if (members.length === 0)
    return (
      <div className="panel">
        <Empty
          text="还没有在职成员。"
          {...(onAdd
            ? {
                action: (
                  <button type="button" className="btn btn-outline" onClick={onAdd}>
                    添加成员
                  </button>
                ),
              }
            : {})}
        />
      </div>
    );
  return (
    <div className="panel">
      <fieldset className="group-block">
        <legend className="group-title">挑选这次对话的成员</legend>
        <div className="btn-row picker-bar">
          <button type="button" className="btn btn-outline" onClick={() => setPick(all ? [] : members.map((m) => m.name))}>
            {all ? '全不选' : '全选'}
          </button>
        </div>
        <div className="group">
          {members.map((m) => (
            <label key={m.id} className="row row-button">
              <Avatar name={m.name} size="sm" />
              <span className="row-text">
                <span className="row-label">{m.name}</span>
              </span>
              <input
                type="checkbox"
                className="check"
                checked={pick.includes(m.name)}
                onChange={(e) => setPick((g) => (e.target.checked ? [...g, m.name] : g.filter((n) => n !== m.name)))}
              />
            </label>
          ))}
        </div>
      </fieldset>
      <button type="button" className="btn btn-primary btn-wide" disabled={pick.length < 1} onClick={() => onStart(pick)}>
        {pick.length === 0 ? '开始对话（至少选 1 位）' : pick.length === 1 ? `和 ${pick[0]} 单独聊` : `开始对话（${pick.length} 位）`}
      </button>
    </div>
  );
}
