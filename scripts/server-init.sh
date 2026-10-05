#!/usr/bin/env bash
# ========================================================
# 服务器一次性初始化脚本（在云服务器上以 root 或 sudo 执行）
# 功能：安装 Docker、certbot，创建部署目录，放好自签占位证书
# 用法：sudo bash server-init.sh [部署目录，默认 /opt/operp]
# ========================================================
set -e

DEPLOY_DIR="${1:-/opt/operp}"
DOMAIN="${DOMAIN:-operp.oplug.cn}"
CERT_DIR="$DEPLOY_DIR/certs"
WEBROOT="$DEPLOY_DIR/certbot-webroot"

echo "== 1/5 检查/安装 Docker =="
if ! command -v docker &>/dev/null; then
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
else
  echo "Docker 已安装: $(docker --version)"
fi

if ! docker compose version &>/dev/null; then
  echo "缺少 docker compose 插件，请升级 Docker 或安装 docker-compose-plugin"
  exit 1
fi

echo "== 2/5 创建部署目录 $DEPLOY_DIR =="
mkdir -p "$DEPLOY_DIR" "$CERT_DIR" "$WEBROOT/.well-known/acme-challenge"

echo "== 3/5 生成自签占位证书（真证书签发前保证 nginx 能起来）=="
if [ ! -s "$CERT_DIR/fullchain.pem" ] || [ ! -s "$CERT_DIR/privkey.pem" ]; then
  if ! command -v openssl &>/dev/null; then
    echo "缺少 openssl，无法生成占位证书，请安装后重试"
    exit 1
  fi
  openssl req -x509 -nodes -newkey rsa:2048 -days 3650 \
    -subj "/CN=$DOMAIN" \
    -keyout "$CERT_DIR/privkey.pem" \
    -out "$CERT_DIR/fullchain.pem" 2>/dev/null
  echo "已生成自签证书（浏览器会告警，下一步签发真证书后会被覆盖）"
else
  echo "已存在证书，跳过"
fi

echo "== 4/5 安装 certbot =="
if ! command -v certbot &>/dev/null; then
  if command -v apt-get &>/dev/null; then
    apt-get update -y && apt-get install -y certbot openssl
  elif command -v yum &>/dev/null; then
    yum install -y epel-release && yum install -y certbot openssl
  else
    echo "无法识别包管理器，请手工安装 certbot 后重跑本脚本"
    exit 1
  fi
else
  echo "certbot 已安装: $(certbot --version 2>&1 | head -1)"
fi

# certbot 自带续期定时器也要能把证书同步进 certs/，否则续期了 nginx 还是用旧的
HOOK_DIR="/etc/letsencrypt/renewal-hooks/deploy"
mkdir -p "$HOOK_DIR"
cat > "$HOOK_DIR/operp-sync.sh" <<HOOK
#!/usr/bin/env bash
set -e
install -m 644 /etc/letsencrypt/live/$DOMAIN/fullchain.pem $CERT_DIR/fullchain.pem
install -m 600 /etc/letsencrypt/live/$DOMAIN/privkey.pem $CERT_DIR/privkey.pem
cd $DEPLOY_DIR && docker compose exec -T web nginx -s reload || (cd $DEPLOY_DIR && docker compose restart web)
HOOK
chmod +x "$HOOK_DIR/operp-sync.sh"
echo "已写入续期钩子 $HOOK_DIR/operp-sync.sh"

echo "== 5/5 预拉取 nginx 镜像 =="
docker pull nginx:1.27-alpine

echo ""
echo "初始化完成。后续发布由 Gitee Go 流水线自动完成："
echo "  推送 master -> 云端构建 -> 制品到 $DEPLOY_DIR -> 校验 ai-server -> docker compose up -d"
echo ""
echo "请确认部署目录所属用户与流水线 SSH_USER 一致，且该用户有 docker 权限："
echo "  sudo usermod -aG docker <SSH_USER>"
echo ""
echo "================ 下一步（必须手工做一次） ================"
echo "1. 云安全组放行 TCP 80 与 443（当前 80/443 不通，ACME 校验会失败）"
echo "2. 确认 $DOMAIN 已解析到本机： nslookup $DOMAIN"
echo "3. 首次部署后签发真证书："
echo "     cd $DEPLOY_DIR"
echo "     CERTBOT_EMAIL=you@example.com bash scripts/issue-cert.sh"
echo "   之后 certbot 自带定时器会自动续期并同步（钩子已装好）"
echo ""
