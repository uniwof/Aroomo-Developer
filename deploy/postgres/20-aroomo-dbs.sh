#!/bin/bash
# 首次初始化时创建 LiteLLM 和 Core 各自的库与账号（每类数据只有一个权威来源，DECISIONS v4.3）。
# 只在数据目录为空时由 postgres 镜像执行一次；密码来自环境变量，不写进仓库。
set -euo pipefail

: "${LITELLM_DB_PASSWORD:?LITELLM_DB_PASSWORD is required}"
: "${CORE_DB_PASSWORD:?CORE_DB_PASSWORD is required}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v litellm_pw="$LITELLM_DB_PASSWORD" -v core_pw="$CORE_DB_PASSWORD" <<'SQL'
CREATE ROLE litellm LOGIN PASSWORD :'litellm_pw';
CREATE DATABASE litellm OWNER litellm;
CREATE ROLE aroomo_core LOGIN PASSWORD :'core_pw';
CREATE DATABASE aroomo_core OWNER aroomo_core;
-- D206：应用角色（不能登录、不是表所有者、不是超级用户）；Core 连接后 SET ROLE 到它，RLS 才对业务查询生效
CREATE ROLE aroomo_core_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
GRANT aroomo_core_app TO aroomo_core;
REVOKE ALL ON DATABASE litellm FROM PUBLIC;
REVOKE ALL ON DATABASE aroomo_core FROM PUBLIC;
SQL
