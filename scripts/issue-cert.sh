#!/usr/bin/env bash
# ========================================================
# 签发 / 续期 Let's Encrypt 证书（webroot 模式）
#
# 前置条件：
#   1. 域名已解析到本机，且云安全组放行 80 / 443
#   2. nginx 容器已启动（ACME 校验要访问 :80/.well-known/）
#
# 用法：
#   bash scripts/issue-cert.sh                 # 首次签发或续期
#   CERTBOT_EMAIL=you@example.com bash scripts/issue-cert.sh
#   DOMAIN=other.example.com bash scripts/issue-cert.sh
#
# 证书只会放在部署目录的 certs/ 下由 nginx 读取，
# certbot 自己的 /etc/letsencrypt 仅作为原始存档。
# ========================================================
set -e

DOMAIN="${DOMAIN:-operp.oplug.cn}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="${DEPLOY_DIR:-$(dirname "$SCRIPT_DIR")}"
WEBROOT="$DEPLOY_DIR/certbot-webroot"
CERT_DIR="$DEPLOY_DIR/certs"
LIVE_DIR="/etc/letsencrypt/live/$DOMAIN"

if ! command -v certbot &>/dev/null; then
  echo "错误：未安装 certbot，请先执行 sudo bash scripts/server-init.sh"
  exit 1
fi

cd "$DEPLOY_DIR"
mkdir -p "$WEBROOT/.well-known/acme-challenge" "$CERT_DIR"

ARGS=(certonly --webroot -w "$WEBROOT" -d "$DOMAIN"
      --agree-tos --keep-until-expiring --non-interactive)

if [ -n "${CERTBOT_EMAIL:-}" ]; then
  ARGS+=(-m "$CERTBOT_EMAIL" --no-eff-email)
else
  ARGS+=(--register-unsafely-without-email)
fi

echo "== 申请证书 $DOMAIN =="
certbot "${ARGS[@]}"

echo "== 同步证书到 $CERT_DIR =="
install -m 644 "$LIVE_DIR/fullchain.pem" "$CERT_DIR/fullchain.pem"
# 私钥 600：nginx 由 root 起的 master 进程读取，worker 不需要直接读文件
install -m 600 "$LIVE_DIR/privkey.pem" "$CERT_DIR/privkey.pem"

echo "== 重载 nginx =="
if docker compose exec -T web nginx -s reload; then
  echo "nginx 已重载"
else
  echo "reload 失败，改为重启容器"
  docker compose restart web
fi

echo "== 完成 =="
openssl x509 -in "$CERT_DIR/fullchain.pem" -noout -subject -dates 2>/dev/null || true
