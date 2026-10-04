# OPERP · AI 原生智能 ERP 平台

一个面向制造企业的**多租户、AI 原生**企业资源计划（ERP）系统。

它不只是「给 ERP 加了个聊天框」——系统把 **AI 智能体、BAQ 业务活动查询、DocType 单据类型、Workflow 审批流、单据转换（DocFlow）** 五件事做成了平台级底座：业务元数据全部可配置，单据流转规则全部声明式定义，用户既能在界面上点，也能用自然语言让 AI 直接建单、过账、审批、转单。

![alt text](image.png)

---

## ✨ 核心亮点

| 亮点 | 说明 | 实现落点 |
|------|------|----------|
| 🤖 **AI 智能体（LangGraph）** | 意图路由 → 规划 → 工具执行 → 记忆 → 回复组装，全链路可编排、可审计；不只是问答，能**直接操作业务单据** | `ai-server/src/ai/` |
| 🧩 **DocType 单据类型引擎** | 单据类型即元数据（表名、主键、命名规则、是否可提交、审批流、表单/列表配置），驱动取名、状态回写、页面生成 | `deploy_15` / `sys_document_types` |
| 🔀 **单据转换（DocFlow）** | 声明式「源单 → 目标单」字段映射 + **追加式数量台账**，防止超下推，支持整单反冲 | `deploy_35~38` |
| ✅ **Workflow 审批流** | 可视化流程定义、条件分支、多级审批、驳回/撤回、审批历史，审批结果自动回写单据状态 | `deploy_14/16/49` |
| 🔎 **BAQ 业务活动查询** | 不写 SQL，可视化拼装主表/关联/筛选/聚合/排序，发布后可作页面数据源，也可被 AI 调用 | `deploy_12` / `src/features/baq` |
| 🎨 **动态页面设计器** | 拖拽组件、绑定多数据源（静态 JSON / 表 / BAQ），发布即生成菜单 | `src/features/page-builder` |
| 🏢 **多租户 + 多币别** | 基线-副本双层授权、行级 RLS 隔离；双金额记账、汇率冻结、汇兑损益与期末调汇 | `deploy_41~78` |
| 🧠 **RAG 知识库** | pgvector 向量检索，制度/流程/手册问答，回答带出处 | `deploy_25/28/29` |

---

## 🤖 AI 能力（核心）

AI 是本系统的一等公民。它运行在一个独立服务 **`ai-server`**（Express 5 + LangGraph + MCP）中，而不是散落在前端的临时脚本里。

### 1. 智能体编排（LangGraph 状态图）

`ai-server/src/ai/graph.ts` 用 LangGraph 把一次对话拆成可测试、可观测的节点流水线：

```
START → contextLoader → intentRouter → planner → toolExecutor → memoryWriter → responseComposer → END
                                            ↑____________|
                                        （多步计划循环，上限 5 步）
```

| 节点 | 职责 |
|------|------|
| `contextLoader` | 加载会话记忆、最近消息、当前页面上下文、租户身份 |
| `intentRouter` | 意图识别 + 技能路由 + 业务对象识别（规则强信号优先，LLM 兜底） |
| `planner` | 复杂诉求拆解为多步计划；写步骤先产草稿并冻结剩余计划 |
| `toolExecutor` | 调用工具/单据 RPC；支持 `$prev.<field>` 引用上一步产出 |
| `memoryWriter` | 落库会话记忆（意图、目标、聚焦对象），支撑「它/这个/刚才那单」 |
| `responseComposer` | 组装回复（文本 / 表格 / 卡片 / 跳转链接），统一剥离租户后缀 |

**意图与技能**：`chat`、`knowledge`、`create`、`update`、`baq`、`analysis`、`document`（单据操作）、`confirm_execute` / `cancel_action`（草稿确认回路）。
**前端技能选择器**：自动 / 数据分析 / 创建业务 / 业务动作 / 创建 BAQ / 普通对话。

### 2. 能力矩阵

| 能力 | 用户怎么用 | 系统做了什么 |
|------|-----------|-------------|
| **数据问答与分析** | 「帮我分析本月应收应付风险」「哪些物料低于安全库存」 | 识别分析意图 → 查询真实租户数据 → 生成指标、异常、成因、建议；SQL 执行有 5s 超时 + 强制 LIMIT + 危险函数黑名单 |
| **自然语言建单** | 「建一张采购订单给上海钢铁，物料 A 100 个」 | LLM 抽取字段 → 名称解析为 ID → **生成草稿** → 用户回复「确认」才落库 |
| **单据动作** | 「把这张采购订单过账」「反过账」「驳回」「转成入库单」 | 调用库内 RPC，走统一的单据状态闸门与幂等键 |
| **多步计划** | 「新建客户，然后给它开一张销售订单」 | 确定性组合成计划，逐步产草稿/执行，`$prev` 串联前后步骤 |
| **知识问答（RAG）** | 「入库流程应该怎么走」「XX 制度怎么规定」 | 向量检索知识库 → 回答附来源 |
| **BAQ 生成** | 「我要查各客户的销售额汇总」 | 生成 BAQ 配置草稿，确认后保存 |

### 3. 两段式写库确认（安全底线）

AI **不会**在没有确认的情况下写业务数据：

```
用户指令 → prepareEntityUpsert → 草稿写入 sys_ai_pending_actions（30 分钟 TTL）
        → 用户回复「确认」/ 调 POST /api/ai/confirm → 才真正执行
```

- 草稿带**用户 + 租户归属校验**、**一次性执行**（重复提交返回 already_handled），天然幂等。
- 单据类写入（建单/过账/反过账/审批/转单）走库内 RPC（`deploy_83`），在同一事务内注入身份，**租户隔离与单据号取号都按真实租户工作**。
- 所有 AI 动作落审计表 `sys_ai_operation_logs`（`services/aiAudit.ts`）。

### 4. 信任边界（AI 不是后门）

| 措施 | 说明 |
|------|------|
| **统一鉴权** | `/api/ai/*`、`/api/mrp|mps|finance/*` 全部过 `requireAuth`（Supabase JWT → `sys_users.auth_id` → 租户上下文），请求体里的 `user_id` 只做一致性校验 |
| **服务端角色校验** | 角色从 `sys_user_roles` 查（`services/roleGuard.ts`），不看请求体声明；租户错配/无权限 403，状态不允许 409 |
| **限流** | 挂在鉴权之后，避免匿名请求污染配额 |
| **SQL 加固** | `execute_ai_analysis` 限制超时、行数与可用函数 |
| **身份注入** | service_role 路径通过 `service_*` 包装在同一事务内注入 `app.tenant_id` + JWT claims，不另起一套租户逻辑 |

### 5. MCP 服务（把 ERP 变成 Agent 工具）

`ai-server/src/mcp/` 提供标准 **Model Context Protocol** 服务，可接入 Claude Desktop / WorkBuddy / Cursor 等客户端，让外部智能体直接使用 ERP 能力。共 **10 个工具**：

**只读（6）**：`erp_list_entities`、`erp_describe_entity`、`erp_count_records`、`erp_finance_summary`、`erp_business_analysis`、`erp_search_knowledge`
**单据（4）**：`erp_query_documents`（只读）、`erp_create_document` / `erp_document_action`（产草稿）、`erp_commit_document`（写库）

- 写操作拆成 **「草稿 → 提交」两次调用**（MCP 里没有「回复确认」这一轮），草稿 30 分钟 TTL、一次性执行。
- 身份解析采用**数据库优先**：`MCP_API_KEY` → `sys_mcp_api_keys`（只存 sha256 摘要，前端「我的密钥」自助签发），`.env` 仅兜底。
- 客户端接入位置：连接器管理 → 右上角「自定义连接器」。

---

## 🧩 DocType 单据类型引擎

参考 ERPNext / Frappe 的 DocType 思路，把「一张单据是什么」收敛成一份**元数据**（`sys_document_types`），业务代码与单据类型解耦。

| 元数据字段 | 作用 |
|-----------|------|
| `document_type` / `document_name` | 唯一类型码与展示名 |
| `table_name` / `primary_key_field` | 物理表与主键 → 审批结果能**自动回写**单据状态 |
| `naming_rule` | 单号规则，如 `PO{YYYY}{####}` |
| `is_submittable` / `is_single` / `is_child` / `is_tree` | 单据形态 |
| `workflow_process_id` | 绑定的审批流 |
| `form_config` / `list_config` / `permission_config` | 表单、列表、权限配置（JSONB） |

**统一取号**：`generate_document_no()`（`deploy_32`）按 `naming_rule` 原子取号，支持 `{YYYY} {YY} {MM} {DD} {####}` 令牌，计数器在日期令牌进位时自动归零——采购/销售/出入库/调拨/盘点/调整/凭证/生产订单/领料/MRP 计划全部走它，不再依赖前端时间戳。
**字段自动同步**：`sync_document_type_fields()` 让表结构变化与元数据保持一致。
**管理界面**：`/system/document-types`（DocType 构建器）。

---

## 🔀 单据转换引擎（DocFlow）

单据转换回答的是「**一张单能生成什么**」——与「谁审批、按什么顺序审批」的工作流刻意分离。核心是**声明式规则 + 追加式台账**（`deploy_35` ~ `deploy_38`）。

| 表 | 作用 |
|----|------|
| `doc_flow_rules` | 源单 → 目标单的转换规则（含数量字段、过账要求等） |
| `doc_flow_field_maps` | 单头 / 明细的字段映射（支持取值、引用、常量、表达式） |
| `doc_flow_transfers` | **追加式数量台账**：已转数量、目标单、反向冲销行 |
| `doc_flow_source_meta` / `doc_flow_doc_meta` | 源单/目标单的元信息 |

**设计取舍**：

- **台账只追加、从不物理删除**：反冲是插入一条负数行并指向原行（`reversed_transfer_id`），任何源单行都能审计回每一次转换与冲销。
- **已转数量 = 台账 `SUM(quantity)`**：负数行自然抵消，不需要额外的「是否有效」标志位去同步。
- **台账由目标明细表上的触发器维护**，而不是由生成函数维护——手工建的单和转来的单走完全相同的路径，不会出现两套口径。
- **防超下推**：部分唯一索引 + `doc_flow_ledger_convert` 兜住并发。
- **可视化**：`doc_flow_connections()` 输出单据连接图，前端用 `DocFlowConnectionsGraph` 展示，工具栏 `DocFlowGenerateButton` 一键下推。

**AI 与它是同一套**：`FLOW_RULES` 里注册的三条主线（采购订单→采购入库、销售订单→销售出货、生产订单→生产领料）既是界面上的按钮，也是 AI 说的「转成入库单」。订单类单据不可直接过账，AI 的计划器会自动把第二步换成「转单」。

---

## ✅ Workflow 审批流引擎

轻量但可配置的工作流引擎（`deploy_14` / `deploy_16` / `deploy_49`），支持多级顺序审批、驳回、撤回与完整历史。

| 表 | 作用 |
|----|------|
| `wf_process_definitions` | 流程定义（流程码、单据类型、版本、是否启用） |
| `wf_process_nodes` | 流程节点（审批角色、顺序、条件） |
| `wf_process_actions` | 流转动作（提交、通过、驳回、撤回） |
| `wf_process_instances` | 运行实例（按「租户 + 单据类型 + 单据 ID」唯一） |

**关键设计**：

- **状态双写在一个事务内**：`workflow_execute_action` 从持久化的图边与结构化条件里解析下一节点，并通过 DocType 元数据把审批结果**写回真实业务表的状态列**，`wf_process_instances` 与单据自身的 `status` 不会漂移。
- **条件求值**：`workflow_evaluate_condition` / `workflow_compare_value` 支持结构化条件分支。
- **前端组件**：`WorkflowDiagram`（流程图）、`ConditionEditor`（条件编辑）、`WorkflowActionBar`（单据页动作条）、`WorkflowHistoryCard`（审批历史）。
- **每个单据动作不变量只有一份实现**：`services/documentService.ts` 的 `validateDocumentAction()` 同时被 HTTP 与 MCP 调用，不在别处另写状态闸门。

---

## 🔎 BAQ 业务活动查询

BAQ（Business Activity Query，业务活动查询）让业务人员在**不写 SQL** 的前提下，可视化拼装面向场景的数据查询（`deploy_12`）。

- 可视化配置**主表 / 关联表 / 表别名**
- 字段选择、**分组、聚合、筛选、排序**
- **草稿 → 发布** 两态管理，实时结果预览
- 表/字段名称维护，面向业务人员可读
- 已发布 BAQ 可直接作为**动态页面的数据源**，也可被 **AI 调用**生成

`baq_catalog()` 会输出可用的表与列清单，`aiBaqTools.ts` 用它把自然语言转换成 BAQ 配置草稿。

管理界面：`/system/baq`。

---

## 🎨 动态页面设计器

可视化把组件、布局和数据源编排成页面，发布即生成菜单（`deploy_08`，路由 `/custom/:slug`）。

- 拖拽添加文本、指标、按钮、表格、图表等组件，支持网格布局与尺寸调整
- 三种数据源：**静态 JSON / Supabase 表 / BAQ**
- 草稿保存与发布，发布后成为正式菜单项
- 适合业务看板、经营仪表盘、专题分析页、基于 BAQ 的查询展示页

管理界面：`/system/page-designer`。

---

## 🏢 业务模块

系统包含 **5 大模块、60+ 业务页面**，菜单名全量中英双语（i18n 键当前 **3034 × 2**）。

### 🏠 首页与工作台
- 经营驾驶舱（Dashboard）、工作台（Workbench）

### 💰 财务
会计科目、凭证（支持多币种分录）、总账余额、试算平衡（本位币/按币种双口径）、科目明细账、会计期间、应收、应付、固定资产、资产类别
> 含**汇兑损益**：核销差额 + 期末调汇，`fx_gain_loss` 取 6603 净借方（正=损失，负=收益）。

### 📦 进销存
客户、供应商、物料（含图片）、仓库、库位、库存查询、采购订单、采购入库、销售订单、销售出货、库存流水、库存调拨、盘点、库存调整、单位换算（UOM）、物料分类

### 🏭 生产制造
部门、BOM（含可编辑树图）、工艺路线（含流程图）、工作中心、工序、生产订单、生产领料、生产入库、生产报工、成本核算、MRP 计划、MPS 主生产计划、质量检验

### ⚙️ 系统
用户、租户、角色、菜单、系统设置、数据字典、单位、**币别与汇率**、**工作流配置**、**单据转换配置**、**单据类型（DocType）**、日志、**页面设计器**、**BAQ**、**知识库**、我的 MCP 密钥

---

## 🗄️ 数据库与多租户

- **PostgreSQL（Supabase）**，**104 张表**：66 张 `erp_*` 业务表 + 29 张 `sys_*` 系统/元数据表 + 4 张 `wf_*` 工作流表 + 5 张 `doc_flow_*` 转换表
- **85 个迁移脚本**（`supabase/tables/deploy_01` ~ `deploy_83`），可按编号顺序整体重放
- **多租户隔离**：`sys_tenants` 上触发器自动为新租户物化基线（菜单、角色、字典、表权限、币别）；行级 RLS + 表权限 + 基线/副本双层授权
- **RLS 语义**：`erp_*` 物理表带租户后缀 `_s_539dcf81_b`（设计如此）；`sys_*` 无后缀
- **多币别**：双金额（原币 + 本位币）、汇率冻结在单据上、库存/凭证/报表一律本位币记账，汇率方向恒为「1 单位外币 = rate 单位本位币」
- 全站金额展示统一走 `src/utils/money.ts`，输入用 `MoneyInput`

---

## 🛠️ 技术栈

### 前端
- **React 18.2** + **TypeScript 5.9** + **Vite 5.4** + **React Router 6**
- **Ant Design 6** + **Pro Components 3.1** + **Ant Design X 2.8**（AI 对话组件）
- **@ant-design/charts**（图表）、**@antv/x6**（流程图/关系图）、**react-grid-layout**（拖拽布局）
- **Tailwind CSS 3.4**、**i18next / react-i18next**（中英双语）
- **operp-print-designer**（打印设计器）

### 后端（`ai-server`）
- **Express 5** + **Zod**（校验）
- **LangGraph / LangChain**（智能体编排）
- **@modelcontextprotocol/sdk**（MCP 服务）
- **Supabase JS**（service_role 直连，显式租户过滤）

### 数据与模型
- **Supabase / PostgreSQL**，**pgvector**（知识库向量检索）
- **Ollama / OpenAI 兼容代理**（多套模型配置，存于 `sys_config` 的 `ai` 分类，支持**按租户覆盖**基线配置；API Key 建议放服务端环境变量）

---

## 🏗️ 架构概览

```
┌──────────────────────────────┐        ┌──────────────────────────────┐
│  前端 SPA (React + Vite)      │        │  外部 AI 客户端                │
│  ├─ 业务页面 / BAQ / 页面设计器 │        │  (Claude Desktop / Cursor…)   │
│  ├─ AI 对话抽屉 (antd/x)      │        └───────────────┬──────────────┘
│  └─ Supabase SDK（直接读写）   │                        │ MCP (stdio)
└───────────┬──────────────────┘                        │
            │  REST (Bearer JWT)                        │
            ▼                                           ▼
┌───────────────────────────────────────────────────────────────────────┐
│                        ai-server (Express 5 :3001)                     │
│  鉴权 / 限流 / 角色校验  →  AI 编排 (LangGraph)  →  工具层 / 单据动作      │
│                                           └──→  MCP 服务（10 工具）      │
└───────────────────────────────┬───────────────────────────────────────┘
                                │ service_role（显式租户过滤）
                                ▼
┌───────────────────────────────────────────────────────────────────────┐
│              Supabase / PostgreSQL（RLS + 104 张表）                     │
│  业务内核全部落在库内 RPC：取号 / 过账 / 反过账 / 审批 / 转单 / 核销 / 调汇  │
│  保证多表写入的单事务原子性、行级锁、租户兜底                              │
└───────────────────────────────────────────────────────────────────────┘
```

**业务内核放哪**：多表写入的原子性、`pg_advisory_xact_lock` 行级锁、RLS 与 `current_sys_user_id()` 兜底这三件事只有数据库里能做——因此**默认写库内 RPC**；ai-server 只承接外部 IO（LLM/HTTP）、跨事务的长流程、纯计算（MRP 展开、成本卷积）以及拿不到 JWT 的调用方（定时任务、MCP）。

---

## 📁 目录结构

```
supabase-erp/
├── src/                           # 前端
│   ├── components/                # 公共组件（AI 抽屉、工作流、单据转换、附件、通知…）
│   │   ├── AIChatPanel.tsx        # AI 对话主面板
│   │   ├── McpGuideDrawer.tsx     # MCP 接入指引
│   │   ├── WorkflowActionBar.tsx  # 单据审批动作条
│   │   ├── DocFlowGenerateButton.tsx  # 单据下推按钮
│   │   └── workflow/              # 流程设计器组件
│   ├── features/
│   │   ├── baq/                   # BAQ 设计器
│   │   └── page-builder/          # 动态页面设计器
│   ├── pages/                     # 业务页面（finance / inventory / mrp / system）
│   ├── locales/                   # i18n（zh-CN / en-US）
│   └── utils/                     # supabase 客户端、money、AI 工具、单据转换规则…
├── ai-server/                     # AI 服务
│   └── src/
│       ├── ai/                    # LangGraph 编排（graph + nodes + planRunner）
│       ├── api/                   # 路由（ai / mrp / mps / finance / health）
│       ├── services/              # 单据动作、MRP 引擎、成本卷积、知识库、审计…
│       ├── tools/                 # 实体注册表、ERP 查询工具
│       └── mcp/                   # MCP 服务（stdio）
├── supabase/
│   ├── tables/                    # 85 个迁移脚本（deploy_01 ~ deploy_83）
│   └── functions/                 # Edge Functions（建租户用户、重置密码）
├── docs/                          # 设计与评估文档
└── README.md
```

---

## 🚀 快速开始

### 前置要求
- Node.js 18+、Docker（运行本地 Supabase）

### 1. 启动数据库

```bash
# 在 Supabase 本地实例目录下启动（本仓库只含 tables/functions，不含 config.toml）
supabase start

# 按编号顺序部署全部表结构（脚本已按依赖排序）
bash supabase/tables/000_run_all.local.sh
```

默认端口：`54321` Kong 网关、`54322` Postgres、`54323` Studio、`54324` Mailpit。

### 2. 启动 AI 服务

```bash
cd ai-server
npm install
cp .env.example .env          # 填入 SUPABASE_URL / SERVICE_ROLE_KEY / 模型配置
npm run dev                   # http://localhost:3001
```

### 3. 启动前端

```bash
npm install
npm run dev                   # http://localhost:5173
```

### 4. （可选）接入 MCP 客户端

```bash
cd ai-server && npm run build
# 在 ~/.workbuddy/mcp.json（或等价客户端配置）中注册 stdio 服务，
# 指向 node 绝对路径 + ai-server/dist/mcp/server.js，
# env 里放 MCP_API_KEY（在系统 →「我的密钥」中生成）
```

### 常用命令

```bash
npm run dev        # 前端开发服务器
npm run build      # 前端生产构建
npm run lint       # 代码检查

cd ai-server
npm run dev        # AI 服务开发（tsx watch）
npm run build      # 编译到 dist/
npm run mcp:smoke  # MCP 工具冒烟测试（默认不写业务数据）
```

### 默认账号

```
超管：admin@operp.com / admin123（上线请立即修改）
```

---

## 📚 相关文档

| 文档 | 内容 |
|------|------|
| `docs/page-designer.md` | 动态页面设计器设计说明 |
| `docs/production-planning-implementation.md` | MRP / MPS 生产计划实现 |
| `docs/production-planning-marketing.md` | 生产计划能力对外说明 |
| `docs/multi-currency-assessment.md` | 多币别方案评估 |
| `docs/posting-logic.md` | 单据过账逻辑 |
| `docs/inventory-transaction-types.md` | 库存交易类型设计 |
| `docs/custom-menu-architecture.md` | 自定义菜单架构 |
| `docs/database-types.md` | 数据库类型设计 |
| `docs/notification-center.md` | 通知中心 |
| `docs/subscription-billing-design.md` | 订阅计费设计 |
| `docs/saas-transformation-assessment.md` | SaaS 化改造评估 |
| `supabase/tables/README_DEPLOYMENT.md` | 数据库部署说明 |

---

© 2026 OPERP System
