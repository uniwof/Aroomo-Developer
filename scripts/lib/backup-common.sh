#!/usr/bin/env bash
# backup.sh / restore.sh 共用：异地存储（rclone S3）配置、备份文件命名、列出备份。
# 由调用方 source；不单独运行。
#
# 备份格式（DECISIONS D64 实现注 a）：
#   <前缀>/aroomo-<主机标签>-<UTC 时间 YYYYMMDDTHHMMSSZ>.tar.zst.age   用主密钥的公钥（age X25519）加密的压缩包
#   <前缀>/aroomo-<主机标签>-<UTC 时间>.meta.json                      明文元数据：格式、算法、公钥、密文 SHA-256（不是秘密）
# 服务器前缀默认 server，电脑版 pc/<电脑名>（D65：同一个异地存储，独立目录）。

# shellcheck disable=SC2034  # 下面三个变量由 source 本文件的脚本使用
AROOMO_BACKUP_FORMAT=2
AROOMO_AGE_RECIPIENT_RE='^age1[02-9ac-hj-np-z]{58}$'
AROOMO_AGE_IDENTITY_RE='^AGE-SECRET-KEY-1[02-9AC-HJ-NP-Z]{58}$'

# 异地存储是否已配置
offsite_configured() {
  [[ -n "${BACKUP_S3_ENDPOINT:-}" && -n "${BACKUP_S3_BUCKET:-}" ]]
}

# 把 BACKUP_S3_* 转成 rclone 的环境变量配置（远端名 offsite），不写配置文件
offsite_setup() {
  export RCLONE_CONFIG_OFFSITE_TYPE=s3
  export RCLONE_CONFIG_OFFSITE_PROVIDER="${BACKUP_S3_PROVIDER:-Other}"
  export RCLONE_CONFIG_OFFSITE_ENDPOINT="$BACKUP_S3_ENDPOINT"
  export RCLONE_CONFIG_OFFSITE_REGION="${BACKUP_S3_REGION:-auto}"
  export RCLONE_CONFIG_OFFSITE_ACCESS_KEY_ID="${BACKUP_S3_ACCESS_KEY_ID:-}"
  export RCLONE_CONFIG_OFFSITE_SECRET_ACCESS_KEY="${BACKUP_S3_SECRET_ACCESS_KEY:-}"
  # 只给桶的读写权限即可，不需要建桶权限
  export RCLONE_CONFIG_OFFSITE_NO_CHECK_BUCKET=true
  export RCLONE_CONFIG_OFFSITE_FORCE_PATH_STYLE=true
  export RCLONE_CONFIG_DIR=/tmp RCLONE_CONFIG=/dev/null
}

# 异地目录：offsite:<桶>/<前缀>
offsite_dir() {
  local prefix="${BACKUP_S3_PREFIX:-server}"
  prefix="${prefix#/}"
  prefix="${prefix%/}"
  printf 'offsite:%s/%s' "$BACKUP_S3_BUCKET" "$prefix"
}

backup_basename() { # backup_basename <主机标签> <UTC 时间>
  printf 'aroomo-%s-%s' "$1" "$2"
}

# 列出某处的备份（只输出 .tar.zst.age 文件名，旧→新）。where = local | offsite
list_backups() {
  local where="$1"
  case "$where" in
    local)
      [[ -d "${BACKUP_LOCAL_DIR:-}" ]] || return 0
      find "$BACKUP_LOCAL_DIR" -maxdepth 1 -type f -name 'aroomo-*.tar.zst.age' -printf '%f\n' | sort
      ;;
    offsite)
      rclone lsf --files-only --include 'aroomo-*.tar.zst.age' "$(offsite_dir)" | sort
      ;;
  esac
}

# 从文件名取 UTC 时间（YYYYMMDDTHHMMSSZ）
stamp_of() { sed -E 's/.*-([0-9]{8}T[0-9]{6}Z)\.tar\.zst\.age$/\1/' <<<"$1"; }

# 保留策略：从 stdin 读备份文件名（任意顺序），输出要保留的文件名。
# 规则与 restic forget 相同：最近 N 个；每天 / 每周（周一开始）/ 每月各保留最新的一个，最多 N 天 / 周 / 月。
retention_keep() { # retention_keep <last> <daily> <weekly> <monthly>
  jq -R -s -r --argjson last "$1" --argjson daily "$2" --argjson weekly "$3" --argjson monthly "$4" '
    def stamp: capture("-(?<s>[0-9]{8}T[0-9]{6}Z)\\.tar\\.zst\\.age$").s;
    def epoch: stamp | "\(.[0:4])-\(.[4:6])-\(.[6:8])T\(.[9:11]):\(.[11:13]):\(.[13:15])Z" | fromdateiso8601;
    def pick(key; n):
      if n <= 0 then []
      else reduce .[] as $x ({seen: {}, keep: []};
             ($x | key | tostring) as $k
             | if (.seen[$k] // false) or ((.keep | length) >= n) then . else .seen[$k] = true | .keep += [$x] end)
           | .keep end;
    split("\n") | map(select(test("-[0-9]{8}T[0-9]{6}Z\\.tar\\.zst\\.age$")))
    | sort_by(stamp) | reverse
    | (.[0:$last])
      + pick(stamp[0:8]; $daily)
      + pick((epoch / 86400 | floor) + 3 | . / 7 | floor; $weekly)
      + pick(stamp[0:6]; $monthly)
    | unique | .[]'
}
