# ERP 系统本地部署说明

## 项目简介

这是一个基于 React + TypeScript + Tailwind CSS + Supabase 的企业资源规划（ERP）系统，包含三大核心模块：
- **财务模块**：总账、应收应付、固定资产、成本核算
- **进销存模块**：采购、销售、库存、供应商/客户管理
- **MRP 模块**：物料需求计划、生产订单、BOM、工艺路线、工作中心

## 环境要求

- **Node.js**: >= 18.0.0
- **npm**: >= 9.0.0 或 **pnpm**: >= 8.0.0 或 **yarn**: >= 1.22.0
- **Git**: >= 2.30.0

## 快速开始

### 1. 克隆项目

```bash
git clone <项目仓库地址>
cd erp-system
```

### 2. 安装依赖

使用 npm:
```bash
npm install
```

或使用 pnpm (推荐):
```bash
pnpm install
```

或使用 yarn:
```bash
yarn install
```

### 3. 配置环境变量

项目使用 Supabase 作为后端服务，配置已内置在代码中。如需自定义，创建 `.env` 文件：

```bash
# .env
VITE_SUPABASE_URL=https://your-supabase-url.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
```

### 4. 启动开发服务器

```bash
npm run dev
```

开发服务器默认运行在 http://localhost:5173

### 5. 构建生产版本

```bash
npm run build
```

构建产物将输出到 `dist/` 目录。

### 6. 预览生产构建

```bash
npm run preview
```

## 生产部署

### 前端 + AI 服务 的 Docker 方案

这个方案会把前端静态站点和 `ai-server` 一起交给 `docker compose` 管理。浏览器侧访问同域 `/api`，由 Nginx 反向代理到 AI 服务容器。

#### 1. 在本地或 CI 构建

```bash
npm run build
```

构建完成后会生成 `dist/` 目录。

#### 2. 上传到服务器

```text
dist/
ai-server/
docker-compose.yml
nginx.conf
scripts/
```

首次部署前先在服务器跑一次初始化脚本，它会创建 `certs/`、`certbot-webroot/` 并装好 certbot：

```bash
sudo bash scripts/server-init.sh <部署目录>
```

#### 3. 启动容器

```bash
docker compose up -d
```

#### 4. 访问应用

```text
https://operp.oplug.cn
```

HTTP 访问会 301 跳到 HTTPS。若证书尚未签发，此时是自签占位证书（浏览器会告警），
按下面「HTTPS 证书」一节签发真证书即可。

#### 5. 停止服务

```bash
docker compose down
```

## 自动发布（Gitee Go 流水线）

推送到 `master` 分支即自动构建并发布到自有主机，流水线配置见 `.workflow/deploy.yml`（格式参照图形视图导出的 `.workflow/流水线-202608132225.yml`）。

### 一次性准备

1. **服务器**：安装 Docker 并给部署用户权限（`scripts/server-init.sh` 可参考，其中目录部分改为主机 Agent 的 `~/gitee_go/deploy`）。
2. **主机 Agent**：在 Gitee 仓库 → Gitee Go → 主机管理 中给云服务器安装 Agent，注册到主机组 `operp`（已完成）。
3. **验证触发器**：流水线编辑页确认触发方式为「push 到 master 分支」，若 yml 中 triggers 格式报错，直接在图形视图里设置触发器保存即可。

### 发布流程

```text
git push origin master
  -> Gitee Go 云端构建（npm install + npm run build）
  -> 打包 dist/ + docker-compose.yml + nginx.conf 为制品并上传
  -> 部署到主机组 operp 的 ~/gitee_go/deploy 目录
  -> 在服务器执行 docker compose up -d --force-recreate 重启 nginx 容器
```

构建与部署日志在 Gitee 仓库的「Gitee Go」页查看。注意 Gitee Go 免费额度有构建时长限制。

## HTTPS 证书

站点域名 `operp.oplug.cn`，证书由 Let's Encrypt 签发，nginx 终结 TLS，AI 服务仍在容器内网走 HTTP。

### 一次性准备

1. **云安全组放行 TCP 80 与 443**。ACME 的 HTTP-01 校验必须能从公网访问 `http://operp.oplug.cn/.well-known/acme-challenge/`。
   校验命令：`curl -I http://operp.oplug.cn` 应返回 301，而不是超时。
2. **域名解析**：`nslookup operp.oplug.cn` 应指向本机公网 IP。
3. 在服务器执行 `sudo bash scripts/server-init.sh <部署目录>`，安装 certbot 并生成自签占位证书。

### 签发

```bash
cd <部署目录>
CERTBOT_EMAIL=you@example.com bash scripts/issue-cert.sh
```

脚本用 webroot 模式（`-w ./certbot-webroot`），不需要停 nginx；签发成功后会把证书复制到
`certs/fullchain.pem` 与 `certs/privkey.pem`，然后 `nginx -s reload`。

### 自动续期

`server-init.sh` 已写入续期钩子 `/etc/letsencrypt/renewal-hooks/deploy/operp-sync.sh`，
certbot 自带的定时器续期成功后会自动把新证书同步进 `certs/` 并重载 nginx。

手动检查：`certbot renew --dry-run`；查看证书有效期：
`openssl x509 -in certs/fullchain.pem -noout -dates`。

### 改域名要动的地方

`nginx.conf` 的两处 `server_name`、`scripts/issue-cert.sh` 的 `DOMAIN` 默认值、
`docker-compose.yml` 里 `ALLOWED_ORIGIN` 的默认值、以及续期钩子里的路径（重跑 `server-init.sh` 会重写）。

### Supabase 侧配套

在 Supabase 控制台 → Authentication → URL Configuration 里，把 Site URL 设为
`https://operp.oplug.cn`，并在 Redirect URLs 加上 `https://operp.oplug.cn/**`，
否则邮箱验证、密码重置等跳转会落在旧地址上。

## 常见问题

### 1. 端口被占用

如果 5173 端口被占用，Vite 会自动使用其他端口，或在 `vite.config.ts` 中指定：

```ts
export default defineConfig({
  server: {
    port: 3000,
  },
})
```

### 2. AI 服务环境变量

线上部署 `ai-server` 时，需要提供这些环境变量：

```bash
VITE_SUPABASE_URL=
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
LLM_API_KEY=
LLM_BASE_URL=
LLM_MODEL=
ALLOWED_ORIGIN=https://operp.oplug.cn
```

前端和 AI 服务通过同域 `/api` 访问，浏览器侧不会直接碰到 `3001` 端口，
所以 `ALLOWED_ORIGIN` 只需要填站点自己的 HTTPS 地址（默认已带，`.env` 里可覆盖）。

### 3. 依赖安装失败

尝试清除缓存后重新安装：

```bash
rm -rf node_modules package-lock.json
npm install
```

### 4. TypeScript 类型错误

运行 `npm run build` 检查类型错误并修复。

### 5. 样式不生效

确保 `src/index.css` 中正确导入 Tailwind：

```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

## 许可证

MIT
