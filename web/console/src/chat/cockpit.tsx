/**
 * /console 驾驶舱（Poke 规范 §3；docs/api/design-poke-data-v1.md）：只用现有 Core 接口，不加新样式。
 * 指标：在职成员、工作中（成员 activity）→ /team；等你处理（/api/inbox/unread-count）→ /inbox；资源库能力数（/api/capabilities，只给所有者）→ /hub。
 * 最近动态：审计记录最新 10 条（只给所有者）；能打开的对象（成员、收件箱、会话）是按钮，打不开的只是一行字，不装作能点。
 * 读不到的不编数字：写「没读到」并给「重试」。
 */
import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, isFamily, type Member } from '@/lib/api';
import { Group } from '@/pages/Settings';
import { actorText, RESULT_LABEL, type AuditRow } from '@/pages/Audit';
import { ErrorRetry } from '@/components/ErrorRetry';
import { NavRow } from './panels';

type Go = 'members' | 'inbox' | 'library';

interface Data {
  inbox: number | null;
  capabilities: number | null;
  activity: AuditRow[] | null;
  at: Date;
}

const hm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

export function Cockpit({
  members,
  membersFailed,
  onGo,
  onOpenMember,
  onOpenConversation,
}: {
  members: Member[];
  membersFailed?: boolean;
  onGo: (to: Go) => void;
  onOpenMember: (id: string) => void;
  onOpenConversation: (id: string) => void;
}) {
  const owner = !isFamily();
  const [data, setData] = useState<Data | null>(null);
  const [failed, setFailed] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    const bad: string[] = [];
    const get = async <T,>(what: string, fn: () => Promise<T>): Promise<T | null> => {
      try {
        return await fn();
      } catch (e) {
        // 没权限不算读失败（家人账号本来就看不到）
        if (!(e instanceof ApiError && e.status === 403)) bad.push(what);
        return null;
      }
    };
    const [inbox, caps, audit] = await Promise.all([
      get('收件箱', () => api<{ total: number }>('GET', '/api/inbox/unread-count').then((r) => r.total)),
      owner ? get('资源库', () => api<{ items?: unknown[] }>('GET', '/api/capabilities').then((r) => (r.items ?? []).length)) : Promise.resolve(null),
      owner ? get('最近动态', () => api<{ entries: AuditRow[] }>('GET', '/api/audit?limit=10').then((r) => r.entries)) : Promise.resolve(null),
    ]);
    setData({ inbox, capabilities: caps, activity: audit, at: new Date() });
    setFailed(bad);
    setBusy(false);
  }, [owner]);
  useEffect(() => {
    void load();
  }, [load]);

  const active = members.filter((m) => m.enabled && m.status === 'active');
  const working = members.filter((m) => m.activity?.state === 'working');
  const hasActivity = members.some((m) => m.activity);
  const num = (n: number | null | undefined) => (n == null ? '没读到' : String(n));

  /** 审计记录里的对象能不能打开：成员、收件箱、会话；其余只显示 */
  const opener = (r: AuditRow): (() => void) | null => {
    if (r.target.type === 'member') return () => onOpenMember(r.target.id);
    if (r.target.type === 'inbox') return () => onGo('inbox');
    if (r.target.type === 'conversation') return () => onOpenConversation(r.target.id);
    return null;
  };

  return (
    <div className="panel">
      <p role="status" className="note">
        {busy ? '正在更新…' : data ? `更新于 ${hm(data.at)}` : ''}
      </p>
      <div className="panel-actions">
        <button type="button" className="btn btn-outline" disabled={busy} onClick={() => void load()} aria-label="刷新驾驶舱">
          刷新
        </button>
      </div>
      {failed.length > 0 && <ErrorRetry text={`${failed.join('、')}没读到。`} what="驾驶舱" onRetry={() => void load()} />}
      <Group title="概览">
        <NavRow label="在职成员" value={membersFailed ? '没读到' : String(active.length)} onClick={() => onGo('members')} />
        {hasActivity && <NavRow label="工作中" value={String(working.length)} onClick={() => onGo('members')} />}
        <NavRow label="等你处理" value={data ? num(data.inbox) : '…'} onClick={() => onGo('inbox')} />
        {owner && <NavRow label="资源库能力" value={data ? num(data.capabilities) : '…'} onClick={() => onGo('library')} />}
      </Group>
      {owner && (
        <Group title="最近动态">
          {data === null ? (
            <p className="row muted">加载中…</p>
          ) : data.activity === null ? (
            <p className="row muted">最近动态没读到。</p>
          ) : data.activity.length === 0 ? (
            <p className="row muted">还没有动态。</p>
          ) : (
            data.activity.map((r) => {
              const open = opener(r);
              const label = `${actorText(r.actor, {})} · ${r.action}`;
              const hint = `${r.target.type} ${r.target.id} · ${RESULT_LABEL[r.result] ?? r.result} · ${new Date(r.ts).toLocaleString('zh-CN', { hour12: false })}`;
              return open ? (
                <button key={r.id} type="button" className="row row-button" onClick={open} aria-label={`打开：${label}，${hint}`}>
                  <span className="row-text">
                    <span className="row-label">{label}</span>
                    <span className="row-hint">{hint}</span>
                  </span>
                </button>
              ) : (
                <div key={r.id} className="row">
                  <span className="row-text">
                    <span className="row-label">{label}</span>
                    <span className="row-hint">{hint}</span>
                  </span>
                </div>
              );
            })
          )}
        </Group>
      )}
    </div>
  );
}
