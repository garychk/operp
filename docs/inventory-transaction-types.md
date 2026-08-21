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

## 代码位置

- 枚举定义: `src/constants/inventoryTransactionTypes.ts`
- 采购入库 / 销售出货过账: `supabase/tables/deploy_13_stock_posting_rpc.sql`
- 调拨 / 盘点 / 调整过账: `supabase/tables/deploy_24_inventory_document_ops.sql`

## 建议

后续新增库存类业务时，优先复用这份枚举，不要再直接新增临时字符串。这样查询、统计和报表口径会更稳定。
