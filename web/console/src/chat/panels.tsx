/**
 * 主区域里的面板（成员 / 新建群聊 / 设置 / 快捷键；工具、收件箱直接用控制台页面）。
 * 参照 sumus：侧栏底部「Members」、顶部齿轮打开的内容都在主区域原地显示，不开第二层抽屉；
 * 面板内容一律是分组列表（iOS / sumus 式），不用标签页。最终位置等负责人的 sumus→Aroomo 逐屏映射方案再定。
 */
import { useState, type ReactNode } from 'react';
import { Bell, ArrowLeft, ChevronRight, Home, Keyboard, Monitor, Moon, Plug, ScrollText, ShieldCheck, SlidersHorizontal, Sun, UserRound, Users, X } from 'lucide-react';
import { isFamily, type Member } from '@/lib/api';
import { useUsage } from '@/lib/usage';
import { UsageLine } from '@/pages/Members';
import { CapabilityMap } from '@/components/CapabilityMap';
import { BudgetSection, Field, Group, LeadSection, McpSection, SecuritySection } from '@/pages/Settings';
import { FamilySection, GeneralSection, PasswordRow, ProfileSection, SignOutGroup } from './views';
import { ClientTokens } from '@/components/ClientTokens';
import { Dialog } from '@/components/Dialog';
import { Avatar } from './Avatar';
import { SPEECH_RATES, speechSupported } from './speech';
import { type ChatPrefs } from './store';
import { FONT_DEFAULT, FONT_MAX, FONT_MIN, clampFont } from '@/lib/display';
import type { Theme } from '@/lib/display';

/** 面板顶栏：← 返回 + 标题（自审 C13：桌面、手机、设置都用同一种「← 上一层名字」）（手机上还有「会话列表」按钮，由外层传进来） */
export function PanelHeader({ title, onBack, backLabel, lead }: { title: string; onBack?: () => void; backLabel?: string; lead?: ReactNode }) {
  return (
    <header className="main-head">
      {lead}
      {onBack && (
        <button type="button" className="btn btn-quiet" onClick={onBack} aria-label={`返回${backLabel ?? ''}`}>
          <ArrowLeft aria-hidden="true" />
          <span>{backLabel ?? '返回'}</span>
        </button>
      )}
      <h1 className="main-title">{title}</h1>
    </header>
  );
}

/** 一行「进入下一层」：行尾 › */
export function NavRow({ icon, label, value, onClick }: { icon?: ReactNode; label: string; value?: string; onClick: () => void }) {
  return (
    <button type="button" className="row row-button" onClick={onClick}>
      {icon && <span className="row-icon">{icon}</span>}
      <span className="row-text">
        <span className="row-label">{label}</span>
      </span>
      {value && <span className="row-value">{value}</span>}
      <ChevronRight aria-hidden="true" className="row-chevron" />
    </button>
  );
}

function statusText(m: Member): string {
  if (!m.enabled) return '已停用';
  if (m.status === 'candidate') return '候选';
  return (m.online ?? m.status === 'active') ? '在线' : '离线';
}

/** 成员：列表 → 详情 */
export function MembersPanel({ members, onOpen }: { members: Member[]; onOpen: (m: Member) => void }) {
  return (
    <div className="panel">
      {members.length === 0 ? (
        <p className="group-empty">还没有在职成员。在「能力地图」里填一个模型 Key，模型就会成为候选成员。</p>
      ) : (
        <Group title={`在职（${members.length}）`}>
          {members.map((m) => (
            <button key={m.id} type="button" className="row row-button" onClick={() => onOpen(m)}>
              <Avatar name={m.name} size="sm" />
              <span className="row-text">
                <span className="row-label">{m.name}</span>
                <span className="row-hint">
                  {statusText(m)}
                  {m.capabilityTags.length > 0 && ` · ${m.capabilityTags.join('、')}`}
                </span>
              </span>
              <ChevronRight aria-hidden="true" className="row-chevron" />
            </button>
          ))}
        </Group>
      )}
    </div>
  );
}

export function MemberDetail({ member, onChat, onMention }: { member: Member; onChat: () => void; onMention: () => void }) {
  const { rows, reload } = useUsage(120_000);
  const row = rows?.find((r) => r.memberId === member.id);
  return (
    <div className="panel">
      <div className="profile">
        <Avatar name={member.name} size="lg" />
        <div>
          <p className="profile-name">{member.name}</p>
          <p className="muted">{statusText(member)}</p>
        </div>
      </div>
      <div className="panel-actions">
        <button type="button" className="btn btn-primary" onClick={onChat} aria-label={`和 ${member.name} 单独对话`}>
          单独聊
        </button>
        <button type="button" className="btn btn-outline" onClick={onMention} aria-label={`在当前对话里点名 ${member.name}`}>
          在当前对话里点名
        </button>
      </div>
      <Group title="能力">
        <Field label="能力标签">
          <span>{member.capabilityTags.length ? member.capabilityTags.join('、') : '—'}</span>
        </Field>
        <Field label="能当负责人">
          <span>{member.leadEligible ? '能' : '不能'}</span>
        </Field>
      </Group>
      {row && (
        <Group title="今天的用量">
          <div className="row">
            <UsageLine row={row} onSaved={() => void reload()} />
          </div>
        </Group>
      )}
    </div>
  );
}

export function CapabilityPanel() {
  return (
    <div className="panel">
      <CapabilityMap />
    </div>
  );
}

/**
 * 挑选成员新建（所有者 11-05 12:15）：默认的新对话是全员；这里自己挑。
 * 挑一位 = 和 TA 单聊；挑几位 = 这几位一起回答，对话里 @ 只列这几位。
 */
export function GroupNewPanel({ members, onStart }: { members: Member[]; onStart: (names: string[]) => void }) {
  const [pick, setPick] = useState<string[]>([]);
  const all = members.length > 0 && pick.length === members.length;
  if (members.length === 0) return <div className="panel"><p className="group-empty">还没有成员。先在资源库里添加一位。</p></div>;
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

const THEMES: [Theme, string, ReactNode][] = [
  ['light', '浅色', <Sun key="l" aria-hidden="true" />],
  ['dark', '深色', <Moon key="d" aria-hidden="true" />],
  ['system', '跟随系统', <Monitor key="s" aria-hidden="true" />],
];

export const SHORTCUTS: [string, string][] = [
  ['回车', '发送'],
  ['Shift + 回车', '换行'],
  ['Esc', '停止回复'],
  ['Shift + Esc', '回到输入框'],
  ['Ctrl（Mac 用 ⌘）+ Shift + O', '新对话'],
  ['Ctrl（Mac 用 ⌘）+ Shift + S', '打开或关上会话列表'],
];

/** 单选值（外观、语速）：照 sumus「Appearance」连在一起的几个按钮，选中的浅灰底 */
function Segmented<T extends string | number>({ label, value, options, onChange }: { label: string; value: T; options: [T, string, ReactNode?][]; onChange: (v: T) => void }) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map(([v, text, icon]) => (
        <button key={String(v)} type="button" role="radio" aria-checked={value === v} className="seg-item" onClick={() => onChange(v)}>
          {icon}
          {text}
        </button>
      ))}
    </div>
  );
}

/** 字号滑杆（所有者 23:07：任意大小，约 12–32，连续可调）：拖动、方向键、两边的 −/+ 都行；「恢复默认」回到 sumus 原尺寸 */
function FontSlider({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const text = `正文 ${value} 像素${value === FONT_DEFAULT ? '（默认）' : ''}`;
  return (
    <div className="row row-stack">
      <label className="row-label" htmlFor="font-size-slider">
        字号（整个页面一起变）
      </label>
      <div className="font-slider">
        <button type="button" className="btn btn-outline btn-square" aria-label="字号调小" disabled={value <= FONT_MIN} onClick={() => onChange(clampFont(value - 1))}>
          A−
        </button>
        <input
          id="font-size-slider"
          type="range"
          min={FONT_MIN}
          max={FONT_MAX}
          step={0.5}
          value={value}
          aria-valuetext={text}
          onChange={(e) => onChange(clampFont(Number(e.target.value)))}
        />
        <button type="button" className="btn btn-outline btn-square" aria-label="字号调大" disabled={value >= FONT_MAX} onClick={() => onChange(clampFont(value + 1))}>
          A+
        </button>
      </div>
      <div className="font-slider-foot">
        <span className="muted" aria-hidden="true">
          {text}
        </span>
        {value !== FONT_DEFAULT && (
          <button type="button" className="btn btn-outline" onClick={() => onChange(FONT_DEFAULT)}>
            恢复默认
          </button>
        )}
      </div>
    </div>
  );
}

function Switch({ label, on, onChange }: { label: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className="switch" onClick={() => onChange(!on)}>
      <span className="switch-knob" />
    </button>
  );
}

/** 设置的分区（照 sumus 设置弹窗左边的分组；Connectors 挪到窄栏「工具」，计费、本地电脑隐藏） */
export type SettingsSection = 'profile' | 'prefs' | 'safety' | 'general' | 'family' | 'lead' | 'budget' | 'external' | 'shortcuts';
export const SETTINGS_SECTIONS: { id: SettingsSection; label: string; sub: string; Icon: typeof Keyboard }[] = [
  { id: 'profile', label: '个人资料', sub: '你在 Aroomo 里的名字和登录账号。', Icon: UserRound },
  { id: 'prefs', label: '偏好', sub: '改动立即生效，不用保存。', Icon: SlidersHorizontal },
  { id: 'safety', label: '安全', sub: '密码、登录和敏感内容保护。', Icon: ShieldCheck },
  { id: 'general', label: '通用', sub: '这个 Aroomo 的概况和总额度。', Icon: Home },
  { id: 'family', label: '家人与邀请', sub: '家里谁在用 Aroomo。', Icon: Users },
  { id: 'lead', label: '负责人', sub: '对话里没有 @ 成员时，交给负责人回答。', Icon: UserRound },
  { id: 'budget', label: '电脑助手提醒', sub: '电脑助手每天最多提醒你几次。', Icon: Bell },
  { id: 'external', label: '外部接入', sub: '在别的 AI 软件里也能用你的 Aroomo。', Icon: Plug },
  { id: 'shortcuts', label: '键盘快捷键', sub: '不用鼠标也能用。', Icon: Keyboard },
];

type PrefsProps = { prefs: ChatPrefs; setPrefs: (f: (p: ChatPrefs) => ChatPrefs) => void };
/** 设置里跳到整页的下一层（所有者：审计记录、本机执行员） */
export type GoTarget = 'audit' | 'executors' | 'keys';
type GoProps = { onGo: (k: GoTarget) => void; members?: Member[] };
/** 家人：个人资料 / 偏好 / 安全（+ 键盘快捷键，只是说明）；落地文档 0.5、11 章 */
const FAMILY_SECTIONS: SettingsSection[] = ['profile', 'prefs', 'safety', 'shortcuts'];
/** 这个账号能看到的分组：家人只有 偏好 / 安全 / 键盘快捷键（落地文档 0.5、11 章） */
export function visibleSections() {
  return SETTINGS_SECTIONS.filter((x) => !isFamily() || FAMILY_SECTIONS.includes(x.id));
}

/** 一个分区的内容：图标 + 标题 + 灰色说明 + 分隔线，下面是分组（照 sumus 设置右侧） */
export function SettingsSectionBody({ section, prefs, setPrefs, onGo, members = [], headingLevel = 2 }: PrefsProps & GoProps & { section: SettingsSection; headingLevel?: 2 | 3 }) {
  const sec = SETTINGS_SECTIONS.find((x) => x.id === section)!;
  const H = headingLevel === 2 ? 'h2' : 'h3';
  return (
    <section className="page page-set" aria-labelledby={`set-${section}`}>
      <div className="page-head">
        <H id={`set-${section}`} className="page-title">
          <sec.Icon aria-hidden="true" />
          {sec.label}
        </H>
        <p className="page-sub">{sec.sub}</p>
      </div>
      {section === 'prefs' && (
        <>
          <Group title="外观">
            <Field label="颜色">
              <Segmented label="颜色" value={prefs.theme} options={THEMES} onChange={(t) => setPrefs((p) => ({ ...p, theme: t }))} />
            </Field>
            <FontSlider value={prefs.fontSize} onChange={(v) => setPrefs((p) => ({ ...p, fontSize: v }))} />
            <Field label="高对比度">
              <Switch label="高对比度" on={prefs.highContrast} onChange={(v) => setPrefs((p) => ({ ...p, highContrast: v }))} />
            </Field>
          </Group>
          {speechSupported() && (
            <Group title="朗读">
              <Field label="语速">
                <Segmented label="朗读语速" value={prefs.speechRate} options={SPEECH_RATES.map((r) => [r, r.toFixed(1)])} onChange={(r) => setPrefs((p) => ({ ...p, speechRate: r }))} />
              </Field>
              <Field label="用在线语音" hint="文字会发到 Google 或微软">
                <Switch label="本机没有中文语音时，用在线语音" on={prefs.speechOnline} onChange={(v) => setPrefs((p) => ({ ...p, speechOnline: v }))} />
              </Field>
            </Group>
          )}
        </>
      )}
      {section === 'lead' && (
        <div className="group">
          <LeadSection />
        </div>
      )}
      {section === 'profile' && <ProfileSection />}
      {section === 'safety' && (
        <>
          <div className="group">
            <PasswordRow />
            {!isFamily() && (
              <>
                <SecuritySection />
                <NavRow icon={<ScrollText aria-hidden="true" />} label="审计记录" value="最近的操作" onClick={() => onGo('audit')} />
              </>
            )}
          </div>
          <SignOutGroup />
        </>
      )}
      {section === 'general' && <GeneralSection members={members} onUsage={() => onGo('keys')} />}
      {section === 'family' && <FamilySection />}
      {section === 'budget' && (
        <div className="group">
          <BudgetSection />
          <NavRow icon={<Monitor aria-hidden="true" />} label="电脑助手" value="哪些电脑、在做什么" onClick={() => onGo('executors')} />
        </div>
      )}
      {section === 'external' && (
        <div className="group">
          <McpSection />
          <div className="row row-stack">
            <ClientTokens />
          </div>
        </div>
      )}
      {section === 'shortcuts' && <ShortcutList />}
    </section>
  );
}

/** 桌面 / 中等宽度：居中弹窗，左边分组、右边内容（照 sumus 05–12 号截图），右上角 × 关闭 */
export function SettingsDialog({ open, onClose, prefs, setPrefs, onGo, members }: PrefsProps & GoProps & { open: boolean; onClose: () => void }) {
  const [section, setSection] = useState<SettingsSection>('profile');
  return (
    <Dialog
      open={open}
      title="设置"
      onClose={onClose}
      className="dlg-settings"
      nav={
        <ul className="set-nav" aria-label="设置分组">
          {visibleSections().map(({ id, label, Icon }) => (
            <li key={id}>
              <button type="button" className="set-nav-item" aria-current={section === id ? 'page' : undefined} onClick={() => setSection(id)}>
                <Icon aria-hidden="true" />
                <span>{label}</span>
              </button>
            </li>
          ))}
        </ul>
      }
    >
      <button type="button" className="btn btn-quiet btn-icon set-close" aria-label="关闭设置" onClick={onClose}>
        <X aria-hidden="true" />
      </button>
      <SettingsSectionBody section={section} prefs={prefs} setPrefs={setPrefs} onGo={onGo} {...(members ? { members } : {})} headingLevel={3} />
    </Dialog>
  );
}

/** 手机 / 大字号：整页——先看分组列表，点进去看详情（不用横向一排标签） */
export function SettingsPanel({ prefs, setPrefs, section, onOpen, onGo, members }: PrefsProps & GoProps & { section?: SettingsSection; onOpen: (s: SettingsSection) => void }) {
  if (section) {
    return (
      <div className="panel">
        <SettingsSectionBody section={section} prefs={prefs} setPrefs={setPrefs} onGo={onGo} {...(members ? { members } : {})} />
      </div>
    );
  }
  return (
    <div className="panel">
      <div className="group">
        {visibleSections().map(({ id, label, Icon }) => (
          <NavRow key={id} icon={<Icon aria-hidden="true" />} label={label} onClick={() => onOpen(id)} />
        ))}
      </div>
    </div>
  );
}

function ShortcutList() {
  return (
    <div className="group">
      {SHORTCUTS.map(([k, what]) => (
        <div key={k} className="row">
          <span className="row-text">
            <span className="row-label">{what}</span>
          </span>
          <kbd className="row-value">{k}</kbd>
        </div>
      ))}
    </div>
  );
}
