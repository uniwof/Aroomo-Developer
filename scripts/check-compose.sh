#!/usr/bin/env bash
# CI / 本地：用占位 .env 校验每个档位（及 local、data-dir 叠加）的 compose 配置能否解析。
# 不需要 Docker 守护进程，只需要 docker compose（v2+）。
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
deploy="$here/../deploy"
compose="${COMPOSE_BIN:-docker compose}"

tmp_env="$(mktemp)"
trap 'rm -f "$tmp_env"' EXIT
# 用模板生成占位 env，并补上 data-dir.yml 需要的 DATA_DIR
sed 's/CHANGE_ME/placeholder/g' "$deploy/.env.example" > "$tmp_env"
{
  echo "DATA_DIR=/tmp/aroomo-ci-data"
  echo "LOCAL_BACKUP_DIR=/tmp/aroomo-ci-backups"
  echo "AROOMO_ENV_FILE=$tmp_env"
} >> "$tmp_env"

status=0
for tier in demo-2g standard full; do
  for extra in "" "local.yml" "data-dir.yml" "local.yml local-backup.yml"; do
    files=(-f "$deploy/docker-compose.yml" -f "$deploy/tiers/$tier.yml")
    # shellcheck disable=SC2086  # extra 按空格拆成多个文件
    for e in $extra; do files+=(-f "$deploy/$e"); done
    label="$tier${extra:+ + $extra}"
    # shellcheck disable=SC2086
    if $compose --project-directory "$deploy" --env-file "$tmp_env" "${files[@]}" \
        --profile tunnel --profile backup --profile restore --profile agent-gateway config --quiet; then
      echo "ok   $label"
    else
      echo "FAIL $label" >&2
      status=1
    fi
  done
done

# 基础文件不得发布宿主机端口（服务器除 22 外不开端口）
# shellcheck disable=SC2086
if $compose --project-directory "$deploy" --env-file "$tmp_env" -f "$deploy/docker-compose.yml" \
    --profile tunnel --profile backup --profile restore --profile agent-gateway config --format json \
    | python3 -c 'import json,sys; d=json.load(sys.stdin); bad=[n for n,s in d["services"].items() if s.get("ports")]; print("published ports in base:", bad) if bad else None; sys.exit(1 if bad else 0)'; then
  echo "ok   base publishes no host ports"
else
  status=1
fi

# 镜像必须固定版本（不允许 latest 或无标签）
# shellcheck disable=SC2086
if $compose --project-directory "$deploy" --env-file "$tmp_env" -f "$deploy/docker-compose.yml" \
    --profile tunnel --profile backup --profile restore --profile agent-gateway config --format json \
    | python3 -c '
import json,sys
d=json.load(sys.stdin); bad=[]
for n,s in d["services"].items():
    img=s.get("image","")
    if "build" in s: continue
    tag=img.rsplit(":",1)[1] if ":" in img.split("/")[-1] else ""
    if tag in ("","latest"): bad.append(f"{n}={img}")
print("unpinned images:", bad) if bad else None
sys.exit(1 if bad else 0)'; then
  echo "ok   all images pinned"
else
  status=1
fi

# LobeHub 的 AGENT_GATEWAY_URL 不能为空（空值 → "Invalid URL" 崩溃）；模板里留空 / 显式设空时都要有默认值
for override in "" "AGENT_GATEWAY_URL="; do
  env_check="$(mktemp)"
  cp "$tmp_env" "$env_check"
  [ -n "$override" ] && echo "$override" >> "$env_check"
  # shellcheck disable=SC2086
  url="$($compose --project-directory "$deploy" --env-file "$env_check" -f "$deploy/docker-compose.yml" config --format json \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["services"]["lobe"]["environment"].get("AGENT_GATEWAY_URL",""))')"
  rm -f "$env_check"
  case "$url" in
    http://*|https://*|ws://*|wss://*) echo "ok   lobe AGENT_GATEWAY_URL non-empty (${override:-unset})" ;;
    *) echo "FAIL lobe AGENT_GATEWAY_URL empty/invalid (${override:-unset}): '$url'" >&2; status=1 ;;
  esac
done

# D66：每个档位里每个容器（含一次性的 rustfs-init、restore 和所有 profile）都必须有 mem_limit
for tier in demo-2g standard full; do
  # shellcheck disable=SC2086
  if $compose --project-directory "$deploy" --env-file "$tmp_env" -f "$deploy/docker-compose.yml" -f "$deploy/tiers/$tier.yml" \
      --profile tunnel --profile backup --profile restore --profile agent-gateway config --format json \
      | python3 -c 'import json,sys; d=json.load(sys.stdin); bad=[n for n,s in d["services"].items() if not s.get("mem_limit")]; print("services without mem_limit:", bad) if bad else None; sys.exit(1 if bad else 0)'; then
    echo "ok   $tier: every service has mem_limit"
  else
    echo "FAIL $tier: missing mem_limit" >&2
    status=1
  fi
done

exit $status
