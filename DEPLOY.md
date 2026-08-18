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

### 只部署 dist 的 Docker 方案

这个方案不需要在服务器上拉取源码，也不需要安装 Node.js。你只需要把 `dist/`、`docker-compose.yml`、`nginx.conf` 上传到服务器，然后用 Nginx 容器直接托管静态文件。

#### 1. 在本地或 CI 构建

```bash
npm run build
```

构建完成后会生成 `dist/` 目录。

#### 2. 上传到服务器

```text
dist/
docker-compose.yml
nginx.conf
```

#### 3. 启动容器

```bash
docker compose up -d
```

#### 4. 访问应用

默认访问地址：

```text
http://localhost:8080
```

#### 5. 停止服务

```bash
docker compose down
```

## 自动发布（Gitee Go 流水线）

推送到 `master` 分支即自动构建并发布到云服务器，流水线配置见 `.workflow/deploy.yml`。

### 一次性准备

1. **服务器初始化**：在云服务器上执行 `sudo bash scripts/server-init.sh`（安装 Docker、创建 `/opt/operp` 部署目录）。
2. **生成 SSH 密钥对**：`ssh-keygen -t ed25519 -f operp-deploy`，公钥追加到服务器 `~/.ssh/authorized_keys`。
3. **配置流水线密钥**：Gitee 仓库网页 → 服务 → Gitee Go → 流水线设置 → 环境变量管理，添加：
   - `SSH_HOST` / `SSH_PORT` / `SSH_USER`：服务器地址、端口、用户
   - `SSH_PRIVATE_KEY`：上面生成的私钥内容
   - `DEPLOY_DIR`：部署目录（如 `/opt/operp`）

### 发布流程

```text
git push origin master
  -> Gitee Go 自动触发构建（npm install + npm run build）
  -> 打包 dist/ + docker-compose.yml + nginx.conf
  -> scp 上传服务器并在 DEPLOY_DIR 解压
  -> docker compose up -d --force-recreate 重启 nginx 容器
```

构建日志可在 Gitee 仓库的「Gitee Go」页查看。注意：Gitee Go 免费额度有时长限制，如超量可改为 WebHook + 服务器脚本方案。

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

### 2. 依赖安装失败

尝试清除缓存后重新安装：

```bash
rm -rf node_modules package-lock.json
npm install
```

### 3. TypeScript 类型错误

运行 `npm run build` 检查类型错误并修复。

### 4. 样式不生效

确保 `src/index.css` 中正确导入 Tailwind：

```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

## 许可证

MIT
