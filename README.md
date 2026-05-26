# Supabase ERP 管理系统

一个功能完整的企业资源计划（ERP）系统，采用现代前端技术栈构建。

---

## 🛠️ 技术栈

### 前端框架与工具
- **React 18.2** - UI 组件库
- **TypeScript 5.9** - 类型安全的 JavaScript
- **Vite 5.4** - 构建工具（快速开发体验）
- **React Router DOM 6.26** - 路由管理

### UI 组件库
- **Ant Design 6.3** - 企业级 UI 组件库
- **Pro Components 2.8** - 专业组件（表格、表单等）
- **Tailwind CSS 3.4** - 实用优先的 CSS 框架
- **Lucide React 0.436** - 图标库

### 数据库与后端服务
- **Supabase** - 后端即服务（BaaS）平台
  - PostgreSQL 数据库
  - 实时数据库、认证、存储等功能
  - @supabase/supabase-js 2.45

### 工具库
- **dayjs 1.11** - 轻量级日期处理库
- **rc-field-form 2.7** - 表单管理库

---

## 🏗️ 架构设计

### 架构类型
- 前端 SPA（单页面应用）架构
- 无独立后端，使用 Supabase 作为 BaaS 服务
- 前后端通过 Supabase SDK 直接交互

### 目录结构
```
src/
├── components/       # 公共组件（Layout、ProLayout）
├── pages/            # 页面组件（按业务模块划分）
│   ├── finance/      # 财务模块
│   ├── inventory/    # 进销存模块
│   ├── mrp/          # 生产制造模块
│   └── system/       # 系统管理模块
├── types/            # TypeScript 类型定义
├── utils/            # 工具函数（Supabase 客户端、日志）
├── App.tsx           # 主应用组件（路由配置）
└── main.tsx          # 应用入口
```

### 路由结构
- `/` - 首页（Dashboard）
- `/finance/*` - 财务管理模块
- `/inventory/*` - 进销存管理模块
- `/mrp/*` - 生产制造 MRP 模块
- `/system/*` - 系统管理模块

---

## 🗄️ 数据库设计

### 数据库平台
Supabase PostgreSQL

### 数据表（40+ 张表）

| 模块 | 主要表 |
|------|--------|
| **系统管理** | `sys_users`、`sys_roles`、`sys_menus`、`sys_logs` |
| **基础数据** | `erp_companies`、`erp_departments`、`erp_employees` |
| **进销存** | `erp_customers`、`erp_suppliers`、`erp_products`、`erp_warehouses`、`erp_inventory`、`erp_purchase_orders`、`erp_sales_orders` |
| **财务** | `erp_account_subjects`、`erp_vouchers`、`erp_receivables`、`erp_payables`、`erp_fixed_assets` |
| **生产 MRP** | `erp_boms`、`erp_routing_operations`、`erp_work_centers`、`erp_production_orders`、`erp_mrp_plans` |

### 数据库特点
- 所有表都有标准字段：`id`、`corp_id`、`emp_id`、`is_deleted`、`created_at`、`updated_at`
- 完整的外键关联设计
- 支持软删除（`is_deleted` 字段）
- TypeScript 类型自动生成（`types/database.ts`）

---

## 📦 依赖分析

### 生产依赖
```json
{
  "@ant-design/icons": "^6.1.1",       // 图标
  "@ant-design/pro-components": "^2.8.10", // Pro 组件
  "antd": "^6.3.5",                    // Ant Design 组件库
  "dayjs": "^1.11.20",                 // 日期处理
  "rc-field-form": "^2.7.1",           // 表单管理
  "react": "^18.2.0",                  // React
  "react-dom": "^18.2.0"               // React DOM
}
```

### 开发依赖
```json
{
  "@supabase/supabase-js": "^2.45.0",  // Supabase 客户端
  "@types/react": "^18.3.3",           // React 类型
  "autoprefixer": "^10.4.19",          // CSS 前缀
  "eslint": "^9.9.0",                  // 代码检查
  "postcss": "^8.4.39",                // CSS 处理
  "react-router-dom": "^6.26.0",       // 路由
  "tailwindcss": "^3.4.7",             // Tailwind CSS
  "typescript": "^5.9.3",              // TypeScript
  "vite": "^5.4.0"                     // 构建工具
}
```

---

## 🎯 业务模块

系统包含 **4 大核心模块**，共 **20+ 业务功能页面**：

### 1. 🏠 首页
- Dashboard 仪表盘

### 2. 💰 财务管理模块
- 会计科目管理
- 凭证管理
- 应收账款管理
- 应付账款管理
- 固定资产管理

### 3. 📦 进销存管理模块
- 客户管理
- 供应商管理
- 物料管理
- 仓库管理
- 库存查询
- 采购订单管理
- 销售订单管理

### 4. 🏭 生产制造 MRP 模块
- BOM（物料清单）管理
- 工艺路线管理
- 工作中心管理
- 工序管理
- 生产订单管理
- MRP 计划管理

### 5. ⚙️ 系统管理模块
- 用户管理
- 角色管理
- 菜单管理
- 日志管理

---

## 🔑 关键特性

1. **企业级设计** - 使用 Ant Design + Pro Components
2. **类型安全** - 完整的 TypeScript 类型定义
3. **现代化工具链** - Vite 快速开发
4. **无服务器架构** - Supabase 简化后端开发
5. **完整的 ERP 业务流程** - 覆盖制造企业核心流程
6. **模块化设计** - 业务模块清晰分离
7. **响应式布局** - Tailwind CSS 实现

---

## 🚀 启动方式

```bash
# 安装依赖
npm install

# 启动开发服务器
npm run dev

# 构建生产版本
npm run build

# 代码检查
npm run lint
```

---

## 📝 项目概述

这是一个功能完整、架构清晰的 **现代化 ERP 前端系统**，适合作为制造企业的信息化管理平台。

---

© 2024 悟空 ERP System
