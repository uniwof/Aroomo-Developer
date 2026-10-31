/**
 * 确认卡（D63）：重要操作两步确认。标题 → 全部后果 → 「继续」→ 第二个按钮带 3 秒倒计时 → 拿到一次性令牌，交给 onToken 重发原请求。
 * 令牌不缓存、不显示。手机和电脑同一个组件。约定见 docs/architecture/CONFIRM-CARD.md。
 */
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ApiError, api, type Challenge } from '@/lib/api';

interface StepResult {
  confirm: Challenge;
  confirmToken?: string;
}

const ERR_TEXT: Record<string, string> = {
  CONFIRM_EXPIRED: '这张确认卡过期了，请重新操作',
  CONFIRM_USED: '这张确认卡已经用过，请重新操作',
  CONFIRM_INVALID: '这张确认卡无效，请重新操作',
  FORBIDDEN: '这个账号不能完成重要确认，请用所有者账号',
  ACCESS_REAUTH_NOT_CONFIGURED: '服务器还没配置身份验证，暂时不能做这个操作',
};
/** 这些错误说明卡片已经作废，要关掉重来 */
const DEAD = new Set(['CONFIRM_EXPIRED', 'CONFIRM_USED', 'CONFIRM_INVALID', 'FORBIDDEN', 'ACCESS_REAUTH_NOT_CONFIGURED']);

export function ConfirmCard({
  challenge,
  onToken,
  onCancel,
}: {
  challenge: Challenge;
  /** 拿到令牌后重发原请求；抛错时卡片显示错误 */
  onToken: (token: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [c, setC] = useState(challenge);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [left, setLeft] = useState(0);
  const [dead, setDead] = useState(false);

  // 第二步按钮倒计时：以服务端给的 step2NotBefore 为准
  useEffect(() => {
    if (c.nextStep !== 2 || !c.step2NotBefore) return;
    const target = new Date(c.step2NotBefore).getTime();
    const tick = () => setLeft(Math.max(0, Math.ceil((target - Date.now()) / 1000)));
    tick();
    const t = setInterval(tick, 250);
    return () => clearInterval(t);
  }, [c.nextStep, c.step2NotBefore]);

  async function step(n: 1 | 2) {
    setBusy(true);
    setMsg('');
    try {
      const r = await api<StepResult>('POST', c.stepUrl, { step: n });
      setC(r.confirm);
      if (r.confirmToken) await onToken(r.confirmToken);
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.code === 'CONFIRM_TOO_EARLY') {
          setLeft(Math.ceil((e.retryAfterMs ?? 1000) / 1000));
          setMsg('还差一点点，稍等再点');
        } else if (e.code === 'ACCESS_REAUTH_REQUIRED') {
          setMsg('需要重新验证身份：请先重新登录一次，再回来点这个按钮');
        } else {
          setMsg(ERR_TEXT[e.code] ?? e.message);
          if (DEAD.has(e.code)) setDead(true);
        }
      } else setMsg('操作失败，请稍后再试');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div role="alertdialog" aria-labelledby={`cc-${c.id}`} className="space-y-3 rounded-xl border-2 border-[var(--border)] p-4">
      <h3 id={`cc-${c.id}`} className="text-[16px] font-semibold">
        {c.title}
      </h3>
      <ul className="list-disc space-y-1 pl-5">
        {c.consequences.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
      {c.requiresAccessReauth && c.nextStep === 2 && <p>这一步涉及凭据，需要先重新验证身份。</p>}
      {msg && <p role="status">{msg}</p>}
      <div className="flex flex-wrap gap-6">
        {!dead && c.nextStep === 1 && (
          <Button disabled={busy} onClick={() => void step(1)}>
            继续
          </Button>
        )}
        {!dead && c.nextStep === 2 && (
          <Button disabled={busy || left > 0} onClick={() => void step(2)} aria-label={left > 0 ? `${c.confirmLabel}，还要等 ${left} 秒` : c.confirmLabel}>
            {left > 0 ? `${c.confirmLabel}（${left}）` : c.confirmLabel}
          </Button>
        )}
        <Button variant="outline" onClick={onCancel}>
          {dead ? '关闭' : '取消'}
        </Button>
      </div>
    </div>
  );
}
