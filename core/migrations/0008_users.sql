-- 多用户底座 B1（DECISIONS D111、D117-15/16/18；D118）：用户、邀请、登录会话。
-- 登录放在 Core 这一层（不绑任何界面）：邮箱 + 密码，凭邀请注册；会话令牌与邀请令牌只存 SHA-256。
-- 这一步只建账号体系；业务表的 user_id 隔离是 B1 的下一步（0009 起）。

-- 审计日志增加操作者类型 user（普通用户 / 管理员账号）。只放宽 CHECK，不动已有记录。
ALTER TABLE audit_log DROP CONSTRAINT audit_log_actor_type_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_actor_type_check
  CHECK (actor_type IN ('owner', 'operator', 'system', 'member', 'user'));

CREATE TABLE users (
  id            uuid        PRIMARY KEY,
  email         text        NOT NULL CHECK (length(email) BETWEEN 3 AND 254),
  display_name  text        NOT NULL DEFAULT '' CHECK (length(display_name) <= 64),
  role          text        NOT NULL CHECK (role IN ('admin', 'user')),
  status        text        NOT NULL CHECK (status IN ('active', 'disabled')),
  password_hash text        NOT NULL,
  created_at    timestamptz NOT NULL,
  updated_at    timestamptz NOT NULL
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));

-- 邀请（kind=invite，新账号）与重置链接（kind=reset，已有账号忘记密码，由管理员发出）
CREATE TABLE user_invites (
  token_hash text        PRIMARY KEY,
  kind       text        NOT NULL CHECK (kind IN ('invite', 'reset')),
  email      text        NOT NULL,
  user_id    uuid        REFERENCES users (id) ON DELETE CASCADE,
  role       text        NOT NULL CHECK (role IN ('admin', 'user')),
  created_by text        NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  CHECK ((kind = 'reset') = (user_id IS NOT NULL))
);
CREATE INDEX user_invites_open_idx ON user_invites (expires_at) WHERE used_at IS NULL;

CREATE TABLE user_sessions (
  token_hash text        PRIMARY KEY,
  user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX user_sessions_user_idx ON user_sessions (user_id);
