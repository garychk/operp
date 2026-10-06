# 库存业务 vs 标准 ERP 差距评估

> 评估时间：2026-10-06
> 评估对象：`erp_inventory*` / `erp_*_details` / `post_*_document` 系列 RPC / `src/pages/inventory` / `src/pages/mrp` / `ai-server/src/services/mrp*`
> 参照系：金蝶 K3/Cloud 库存管理、用友 U8/NC 库存管理、SAP MM-IM 的通用功能集
> 验证方式：静态通读 88 个 SQL 部署脚本 + 前端页面 + ai-server 服务，并连本地 PG(54320) 核对实际库结构与函数体

---

## 一、结论摘要

**当前库存模块的「事务内核」质量明显高于同类自研系统，但「业务覆盖广度」和「核算闭环」只到标准 ERP 的 55%～60%。**

一句话概括：**能准确记流水、能算移动加权、能做 MRP，但录不进完整的业务场景，也算不进总账。**

| 维度 | 成熟度 | 说明 |
|---|---|---|
| 事务内核（原子性/并发/幂等） | ★★★★★ | 行锁 + advisory lock + 幂等键 + 冲销键，设计到位 |
| 出入库过账 | ★★★★☆ | 采购入库/销售出库/领料/完工入库/调拨/盘点/调整 齐 |
| 主数据（物料/仓库/库位/多单位） | ★★★★☆ | 多计量单位实现质量高；缺物料管理属性开关 |
| 库位维度 | ★★★★☆ | 已贯穿到过账；但被一个遗留唯一键破坏 |
| 成本核算 | ★★☆☆☆ | 仅移动加权；无凭证联动；无成本调整 |
| 库存状态/质量联动 | ★☆☆☆☆ | 无状态字段，质检与库存完全脱钩 |
| 批次/序列号/保质期 | ★★☆☆☆ | 有批次列无批次管理；序列号为零；无有效期预警 |
| 报表体系 | ★☆☆☆☆ | 业务报表视图 **0 个** |
| 计划（MRP/MPS） | ★★★★☆ | 净需求+批量规则+提前期回退+转单，超预期 |
| 财务联动 | ★★☆☆☆ | 只生成应付，不生成存货凭证 |
| 单据覆盖完整度 | ★★☆☆☆ | 退货/委外/其他出入库/期初 全缺 |

---

## 二、已经具备的能力（不必重做）

| 能力 | 实现位置 | 备注 |
|---|---|---|
| 采购入库、销售出库过账 | `deploy_13` + `deploy_34` `post_stock_document` | 事务原子、行锁、`posting_idempotency_key`、可冲销 |
| 调拨 / 盘点 / 调整 过账 | `deploy_24_inventory_document_ops` `post_inventory_document` | 调拨写出一入两条流水，方向自动解析 |
| 生产领料 / 完工入库过账 | `deploy_56` `post_production_document` | 含齐套检查，可冲销 |
| BOM 展开 / 齐套 / 虚拟件穿透 | `deploy_57` `explode_production_order_bom`、`production_kit_check` | 含 `is_phantom` 虚幻件 |
| MRP 运算 | `ai-server/src/services/mrpEngine.ts` | 毛需求→在途→预计可用→净需求；批量规则（逐批/固定量/倍数）；提前期回退下单日；安全库存补货 |
| MRP 计划转单 | `mrpConvertService.ts` | 计划订单 → 采购订单 / 生产订单（并自动展开子件） |
| 流水类型字典化 | `deploy_40` | 21 个业务类型 + DocType 映射 + 配置体检视图 `v_inventory_transaction_type_audit` |
| 多计量单位 | `deploy_33` | 单位组 → 单位 → 物料用途单位；库存统一按基本单位记账 |
| 移动加权平均成本 | `post_*_document` 内联 | `unit_cost = |total_cost / qty|` |
| 负库存控制 | `erp_warehouses.is_negative_stock_allowed` | 按仓库开关，过账时强校验 |
| 库存预警 | `deploy_31` `check_inventory_warnings` | 低于最低/安全库存分级推送，pg_cron 每小时，24h 去重 |
| 库位（Bin） | `deploy_24_erp_bins`、`deploy_25`、`deploy_34` | 采购/销售过账也已带库位 |
| 多租户 + RLS + 权限 | `deploy_41`~`deploy_51` | 59 张 `erp_*` 全 fail-closed |
| 生产成本卷算 | `ai-server/src/services/costRollupService.ts` | 材料+人工+制造费用 → 单位成本 |
| 多币别 | `deploy_65`~`deploy_69` | 流水/应付带原币与本币金额 |

**这套事务内核的完成度，已经超过很多国产中小 ERP 的库存模块。** 下面的差距主要不在「写得对不对」，而在「场景够不够全」。

---

## 三、差距清单

### A. 单据覆盖：有类型、没单据（最直接的业务缺口）

| # | 缺口 | 现状证据 | 标准 ERP 应有 | 业务影响 |
|---|---|---|---|---|
| A1 | **采购退货完全没有** | 全库搜 `purchase_return` 只命中字典项 `deploy_40:114` 和前端常量 `inventoryTransactionTypes.ts:4`；**无表、无 RPC、无页面** | 采购退货单 → 出库 → 冲减应付 | 退货只能靠「库存调整」硬凑，账实、账账都对不上 |
| A2 | **销售退货不进库存** | `erp_sales_returns` 表存在于 `deploy_10`，但无任何过账 RPC；仅被 `QualityInspections.tsx` 当归档来源引用 | 销售退货单 → 入库（可指定良品/不良品仓） | 退货商品在系统里「不存在」，库存虚高 |
| A3 | **生产退料没有** | 字典有 `material_return_in`（`deploy_40:123`），无表无 RPC | 生产退料单 → 入库回冲领料成本 | 车间余料无法回库，领料成本虚高 |
| A4 | **委外/外协全流程为零** | 全库搜 `委外/外协/subcontract/outsourc` → **0 命中** | 委外订单 → 委外发料 → 委外入库 → 委外核销 | 有外协工序的制造业客户直接无法上线 |
| A5 | **其他入库/出库缺位** | 无单据，只能借「库存调整」表达 | 其他出入库单（赠品/样品/借出/报废/损耗） | 语义混杂，调整单被迫承担多种用途 |
| A6 | **期初库存无录入通道** | 字典有 `opening_balance_in/out`，无单据、无导入 | 期初库存录入/导入 + 期初成本 | 新客户开账只能靠手工调调整单 |

### B. 冲销能力残缺

| # | 缺口 | 现状证据 | 影响 |
|---|---|---|---|
| B1 | **`reverse_inventory_document` 是个桩** | `deploy_24:318-326` 函数体只有 `RAISE EXCEPTION 'Reverse inventory document is not implemented yet'`；**连本地库实测 `prosrc LIKE '%not implemented yet%'` 返回 true** | 调拨单/盘点单/调整单过账后**永远无法冲销**，只能反向再开一张单，流水双份、审计链断裂 |
| B2 | 可冲销范围只有 3 类 | 仅 `reverse_stock_document`（采购入库/销售出库）、`reverse_production_document`（领料/完工） | — |

### C. 库存状态与质量联动（制造型企业刚需）

| # | 缺口 | 现状证据 | 影响 |
|---|---|---|---|
| C1 | **库存无状态字段** | `erp_inventory` 15 列中无 `status`（实测列清单：id/corp_id/emp_id/is_deleted/created_at/updated_at/product_id/warehouse_id/quantity/available_quantity/locked_quantity/unit_cost/total_cost/batch_no/expiry_date/location_id/tenant_id） | 无法区分 合格/待检/冻结/不合格，可用量恒等于现存量 |
| C2 | **质检与库存零联动** | `deploy_10` 质检表无任何库存写入；`quality_hold`/`quality_release` 在字典里 `affects_stock = FALSE` 且无 RPC | 采购入库**不触发检验**，检验不合格**无法隔离库存**，不良品随时可被发出 |
| C3 | **`locked_quantity` 是个死字段** | 全库 `locked_quantity` 只在 INSERT 时写死 `0`，**无任何 UPDATE** | 无库存预留、无销售占用、无 ATP 可用量承诺 |
| C4 | 无待检仓/在途仓概念 | `erp_warehouses.type` 是自由文本 `VARCHAR(50)`，无枚举约束，无系统内置虚拟仓 | 无法用「虚拟仓」方案绕开 C1 |

### D. 成本核算与财务联动

| # | 缺口 | 现状证据 | 影响 |
|---|---|---|---|
| D1 | **库存过账不生成会计凭证** | `post_stock_document` / `post_inventory_document` / `post_production_document` 全都不调用 `post_voucher_document`；自动生成凭证的只有折旧、往来结算、汇兑重估（`deploy_20`/`deploy_73`） | **存货科目与总账必然不一致**，必须人工补录凭证 → 标准 ERP 里「存货 vs 总账对账」这个动作在此系统里无意义 |
| D2 | 仅移动加权一种计价 | RPC 内联 `unit_cost = |total_cost/qty|` | 缺 FIFO / 全月一次加权 / 个别计价 / 标准成本 |
| D3 | 成本口径按库存行聚合，非按物料 | 成本锚在 `(product_id, warehouse_id, location_id, batch_no)` 行上 | 同物料不同库位/批次成本不同，跨仓调拨会搬运成本 → 与标准 ERP「按物料（或按批次）计价」的口径不同，易被财务质疑 |
| D4 | 无成本调整/重估 | `cost_revaluation` 只在字典里（`affects_stock=FALSE`，无 RPC） | 发现历史入库单价录错，只能冲销重开 |
| D5 | 无存货跌价准备 | 全库无 | 月末结账/审计缺口 |
| D6 | 生产成本卷算刻意从简 | `costRollupService.ts` 头部注释明示：完工数量>0 时**全额结转、期末在制=0**，不做约当产量、不做差异分摊 | 有在制品的多工序场景成本会失真 |
| D7 | 流水缺本币金额列 | `erp_inventory_transactions` 只有 `unit_cost`/`total_cost`；币种链路只补到了应付与单据头 | 多币别下库存金额与总账币种口径需再核 |

### E. 批次 / 序列号 / 保质期

| # | 缺口 | 现状证据 | 影响 |
|---|---|---|---|
| E1 | **无批次管理开关** | `erp_products` 无 `is_batch_managed`（全库搜 `is_batch/batch_managed` → 0 命中） | 批次是「可填可不填的自由文本」，同一物料可能一半带批次一半不带 |
| E2 | 无批次主数据 | 无批次表（无生产日期/供应商/质检状态/效期属性） | 批次只是库存行上的一个字符串 |
| E3 | **序列号完全缺失** | 全库搜 `serial_no/serial_number/序列号` → **0 命中** | 3C、设备、医疗器械类客户无法做单件追溯 |
| E4 | 保质期只有一列 | `erp_inventory.expiry_date` 是 `DATE`，由采购入库明细带入（`COALESCE(d.expiry_date, expiry_date)`） | 无保质期主数据、无近效期/过期预警任务、无先进先出强制（虽然有 `expiry_date` 却没人读它做校验） |
| E5 | 无追溯查询 | 无正/反向追溯视图或接口 | 客诉时无法从成品批次倒查原料批次 |

### F. 报表体系（当前最薄弱环节）

**库存业务报表视图数量：0。** 现有 9 个视图全是财务域：

```
v_inventory_transaction_type_audit   ← 唯一带 inventory 的，但它是配置体检，不是业务报表
vw_erp_ar_ap_open / vw_erp_gl_balance / vw_erp_gl_balance_fc / vw_erp_ledger_detail
vw_erp_subject_balance / vw_erp_trial_balance / vw_erp_trial_balance_fc / vw_sys_config_effective
```

标准 ERP 的库存报表清单对照：

| 报表 | 状态 |
|---|---|
| 现存量查询 | ✅ 有（`Inventory.tsx`） |
| 库存流水查询 | ✅ 有（`InventoryTransactions.tsx`） |
| **收发存汇总表（进销存）** | ❌ 无 |
| **库存明细账（按物料/期间的收发存）** | ❌ 无 |
| **库龄分析** | ❌ 无 |
| **呆滞料分析** | ❌ 无 |
| **存货周转率** | ❌ 无（Dashboard 只算了总值和总量） |
| **ABC 分析** | ❌ 无 |
| **安全库存预警报表** | ⚠️ 仅推送通知，无报表页 |
| **批次追溯表** | ❌ 无 |
| **库存对账表（存货 vs 总账）** | ❌ 无 |
| **库存金额与流水累计一致性校验** | ❌ 无 |

另外 `Inventory.tsx` 的实现方式存在扩展性风险：`.select('*')` 把**全表库存 + 全部物料 + 全部仓库 + 全部库位**一次性拉进浏览器，在 JS 里做 `find()` 关联（`getProductName`/`getWarehouseName`/`getBinName`）。数据量上千行后必然被 PostgREST 默认行数上限截断，且首屏性能急剧下降。

### G. 计划侧（相对完整，但有明确空洞）

| # | 缺口 | 现状证据 |
|---|---|---|
| G1 | `max_qty` 批量规则未实现 | `mrpEngine.ts:231` 显式返回 warning：`批量规则 max_qty 尚未实现，物料按逐批补充（lot_for_lot）计算` |
| G2 | 无 DRP / 多仓补货 | MRP 按物料聚合（`is_mrp_participating` 只控制仓库参不参与），无仓间调拨建议 |
| G3 | 无限产能约束 | 无 CRP 负荷计算；`productionReports` 与 `work_centers` 有工时与费率，但计划排程不读产能 |
| G4 | 订货点补货无独立引擎 | `erp_products.order_point` 字段已建（`deploy_60`），但无「订货点法」独立补货运算 |
| G5 | 无 ATP / 销售承诺量 | 与 C3 同源 |

### H. 库内作业与盘点

| # | 缺口 | 现状 |
|---|---|---|
| H1 | 无组装/拆卸单 | BOM 只能单向展开领料，不能反用做组装 |
| H2 | 无形态转换 | 数量/单位转换、拆包、合包无单据 |
| H3 | **调拨无在途** | `post_inventory_document` 一步写完出库+入库，无调拨在途仓、无运输在途、无跨组织在途挂账 |
| H4 | 盘点能力偏基础 | 只有「账面量 vs 实盘量」录入式盘点（`erp_stock_count_details.system_quantity/counted_quantity/difference_quantity`）；无盘点冻结、无盲盘、无循环盘点、无 ABC 盘点策略 |
| H5 | 无库位容量/上架策略/拣货波次 | — |
| H6 | 无条码/RF 作业 | `erp_products.barcode` 与 `erp_product_uoms.barcode` 有字段，但无扫码作业流 |

### I. 正确性问题（不是「差距」，是「缺陷」）

**这三条优先级高于上面所有功能缺口。**

| # | 问题 | 证据 | 后果 |
|---|---|---|---|
| I1 | **库存表上两个唯一键互相冲突** | 本地库实测 `erp_inventory` 同时存在：<br>`uq_erp_inventory_active_stock_key_v2 (product_id, warehouse_id, COALESCE(location_id,0), batch)` <br>`uq_erp_inventory_s_539dcf81_t_4eb2af5d4a (tenant_id, product_id, warehouse_id, batch_no)` —— **后者不含 `location_id`** | `deploy_34` 特意为库位维度补了 v2 索引，但 `deploy_51` 的分租户唯一键改造又把库位维度**抹平了**。结果：同一仓库、同一物料、同一批次放在两个库位 → 被 23505 拦死。而 `post_inventory_document` 的寻址逻辑恰恰是按 `COALESCE(x.location_id,0)` 精确匹配的 → **库位级库存根本存不下第二行**。库位功能事实上处于「代码支持、数据库不允许」的矛盾状态 |
| I2 | `reverse_inventory_document` 是桩 | 见 B1，实测确认 | 三类单据无法冲销 |
| I3 | 库存过账不产生凭证 | 见 D1 | 存货账与总账无自动勾稽 |

---

## 四、差距量化

按标准 ERP 库存管理模块的功能点计数（去重后约 **118** 个功能点）：

| 分类 | 标准功能点 | 已具备 | 覆盖度 |
|---|---|---|---|
| 主数据 | 18 | 15 | 83% |
| 入库业务 | 14 | 6 | 43% |
| 出库业务 | 13 | 5 | 38% |
| 库内作业 | 15 | 4 | 27% |
| 盘点 | 9 | 4 | 44% |
| 成本核算 | 12 | 3 | 25% |
| 报表 | 13 | 2 | 15% |
| 计划 | 11 | 7 | 64% |
| 质量/状态 | 7 | 1 | 14% |
| 追溯（批次/序列号） | 6 | 1 | 17% |
| **合计** | **118** | **48** | **≈ 41%** |

> 若只按「核心出入库+账务正确性」口径（用户日常真正会用的子集，约 60 个功能点），覆盖度约 **72%**。
> 但按「能否承接一个真实制造业客户」的口径，**41% 偏低**，缺口集中在退货、委外、状态、报表四块。

---

## 五、补课优先级建议

### P0 — 正确性（不修不能上线）—— **三条已全部修复**

1. ✅ **删掉冲突唯一键** —— `deploy_85_inventory_unique_key_fix.sql`。
   三条并存的唯一索引（`uq_erp_inventory_active_stock_key_v2` / `uq_erp_inventory_s_539dcf81_t_4eb2af5d4a` /
   `uq_erp_inventory_active_stock_key`）合并为一条
   `uq_erp_inventory_active_stock_t (product_id, warehouse_id, COALESCE(location_id,0), normalized_batch, tenant_id)
   WHERE is_deleted='n'`；`deploy_51` 已把 `erp_inventory` 列入跳过名单，重跑全量不会再生成冲突键。
   顺带修掉了旧键 `batch_no` 裸比较导致「多条 NULL 批次行可以共存」的失效问题。
   验收：`node scripts/verify/verify-85-inventory-unique-key.cjs` → PASS 9 / FAIL 0。

2. ✅ **实现 `reverse_inventory_document`** —— `deploy_86_reverse_inventory_document.sql`。
   按流水行自身的带符号 `quantity`/`total_cost` 反算，一套代码覆盖调拨（两条腿）、盘点（差异行）、
   调整（按 direction）三种单据；补了三个 `reversal_idempotency_key` 部分唯一索引；
   单据状态回退 `approved`，流水软删。三个库存页（调拨 / 盘点 / 调整）的「反过账」入口已接上。
   验收：`node scripts/verify/verify-86-reverse-inventory-document.cjs` → PASS 16 / FAIL 0。

3. ✅ **库存过账生成凭证** —— `deploy_87_inventory_gl_linkage.sql`。
   新增 `erp_inventory_subject_map_s_539dcf81_b`（交易类型 → 存货科目 / 对方科目，按租户可覆盖 +
   内置标准科目兜底），两个 `SECURITY DEFINER` 助手
   `inventory_sync_voucher()` / `inventory_void_voucher()`，并在 6 个过账 / 反过账 RPC 尾部挂钩。
   `erp_vouchers` 加 `inventory_source_type` / `inventory_source_id` + 部分唯一索引，做到「单据 ↔ 凭证」一一对应。
   自动补齐 8→14 个标准科目（1403 / 1405 / 1901 / 5001 / 6401 / 6001）。
   **关键取舍**：会计侧问题（缺期间 / 期间未启用 / 已关闭 / 已锁定 / 缺科目 / 凭证过账失败）
   一律**不阻断**库存过账，只 `RAISE WARNING` + 把原因回传到返回值，前端六个过账入口弹黄色提示 ——
   避免「月结后仓库无法收发货」这种比无勾稽更严重的事故，同时不留下静默差异。
   内部调拨按设计不进总账（同一法人主体内仓库间移动不改变资产负债）。
   验收：`node scripts/verify/verify-87-inventory-gl-linkage.cjs` → PASS 45 / FAIL 0。

> **仍缺的收尾**：`erp_inventory_subject_map` 目前只能靠 SQL 维护 —— 加菜单要写
> `sys_menus` / `sys_role_menus`，属于「禁写权限表」范围，需要人工在后台加一条配置页菜单。
> 未配置也能跑（内置兜底），所以不阻塞上线。
>
> 另：`erp_accounting_periods` 目前是空表。生产环境上线前必须先生成并启用当年期间，
> 否则库存过账会全部「跳过凭证」（会提示，不是静默）。

### P1 — 业务闭环（决定能不能卖）

4. **采购退货单**（表 + 过账 RPC + 页面）：复用 `post_stock_document` 骨架，方向 `out`，同时冲减 `erp_payables.balance`。
5. **销售退货过账**：`erp_sales_returns` 已有表，补 RPC + 页面。
6. **生产退料单**：补表 + RPC。
7. **库存状态字段 + 质检联动**：`erp_inventory` 加 `stock_status`（`available`/`inspection`/`hold`/`rejected`），`available_quantity` 改为按状态计算；采购入库可配置「入库即待检」，检验合格后转 available。
8. **启用 `locked_quantity`**：销售订单/生产订单下发时占用，过账时释放；补 ATP 可用量计算。
9. **收发存汇总表 + 库存明细账 + 库龄分析** 三个报表视图（`security_invoker`），把 `Inventory.tsx` 的全表 JS 关联改成服务端聚合。
9b. **存货 vs 总账对账视图**（原 P0-3 的后半）：按科目 + 期间比对 `erp_gl_entries` 中存货 / 成本科目的发生额
    与 `erp_inventory_transactions` 的金额，把「被跳过凭证」（`period_closed` / `subject_not_found` 等）
    的差异显式列出来。deploy_87 已保证单据 ↔ 凭证可反查，做这个视图的数据基础已具备。
9c. **库存科目映射配置页**：见 P0 后的收尾说明，表已建好、需要人工加一条菜单。

### P2 — 行业适配（按客户行业点单）

10. 委外/外协全流程
11. 序列号管理（物料开关 + 序列号表 + 出入库绑定 + 追溯）
12. 保质期主数据 + 近效期/过期预警任务 + 批次追溯查询
13. 计价方法扩展（至少补 FIFO 与个别计价）
14. 调拨在途（虚拟在途仓 + 两阶段过账）
15. 组装拆卸 / 形态转换
16. 循环盘点 / 盲盘 / 盘点冻结
17. MRP 补 `max_qty` 批量规则、DRP 多仓补货、CRP 产能校验
18. 条码/RF 作业

---

## 六、验证方式（可复现）

> **注意**：下面第 1–3 条是修复**前**的取证语句，三条 P0 修完之后它们已经不再成立
> （现在分别是 `false` / 只剩 1 条索引 / 三份部署文件里都能搜到 `post_voucher_document`）。
> 修复后的验收改跑 `scripts/verify/` 下的脚本（单事务内执行完 ROLLBACK，不污染数据）。
>
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

```bash
node scripts/verify/verify-85-inventory-unique-key.cjs         # P0-1 唯一键：期望 PASS 9  / FAIL 0
node scripts/verify/verify-86-reverse-inventory-document.cjs   # P0-2 反过账：期望 PASS 16 / FAIL 0
node scripts/verify/verify-87-inventory-gl-linkage.cjs         # P0-3 凭证联动：期望 PASS 45 / FAIL 0
node scripts/verify/verify-88-transfer-batch-reverse.cjs       # 调拨批量反过账：期望 PASS 20 / FAIL 0
```

修复前的取证语句（留作历史记录）：

```bash
# 1. 修复前确认 reverse_inventory_document 是桩
SELECT prosrc LIKE '%not implemented yet%' FROM pg_proc
 WHERE proname='reverse_inventory_document';   -- 修复前 → true，现在 → false

# 2. 修复前确认库存表双唯一键冲突
SELECT indexname, indexdef FROM pg_indexes
 WHERE tablename='erp_inventory_s_539dcf81_b';  -- 修复前：一个含 location，一个不含；现在只剩 uq_erp_inventory_active_stock_t

# 3. 修复前确认库存过账不写凭证
grep -c post_voucher_document supabase/tables/deploy_13_stock_posting_rpc.sql  -- 修复前 → 0

# 4. 确认退货/委外缺失（这条仍然成立，属 P1/P2 未修范围）
grep -rl "purchase_return" supabase/tables src ai-server/src   # → 仅字典 + 前端常量
grep -rl "委外\|外协\|subcontract" supabase/tables src ai-server/src  # → 0 命中
```

---

## 七、附：本次评估顺带发现的其他问题

- `src/constants/inventoryTransactionTypes.ts` 定义了 21 个流水类型，其中 `purchase_return_out` / `sales_return_in` / `material_return_in` / `opening_balance_*` / `scrap_out` / `cost_revaluation` **全部没有任何代码路径会写入** → 字典比事实多，容易误导配置人员。
- `erp_products` 缺管理属性开关（批次/序列号/保质期/计价方法），导致「同一张表里的物料只能用同一种管理粒度」。
- 全库 `erp_*` 列注释仍为 0（与既有遗留一致），MRP/成本引擎的中文语义只能从注释文本里读。
