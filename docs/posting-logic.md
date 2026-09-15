# 过账（Posting）逻辑说明

本文描述 ERP 各单据的过账与反过账行为，覆盖采购入库、销售出货、库存调拨、库存盘点、库存调整、会计凭证。

对应源文件：

| 文件 | 内容 |
|---|---|
| `supabase/tables/deploy_34_outbound_inbound_location.sql` | `post_stock_document` / `reverse_stock_document`（采购入库、销售出货，含库位维度） |
| `supabase/tables/deploy_24_inventory_document_ops.sql` | `post_inventory_document` / `reverse_inventory_document`（调拨、盘点、调整） |
| `supabase/tables/deploy_17_voucher_posting_rpc.sql` | `post_voucher_document` / `reverse_voucher_document`（会计凭证） |

> 注意：`deploy_13` 里也有一份早期的 `post_stock_document`，已被 `deploy_34` 完整覆盖，以 `deploy_34` 为准。

---

## 1. 单据状态流转

```
draft ──提交──> pending ──审批通过──> approved ──过账──> posted
                  │                      │                  │
                  └──驳回──┐            │                  └──反过账──> approved
                           ↓            │
                         draft <────────┘（撤回）
```

- 工作流引擎只负责 `draft → pending → approved` 这一段（`workflow_execute_action` + `workflow_sync_document_status`）
- `approved → posted` 由过账 RPC 完成，**与工作流解耦**
- 所有过账 RPC 都强制要求 `status = 'approved'`，草稿或审批中的单据不能过账

调用方：

- 前端统一入口 `src/utils/businessEngine.ts` 的 `runBusinessAction()`，按 `action` 分发
- 部分页面直接调用：调拨/盘点/调整在各单据页用 `supabase.rpc('post_inventory_document', ...)`

---

## 2. 三个过账入口对照

| 函数 | 覆盖单据 | 反过账 | 状态 |
|---|---|---|---|
| `post_stock_document(type, id, key)` | `purchase_receipt`、`sales_delivery` | `reverse_stock_document` | 完整实现 |
| `post_inventory_document(type, id, key)` | `inventory_transfer`、`stock_count`、`stock_adjustment` | `reverse_inventory_document` | **反过账未实现** |
| `post_voucher_document(id, key)` | `voucher` | `reverse_voucher_document` | 完整实现 |

`reverse_inventory_document` 目前函数体只有一句：

```sql
RAISE EXCEPTION 'Reverse inventory document is not implemented yet';
```

即调拨、盘点、调整**一旦过账就无法通过反过账撤销**，只能手工做反向单据。

---

## 3. 通用前置校验

三个过账 RPC 共有的检查（顺序大致如下）：

| 检查 | 失败行为 |
|---|---|
| 单据 ID 为正、幂等键非空 | 拒绝（`22023`） |
| 单据存在且未逻辑删除 | 拒绝（`P0002`） |
| 幂等命中（已过账且幂等键相同） | 直接返回 `{ok:true, idempotent:true}`，不重复执行 |
| 状态必须为 `approved` | 拒绝（`55000`） |
| 至少有一条有效明细 | 拒绝（`23514`） |

### 幂等是双重保护

1. **软检查**：`status='posted' AND posting_idempotency_key = 入参` → 返回 `idempotent:true`
2. **硬屏障**（仅库存类）：只要该单据已产生过未删除的库存流水，无论传什么幂等键都拒绝

```sql
IF EXISTS (
  SELECT 1 FROM erp_inventory_transactions_s_539dcf81_b t
  WHERE t.reference_type = p_document_type
    AND t.reference_id = p_document_id AND t.is_deleted = 'n'
) THEN
  RAISE EXCEPTION 'Document already has active inventory transactions';
```

所以即使调用方每次生成新的随机 UUID，也不会重复扣减库存。凭证过账没有第二道屏障，它靠 `status='posted'` 短路。

---

## 4. 库存过账的核心：四元组精确匹配

库存表 `erp_inventory_s_539dcf81_b` **不是**「物料 + 仓库」一条记录，而是按四个维度各存一条独立记录：

```
(物料 product_id, 仓库 warehouse_id, 库位 location_id, 批次 batch_no)
```

过账时用这四个条件精确匹配**唯一一条**库存记录：

```sql
WHERE x.product_id   = d.product_id
  AND x.warehouse_id = h.warehouse_id
  AND COALESCE(x.location_id, 0) = COALESCE(v_location_id, 0)
  AND COALESCE(NULLIF(BTRIM(x.batch_no), ''), '') = COALESCE(normalized_batch, '')
```

匹配不到就视为 0，然后走插入或更新。

### 由此产生的重要行为

**不会跨库位、跨批次调剂。** 库位 A 有 10 个、库位 B 有 50 个，出货单指定从 A 出 20 个 → 直接报库存不足，**不会**自动去 B 补。库存不足时只能人工改单、拆分明细，或先用调拨单把货挪过去。

**库位取值顺序**：明细行的 `location_id` 优先，为空则回退单据头的 `location_id`。

**库位必须属于本单仓库**，否则报 `Location % is not valid for warehouse %`。

**不填库位可能一个都扣不到**：匹配条件用 `COALESCE(location_id, 0) = COALESCE(v_location_id, 0)`，即不填库位时只会命中 `location_id IS NULL` 的那条记录。若库存全都挂在具体库位上，不填库位会直接报"库存不足"——明明仓库里有货。批次同理。

---

## 5. 数量与成本计算

每条明细处理后同时更新两个数量字段和成本：

```sql
-- 入库
new_qty       := old_qty + quantity;
new_available := old_available + quantity;
new_cost      := old_cost + quantity * unit_cost;

-- 出库
new_qty       := old_qty - quantity;
new_available := old_available - quantity;
new_cost      := old_cost - quantity * unit_cost;
```

`unit_cost` 的取值优先级：

- 入库（采购入库）：明细单价 → 产品 `cost_price` → 产品 `purchase_price` → 现有库存均价
- 出库：现有库存 `unit_cost` → 产品 `cost_price` → 产品 `purchase_price`

写回时重算单价，库存归零则保留原单价：

```sql
unit_cost = CASE WHEN new_qty = 0 THEN v_unit_cost ELSE ABS(new_cost / new_qty) END
```

整体接近移动加权平均。同时向 `erp_inventory_transactions_s_539dcf81_b` 插入一条流水（出库为负数）。

---

## 6. 各单据类型的差异

### 采购入库 `purchase_receipt`

- 必须填供应商且 `total_amount > 0`，否则拒绝
- **自动生成应付账款**：向 `erp_payables` 插入一条，带部分唯一索引 `(source_type, source_id)`，重复则跳过
- 过账后状态 → `posted`

### 销售出货 `sales_delivery`

- 扣减库存，受仓库 `is_negative_stock_allowed` 控制（见下节）
- 过账后状态 → `posted`

### 库存调拨 `inventory_transfer`

- 必须同时有调入/调出仓库，且两者不同
- 一条明细产生**两条流水**：`inventory_transfer_out`（负）和 `inventory_transfer_in`（正）
- ⚠ **不认 `allow_negative`**：直接判断 `available_quantity < quantity` 就拒绝，即使仓库开了允许负库存也一样
- ⚠ **没有咨询锁**，只有 `SELECT ... FOR UPDATE`
- ⚠ 流水的 `reference_type` 是 `inventory_transfer_out`，与单据类型 `inventory_transfer` 不一致

### 库存盘点 `stock_count`

- **覆盖式写入**：直接把库存设为盘点数（`new_qty := counted_quantity`），不累加
- 流水数量为差异值 `new_qty - old_qty`，类型按增减分 `stock_count_increase` / `stock_count_decrease`
- 盘点结果为负时，受 `allow_negative` 约束

### 库存调整 `stock_adjustment`

- 按明细的 `direction`（`in` / `out`）增减
- 出库方向受 `allow_negative` 约束
- 流水类型 `stock_adjust_in` / `stock_adjust_out`

### 负库存开关

```sql
SELECT COALESCE(w.is_negative_stock_allowed, FALSE)
FROM erp_warehouses_s_539dcf81_b w WHERE w.id = h.warehouse_id;
```

字段默认 `FALSE`（不允许负库存）。若某仓库被改成 `TRUE`，该仓库的销售出货/盘点/调整将**永不因库存不足被拦**（调拨除外）。

排查建议：

```sql
select id, warehouse_name, is_negative_stock_allowed
from erp_warehouses_s_539dcf81_b where is_deleted = 'n';
```

---

## 7. 反过账

### 库存类（采购入库 / 销售出货）

`reverse_stock_document` 是**按流水冲销**，不是按单据明细：

1. 查出该单据所有未删除的库存流水，`FOR UPDATE`
2. 逐条反向：`new_qty = 库存量 - 流水数量`（流水里出库是负数，所以减负数等于加回）
3. 同样做负库存检查（报 `Cannot reverse: stock was consumed...`）
4. 把流水标记 `is_deleted='y'` 并写 `reversed_at`
5. 单据状态 `posted → approved`

采购入库反过账还有额外限制：**应付已付款或已核销则不允许反过账**，并会同步把生成的应付记录标记为 `cancelled`。

### 凭证

`reverse_voucher_document` 直接 `DELETE` 该凭证的 `erp_gl_entries`，状态 `posted → draft`（注意是回 `draft` 而不是 `approved`）。

---

## 8. 凭证过账

与库存类完全不同的校验链：

| 检查 | 说明 |
|---|---|
| 会计期间存在 | 不存在拒绝 |
| 期间未锁定 `is_locked` | 锁定拒绝 |
| 期间未关闭 `is_closed` | 关闭拒绝 |
| 期间已启用 `is_enabled` | 未启用拒绝 |
| 借贷双方合计均 > 0 | 否则拒绝 |
| 借贷平衡（容差 0.005） | 不平衡拒绝，报出双方金额 |
| 已有分录则先删除 | 支持重过账 |

然后把每条明细写成一条 `erp_gl_entries`，更新凭证 `status='posted'` 并回写 `total_amount = 借方合计`。

⚠ **不对称之处**：过账要求期间 `is_enabled`，反过账只检查 `is_locked` 与 `is_closed`，不检查 `is_enabled`。

---

## 9. 并发控制

库存类过账在处理每行前加事务级咨询锁，锁的粒度就是四元组：

```sql
PERFORM pg_advisory_xact_lock(hashtextextended(
  format('erp_inventory:%s:%s:%s:%s',
    product_id, warehouse_id, COALESCE(location_id,0), COALESCE(batch_no,'')), 0));
```

配合 `SELECT ... FOR UPDATE` 锁住库存行，可防并发超卖。整个过账在单个事务内，任一行失败全部回滚。

⚠ 调拨走 `post_inventory_document`，**没有这层咨询锁**，只有 `FOR UPDATE`。

---

## 10. 错误码对照

| 错误码 | 含义 | 典型场景 |
|---|---|---|
| `22023` | 参数非法 | 单据 ID 非法、幂等键为空、不支持的单据类型 |
| `P0002` | 未找到 | 单据不存在、仓库不存在、反过账时库存记录缺失 |
| `55000` | 状态不允许 | 未审批就过账、未过账就反过账、期间锁定/关闭、应付已核销 |
| `23514` | 业务规则违反 | 库存不足、借贷不平衡、调拨仓库相同、无有效明细 |
| `23502` | 必填缺失 | 入库单缺供应商、库存单据缺仓库 |
| `23503` | 外键约束 | 库位不属于该仓库 |
| `23505` | 唯一约束冲突 | 已存在有效应付、已产生库存流水 |

---

## 11. 实务注意事项与已知问题

1. **调拨/盘点/调整不能反过账** —— `reverse_inventory_document` 未实现，只能手工做反向单据冲销。
2. **不填库位会扣不到库存** —— 库位参与精确匹配，空值只匹配空值记录。启用库位管理后，出货单必须指定库位。
3. **批次同理** —— 按批次管理时，单据必须填对应批次。
4. **调拨不认允许负库存**，且缺咨询锁，高并发下调拨需谨慎。
5. **调拨流水的 `reference_type` 与单据类型不一致**（`inventory_transfer_out` vs `inventory_transfer`），写报表或联查时要注意。
6. **过账与工作流解耦** —— 审批通过只把状态改成 `approved`，不会自动过账。如需「审批通过自动过账」，要另外把过账挂到工作流的任务节点上（参见 `deploy_35` 单据转换引擎的设计讨论）。
7. **权限** —— 所有过账 RPC 都是 `SECURITY INVOKER`，以当前登录用户身份执行，需要有 `erp_inventory_transactions` 等表的写权限（受 RLS 约束）。
