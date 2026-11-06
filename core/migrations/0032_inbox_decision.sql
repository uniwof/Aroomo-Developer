-- Poke 行为规范 §8 决定卡（docs/api/design-poke-data-v1.md）：发起者、影响范围、拒绝理由。回退：migrations/down/0032_inbox_decision.down.sql
-- actor：{type, id?, name}，Core 自己填（内部调用方 = 自己；HTTP 发卡 = 调用者令牌），请求体不能冒充。
-- impact：影响范围，每条一句（≤10 条）；没写 = 空数组，界面写「未注明」。resolved_note：处理时写的理由（拒绝理由，≤500 字）。
-- inbox_items 已 FORCE RLS（0023），新列跟随行策略，不新增策略。
ALTER TABLE inbox_items
  ADD COLUMN actor         jsonb,
  ADD COLUMN impact        text[] NOT NULL DEFAULT '{}' CHECK (cardinality(impact) <= 10),
  ADD COLUMN resolved_note text CHECK (resolved_note IS NULL OR length(resolved_note) BETWEEN 1 AND 500);
