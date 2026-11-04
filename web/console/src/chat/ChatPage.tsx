/**
 * 控制台里的原生对话页（#250 spike，S0）。
 * - 打开 Aroomo 直接进对话（负责人 2026-11-04 方向 A）。
 * - 一层抽屉：会话 / 成员 / 群聊 / 工具 / 收件箱 / 设置都是同一个抽屉里的标签页，原地打开、不跳页，没有子抽屉
 *   （所有者 2026-11-04：能切换分类的地方用标签页）。收件箱、设置、工具、成员管理直接复用控制台原有页面组件。
 * - 只调用 Core 的标准接口（/api/*），换界面不用改后端。
 * - 会话先存在本机浏览器（localStorage）；回复一段一段出来，可以「停止」；可以 @ 成员；代码一键复制。
 * - 照顾视力：默认 16px，可调大；可开高对比；按钮至少 48px；读屏有标签。
 * 边界：本目录自成一块（store.ts 管数据和请求，Thread.tsx 管对话区，这里管抽屉和拼装），拆换都不影响控制台其他页面。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Menu, MessageSquarePlus, Trash2, Users, X } from 'lucide-react';
import { api, viaShell, type Member } from '@/lib/api';
import { Tabs } from '@/components/ui/tabs';
import { Logo } from '@/components/brand';
import { Members } from '@/pages/Members';
import { Tools } from '@/pages/Tools';
import { Inbox } from '@/pages/Inbox';
import { Settings } from '@/pages/Settings';
import { Thread } from './Thread';
import {
  FONT_SIZES,
  loadConversations,
  loadPrefs,
  newConversation,
  saveConversations,
  savePrefs,
  titleFrom,
  type ChatPrefs,
  type ChatTurn,
  type Conversation,
} from './store';
import './chat.css';

type Tab = 'conversations' | 'members' | 'groups' | 'tools' | 'inbox' | 'settings';

function useMembers(): Member[] {
  const [members, setMembers] = useState<Member[]>([]);
  useEffect(() => {
    let alive = true;
    api<{ members: Member[] }>('GET', '/api/members')
      .then((r) => alive && setMembers(r.members.filter((m) => m.enabled && m.status === 'active')))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  return members;
}

export function ChatPage({ fetchImpl }: { fetchImpl?: typeof fetch } = {}) {
  const [list, setList] = useState<Conversation[]>(() => {
    const l = loadConversations();
    return l.length ? l : [newConversation()];
  });
  const [currentId, setCurrentId] = useState(() => list[0]!.id);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('conversations');
  const [prefs, setPrefs] = useState<ChatPrefs>(() => loadPrefs());
  const [insert, setInsert] = useState<{ text: string; seq: number } | null>(null);
  const [groupPick, setGroupPick] = useState<string[]>([]);
  const members = useMembers();
  const dialog = useRef<HTMLDialogElement>(null);
  const current = list.find((c) => c.id === currentId) ?? list[0]!;

  useEffect(() => saveConversations(list.filter((c) => c.messages.length > 0)), [list]);
  useEffect(() => savePrefs(prefs), [prefs]);
  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) (d.showModal ? d.showModal() : d.setAttribute('open', ''));
    if (!open && d.open) (d.close ? d.close() : d.removeAttribute('open'));
  }, [open]);

  const start = useCallback((opts: Parameters<typeof newConversation>[0] = {}) => {
    const c = newConversation(opts);
    setList((l) => [c, ...l.filter((x) => x.messages.length > 0)]);
    setCurrentId(c.id);
    setOpen(false);
  }, []);

  const onMessages = useCallback(
    (turns: ChatTurn[]) => {
      setList((l) =>
        l
          .map((c) =>
            c.id === currentId
              ? { ...c, messages: turns, updatedAt: Date.now(), title: c.title === '新对话' ? titleFrom(turns.find((t) => t.role === 'user')?.text ?? '') : c.title }
              : c,
          )
          .sort((a, b) => b.updatedAt - a.updatedAt),
      );
    },
    [currentId],
  );

  const pick = (id: string) => {
    setCurrentId(id);
    setOpen(false);
  };

  const remove = (id: string) => {
    const c = list.find((x) => x.id === id);
    if (!c || !window.confirm(`删除会话「${c.title}」？只删本机这一份，删了找不回来。`)) return;
    const rest = list.filter((x) => x.id !== id);
    const next = rest.length ? rest : [newConversation()];
    setList(next);
    if (id === currentId) setCurrentId(next[0]!.id);
  };

  const memberNames = useMemo(() => members.map((m) => m.name), [members]);
  const style = { '--chat-font': `${prefs.fontSize}px` } as React.CSSProperties;

  return (
    <div className={`chat-shell aroomo-bg${prefs.highContrast ? ' chat-hc' : ''}`}>
    <section className={`chat-root${prefs.highContrast ? ' chat-hc' : ''}`} style={style} aria-labelledby="chat-title">
      <header className="chat-header">
        <button type="button" className="chat-btn chat-btn-ghost" aria-label="打开菜单：会话、成员、群聊、工具" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
          <Menu aria-hidden="true" />
          <span>菜单</span>
        </button>
        <Logo size={28} className="chat-logo" />
        <h1 id="chat-title" className="chat-title">
          {current.title}
          {current.model !== 'aroomo' && <span className="chat-muted">（单独对话）</span>}
        </h1>
        <button type="button" className="chat-btn chat-btn-ghost" aria-label="新对话" onClick={() => start()}>
          <MessageSquarePlus aria-hidden="true" />
          <span className="chat-hide-narrow">新对话</span>
        </button>
      </header>

      {viaShell && (
        <p role="alert" className="chat-error">
          原生对话要直接打开 Aroomo 控制台（不经过旧的 LobeHub 外壳）才能用。
        </p>
      )}
      <Thread key={current.id} conversation={current} onMessages={onMessages} insert={insert} members={memberNames} {...(fetchImpl ? { fetchImpl } : {})} />

      <dialog ref={dialog} className="chat-drawer" aria-label="菜单" onClose={() => setOpen(false)} onCancel={() => setOpen(false)}>
        <Tabs
          label="菜单分类"
          wrap
          value={tab}
          onChange={(t) => setTab(t as Tab)}
          aside={
            <button type="button" className="chat-btn chat-btn-ghost" aria-label="关闭菜单" onClick={() => setOpen(false)}>
              <X aria-hidden="true" />
            </button>
          }
          items={[
            {
              id: 'conversations',
              label: '会话',
              content: (
                <>
                  <button type="button" className="chat-btn chat-btn-primary chat-wide" onClick={() => start()}>
                    <MessageSquarePlus aria-hidden="true" />
                    新对话
                  </button>
                  <ul className="chat-list" aria-label="会话列表">
                    {list.map((c) => (
                      <li key={c.id} className="chat-list-item">
                        <button type="button" className="chat-list-main" aria-current={c.id === currentId ? 'true' : undefined} onClick={() => pick(c.id)}>
                          {c.group?.length ? <Users aria-hidden="true" className="chat-inline-icon" /> : null}
                          {c.title}
                        </button>
                        {c.messages.length > 0 && (
                          <button type="button" className="chat-btn chat-btn-ghost" aria-label={`删除会话「${c.title}」`} onClick={() => remove(c.id)}>
                            <Trash2 aria-hidden="true" />
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                  <p className="chat-muted">会话只存在这台设备的浏览器里。</p>
                </>
              ),
            },
            {
              id: 'members',
              label: '成员',
              content: (
                <Tabs
                  label="成员"
                  items={[
                    {
                      id: 'call',
                      label: '点名',
                      content: (
                        <>
                          {members.length === 0 ? (
                            <p>还没有在职成员。到旁边的「管理」里让模型入职。</p>
                          ) : (
                            <ul className="chat-list" aria-label="在职成员">
                              {members.map((m) => (
                                <li key={m.id} className="chat-list-item">
                                  <span className="chat-list-main chat-static">{m.name}</span>
                                  <button
                                    type="button"
                                    className="chat-btn chat-btn-ghost"
                                    aria-label={`在当前对话里点名 ${m.name}`}
                                    onClick={() => {
                                      setInsert((p) => ({ text: `@${m.name} `, seq: (p?.seq ?? 0) + 1 }));
                                      setOpen(false);
                                    }}
                                  >
                                    @点名
                                  </button>
                                  <button type="button" className="chat-btn chat-btn-ghost" aria-label={`和 ${m.name} 单独对话`} onClick={() => start({ title: `和 ${m.name}`, model: `aroomo/${m.id}` })}>
                                    单独聊
                                  </button>
                                </li>
                              ))}
                            </ul>
                          )}
                          <p className="chat-muted">不点名时，由负责人回答。</p>
                        </>
                      ),
                    },
                    { id: 'manage', label: '管理', content: <Members /> },
                  ]}
                />
              ),
            },
            {
              id: 'groups',
              label: '群聊',
              content: (
                <>
                  <fieldset className="chat-fieldset">
                    <legend>选几位成员，一起回答</legend>
                    {members.map((m) => (
                      <label key={m.id} className="chat-check">
                        <input
                          type="checkbox"
                          checked={groupPick.includes(m.name)}
                          onChange={(e) => setGroupPick((g) => (e.target.checked ? [...g, m.name] : g.filter((n) => n !== m.name)))}
                        />
                        {m.name}
                      </label>
                    ))}
                  </fieldset>
                  <button
                    type="button"
                    className="chat-btn chat-btn-primary chat-wide"
                    disabled={groupPick.length < 2}
                    onClick={() => {
                      start({ title: `群聊：${groupPick.join('、')}`, group: groupPick });
                      setGroupPick([]);
                    }}
                  >
                    <Users aria-hidden="true" />
                    开始群聊{groupPick.length < 2 ? '（至少选 2 位）' : ''}
                  </button>
                  <ul className="chat-list" aria-label="已有群聊">
                    {list
                      .filter((c) => c.group?.length)
                      .map((c) => (
                        <li key={c.id} className="chat-list-item">
                          <button type="button" className="chat-list-main" aria-current={c.id === currentId ? 'true' : undefined} onClick={() => pick(c.id)}>
                            {c.title}
                          </button>
                        </li>
                      ))}
                  </ul>
                </>
              ),
            },
            {
              id: 'tools',
              label: '工具',
              content: (
                <>
                  <p className="chat-muted">对话里直接调用工具（MCP）下一步开放；这里先管理工具。</p>
                  <Tools />
                </>
              ),
            },
            { id: 'inbox', label: '收件箱', content: <Inbox /> },
            {
              id: 'settings',
              label: '设置',
              content: (
                <>
                  <fieldset className="chat-fieldset">
                    <legend>对话字号</legend>
                    <div className="chat-seg" role="radiogroup" aria-label="字号">
                      {FONT_SIZES.map((s) => (
                        <button key={s} type="button" role="radio" aria-checked={prefs.fontSize === s} className="chat-btn chat-btn-ghost" onClick={() => setPrefs((p) => ({ ...p, fontSize: s }))}>
                          {s}
                        </button>
                      ))}
                    </div>
                  </fieldset>
                  <label className="chat-check">
                    <input type="checkbox" checked={prefs.highContrast} onChange={(e) => setPrefs((p) => ({ ...p, highContrast: e.target.checked }))} />
                    高对比度
                  </label>
                  <Settings />
                </>
              ),
            },
          ]}
        />
      </dialog>
    </section>
    </div>
  );
}
