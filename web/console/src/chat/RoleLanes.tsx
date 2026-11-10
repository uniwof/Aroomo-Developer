/**
 * Skin/Bones 切片 3：角色泳道（Poke #250 补充规范 Bones 第 3 条：/chat、/console 不选具体模型，映射四职能角色
 * Architect / Scraper / Summarizer / Monitor）。只读骨架：按成员现有的 role 字段分道，不新建接口、不改成员。
 * 只被懒加载的 SkinBonesZone 引用，开关关着时不进任何包；开着时也不进对话页主包。
 * shortcut: 角色按 role 文字对号入座（英文名或中文名，不分大小写），对不上的归「其他」；等后台有正式的角色字段再换成枚举。
 */
import { activityLabel, type Member } from '@/lib/api';

export const LANES = [
  { id: 'architect', label: '架构', en: 'Architect' },
  { id: 'scraper', label: '采集', en: 'Scraper' },
  { id: 'summarizer', label: '总结', en: 'Summarizer' },
  { id: 'monitor', label: '监控', en: 'Monitor' },
] as const;

export type LaneId = (typeof LANES)[number]['id'] | 'other';

/** 成员的 role 文字 → 哪一道 */
export function laneOf(role: string | null | undefined): LaneId {
  const r = (role ?? '').trim().toLowerCase();
  return LANES.find((l) => r === l.id || r === l.label)?.id ?? 'other';
}

function status(m: Member): string {
  if (m.activity) return activityLabel(m.activity);
  return m.enabled ? '在职' : '已停用';
}

export function RoleLanes({ members, failed, onRetry, onOpenMember }: { members: Member[]; failed?: boolean; onRetry?: () => void; onOpenMember: (id: string) => void }) {
  const lanes = [...LANES.map((l) => ({ id: l.id as LaneId, name: `${l.label}（${l.en}）` })), { id: 'other' as LaneId, name: '其他' }];
  return (
    <section className="group-block" aria-labelledby="lanes-title">
      <h2 id="lanes-title" className="group-title">
        角色泳道
      </h2>
      {failed ? (
        <div className="empty">
          <p className="empty-text">成员没读到。</p>
          {onRetry && (
            <button type="button" className="btn btn-outline" onClick={onRetry}>
              重试
            </button>
          )}
        </div>
      ) : (
        <ul className="lanes">
          {lanes.map((lane) => {
            const list = members.filter((m) => laneOf(m.role) === lane.id);
            return (
              <li key={lane.id} className="lane">
                <section aria-label={`${lane.name}，${list.length} 位成员`}>
                  <h3 className="lane-title">
                    {lane.name}
                    <span className="lane-count"> · {list.length}</span>
                  </h3>
                  {list.length === 0 ? (
                    <p className="lane-empty">这一道还没有成员。</p>
                  ) : (
                    <ul className="lane-list">
                      {list.map((m) => (
                        <li key={m.id}>
                          <button type="button" className="lane-item hit" onClick={() => onOpenMember(m.id)} aria-label={`${m.name}，${status(m)}，打开成员详情`}>
                            <span className="lane-name">{m.name}</span>
                            <span className="lane-status">{status(m)}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
