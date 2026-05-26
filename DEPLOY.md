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

## 项目结构

```
.
├── index.html              # HTML 入口文件
├── package.json            # 项目依赖和脚本
├── postcss.config.js       # PostCSS 配置
├── tailwind.config.js      # Tailwind CSS 配置
├── tsconfig.json           # TypeScript 配置
├── vite.config.ts          # Vite 配置
├── public/                 # 静态资源
│   ├── favicon.svg
│   └── icons.svg
├── src/
│   ├── main.tsx           # 应用入口
│   ├── index.css          # 全局样式
│   ├── App.tsx            # 主路由配置
│   ├── components/        # 公共组件
│   │   └── Layout.tsx     # 布局组件
│   ├── pages/             # 页面组件
│   │   ├── Dashboard.tsx  # 首页仪表板
│   │   ├── finance/       # 财务模块页面
│   │   ├── inventory/     # 进销存模块页面
│   │   └── mrp/           # MRP 模块页面
│   ├── types/             # TypeScript 类型定义
│   │   └── database.ts    # 数据库类型
│   └── utils/             # 工具函数
│       └── supabase.ts    # Supabase 客户端
└── supabase/
    └── tables/            # 数据库表结构 SQL
```

## 常用命令

| 命令 | 说明 |
|------|------|
| `npm run dev` | 启动开发服务器 |
| `npm run build` | 构建生产版本 |
| `npm run preview` | 预览生产构建 |
| `npm run lint` | 运行 ESLint 检查 |

## 技术栈

- **前端框架**: React 18
- **开发语言**: TypeScript 5
- **构建工具**: Vite 5
- **样式框架**: Tailwind CSS 3
- **UI 组件**: Radix UI
- **图标库**: Lucide React
- **后端服务**: Supabase
- **路由**: React Router 6

## 数据库配置

项目使用 Supabase 作为后端数据库，包含以下主要表：

### 财务模块
- `erp_account_subjects_s_539dcf81_b` - 会计科目
- `erp_vouchers_s_539dcf81_b` - 凭证
- `erp_receivables_s_539dcf81_b` - 应收账款
- `erp_payables_s_539dcf81_b` - 应付账款
- `erp_fixed_assets_s_539dcf81_b` - 固定资产

### 进销存模块
- `erp_customers_s_539dcf81_b` - 客户
- `erp_suppliers_s_539dcf81_b` - 供应商
- `erp_products_s_539dcf81_b` - 物料
- `erp_warehouses_s_539dcf81_b` - 仓库
- `erp_inventory_s_539dcf81_b` - 库存
- `erp_purchase_orders_s_539dcf81_b` - 采购订单
- `erp_sales_orders_s_539dcf81_b` - 销售订单

### MRP 模块
- `erp_boms_s_539dcf81_b` - BOM
- `erp_routing_operations_s_539dcf81_b` - 工艺路线
- `erp_work_centers_s_539dcf81_b` - 工作中心
- `erp_production_orders_s_539dcf81_b` - 生产订单
- `erp_mrp_plans_s_539dcf81_b` - MRP 计划

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

## 生产部署

### 静态托管

构建完成后，将 `dist/` 目录部署到任意静态托管服务：

```bash
npm run build
# 部署 dist/ 目录到服务器
```

### Docker 部署

创建 `Dockerfile`：

```dockerfile
FROM node:18-alpine as builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
```

## 许可证

MIT
