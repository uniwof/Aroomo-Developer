/**
 * 全站唯一一种弹窗（#250 统一风格，照 sumus「New agent」弹窗）：原生 <dialog> + showModal。
 * - 背后页面自动 inert；Esc、点背景、「取消」都能关；打开后焦点到第一个输入框或主按钮；关上后焦点回到打开它的按钮。
 * - 外观只用 index.css 的 .dlg / .dlg-title / .dlg-desc / .dlg-foot 和 .btn，不另起样式。
 * useAsk() 代替浏览器自带的 window.confirm / window.prompt（那两个是系统原始样式、读屏和字号都不跟随）。
 */
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';

export function Dialog(props: { open: boolean; title: string; desc?: string; children?: ReactNode; onClose: () => void; className?: string; nav?: ReactNode }) {
  // 只在打开时挂载：关上就整个移除（读屏和测试都不会读到一个藏着的空弹窗）
  return props.open ? <OpenDialog {...props} /> : null;
}

function OpenDialog({ title, desc, children, onClose, className, nav }: { title: string; desc?: string; children?: ReactNode; onClose: () => void; className?: string; nav?: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    const back = document.activeElement;
    if (!d.open) (d.showModal ? d.showModal() : d.setAttribute('open', ''));
    const first = d.querySelector<HTMLElement>('[data-autofocus]') ?? d.querySelector<HTMLElement>('input, textarea, select, .btn-primary, button');
    first?.focus();
    return () => {
      if (back instanceof HTMLElement && back.isConnected) back.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={className ? `dlg ${className}` : 'dlg'}
      aria-labelledby={`${id}-t`}
      aria-describedby={desc ? `${id}-d` : undefined}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      {nav ? (
        // 左右两栏（设置）：左边标题 + 分组导航，右边内容
        <div className="dlg-split">
          <div className="dlg-nav">
            <h2 id={`${id}-t`} className="dlg-title">
              {title}
            </h2>
            {nav}
          </div>
          <div className="dlg-main">{children}</div>
        </div>
      ) : (
      <div className="dlg-body">
        <h2 id={`${id}-t`} className="dlg-title">
          {title}
        </h2>
        {desc && (
          <p id={`${id}-d`} className="dlg-desc">
            {desc}
          </p>
        )}
        {children}
      </div>
      )}
    </dialog>
  );
}

type Ask =
  | { kind: 'confirm'; title: string; desc?: string; ok: string; danger?: boolean; resolve: (v: boolean) => void }
  | { kind: 'prompt'; title: string; desc?: string; ok: string; label: string; value: string; resolve: (v: string | null) => void };

/** 确认 / 输入一行字：await confirm({...}) 得到 true/false，await prompt({...}) 得到文字或 null */
export function useAsk() {
  const [ask, setAsk] = useState<Ask | null>(null);
  const [text, setText] = useState('');
  const confirm = useCallback(
    (o: { title: string; desc?: string; ok?: string; danger?: boolean }) => new Promise<boolean>((resolve) => setAsk({ kind: 'confirm', ok: '确定', ...o, resolve })),
    [],
  );
  const prompt = useCallback(
    (o: { title: string; label: string; value?: string; desc?: string; ok?: string }) =>
      new Promise<string | null>((resolve) => {
        setText(o.value ?? '');
        setAsk({ kind: 'prompt', ok: '保存', value: o.value ?? '', ...o, resolve });
      }),
    [],
  );
  const done = (v: boolean) => {
    if (!ask) return;
    if (ask.kind === 'confirm') ask.resolve(v);
    else ask.resolve(v ? text : null);
    setAsk(null);
  };
  const node = (
    <Dialog open={!!ask} title={ask?.title ?? ''} {...(ask?.desc ? { desc: ask.desc } : {})} onClose={() => done(false)}>
      {ask && (
        <form
          method="dialog"
          className="dlg-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (ask.kind === 'prompt' && !text.trim()) return;
            done(true);
          }}
        >
          {ask.kind === 'prompt' && (
            <label className="form-field">
              <span className="form-label">{ask.label}</span>
              <input value={text} maxLength={60} required onChange={(e) => setText(e.target.value)} />
            </label>
          )}
          <div className="dlg-foot">
            <button type="button" className="btn btn-quiet" onClick={() => done(false)} {...(ask.kind === 'confirm' && ask.danger ? { 'data-autofocus': true } : {})}>
              取消
            </button>
            <button type="submit" className={ask.kind === 'confirm' && ask.danger ? 'btn btn-primary btn-danger-fill' : 'btn btn-primary'} {...(ask.kind === 'confirm' && !ask.danger ? { 'data-autofocus': true } : {})}>
              {ask.ok}
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
  return { confirm, prompt, node };
}
