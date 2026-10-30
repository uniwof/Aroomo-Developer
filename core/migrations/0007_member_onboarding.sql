-- 成员入职流程与负责人资格（PRODUCT §9.1；docs/ops/OLD-VS-NEW.md #50、#52）。
-- status：candidate = 候选（加 Key 自动发现，等用户一键入职）；active = 在职。已有成员都算在职。
-- model_caps：由后端从 LiteLLM 模型信息判定的事实（对话类型、上下文长度、是否支持工具调用），
--   用于负责人资格判定（能文字对话、上下文 ≥32k、支持工具调用）。不放任何密钥。
ALTER TABLE members
  ADD COLUMN status text NOT NULL DEFAULT 'active' CHECK (status IN ('candidate', 'active')),
  ADD COLUMN model_caps jsonb;
