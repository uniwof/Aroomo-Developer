/**
 * Skin/Bones 右侧抽屉（Poke #250 补充规范 Bones 第 2 条，切片 2）。开关 SKIN_BONES 关着时整个文件不被引用（ChatPage 懒加载，#323 写法）。
 * - 两档宽：常规 480 = 30 × --k、宽 640 = 40 × --k（--k = 1rem，跟字号滑杆一起缩放）；窄于 680px（42.5em）整屏。
 * - 原生 <dialog> + showModal，和全站唯一那种弹窗（components/Dialog.tsx）同一做法：背后页面 inert、焦点关在抽屉里（平台自带）、
 *   Esc / 点背景 / 「关闭」都能关、打开后焦点到第一个可操作元素、关上后回到打开它的按钮。无动画。
 * - 这里只管长相：开着哪个、多宽都由地址说了算，ChatPage 读 drawer-query 解析、回调写回地址（这个文件不碰路由，
 *   免得 drawer-query 被两个块共用而被提到对话页主包里）。
 * 切片 2 只有一个示例抽屉（preview），内容等资产区接上后再换成真的。
 */
import { useEffect, useId, useRef } from 'react';
import { X } from 'lucide-react';

/** 已知的抽屉：id → 标题。shortcut: 只有一个示例，资产区 / 任务抽屉做的时候往这里加 */
const TITLES: Record<string, string> = { preview: '详情' };

export default function SideDrawer({ id, wide, onClose, onWide }: { id: string; wide: boolean; onClose: () => void; onWide: (wide: boolean) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const title = TITLES[id];
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    const back = document.activeElement;
    if (!d.open) (d.showModal ? d.showModal() : d.setAttribute('open', ''));
    d.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    return () => {
      if (back instanceof HTMLElement && back.isConnected) back.focus();
    };
  }, []);
  // 地址里是没见过的 id：当关着处理，不弹一个空抽屉
  if (!title) return null;
  return (
    <dialog
      ref={ref}
      className={wide ? 'sdrawer sdrawer-wide' : 'sdrawer'}
      aria-labelledby={titleId}
      aria-modal="true"
      // Esc：浏览器先发 keydown 再发 cancel；这里拦 keydown 自己关（jsdom 不发 cancel），cancel 兜底（手机返回键等）
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        onClose();
      }}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="sdrawer-head">
        <h2 id={titleId} className="sdrawer-title">
          {title}
        </h2>
        <button type="button" className="icon-btn hit" aria-label="关闭" data-autofocus="" onClick={onClose}>
          <X aria-hidden="true" />
        </button>
      </div>
      <div className="sdrawer-body panel">
        <p>这里会放选中项的详情，还没有接上。</p>
        <button type="button" className="btn btn-outline" aria-pressed={wide} onClick={() => onWide(!wide)}>
          {wide ? '改回常规宽度' : '加宽'}
        </button>
      </div>
    </dialog>
  );
}
