/**
 * 主区域里的面板（成员 / 新建群聊 / 设置 / 快捷键；工具、收件箱直接用控制台页面）。
 * 参照 sumus：侧栏底部「Members」、顶部齿轮打开的内容都在主区域原地显示，不开第二层抽屉；
 * 面板内容一律是分组列表（iOS / sumus 式），不用标签页。最终位置等负责人的 sumus→Aroomo 逐屏映射方案再定。
 */
import { useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, Keyboard } from 'lucide-react';
import type { Member } from '@/lib/api';
import { useUsage } from '@/lib/usage';
import { UsageLine } from '@/pages/Members';
import { CapabilityMap } from '@/components/CapabilityMap';
import { Field, Group, SettingsGroups } from '@/pages/Settings';
import { Avatar } from './Avatar';
import { SPEECH_RATES, speechSupported } from './speech';
import { FONT_SIZES, type ChatPrefs } from './store';
import type { Theme } from '@/lib/display';

/** 面板顶栏：‹ 返回 + 标题（手机上还有「会话列表」按钮，由外层传进来） */
export function PanelHeader({ title, onBack, backLabel, lead }: { title: string; onBack?: () => void; backLabel?: string; lead?: ReactNode }) {
  return (
    <header className="main-head">
      {lead}
      {onBack && (
        <button type="button" className="btn btn-quiet" onClick={onBack} aria-label={`返回${backLabel ?? ''}`}>
          <ChevronLeft aria-hidden="true" />
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

/** 新建群聊：勾选成员（sumus 底部 Invite 的位置） */
export function GroupNewPanel({ members, onStart }: { members: Member[]; onStart: (names: string[]) => void }) {
  const [pick, setPick] = useState<string[]>([]);
  return (
    <div className="panel">
      <fieldset className="group-block">
        <legend className="group-title">选几位成员，一起回答</legend>
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
      <button type="button" className="btn btn-primary btn-wide" disabled={pick.length < 2} onClick={() => onStart(pick)}>
        开始群聊{pick.length < 2 ? '（至少选 2 位）' : `（${pick.length} 位）`}
      </button>
    </div>
  );
}

const THEMES: [Theme, string][] = [
  ['system', '跟随系统'],
  ['light', '浅色'],
  ['dark', '深色'],
];

export const SHORTCUTS: [string, string][] = [
  ['回车', '发送'],
  ['Shift + 回车', '换行'],
  ['Esc', '停止回复'],
  ['Shift + Esc', '回到输入框'],
  ['Ctrl（Mac 用 ⌘）+ Shift + O', '新对话'],
  ['Ctrl（Mac 用 ⌘）+ Shift + S', '打开或关上会话列表'],
];

/** 单选值（字号、颜色、语速）：一排分段按钮，选中的用珊瑚色 */
function Segmented<T extends string | number>({ label, value, options, onChange }: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={String(v)} type="button" role="radio" aria-checked={value === v} className="seg-item" onClick={() => onChange(v)}>
          {text}
        </button>
      ))}
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

export function SettingsPanel({ prefs, setPrefs, onOpen }: { prefs: ChatPrefs; setPrefs: (f: (p: ChatPrefs) => ChatPrefs) => void; onOpen: (v: 'shortcuts') => void }) {
  return (
    <div className="panel">
      <Group title="外观">
        <div className="row row-stack">
          <span className="row-label">字号（整个页面一起变）</span>
          <Segmented label="字号" value={prefs.fontSize} options={FONT_SIZES.map((s) => [s, String(s)])} onChange={(s) => setPrefs((p) => ({ ...p, fontSize: s }))} />
        </div>
        <div className="row row-stack">
          <span className="row-label">颜色</span>
          <Segmented label="颜色" value={prefs.theme} options={THEMES} onChange={(t) => setPrefs((p) => ({ ...p, theme: t }))} />
        </div>
        <Field label="高对比度" hint="纯黑白、加粗边框">
          <Switch label="高对比度" on={prefs.highContrast} onChange={(v) => setPrefs((p) => ({ ...p, highContrast: v }))} />
        </Field>
      </Group>
      {speechSupported() && (
        <Group title="朗读">
          <div className="row row-stack">
            <span className="row-label">语速</span>
            <Segmented label="朗读语速" value={prefs.speechRate} options={SPEECH_RATES.map((r) => [r, r.toFixed(1)])} onChange={(r) => setPrefs((p) => ({ ...p, speechRate: r }))} />
          </div>
          <Field label="用在线语音" hint="本机没有中文语音时用；文字会发到 Google 或微软合成">
            <Switch label="本机没有中文语音时，用在线语音" on={prefs.speechOnline} onChange={(v) => setPrefs((p) => ({ ...p, speechOnline: v }))} />
          </Field>
        </Group>
      )}
      <Group title="更多">
        <NavRow icon={<Keyboard aria-hidden="true" />} label="键盘快捷键" onClick={() => onOpen('shortcuts')} />
      </Group>
      <SettingsGroups />
    </div>
  );
}

export function ShortcutsPanel() {
  return (
    <div className="panel">
      <Group title="键盘快捷键">
        {SHORTCUTS.map(([k, what]) => (
          <div key={k} className="row">
            <span className="row-text">
              <span className="row-label">{what}</span>
            </span>
            <kbd className="row-value">{k}</kbd>
          </div>
        ))}
      </Group>
    </div>
  );
}
