/**
 * 设置（从旧 Shell /aroomo/settings 迁来）：负责人、敏感内容保护、执行员提醒、外部接入（MCP 配置复制 + 客户端令牌）、账号。
 * #250 重设计：不用标签页，改成 iOS / sumus 式分组列表（一组一个小标题，组内一行一项），一页看完。
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { ApiError, api, logout, type Member } from '@/lib/api';
import { ClientTokens } from '@/components/ClientTokens';

interface LeadSetting {
  leadId: string | null;
  effectiveLeadId: string | null;
  auto: boolean;
}

/** 分组列表里的一行：左边名称和说明，右边控件（放不下时控件换到下一行） */
export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="row row-field">
      <div className="row-text">
        <div className="row-label">{label}</div>
        {hint && <div className="row-hint">{hint}</div>}
      </div>
      <div className="row-control">{children}</div>
    </div>
  );
}

/** 一组：小标题 + 圆角分组列表 */
export function Group({ title, children, footer }: { title?: string; children: ReactNode; footer?: string }) {
  return (
    <section className="group-block" aria-label={title}>
      {title && <h2 className="group-title">{title}</h2>}
      <div className="group">{children}</div>
      {footer && <p className="group-footer">{footer}</p>}
    </section>
  );
}

function errText(e: unknown) {
  if (e instanceof ApiError && e.status === 403) return '这个账号还不能改这一项（等后台开放账号权限）';
  return e instanceof Error ? e.message : '出错了，请稍后再试';
}

export function LeadSection() {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [lead, setLead] = useState<LeadSetting | null>(null);
  const [msg, setMsg] = useState('');

  const load = useCallback(() => {
    Promise.all([api<{ members: Member[] }>('GET', '/api/members'), api<LeadSetting>('GET', '/api/settings/lead')])
      .then(([m, l]) => {
        setMembers(m.members);
        setLead(l);
      })
      .catch((e) => setMsg(errText(e)));
  }, []);
  useEffect(load, [load]);

  if (!members || !lead) return <p className="muted">{msg || '正在加载…'}</p>;
  const active = members.filter((m) => m.enabled && m.status !== 'candidate');
  const eligible = active.filter((m) => m.leadEligible);
  const effective = eligible.find((m) => m.id === lead.effectiveLeadId);

  async function change(value: string) {
    setMsg('');
    try {
      await api('PUT', '/api/settings/lead', { leadId: value || null });
      setMsg('已保存');
      load();
    } catch (e) {
      setMsg(errText(e));
    }
  }

  return (
    <>
      <Field label="负责人">
        {eligible.length === 0 ? (
          <span className="muted">还没有合格的成员</span>
        ) : (
          <select
            aria-label="负责人"
            className="field-select"
            value={lead.auto ? '' : (lead.leadId ?? '')}
            onChange={(e) => void change(e.target.value)}
          >
            <option value="">自动（第一个合格的成员）</option>
            {eligible.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field label="当前生效">
        <span>
          {effective ? effective.name : '—'}
          {lead.auto && effective ? '（自动）' : ''}
        </span>
      </Field>
      {msg && (
        <p role="status" className="row-status">
          {msg}
        </p>
      )}
    </>
  );
}

export function SecuritySection() {
  const [on, setOn] = useState<boolean | null>(null);
  const [msg, setMsg] = useState('');
  useEffect(() => {
    api<{ sensitiveProtect: boolean }>('GET', '/api/settings/security')
      .then((r) => setOn(r.sensitiveProtect))
      .catch((e) => setMsg(errText(e)));
  }, []);

  async function toggle() {
    if (on == null) return;
    const next = !on;
    setOn(next);
    setMsg('');
    try {
      await api('PUT', '/api/settings/security', { sensitiveProtect: next });
      setMsg(next ? '已开启敏感内容保护' : '已关闭敏感内容保护');
    } catch (e) {
      setOn(!next);
      setMsg(errText(e));
    }
  }

  return (
    <>
      <Field label="敏感内容保护" hint="含密码、卡号、Key 的消息不发给外部成员">
        {on == null ? (
          <span className="muted">—</span>
        ) : (
          <button
            type="button"
            role="switch"
            aria-checked={on}
            aria-label="敏感内容保护"
            onClick={() => void toggle()}
            className="switch"
          >
            <span className="switch-knob" />
          </button>
        )}
      </Field>
      {msg && (
        <p role="status" className="row-status">
          {msg}
        </p>
      )}
    </>
  );
}

interface Budget {
  daily: number;
  today?: { total: number; loud: number; quiet: number };
}

/** 打扰预算（D100）：每天最多让本机执行员「喊你」几次；超出的接管卡静默躺在收件箱，30 分钟没人处理就自动取消 */
export function BudgetSection() {
  const [b, setB] = useState<Budget | null>(null);
  const [msg, setMsg] = useState('');
  useEffect(() => {
    api<Budget>('GET', '/api/interrupt-budget')
      .then(setB)
      .catch((e) => setMsg(errText(e)));
  }, []);

  async function change(delta: number) {
    if (!b) return;
    const next = Math.min(50, Math.max(0, b.daily + delta));
    if (next === b.daily) return;
    setMsg('');
    try {
      await api('PUT', '/api/interrupt-budget', { daily: next });
      setB({ ...b, daily: next });
      setMsg(`已保存：每天最多提醒你 ${next} 次`);
    } catch (e) {
      setMsg(errText(e));
    }
  }

  const btn = 'btn btn-outline btn-square';
  return (
    <>
      <Field
        label="每天最多打扰我几次"
        hint={b?.today ? `今天提醒了 ${b.today.loud} 次，静默 ${b.today.quiet} 次。付款每次都提醒。` : '付款每次都提醒。'}
      >
        {b ? (
          <div className="flex items-center gap-2">
            <button type="button" aria-label="减少一次" className={btn} disabled={b.daily <= 0} onClick={() => void change(-1)}>
              −
            </button>
            <span aria-label="每天提醒次数" className="stepper-value">
              {b.daily}
            </span>
            <button type="button" aria-label="增加一次" className={btn} disabled={b.daily >= 50} onClick={() => void change(1)}>
              +
            </button>
          </div>
        ) : (
          <span className="muted">—</span>
        )}
      </Field>
      {msg && (
        <p role="status" className="row-status">
          {msg}
        </p>
      )}
    </>
  );
}

interface McpConfig {
  url: string;
  config: unknown;
}

/** MCP 连接配置一键复制（D195）：只含地址和令牌占位符，令牌本身不在这里出现 */
export function McpSection() {
  const [cfg, setCfg] = useState<McpConfig | null>(null);
  const [msg, setMsg] = useState('');
  useEffect(() => {
    api<McpConfig>('GET', '/api/mcp/config')
      .then(setCfg)
      .catch((e) => setMsg(errText(e)));
  }, []);

  async function copy() {
    if (!cfg) return;
    const text = JSON.stringify(cfg.config, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      setMsg('已复制。把 <YOUR_ARC_TOKEN> 换成下面新建的连接密码，再粘贴到那个软件里。');
    } catch {
      setMsg('这个浏览器不让自动复制，请长按下面的文字手动复制。');
    }
  }

  return (
    <>
      <Field label="连接设置" hint="在 Claude、Cursor 里用 Aroomo">
        <Button variant="outline" disabled={!cfg} onClick={() => void copy()}>
          复制配置
        </Button>
      </Field>
      {cfg && (
        <pre aria-label="连接设置内容" tabIndex={0} className="row-pre">
          {JSON.stringify(cfg.config, null, 2)}
        </pre>
      )}
      {msg && (
        <p role="status" className="row-status">
          {msg}
        </p>
      )}
    </>
  );
}

/** 设置的各组（对话页的设置弹窗 / 整页按组取用；控制台 /settings 一页全显示） */
export function LeadGroup() {
  return (
    <Group title="负责人与安全">
      <LeadSection />
      <SecuritySection />
    </Group>
  );
}
export function BudgetGroup() {
  return (
    <Group title="电脑助手提醒">
      <BudgetSection />
    </Group>
  );
}
export function ExternalGroup() {
  return (
    <Group title="外部接入">
      <McpSection />
      <ClientTokens />
    </Group>
  );
}
export function AccountGroup() {
  return (
    <Group title="登录">
      <Field label="退出登录" hint="退出后要重新输入邮箱和密码">
        <Button variant="outline" onClick={() => void logout()}>
          退出登录
        </Button>
      </Field>
    </Group>
  );
}

export function SettingsGroups() {
  return (
    <>
      <LeadGroup />
      <BudgetGroup />
      <ExternalGroup />
      <AccountGroup />
    </>
  );
}

export function Settings() {
  return (
    <section aria-labelledby="settings-title" className="page">
      <h1 id="settings-title" className="page-title">
        设置
      </h1>
      <SettingsGroups />
    </section>
  );
}
