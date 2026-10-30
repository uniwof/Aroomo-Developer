/** 设置（从旧 Shell /aroomo/settings 迁来）：负责人、敏感内容保护、账号。客户端令牌与 MCP 配置复制等后台线 API。 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { ApiError, api, logout, type Member } from '@/lib/api';

interface LeadSetting {
  leadId: string | null;
  effectiveLeadId: string | null;
  auto: boolean;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <div className="font-medium">{label}</div>
        {hint && <div className="text-[var(--muted)]">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function errText(e: unknown) {
  if (e instanceof ApiError && e.status === 403) return '这个账号还不能改这一项（等后台开放账号权限）';
  return e instanceof Error ? e.message : '出错了，请稍后再试';
}

function LeadSection() {
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

  if (!members || !lead) return <p className="text-[var(--muted)]">{msg || '正在加载…'}</p>;
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
      <Field label="负责人" hint="对话里没有 @ 成员时，交给负责人回答。负责人要能文字对话、上下文 ≥32k、支持工具调用。">
        {eligible.length === 0 ? (
          <span className="text-[var(--muted)]">还没有合格的成员</span>
        ) : (
          <select
            aria-label="负责人"
            className="min-h-11 rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3"
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
        <p role="status" className="text-[var(--muted)]">
          {msg}
        </p>
      )}
    </>
  );
}

function SecuritySection() {
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
      <Field label="敏感内容保护" hint="开着时，含密码、银行卡号、Key 等敏感信息的消息不发给外部成员（默认开）">
        {on == null ? (
          <span className="text-[var(--muted)]">—</span>
        ) : (
          <button
            type="button"
            role="switch"
            aria-checked={on}
            aria-label="敏感内容保护"
            onClick={() => void toggle()}
            className={`relative inline-flex h-11 w-16 items-center rounded-full transition-colors ${on ? 'bg-brand' : 'bg-[var(--border)]'}`}
          >
            <span className={`inline-block size-7 rounded-full bg-white shadow transition-transform ${on ? 'translate-x-8' : 'translate-x-1'}`} />
          </button>
        )}
      </Field>
      {msg && (
        <p role="status" className="text-[var(--muted)]">
          {msg}
        </p>
      )}
    </>
  );
}

export function Settings() {
  return (
    <section aria-labelledby="settings-title" className="space-y-6">
      <h1 id="settings-title" className="text-[20px] font-semibold">
        设置
      </h1>
      <div className="divide-y divide-[var(--border)] rounded-2xl bg-[var(--card)] px-4">
        <LeadSection />
      </div>
      <h2 className="text-[16px] font-semibold">安全</h2>
      <div className="divide-y divide-[var(--border)] rounded-2xl bg-[var(--card)] px-4">
        <SecuritySection />
      </div>
      <h2 className="text-[16px] font-semibold">账号</h2>
      <div className="rounded-2xl bg-[var(--card)] px-4">
        <Field label="登录" hint="退出后要重新输入邮箱和密码">
          <Button variant="outline" onClick={() => void logout()}>
            退出登录
          </Button>
        </Field>
      </div>
      <p className="text-[var(--muted)]">外部客户端令牌与 MCP 配置复制即将上线。</p>
    </section>
  );
}
