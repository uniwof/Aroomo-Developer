import { useState, type FormEvent } from 'react';
import { Logo } from '@/components/brand';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ApiError, login } from '@/lib/api';

export function Login({ onLoggedIn }: { onLoggedIn?: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await login(email.trim(), password);
      setPassword('');
      onLoggedIn?.();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? '邮箱或密码不对' : err instanceof Error ? err.message : '登录失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4" aria-labelledby="login-title">
        <div className="flex flex-col items-center gap-3 pb-2">
          <Logo size={56} />
          <h1 id="login-title" className="text-[20px] font-semibold">
            登录 Aroomo 控制台
          </h1>
        </div>
        <label className="block space-y-1">
          <span>邮箱</span>
          <Input type="email" name="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="block space-y-1">
          <span>密码</span>
          <Input
            type="password"
            name="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && (
          <p role="alert" className="text-[#d70015]">
            {error}
          </p>
        )}
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? '正在登录…' : '登录'}
        </Button>
      </form>
    </main>
  );
}
