/**
 * Skin/Bones 工作台里「只有开关打开才看得到」的区内容，全放这一个懒加载块（切片 3 的瘦身）：
 * 切片 1 的 /work、/assets 空壳，切片 2 的右侧抽屉（?drawer= 地址契约也在这里），切片 3 的 /console 角色泳道。
 * 为什么挪进来：切片 2 之后开关一打开，对话页主包就剩 0.05 kB 余量（149.95/150）。这些字和这段逻辑
 * 只有进了 /work、/assets 才用得上，放进点开才下载的块里，开关开着主包也不涨（见 PR 的包体数字）。
 * ChatPage 里只剩一行 `lazy(() => import('./SkinBonesZone'))`，关着时那一行是常量 false，整块摇掉。
 */
import { lazy, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Empty } from './ui';
import { drawerOf, withDrawer, type DrawerState } from './drawer-query';
import { RoleLanes } from './RoleLanes';
import type { Member } from '@/lib/api';

const SideDrawer = lazy(() => import('./SideDrawer'));

/** 空壳上那个占位动作要去的地方（ChatPage 负责换页，这里不碰路由表） */
export type ZoneGo = 'chat' | 'library';

type Props =
  | { kind: 'work' | 'assets'; onGo: (to: ZoneGo) => void }
  /** /console：驾驶舱下面加角色泳道；成员用 ChatPage 已经读到的那份，不另发请求 */
  | { kind: 'console'; members: Member[]; failed?: boolean; onRetry?: () => void; onOpenMember: (id: string) => void };

export default function SkinBonesZone(props: Props) {
  const location = useLocation();
  const navigate = useNavigate();
  // 抽屉状态只在地址里（?drawer=<id>&w=640）。打开、关上各占一步历史（后退能关、前进能再开），切宽档不占
  const drawer = drawerOf(location.search);
  const ref = useRef({ location, navigate });
  ref.current = { location, navigate };
  const setDrawer = (d: DrawerState | null, replace = false) => {
    const { location: loc, navigate: nav } = ref.current;
    // Esc 的 keydown 和 cancel 可能先后都到：已经关了就不再写一步历史
    if (!d && !drawerOf(loc.search)) return;
    nav(loc.pathname + withDrawer(loc.search, d), { replace, state: loc.state });
  };
  if (props.kind === 'console') {
    return (
      <div className="panel">
        <RoleLanes members={props.members} {...(props.failed ? { failed: true } : {})} {...(props.onRetry ? { onRetry: props.onRetry } : {})} onOpenMember={props.onOpenMember} />
      </div>
    );
  }
  const { kind, onGo } = props;
  return (
    <div className="panel">
      {kind === 'work' ? (
        <Empty
          text="这里会放项目和版本，还没有接上。"
          action={
            <button type="button" className="btn btn-outline" onClick={() => onGo('chat')}>
              先回到对话
            </button>
          }
        />
      ) : (
        <>
          <Empty
            text="这里会放点子、工具与试用、知识库，还没有接上。"
            action={
              <button type="button" className="btn btn-outline" onClick={() => onGo('library')}>
                先去资源库
              </button>
            }
          />
          {/* 切片 2：右侧抽屉的入口（示例）；开哪个抽屉由地址说了算 */}
          <button type="button" className="btn btn-outline" onClick={() => setDrawer({ id: 'preview', wide: false })}>
            打开示例详情
          </button>
        </>
      )}
      {drawer && <SideDrawer key={drawer.id} id={drawer.id} wide={drawer.wide} onClose={() => setDrawer(null)} onWide={(wide) => setDrawer({ ...drawer, wide }, true)} />}
    </div>
  );
}
