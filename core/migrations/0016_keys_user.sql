-- Key 记录按账号隔离（D117）：user_id 为空 = 所有者的 Key。
ALTER TABLE provider_keys ADD COLUMN user_id text;
CREATE INDEX provider_keys_user_idx ON provider_keys (user_id) WHERE user_id IS NOT NULL;
