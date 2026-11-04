import { useState, type FormEvent } from 'react';
import { Logo } from '@/components/brand';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';

/** 凭一次性链接设密码：/console/accept?token=…（未登录可打开），调 Core POST /auth/accept */
export function Accept({ fetchImpl = fetch }: { fetchImpl?: typeof fetch }) {
  const token = new URLSearchParams(window.location.search).get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (!token) return setError('链接无效，请重新获取设密码链接');
    if (password.length < 10) return setError('密码至少 10 位');
    if (password !== confirm) return setError('两次输入的密码不一样');
    setBusy(true);
    try {
      await api('POST', '/auth/accept', { token, password }, fetchImpl);
      setPassword('');
      setConfirm('');
      setDone(true);
      setTimeout(() => window.location.assign('/console/'), 1500);
    } catch {
      setError('设置失败：链接可能已用过或已过期，请重新获取');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4" aria-labelledby="accept-title">
        <div className="flex flex-col items-center gap-3 pb-2">
          <Logo size={56} />
          <h1 id="accept-title" className="text-[1.25rem] font-semibold">
            设置 Aroomo 密码
          </h1>
        </div>
        {done ? (
          <p role="status">密码已设好，正在打开登录页…</p>
        ) : (
          <>
            <label className="block space-y-1">
              <span>新密码</span>
              <Input type="password" id="password" name="password" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
            <label className="block space-y-1">
              <span>确认密码</span>
              <Input type="password" name="confirm" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </label>
            {error && (
              <p role="alert" className="text-[#d70015]">
                {error}
              </p>
            )}
            <Button type="submit" className="min-h-11 w-full" disabled={busy}>
              {busy ? '正在设置…' : '设置密码'}
            </Button>
          </>
        )}
      </form>
    </main>
  );
}
