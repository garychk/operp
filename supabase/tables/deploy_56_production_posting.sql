-- ============================================================================
-- deploy_56：生产类单据过账闭环（阶段 1）
--
-- 背景
-- ----
-- deploy_13 的 post_stock_document 只认 purchase_receipt / sales_delivery；
-- deploy_24 的 post_inventory_document 只管调拨 / 盘点 / 调整。
-- 生产领料单与生产完工入库单此前没有任何过账入口：
--   - 不写 erp_inventory_transactions
--   - 不动 erp_inventory
-- 结果是「领料了但库存没减」「完工了但库存没加」，账实必然背离。
--
-- deploy_40 已经把 material_issue_out / production_receipt_in 两个业务类型
-- 预置进 sys_inventory_transaction_types，resolve_inventory_transaction_type()
-- 里也有对应回退分支 —— 本脚本只补「映射行 + 过账 RPC」。
--
-- 本脚本做什么
-- ------------
--   1. erp_material_issues / erp_production_receipts 补过账状态列（与 deploy_13 同名同义）
--   2. 幂等键的唯一索引（与 deploy_13 的 uq_*_posting_key 一致）
--   3. sys_document_transaction_types 补两个 DocType 映射行
--   4. post_production_document()    —— 过账（领料出库 / 完工入库）
--   5. reverse_production_document() —— 反过账（冲回库存，状态退回 draft）
--
-- 为什么另起函数而不扩 post_stock_document
-- ----------------------------------------
-- deploy_13/34 的 purchase_receipt 分支内联了「生成应付单」逻辑，与采购订单
-- 回写耦合很深；把生产单据塞进去会让那份函数承担两套不相干的业务不变量。
-- 三个函数分工：post_stock_document（采销）/ post_inventory_document（库存内部）/
-- post_production_document（生产）。
--
-- 状态机
-- ------
--   material_issue      draft|approved|issued --过账--> posted --反过账--> draft
--   production_receipt  draft|approved|issued --过账--> posted --反过账--> draft
--   反过账刻意退回 draft（而非 approved）：生产单据目前没有审批流，
--   退回 draft 才能改单重过；这与 post_stock_document 退回 approved 的差异是有意的。
--
-- 已知边界（本阶段不覆盖）
-- ------------------------
--   - 领料单没有库位字段，按「仓库级无库位库存行」扣减（COALESCE(location_id, 0) = 0）。
--     若某仓库启用了库位且库存全在库位上，领料会因无该行而报缺口 —— 这是刻意
--     暴露而不是静默选一个库位扣。库位化领料是后续步骤。
--   - 成本口径：出库用库存移动加权单价，入库用单据单价（将来接成本卷算）。
--     真正的生产成本卷算（erp_cost_calculations）不在本阶段。
--
-- 依赖：deploy_13（流水列与唯一索引风格）、deploy_25_bins_and_location（location_id）、
--       deploy_34（库位感知过账范式）、deploy_40（交易类型字典）、
--       deploy_41/48（tenant_id 默认值）
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. 过账状态列（与 deploy_13 给采购入库/销售出货加的列完全同名）
-- ----------------------------------------------------------------------------
ALTER TABLE public.erp_material_issues_s_539dcf81_b
  ADD COLUMN IF NOT EXISTS posting_idempotency_key UUID,
  ADD COLUMN IF NOT EXISTS reversal_idempotency_key UUID,
  ADD COLUMN IF NOT EXISTS posted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ;

ALTER TABLE public.erp_production_receipts_s_539dcf81_b
  ADD COLUMN IF NOT EXISTS posting_idempotency_key UUID,
  ADD COLUMN IF NOT EXISTS reversal_idempotency_key UUID,
  ADD COLUMN IF NOT EXISTS posted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ;


-- ----------------------------------------------------------------------------
-- 2. 幂等键唯一索引
--    与 deploy_13 的 uq_purchase_receipt_posting_key 同款：UUID 本身全局唯一，
--    不需要再叠加 tenant_id。
-- ----------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uq_material_issue_posting_key
  ON public.erp_material_issues_s_539dcf81_b (posting_idempotency_key)
  WHERE posting_idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_material_issue_reversal_key
  ON public.erp_material_issues_s_539dcf81_b (reversal_idempotency_key)
  WHERE reversal_idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_production_receipt_posting_key
  ON public.erp_production_receipts_s_539dcf81_b (posting_idempotency_key)
  WHERE posting_idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_production_receipt_reversal_key
  ON public.erp_production_receipts_s_539dcf81_b (reversal_idempotency_key)
  WHERE reversal_idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_erp_material_issues_status
  ON public.erp_material_issues_s_539dcf81_b (status) WHERE is_deleted = 'n';


-- ----------------------------------------------------------------------------
-- 3. DocType -> 业务类型映射
--    tenant_id 显式跟随 sys_document_types 那一行：基线 DocType（tenant_id IS NULL）
--    的映射行也保持 NULL，才对得上 deploy_48 的「共享基线」语义。
--
--    注意：映射行只在 DocType 已注册时才有落点。material_issue 由 deploy_32 注册；
--    production_receipt 目前还没注册（前端也还没有完工入库页），因此这一行会被
--    静默跳过 —— resolve_inventory_transaction_type() 里有对应回退分支，过账不受
--    影响。这里用 NOTICE 把「跳过了谁」打进部署日志，避免以后误判成漏写。
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  missing TEXT;
BEGIN
  SELECT string_agg(x.document_type, ', ' ORDER BY x.document_type)
  INTO missing
  FROM (VALUES ('material_issue'), ('production_receipt')) AS x(document_type)
  WHERE NOT EXISTS (
    SELECT 1 FROM public.sys_document_types d
    WHERE d.document_type = x.document_type AND d.is_deleted = 'n'
  );
  IF missing IS NOT NULL THEN
    RAISE NOTICE 'DocType 未注册，映射行已跳过（过账走 resolve_inventory_transaction_type 回退分支）：%',
      missing;
  END IF;
END
$$;

INSERT INTO public.sys_document_transaction_types
  (tenant_id, document_type_id, transaction_type_code, direction,
   is_default, condition_note, sort_order)
SELECT d.tenant_id, d.id, x.code, x.direction,
       TRUE, x.condition_note, x.sort_order
FROM public.sys_document_types d
JOIN (VALUES
  ('material_issue',     'material_issue_out',    'out', '生产领料单出库',     10),
  ('production_receipt', 'production_receipt_in', 'in',  '生产完工入库单入库', 10)
) AS x(document_type, code, direction, condition_note, sort_order)
  ON x.document_type = d.document_type
WHERE d.is_deleted = 'n'
ON CONFLICT (document_type_id, transaction_type_code) DO UPDATE SET
  direction = EXCLUDED.direction,
  is_default = EXCLUDED.is_default,
  condition_note = EXCLUDED.condition_note,
  sort_order = EXCLUDED.sort_order,
  is_deleted = 'n',
  updated_at = NOW();


-- ----------------------------------------------------------------------------
-- 4. 过账
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.post_production_document(
  p_document_type TEXT, p_document_id INTEGER, p_idempotency_key UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public
AS $$
DECLARE
  h RECORD; d RECORD; i RECORD;
  actor_id INTEGER; line_count INTEGER := 0;
  old_qty NUMERIC; old_available NUMERIC; old_cost NUMERIC;
  new_qty NUMERIC; new_available NUMERIC; new_cost NUMERIC;
  v_unit_cost NUMERIC; inventory_unit_cost NUMERIC; v_location_id INTEGER;
  allow_negative BOOLEAN; normalized_batch TEXT; v_transaction_no TEXT;
  v_direction TEXT; v_is_out BOOLEAN;
BEGIN
  IF p_document_type NOT IN ('material_issue', 'production_receipt') THEN
    RAISE EXCEPTION 'Unsupported production document type: %', p_document_type
      USING ERRCODE = '22023';
  END IF;
  IF p_document_id IS NULL OR p_document_id <= 0
     OR p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'A positive document ID and idempotency key are required'
      USING ERRCODE = '22023';
  END IF;
  actor_id := public.current_sys_user_id();

  -- 主表加锁。领料单与完工入库单都没有库位字段，header_location_id 恒为 NULL。
  IF p_document_type = 'material_issue' THEN
    SELECT x.id, x.issue_no AS document_no, x.issue_date AS document_date,
      x.warehouse_id, NULL::INTEGER AS header_location_id,
      x.total_amount, x.status, x.corp_id, x.posting_idempotency_key
    INTO h FROM public.erp_material_issues_s_539dcf81_b x
    WHERE x.id = p_document_id AND x.is_deleted = 'n' FOR UPDATE;
  ELSE
    SELECT x.id, x.receipt_no AS document_no, x.receipt_date AS document_date,
      x.warehouse_id, NULL::INTEGER AS header_location_id,
      x.amount AS total_amount, x.status, x.corp_id, x.posting_idempotency_key
    INTO h FROM public.erp_production_receipts_s_539dcf81_b x
    WHERE x.id = p_document_id AND x.is_deleted = 'n' FOR UPDATE;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Production document does not exist or is deleted'
      USING ERRCODE = 'P0002';
  END IF;
  IF h.status = 'posted' AND h.posting_idempotency_key = p_idempotency_key THEN
    RETURN jsonb_build_object('ok', TRUE, 'idempotent', TRUE,
      'document_type', p_document_type, 'document_id', p_document_id,
      'status', 'posted');
  END IF;
  IF COALESCE(h.status, '') NOT IN ('draft', 'approved', 'issued') THEN
    RAISE EXCEPTION
      'Only draft, approved or issued documents can be posted; current status: %',
      COALESCE(h.status, '<null>') USING ERRCODE = '55000';
  END IF;
  IF h.warehouse_id IS NULL THEN
    RAISE EXCEPTION 'Production document has no warehouse' USING ERRCODE = '23502';
  END IF;
  -- 双保险：主表状态没置 posted 但流水已存在（例如手工改回 draft），一律拒绝。
  IF EXISTS (
    SELECT 1 FROM public.erp_inventory_transactions_s_539dcf81_b t
    WHERE t.reference_type = p_document_type
      AND t.reference_id = p_document_id AND t.is_deleted = 'n'
  ) THEN
    RAISE EXCEPTION 'Document already has active inventory transactions'
      USING ERRCODE = '23505';
  END IF;

  -- 锁明细行，避免并发过账读到改到一半的明细
  IF p_document_type = 'material_issue' THEN
    PERFORM x.id
    FROM public.erp_material_issue_details_s_539dcf81_b x
    WHERE x.issue_id = p_document_id AND x.is_deleted = 'n'
    ORDER BY x.id FOR UPDATE;
  END IF;

  SELECT COALESCE(w.is_negative_stock_allowed, FALSE)
  INTO allow_negative FROM public.erp_warehouses_s_539dcf81_b w
  WHERE w.id = h.warehouse_id AND w.is_deleted = 'n' FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Warehouse does not exist or is deleted'
      USING ERRCODE = 'P0002';
  END IF;

  -- 两张单据归一成同一形状的明细流：完工入库单没有明细表，主表即唯一明细行。
  FOR d IN
    SELECT x.id AS detail_id, x.material_id AS product_id, x.quantity,
      x.unit_cost AS document_unit_cost,
      COALESCE(NULLIF(p.cost_price, 0), NULLIF(p.purchase_price, 0), 0)
        AS product_unit_cost,
      NULLIF(BTRIM(x.batch_no), '') AS batch_no,
      NULL::DATE AS expiry_date, NULL::INTEGER AS detail_location_id
    FROM public.erp_material_issue_details_s_539dcf81_b x
    LEFT JOIN public.erp_products_s_539dcf81_b p ON p.id = x.material_id
    WHERE p_document_type = 'material_issue'
      AND x.issue_id = p_document_id AND x.is_deleted = 'n'
    UNION ALL
    SELECT x.id, x.product_id, x.quantity,
      x.unit_cost,
      COALESCE(NULLIF(p.cost_price, 0), NULLIF(p.purchase_price, 0), 0),
      NULLIF(BTRIM(x.batch_no), ''), NULL::DATE, NULL::INTEGER
    FROM public.erp_production_receipts_s_539dcf81_b x
    LEFT JOIN public.erp_products_s_539dcf81_b p ON p.id = x.product_id
    WHERE p_document_type = 'production_receipt' AND x.id = p_document_id
      AND x.is_deleted = 'n'
    ORDER BY product_id, batch_no NULLS FIRST, detail_id
  LOOP
    line_count := line_count + 1;
    IF d.product_id IS NULL OR d.quantity IS NULL OR d.quantity <= 0 THEN
      RAISE EXCEPTION 'Detail % has no product or non-positive quantity',
        d.detail_id USING ERRCODE = '23514';
    END IF;
    v_is_out := (p_document_type = 'material_issue');
    v_direction := CASE WHEN v_is_out THEN 'out' ELSE 'in' END;
    normalized_batch := NULLIF(BTRIM(d.batch_no), '');
    v_location_id := COALESCE(d.detail_location_id, h.header_location_id);

    IF v_location_id IS NOT NULL THEN
      PERFORM 1 FROM public.erp_bins_s_539dcf81_b b
      WHERE b.id = v_location_id AND b.warehouse_id = h.warehouse_id
        AND b.is_deleted = 'n';
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Location % is not valid for warehouse %',
          v_location_id, h.warehouse_id USING ERRCODE = '23503';
      END IF;
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended(
      format('erp_inventory:%s:%s:%s:%s', d.product_id, h.warehouse_id,
        COALESCE(v_location_id, 0), COALESCE(normalized_batch, '')), 0));

    SELECT x.* INTO i FROM public.erp_inventory_s_539dcf81_b x
    WHERE x.product_id = d.product_id AND x.warehouse_id = h.warehouse_id
      AND COALESCE(x.location_id, 0) = COALESCE(v_location_id, 0)
      AND COALESCE(NULLIF(BTRIM(x.batch_no), ''), '') =
          COALESCE(normalized_batch, '')
      AND x.is_deleted = 'n' FOR UPDATE;
    IF FOUND THEN
      old_qty := COALESCE(i.quantity, 0);
      old_available := COALESCE(i.available_quantity, 0);
      old_cost := COALESCE(i.total_cost, 0);
      inventory_unit_cost := COALESCE(i.unit_cost, 0);
    ELSE
      old_qty := 0; old_available := 0; old_cost := 0;
      inventory_unit_cost := 0;
    END IF;

    IF v_is_out THEN
      -- 出库：成本取库存移动加权单价（与 deploy_24 调拨出库口径一致）
      v_unit_cost := COALESCE(NULLIF(inventory_unit_cost, 0),
        NULLIF(d.document_unit_cost, 0), NULLIF(d.product_unit_cost, 0), 0);
      new_qty := old_qty - d.quantity;
      new_available := old_available - d.quantity;
      new_cost := old_cost - d.quantity * v_unit_cost;
    ELSE
      -- 入库：成本取单据单价（将来由成本卷算写入），再退物料成本价、库存单价
      v_unit_cost := COALESCE(NULLIF(d.document_unit_cost, 0),
        NULLIF(d.product_unit_cost, 0), NULLIF(inventory_unit_cost, 0), 0);
      new_qty := old_qty + d.quantity;
      new_available := old_available + d.quantity;
      new_cost := old_cost + d.quantity * v_unit_cost;
    END IF;

    IF NOT allow_negative AND (new_qty < 0 OR new_available < 0) THEN
      IF v_is_out AND v_location_id IS NULL THEN
        RAISE EXCEPTION
          'Insufficient warehouse-level stock for product %, warehouse %: available %, requested % (领料单按无库位库存行扣减；若该仓库存量都在库位上，请先做库位调整或补建无库位库存)',
          d.product_id, h.warehouse_id, old_available, d.quantity
          USING ERRCODE = '23514';
      END IF;
      RAISE EXCEPTION
        'Insufficient stock for product %, warehouse %: available %, requested %',
        d.product_id, h.warehouse_id, old_available, d.quantity
        USING ERRCODE = '23514';
    END IF;

    IF i.id IS NULL THEN
      INSERT INTO public.erp_inventory_s_539dcf81_b (
        corp_id, emp_id, is_deleted, product_id, warehouse_id, location_id,
        quantity, available_quantity, locked_quantity, unit_cost,
        total_cost, batch_no, expiry_date
      ) VALUES (
        h.corp_id, actor_id::TEXT, 'n', d.product_id, h.warehouse_id,
        v_location_id,
        new_qty, new_available, 0,
        CASE WHEN new_qty = 0 THEN v_unit_cost ELSE ABS(new_cost / new_qty) END,
        new_cost, normalized_batch, d.expiry_date
      ) RETURNING * INTO i;
    ELSE
      UPDATE public.erp_inventory_s_539dcf81_b
      SET quantity = new_qty, available_quantity = new_available,
          unit_cost = CASE WHEN new_qty = 0 THEN v_unit_cost
                           ELSE ABS(new_cost / new_qty) END,
          total_cost = new_cost,
          expiry_date = COALESCE(d.expiry_date, expiry_date),
          updated_at = NOW()
      WHERE id = i.id;
    END IF;

    v_transaction_no := 'IT' || TO_CHAR(clock_timestamp(), 'YYYYMMDDHH24MISSMS')
      || LPAD(d.detail_id::TEXT, 6, '0');
    INSERT INTO public.erp_inventory_transactions_s_539dcf81_b (
      corp_id, emp_id, is_deleted, transaction_no, transaction_type,
      transaction_date, product_id, warehouse_id, location_id, batch_no, quantity,
      unit_cost, total_cost, reference_type, reference_id,
      reference_detail_id, posting_idempotency_key, remark
    ) VALUES (
      h.corp_id, actor_id::TEXT, 'n', LEFT(v_transaction_no, 50),
      public.resolve_inventory_transaction_type(p_document_type, v_direction),
      h.document_date, d.product_id, h.warehouse_id, v_location_id,
      normalized_batch,
      CASE WHEN v_is_out THEN -d.quantity ELSE d.quantity END,
      v_unit_cost,
      CASE WHEN v_is_out THEN -(d.quantity * v_unit_cost)
           ELSE d.quantity * v_unit_cost END,
      p_document_type, p_document_id, d.detail_id, p_idempotency_key,
      CASE WHEN v_is_out
           THEN format('生产领料单 %s 过账', h.document_no)
           ELSE format('生产完工入库单 %s 过账', h.document_no) END
    );
  END LOOP;

  IF line_count = 0 THEN
    RAISE EXCEPTION 'Production document has no active details'
      USING ERRCODE = '23514';
  END IF;

  IF p_document_type = 'material_issue' THEN
    UPDATE public.erp_material_issues_s_539dcf81_b
    SET status = 'posted', posting_idempotency_key = p_idempotency_key,
        reversal_idempotency_key = NULL, posted_at = NOW(), reversed_at = NULL,
        updated_at = NOW()
    WHERE id = p_document_id;
  ELSE
    UPDATE public.erp_production_receipts_s_539dcf81_b
    SET status = 'posted', posting_idempotency_key = p_idempotency_key,
        reversal_idempotency_key = NULL, posted_at = NOW(), reversed_at = NULL,
        updated_at = NOW()
    WHERE id = p_document_id;
  END IF;

  RETURN jsonb_build_object('ok', TRUE, 'idempotent', FALSE,
    'document_type', p_document_type, 'document_id', p_document_id,
    'status', 'posted', 'line_count', line_count,
    'idempotency_key', p_idempotency_key);
END;
$$;


-- ----------------------------------------------------------------------------
-- 5. 反过账
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reverse_production_document(
  p_document_type TEXT, p_document_id INTEGER, p_idempotency_key UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public
AS $$
DECLARE
  h RECORD; t RECORD; i RECORD;
  allow_negative BOOLEAN; normalized_batch TEXT;
  new_qty NUMERIC; new_available NUMERIC; new_cost NUMERIC;
  restored_unit_cost NUMERIC; line_count INTEGER := 0;
BEGIN
  IF p_document_type NOT IN ('material_issue', 'production_receipt') THEN
    RAISE EXCEPTION 'Unsupported production document type: %', p_document_type
      USING ERRCODE = '22023';
  END IF;
  IF p_document_id IS NULL OR p_document_id <= 0
     OR p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'A positive document ID and idempotency key are required'
      USING ERRCODE = '22023';
  END IF;

  IF p_document_type = 'material_issue' THEN
    SELECT x.id, x.issue_no AS document_no, x.status,
      x.reversal_idempotency_key
    INTO h FROM public.erp_material_issues_s_539dcf81_b x
    WHERE x.id = p_document_id AND x.is_deleted = 'n' FOR UPDATE;
  ELSE
    SELECT x.id, x.receipt_no AS document_no, x.status,
      x.reversal_idempotency_key
    INTO h FROM public.erp_production_receipts_s_539dcf81_b x
    WHERE x.id = p_document_id AND x.is_deleted = 'n' FOR UPDATE;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Production document does not exist or is deleted'
      USING ERRCODE = 'P0002';
  END IF;
  IF h.status = 'draft' AND h.reversal_idempotency_key = p_idempotency_key THEN
    RETURN jsonb_build_object('ok', TRUE, 'idempotent', TRUE,
      'document_type', p_document_type, 'document_id', p_document_id,
      'status', 'draft');
  END IF;
  IF h.status <> 'posted' THEN
    RAISE EXCEPTION 'Only posted documents can be reversed; current status: %',
      COALESCE(h.status, '<null>') USING ERRCODE = '55000';
  END IF;

  FOR t IN
    SELECT x.* FROM public.erp_inventory_transactions_s_539dcf81_b x
    WHERE x.reference_type = p_document_type
      AND x.reference_id = p_document_id AND x.is_deleted = 'n'
    ORDER BY x.product_id, x.warehouse_id, COALESCE(x.location_id, 0),
             x.batch_no NULLS FIRST, x.id FOR UPDATE
  LOOP
    line_count := line_count + 1;
    normalized_batch := NULLIF(BTRIM(t.batch_no), '');
    PERFORM pg_advisory_xact_lock(hashtextextended(
      format('erp_inventory:%s:%s:%s:%s', t.product_id, t.warehouse_id,
        COALESCE(t.location_id, 0), COALESCE(normalized_batch, '')), 0));
    SELECT x.* INTO i FROM public.erp_inventory_s_539dcf81_b x
    WHERE x.product_id = t.product_id AND x.warehouse_id = t.warehouse_id
      AND COALESCE(x.location_id, 0) = COALESCE(t.location_id, 0)
      AND COALESCE(NULLIF(BTRIM(x.batch_no), ''), '') =
          COALESCE(normalized_batch, '')
      AND x.is_deleted = 'n' FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'Inventory missing for transaction %, product %, warehouse %, location %',
        t.id, t.product_id, t.warehouse_id, COALESCE(t.location_id, 0)
        USING ERRCODE = 'P0002';
    END IF;

    SELECT COALESCE(w.is_negative_stock_allowed, FALSE)
    INTO allow_negative FROM public.erp_warehouses_s_539dcf81_b w
    WHERE w.id = t.warehouse_id AND w.is_deleted = 'n' FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Warehouse does not exist or is deleted'
        USING ERRCODE = 'P0002';
    END IF;

    -- 流水里的 quantity / total_cost 带符号：出库为负，入库为正。
    -- 减去流水即「撤销该笔影响」，方向自动正确。
    new_qty := COALESCE(i.quantity, 0) - COALESCE(t.quantity, 0);
    new_available := COALESCE(i.available_quantity, 0) -
      COALESCE(t.quantity, 0);
    new_cost := COALESCE(i.total_cost, 0) - COALESCE(t.total_cost, 0);
    IF NOT allow_negative AND (new_qty < 0 OR new_available < 0) THEN
      RAISE EXCEPTION
        'Cannot reverse: stock was consumed for product %, warehouse %',
        t.product_id, t.warehouse_id USING ERRCODE = '23514';
    END IF;

    restored_unit_cost := CASE
      WHEN new_qty = 0 THEN COALESCE(t.unit_cost, i.unit_cost, 0)
      ELSE ABS(new_cost / new_qty)
    END;
    UPDATE public.erp_inventory_s_539dcf81_b
    SET quantity = new_qty, available_quantity = new_available,
        unit_cost = restored_unit_cost, total_cost = new_cost,
        updated_at = NOW()
    WHERE id = i.id;
  END LOOP;
  IF line_count = 0 THEN
    RAISE EXCEPTION 'No active inventory transactions found'
      USING ERRCODE = 'P0002';
  END IF;

  UPDATE public.erp_inventory_transactions_s_539dcf81_b
  SET is_deleted = 'y', reversal_idempotency_key = p_idempotency_key,
      reversed_at = NOW(), updated_at = NOW()
  WHERE reference_type = p_document_type
    AND reference_id = p_document_id AND is_deleted = 'n';

  IF p_document_type = 'material_issue' THEN
    UPDATE public.erp_material_issues_s_539dcf81_b
    SET status = 'draft', reversal_idempotency_key = p_idempotency_key,
        reversed_at = NOW(), updated_at = NOW()
    WHERE id = p_document_id;
  ELSE
    UPDATE public.erp_production_receipts_s_539dcf81_b
    SET status = 'draft', reversal_idempotency_key = p_idempotency_key,
        reversed_at = NOW(), updated_at = NOW()
    WHERE id = p_document_id;
  END IF;

  RETURN jsonb_build_object('ok', TRUE, 'idempotent', FALSE,
    'document_type', p_document_type, 'document_id', p_document_id,
    'status', 'draft', 'line_count', line_count,
    'idempotency_key', p_idempotency_key);
END;
$$;


REVOKE ALL ON FUNCTION public.post_production_document(TEXT, INTEGER, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reverse_production_document(TEXT, INTEGER, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.post_production_document(TEXT, INTEGER, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reverse_production_document(TEXT, INTEGER, UUID) TO authenticated;
