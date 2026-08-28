#!/usr/bin/env bash
# ========================================================
# 服务器一次性初始化脚本（在云服务器上以 root 或 sudo 执行）
# 功能：安装 Docker、创建部署目录、放好 compose 配置
# 用法：sudo bash server-init.sh [部署目录，默认 /opt/operp]
# ========================================================
set -e

DEPLOY_DIR="${1:-/opt/operp}"

echo "== 1/3 检查/安装 Docker =="
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

echo "== 2/3 创建部署目录 $DEPLOY_DIR =="
mkdir -p "$DEPLOY_DIR"

echo "== 3/3 预拉取 nginx 镜像 =="
docker pull nginx:1.27-alpine

echo ""
echo "初始化完成。后续发布由 Gitee Go 流水线自动完成："
echo "  推送 master -> 云端构建 -> scp 制品到 $DEPLOY_DIR -> 校验 ai-server -> docker compose up -d"
echo ""
echo "请确认部署目录所属用户与流水线 SSH_USER 一致，且该用户有 docker 权限："
echo "  sudo usermod -aG docker <SSH_USER>"
