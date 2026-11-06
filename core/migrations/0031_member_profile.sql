-- Poke 行为规范 §4 New Member（docs/api/design-poke-data-v1.md）：成员资料三个可选字段。回退：migrations/down/0031_member_profile.down.sql
-- role：角色（一句话）；system_prompt：这位成员的系统提示词，对话转发前拼在规矩后面；avatar：头像（1–2 个字符：emoji 或字，没有上传）。
-- members 已 FORCE RLS（0019），新列跟随行策略，不新增策略。都可为空：老成员不受影响。
ALTER TABLE members
  ADD COLUMN role          text CHECK (role IS NULL OR length(role) BETWEEN 1 AND 60),
  ADD COLUMN system_prompt text CHECK (system_prompt IS NULL OR length(system_prompt) BETWEEN 1 AND 4000),
  ADD COLUMN avatar        text CHECK (avatar IS NULL OR length(avatar) BETWEEN 1 AND 16);
