/**
 * 对话页里每个面板的地址（Poke 行为规范 §2 / 审计 C3）：能直接打开、刷新不丢、浏览器前进后退按面板走。
 * 地址都在 /console 下：/chat、/team（成员）、/hub（资源库、能力地图、工具、API、外部接入 /hub/mcp）、/inbox、/settings[/分组]、/settings/audit、/settings/executors。
 * 成员详情用 /team?member=<id>，不占 /team/:id（规范：成员详情不能和别的路由撞，也不是进对话）。
 * 助手（只给所有者、开关打开时）：详情 /assistants?assistant=<id>，全部计划 /assistants/schedule。
 * /console（驾驶舱）：只用现有接口（成员、收件箱计数、能力地图、审计），见 cockpit.tsx。
 * /work（项目与版本，规范 §7）：需 Core API——Core 没有项目 / 交付物 / 不可变版本的数据，不做假页面，落到对话（docs/api/design-poke-data-v1.md）。
 */
import type { SettingsSection } from './panels';

export type View =
  | { kind: 'chat' }
  | { kind: 'console' }
  /** chat：从群聊顶栏卡进来时只列这个群里的成员（审计 C15），/team?chat=<会话 id> */
  | { kind: 'members'; chat?: string }
  | { kind: 'member'; id: string }
  | { kind: 'capmap' }
  | { kind: 'group-new' }
  | { kind: 'settings'; section?: SettingsSection }
  | { kind: 'tools' }
  | { kind: 'inbox' }
  | { kind: 'library' }
  | { kind: 'keys' }
  /** 外部接入（MCP 配置 + 连接密码）：规范 §6 Hub 的一类；和设置 › 外部接入是同一组内容 */
  | { kind: 'mcp' }
  /** 所有者：审计记录（设置·安全里进入）、本机执行员（设置·电脑助手提醒里进入） */
  | { kind: 'audit' }
  | { kind: 'executors' }
  /** 手机底部栏「我」 */
  | { kind: 'me' }
  /** 助手详情（固定会话 + 运行记录）、X-02 全部计划；只给所有者 */
  | { kind: 'assistant'; id: string }
  | { kind: 'schedule' };

const SECTIONS: readonly string[] = ['profile', 'prefs', 'safety', 'general', 'family', 'lead', 'budget', 'external', 'shortcuts'];

export function pathOf(v: View): string {
  switch (v.kind) {
    case 'chat':
      return '/chat';
    case 'console':
      return '/console';
    case 'members':
      return v.chat ? `/team?chat=${encodeURIComponent(v.chat)}` : '/team';
    case 'member':
      return `/team?member=${encodeURIComponent(v.id)}`;
    case 'capmap':
      // 能力地图是资产（模型清单），归资源库，不挂在成员下（规范 §6 / 审计 H1）
      return '/hub/capabilities';
    case 'group-new':
      return '/chat/new-group';
    case 'settings':
      return v.section ? `/settings/${v.section}` : '/settings';
    case 'tools':
      return '/hub/tools';
    case 'keys':
      return '/hub/keys';
    case 'mcp':
      return '/hub/mcp';
    case 'library':
      return '/hub';
    case 'inbox':
      return '/inbox';
    case 'audit':
      return '/settings/audit';
    case 'executors':
      return '/settings/executors';
    case 'me':
      return '/me';
    case 'assistant':
      // 和成员详情一样用查询参数，不占 /assistants/:id（免得和 /assistants/schedule 撞）
      return `/assistants?assistant=${encodeURIComponent(v.id)}`;
    case 'schedule':
      return '/assistants/schedule';
  }
}

/** 旧地址（控制台时代的 /members、/keys… 和 ?view=）→ 新地址；不是旧地址返回 null */
export function legacyPath(pathname: string, search: string): string | null {
  const p = pathname.replace(/\/+$/, '') || '/';
  const old: Record<string, string> = {
    '/members': '/team',
    '/library': '/hub',
    '/tools': '/hub/tools',
    '/keys': '/hub/keys',
    '/audit': '/settings/audit',
    '/executors': '/settings/executors',
  };
  if (old[p]) return old[p];
  const want = new URLSearchParams(search).get('view');
  if (want) {
    const map: Record<string, string> = { members: '/team', ...Object.fromEntries(Object.entries(old).map(([k, v]) => [k.slice(1), v])), inbox: '/inbox', settings: '/settings' };
    return map[want] ?? '/chat';
  }
  return null;
}

export function viewOf(pathname: string, search: string): View {
  const p = pathname.replace(/\/+$/, '') || '/';
  const q = new URLSearchParams(search);
  if (p === '/team') {
    const id = q.get('member');
    if (id) return { kind: 'member', id };
    const chat = q.get('chat');
    return chat ? { kind: 'members', chat } : { kind: 'members' };
  }
  if (p === '/console') return { kind: 'console' };
  if (p === '/hub/capabilities' || p === '/team/capabilities') return { kind: 'capmap' };
  if (p === '/chat/new-group') return { kind: 'group-new' };
  if (p === '/hub') return { kind: 'library' };
  if (p === '/hub/tools') return { kind: 'tools' };
  if (p === '/hub/keys') return { kind: 'keys' };
  if (p === '/hub/mcp') return { kind: 'mcp' };
  if (p === '/inbox') return { kind: 'inbox' };
  if (p === '/me') return { kind: 'me' };
  if (p === '/assistants/schedule') return { kind: 'schedule' };
  if (p === '/assistants') {
    const id = q.get('assistant');
    if (id) return { kind: 'assistant', id };
  }
  if (p === '/settings/audit') return { kind: 'audit' };
  if (p === '/settings/executors') return { kind: 'executors' };
  if (p === '/settings') return { kind: 'settings' };
  const m = /^\/settings\/([a-z]+)$/.exec(p);
  if (m && SECTIONS.includes(m[1]!)) return { kind: 'settings', section: m[1] as SettingsSection };
  return { kind: 'chat' };
}

/** 只给所有者的面板（家人账号打开这些地址落到对话） */
export const OWNER_ONLY: readonly View['kind'][] = ['library', 'tools', 'keys', 'mcp', 'audit', 'executors', 'assistant', 'schedule'];
