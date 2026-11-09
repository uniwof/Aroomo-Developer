/**
 * 成员详情「已分配的工具」（docs/api/design-member-tools-v1.md；Poke 清单第 9 项后半）。单独懒加载块，开关 MEMBER_TOOLS 关着时不进任何包。
 * 只显示 Core 给的：分配（引用）+ 工具网关当场的状态；不可用的写明原因。分配处理中锁住、结果播报；去掉先确认。只给所有者（panels 判家人）。
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type Member } from '@/lib/api';
import { useAsk } from '@/components/Dialog';
import { ErrorRetry } from '@/components/ErrorRetry';
import { Group } from '@/pages/Settings';
import { RISK_LABEL, toolName, type ToolRisk } from '@/lib/tools';
import { Empty, errText } from './ui';
import { pathOf } from './routes';

interface Assigned {
  tool: string;
  description: string | null;
  risk: ToolRisk | null;
  available: boolean;
  assignedAt: string;
}
interface GatewayTool {
  name: string;
  risk: ToolRisk;
}

export default function MemberTools({ member }: { member: Member }) {
  const navigate = useNavigate();
  const ask = useAsk();
  const [list, setList] = useState<Assigned[] | null>(null);
  const [gw, setGw] = useState<GatewayTool[]>([]);
  const [loadErr, setLoadErr] = useState(false);
  const [seq, setSeq] = useState(0);
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');
  const [err, setErr] = useState('');
  const base = `/api/members/${encodeURIComponent(member.id)}/tools`;

  useEffect(() => {
    let alive = true;
    setLoadErr(false);
    api<{ tools: Assigned[] }>('GET', base)
      .then((r) => alive && setList(r.tools))
      .catch(() => alive && setLoadErr(true));
    api<{ tools?: GatewayTool[] }>('GET', '/api/gateway/tools')
      .then((r) => alive && setGw(r.tools ?? []))
      .catch(() => alive && setGw([]));
    return () => {
      alive = false;
    };
  }, [base, seq]);

  const choices = gw.filter((t) => !list?.some((a) => a.tool === t.name));
  const chosen = choices.some((t) => t.name === pick) ? pick : (choices[0]?.name ?? '');

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(true);
    setDone('');
    setErr('');
    try {
      await fn();
      setDone(label);
      setSeq((n) => n + 1);
    } catch (e) {
      setErr(errText(e, '没改成，请稍后再试'));
    } finally {
      setBusy(false);
    }
  }
  async function remove(a: Assigned) {
    if (busy) return;
    const n = toolName(a.tool);
    if (!(await ask.confirm({ title: `不再给 ${member.name} 用「${n}」？`, desc: '只是去掉分配，工具本身还在资源库里，随时可以再分配。', ok: '去掉', danger: true }))) return;
    await run(`已不再给 ${member.name} 用「${n}」`, () => api('DELETE', `${base}/${encodeURIComponent(a.tool)}`));
  }

  return (
    <Group title="已分配的工具" footer="分配先记在这里；成员对话里调用工具还没接上，接上后只能用分到的工具。">
      {ask.node}
      {loadErr && <ErrorRetry text="已分配的工具没加载出来。" what="已分配的工具" onRetry={() => setSeq((n) => n + 1)} />}
      {!loadErr && !list && <p className="note">正在加载…</p>}
      {list && list.length === 0 && (
        <Empty
          text={`还没给 ${member.name} 分配工具。`}
          action={
            <button type="button" className="btn btn-outline" onClick={() => navigate(pathOf({ kind: 'tools' }))}>
              去工具页
            </button>
          }
        />
      )}
      {list?.map((a) => (
        <div key={a.tool} className="row">
          <span className="row-text">
            <span className="row-label">{toolName(a.tool)}</span>
            <span className="row-hint">{a.available && a.risk ? `可用 · ${RISK_LABEL[a.risk]}` : '不可用：工具在资源库里已停用或删除'}</span>
          </span>
          <button type="button" className="btn btn-outline" disabled={busy} onClick={() => void remove(a)} aria-label={`不再给 ${member.name} 用「${toolName(a.tool)}」`}>
            去掉
          </button>
        </div>
      ))}
      {list && choices.length > 0 && (
        <div className="row">
          <select className="field-select" aria-label={`选一个工具分配给 ${member.name}`} value={chosen} onChange={(e) => setPick(e.target.value)} disabled={busy}>
            {choices.map((t) => (
              <option key={t.name} value={t.name}>
                {toolName(t.name)}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn btn-outline"
            disabled={busy || !chosen}
            onClick={() => void run(`已把「${toolName(chosen)}」分配给 ${member.name}`, () => api('PUT', `${base}/${encodeURIComponent(chosen)}`))}
          >
            分配
          </button>
        </div>
      )}
      <p role="status" className="note">
        {done}
      </p>
      {err && (
        <p role="alert" className="note note-error">
          {err}
        </p>
      )}
    </Group>
  );
}
