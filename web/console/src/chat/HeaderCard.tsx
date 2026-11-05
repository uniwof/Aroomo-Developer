/**
 * 对话顶栏（照 sumus）：左边头像 + 名字（悬浮出详细信息卡）+ 话题小标签，右边 ⓘ 和 ···。
 * 鼠标停在名字上、键盘聚焦后按回车、点名字或右边的 ⓘ 都会打开卡片；Esc、点外面或移开就关。不做动画。
 * 卡片内容（照 sumus 的悬浮卡）：头像、名字、类型；一句简介；分隔线；模型；底部「查看成员 ↗」。
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ArrowUpRight, Info } from 'lucide-react';
import { Avatar, type AvatarKind } from './Avatar';

export function HeaderCard({
  title,
  name,
  kind,
  type,
  intro,
  model,
  creator,
  onView,
  extra,
  right,
}: {
  title: ReactNode;
  name: string;
  kind: AvatarKind;
  type: string;
  intro: string;
  model: string;
  /** 创建者（照 sumus 悬浮卡的「创建者」一行） */
  creator?: string;
  onView?: () => void;
  /** 名字后面的小标签（话题） */
  extra?: ReactNode;
  /** ⓘ 右边的按钮（···） */
  right?: ReactNode;
}) {
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
        <button type="button" className="hc-trigger hit" aria-expanded={open} aria-controls={id} onMouseEnter={() => setOpen(true)} onClick={toggle}>
          <Avatar name={name} kind={kind} size="sm" />
          <span className="hc-name-text">{title}</span>
        </button>
      </h1>
      {extra}
      <span className="hc-spacer" />
      <button type="button" className="icon-btn hit hc-info" aria-label="对话信息" title="对话信息" aria-expanded={open} aria-controls={id} onClick={toggle}>
        <Info aria-hidden="true" />
      </button>
      {right}
      {open && (
        <div id={id} className="hc-card" role="group" aria-label={`${name} 的详细信息`}>
          <div className="hc-body">
            <div className="hc-top">
              <Avatar name={name} kind={kind} size="md" />
              <div>
                <p className="hc-name">{name}</p>
                <p className="hc-type">{type}</p>
              </div>
            </div>
            <p className="hc-intro">{intro}</p>
            <dl className="hc-meta">
              {creator && (
                <>
                  <dt>创建者</dt>
                  <dd>{creator}</dd>
                </>
              )}
              {/* 自审 B5：不显示 freebot 这类内部 id；不知道模型就不显示这一行 */}
              {model !== '—' && (
                <>
                  <dt>{kind === 'group' ? '成员' : '模型'}</dt>
                  <dd>{model}</dd>
                </>
              )}
            </dl>
          </div>
          {onView && (
            <button
              type="button"
              className="hc-view"
              onClick={() => {
                setOpen(false);
                onView();
              }}
            >
              {/* 群聊打开的也是全部成员（成员页不按群筛）：字照实说（审计 C15） */}
              <span>{kind === 'member' ? '查看成员' : '查看所有成员'}</span>
              <ArrowUpRight aria-hidden="true" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
