# 标准库存流水枚举

本文整理的是 ERP 中比较通用的库存流水分类，适合作为库存台账、分析报表和单据过账的统一枚举基础。

## 当前项目现状

项目里原先的库存流水类型主要包含：

- `inbound`
- `outbound`
- `inventory_transfer_out`
- `inventory_transfer_in`
- `stock_count_increase`
- `stock_count_decrease`
- `stock_adjust_in`
- `stock_adjust_out`

其中 `inbound / outbound` 已统一为更标准的：

- `purchase_receipt_in`
- `sales_delivery_out`

## 标准枚举表

| 枚举值 | 中文含义 | 典型来源 |
| --- | --- | --- |
| `purchase_receipt_in` | 采购入库 | 采购入库单 |
| `sales_delivery_out` | 销售出货 | 销售出货单 |
| `purchase_return_out` | 采购退货 | 采购退货单 |
| `sales_return_in` | 销售退货 | 销售退货单 |
| `inventory_transfer_out` | 库存调拨出库 | 调拨单 |
| `inventory_transfer_in` | 库存调拨入库 | 调拨单 |
| `stock_count_increase` | 盘盈 | 库存盘点 |
| `stock_count_decrease` | 盘亏 | 库存盘点 |
| `stock_adjust_in` | 库存调整增加 | 库存调整单 |
| `stock_adjust_out` | 库存调整减少 | 库存调整单 |
| `material_issue_out` | 生产领料 | 领料单 |
| `material_return_in` | 生产退料 | 退料单 |
| `production_receipt_in` | 生产完工入库 | 完工入库单 |
| `scrap_out` | 报废出库 | 报废单 |
| `opening_balance_in` | 期初入库 | 期初建账 |
| `opening_balance_out` | 期初冲销 | 期初纠错 |
| `quality_hold` | 质量冻结 | 检验 / 质检 |
| `quality_release` | 质量解冻 | 检验 / 质检 |
| `inventory_freeze` | 库存冻结 | 业务冻结 |
| `inventory_unfreeze` | 库存解冻 | 业务解冻 |
| `cost_revaluation` | 成本重估 | 成本调整 |

## 旧值兼容

为了兼容历史数据，项目里保留了旧值到新值的映射：

| 旧值 | 新值 |
| --- | --- |
| `inbound` | `purchase_receipt_in` |
| `outbound` | `sales_delivery_out` |

## DocType 驱动的业务类型（当前方案）

枚举已经从前端常量搬进数据库，由 DocType 驱动（`supabase/tables/deploy_40_inventory_transaction_types.sql`）：

| 表 | 作用 |
| --- | --- |
| `sys_inventory_transaction_types` | 业务类型字典：code / name / direction(in/out/neutral) / affects_stock / name_en |
| `sys_document_transaction_types` | DocType × 业务类型映射：direction / is_default / condition_note |

- 一个 DocType 可以关联多个业务类型，例如 `inventory_transfer` → `inventory_transfer_out`（出库）+ `inventory_transfer_in`（入库），
  `stock_count` → `stock_count_increase`（盘盈）/ `stock_count_decrease`（盘亏）。
- 过账时按方向解析：`public.resolve_inventory_transaction_type(document_type, direction)`，
  优先命中配置，未配置时回落到上表的内置默认值，因此配置缺失不会让过账失败。
- 流水行里存的是解析结果快照，之后改配置不影响历史数据。

### 预置映射

| DocType | 业务类型 | 方向 |
| --- | --- | --- |
| `purchase_receipt` | `purchase_receipt_in` | in（默认） |
| `sales_delivery` | `sales_delivery_out` | out（默认） |
| `inventory_transfer` | `inventory_transfer_out` / `inventory_transfer_in` | out / in |
| `stock_count` | `stock_count_increase` / `stock_count_decrease` | in（盘盈）/ out（盘亏） |
| `stock_adjustment` | `stock_adjust_in` / `stock_adjust_out` | in / out |

字典里其余类型（生产领料/退料、完工入库、报废、期初、质量冻结解冻、成本重估）已预置，
等业务单据接入过账后直接在 DocType Builder 里关联即可，不需要再改代码。

## 生效边界（重要）

配置不是万能的，以下三点决定了「配了就一定生效」这个假设不成立：

1. **只有 5 个 DocType 有写入端。** 目前调用 `resolve_inventory_transaction_type` 的只有
   `post_stock_document`（purchase_receipt / sales_delivery）和 `post_inventory_document`
   （inventory_transfer / stock_count / stock_adjustment）。给其他 DocType（如 `material_issue`）
   配业务类型只会存成元数据，一条流水都不会产生 —— DocType Builder 里会对此给出黄色警告。
   要让新 DocType 真正产生流水，必须先写过账 RPC（或接通用过账引擎）。
2. **direction 由代码决定。** 过账代码按业务算出方向再传给解析器（调拨写死 out/in，盘点按
   `实盘 >= 账面`，调整按明细 direction）。配置里 `direction` 与代码不符的映射只有在精确匹配
   缺失时才会被兜底命中，不要靠它做业务分流。
3. **字典是流水页面的下拉数据源。** 字典里没有的 code 会在列表里显示原始英文串。

## 完整性约束

- `sys_document_transaction_types.transaction_type_code` 外键指向字典 `code`（`ON DELETE RESTRICT`），
  字典里不存在的类型无法被关联，已被引用的类型无法被硬删除（界面上是软删 `is_deleted='y'`）。
- 唯一索引 `uq_sys_document_transaction_types_default`：同一 DocType + 同一方向最多一个默认类型，
  避免解析结果依赖插入顺序。
- 唯一约束 `(document_type_id, transaction_type_code)`：同一 DocType 不能重复关联同一类型。

## 配置体检

```sql
SELECT * FROM public.v_inventory_transaction_type_audit;
```

| issue_type | 含义 | 怎么处理 |
| --- | --- | --- |
| `unregistered_code` | 流水里写了字典里没有的 code（通常是新 DocType 走了兜底） | 在字典里补一条，或给该 DocType 配映射 |
| `unmapped_code` | 字典里有但没挂任何 DocType | 正常（预置的通用类型），或确认是否漏配 |
| `orphan_mapping` | 配了映射但该 DocType 没有过账 RPC | 先写过账逻辑，配置才生效 |

## 代码位置

- 数据库定义与种子: `supabase/tables/deploy_40_inventory_transaction_types.sql`
- 解析 RPC: `public.resolve_inventory_transaction_type(TEXT, TEXT)`
- 前端常量（仅作离线兜底）: `src/constants/inventoryTransactionTypes.ts`
- 前端读取 hook: `src/hooks/useInventoryTransactionTypes.ts`
- 配置界面: `src/pages/system/DocumentTypeBuilder.tsx`（DocType 抽屉的「业务流水类型」页签）
- 采购入库 / 销售出货过账: `supabase/tables/deploy_34_outbound_inbound_location.sql`（旧版 `deploy_13_stock_posting_rpc.sql`）
- 调拨 / 盘点 / 调整过账: `supabase/tables/deploy_24_inventory_document_ops.sql`

## 建议

后续新增库存类业务时，先在 DocType Builder 里给 DocType 关联业务类型，不要在代码里新增临时字符串。
只有需要新增一个全新业务类型（而不是现有类型的新单据）时，才在字典里加 code。这样查询、统计和报表口径会更稳定。
