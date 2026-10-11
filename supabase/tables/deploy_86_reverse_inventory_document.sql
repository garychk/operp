-- ============================================================================
-- deploy_86: 实现 reverse_inventory_document（P0-2）
-- ============================================================================
--
-- 问题
-- ----
-- deploy_24_inventory_document_ops.sql 里 reverse_inventory_document 只是个桩：
--
--     CREATE OR REPLACE FUNCTION public.reverse_inventory_document(...)
--     ... AS $$ BEGIN
--       RAISE EXCEPTION 'Reverse inventory document is not implemented yet';
--     END; $$;
--
-- 而**库存调拨单 / 库存盘点单 / 库存调整单**都只有 post_inventory_document 可用，
-- 过账之后没有任何回退路径：
--   · 录错一行数量 → 只能再开一张反向调整单，流水双份、审计链断裂；
--   · 盘点单过账后想重盘 → 只能新增一张盘点单覆盖，历史盘点结果失真；
--   · 调拨单过账后发现仓库选错 → 库存被搬到错误仓库且无法撤销。
--
-- 另外 deploy_83_ai_document_tools.sql 的 AI 反过账路由已经把这三类单据
-- 路由到本函数 —— 桩函数让 AI 侧「反过账」能力对这三类单据直接报错。
--
-- 实现思路
-- --------
--   不按单据类型各写一套回退逻辑，而是**逐条冲销该单据产生的库存流水**：
--
--     new_qty        = 当前 quantity         - 流水 quantity
--     new_available  = 当前 available_quantity - 流水 quantity
--     new_cost       = 当前 total_cost       - 流水 total_cost
--
--   这对三类单据都成立，因为过账时写下的流水 quantity / total_cost 就是
--   「本次增量」，减回去即恢复原值：
--     · 调拨：出库腿 quantity 为负（减负数 = 加回），入库腿为正（减正数 = 移除），
--             两条腿一次循环同时回退；
--     · 盘点：流水写的是「实盘 - 账面」差额，减差额即回到盘点前的账面数量；
--     · 调整：流水写的是 ±明细数量，减回去即回到调整前。
--
--   与 reverse_stock_document（deploy_13 / deploy_69）保持同一套语义：
--   行锁 + advisory lock + 幂等键 + 负库存守卫 + 软删流水 + 单据状态回退。
--
-- ⚠️ 两个容易踩的点（已处理）
-- --------------------------
--   1) 调拨单两条腿写的 reference_type 是**字面量**
--        'inventory_transfer_out' / 'inventory_transfer_in'，
--      不是 p_document_type（'inventory_transfer'）。
--      只按 reference_type = p_document_type 捞流水会一条都捞不到，静默冲销 0 行。
--      本函数用 IN (...) 同时匹配新旧两种写法。
--   2) 盘点单的 available_quantity 在过账时被**强制拉平**为实盘数量
--        （new_available := new_qty，见 deploy_24），
--      所以冲销时不能简单减差额，要按同一规则把 available 还原成冲销后的 quantity。
--
-- 幂等性
-- ------
--   可重复执行（DDL 全部 IF NOT EXISTS）。函数本身也是幂等的：
--   同一 (单据, 冲销幂等键) 重复调用直接返回 idempotent = true。
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. 给三张单据表补「冲销幂等键」唯一索引
--    deploy_13 给采购入库 / 销售出货建了 uq_*_reversal_key，
--    deploy_24 的三张库存单据漏了 —— 同一个冲销键理论上可以打到多张单据上。
--    部分索引（WHERE ... IS NOT NULL）不会进入 deploy_51 的改造范围。
-- ----------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_transfer_reversal_key
  ON public.erp_inventory_transfers_s_539dcf81_b (reversal_idempotency_key)
  WHERE reversal_idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_count_reversal_key
  ON public.erp_stock_counts_s_539dcf81_b (reversal_idempotency_key)
  WHERE reversal_idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_adjustment_reversal_key
  ON public.erp_stock_adjustments_s_539dcf81_b (reversal_idempotency_key)
  WHERE reversal_idempotency_key IS NOT NULL;

-- 冲销按 (reference_type, reference_id) 取流水，补一个稳定的访问路径
CREATE INDEX IF NOT EXISTS idx_inventory_transactions_reference
  ON public.erp_inventory_transactions_s_539dcf81_b (reference_type, reference_id)
  WHERE is_deleted = 'n';


-- ----------------------------------------------------------------------------
-- 2. 实现冲销
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reverse_inventory_document(
  p_document_type TEXT, p_document_id INTEGER, p_idempotency_key UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public
AS $$
DECLARE
  h RECORD; t RECORD; i RECORD;
  actor_id INTEGER;
  line_count INTEGER := 0;
  new_qty NUMERIC; new_available NUMERIC; new_cost NUMERIC;
  restored_unit_cost NUMERIC;
  normalized_batch TEXT;
  allow_negative BOOLEAN;
  v_ref_types TEXT[];
BEGIN
  IF p_document_type NOT IN ('inventory_transfer', 'stock_count', 'stock_adjustment') THEN
    RAISE EXCEPTION 'Unsupported inventory document type: %', p_document_type
      USING ERRCODE = '22023';
  END IF;
  IF p_document_id IS NULL OR p_document_id <= 0 OR p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'A positive document ID and idempotency key are required'
      USING ERRCODE = '22023';
  END IF;
  actor_id := public.current_sys_user_id();

  -- ---- 锁单据头 ----------------------------------------------------------
  IF p_document_type = 'inventory_transfer' THEN
    SELECT * INTO h FROM public.erp_inventory_transfers_s_539dcf81_b
     WHERE id = p_document_id AND is_deleted = 'n' FOR UPDATE;
  ELSIF p_document_type = 'stock_count' THEN
    SELECT * INTO h FROM public.erp_stock_counts_s_539dcf81_b
     WHERE id = p_document_id AND is_deleted = 'n' FOR UPDATE;
  ELSE
    SELECT * INTO h FROM public.erp_stock_adjustments_s_539dcf81_b
     WHERE id = p_document_id AND is_deleted = 'n' FOR UPDATE;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Inventory document does not exist or is deleted'
      USING ERRCODE = 'P0002';
  END IF;

  -- ---- 幂等：同一冲销键重复调用 ------------------------------------------
  IF h.status = 'approved' AND h.reversal_idempotency_key = p_idempotency_key THEN
    RETURN jsonb_build_object('ok', TRUE, 'idempotent', TRUE,
      'document_type', p_document_type, 'document_id', p_document_id,
      'status', 'approved');
  END IF;
  IF h.status <> 'posted' THEN
    RAISE EXCEPTION 'Only posted documents can be reversed; current status: %',
      COALESCE(h.status, '<null>') USING ERRCODE = '55000';
  END IF;

  -- ---- 流水 reference_type 匹配集合 --------------------------------------
  -- 调拨单两条腿写的是 'inventory_transfer_out' / 'inventory_transfer_in'
  -- 字面量（deploy_24 第 216 / 240 行），兼容两种写法。
  v_ref_types := CASE p_document_type
    WHEN 'inventory_transfer'
      THEN ARRAY['inventory_transfer', 'inventory_transfer_in', 'inventory_transfer_out']
    ELSE ARRAY[p_document_type]
  END;

  IF NOT EXISTS (
    SELECT 1 FROM public.erp_inventory_transactions_s_539dcf81_b x
     WHERE x.reference_type = ANY (v_ref_types)
       AND x.reference_id = p_document_id
       AND x.is_deleted = 'n'
  ) THEN
    RAISE EXCEPTION 'No active inventory transactions found for % #% — 单据状态是 posted 但没有对应流水，请人工核对',
      p_document_type, p_document_id USING ERRCODE = 'P0002';
  END IF;

  -- ---- 逐条冲销 ----------------------------------------------------------
  FOR t IN
    SELECT x.*
      FROM public.erp_inventory_transactions_s_539dcf81_b x
     WHERE x.reference_type = ANY (v_ref_types)
       AND x.reference_id = p_document_id
       AND x.is_deleted = 'n'
     ORDER BY x.product_id, x.warehouse_id,
              x.location_id NULLS FIRST, x.batch_no NULLS FIRST, x.id
     FOR UPDATE
  LOOP
    line_count := line_count + 1;
    normalized_batch := NULLIF(BTRIM(t.batch_no), '');
    PERFORM pg_advisory_xact_lock(hashtextextended(
      format('erp_inventory:%s:%s:%s', t.product_id, t.warehouse_id,
        COALESCE(normalized_batch, '')), 0));

    SELECT x.* INTO i
      FROM public.erp_inventory_s_539dcf81_b x
     WHERE x.product_id = t.product_id
       AND x.warehouse_id = t.warehouse_id
       AND COALESCE(x.location_id, 0) = COALESCE(t.location_id, 0)
       AND COALESCE(NULLIF(BTRIM(x.batch_no), ''), '') =
           COALESCE(normalized_batch, '')
       AND x.is_deleted = 'n'
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'Inventory row missing for transaction % (product %, warehouse %, location %, batch %)',
        t.id, t.product_id, t.warehouse_id, COALESCE(t.location_id, 0),
        COALESCE(normalized_batch, '<none>') USING ERRCODE = 'P0002';
    END IF;

    SELECT COALESCE(w.is_negative_stock_allowed, FALSE)
      INTO allow_negative
      FROM public.erp_warehouses_s_539dcf81_b w
     WHERE w.id = t.warehouse_id AND w.is_deleted = 'n' FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Warehouse does not exist or is deleted'
        USING ERRCODE = 'P0002';
    END IF;

    new_qty := COALESCE(i.quantity, 0) - COALESCE(t.quantity, 0);
    new_cost := COALESCE(i.total_cost, 0) - COALESCE(t.total_cost, 0);

    -- 盘点过账时把 available 拉平成了实盘数量（deploy_24 的 new_available := new_qty），
    -- 冲销要按同一规则还原；调拨 / 调整是 available 与 quantity 同增同减，逐条减回去即可。
    IF p_document_type = 'stock_count' THEN
      new_available := new_qty;
    ELSE
      new_available := COALESCE(i.available_quantity, 0) - COALESCE(t.quantity, 0);
    END IF;

    IF NOT allow_negative AND (new_qty < 0 OR new_available < 0) THEN
      RAISE EXCEPTION
        'Cannot reverse % #%: 物料 % 在仓库 % 的库存已被后续业务消耗（现有 %，本行需冲 %）',
        p_document_type, p_document_id, t.product_id, t.warehouse_id,
        COALESCE(i.quantity, 0), t.quantity USING ERRCODE = '23514';
    END IF;

    restored_unit_cost := CASE
      WHEN new_qty = 0 THEN COALESCE(NULLIF(t.unit_cost, 0), NULLIF(i.unit_cost, 0), 0)
      ELSE ABS(new_cost / new_qty)
    END;

    UPDATE public.erp_inventory_s_539dcf81_b
       SET quantity = new_qty,
           available_quantity = new_available,
           unit_cost = restored_unit_cost,
           total_cost = new_cost,
           updated_at = NOW()
     WHERE id = i.id;
  END LOOP;

  -- ---- 软删流水，保留审计痕迹 -------------------------------------------
  UPDATE public.erp_inventory_transactions_s_539dcf81_b
     SET is_deleted = 'y',
         reversal_idempotency_key = p_idempotency_key,
         reversed_at = NOW(),
         updated_at = NOW()
   WHERE reference_type = ANY (v_ref_types)
     AND reference_id = p_document_id
     AND is_deleted = 'n';

  -- ---- 单据状态退回「已审核」，可修改后重新过账 ---------------------------
  IF p_document_type = 'inventory_transfer' THEN
    UPDATE public.erp_inventory_transfers_s_539dcf81_b
       SET status = 'approved',
           reversal_idempotency_key = p_idempotency_key,
           reversed_at = NOW(),
           updated_at = NOW()
     WHERE id = p_document_id;
  ELSIF p_document_type = 'stock_count' THEN
    UPDATE public.erp_stock_counts_s_539dcf81_b
       SET status = 'approved',
           reversal_idempotency_key = p_idempotency_key,
           reversed_at = NOW(),
           updated_at = NOW()
     WHERE id = p_document_id;
  ELSE
    UPDATE public.erp_stock_adjustments_s_539dcf81_b
       SET status = 'approved',
           reversal_idempotency_key = p_idempotency_key,
           reversed_at = NOW(),
           updated_at = NOW()
     WHERE id = p_document_id;
  END IF;

  RETURN jsonb_build_object(
    'ok', TRUE, 'idempotent', FALSE,
    'document_type', p_document_type, 'document_id', p_document_id,
    'status', 'approved', 'line_count', line_count,
    'idempotency_key', p_idempotency_key);
END;
$$;

REVOKE ALL ON FUNCTION public.reverse_inventory_document(TEXT, INTEGER, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reverse_inventory_document(TEXT, INTEGER, UUID) TO authenticated;

COMMENT ON FUNCTION public.reverse_inventory_document(TEXT, INTEGER, UUID) IS
  '冲销库存调拨 / 盘点 / 调整单：按单据产生的库存流水逐条取反，恢复库存数量与移动加权成本，软删流水并把单据状态退回 approved（可修改后重新过账）。幂等：同一冲销键重复调用返回 idempotent=true。库存已被后续消耗时抛 23514 拒绝。注意返回的 line_count 是**冲销的流水条数**（调拨单一张明细会产生出/入两条），与 post_inventory_document 返回的「明细行数」不是同一口径。';


-- ----------------------------------------------------------------------------
-- 3. 自检：桩函数必须已被真实实现取代
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_src TEXT;
BEGIN
    SELECT prosrc INTO v_src
      FROM pg_proc
     WHERE proname = 'reverse_inventory_document'
       AND pronargs = 3;

    IF v_src IS NULL THEN
        RAISE EXCEPTION 'deploy_86 自检失败：reverse_inventory_document(TEXT,INTEGER,UUID) 不存在';
    END IF;

    IF v_src ILIKE '%not implemented yet%' THEN
        RAISE EXCEPTION 'deploy_86 自检失败：reverse_inventory_document 仍是桩函数';
    END IF;

    IF v_src NOT ILIKE '%inventory_transfer_out%' THEN
        RAISE EXCEPTION 'deploy_86 自检失败：冲销未兼容调拨单的 reference_type 字面量写法';
    END IF;

    RAISE NOTICE 'deploy_86 OK：reverse_inventory_document 已实现（% 字符）', length(v_src);
END $$;

GRANT EXECUTE ON FUNCTION public.reverse_inventory_document(TEXT, INTEGER, UUID) TO authenticated;

-- ============================================================================
-- 回滚
-- ----
--   CREATE OR REPLACE FUNCTION public.reverse_inventory_document(TEXT, INTEGER, UUID)
--   RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path = public
--   AS $$ BEGIN RAISE EXCEPTION 'Reverse inventory document is not implemented yet'; END; $$;
--   DROP INDEX public.uq_inventory_transfer_reversal_key;
--   DROP INDEX public.uq_stock_count_reversal_key;
--   DROP INDEX public.uq_stock_adjustment_reversal_key;
--
-- 已知限制
-- --------
--   1) 冲销不重算也不回滚已经产生的**会计凭证** —— 凭证侧的回退由
--      deploy_87 建立的库存-凭证联动负责（冲销时一并作废原凭证）。
--   2) 冲销后库存行不会因为数量归零而被删除（与 reverse_stock_document 一致），
--      留下数量为 0 的行；这保留了 (租户, 物料, 仓库, 库位, 批次) 这个位置的历史。
-- ============================================================================
