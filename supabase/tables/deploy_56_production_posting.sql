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
-- ----------------------------------------------------------------------------
-- 4. 过账（post_production_document，含 material_return / 完工入库回写 / 超额硬限制）
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.post_production_document(p_document_type text, p_document_id integer, p_idempotency_key uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  h RECORD; d RECORD;
  actor_id INTEGER; line_count INTEGER := 0;
  normalized_batch TEXT; v_location_id INTEGER; v_transaction_no TEXT;
  allow_negative BOOLEAN;
  v_is_out BOOLEAN; v_direction TEXT; v_target_status TEXT;
  v_inv_unit_cost NUMERIC; v_unit_cost NUMERIC; v_move JSONB; v_consumed NUMERIC;
  v_voucher_result JSONB;
  -- 完工入库过账后回写生产订单完成数量（deploy_93 补丁，见 2026-10-19）
  v_order_completed NUMERIC; v_order_planned NUMERIC; v_order_status VARCHAR(20);
BEGIN
  IF p_document_type NOT IN ('material_issue', 'production_receipt', 'material_return') THEN
    RAISE EXCEPTION 'Unsupported production document type: %', p_document_type
      USING ERRCODE = '22023';
  END IF;
  IF p_document_id IS NULL OR p_document_id <= 0 OR p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'A positive document ID and idempotency key are required'
      USING ERRCODE = '22023';
  END IF;
  actor_id := public.current_sys_user_id();

  -- 主表加锁。三张主表都带 tenant_id（旧版没取，导致写入靠 GUC 兜底 —— 已修）。
  IF p_document_type = 'material_issue' THEN
    SELECT x.id, x.issue_no AS document_no, x.issue_date AS document_date,
      x.warehouse_id, NULL::INTEGER AS header_location_id,
      x.total_amount, x.status, x.corp_id, x.posting_idempotency_key, x.tenant_id
    INTO h FROM public.erp_material_issues_s_539dcf81_b x
    WHERE x.id = p_document_id AND x.is_deleted = 'n' FOR UPDATE;
  ELSIF p_document_type = 'production_receipt' THEN
    SELECT x.id, x.receipt_no AS document_no, x.receipt_date AS document_date,
      x.warehouse_id, x.location_id AS header_location_id,
      x.amount AS total_amount, x.status, x.corp_id, x.posting_idempotency_key, x.tenant_id,
      x.production_order_id, x.quantity
    INTO h FROM public.erp_production_receipts_s_539dcf81_b x
    WHERE x.id = p_document_id AND x.is_deleted = 'n' FOR UPDATE;
  ELSE
    SELECT x.id, x.return_no AS document_no, x.return_date AS document_date,
      x.warehouse_id, x.location_id AS header_location_id,
      x.total_amount, x.status, x.corp_id, x.posting_idempotency_key, x.tenant_id
    INTO h FROM public.erp_material_returns_s_539dcf81_b x
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
  -- 完工入库硬限制：累计完工入库不得超过生产订单计划数量（deploy_93 补丁，2026-10-19）。
  -- 口径：同订单其它「已过账」入库单数量之和 + 本单数量 <= planned_quantity；
  -- 反过账后（本单 draft）重过账时不含本单旧值，天然正确。
  -- 注意：不能用 `IF p_document_type = 'production_receipt' AND h.production_order_id ...`
  -- 这种写法 —— PL/pgSQL 会把整个 AND 表达式交给 SQL 求值，不保证短路顺序，
  -- 领料单分支的 h 没有 production_order_id 字段时会直接报
  -- "record h has no field production_order_id"。必须用嵌套 IF 隔离 RECORD 字段访问。
  IF p_document_type = 'production_receipt' THEN
    IF h.production_order_id IS NOT NULL THEN
      SELECT o.planned_quantity INTO v_order_planned
        FROM public.erp_production_orders_s_539dcf81_b o
       WHERE o.id = h.production_order_id AND o.tenant_id = h.tenant_id AND o.is_deleted = 'n'
         FOR SHARE;
      IF FOUND AND COALESCE(v_order_planned, 0) > 0 THEN
        SELECT COALESCE(SUM(x.quantity), 0) INTO v_order_completed
          FROM public.erp_production_receipts_s_539dcf81_b x
         WHERE x.production_order_id = h.production_order_id
           AND x.status = 'posted' AND x.is_deleted = 'n'
           AND x.id <> p_document_id;
        IF COALESCE(v_order_completed, 0) + COALESCE(h.quantity, 0)
             > v_order_planned + 0.000001 THEN
          RAISE EXCEPTION
            '完工入库超额：订单已累计入库 %，本单 %，超过计划数量 %',
            v_order_completed, h.quantity, v_order_planned
            USING ERRCODE = '55000';
        END IF;
      END IF;
    END IF;
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

  IF p_document_type = 'material_issue' THEN
    PERFORM x.id FROM public.erp_material_issue_details_s_539dcf81_b x
     WHERE x.issue_id = p_document_id AND x.is_deleted = 'n' ORDER BY x.id FOR UPDATE;
  ELSIF p_document_type = 'material_return' THEN
    PERFORM x.id FROM public.erp_material_return_details_s_539dcf81_b x
     WHERE x.return_id = p_document_id AND x.is_deleted = 'n' ORDER BY x.id FOR UPDATE;
  END IF;

  SELECT COALESCE(w.is_negative_stock_allowed, FALSE)
  INTO allow_negative FROM public.erp_warehouses_s_539dcf81_b w
  WHERE w.id = h.warehouse_id AND w.is_deleted = 'n' FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Warehouse does not exist or is deleted'
      USING ERRCODE = 'P0002';
  END IF;

  v_is_out := (p_document_type = 'material_issue');
  v_direction := CASE WHEN v_is_out THEN 'out' ELSE 'in' END;

  -- 领料出库只吃可用库存；完工入库按「入库即待检」开关；
  -- 生产退料是「车间把原先领走的料还回来」，回到可用状态（不进待检 —— 料本来就是合格的）。
  IF v_is_out THEN
    v_target_status := 'available';
  ELSIF p_document_type = 'material_return' THEN
    v_target_status := 'available';
  ELSE
    v_target_status := public.inventory_receipt_stock_status(h.tenant_id);
  END IF;

  -- 三张单据归一成同一形状的明细流：完工入库单没有明细表，主表即唯一明细行。
  FOR d IN
    SELECT x.id AS detail_id, x.material_id AS product_id, x.quantity,
      x.unit_cost AS document_unit_cost,
      COALESCE(NULLIF(p.cost_price, 0), NULLIF(p.purchase_price, 0), 0) AS product_unit_cost,
      NULLIF(BTRIM(x.batch_no), '') AS batch_no,
      NULL::DATE AS expiry_date, x.location_id AS detail_location_id
    FROM public.erp_material_issue_details_s_539dcf81_b x
    LEFT JOIN public.erp_products_s_539dcf81_b p ON p.id = x.material_id
    WHERE p_document_type = 'material_issue'
      AND x.issue_id = p_document_id AND x.is_deleted = 'n'
    UNION ALL
    SELECT x.id, x.product_id, x.quantity, x.unit_cost,
      COALESCE(NULLIF(p.cost_price, 0), NULLIF(p.purchase_price, 0), 0),
      NULLIF(BTRIM(x.batch_no), ''), NULL::DATE, x.location_id
    FROM public.erp_production_receipts_s_539dcf81_b x
    LEFT JOIN public.erp_products_s_539dcf81_b p ON p.id = x.product_id
    WHERE p_document_type = 'production_receipt' AND x.id = p_document_id
      AND x.is_deleted = 'n'
    UNION ALL
    SELECT x.id, x.material_id, x.quantity, x.unit_cost,
      COALESCE(NULLIF(p.cost_price, 0), NULLIF(p.purchase_price, 0), 0),
      NULLIF(BTRIM(x.batch_no), ''), NULL::DATE, x.location_id
    FROM public.erp_material_return_details_s_539dcf81_b x
    LEFT JOIN public.erp_products_s_539dcf81_b p ON p.id = x.material_id
    WHERE p_document_type = 'material_return'
      AND x.return_id = p_document_id AND x.is_deleted = 'n'
    ORDER BY product_id, batch_no NULLS FIRST, detail_id
  LOOP
    line_count := line_count + 1;
    IF d.product_id IS NULL OR d.quantity IS NULL OR d.quantity <= 0 THEN
      RAISE EXCEPTION 'Detail % has no product or non-positive quantity',
        d.detail_id USING ERRCODE = '23514';
    END IF;
    normalized_batch := NULLIF(BTRIM(d.batch_no), '');
    v_location_id := COALESCE(d.detail_location_id, h.header_location_id);

    IF v_location_id IS NOT NULL THEN
      PERFORM 1 FROM public.erp_bins_s_539dcf81_b b
      WHERE b.id = v_location_id AND b.warehouse_id = h.warehouse_id
        AND b.tenant_id = h.tenant_id AND b.is_deleted = 'n';
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Location % is not valid for warehouse %',
          v_location_id, h.warehouse_id USING ERRCODE = '23503';
      END IF;
    END IF;

    v_inv_unit_cost := COALESCE((
      SELECT x.unit_cost FROM public.erp_inventory_s_539dcf81_b x
       WHERE x.product_id = d.product_id AND x.warehouse_id = h.warehouse_id
         AND x.tenant_id = h.tenant_id
         AND COALESCE(x.location_id, 0) = COALESCE(v_location_id, 0)
         AND COALESCE(NULLIF(BTRIM(x.batch_no), ''), '') = COALESCE(normalized_batch, '')
         AND x.stock_status = v_target_status AND x.is_deleted = 'n'), 0);

    IF v_is_out THEN
      -- 出库：成本取库存移动加权单价（与调拨出库口径一致）
      v_unit_cost := COALESCE(NULLIF(v_inv_unit_cost, 0),
        NULLIF(d.document_unit_cost, 0), NULLIF(d.product_unit_cost, 0), 0);
    ELSE
      -- 入库：成本取单据单价（成本卷算写入），再退物料成本价、库存单价
      v_unit_cost := COALESCE(NULLIF(d.document_unit_cost, 0),
        NULLIF(d.product_unit_cost, 0), NULLIF(v_inv_unit_cost, 0), 0);
    END IF;

    -- 出库先释放预占，再扣库存（顺序理由同 post_stock_document）
    IF v_is_out THEN
      v_consumed := public.inventory_consume_reservations(
        h.tenant_id, d.product_id, h.warehouse_id, v_location_id,
        normalized_batch, v_target_status, d.quantity);
    END IF;

    v_move := public.inventory_apply_move(
      p_tenant_id      => h.tenant_id,
      p_corp_id        => h.corp_id,
      p_actor_id       => actor_id,
      p_product_id     => d.product_id,
      p_warehouse_id   => h.warehouse_id,
      p_location_id    => v_location_id,
      p_batch_no       => normalized_batch,
      p_stock_status   => v_target_status,
      p_qty_delta      => CASE WHEN v_is_out THEN -d.quantity ELSE d.quantity END,
      p_unit_cost      => v_unit_cost,
      p_cost_delta     => NULL,
      p_expiry_date    => d.expiry_date,
      p_allow_negative => allow_negative);
    v_unit_cost := COALESCE((v_move ->> 'unit_cost')::NUMERIC, v_unit_cost);

    v_transaction_no := 'IT' || TO_CHAR(clock_timestamp(), 'YYYYMMDDHH24MISSMS')
      || LPAD(d.detail_id::TEXT, 6, '0');
    INSERT INTO public.erp_inventory_transactions_s_539dcf81_b (
      corp_id, emp_id, is_deleted, transaction_no, transaction_type,
      transaction_date, product_id, warehouse_id, location_id, batch_no,
      stock_status, quantity, unit_cost, total_cost, reference_type, reference_id,
      reference_detail_id, posting_idempotency_key, remark, tenant_id
    ) VALUES (
      h.corp_id, actor_id::TEXT, 'n', LEFT(v_transaction_no, 50),
      public.resolve_inventory_transaction_type(p_document_type, v_direction),
      h.document_date, d.product_id, h.warehouse_id, v_location_id,
      normalized_batch, v_target_status,
      CASE WHEN v_is_out THEN -d.quantity ELSE d.quantity END,
      v_unit_cost,
      COALESCE((v_move ->> 'cost_delta')::NUMERIC, 0),
      p_document_type, p_document_id, d.detail_id, p_idempotency_key,
      format('%s %s 过账', p_document_type, h.document_no),
      h.tenant_id
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
  ELSIF p_document_type = 'production_receipt' THEN
    UPDATE public.erp_production_receipts_s_539dcf81_b
    SET status = 'posted', posting_idempotency_key = p_idempotency_key,
        reversal_idempotency_key = NULL, posted_at = NOW(), reversed_at = NULL,
        updated_at = NOW()
    WHERE id = p_document_id;

    -- 回写生产订单完成数量：完工入库过账后，把本次入库数累计到订单 completed_quantity。
    -- 累计 >= 计划数时自动置 completed（此前该字段无任何写入来源，恒为 0 —— 历史 bug）。
    IF h.production_order_id IS NOT NULL THEN
      UPDATE public.erp_production_orders_s_539dcf81_b o
         SET completed_quantity = COALESCE(o.completed_quantity, 0) + COALESCE(h.quantity, 0),
             updated_at = NOW()
       WHERE o.id = h.production_order_id
         AND o.tenant_id = h.tenant_id
         AND o.is_deleted = 'n'
      RETURNING completed_quantity, planned_quantity, status
        INTO v_order_completed, v_order_planned, v_order_status;

      IF FOUND
         AND v_order_completed >= COALESCE(v_order_planned, 0)
         AND v_order_planned > 0
         AND COALESCE(v_order_status, '') NOT IN ('completed', 'closed', 'cancelled') THEN
        UPDATE public.erp_production_orders_s_539dcf81_b
           SET status = 'completed', updated_at = NOW()
         WHERE id = h.production_order_id AND is_deleted = 'n';
      END IF;
    END IF;
  ELSE
    UPDATE public.erp_material_returns_s_539dcf81_b
    SET status = 'posted', posting_idempotency_key = p_idempotency_key,
        reversal_idempotency_key = NULL, posted_at = NOW(), reversed_at = NULL,
        updated_at = NOW()
    WHERE id = p_document_id;
  END IF;

  -- ---- 库存 -> 总账勾稽（deploy_87 / deploy_92）--------------------------
  v_voucher_result := public.inventory_sync_voucher(
    p_source_type   => p_document_type,
    p_source_id     => p_document_id,
    p_document_no   => h.document_no,
    p_document_date => h.document_date,
    p_tenant_id     => h.tenant_id,
    p_remark        => format('%s %s', p_document_type, h.document_no));

  RETURN jsonb_build_object('ok', TRUE, 'idempotent', FALSE,
    'document_type', p_document_type, 'document_id', p_document_id,
    'status', 'posted', 'line_count', line_count,
    'stock_status', v_target_status,
    'voucher', v_voucher_result,
    'idempotency_key', p_idempotency_key);
END;
$function$

-- ----------------------------------------------------------------------------
-- 5. 反过账（reverse_production_document）
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reverse_production_document(p_document_type text, p_document_id integer, p_idempotency_key uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  h RECORD; t RECORD;
  actor_id INTEGER;
  line_count INTEGER := 0;
  v_target_status TEXT;
  v_move JSONB;
  v_voucher_result JSONB;
  -- 完工入库反过账回写生产订单（deploy_93 补丁，见 2026-10-19）
  v_order_completed NUMERIC; v_order_planned NUMERIC; v_order_status VARCHAR(20);
BEGIN
  IF p_document_type NOT IN ('material_issue', 'production_receipt', 'material_return') THEN
    RAISE EXCEPTION 'Unsupported production document type: %', p_document_type
      USING ERRCODE = '22023';
  END IF;
  IF p_document_id IS NULL OR p_document_id <= 0 OR p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'A positive document ID and idempotency key are required'
      USING ERRCODE = '22023';
  END IF;
  actor_id := public.current_sys_user_id();

  IF p_document_type = 'material_issue' THEN
    SELECT x.id, x.issue_no AS document_no, x.status, x.reversal_idempotency_key, x.tenant_id
    INTO h FROM public.erp_material_issues_s_539dcf81_b x
    WHERE x.id = p_document_id AND x.is_deleted = 'n' FOR UPDATE;
  ELSIF p_document_type = 'production_receipt' THEN
    SELECT x.id, x.receipt_no AS document_no, x.status, x.reversal_idempotency_key, x.tenant_id,
      x.production_order_id, x.quantity
    INTO h FROM public.erp_production_receipts_s_539dcf81_b x
    WHERE x.id = p_document_id AND x.is_deleted = 'n' FOR UPDATE;
  ELSE
    SELECT x.id, x.return_no AS document_no, x.status, x.reversal_idempotency_key, x.tenant_id
    INTO h FROM public.erp_material_returns_s_539dcf81_b x
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
             x.batch_no NULLS FIRST, COALESCE(x.stock_status, 'available'), x.id
    FOR UPDATE
  LOOP
    line_count := line_count + 1;
    v_target_status := COALESCE(NULLIF(BTRIM(t.stock_status), ''), 'available');

    -- 流水里的 quantity / total_cost 带符号：出库为负，入库为正。
    -- 减去流水即「撤销该笔影响」，方向自动正确。
    v_move := public.inventory_apply_move(
      p_tenant_id      => t.tenant_id,
      p_corp_id        => t.corp_id,
      p_actor_id       => actor_id,
      p_product_id     => t.product_id,
      p_warehouse_id   => t.warehouse_id,
      p_location_id    => t.location_id,
      p_batch_no       => t.batch_no,
      p_stock_status   => v_target_status,
      p_qty_delta      => -COALESCE(t.quantity, 0),
      p_unit_cost      => t.unit_cost,
      p_cost_delta     => -COALESCE(t.total_cost, 0),
      p_expiry_date    => NULL,
      p_allow_negative => NULL);
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
  ELSIF p_document_type = 'production_receipt' THEN
    UPDATE public.erp_production_receipts_s_539dcf81_b
    SET status = 'draft', reversal_idempotency_key = p_idempotency_key,
        reversed_at = NOW(), updated_at = NOW()
    WHERE id = p_document_id;

    -- 对称回写：反过账把本次入库数从订单 completed_quantity 扣回；
    -- 若订单此前因达标被自动置 completed，反过账后数量跌破计划数 → 退回 in_progress。
    IF h.production_order_id IS NOT NULL THEN
      UPDATE public.erp_production_orders_s_539dcf81_b o
         SET completed_quantity = GREATEST(0, COALESCE(o.completed_quantity, 0) - COALESCE(h.quantity, 0)),
             updated_at = NOW()
       WHERE o.id = h.production_order_id
         AND o.tenant_id = h.tenant_id
         AND o.is_deleted = 'n'
      RETURNING completed_quantity, planned_quantity, status
        INTO v_order_completed, v_order_planned, v_order_status;

      IF FOUND
         AND COALESCE(v_order_status, '') = 'completed'
         AND v_order_completed < COALESCE(v_order_planned, 0) THEN
        UPDATE public.erp_production_orders_s_539dcf81_b
           SET status = 'in_progress', updated_at = NOW()
         WHERE id = h.production_order_id AND is_deleted = 'n';
      END IF;
    END IF;
  ELSE
    UPDATE public.erp_material_returns_s_539dcf81_b
    SET status = 'draft', reversal_idempotency_key = p_idempotency_key,
        reversed_at = NOW(), updated_at = NOW()
    WHERE id = p_document_id;
  END IF;

  v_voucher_result := public.inventory_void_voucher(
    p_source_type     => p_document_type,
    p_source_id       => p_document_id,
    p_tenant_id       => h.tenant_id,
    p_idempotency_key => p_idempotency_key);

  RETURN jsonb_build_object('ok', TRUE, 'idempotent', FALSE,
    'document_type', p_document_type, 'document_id', p_document_id,
    'status', 'draft', 'line_count', line_count,
    'voucher', v_voucher_result,
    'idempotency_key', p_idempotency_key);
END;
$function$


REVOKE ALL ON FUNCTION public.post_production_document(TEXT, INTEGER, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reverse_production_document(TEXT, INTEGER, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.post_production_document(TEXT, INTEGER, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reverse_production_document(TEXT, INTEGER, UUID) TO authenticated;
