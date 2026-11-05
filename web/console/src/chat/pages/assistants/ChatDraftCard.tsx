/**
 * X-15 聊天里的助手草稿卡（design-assistants-v1 §7.6，对话页懒加载）。
 * 负责人回的 data-aroomo-assistant-draft → 草稿卡：「建好」才调 POST /api/assistants（幂等键 = 卡的 id，连点 / 重试只建一个）；
 * 「改一改」打开新建助手弹窗并预先填好；「不用了」只把卡收起来。家人看不到（Thread 不给家人渲染，Core 也不给家人发卡）。
 */
import type { Member } from '@/lib/api';
import { assistantsApi, type Assistant, type AssistantInput } from '@/lib/assistants';
import { AssistantDraftCard } from '../../thread/cards/AssistantDraftCard';
import { errText } from '../../ui';
import type { ChatDraft } from '../../store';
import { draftFromPart } from './AssistantPages';

/** 卡上的数据 → 建助手的请求体（只取接口认的字段） */
export function inputFromDraft(d: ChatDraft['data']): AssistantInput {
  const { text: _t, ...schedule } = d.schedule;
  return { name: d.name, instructions: d.instructions, members: d.members, leadMemberId: d.leadMemberId, schedule, timezone: d.timezone, budgetLevel: d.budgetLevel };
}

export default function ChatDraftCard({
  draft,
  members,
  onState,
  onCreated,
  onEdit,
}: {
  draft: ChatDraft;
  members: Member[];
  onState: (s: 'done' | 'dismissed') => void;
  onCreated: (a: Assistant) => void;
  onEdit: (input: AssistantInput) => void;
}) {
  return (
    <AssistantDraftCard
      draft={draftFromPart({ type: 'data-aroomo-assistant-draft', data: draft.data }, members)}
      initial={draft.state ?? 'open'}
      onCreate={async () => {
        try {
          const a = await assistantsApi.create(inputFromDraft(draft.data), draft.id);
          onState('done');
          onCreated(a);
        } catch (err) {
          throw new Error(errText(err, '没建成，请稍后再试'));
        }
      }}
      onEdit={() => onEdit(inputFromDraft(draft.data))}
      onDismiss={() => onState('dismissed')}
    />
  );
}
