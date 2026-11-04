#!/bin/sh
# 创建 LobeHub 桶、设置读取策略和 CORS（来自 LobeHub 2.2.20 官方 compose，去掉了打印密钥的部分）。
# 注意：bucket.config.json 允许匿名读取桶内对象（上游默认行为）；服务器上对象存储域名应放在 Cloudflare Access 后面。
set -eu
rc alias set rustfs "http://rustfs:9000" "$RUSTFS_ACCESS_KEY" "$RUSTFS_SECRET_KEY" >/dev/null
rc mb "rustfs/$BUCKET" --ignore-existing
rc anonymous set-json /bucket.config.json "rustfs/$BUCKET"
printf '%s' '<CORSConfiguration><CORSRule><AllowedOrigin>*</AllowedOrigin><AllowedMethod>GET</AllowedMethod><AllowedMethod>PUT</AllowedMethod><AllowedMethod>HEAD</AllowedMethod><AllowedHeader>*</AllowedHeader><ExposeHeader>ETag</ExposeHeader><MaxAgeSeconds>3600</MaxAgeSeconds></CORSRule></CORSConfiguration>' \
  | rc bucket cors set "rustfs/$BUCKET" -
echo "rustfs-init: bucket $BUCKET ready"
