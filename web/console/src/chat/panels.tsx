/**
 * 主区域里的面板（成员 / 新建群聊 / 设置 / 快捷键；工具、收件箱直接用控制台页面）。
 * 参照 sumus：侧栏底部「Members」、顶部齿轮打开的内容都在主区域原地显示，不开第二层抽屉；
 * 面板内容一律是分组列表（iOS / sumus 式），不用标签页。最终位置等负责人的 sumus→Aroomo 逐屏映射方案再定。
 */
import { lazy, Suspense, useState, type ReactNode } from 'react';
import { Bell, BellRing, ArrowLeft, ChevronRight, Home, Keyboard, Monitor, Moon, Plug, ScrollText, ShieldCheck, SlidersHorizontal, Sun, UserRound, Users, X } from 'lucide-react';
import { activityLabel, api, isFamily, type Member } from '@/lib/api';
import { useAsk } from '@/components/Dialog';
import { useUsage } from '@/lib/usage';
import { UsageLine } from '@/components/UsageLine';
import { BudgetSection, Field, Group, LeadSection, McpSection, SecuritySection } from '@/pages/Settings';
import { FamilySection, GeneralSection, PasswordRow, ProfileSection, SignOutGroup } from './settings-sections';
import { ClientTokensLazy } from '@/components/ClientTokensLazy';
import { Dialog } from '@/components/Dialog';
import { Avatar } from './Avatar';
import { Empty, errText } from './ui';
import { ErrorRetry } from '@/components/ErrorRetry';
import { SPEECH_RATES, speechSupported } from './speech';
import { type ChatPrefs } from './store';
import { FONT_DEFAULT, FONT_MAX, FONT_MIN, clampFont } from '@/lib/display';
import type { Theme } from '@/lib/display';

// #281：设置 › 通知点开才下载（对话页包 ≤150 KB gz）；下载时一句静态文字，不转圈
const PushSection = lazy(() => import('./push-section').then((m) => ({ default: m.PushSection })));

/**
 * 全站唯一一种返回键（Poke ③ / 自审 C13）：「← 上一层名字」，桌面、手机、对话页、面板、设置都用它。
 * 手机对话页回会话列表也是它（不再是光秃秃的 ← 图标）。ariaLabel 不给时读「返回 + 名字」。
 */
export function BackButton({ label, onClick, ariaLabel }: { label: string; onClick: () => void; ariaLabel?: string }) {
  return (
    <button type="button" className="btn btn-quiet back-btn" onClick={onClick} aria-label={ariaLabel ?? `返回${label}`}>
      <ArrowLeft aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
}

/** 面板顶栏：← 上一层 + 标题（桌面中等宽度前面还有 ≡ 打开会话列表，由外层传进来） */
export function PanelHeader({ title, onBack, backLabel, backAria, lead }: { title: string; onBack?: () => void; backLabel?: string; backAria?: string; lead?: ReactNode }) {
  return (
    <header className="main-head">
      {lead}
      {onBack && <BackButton label={backLabel ?? '返回'} onClick={onBack} {...(backAria ? { ariaLabel: backAria } : {})} />}
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
  if (m.activity) return activityLabel(m.activity);
  if (!m.enabled) return '已停用';
  if (m.status === 'candidate') return '候选';
  return (m.online ?? m.status === 'active') ? '在线' : '离线';
}

/** 详情里的一行：状态 + 依据 + 从几点起（Poke §5 的提示信息，直接写出来，读屏能读到） */
function statusLine(m: Member): string {
  const a = m.activity;
  if (!a || a.state === 'unknown') return statusText(m);
  const t = a.since ? new Date(a.since) : null;
  const p = (n: number) => String(n).padStart(2, '0');
  const since = t && !Number.isNaN(t.getTime()) ? ` · ${p(t.getHours())}:${p(t.getMinutes())} 起` : '';
  return `${activityLabel(a)}${a.reason ? ` · ${a.reason}` : ''}${since}`;
}

function MemberRows({ list, onOpen }: { list: Member[]; onOpen: (m: Member) => void }) {
  return (
    <>
          {list.map((m) => (
            <button key={m.id} type="button" className="row row-button" onClick={() => onOpen(m)}>
              <Avatar name={m.name} size="sm" glyph={m.avatar} />
              <span className="row-text">
                <span className="row-label">{m.name}</span>
                <span className="row-hint">
                  {m.role ? `${m.role} · ` : ''}
                  {statusText(m)}
                  {m.capabilityTags.length > 0 && ` · ${m.capabilityTags.join('、')}`}
                </span>
              </span>
              <ChevronRight aria-hidden="true" className="row-chevron" />
            </button>
          ))}
    </>
  );
}

/**
 * 成员：列表 → 详情。列全部成员，按 在职 / 候选 / 已停用 分组（切片 5 / 审计 M1：以前只列在职，候选、停用的看不到也管不了）。
 * 空状态 = 一句话 + 直达「添加成员」（审计 M2）。
 */
export function MembersPanel({ members, onOpen, onAdd, failed, onRetry }: { members: Member[]; onOpen: (m: Member) => void; onAdd?: () => void; failed?: boolean; onRetry?: () => void }) {
  const active = members.filter((m) => m.enabled && m.status === 'active');
  const candidates = members.filter((m) => m.enabled && m.status === 'candidate');
  const off = members.filter((m) => !m.enabled);
  return (
    <div className="panel">
      {/* 列表没读到：说清楚 + 重试，不假装「还没有成员」（切片 14） */}
      {failed && onRetry && <ErrorRetry text="成员列表没读到。" what="成员" onRetry={onRetry} />}
      {failed && members.length === 0 ? null : members.length === 0 ? (
        <Empty
          text="还没有成员。"
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
      ) : (
        <>
          {active.length > 0 && (
            <Group title={`在职（${active.length}）`}>
              <MemberRows list={active} onOpen={onOpen} />
            </Group>
          )}
          {candidates.length > 0 && (
            <Group title={`候选（${candidates.length}）`}>
              <MemberRows list={candidates} onOpen={onOpen} />
            </Group>
          )}
          {off.length > 0 && (
            <Group title={`已停用（${off.length}）`}>
              <MemberRows list={off} onOpen={onOpen} />
            </Group>
          )}
        </>
      )}
    </div>
  );
}

/**
 * 成员详情（切片 8）：启用 / 停用走 PATCH /api/members/:id {enabled}，入职走 POST /api/members/:id/onboard（只给所有者）。
 * 停用先确认；处理中锁住这几个按钮；结果只在 Core 回成功后播报，失败说清楚、按钮还能再点。
 */
export function MemberDetail({ member, onChat, onMention, onChanged }: { member: Member; onChat: () => void; onMention: () => void; onChanged?: (m: Member) => void }) {
  const { rows, reload } = useUsage(120_000);
  const row = rows?.find((r) => r.memberId === member.id);
  const ask = useAsk();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');
  const [err, setErr] = useState('');
  const canTalk = member.enabled && member.status === 'active';
  async function change(kind: 'enable' | 'disable' | 'onboard') {
    if (busy) return;
    if (kind === 'disable' && !(await ask.confirm({ title: `停用 ${member.name}？`, desc: '停用后 TA 不再回答，对话里也 @ 不到；随时可以再启用。', ok: '停用', danger: true }))) return;
    setBusy(true);
    setDone('');
    setErr('');
    try {
      const r =
        kind === 'onboard'
          ? await api<{ member: Member }>('POST', `/api/members/${encodeURIComponent(member.id)}/onboard`)
          : await api<{ member: Member }>('PATCH', `/api/members/${encodeURIComponent(member.id)}`, { enabled: kind === 'enable' });
      onChanged?.(r.member);
      setDone(kind === 'onboard' ? `${member.name} 已入职` : kind === 'enable' ? `已启用 ${member.name}` : `已停用 ${member.name}`);
    } catch (e) {
      setErr(errText(e, '没改成，请稍后再试'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="panel">
      {ask.node}
      <div className="profile">
        <Avatar name={member.name} size="lg" glyph={member.avatar} />
        <div>
          <p className="profile-name">{member.name}</p>
          <p className="muted">{statusLine(member)}</p>
        </div>
      </div>
      <div className="panel-actions">
        {/* 对话、@ 只认在职成员（ChatPage 的 members 只留 enabled && active）；停用、候选的不放点了没用的按钮（审计清单第 7 项） */}
        {canTalk && (
          <>
            <button type="button" className="btn btn-primary" onClick={onChat} aria-label={`和 ${member.name} 单独对话`}>
              单独聊
            </button>
            <button type="button" className="btn btn-outline" onClick={onMention} aria-label={`在当前对话里点名 ${member.name}`}>
              在当前对话里点名
            </button>
          </>
        )}
        {member.enabled && member.status === 'candidate' && !isFamily() && (
          <button type="button" className="btn btn-outline" disabled={busy} onClick={() => void change('onboard')} aria-label={`让 ${member.name} 入职`}>
            入职
          </button>
        )}
        {member.enabled ? (
          <button type="button" className="btn btn-outline" disabled={busy} onClick={() => void change('disable')} aria-label={`停用 ${member.name}`}>
            停用
          </button>
        ) : (
          <button type="button" className="btn btn-outline" disabled={busy} onClick={() => void change('enable')} aria-label={`启用 ${member.name}`}>
            启用
          </button>
        )}
      </div>
      {!canTalk && (
        <p className="note">
          {!member.enabled
            ? `${member.name} 已停用，启用后才能对话。`
            : member.status === 'candidate'
              ? `${member.name} 还是候选，入职后才能对话。`
              : `${member.name} 现在不能对话。`}
        </p>
      )}
      <p role="status" className="note">
        {done}
      </p>
      {err && (
        <p role="alert" className="note note-error">
          {err}
        </p>
      )}
      {(member.role || member.systemPrompt) && (
        <Group title="资料">
          {member.role && (
            <Field label="角色">
              <span>{member.role}</span>
            </Field>
          )}
          {member.systemPrompt && (
            <Field label="系统提示词">
              <span className="whitespace-pre-wrap">{member.systemPrompt}</span>
            </Field>
          )}
        </Group>
      )}
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
export type SettingsSection = 'profile' | 'prefs' | 'safety' | 'general' | 'family' | 'lead' | 'push' | 'budget' | 'external' | 'shortcuts';
export const SETTINGS_SECTIONS: { id: SettingsSection; label: string; sub: string; Icon: typeof Keyboard }[] = [
  { id: 'profile', label: '个人资料', sub: '你在 Aroomo 里的名字和登录账号。', Icon: UserRound },
  { id: 'prefs', label: '偏好', sub: '改动立即生效，不用保存。', Icon: SlidersHorizontal },
  { id: 'safety', label: '安全', sub: '密码、登录和敏感内容保护。', Icon: ShieldCheck },
  { id: 'general', label: '通用', sub: '这个 Aroomo 的概况和总额度。', Icon: Home },
  { id: 'family', label: '家人与邀请', sub: '家里谁在用 Aroomo。', Icon: Users },
  { id: 'lead', label: '负责人', sub: '对话里没有 @ 成员时，交给负责人回答。', Icon: UserRound },
  // X-08：总开关在服务器（PUSH_ENABLED，默认关）；关着时这一节只说一句「服务器还没有打开推送提醒」
  { id: 'push', label: '推送提醒', sub: '锁屏上收到一句提醒：助手做完了、有事等你确认。', Icon: BellRing },
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
      {section === 'push' && (
        <Suspense fallback={<p role="status" className="note panel-loading">正在加载…</p>}>
          <PushSection />
        </Suspense>
      )}
      {section === 'budget' && (
        <div className="group">
          <BudgetSection />
          <NavRow icon={<Monitor aria-hidden="true" />} label="电脑助手" value="哪些电脑、在做什么" onClick={() => onGo('executors')} />
        </div>
      )}
      {section === 'external' && <ExternalGroup />}
      {section === 'shortcuts' && <ShortcutList />}
    </section>
  );
}

/** 外部接入（MCP 配置 + 连接密码）：设置 › 外部接入和资源库 › 外部接入（/hub/mcp）共用这一组 */
function ExternalGroup() {
  return (
    <div className="group">
      <McpSection />
      <div className="row row-stack">
        <ClientTokensLazy />
      </div>
    </div>
  );
}

/** /hub/mcp：规范 §6 Hub 的「MCPs」一类，内容同设置 › 外部接入 */
export function ExternalPanel() {
  return (
    <div className="panel">
      <ExternalGroup />
    </div>
  );
}

/** 桌面 / 中等宽度：居中弹窗，左边分组、右边内容（照 sumus 05–12 号截图），右上角 × 关闭 */
export function SettingsDialog({ open, onClose, prefs, setPrefs, onGo, members, section: routed, onSection }: PrefsProps & GoProps & { open: boolean; onClose: () => void; section?: SettingsSection | undefined; onSection?: (s: SettingsSection) => void }) {
  const [own, setOwn] = useState<SettingsSection>('profile');
  // 分组由地址给（/settings/<分组>，切片 2）；没给就用自己记的
  const section = routed && visibleSections().some((x) => x.id === routed) ? routed : own;
  const setSection = (s: SettingsSection) => {
    setOwn(s);
    onSection?.(s);
  };
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
