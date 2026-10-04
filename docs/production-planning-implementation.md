# 生产计划（MRP / MPS）功能落地文档

> 更新日期：2026-10-04
> 范围：`/mrp` 菜单下的生产计划全链路 —— 基础主数据 → 生产单据过账 → BOM 展开/齐套 → MRP 运算 → 计划转单 → 成本卷算 → MPS 主生产计划。
> 读者：后续接手维护的开发者、参与验收的产品/测试。

---

## 一、功能全景

生产计划模块在产品内覆盖以下能力：

| 能力域 | 内容 | 主要入口 |
|---|---|---|
| 基础主数据 | 工作中心、工序、工艺路线、部门、BOM | `/mrp` 下各页面 |
| 生产执行 | 生产订单（MO）、生产领料单、生产退料单、完工入库单、生产报工 | `ProductionOrders / MaterialIssues / ProductionReceipts / ProductionReports` |
| 计划运算 | MPS 主生产计划（确认/锁定/下推/RCCP）、MRP 物料需求运算 | `MpsPlans / MrpPlans` |
| 计划落地 | MRP 计划订单转采购订单/生产订单 | `MrpPlans`（转单面板） |
| 成本 | 生产成本卷算（材料/人工/制费/在制） | `CostCalculations` |
| 质量 | 质量检验单 | `QualityInspections` |

业务闭环：**销售/预测 → MPS 确认 → 下推生产订单 → MRP 运算（含 MPS 供给）→ 计划订单转 PO/MO → 领料过账出库 → 完工入库过账 → 成本卷算**。

---

## 二、总体架构

三段式：

```
前端 React (src/pages/mrp/*)
        │  supabase-js（单据 CRUD，走 RLS） + aiServer client（运算/转单/成本）
        ▼
ai-server (Express 5, :3001)
        │  确定性计算引擎（纯 TS）+ LLM 报告 + service_role 写库
        ▼
PostgreSQL (Supabase)
   单据表 + 过账 RPC + 触发器 + RLS（多租户隔离）
```

- **单据/状态流转在库内**（RPC + 触发器，单事务原子性 + `pg_advisory_xact_lock`）。
- **运算主体在 ai-server**（MRP 引擎是确定性纯函数，可测试、可复现；LLM 只生成解读报告，不参与任何数字计算）。
- **前端只做编排与展示**，不自己算数量/成本。

关键代码位置：

| 层 | 文件 |
|---|---|
| MRP 引擎 | `ai-server/src/services/mrpEngine.ts` |
| MRP 编排 | `ai-server/src/services/mrpService.ts` |
| LLM 报告 | `ai-server/src/services/mrpAdvisor.ts` |
| 计划转单 | `ai-server/src/services/mrpConvertService.ts` |
| 成本卷算 | `ai-server/src/services/costRollupService.ts` |
| MPS 服务 | `ai-server/src/services/mpsService.ts` |
| 路由 | `ai-server/src/api/mrp.routes.ts`、`ai-server/src/api/mps.routes.ts` |
| 角色白名单 | `ai-server/src/services/roleGuard.ts` |

---

## 三、分阶段落地记录

> 改造起点（2026-10-01 审计）：MRP 只有壳 —— `erp_mrp_requirements` 零引用、`MrpPlans.handleRunMrp` 只改状态、生产类三张表是死表、生产类单据无法过账。
> 改造顺序刻意不可颠倒：**先补过账闭环与 BOM 展开，再写运算引擎**（净需求无处落地时，运算只是报表）。

### 阶段 1 · 生产单据过账闭环（deploy_56 / 58 / 59）

- RPC：`post_production_document` / `reverse_production_document(p_document_type, p_document_id, p_idempotency_key)`，`SECURITY INVOKER`（租户靠 RLS + `tenant_id DEFAULT current_tenant_id()`）。
- 支持单据类型：`material_issue`（领料出库）、`production_receipt`（完工入库，主表即唯一明细行）；生产退料走库存单据通道。
- 状态机：`draft | approved | issued` → **posted** → 反过账退回 **draft**（刻意非 approved，留给人工确认是否重新审批）。
- 库存流水 `quantity` / `total_cost` **带符号**（出库为负）；反过账 = 库存 − 流水。
- 成本口径：出库取**移动加权单价**，入库取单据单价。
- 并发控制：`pg_advisory_xact_lock(hashtextextended('erp_inventory:产品:仓:库位:批次'))`，锁键含库位。
- deploy_58 补库位维度：领料单库位放**明细行**（`erp_material_issue_details.location_id`）、完工入库放**表头**（`erp_production_receipts.location_id`），函数内 `COALESCE(明细, 表头)` 统一取值；同时注册 `production_receipt` 单据类型（编号 `PRT{YYYY}{####}`）。
- 前端入口：`MaterialIssues.tsx` 工具栏，支持多选批量过账/反过账。

### 阶段 2 · BOM 展开与齐套（deploy_57）

- RPC：`explode_production_order_bom(order_id, replace)`、`production_kit_check(order_id)`（返回 `done / ready / transfer / short` 四态）、`generate_material_issue_from_order`、`pull_order_lines_into_issue`。
- **用量公式**：`订单计划量 × BOM行用量 ÷ BOM.quantity × (1 + loss_rate)`。⚠️ `loss_rate` 存小数（0.05 = 5%），直接 `1 + loss_rate`，**不要 /100**。
- 取舍：
  - 齐套检查**按物料聚合、不按订单行**（同一物料多行会重复算库存 = 假齐套）。
  - 已领料或台账已挂源行 → 拒绝重展开。
  - **刻意不做审批流**（`approver_role_code` 是硬门槛，会造成谁也走不完的流程）。

### 阶段 3 · MRP 运算引擎（deploy_60 + ai-server）

- 引擎（`mrpEngine.ts`，纯函数）：LLC 低层码分层 → 逐日净需求 → 批量规则（`lot_for_lot / fixed_qty / multiples`）→ 提前期倒排 → 子件毛需求递归，支持**幻影件 blow-through 穿透**；`computeLowLevelCodes` 用不动点迭代，BOM 成环直接抛错。
- 架构决策（与产品确认）：**计算主体是确定性引擎，LLM 只解读不计算** —— 数字必须可复现、可审计；LLM 报告失败自动回退确定性摘要，绝不影响运算结果。
- 并发与状态机：同一租户同一时刻只允许一个 running 计划（`tryAcquirePlan`）；⚠️ **`running` 必须在 `persistResult` 之后置 `completed`**（失败 catch 置 `failed`），否则计划永远停在「计算中」且通知触发器永不触发。
- 提前期按物料的 `is_manufactured` 选择（带 BOM 的采购件会被错取成 0）；下达行可能落在更早日期桶，`projectedOnHand` 需循环后回填。
- 端点：`POST /api/mrp/run`、`GET /api/mrp/report/:planId`。
- 测试：`npx tsx ai-server/scripts/test-mrp-engine.ts`。

### 阶段 4 · 计划转单与成本卷算（deploy_61 / 62）

- 转单：采购件 → **采购订单草稿**、制造件 → **生产订单**；`mode=preview` 只回候选清单不写单，`mode=apply` 才真正建单；支持按 `all / purchased / manufactured` 过滤。
- ⭐ **转单追踪列放在 `erp_mrp_requirements` 上**（`converted_document_id` 等，不新建关联表）—— 代价是 `persistResult` 必须只删 `converted_document_id IS NULL` 的行，否则重跑 MRP 会把追踪列连行抹掉 → **重复下单**；部分唯一索引 `uq_mrp_requirements_converted` 兜并发。
- 成本卷算（v1 口径）：
  - 材料 = 期间内**已过账**领料明细金额；
  - 人工 = **已确认**报工 `labor_hours × labor_rate`；
  - 制费 = `machine_hours × overhead_rate`；
  - 完工数量 = **已过账**完工入库；
  - 完工 > 0 全额结转（期末在制 = 0），完工 = 0 则本期投入全留期末在制。**刻意不做约当产量**。
  - ⚠️ 空期间会吞掉在制余额 → 已改为「上一期有期末在制的产品，本期即使无业务也结转一行」。
- 报工只记工时/产出，**不产生库存流水、不回写订单进度**（进度以完工入库为准）；只有 `status='confirmed'` 的报工计入成本。
- 端点：`POST /api/mrp/convert`、`POST /api/mrp/cost-rollup`（`dry_run=true` 只算不写）、`GET /api/mrp/cost`。

### 阶段 5 · MPS 主生产计划（deploy_63 / 64）

- 表：`erp_mps_plans` / `erp_mps_plan_details`（⚠️ 明细表名必须如此，`doc_flow_detail_table('mps_plan')` 按去尾 s 惯例推导，改名即断台账）。
- **确认 = 整单锁定**：触发器 `mps_plan_detail_lock` 锁定后明细不可改；`pushed_quantity` 回写不受锁影响。
- **下推生产订单**：一行一个产品 → 一张 MO。取舍：`doc_flow_generate` 是单头→单头转换，与该形状不匹配 → **不建 `doc_flow_rules`、不挂触发器**，只复用台账层（`doc_flow_source_meta` + `doc_flow_ledger_convert` 防超下推 + 回写 `pushed_quantity`）。`doc_flow_transfers.target_document_id` NOT NULL → 必须先建 MO 再记账，记账失败要作废刚建的 MO（保持「台账 = 事实」）。
- **MRP 供给接线**：`loadEngineInput` 新增 `sourceType="mps"` 块 —— confirmed 且 `mps_qty - pushed_quantity > 0` 算计划供给（已下推部分由 production_order 覆盖）；`forecast_qty` 刻意不进需求源。
- **RCCP 粗能力**：纯计算不落表，月产能 = `capacity_per_day × 自然日数`。
- 端点：`GET /api/mps/overview`、`GET /api/mps/rccp`、`POST /api/mps/confirm`、`POST /api/mps/push`。

---

## 四、前端页面清单

| 页面 | 文件 | 说明 |
|---|---|---|
| MRP 工作台 | `src/pages/mrp/MrpModule.tsx` | 模块入口 |
| MPS 主生产计划 | `src/pages/mrp/MpsPlans.tsx` | 计划行汇总 / 确认 / 下推 / RCCP |
| MRP 计划 | `src/pages/mrp/MrpPlans.tsx` | 运算、报告、计划转单 |
| 生产订单 | `src/pages/mrp/ProductionOrders.tsx` | MO 全生命周期 + BOM 展开 + 齐套检查 |
| 生产领料单 | `src/pages/mrp/MaterialIssues.tsx` | 含批量过账/反过账工具栏 |
| 完工入库单 | `src/pages/mrp/ProductionReceipts.tsx` | PRT 单据类型 |
| 成本卷算 | `src/pages/mrp/CostCalculations.tsx` | 月度成本查询（只读） |
| 生产报工 | `src/pages/mrp/ProductionReports.tsx` | 工时/产出登记 |
| BOM | `src/pages/mrp/Boms.tsx` | 含树形图组件 `BomTreeGraph` / `BomEditableTreeGraph` |
| 工艺路线 | `src/pages/mrp/RoutingOperations.tsx` / `Operations.tsx` / `WorkCenters.tsx` | 含 `RoutingMap` 可视化 |
| 部门 / 质检 | `src/pages/mrp/Departments.tsx` / `QualityInspections.tsx` | |

已知现状：`mrp/*` 页面文案仍为硬编码中文（未接 i18n），属遗留事项，见第九节。

---

## 五、API 端点清单（ai-server :3001）

| 方法 | 路径 | 说明 | 角色 |
|---|---|---|---|
| POST | `/api/mrp/run` | 执行 MRP 运算 + 生成解读报告 | super_admin / tenant_admin / mrp_manager |
| GET | `/api/mrp/report/:planId` | 读取已保存的分析报告 | 登录用户（校验租户归属） |
| POST | `/api/mrp/convert` | 计划转单（`mode=preview\|apply`） | 同 run |
| POST | `/api/mrp/cost-rollup` | 成本卷算（`dry_run` 支持） | 同 run |
| GET | `/api/mrp/cost` | 读取成本行（只读） | 登录用户 |
| GET | `/api/mps/overview` | MPS 计划行汇总 | 登录用户 |
| GET | `/api/mps/rccp` | 粗能力校验 | 登录用户 |
| POST | `/api/mps/confirm` | 确认 / 取消确认 | super_admin / tenant_admin / mrp_manager |
| POST | `/api/mps/push` | 下推生产订单 | 同上 |

鉴权统一口径：**请求体明文 `user_id`/`tenant_id` 只用来「找到人」**，角色必须在服务端查 `sys_user_roles` 核实（`roleGuard.ts`），绝不信任请求方自称的角色；租户错配 403、无角色 403、状态冲突 409。错误信息统一走 `extractErrorMessage()`（PostgREST 错误是普通对象，`String(err)` 会得 `[object Object]`）。

---

## 六、数据库对象清单

| 类别 | 对象 |
|---|---|
| 单据表 | 生产订单/明细、领料单/明细、退料单、完工入库、报工、MRP 计划/需求、MPS 计划/明细、成本计算（`erp_*_s_539dcf81_b` 后缀为多租户设计约定） |
| 过账 RPC | `post_production_document`、`reverse_production_document` |
| BOM RPC | `explode_production_order_bom`、`production_kit_check`、`generate_material_issue_from_order`、`pull_order_lines_into_issue` |
| 台账/流转 | `doc_flow_source_meta`、`doc_flow_ledger_convert`、`doc_flow_detail_table` |
| 触发器 | `mps_plan_detail_lock`（MPS 确认锁定）、`trg_mrp_notify`（MRP 完成通知） |
| 唯一索引 | `uq_mrp_requirements_converted`（部分唯一，兜转单并发） |
| 字典 | deploy_40 预留的 4 个生产类交易类型 |

部署脚本：`supabase/tables/deploy_56 ~ 64`；全量重跑入口 `supabase/tables/000_run_all.local.sh`（⚠️ 任一步失败必须整体 reset 重跑）。

---

## 七、权限模型

- 表权限走平台**基线（`tenant_id IS NULL`）+ 租户副本**双层授权（`sys_role_table_permissions`）。
- 过账表权限基线只给 `super_admin`，租户 2 只给 `tenant_admin`；`mrp_manager` 需要过账时按双层授权补。
- ai-server 写端点角色白名单：`super_admin / tenant_admin / mrp_manager`（`roleGuard.ts` 服务端核实）。
- ai-server 连库用 service_role（**BYPASSRLS**）→ 每条查询与写入都显式带 `tenant_id`（`resolveTenantContext` 校验后的值，不透传请求体），**没有 RLS 兜底**。已踩坑：靠 `DEFAULT current_tenant_id()` 取租户的表（如 `erp_production_order_details`）服务端写必须显式带 tenant_id。

---

## 八、关键设计决策与取舍（速查）

| # | 决策 | 理由 |
|---|---|---|
| 1 | 先过账闭环、后运算引擎 | 净需求无处落地时，运算只是报表 |
| 2 | 新增过账函数，不改 `deploy_13` | 与采购订单回写耦合太深 |
| 3 | LLM 只解读不计算 | 数字必须可复现、可审计；报告失败回退确定性摘要 |
| 4 | 过账后反过账退回 draft 而非 approved | 留人工确认是否重新审批 |
| 5 | 齐套按物料聚合不按订单行 | 多行同物料会重复算库存 = 假齐套 |
| 6 | 转单追踪列放 `erp_mrp_requirements` | 不建关联表；`persistResult` 只删未转单行防重复下单 |
| 7 | 成本 v1 不做约当产量 | 完工=0 全留期末在制，口径简单可解释 |
| 8 | 报工不产生库存流水、不回写进度 | 进度以完工入库为准，单一事实源 |
| 9 | MPS 下推不走 `doc_flow_rules` | 单头→单头转换模型不匹配「一行一张 MO」 |
| 10 | `forecast_qty` 不进 MRP 需求源 | 预测管理（货源清单等）属后续规划 |

---

## 九、已知边界与后续规划

**未实现（按优先级参考）**：

- 工作日历 / 工作日提前期（当前按自然日倒排）；
- 预测需求源与货源清单；
- 批量策略 `max_qty`（现有 `lot_for_lot / fixed_qty / multiples`）；
- MRP 定时重算（当前手动触发）；
- `erp_mrp_requirements` 缺 `low_level_code` / 行动消息列；
- MPS 与 MRP 页面 i18n（`mrp/*` 仍硬编码中文）。

**维护铁律（改代码前必读）**：

1. BOM 用量必须 ÷ `erp_boms.quantity`；`loss_rate` 是小数。
2. `running` 状态必须在 `persistResult` 之后置 `completed`。
3. `persistResult` 只能删 `converted_document_id IS NULL` 的行。
4. 齐套按物料聚合不按订单行。
5. 新增过账类型**新建**函数，不要改既有 deploy 脚本。
6. ai-server 写库必须显式带 tenant_id（service_role 无 RLS 兜底）。

---

## 十、验证方式

- MRP 引擎单测：`npx tsx ai-server/scripts/test-mrp-engine.ts`。
- 过账闭环：走前端 `MaterialIssues.tsx` / `ProductionReceipts.tsx` 的真实按钮路径（RPC + 幂等键），核对库存流水符号、移动加权成本、反过账回退。
- 转单：先 `preview` 核对候选清单，再 `apply`，检查 `converted_document_id` 回写与重复运行防重。
- 成本：`dry_run=true` 先试算核对，再正式落表；月末在制余额抽查（空期间结转）。
- MPS：确认 → 修改明细应被锁拒 → 下推 → 台账 `pushed_quantity` 回写 → MRP 重跑核对供给抵扣。
