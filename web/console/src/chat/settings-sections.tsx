/**
 * 设置里的个人资料 / 安全补充 / 通用 / 家人与邀请（落地文档 11.1 11.3 11.4 11.5）。
 * 从 views.tsx 拆出：设置页随对话页一起加载，资源库 / 工具 / API 三个面板改成点开才下载（#250 包体积 ≤150 KB gz）。
 */
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { ApiError, api, currentUser, logout } from '@/lib/api';
import { useUsage, worstRow } from '@/lib/usage';
import { Field, Group } from '@/pages/Settings';
import { Dialog, useAsk } from '@/components/Dialog';
import { QuotaRing } from '@/components/brand';
import type { Member } from '@/lib/api';
import { Avatar } from './Avatar';
import { quotaState } from './Rail';
import { DialogFoot, Empty, errText } from './ui';

// ---------------- 设置：个人资料、安全补充、通用、家人与邀请（落地文档 11.1 11.3 11.4 11.5） ----------------

interface Me {
  kind: string;
  user?: { id: string; email: string; displayName?: string; role: string; status?: string };
}
const ROLE_LABEL: Record<string, string> = { admin: '管理员', user: '家人', owner: '所有者' };

function useMe(): Me | null {
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => {
    let alive = true;
    api<Me>('GET', '/api/auth/me')
      .then((r) => alive && setMe(r))
      .catch(() => {
        const u = currentUser();
        if (alive) setMe(u ? { kind: 'user', user: { id: '', email: u.email, displayName: u.displayName, role: u.role } } : { kind: 'unknown' });
      });
    return () => {
      alive = false;
    };
  }, []);
  return me;
}

/** 个人资料：头像（名字首字）、名字、登录账号、身份。改名字 Core 还没有接口，先只读、不放保存键。 */
export function ProfileSection() {
  const me = useMe();
  if (!me) return <p className="note">正在加载…</p>;
  const u = me.user;
  const name = u?.displayName || (u ? u.email.split('@')[0]! : '所有者');
  return (
    <>
      <div className="profile">
        <Avatar name={name} kind="user" size="lg" />
        <div>
          <p className="profile-name">{name}</p>
          <p className="muted">{u ? (ROLE_LABEL[u.role] ?? u.role) : '所有者'}</p>
        </div>
      </div>
      <Group>
        <Field label="名字">
          <span>{name}</span>
        </Field>
        <Field label="登录账号">
          <span className="row-break">{u?.email ?? '用所有者密钥登录'}</span>
        </Field>
      </Group>
    </>
  );
}

/** 改密码（POST /api/auth/password）：只有账号登录时有；所有者密钥登录没有密码可改 */
export function PasswordRow() {
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState('');
  const [done, setDone] = useState('');
  const [busy, setBusy] = useState(false);
  if (!currentUser()) return null;
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    const currentPassword = String(d.get('current') ?? '');
    const newPassword = String(d.get('next') ?? '');
    if (!currentPassword || !newPassword) return setMsg('两栏都要填');
    if (newPassword.length < 10) return setMsg('新密码至少 10 位');
    setBusy(true);
    setMsg('');
    try {
      await api('POST', '/api/auth/password', { currentPassword, newPassword });
      setOpen(false);
      setDone('密码已改好');
    } catch (err) {
      setMsg(errText(err, '没改成，请稍后再试'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Field label="密码" {...(done ? { hint: done } : {})}>
        <button type="button" className="btn btn-outline" onClick={() => { setMsg(''); setOpen(true); }}>
          改密码
        </button>
      </Field>
      <Dialog open={open} title="改密码" onClose={() => setOpen(false)}>
        <form className="dlg-form" onSubmit={(e) => void submit(e)} noValidate>
          <label className="form-field">
            <span className="form-label">现在的密码</span>
            <input name="current" type="password" autoComplete="current-password" />
          </label>
          <label className="form-field">
            <span className="form-label">新密码</span>
            <input name="next" type="password" autoComplete="new-password" aria-describedby="pw-rule" />
            <span id="pw-rule" className="note">
              至少 10 位
            </span>
          </label>
          {msg && (
            <p role="alert" className="note note-error">
              {msg}
            </p>
          )}
          <DialogFoot onCancel={() => setOpen(false)} ok="改好了" busy={busy} />
        </form>
      </Dialog>
    </>
  );
}

/** 登录：退出所有设备（POST /api/auth/logout-all，包括这台）+ 退出登录。设备列表要 Core 会话列表接口，没有之前不显示。 */
export function SignOutGroup() {
  const ask = useAsk();
  const [msg, setMsg] = useState('');
  async function all() {
    if (!(await ask.confirm({ title: '退出所有设备？', desc: '包括这台。手机、别的电脑上的 Aroomo 都要重新登录。', ok: '全部退出', danger: true }))) return;
    try {
      await api('POST', '/api/auth/logout-all');
      await logout().catch(() => undefined);
    } catch (e) {
      setMsg(errText(e));
    }
  }
  return (
    <Group title="登录">
      {ask.node}
      {currentUser() && (
        <Field label="退出所有设备">
          <button type="button" className="btn btn-outline" onClick={() => void all()}>
            全部退出
          </button>
        </Field>
      )}
      <Field label="退出这台设备">
        <button type="button" className="btn btn-outline" onClick={() => void logout().catch((e: unknown) => setMsg(errText(e, '退出失败，请稍后再试')))}>
          退出登录
        </button>
      </Field>
      {msg && (
        <p role="alert" className="row-status">
          {msg}
        </p>
      )}
    </Group>
  );
}

interface UserRow {
  id: string;
  email: string;
  displayName?: string;
  role: string;
  status?: string;
  createdAt?: string;
}
function useUsers(): { users: UserRow[] | null; err: string } {
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let alive = true;
    api<{ users: UserRow[] }>('GET', '/api/users')
      .then((r) => alive && setUsers(r.users))
      .catch((e) => alive && setErr(e instanceof ApiError && e.status === 403 ? '这个账号不能看家人列表' : '家人列表加载失败'));
    return () => {
      alive = false;
    };
  }, []);
  return { users, err };
}

/** 通用（只有所有者）：空间名、身份、人数、总额度卡（圆环 + 一个词 + 看各成员用量） */
export function GeneralSection({ members, onUsage }: { members: Member[]; onUsage: () => void }) {
  const { users } = useUsers();
  const { rows } = useUsage(120_000);
  const worst = worstRow(rows);
  const q = quotaState(worst ?? undefined);
  const family = users?.filter((u) => u.role === 'user').length;
  const me = currentUser();
  return (
    <>
      <Group>
        <Field label="空间">
          <span>Aroomo</span>
        </Field>
        <Field label="你的身份">
          <span>{me ? (ROLE_LABEL[me.role] ?? me.role) : '所有者'}</span>
        </Field>
        <Field label="家人">
          <span>{family == null ? '—' : `${family} 位`}</span>
        </Field>
        <Field label="AI 成员">
          <span>{members.length} 位</span>
        </Field>
      </Group>
      <Group title="总额度">
        <div className="row">
          <QuotaRing used={worst?.quota.used} limit={worst?.quota.limit} size={28} />
          <span className="row-text">
            <span className="row-label">{rows ? q.label : '额度查不到'}</span>
            {rows && <span className="row-hint">今天一共 {rows.reduce((s, r) => s + r.today.requests, 0)} 次</span>}
          </span>
          <button type="button" className="btn btn-outline" onClick={onUsage}>
            看各成员用量 ↗
          </button>
        </div>
      </Group>
    </>
  );
}

/**
 * 家人与邀请（只有所有者）：家人 / 身份 / 状态。
 * 「添加家人」按负责人裁决：多用户隔离修好、两个账号测过之前不开放，所以先不放按钮；本期额度要 Core 按账号统计用量，暂不显示。
 */
export function FamilySection() {
  const { users, err } = useUsers();
  const list = useMemo(() => (users ?? []).filter((u) => u.role !== 'owner'), [users]);
  if (err) return <p role="alert" className="note note-error">{err}</p>;
  if (!users) return <p className="note">正在加载…</p>;
  if (list.length === 0) return <Empty text="还没有家人。" />;
  return (
    <ul className="group" aria-label="家人">
      {list.map((u) => (
        <li key={u.id} className="row">
          <Avatar name={u.displayName || u.email} kind="user" size="sm" />
          <span className="row-text">
            <span className="row-label">{u.displayName || u.email.split('@')[0]}</span>
            <span className="row-hint row-break">{u.email}</span>
          </span>
          <span className="row-value">
            {ROLE_LABEL[u.role] ?? u.role}
            {u.status === 'disabled' ? ' · 已停用' : ''}
          </span>
        </li>
      ))}
    </ul>
  );
}

