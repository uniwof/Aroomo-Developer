/**
 * 模型事实与负责人资格（PRODUCT §9.1：「负责人资格：能文字对话、上下文 ≥32k、支持工具调用，由后端统一判定；
 * 专用模型（生图、视频、语音）不能当负责人」；docs/ops/OLD-VS-NEW.md #52）。
 *
 * - 事实来源：LiteLLM 的 /model/info（D45：模型与来源的权威在 LiteLLM）。Core 只存判定所需的三项事实。
 * - 判定：在职、启用、未删除，并且 mode 是对话类（chat / responses）、上下文 ≥ 32k、支持工具调用。
 *   任何一项未知都不合格（不猜）；原因写成一句中文，界面直接显示。
 */
import type { LiteLLMAdmin } from '../keys/litellm.js';
import type { Member, MemberStore, ModelCaps } from './types.js';

/** 「≥32k」按 32,000 个 token 计（有的服务商标 32,000，有的标 32,768，都算） */
export const LEAD_MIN_CONTEXT = 32_000;
const CHAT_MODES = new Set(['chat', 'responses']);

export interface LeadEligibility {
  eligible: boolean;
  /** 不合格的原因（一句话）；合格时为 null */
  reason: string | null;
}

export function leadEligibility(m: Member): LeadEligibility {
  const no = (reason: string): LeadEligibility => ({ eligible: false, reason });
  if (m.deletedAt) return no('已删除');
  if (m.status !== 'active') return no('还是候选，入职后才能当负责人');
  if (!m.enabled) return no('已停用');
  const c = m.modelCaps;
  if (!c) return no('还没有拿到这个模型的能力信息');
  if (c.mode !== null && !CHAT_MODES.has(c.mode)) return no('专用模型（不是文字对话模型）');
  if (c.mode === null) return no('不确定能不能文字对话');
  if (c.maxInputTokens === null) return no('不确定上下文长度');
  if (c.maxInputTokens < LEAD_MIN_CONTEXT) return no(`上下文不到 32k（${Math.round(c.maxInputTokens / 1000)}k）`);
  if (c.supportsTools === null) return no('不确定是否支持工具调用');
  if (!c.supportsTools) return no('不支持工具调用');
  return { eligible: true, reason: null };
}

/** 一行能力摘要（收件箱候选卡片用），例如「对话 · 上下文 128k · 支持工具调用」 */
export function capsSummary(c: ModelCaps | null): string {
  if (!c) return '能力信息未知';
  const parts: string[] = [];
  if (c.mode) parts.push(CHAT_MODES.has(c.mode) ? '文字对话' : `专用模型（${c.mode}）`);
  if (c.maxInputTokens) parts.push(`上下文 ${Math.round(c.maxInputTokens / 1000)}k`);
  if (c.supportsTools !== null) parts.push(c.supportsTools ? '支持工具调用' : '不支持工具调用');
  return parts.length ? parts.join(' · ') : '能力信息未知';
}

/**
 * 按 LiteLLM 的模型信息刷新成员的模型事实（成员名 = LiteLLM 对外模型名，大小写不敏感）。
 * names 不传 = 刷新全部未删除成员。LiteLLM 不可用时抛错，调用方决定是否忽略。
 * 返回实际改动的成员数。
 */
export async function refreshModelCaps(store: MemberStore, litellm: LiteLLMAdmin, now: () => Date, names?: string[]): Promise<number> {
  if (!litellm.configured) return 0;
  const info = await litellm.modelCaps();
  const want = names ? new Set(names.map((n) => n.toLowerCase())) : null;
  let changed = 0;
  for (const m of await store.listAll()) {
    if (m.deletedAt) continue;
    const key = m.name.toLowerCase();
    if (want && !want.has(key)) continue;
    const found = info.get(key);
    const next: ModelCaps | null = found ? { ...found, checkedAt: now().toISOString() } : null;
    const same =
      (next === null && m.modelCaps === null) ||
      (next !== null &&
        m.modelCaps !== null &&
        next.mode === m.modelCaps.mode &&
        next.maxInputTokens === m.modelCaps.maxInputTokens &&
        next.supportsTools === m.modelCaps.supportsTools);
    if (same) continue;
    await store.update({ ...m, modelCaps: next, updatedAt: now() });
    changed++;
  }
  return changed;
}
