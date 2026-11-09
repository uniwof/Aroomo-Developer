/**
 * Skin/Bones 工作台侧栏（Poke #250 补充规范 Bones 第 1 条：核心四区 /chat、/work、/assets、/console，侧栏常驻 224px 极简导航）。
 * 开关 SKIN_BONES 关着时整个文件不被引用，代码摇掉，对话页包不涨（#323 写法）。
 * 宽度写成 14 × --k（--k = 1rem，= 默认 16px 下的 224px），跟着设置里的字号滑杆一起缩放，不写死像素。
 * 无障碍：<nav> + aria-label，当前区 aria-current="page"，按钮有文字（不靠图标认），点击区 ≥44px（.hit）。
 */
import { Boxes, FolderKanban, LayoutDashboard, MessagesSquare, Settings, Users } from 'lucide-react';

export type Zone = 'chat' | 'work' | 'assets' | 'console';

const ZONES: { id: Zone; label: string; icon: typeof Boxes }[] = [
  { id: 'chat', label: '对话', icon: MessagesSquare },
  { id: 'work', label: '工作', icon: FolderKanban },
  { id: 'assets', label: '资产', icon: Boxes },
  { id: 'console', label: '控制台', icon: LayoutDashboard },
];

/** 当前地址属于哪一区（四区之外的面板算在对话区里，侧栏不乱跳） */
export function zoneOf(kind: string): Zone | 'members' | 'settings' {
  if (kind === 'members' || kind === 'member') return 'members';
  if (kind === 'settings') return 'settings';
  if (kind === 'work') return 'work';
  if (kind === 'assets') return 'assets';
  if (kind === 'console') return 'console';
  return 'chat';
}

/** 底部两项：窄栏让位后，成员和设置仍要能到（切片 1 不搬家，后面的切片再归进四区） */
const FOOT: { id: 'members' | 'settings'; label: string; icon: typeof Boxes }[] = [
  { id: 'members', label: '成员', icon: Users },
  { id: 'settings', label: '设置', icon: Settings },
];

/** active 收的是当前面板的 kind，这里自己折算成区，ChatPage 不必引用 zoneOf（它跟组件一起懒加载） */
export function WorkbenchNav({ active: kind, onOpen }: { active: string; onOpen: (z: Zone | 'members' | 'settings') => void }) {
  const active = zoneOf(kind);
  const item = ({ id, label, icon: Icon }: { id: Zone | 'members' | 'settings'; label: string; icon: typeof Boxes }) => (
    <li key={id}>
      <button type="button" className="wb-item hit" aria-current={active === id ? 'page' : undefined} onClick={() => onOpen(id)}>
        <Icon aria-hidden="true" className="wb-icon" />
        <span>{label}</span>
      </button>
    </li>
  );
  return (
    <nav className="wb-nav" aria-label="工作台分区">
      <ul className="wb-list">{ZONES.map(item)}</ul>
      <ul className="wb-list wb-foot">{FOOT.map(item)}</ul>
    </nav>
  );
}
