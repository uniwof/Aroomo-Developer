/**
 * 助手接口（Core /api/assistants，docs/api/design-assistants-v1.md §2）的类型和请求。只给所有者：家人账号不调（Core 也会 403）。
 * 字段名照 Core 返回的 JSON（core/src/assistants/service.ts assistantJson / runJson / foldSteps / messageJson），不在前端另起一套。
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import type { ScheduleKind, ScheduleSpec } from '@/chat/pages/assistants/schedule-text';

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'waiting_confirmation' | 'cancelled';
export type BudgetLevel = 'low' | 'mid' | 'high';

/** Core 的计划：{ kind, time?, days?, everyHours? } + 服务端算好的人话 text */
export interface CoreSchedule extends ScheduleSpec {
  kind: ScheduleKind;
  text?: string;
}

export interface AssistantRun {
  id: string;
  assistantId: string;
  trigger: 'manual' | 'schedule';
  scheduledFor: string | null;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  status: RunStatus;
  failureCode: string | null;
  summary: string | null;
  usageState: 'ample' | 'tight' | 'exhausted' | null;
  messageIds: string[];
}

export interface RunStep {
  stepNo: number;
  memberId: string | null;
  action: 'plan' | 'work' | 'summarize' | 'confirm';
  /** received = X-06「已收到」（成员的模型接下了，还没回字），只出现在成员那一步 */
  status: 'pending' | 'received' | 'running' | 'done' | 'failed' | 'skipped' | 'waiting_confirmation';
  detail: string;
  startedAt: string;
  updatedAt: string;
}

export interface Assistant {
  id: string;
  name: string;
  instructions: string;
  leadMemberId: string | null;
  members: { memberId: string; role: 'lead' | 'worker'; position: number }[];
  enabled: boolean;
  schedule: CoreSchedule;
  timezone: string;
  budgetLevel: BudgetLevel;
  notify: boolean;
  conversationId: string;
  nextRunAt: string | null;
  pausedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** 列表 / 单个查询才有 */
  status?: 'normal' | 'running' | 'paused' | 'waiting';
  unread?: boolean;
  lastRun?: AssistantRun | null;
  activeRunId?: string | null;
}

export interface AssistantMessage {
  id: string;
  seq: number | null;
  role: 'user' | 'member' | 'system';
  memberId: string | null;
  runId: string | null;
  content: string;
  createdAt: string;
}

/** 建助手 / 预览的请求体（Core createBody） */
export interface AssistantInput {
  name: string;
  instructions: string;
  members: string[];
  leadMemberId?: string;
  schedule: CoreSchedule;
  timezone?: string;
  budgetLevel?: BudgetLevel;
}

/** POST /api/assistants/preview 返回的草稿数据块（X-15，type = data-aroomo-assistant-draft） */
export interface DraftPart {
  type: 'data-aroomo-assistant-draft';
  data: {
    name: string;
    instructions: string;
    members: string[];
    leadMemberId: string;
    schedule: CoreSchedule;
    timezone: string;
    budgetLevel: BudgetLevel;
    nextRunAt: string | null;
    scheduleText: string;
  };
}

const idem = (key?: string): Record<string, string> => (key ? { 'idempotency-key': key } : {});
/** 新的幂等键（每个意图一个：一张草稿卡、一次「立即运行」） */
export const newIdemKey = (prefix: string) => `${prefix}-${typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`}`;

const base = (id: string) => `/api/assistants/${encodeURIComponent(id)}`;

export const assistantsApi = {
  list: () => api<{ assistants: Assistant[] }>('GET', '/api/assistants').then((r) => r.assistants),
  get: (id: string) => api<{ assistant: Assistant }>('GET', base(id)).then((r) => r.assistant),
  preview: (b: AssistantInput) => api<{ scheduleText: string; nextRunAt: string | null; nextRunText: string; part: DraftPart }>('POST', '/api/assistants/preview', b),
  /** key = Idempotency-Key：同一次「建好」（同一张草稿卡）重试或连点只建一个 */
  create: (b: AssistantInput, key?: string) => api<{ assistant: Assistant; created: boolean }>('POST', '/api/assistants', b, fetch, idem(key)).then((r) => r.assistant),
  pause: (id: string) => api<{ assistant: Assistant }>('POST', `${base(id)}/pause`).then((r) => r.assistant),
  resume: (id: string) => api<{ assistant: Assistant }>('POST', `${base(id)}/resume`).then((r) => r.assistant),
  /** key = Idempotency-Key：同一次点击的重试返回同一条运行 */
  runNow: (id: string, key?: string) => api<{ run: AssistantRun; created: boolean }>('POST', `${base(id)}/runs`, undefined, fetch, idem(key)).then((r) => r.run),
  runs: (id: string, before?: string) => api<{ runs: AssistantRun[]; nextBefore: string | null }>('GET', `${base(id)}/runs?limit=20${before ? `&before=${encodeURIComponent(before)}` : ''}`),
  run: (id: string, runId: string) => api<{ run: AssistantRun & { steps: RunStep[] } }>('GET', `${base(id)}/runs/${encodeURIComponent(runId)}`).then((r) => r.run),
  cancelRun: (id: string, runId: string) => api<{ run: AssistantRun }>('POST', `${base(id)}/runs/${encodeURIComponent(runId)}/cancel`).then((r) => r.run),
  messages: (id: string, afterSeq?: number) => api<{ messages: AssistantMessage[] }>('GET', `${base(id)}/messages?limit=200${afterSeq !== undefined ? `&afterSeq=${afterSeq}` : ''}`).then((r) => r.messages),
  markRead: (id: string) => api<void>('POST', `${base(id)}/read`),
};

export const isActive = (s: RunStatus | undefined) => s === 'queued' || s === 'running';

/** 助手列表：enabled=false（家人 / 开关关）时不请求；有进行中的运行每 3 秒刷新一次，其余每 60 秒 */
export function useAssistants(enabled: boolean): { list: Assistant[] | null; error: string; reload: () => void } {
  const [list, setList] = useState<Assistant[] | null>(null);
  const [error, setError] = useState('');
  const [seq, setSeq] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    assistantsApi
      .list()
      .then((l) => {
        if (!alive) return;
        setList(l);
        setError('');
      })
      .catch((e: unknown) => alive && setError(e instanceof Error && e.message ? e.message : '助手列表没加载出来'));
    return () => {
      alive = false;
    };
  }, [enabled, seq]);
  const running = !!list?.some((a) => a.status === 'running');
  useEffect(() => {
    if (!enabled) return;
    const t = setInterval(() => setSeq((n) => n + 1), running ? 3000 : 60_000);
    return () => clearInterval(t);
  }, [enabled, running]);
  return { list: enabled ? list : null, error, reload: useCallback(() => setSeq((n) => n + 1), []) };
}
