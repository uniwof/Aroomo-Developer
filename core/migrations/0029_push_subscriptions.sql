-- X-08 推送提醒：网页推送订阅（一台设备的一个浏览器 = 一行）。第一版只给所有者用，表照样按 user_id 隔离（D206，模板同 0019 / 0023）。
-- endpoint 是推送服务给的地址（相当于这台设备的投递凭据），不进日志、不回给前端；p256dh / auth 是浏览器给的加密公钥和认证串。
-- 回退：migrations/down/0029_push_subscriptions.down.sql
CREATE TABLE push_subscriptions (
  id         uuid        PRIMARY KEY,
  user_id    text        NOT NULL CONSTRAINT push_subscriptions_user_id_nonempty CHECK (user_id <> ''),
  endpoint   text        NOT NULL CHECK (endpoint ~ '^https://' AND length(endpoint) <= 1024),
  p256dh     text        NOT NULL CHECK (length(p256dh) BETWEEN 80 AND 100),
  auth       text        NOT NULL CHECK (length(auth) BETWEEN 16 AND 32),
  created_at timestamptz NOT NULL,
  UNIQUE (user_id, endpoint)
);
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY push_subscriptions_user ON push_subscriptions
  USING (user_id = NULLIF(current_setting('app.user_id', true), ''))
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY push_subscriptions_system_read ON push_subscriptions FOR SELECT
  USING (current_setting('app.system_scope', true) = 'on');
