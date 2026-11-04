/**
 * 对话顶栏标题 + 悬浮卡片（所有者 21:42 按 sumus 标注：标题悬浮时看这个对话 / 成员的详细信息）。
 * 鼠标停在标题上、键盘聚焦标题、点标题或右边的 ⓘ 都会打开；Esc 或移开就关。不做动画。
 * 卡片内容：头像、名字、类型、一句简介、模型、「查看成员」。
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ChevronRight, Info } from 'lucide-react';
import { Avatar, type AvatarKind } from './Avatar';

export function HeaderCard({ title, name, kind, type, intro, model, onView }: { title: ReactNode; name: string; kind: AvatarKind; type: string; intro: string; model: string; onView?: () => void }) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        setPinned(false);
      }
    };
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) {
        setOpen(false);
        setPinned(false);
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [open]);
  const toggle = () => {
    setPinned(!open);
    setOpen(!open);
  };
  return (
    <div className="hc" ref={box} onMouseLeave={() => !pinned && setOpen(false)}>
      <h1 id="chat-title" className="main-title">
        <button type="button" className="hc-trigger" aria-expanded={open} aria-controls={id} onMouseEnter={() => setOpen(true)} onClick={toggle}>
          {title}
        </button>
      </h1>
      <button type="button" className="btn btn-icon hc-info" aria-label="对话信息" title="对话信息" aria-expanded={open} aria-controls={id} onClick={toggle}>
        <Info aria-hidden="true" />
      </button>
      {open && (
        <div id={id} className="hc-card" role="group" aria-label={`${name} 的详细信息`}>
          <div className="hc-top">
            <Avatar name={name} kind={kind} size="lg" />
            <div>
              <p className="hc-name">{name}</p>
              <p className="muted">{type}</p>
            </div>
          </div>
          <p className="hc-intro">{intro}</p>
          <dl className="hc-meta">
            <dt>{kind === 'group' ? '成员' : '模型'}</dt>
            <dd>{model}</dd>
          </dl>
          {onView && (
            <button
              type="button"
              className="hc-view"
              onClick={() => {
                setOpen(false);
                onView();
              }}
            >
              <span>{kind === 'group' ? '查看成员' : kind === 'lead' ? '查看所有成员' : '查看成员'}</span>
              <ChevronRight aria-hidden="true" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
