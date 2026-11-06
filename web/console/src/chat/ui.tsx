/** 面板和设置共用的小零件（views 懒加载后，设置分组仍要用它们，所以单独放；#250 包体积） */
import type { ReactNode } from 'react';
import { ApiError } from '@/lib/api';

export const errText = (e: unknown, fallback = '出错了，请稍后再试') => (e instanceof ApiError ? e.message : fallback);

/** 空状态：一句话 + 一个动作 */
export function Empty({ text, action }: { text: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty-text">{text}</p>
      {action}
    </div>
  );
}

/** 弹窗底部：取消 + 主按钮 */
export function DialogFoot({ onCancel, ok, busy, disabled }: { onCancel: () => void; ok: string; busy?: boolean; disabled?: boolean }) {
  return (
    <div className="dlg-foot">
      <button type="button" className="btn btn-quiet" onClick={onCancel}>
        取消
      </button>
      <button type="submit" className="btn btn-primary" disabled={busy || disabled}>
        {busy ? '正在保存…' : ok}
      </button>
    </div>
  );
}
