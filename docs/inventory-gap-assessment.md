# 库存业务 vs 标准 ERP 差距评估

> 评估时间：2026-10-06
> 末次更新：2026-10-06（第三轮）—— **P0 三条 + P1 全部（含 9b / 9c）+ P2-10 委外闭环 + P2-11 其他出入库/期初库存已落地并验收**，本文已按下线后的实际状态复核
> 评估对象：`erp_inventory*` / `erp_*_details` / `erp_subcontract*` / `erp_other_stock*` / `erp_opening_balance*` / `post_*_document` 系列 RPC / `src/pages/inventory` / `src/pages/mrp` / `ai-server/src/services/mrp*`
> 参照系：金蝶 K3/Cloud 库存管理、用友 U8/NC 库存管理、SAP MM-IM 的通用功能集
> 验证方式：静态通读 **107** 个 SQL 部署脚本 + 前端页面 + ai-server 服务，并连本地 PG(54320) 核对实际库结构与函数体；修复项另有 11 个可复现的验收脚本（合计 **509 断言**）

---

## 一、结论摘要

**「事务内核」依旧是这个模块最强的部分；本轮补完 P0/P1 后，「业务覆盖广度」与「核算闭环」已经从明显短板追到及格线以上。**

一句话概括：**能准确记流水、能算移动加权、能做 MRP；退货能录、存货能进总账、库存有状态维度、可用量能被预占、委外能闭环、其他收发与期初开账都有正规单据；剩下的缺口集中在批次/序列号追溯、计价方法扩展与行业化报表。**

| 维度 | 改造前 | 现在 | 说明 |
|---|---|---|---|
| 事务内核（原子性/并发/幂等） | ★★★★★ | ★★★★★ | 行锁 + advisory lock + 幂等键 + 冲销键；新增唯一入口 `inventory_apply_move` |
| 出入库过账 | ★★★★☆ | ★★★★★ | 采购入库/销售出库/领料/完工入库/调拨/盘点/调整 + **采购退货/销售退货/生产退料** |
| 主数据（物料/仓库/库位/多单位） | ★★★★☆ | ★★★★☆ | 多计量单位实现质量高；**仍缺物料管理属性开关** |
| 库位维度 | ★★★★☆ | ★★★★★ | 过账早已贯穿；**冲突唯一键已在 deploy_85 修掉**，库位级库存真正可存 |
| 成本核算 | ★★☆☆☆ | ★★★☆☆ | 仍只有移动加权；但**库存过账已生成会计凭证**，存货账与总账自动勾稽 |
| 库存状态/质量联动 | ★☆☆☆☆ | ★★★★☆ | `stock_status` 四态 + 质检完成自动流转 + 入库即待检开关 |
| 批次/序列号/保质期 | ★★☆☆☆ | ★★☆☆☆ | 有批次列无批次管理；序列号为零；无有效期预警（未动） |
| 报表体系 | ★☆☆☆☆ | ★★★☆☆ | 业务报表视图从 **0 个**到 **8 个**（收发存/明细账/库龄/对账等）；仍缺呆滞料/周转率/ABC |
| 计划（MRP/MPS） | ★★★★☆ | ★★★★☆ | 净需求+批量规则+提前期回退+转单；**新增 ATP 可用量承诺** |
| 财务联动 | ★★☆☆☆ | ★★★★★ | 库存过账写凭证 + 存货 vs 总账对账视图 + 被跳过凭证落库 |
| 单据覆盖完整度 | ★★☆☆☆ | ★★★★★ | 三类退货 + **委外全流程（订单/发料/入库/结算）** + **其他出入库** + **期初库存录入/导入** 已补 |
| 委外/外协（A4） | ☆☆☆☆☆ | ★★★★★ | **P2-10 已交付**：6 表 + 4 RPC + 4 页面 + 4 菜单；发料/入库/反过账/结算全链路，凭证三行 1405/1408/2202 |
| 其他出入库 / 期初开账（A5+A6） | ☆☆☆☆☆ | ★★★★★ | **P2-11 已交付**：4 表 + 4 RPC + 2 页面（含粘贴批量导入）+ 2 菜单；业务类型驱动对方科目，期初录入不再混进本期收入 |

---

## 二、已经具备的能力（不必重做）

| 能力 | 实现位置 | 备注 |
|---|---|---|
| 采购入库、销售出库过账 | `deploy_13` → **`deploy_93`（最新定义）** `post_stock_document` | 事务原子、行锁、`posting_idempotency_key`、可冲销 |
| 调拨 / 盘点 / 调整 过账 | `deploy_24` → **`deploy_93`** `post_inventory_document` | 调拨写出一入两条流水，方向自动解析 |
| 生产领料 / 完工入库过账 | `deploy_56` → **`deploy_93`** `post_production_document` | 含齐套检查，可冲销 |
| **采购退货过账（P1-1）** | `deploy_89` 表 + `deploy_93` 分支 | 方向 `out`；同时生成**负数应付**冲减 `erp_payables.balance` |
| **销售退货过账（P1-2）** | `deploy_90` 表补列 + `deploy_93` 分支 | 方向 `in`；生成**负数应收**冲减 `erp_receivables.balance` |
| **生产退料过账（P1-3）** | `deploy_91` 表 + `deploy_93` 分支 | 方向 `in`；借 原材料 / 贷 生产成本，回冲领料成本 |
| **库存状态维度（P1-4）** | `deploy_88` | `stock_status ∈ {available, inspection, hold, rejected}`，进唯一键；`available_quantity` 按状态计算 |
| **质检 ↔ 库存联动（P1-4）** | `deploy_100` `apply_quality_inspection_stock_move` | 检验完成自动把待检桶搬进 available / hold / rejected；前端 `QualityInspections.tsx` 已接 |
| **库存预占 + ATP（P1-5）** | `deploy_88` + **`deploy_101` 修正** | `locked_quantity` 真正生效；`reserve_inventory_stock` 按 FIFO 逐行摊分，缺口不污染 `available_quantity` |
| **业务级预占 RPC（P1-5）** | `deploy_100` | `reserve_sales_order_stock` / `reserve_production_order_stock` / `inventory_reserve_on_release` |
| **三个库存报表视图（P1-6）** | `deploy_96` | `vw_erp_inventory_summary`（收发存汇总）/ `vw_erp_inventory_ledger`（明细账）/ `vw_erp_inventory_aging`（库龄） |
| **存货 vs 总账对账（P1-9b）** | `deploy_97` + `deploy_92` | `vw_erp_inventory_voucher_plan` / `gl_recon` / `gl_recon_detail`；「被跳过凭证」落 `erp_inventory_voucher_exceptions` |
| **库存查询服务端视图（P1-6 收尾）** | `deploy_99` | `vw_erp_inventory_stock_list` / `stock_totals`，替掉 `Inventory.tsx` 的全表 JS 关联 |
| BOM 展开 / 齐套 / 虚拟件穿透 | `deploy_57` `explode_production_order_bom`、`production_kit_check` | 含 `is_phantom` 虚幻件 |
| MRP 运算 | `ai-server/src/services/mrpEngine.ts` | 毛需求→在途→预计可用→净需求；批量规则（逐批/固定量/倍数）；提前期回退下单日；安全库存补货 |
| MRP 计划转单 | `mrpConvertService.ts` | 计划订单 → 采购订单 / 生产订单（并自动展开子件） |
| 流水类型字典化 | `deploy_40` | 21 个业务类型 + DocType 映射 + 配置体检视图 `v_inventory_transaction_type_audit` |
| 多计量单位 | `deploy_33` | 单位组 → 单位 → 物料用途单位；库存统一按基本单位记账 |
| 移动加权平均成本 | `post_*_document` 内联 | `unit_cost = |total_cost / qty|` |
| 负库存控制 | `erp_warehouses.is_negative_stock_allowed` | 按仓库开关，过账时强校验（`deploy_93` 已补齐 `stock_adjustment` 分支的 `allow_negative` 赋值） |
| 库存预警 | `deploy_31` `check_inventory_warnings` | 低于最低/安全库存分级推送，pg_cron 每小时，24h 去重 |
| 库位（Bin） | `deploy_24_erp_bins`、`deploy_25`、`deploy_34` | 采购/销售过账也已带库位；唯一键冲突已由 `deploy_85` 化解 |
| **调拨/盘点/调整 冲销（P0-2）** | `deploy_86` `reverse_inventory_document` | 不再是桩；一套代码覆盖三种单据；三个库存页已接「反过账」 |
| **库存过账写会计凭证（P0-3）** | `deploy_87` | 6 个过账/反过账 RPC 尾部挂钩 `inventory_sync_voucher()` / `inventory_void_voucher()` |
| 多租户 + RLS + 权限 | `deploy_41`~`deploy_51` | 全部 `erp_*` fail-closed |
| 生产成本卷算 | `ai-server/src/services/costRollupService.ts` | 材料+人工+制造费用 → 单位成本 |
| 多币别 | `deploy_65`~`deploy_69` | 流水/应付带原币与本币金额 |

> ⚠️ **改这 6 个过账函数请只改 `deploy_93_inventory_posting_rpcs.sql`** ——
> 它是 `post_stock_document` / `reverse_stock_document` / `post_inventory_document` /
> `reverse_inventory_document` / `post_production_document` / `reverse_production_document`
> 的**唯一最新定义**，覆盖 deploy_13 / 24 / 56 / 58 / 69 / 86 / 87。回改老文件不会有任何效果。

**这套事务内核的完成度，已经超过很多国产中小 ERP 的库存模块。** 下面的差距主要不在「写得对不对」，而在「场景够不够全」。

---

## 三、差距清单（P0/P1 下线后复核）

状态图例：✅ 已关闭　⚠️ 部分关闭　❌ 仍缺

### 3.0 已关闭项（原差距清单中被本轮回填的条目）

| 原编号 | 缺口 | 关闭方式 | 验收 |
|---|---|---|---|
| **A1** | 采购退货完全没有 | `deploy_89`（表 + 单据类型 + 交易类型映射 + 菜单 + RLS）+ `deploy_93`（过账分支，方向 out，负数应付） | `verify-93-returns` 42/0 |
| **A2** | 销售退货不进库存 | `deploy_90`（补金额/币种/库位/幂等键列 + 分租户唯一键）+ `deploy_93`（方向 in，负数应收）+ `deploy_94`（状态约束修正） | `verify-93-returns` |
| **A3** | 生产退料没有 | `deploy_91`（结构对齐 `erp_material_issues`，复用同一套过账代码反向跑）+ `deploy_93` | `verify-93-returns` |
| **B1** | `reverse_inventory_document` 是桩 | `deploy_86` 按流水行带符号量反算，覆盖调拨（两腿）/盘点（差异行）/调整（按 direction） | `verify-86` 16/0 |
| **B2** | 可冲销范围只有 3 类 | 现覆盖 6 类（含三类退货 + 调拨/盘点/调整） | `verify-86` / `verify-93-returns` |
| **C1** | 库存无状态字段 | `deploy_88` 加 `stock_status`，并入唯一键 | `verify-93-stock-status-atp` 41/0 |
| **C2** | 质检与库存零联动 | `deploy_100` `apply_quality_inspection_stock_move`；`sys_config.inventory.receiptStockStatus` 支持「入库即待检」 | 同上 + `verify-100` 74/0 |
| **C3** | `locked_quantity` 是死字段 | `deploy_88` + `deploy_101`；预占表 `erp_inventory_reservations` | `verify-100` |
| **D1** | 库存过账不生成凭证 | `deploy_87` 科目映射表 + 6 个 RPC 挂钩；`deploy_97` 对账视图；`deploy_92` 异常落库 | `verify-87` 45/0 / `verify-96` 47/0 |
| **I1** | 库存表两个唯一键互相冲突 | `deploy_85` 三条合并为 `uq_erp_inventory_active_stock_t (…, COALESCE(location_id,0), normalized_batch, tenant_id) WHERE is_deleted='n'`；`deploy_51` 已跳过该表 | `verify-85` 9/0 |
| **I2** | `reverse_inventory_document` 是桩 | 同 B1 | `verify-86` |
| **I3** | 库存过账不产生凭证 | 同 D1 | `verify-87` |
| **F** | 报表视图 0 个 | `deploy_96`（3 个）+ `deploy_97`（3 个）+ `deploy_99`（2 个）= **8 个业务视图** | `verify-96` / `verify-99` 51/0 |
| **G5** | 无 ATP / 销售承诺量 | `deploy_88` + `deploy_100` / `deploy_101` | `verify-100` |

### A. 单据覆盖 —— 六类全部关闭（6/6）

| # | 状态 | 缺口 | 现状证据 | 标准 ERP 应有 | 业务影响 |
|---|---|---|---|---|---|
| A1 | ✅ | 采购退货 | `deploy_89` + `deploy_93`；页面 `PurchaseReturns.tsx` | 采购退货单 → 出库 → 冲减应付 | 已闭环 |
| A2 | ✅ | 销售退货 | `deploy_90` + `deploy_93` + `deploy_94`；页面 `SalesReturns.tsx` | 销售退货单 → 入库 | 已闭环 |
| A3 | ✅ | 生产退料 | `deploy_91` + `deploy_93`；页面 `MaterialReturns.tsx` | 生产退料单 → 入库回冲领料成本 | 已闭环 |
| A4 | ✅ | 委外/外协全流程 | `deploy_102`（6 表 + 配置）+ `deploy_103`（4 RPC）；页面 `Subcontract{Orders,Issues,Receipts,Settlements}.tsx`；验收 `verify-102`（89 断言） | 委外订单 → 委外发料 → 委外入库 → 委外核销 → 结算 | 已闭环 |
| **A5** | ✅ | 其他入库/出库 | `deploy_104`（4 表 + 配置）+ `deploy_105`（4 RPC）；页面 `OtherStockDocuments.tsx`；验收 `verify-104`（75 断言） | 其他出入库单（赠品/样品/借出/退货/报废/损耗） | 已闭环：**业务类型决定对方科目**，报废进 6711、损耗进 6602，不再与调整单混用 |
| **A6** | ✅ | 期初库存录入/导入 | 同上；页面 `OpeningBalances.tsx`（含粘贴批量导入）；字典里的 `opening_balance_in/out` 终于有写入路径 | 期初库存录入/导入 + 期初成本 | 已闭环：单价强制 > 0、一仓一份、报表里期初与本期发生额分列 |

### B. 冲销能力 —— 已补齐

| # | 状态 | 缺口 | 说明 |
|---|---|---|---|
| B1 | ✅ | `reverse_inventory_document` 是桩 | `deploy_86` 实现，已在 6 类单据上验证 |
| B2 | ✅ | 可冲销范围只有 3 类 | 现 6 类，且三个库存页 + 三类退货页均有「反过账」入口（调拨页支持**批量**反过账） |

### C. 库存状态与质量联动 —— 已补齐

| # | 状态 | 缺口 | 关闭方式 |
|---|---|---|---|
| C1 | ✅ | 库存无状态字段 | `deploy_88`：`stock_status ∈ {available, inspection, hold, rejected}` 进唯一键 |
| C2 | ✅ | 质检与库存零联动 | `deploy_100` `apply_quality_inspection_stock_move`；`inspection` 桶可放出 |
| C3 | ✅ | `locked_quantity` 是死字段 | `deploy_88` 建 `erp_inventory_reservations`；`deploy_101` 修掉等值匹配与负可用量两个真缺陷 |
| **C4** | ⚠️ | 无待检仓/在途仓概念 | `erp_warehouses.type` 仍是自由文本 `VARCHAR(50)`。**状态维度已落地，所以不再必须靠虚拟仓绕行**；但在途仓仍缺（见 H3） |

> **deploy_88 的设计要点**：所有库存行的变更都必须经过 `inventory_apply_move()` 这一个入口，
> 它在函数内强制 `available_quantity = quantity - locked`（available 行）或 `0`（其他状态行），
> 所以「按状态计算可用量」不是靠约定，而是靠唯一入口的结构性保证。

### D. 成本核算与财务联动 —— 关键一条已补，计价方法仍单薄

| # | 状态 | 缺口 | 现状证据 | 影响 |
|---|---|---|---|---|
| D1 | ✅ | 库存过账不生成会计凭证 | `deploy_87` 建科目映射表 + 两个 SECURITY DEFINER 助手 + 6 个 RPC 挂钩；`erp_vouchers` 加 `inventory_source_type/id` 做到单据↔凭证一一对应 | 已自动勾稽 |
| **D2** | ❌ | 仅移动加权一种计价 | RPC 内联 `unit_cost = |total_cost/qty|` | 缺 FIFO / 全月一次加权 / 个别计价 / 标准成本 |
| **D3** | ❌ | 成本口径按库存行聚合，非按物料 | 成本锚在 `(product_id, warehouse_id, location_id, batch_no, stock_status)` 行上 | 同物料不同库位/批次成本不同，跨仓调拨会搬运成本 → 与标准 ERP 口径不同，易被财务质疑 |
| **D4** | ❌ | 无成本调整/重估 | `cost_revaluation` 只在字典里（无 RPC） | 发现历史入库单价录错，只能冲销重开 |
| **D5** | ❌ | 无存货跌价准备 | 全库无 | 月末结账/审计缺口 |
| **D6** | ❌ | 生产成本卷算刻意从简 | `costRollupService.ts` 头部注释明示：完工数量>0 时**全额结转、期末在制=0** | 有在制品的多工序场景成本失真 |
| **D7** | ❌ | 流水缺本币金额列 | `erp_inventory_transactions` 只有 `unit_cost`/`total_cost` | 多币别下库存金额与总账币种口径需再核 |

### E. 批次 / 序列号 / 保质期 —— 未动（除库龄分析外）

| # | 状态 | 缺口 | 现状证据 | 影响 |
|---|---|---|---|---|
| E1 | ❌ | **无批次管理开关** | `erp_products` 无 `is_batch_managed` | 批次是「可填可不填的自由文本」，同一物料可能一半带批次一半不带 |
| E2 | ❌ | 无批次主数据 | 无批次表（无生产日期/供应商/质检状态/效期属性） | 批次只是库存行上的一个字符串 |
| E3 | ❌ | **序列号完全缺失** | 全库搜 `serial_no/serial_number/序列号` → **0 命中** | 3C、设备、医疗器械类客户无法做单件追溯 |
| E4 | ⚠️ | 保质期只有一列 | `erp_inventory.expiry_date` 是 `DATE`；**`deploy_101` 起预占摊分已按 `expiry_date NULLS LAST, id` 做 FIFO**，但无主数据、无预警任务 | 近效期/过期预警仍缺；先进先出只在预占路径上部分生效 |
| E5 | ❌ | 无追溯查询 | 无正/反向追溯视图或接口 | 客诉时无法从成品批次倒查原料批次 |

### F. 报表体系 —— 从 0 到 8，但仍不成体系

**库存业务报表视图数量：0 → 8。**

```
本轮新增（全部 security_invoker = true）：
deploy_96  vw_erp_inventory_summary            收发存汇总表（按 物料 × 仓库 × 月份）
deploy_96  vw_erp_inventory_ledger             库存明细账（逐笔流水 + 逐行滚动余额）
deploy_96  vw_erp_inventory_aging              库龄分析（按现有库存行分桶）
deploy_97  vw_erp_inventory_voucher_plan       业务类型 → 存货/对方科目 计划
deploy_97  vw_erp_inventory_gl_recon           存货 vs 总账 对账（按 期间 × 单据类型）
deploy_97  vw_erp_inventory_gl_recon_detail    差异明细（被跳过凭证 + 孤儿凭证行）
deploy_99  vw_erp_inventory_stock_list         库存行 + 主数据名称 + 安全库存判定
deploy_99  vw_erp_inventory_stock_totals       按仓库聚合的合计

既有（财务域）：
v_inventory_transaction_type_audit / vw_erp_ar_ap_open / vw_erp_gl_balance / vw_erp_gl_balance_fc
vw_erp_ledger_detail / vw_erp_subject_balance / vw_erp_trial_balance / vw_erp_trial_balance_fc / vw_sys_config_effective
```

标准 ERP 的库存报表清单对照：

| 报表 | 状态 |
|---|---|
| 现存量查询 | ✅ 有（`Inventory.tsx`，**已改为服务端聚合**） |
| 库存流水查询 | ✅ 有（`InventoryTransactions.tsx`） |
| **收发存汇总表（进销存）** | ✅ 有（`vw_erp_inventory_summary` + `InventoryReports.tsx`） |
| **库存明细账** | ✅ 有（`vw_erp_inventory_ledger`） |
| **库龄分析** | ✅ 有（`vw_erp_inventory_aging`） |
| **库存对账表（存货 vs 总账）** | ✅ 有（`vw_erp_inventory_gl_recon*` + `InventoryReconciliation.tsx`） |
| **呆滞料分析** | ❌ 无（库龄视图可作数据基础，未单独做页面） |
| **存货周转率** | ❌ 无（Dashboard 只算了总值和总量） |
| **ABC 分析** | ❌ 无 |
| **安全库存预警报表** | ⚠️ 仅推送通知，无报表页 |
| **批次追溯表** | ❌ 无 |

**`Inventory.tsx` 的扩展性风险已解除**：原实现把**全表库存 + 全部物料 + 全部仓库 + 全部库位**一次性拉进浏览器做 JS `find()` 关联，数据上千行必被 PostgREST 行数上限截断、首屏卡顿、且「合计金额」口径与分页不一致。现已改为查询 `vw_erp_inventory_stock_list`（服务端过滤：仓库/状态/低库存/关键字）+ `vw_erp_inventory_stock_totals`（按仓库聚合好再回传）。

> 视图设计约束（与项目铁律一致）：**一律 `security_invoker = true`**，否则视图会成为绕过租户 RLS 的后门；
> 主数据关联一律 `LEFT JOIN`（软删物料不能让库存行凭空消失，只让名称为 NULL）；
> 「低库存」只在 `stock_status='available'` 的行上判定（待检/冻结的数量不参与可用承诺）。

### G. 计划侧 —— ATP 已补，其余空洞照旧

| # | 状态 | 缺口 | 现状证据 |
|---|---|---|---|
| **G1** | ❌ | `max_qty` 批量规则未实现 | `mrpEngine.ts` 显式返回 warning：按逐批补充（lot_for_lot）计算 |
| **G2** | ❌ | 无 DRP / 多仓补货 | MRP 按物料聚合，无仓间调拨建议 |
| **G3** | ❌ | 无限产能约束 | 无 CRP 负荷计算；有计划排程不读产能 |
| **G4** | ❌ | 订货点补货无独立引擎 | `erp_products.order_point` 字段已建（`deploy_60`），无独立运算 |
| G5 | ✅ | 无 ATP / 销售承诺量 | `erp_inventory_reservations` + `reserve_inventory_stock`（FIFO 摊分） |

### H. 库内作业与盘点 —— 未动

| # | 状态 | 缺口 | 现状 |
|---|---|---|---|
| H1 | ❌ | 无组装/拆卸单 | BOM 只能单向展开领料，不能反用做组装 |
| H2 | ❌ | 无形态转换 | 数量/单位转换、拆包、合包无单据 |
| H3 | ❌ | **调拨无在途** | `post_inventory_document` 一步写完出库+入库，无调拨在途仓、无跨组织在途挂账 |
| H4 | ⚠️ | 盘点能力偏基础 | 只有「账面量 vs 实盘量」录入式盘点；**冲销能力已补（deploy_86）**；仍无盘点冻结、无盲盘、无循环盘点、无 ABC 策略 |
| H5 | ❌ | 无库位容量/上架策略/拣货波次 | — |
| H6 | ❌ | 无条码/RF 作业 | `erp_products.barcode` 与 `erp_product_uoms.barcode` 有字段，无扫码作业流 |

### I. 正确性问题 —— 三条全部修复 ✅

| # | 状态 | 问题 | 修复 |
|---|---|---|---|
| I1 | ✅ | 库存表两个唯一键互相冲突（`deploy_34` 的库位维度被 `deploy_51` 的分租户改造抹平） | `deploy_85`：三条并存索引合并为一条含 `COALESCE(location_id,0)` 的唯一索引；顺带修掉旧键 `batch_no` 裸比较导致 NULL 批次行可共存的失效 |
| I2 | ✅ | `reverse_inventory_document` 是桩 | `deploy_86` |
| I3 | ✅ | 库存过账不产生凭证 | `deploy_87` |

---

## 四、差距量化

按标准 ERP 库存管理模块的功能点计数（去重后约 **118** 个功能点）：

| 分类 | 标准功能点 | 改造前 | 现在 | 覆盖度 |
|---|---|---|---|---|
| 主数据 | 18 | 15 | 15 | 83% |
| 入库业务 | 14 | 6 | 10 | 71% |
| 出库业务 | 13 | 5 | 8 | 62% |
| 库内作业 | 15 | 4 | 6 | 40% |
| 盘点 | 9 | 4 | 5 | 56% |
| 成本核算 | 12 | 3 | 4 | 33% |
| 报表 | 13 | 2 | 6 | 46% |
| 计划 | 11 | 7 | 8 | 73% |
| 质量/状态 | 7 | 1 | 2 | 29% |
| 追溯（批次/序列号） | 6 | 1 | 1 | 17% |
| **合计** | **118** | **48** | **65** | **≈ 55%** |

> 若只按「核心出入库 + 账务正确性」口径（用户日常真正会用的子集，约 60 个功能点），
> 覆盖度从 **≈72%** 提升到 **≈93%**（委外、其他收发、期初开账都是「不开这个就不能上线」的必备项）。
> 全量口径从 **41% → 55%**，剩余缺口集中在**批次/序列号追溯、成本计价方法扩展、行业化报表**三块。

---

## 五、补课优先级建议

### P0 — 正确性（不修不能上线）—— **三条已全部完成并验收**

1. ✅ **删掉冲突唯一键** —— `deploy_85_inventory_unique_key_fix.sql`
   三条并存的唯一索引合并为
   `uq_erp_inventory_active_stock_t (product_id, warehouse_id, COALESCE(location_id,0), normalized_batch, tenant_id)
   WHERE is_deleted='n'`；`deploy_51` 已把 `erp_inventory` 列入跳过名单，重跑全量不会再生成冲突键。
   顺带修掉了旧键 `batch_no` 裸比较导致「多条 NULL 批次行可以共存」的失效问题。
   验收：`verify-85-inventory-unique-key.cjs` → **PASS 9 / FAIL 0**

2. ✅ **实现 `reverse_inventory_document`** —— `deploy_86_reverse_inventory_document.sql`
   按流水行自身的带符号 `quantity`/`total_cost` 反算，一套代码覆盖调拨（两条腿）、盘点（差异行）、
   调整（按 direction）三种单据；补了三个 `reversal_idempotency_key` 部分唯一索引；
   单据状态回退，流水软删。三类库存页的「反过账」入口已接上（调拨页支持批量）。
   验收：`verify-86-reverse-inventory-document.cjs` → **PASS 16 / FAIL 0**

3. ✅ **库存过账生成凭证** —— `deploy_87_inventory_gl_linkage.sql`
   新增 `erp_inventory_subject_map_s_539dcf81_b`（交易类型 → 存货科目 / 对方科目，按租户可覆盖 +
   内置标准科目兜底），两个 `SECURITY DEFINER` 助手
   `inventory_sync_voucher()` / `inventory_void_voucher()`，并在 6 个过账 / 反过账 RPC 尾部挂钩。
   `erp_vouchers` 加 `inventory_source_type` / `inventory_source_id` + 部分唯一索引，做到「单据 ↔ 凭证」一一对应。
   自动补齐 8→14 个标准科目（1403 / 1405 / 1901 / 5001 / 6401 / 6001）。
   **关键取舍**：会计侧问题（缺期间 / 期间未启用 / 已关闭 / 已锁定 / 缺科目 / 凭证过账失败）
   一律**不阻断**库存过账，只 `RAISE WARNING` + 把原因回传到返回值，前端六个过账入口弹黄色提示 ——
   避免「月结后仓库无法收发货」这种比无勾稽更严重的事故，同时不留下静默差异。
   内部调拨按设计不进总账（同一法人主体内仓库间移动不改变资产负债）。
   验收：`verify-87-inventory-gl-linkage.cjs` → **PASS 45 / FAIL 0**

### P1 — 业务闭环（决定能不能卖）—— **已全部完成并验收**

| 项 | 交付 | 迁移 |
|---|---|---|
| **P1-1 采购退货单** | 表 + 过账 RPC + 页面 | `deploy_89` + `deploy_93` + `PurchaseReturns.tsx` |
| **P1-2 销售退货过账** | 补列 + RPC + 页面 | `deploy_90` + `deploy_93` + `deploy_94` + `SalesReturns.tsx` |
| **P1-3 生产退料单** | 表 + RPC + 页面 | `deploy_91` + `deploy_93` + `MaterialReturns.tsx` |
| **P1-4 库存状态 + 质检联动** | `stock_status` 四态 + 入库即待检开关 + 检验完成自动流转 | `deploy_88` + `deploy_100` + `QualityInspections.tsx` |
| **P1-5 启用 `locked_quantity` + ATP** | 预占表 + FIFO 摊分 + 业务级预占 RPC | `deploy_88` + `deploy_95` + `deploy_100` + `deploy_101` + `SalesOrders.tsx` / `ProductionOrders.tsx` |
| **P1-6 三个报表视图 + 服务端聚合** | 收发存汇总 / 明细账 / 库龄；`Inventory.tsx` 改服务端聚合 | `deploy_96` + `deploy_99` + `InventoryReports.tsx` |
| **P1-9b 存货 vs 总账对账** | 计划视图 + 对账视图 + 差异明细 + 异常落库 | `deploy_92` + `deploy_97` + `InventoryReconciliation.tsx` |
| **P1-9c 科目映射配置页** | 生效口径 + 租户覆盖配置两个页签；菜单已由 `deploy_98` 注册 | `erp_inventory_subject_map` + `InventorySubjectMap.tsx` |

**P1 期间顺带挖出并修掉的真实缺陷**（不是设计，是 bug）：

- `deploy_94` —— 销售退货表沿用了**质检单语义**的状态约束（`draft/submitted/inspecting/completed/cancelled`），
  而 `deploy_90` 给它补了过账字段却没同步放开取值 → `post_stock_document` 尾部 `SET status='posted'` 必撞 23514。
- `deploy_95` —— `erp_inventory_reservations` 的预占唯一键包含 `COALESCE(location_id,0)` 与 `batch_no`，
  导致同一明细重复预占无法幂等覆盖。
- `deploy_101` —— `reserve_inventory_stock` 把每条明细当「指向唯一一行库存」做**等值**匹配，两个后果：
  ① **预占形同虚设**：业务级调用拿不到库位，`location_id IS NULL` 只匹配 `location_id IS NULL` 那一行，
  而入库过账通常写了库位 → 一条也匹配不到，`locked_quantity` 纹丝不动；
  ② **能把后续入库卡死**：需求 > 现存时 `available_quantity` 写成负数，而 `inventory_apply_move`
  每次移动都重算 `new_available` 并带 `< 0 → RAISE` 守卫 → 一旦超量预占，该物料+仓库之后**任何入库都失败**。
  改法：库位/批次由等值条件改为**过滤器**语义，命中多行时按 **FIFO（`expiry_date NULLS LAST, id`）**逐行摊分，
  行锁上限＝该行可锁余量，装不下的部分登记为「备货缺口」预占而**不动库存行** → 可用量永不为负。

**P1 落地时的三条运维提醒**：

1. `erp_accounting_periods` 目前是空表。生产上线前必须先生成并启用当年期间，否则库存过账会全部「跳过凭证」（有提示，不静默）。
2. 用 raw pg 跑完迁移后要 `NOTIFY pgrst, 'reload schema'`，否则前端调新 RPC 报 `PGRST202`（PostgREST 不会自动发现新函数）。
3. `erp_sales_orders` 新增了 `warehouse_id`（预占必须有发货仓），**存量单据不回填** —— 猜错仓比不预占更危险，需人工补录。

### P2 — 行业适配（按客户行业点单）

> 十二项里 **P2-10、P2-11 已交付**（见下），其余仍待点单推进。P2 的排序原则：先做「客户不能上线」的
> 阻断项，且优先选**全新表**（回归风险最低），再做「能用但不够好」的增强项。

#### P2-10 委外/外协全流程 —— ✅ 已交付并验收

**为什么它排第一**：这是本轮 P2 里唯一的「客户不能上线」阻断项 —— 有外协加工业务的中小制造
企业没有委外闭环，料账直接对不平。且全部是新增表，不动既有过账 RPC，回归风险最低。

**交付物**

| 层 | 内容 |
|---|---|
| 表（deploy_102） | 6 张新表：`erp_subcontract_orders` / `_order_details` / `_issues` / `_issue_details` / `_receipts` / `_settlements`；全部 GRANT + `install_role_table_rls()` + `refresh_sys_tables()`；`tenant_id NOT NULL DEFAULT current_tenant_id()` |
| 配置（deploy_102） | 4 个 DocType（`subcontract_order` SCO{YYYY}{####} / `_issue` SCI / `_receipt` SCR / `_settlement` SCS）；3 个新交易类型（`subcontract_issue_out` 出、`subcontract_receipt_in` 入、**`subcontract_fee_in` 入但 `affects_stock=FALSE`**）；3 条存货科目映射；1408 委托加工物资 + **2202 应付账款** 科目回填；4 个菜单（挂在 mrp 下，含物化租户副本） |
| RPC（deploy_103） | `build_subcontract_order_materials`（BOM 展开应发料，含损耗率）、`post_subcontract_document`、`reverse_subcontract_document`、`confirm_subcontract_settlement` |
| 前端 | 4 个页面：`src/pages/mrp/Subcontract{Orders,Issues,Receipts,Settlements}.tsx` + 路由 + ProLayout 三张映射表 + 中英 i18n（键集合严格一致） |
| 验收 | `scripts/verify/verify-102-subcontract.cjs` —— **89 断言 / 0 失败** |

**会计口径（企业会计准则）**

```
发料：借 委托加工物资 1408        贷 原材料 1403
入库：借 库存商品 1405（材料+加工费）
      贷 委托加工物资 1408（材料）
      贷 应付账款 2202（加工费）
结算：只确认「开票金额 − 系统侧加工费」差异，**不出凭证**
```

**两个关键设计取舍（踩过才知道）**

1. **一张入库单要两个不同的贷方科目**，而 `inventory_sync_voucher` 对每个
   `transaction_type` 只能出一对（存货科目, 对方科目）。解法是**写两条腿**：正常数量腿
   `subcontract_receipt_in`（借 1405 / 贷 1408），以及一条 **`quantity = 0` 的纯金额腿**
   `subcontract_fee_in`（借 1405 / 贷 2202），该交易类型必须标 `affects_stock = FALSE`，
   否则会被当成真实库存移动。副作用：`vw_erp_inventory_summary` 原先按**数量符号**判定
   收支金额，数量为 0 的费腿会被漏掉 → 已改为按**金额符号**判定（deploy_103 一并修正）。
2. **反过账不重算核销，而是按落库的 `consumed_materials` JSONB 原样退回**。核销公式是
   「应发单位用量比例 × 本次入库数量」，若反过账时重算，订单数量被改过或同一订单多次入库
   都会让 `consumed_quantity` 越冲越偏。同理订单「已发量」派生自应发料明细 `SUM(issued_quantity)`，
   而不是维护一份易漂移的累加值。

**本轮顺带修掉的真实缺陷**（都不是委外本身的问题，是写委外时撞出来的）

| # | 缺陷 | 症状 | 修法 |
|---|---|---|---|
| 1 | 租户 3 缺 `2202 应付账款` | 采购入库/委外入库的凭证会 **静默跳过**（`subject_not_found` 只是 WARNING）→「库存动了、账没动」 | deploy_102 按租户回填 1408 + 2202，并自检科目数 |
| 2 | 入库 base_amount 未按汇率折算 | 外币委外加工费被当本位币入账，应付与总账双双少记，**完全静默** | 与 deploy_93 采购入库口径统一为 `ROUND(金额 × 汇率, 2)`，自检要求函数体出现 `v_exchange_rate` |
| 3 | `post_subcontract_document` 42703 | `h` 是 RECORD，发料分支的 SELECT 里没有 `product_id`，但共享段里引用了它 → 发料过账直接报错 | 嵌套一层 `IF NOT v_is_issue`，让该语句只在入库分支被解析 |
| 4 | 同上 42702 | UPDATE 别名 `o` / `d` 与 PL/pgSQL 的 RECORD 变量同名 → `column reference "o.id" is ambiguous` | 别名改用 `sco` / `sd`，并加注释说明为何不能用 `o/d/h/t` |

11. ~~其他出入库单 + 期初库存录入/导入（A5 / A6）~~ —— **已交付，见下**
12. 序列号管理（物料开关 + 序列号表 + 出入库绑定 + 追溯）（E3 / E5）
13. 批次管理开关 + 批次主数据 + 近效期/过期预警任务 + 批次追溯查询（E1 / E2 / E4 / E5）
14. 计价方法扩展（至少补 FIFO 与个别计价）（D2 / D3）
15. 成本调整/重估 + 存货跌价准备（D4 / D5）
16. 调拨在途（虚拟在途仓 + 两阶段过账）（H3）
17. 组装拆卸 / 形态转换（H1 / H2）
18. 循环盘点 / 盲盘 / 盘点冻结（H4）
19. MRP 补 `max_qty` 批量规则、DRP 多仓补货、CRP 产能校验（G1~G3）；订货点独立引擎（G4）
20. 条码/RF 作业（H6）
21. 呆滞料 / 存货周转率 / ABC / 安全库存报表页 / 批次追溯表（F 剩余项）

#### P2-11 其他出入库单 + 期初库存 —— ✅ 已交付并验收

**为什么选它**：A5/A6 是同一类问题 —— **有语义、没单据**。
「赠品/样品/借出/报废/损耗」只能塞进「库存调整」，而调整单的对方科目固定是
1901 待处理财产损溢：**报废进不了 6711 营业外支出、损耗进不了 6602 管理费用**，
账上区分不开；期初更离谱 —— `sys_inventory_transaction_types` 里早有
`opening_balance_in/out` 两行字典，但**全库没有任何代码路径写它们**，
新客户开账只能手工敲一张张调整单，且报表里期初与本期发生额混在一起。

**交付物**

| 层 | 内容 |
|---|---|
| 表（deploy_104） | 4 张新表：`erp_other_stock_documents` / `_details`、`erp_opening_balances` / `_details`；全部 GRANT + `install_role_table_rls()` + `refresh_sys_tables()`；`tenant_id NOT NULL DEFAULT current_tenant_id()`；`direction` 带 CHECK；明细表有「同单同物料同库位同批次同状态」部分唯一键（防导入贴两遍） |
| 配置（deploy_104） | 2 个 DocType（`other_stock_document` QT{YYYY}{####} / `opening_balance` OB{YYYY}{####}）；3 个新交易类型（`other_receipt_in` / `other_issue_out` / `other_loss_out`，报废复用已有的 `scrap_out`）；5 条存货科目映射；**6602 管理费用 + 6711 营业外支出 科目按租户回填**；2 个菜单（挂在 inventory 下，含物化租户副本） |
| RPC（deploy_105） | `resolve_other_stock_transaction_type`（业务类型 + 方向 → 交易类型）、`post_other_stock_document`、`reverse_other_stock_document`、`post_opening_balance_document`、`reverse_opening_balance_document` |
| 前端 | 2 个页面：`src/pages/inventory/OtherStockDocuments.tsx`（业务类型按方向收窄）、`OpeningBalances.tsx`（**粘贴批量导入** + 逐行错误回报）；路由 + ProLayout 三张映射表 + 中英 i18n（各约 110 键，键集合严格一致） |
| 验收 | `scripts/verify/verify-104-other-stock-opening.cjs` —— **75 断言 / 0 失败** |

**会计口径**

```
其他入库（赠品/归还/盘盈）：借 库存商品 1405          贷 待处理财产损溢 1901
其他出库（借出/赠出/样品）：借 待处理财产损溢 1901      贷 库存商品 1405
损耗出库：                借 管理费用 6602          贷 库存商品 1405
报废出库：                借 营业外支出 6711         贷 库存商品 1405
期初库存建账：            默认**不生成凭证**（期初是余额，不是本期发生额）
```

**三个关键设计取舍（踩过才知道）**

1. **业务类型必须驱动交易类型，而不是让单据共用一个类型。**
   `inventory_sync_voucher` 是按 `transaction_type` 分组再查科目映射的，
   所以「报废」与「借出」若共用 `other_issue_out`，两者在总账上必然落到同一科目。
   解法：`resolve_other_stock_transaction_type(business_type, direction)` 把业务类型映射成
   四个不同的交易类型，各配各的对方科目。**未登记的业务类型不抛错**，按方向兜底 ——
   「其他出入库」本来就是给计划外业务用的，把未知取值挡在门外没有意义，但方向必须正确，否则借贷会反。

2. **期初默认不进总账，而且是「显式配置为不进」而不是「没配置」。**
   `erp_inventory_subject_map` 里 `(opening_balance, opening_balance_in)` 那行的
   `generate_voucher` 写成 `FALSE`，并且**内置兜底分支也保持 FALSE**（新租户没有映射行时
   行为必须一致）。这样 `inventory_sync_voucher` 回的是
   `skipped_reason = 'no_voucher_required'`，与「配错科目导致 `subject_not_found`」
   是两种不同的返回值 —— 验收脚本分别断言，不会把「有意跳过」误报成「账没同步」。
   客户若想把存货期初也同步进总账，把该行开关打开、换个对方科目即可，不用改代码。

3. **0 成本入库直接拒绝，而不是留个警告。**
   `inventory_apply_move` 对入库单价的取值是
   `COALESCE(NULLIF(p_unit_cost,0), NULLIF(现有库存单价,0), 0)` —— 也就是说
   **单价填 0 会静默沿用现有加权价，而该物料尚无有成本库存时就直接以 0 成本建账**，
   此后所有出库的移动加权单价一起被拉低，**全程不报错**。
   所以过账 RPC 里加了前置守卫：其他入库在「未填价且该物料在此仓库尚无有成本库存」时抛
   23514；期初则是**无条件要求单价 > 0**。期初是开账基准，宁可不给过也不能带病开账。

**本波撞出的 3 个真实缺陷**

| # | 缺陷 | 症状 | 修法 |
|---|---|---|---|
| 1 | `6602 管理费用` / `6711 营业外支出` 缺科目 | **6711 两个租户都没有**；6602 只有租户 1 有（租户 3 是 `bootstrap_tenant()` 建的）。缺科目 → 凭证 `subject_not_found` **静默跳过**（只 WARNING）→「库存动了、账没动」 | deploy_104 按租户 `WHERE NOT EXISTS` 回填两个科目，自检断言每租户 2/2 |
| 2 | `vw_erp_inventory_summary` 把期初录入算成「本期收入」 | 期初写出来的是正数量流水，沿用原口径会被计入 `in_qty`，于是**期初永远是 0、本期收入虚高**，A6 要的「分得清期初与发生额」落空 | deploy_105 重定义视图：`opening_balance_in/out` 单独累计为 `opening_input_qty/amount`，本期收发一律排除它们，期初 = 之前各月净额 + **本月的期初录入** |
| 3 | 同号旧视图被后来的迁移覆盖 | deploy_96 的 `vw_erp_inventory_summary` 自检要求 `UNBOUNDED PRECEDING` 与 `security_invoker`，重定义时若漏掉任一项，**deploy_96 的自检会在整包重跑时失败** | deploy_105 的重定义保持两个特征，并在自检里同时断言「委外那次的金额符号口径」「本次的期初拆列」都还在 |

> 缺陷 2 的修法对既有断言**零影响**：deploy_104 之前没有任何代码路径写
> `opening_balance_in/out`，历史数据里这两类条数恒为 0，排除它们不改变任何一行数字。


---

## 六、验证方式（可复现）

> 修复后的验收统一跑 `scripts/verify/` 下的脚本（**单事务内执行完 ROLLBACK，不污染数据**）。
> 口令**不落盘**，跑之前先设环境变量（本机 dev 库默认口令见 `.workbuddy/memory/MEMORY.md`）：
>
> ```bash
> # bash
> export PGPASSWORD=<本机 dev 库口令>
> export NODE_PATH="C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules"   # pg 模块所在
>
> # PowerShell
> $env:PGPASSWORD='<本机 dev 库口令>'; $env:NODE_PATH='C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules'
> ```

### 全量回归（11 个脚本，合计 509 断言 / 0 失败）

```bash
node scripts/verify/verify-85-inventory-unique-key.cjs            # P0-1 唯一键                 期望 PASS 9  / FAIL 0
node scripts/verify/verify-86-reverse-inventory-document.cjs      # P0-2 反过账                 期望 PASS 16 / FAIL 0
node scripts/verify/verify-87-inventory-gl-linkage.cjs            # P0-3 凭证联动               期望 PASS 45 / FAIL 0
node scripts/verify/verify-88-transfer-batch-reverse.cjs          # 调拨批量反过账              期望 PASS 20 / FAIL 0
node scripts/verify/verify-93-returns.cjs                         # P1-1/2/3 三类退货过账       期望 PASS 42 / FAIL 0
node scripts/verify/verify-93-stock-status-atp.cjs                # P1-4/5 状态维度 + ATP       期望 PASS 41 / FAIL 0
node scripts/verify/verify-96-report-and-recon-views.cjs          # P1-6/9b 报表与对账视图      期望 PASS 47 / FAIL 0
node scripts/verify/verify-99-inventory-query-views.cjs           # P1-6 查询视图 + 科目映射    期望 PASS 51 / FAIL 0
node scripts/verify/verify-100-inventory-business-rpcs.cjs        # P1-4/5 业务级 RPC           期望 PASS 74 / FAIL 0
node scripts/verify/verify-102-subcontract.cjs                    # P2-10 委外全流程            期望 PASS 89 / FAIL 0
node scripts/verify/verify-104-other-stock-opening.cjs            # P2-11 其他出入库 + 期初      期望 PASS 75 / FAIL 0
```

> verify-102 的覆盖分区：A BOM 展开/幂等/重建保护；B 发料过账（成本、跟踪回写、凭证 1408/1403、
> 幂等、库存不足抛错、超发与未挂料两条 warning）；C 入库过账（核销、两条流水腿、三行凭证 1405/1408/2202
> 且借贷平衡、加工费应付、加工费为 0 的退化路径、材料缺口）；D 发料/入库反过账；E 结算确认与差异；
> F 收发存汇总金额口径；G 目录与授权（RPC/DocType/交易类型/菜单/科目兜底）；H 外币折算口径。

verify-104 的覆盖分区：A 其他入库（含 **0 成本守卫**、入库状态 warning）；B 其他出库
（**业务类型 → 对方科目**：借出 1901 / 报废 6711 / 损耗 6602，未登记类型按方向兜底，库存不足抛错）；
C 反过账；D 期初库存（0 成本与 0 数量拦截、`no_voucher_required`、一仓一份、重复行唯一键、
反过账后可重过）；E 收发存口径（期初进 `opening_qty` **不**进 `in_qty`）；F 目录与授权
（含**无租户映射时的内置科目兜底**）。

### 迁移应用

```bash
node scripts/verify/run-migration.cjs supabase/tables/deploy_103_subcontract_rpcs.sql
node scripts/verify/run-migration.cjs supabase/tables/deploy_104_other_stock_and_opening_tables.sql
node scripts/verify/run-migration.cjs supabase/tables/deploy_105_other_stock_and_opening_rpcs.sql
```

清单文件：`supabase/tables/000_run_all.local.sh`（本地，**107 步**）、
`000_run_all_in_order.psql.sql`（psql，同序）、`100_run_all.cloud.sh`（云端，从本地动态解析 ORDER）。
跑完记得 `NOTIFY pgrst, 'reload schema'`，否则前端调新 RPC 报 `PGRST202`。

### 修复前的取证语句（留作历史记录）

> 第 1–3 条是修复**前**的取证语句，P0 修完之后它们已经不再成立
> （现在分别是 `false` / 只剩 1 条索引 / 三份部署文件里都能搜到 `post_voucher_document`）。

```bash
# 1. 修复前确认 reverse_inventory_document 是桩
SELECT prosrc LIKE '%not implemented yet%' FROM pg_proc
 WHERE proname='reverse_inventory_document';   -- 修复前 → true，现在 → false

# 2. 修复前确认库存表双唯一键冲突
SELECT indexname, indexdef FROM pg_indexes
 WHERE tablename='erp_inventory_s_539dcf81_b';  -- 修复前：一个含 location，一个不含；现在只剩 uq_erp_inventory_active_stock_t

# 3. 修复前确认库存过账不写凭证
grep -c post_voucher_document supabase/tables/deploy_13_stock_posting_rpc.sql  -- 修复前 → 0

# 4. 修复前确认退货/委外缺失
grep -rl "purchase_return" supabase/tables src ai-server/src   # 修复前 → 仅字典 + 前端常量；现在 → 表/RPC/页面齐全
grep -rl "委外\|外协\|subcontract" supabase/tables src ai-server/src  # → 修复前 0 命中；现已齐全（deploy_102/103 + 4 个 mrp 页面）
```

---

## 七、附：评估过程中发现的其他问题

- `src/constants/inventoryTransactionTypes.ts` 定义 21 个流水类型。其中
  `purchase_return_out` / `sales_return_in` / `material_return_in` **已由 P1 接上真实写入路径**；
  `opening_balance_in/out`（deploy_105 期初库存过账）与 `scrap_out`（deploy_105 其他出库-报废）
  **也已由 P2-11 接上**；现在**只剩 `cost_revaluation` 一条**没有任何写入路径
  → 字典里唯一「多余」的一项，属 D4「无成本调整/重估」未做范围。
- `erp_products` 缺管理属性开关（批次/序列号/保质期/计价方法），导致「同一张表里的物料只能用同一种管理粒度」（E1）。
- 全库 `erp_*` 列注释仍为 0，MRP/成本引擎的中文语义只能从代码注释里读。
- **`deploy_93` 是 6 个过账 RPC 的唯一最新定义**，任何改动请只改它，回改老文件不会生效（详见第二节末的警示）。
  P2-10/P2-11 新增的过账 RPC（`post_subcontract_document` → deploy_103；
  `post_other_stock_document` / `post_opening_balance_document` → deploy_105）**是各自独立的新函数**，
  不改这 6 个；但 `inventory_voucher_plan` 与 `vw_erp_inventory_summary` 被反复重定义，
  **当前最新定义都在 `deploy_105`**。
- `inventory_consume_reservations`（出库时消耗预占）仍按 `(location_id, batch_no)` **精确匹配**。
  若出库单实际填写的库位/批次与预占摊分到的行不一致，消耗会落空，需要靠
  `release_inventory_reservations` 人工释放 —— 属已知遗留，不影响可用量正确性（不会为负）。
- 生产订单的**行级**领料仓目前不参与预占（受预占幂等键限制，只能用订单头 `warehouse_id`）。
