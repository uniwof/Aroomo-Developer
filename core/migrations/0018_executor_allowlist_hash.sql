-- 执行员 hello 上报的本机白名单指纹（控制台比对本机与服务器白名单是否一致）
ALTER TABLE executors ADD COLUMN allowlist_hash text;
