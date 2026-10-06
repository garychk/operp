-- ============================================================================
-- P2-10：委外/外协 过账 RPC（发料 / 入库 / 反过账 / 结算确认 / BOM 展开）
-- ============================================================================
--
-- 表结构与配置在 deploy_102。本文件是委外**唯一的业务逻辑入口**。
--
-- 提供的对象
-- ----------
--   build_subcontract_order_materials   按 BOM 展开生成/重建应发料明细
--   post_subcontract_document           subcontract_issue / subcontract_receipt 过账
--   reverse_subcontract_document        上述两种单据的反过账
--   confirm_subcontract_settlement      委外结算确认（对账差异单列，不进库存/总账）
--
-- 同时修正两个上游对象（都只改函数体 / 视图定义，签名不变）
-- ------------------------------------------------------------
--   ① inventory_voucher_plan —— 补 3 条委外交易类型的科目兜底。
--      ⚠️ 本函数在 deploy_87 里首次定义，**本文件是它的最新定义**。
--         因为它是「未配映射时的内置兜底」，新租户（没有 erp_inventory_subject_map 行）
--         完全依赖这里；漏掉委外三种类型会导致委外过账**静默不生成凭证**。
--         deploy_87 在运行顺序上早于本文件，整包重跑不会互相覆盖。
--   ② vw_erp_inventory_summary —— in_amount / out_amount 由「按数量符号」改为
--      「按金额符号」判定。原因见下。
--
-- 为什么必须改 vw_erp_inventory_summary
-- -------------------------------------
--   委外入库会额外写一条 `quantity = 0`、`total_cost = 加工费` 的金额腿（见 deploy_102 头注）。
--   原视图 `SUM(CASE WHEN quantity > 0 THEN ABS(total_cost) ELSE 0 END)` 会把这条腿漏掉，
--   于是「收发存汇总的收入金额」比库存表少一个加工费 → 期末金额对不上。
--   改为按 total_cost 符号判定后，普通入库/出库的口径完全不变
--   （正常流水里数量符号与金额符号一致），只是把纯金额腿正确地算进收入。
--
-- 库存与预占
-- ----------
--   * 所有库存行变更一律经 `inventory_apply_move()`，不直接 UPDATE erp_inventory。
--   * 发料（出库）**先消耗预占、再扣库存**（顺序反了会误判超发）。
--   * 入库落到哪个状态沿用 `inventory_receipt_stock_status()` —— 委外交回的成品
--     和采购到货一样需要质检，共用「入库即待检」开关。
--
-- 校验口径（哪些抛错、哪些只是警告）
-- ----------------------------------
--   抛错（真数据问题）：单据不存在 / 状态不允许 / 无明细 / 数量非正 /
--                       物料为空 / 库位不属于该仓库 / 入库物料与订单成品不一致 /
--                       重复过账（已有活跃流水）/ 超发到负库存（由 apply_move 兜底）
--   警告（业务判断，不阻断）：超过应发量、超过订单数量、应发料未核销（缺口）
--     这些都会以 `warnings` 数组回传，前端提示但不拦。
--
-- 本脚本由 000_run_all 用 psql --single-transaction 执行，**不要写 BEGIN/COMMIT**。
-- 依赖：deploy_102（委外表与配置）、deploy_93（过账骨架）、deploy_88（唯一入口/预占）、
--       deploy_87（凭证助手）、deploy_96（报表视图）。
-- ============================================================================


-- ============================================================================
-- 1. 修正 inventory_voucher_plan：补委外交易类型的科目兜底
--    （本文件是该函数的最新定义；签名与返回值与 deploy_87 完全一致）
-- ============================================================================
CREATE OR REPLACE FUNCTION public.inventory_voucher_plan(
    p_source_type           TEXT,
    p_transaction_type_code TEXT,
    p_tenant_id             BIGINT
) RETURNS TABLE (
    stock_subject_code   TEXT,
    counter_subject_code TEXT,
    generate_voucher     BOOLEAN
)
LANGUAGE plpgsql STABLE
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_stock   TEXT;
  v_counter TEXT;
  v_gen     BOOLEAN;
BEGIN
  -- ① 租户配置
  SELECT m.stock_subject_code, m.counter_subject_code, m.generate_voucher
    INTO v_stock, v_counter, v_gen
    FROM public.erp_inventory_subject_map_s_539dcf81_b m
   WHERE m.is_deleted = 'n'
     AND m.source_type = p_source_type
     AND m.transaction_type_code = p_transaction_type_code
     AND (p_tenant_id IS NULL OR m.tenant_id = p_tenant_id)
   ORDER BY m.id
   LIMIT 1;

  IF FOUND THEN
    RETURN QUERY SELECT v_stock, v_counter, COALESCE(v_gen, TRUE);
    RETURN;
  END IF;

  -- ② 内置兜底：企业会计准则常用科目。映射表为空（新租户、老环境）也能出凭证。
  IF p_transaction_type_code = 'purchase_receipt_in' THEN
    RETURN QUERY SELECT '1405'::TEXT, '2202'::TEXT, TRUE;
  ELSIF p_transaction_type_code = 'sales_delivery_out' THEN
    RETURN QUERY SELECT '1405'::TEXT, '6401'::TEXT, TRUE;
  ELSIF p_transaction_type_code = 'material_issue_out' THEN
    RETURN QUERY SELECT '1403'::TEXT, '5001'::TEXT, TRUE;
  ELSIF p_transaction_type_code = 'material_return_in' THEN
    RETURN QUERY SELECT '1403'::TEXT, '5001'::TEXT, TRUE;
  ELSIF p_transaction_type_code = 'production_receipt_in' THEN
    RETURN QUERY SELECT '1405'::TEXT, '5001'::TEXT, TRUE;
  ELSIF p_transaction_type_code = 'stock_count_increase' THEN
    RETURN QUERY SELECT '1405'::TEXT, '1901'::TEXT, TRUE;
  ELSIF p_transaction_type_code = 'stock_count_decrease' THEN
    RETURN QUERY SELECT '1405'::TEXT, '1901'::TEXT, TRUE;
  ELSIF p_transaction_type_code = 'stock_adjust_in' THEN
    RETURN QUERY SELECT '1405'::TEXT, '1901'::TEXT, TRUE;
  ELSIF p_transaction_type_code = 'stock_adjust_out' THEN
    RETURN QUERY SELECT '1405'::TEXT, '1901'::TEXT, TRUE;
  -- ---- 委外（deploy_102 起的三种交易类型）----------------------------------
  -- 发料是出库：净额为负 → 借 counter(1408 委托加工物资) / 贷 stock(1403 原材料)
  ELSIF p_transaction_type_code = 'subcontract_issue_out' THEN
    RETURN QUERY SELECT '1403'::TEXT, '1408'::TEXT, TRUE;
  -- 入库材料腿：净额为正 → 借 stock(1405 库存商品) / 贷 counter(1408 委托加工物资)
  ELSIF p_transaction_type_code = 'subcontract_receipt_in' THEN
    RETURN QUERY SELECT '1405'::TEXT, '1408'::TEXT, TRUE;
  -- 加工费金额腿：净额为正 → 借 stock(1405 库存商品) / 贷 counter(2202 应付账款)
  ELSIF p_transaction_type_code = 'subcontract_fee_in' THEN
    RETURN QUERY SELECT '1405'::TEXT, '2202'::TEXT, TRUE;
  END IF;

  -- ③ 其余（内部调拨两条腿、领料/退料以外的中立类型）一律不进总账
  RETURN QUERY SELECT NULL::TEXT, NULL::TEXT, FALSE;
END;
$function$;


-- ============================================================================
-- 2. 修正 vw_erp_inventory_summary：金额按符号判定，别漏掉 quantity = 0 的金额腿
-- ============================================================================
CREATE OR REPLACE VIEW public.vw_erp_inventory_summary
  WITH (security_invoker = true) AS
WITH monthly AS (
  SELECT t.tenant_id,
         t.product_id,
         t.warehouse_id,
         date_trunc('month', t.transaction_date)::date AS period_start,
         SUM(CASE WHEN t.quantity > 0 THEN t.quantity ELSE 0 END)  AS in_qty,
         SUM(CASE WHEN t.quantity < 0 THEN -t.quantity ELSE 0 END) AS out_qty,
         -- 金额按**金额符号**判定而不是数量符号：委外加工费是 quantity = 0 的纯金额腿，
         -- 用数量判定会被漏掉，导致期末金额与库存表差一个加工费。
         SUM(CASE WHEN t.total_cost > 0 THEN t.total_cost ELSE 0 END)  AS in_amount,
         SUM(CASE WHEN t.total_cost < 0 THEN -t.total_cost ELSE 0 END) AS out_amount,
         COUNT(*) AS txn_count
    FROM public.erp_inventory_transactions_s_539dcf81_b t
   WHERE t.is_deleted = 'n'
   GROUP BY t.tenant_id, t.product_id, t.warehouse_id,
            date_trunc('month', t.transaction_date)
)
SELECT c.tenant_id,
       c.period_start,
       EXTRACT(YEAR  FROM c.period_start)::INTEGER AS period_year,
       EXTRACT(MONTH FROM c.period_start)::INTEGER AS period_month,
       c.product_id,
       p.code AS product_code,
       p.name AS product_name,
       p.unit,
       c.warehouse_id,
       w.code AS warehouse_code,
       w.name AS warehouse_name,
       -- 期初 = 本行之前所有月份的净额累计
       COALESCE(SUM(c.in_qty - c.out_qty) OVER (
         PARTITION BY c.tenant_id, c.product_id, c.warehouse_id
         ORDER BY c.period_start
         ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS opening_qty,
       COALESCE(SUM(c.in_amount - c.out_amount) OVER (
         PARTITION BY c.tenant_id, c.product_id, c.warehouse_id
         ORDER BY c.period_start
         ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS opening_amount,
       c.in_qty,
       c.in_amount,
       c.out_qty,
       c.out_amount,
       -- 期末 = 期初 + 收 - 发
       COALESCE(SUM(c.in_qty - c.out_qty) OVER (
         PARTITION BY c.tenant_id, c.product_id, c.warehouse_id
         ORDER BY c.period_start
         ROWS UNBOUNDED PRECEDING), 0) AS closing_qty,
       COALESCE(SUM(c.in_amount - c.out_amount) OVER (
         PARTITION BY c.tenant_id, c.product_id, c.warehouse_id
         ORDER BY c.period_start
         ROWS UNBOUNDED PRECEDING), 0) AS closing_amount,
       c.txn_count
  FROM monthly c
  LEFT JOIN public.erp_products_s_539dcf81_b   p ON p.id = c.product_id   AND p.tenant_id = c.tenant_id
  LEFT JOIN public.erp_warehouses_s_539dcf81_b w ON w.id = c.warehouse_id AND w.tenant_id = c.tenant_id;


-- ============================================================================
-- 3. 委外订单 · 按 BOM 展开生成应发料
-- ============================================================================
-- 幂等：
--   * p_replace = FALSE 且已有明细 → skipped(already_built)，不动任何数据
--   * p_replace = TRUE  且已有明细已发生发料 → **抛错**（重建会打断 issued/consumed 跟踪）
-- 无 BOM → skipped(no_bom) 且不建明细。委外「客供料/无料加工」是合法场景，
-- 此时应发料为空、入库时核销金额为 0，链路照常走通。
CREATE OR REPLACE FUNCTION public.build_subcontract_order_materials(
  p_order_id  INTEGER,
  p_tenant_id BIGINT  DEFAULT NULL,
  p_replace   BOOLEAN DEFAULT FALSE
) RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
DECLARE
  o RECORD;
  v_bom_id  INTEGER;
  v_bom_qty NUMERIC;
  v_ratio   NUMERIC;
  v_existing INTEGER;
  v_dirty    INTEGER;
  v_lines    INTEGER := 0;
  v_amount   NUMERIC := 0;
BEGIN
  IF p_order_id IS NULL OR p_order_id <= 0 THEN
    RAISE EXCEPTION 'A positive order ID is required' USING ERRCODE = '22023';
  END IF;

  SELECT x.* INTO o
    FROM public.erp_subcontract_orders_s_539dcf81_b x
   WHERE x.id = p_order_id
     AND (p_tenant_id IS NULL OR x.tenant_id = p_tenant_id)
     AND x.is_deleted = 'n'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Subcontract order does not exist or is deleted'
      USING ERRCODE = 'P0002';
  END IF;
  IF COALESCE(o.status, '') IN ('cancelled', 'closed') THEN
    RAISE EXCEPTION 'Order % is %, cannot build materials',
      o.order_no, o.status USING ERRCODE = '55000';
  END IF;

  SELECT count(*) INTO v_existing
    FROM public.erp_subcontract_order_details_s_539dcf81_b d
   WHERE d.order_id = p_order_id AND d.is_deleted = 'n';

  IF v_existing > 0 THEN
    IF NOT p_replace THEN
      RETURN jsonb_build_object('ok', TRUE, 'skipped', TRUE,
        'reason', 'already_built', 'line_count', v_existing);
    END IF;
    SELECT count(*) INTO v_dirty
      FROM public.erp_subcontract_order_details_s_539dcf81_b d
     WHERE d.order_id = p_order_id AND d.is_deleted = 'n'
       AND COALESCE(d.issued_quantity, 0) > 0;
    IF v_dirty > 0 THEN
      RAISE EXCEPTION
        '订单 % 已有 % 条应发料发生过发料，重建会打断已发/已核销跟踪；请改用「追加」或先反过账发料单',
        o.order_no, v_dirty USING ERRCODE = '55000';
    END IF;
    UPDATE public.erp_subcontract_order_details_s_539dcf81_b
       SET is_deleted = 'y', updated_at = NOW()
     WHERE order_id = p_order_id AND is_deleted = 'n';
  END IF;

  -- 选 BOM：订单指定优先，否则取该物料的默认生效版本
  v_bom_id := o.bom_id;
  IF v_bom_id IS NOT NULL THEN
    SELECT b.quantity INTO v_bom_qty
      FROM public.erp_boms_s_539dcf81_b b
     WHERE b.id = v_bom_id AND b.tenant_id = o.tenant_id AND b.is_deleted = 'n';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'BOM % does not exist for tenant %', v_bom_id, o.tenant_id
        USING ERRCODE = 'P0002';
    END IF;
  ELSE
    SELECT b.id, b.quantity INTO v_bom_id, v_bom_qty
      FROM public.erp_boms_s_539dcf81_b b
     WHERE b.product_id = o.product_id
       AND b.tenant_id = o.tenant_id
       AND b.is_deleted = 'n'
       AND COALESCE(b.is_active, TRUE)
       AND (b.effective_date IS NULL OR b.effective_date <= o.order_date)
       AND (b.expiry_date   IS NULL OR b.expiry_date   >= o.order_date)
     ORDER BY b.is_default DESC NULLS LAST, b.id DESC
     LIMIT 1;
  END IF;

  IF v_bom_id IS NULL THEN
    RETURN jsonb_build_object('ok', TRUE, 'skipped', TRUE,
      'reason', 'no_bom', 'product_id', o.product_id,
      'hint', '该物料没有生效 BOM（客供料/无料加工属正常），入库时将不核销材料成本');
  END IF;

  -- 应发量 = BOM 单位用量 × (订单量 ÷ BOM 基准量) × (1 + 损耗率)
  v_ratio := CASE WHEN COALESCE(v_bom_qty, 0) <> 0
                  THEN COALESCE(o.quantity, 0) / v_bom_qty
                  ELSE 0 END;

  INSERT INTO public.erp_subcontract_order_details_s_539dcf81_b (
    corp_id, emp_id, is_deleted, order_id, line_no, material_id,
    required_quantity, issued_quantity, issued_amount,
    consumed_quantity, consumed_amount, unit_cost, remark, tenant_id
  )
  SELECT o.corp_id, o.emp_id, 'n', p_order_id, bd.line_no, bd.material_id,
         ROUND(bd.quantity * v_ratio * (1 + COALESCE(bd.loss_rate, 0)), 6),
         0, 0, 0, 0,
         COALESCE(NULLIF(p.cost_price, 0), NULLIF(p.purchase_price, 0), 0),
         bd.remark, o.tenant_id
    FROM public.erp_bom_details_s_539dcf81_b bd
    LEFT JOIN public.erp_products_s_539dcf81_b p
      ON p.id = bd.material_id AND p.tenant_id = o.tenant_id
   WHERE bd.bom_id = v_bom_id AND bd.is_deleted = 'n'
     AND COALESCE(bd.quantity, 0) <> 0;

  GET DIAGNOSTICS v_lines = ROW_COUNT;

  SELECT COALESCE(SUM(required_quantity * unit_cost), 0) INTO v_amount
    FROM public.erp_subcontract_order_details_s_539dcf81_b
   WHERE order_id = p_order_id AND is_deleted = 'n';

  RETURN jsonb_build_object('ok', TRUE, 'skipped', FALSE,
    'order_id', p_order_id, 'bom_id', v_bom_id,
    'line_count', v_lines, 'estimated_material_cost', ROUND(v_amount, 2),
    'ratio', v_ratio);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.build_subcontract_order_materials(INTEGER, BIGINT, BOOLEAN) TO authenticated;


-- ============================================================================
-- 4. 委外发料 / 委外入库 过账
-- ============================================================================
CREATE OR REPLACE FUNCTION public.post_subcontract_document(
  p_document_type   TEXT,
  p_document_id     INTEGER,
  p_idempotency_key UUID
) RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
DECLARE
  h RECORD; d RECORD; o RECORD;
  actor_id INTEGER; line_count INTEGER := 0;
  normalized_batch TEXT; v_location_id INTEGER; v_transaction_no TEXT;
  allow_negative BOOLEAN;
  v_is_issue BOOLEAN;
  v_inv_unit_cost NUMERIC; v_unit_cost NUMERIC; v_move JSONB; v_consumed NUMERIC;
  v_total_cost NUMERIC := 0;
  v_total_qty NUMERIC := 0;
  v_target_status TEXT;
  v_fee BOOLEAN := FALSE;
  v_voucher_result JSONB;
  v_warnings JSONB := '[]'::JSONB;
  -- 入库核销
  v_material_cost NUMERIC := 0;
  v_shortfall NUMERIC := 0;
  v_need NUMERIC; v_avail NUMERIC; v_take NUMERIC; v_detail_unit NUMERIC;
  v_receipt_unit_cost NUMERIC;
  v_leg_cost NUMERIC;
  v_receipt_total NUMERIC;
  v_exchange_rate NUMERIC;
  v_consumed_lines JSONB := '[]'::JSONB;
BEGIN
  IF p_document_type NOT IN ('subcontract_issue', 'subcontract_receipt') THEN
    RAISE EXCEPTION 'Unsupported subcontract document type: %', p_document_type
      USING ERRCODE = '22023';
  END IF;
  IF p_document_id IS NULL OR p_document_id <= 0 OR p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'A positive document ID and idempotency key are required'
      USING ERRCODE = '22023';
  END IF;
  actor_id := public.current_sys_user_id();
  v_is_issue := (p_document_type = 'subcontract_issue');

  IF v_is_issue THEN
    SELECT x.id, x.issue_no AS document_no, x.issue_date AS document_date,
           x.warehouse_id, x.location_id AS header_location_id, x.order_id,
           x.supplier_id, x.status, x.corp_id, x.posting_idempotency_key, x.tenant_id
      INTO h FROM public.erp_subcontract_issues_s_539dcf81_b x
     WHERE x.id = p_document_id AND x.is_deleted = 'n' FOR UPDATE;
  ELSE
    SELECT x.id, x.receipt_no AS document_no, x.receipt_date AS document_date,
           x.warehouse_id, x.location_id AS header_location_id, x.order_id,
           x.supplier_id, x.status, x.corp_id, x.posting_idempotency_key, x.tenant_id,
           x.product_id, x.quantity, x.processing_fee, x.currency, x.exchange_rate,
           x.batch_no, x.expiry_date
      INTO h FROM public.erp_subcontract_receipts_s_539dcf81_b x
     WHERE x.id = p_document_id AND x.is_deleted = 'n' FOR UPDATE;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Subcontract document does not exist or is deleted'
      USING ERRCODE = 'P0002';
  END IF;
  IF h.status = 'posted' AND h.posting_idempotency_key = p_idempotency_key THEN
    RETURN jsonb_build_object('ok', TRUE, 'idempotent', TRUE,
      'document_type', p_document_type, 'document_id', p_document_id, 'status', 'posted');
  END IF;
  IF COALESCE(h.status, '') NOT IN ('draft', 'approved') THEN
    RAISE EXCEPTION 'Only draft or approved documents can be posted; current status: %',
      COALESCE(h.status, '<null>') USING ERRCODE = '55000';
  END IF;
  IF h.warehouse_id IS NULL THEN
    RAISE EXCEPTION 'Subcontract document has no warehouse' USING ERRCODE = '23502';
  END IF;
  -- 双保险：主表状态没置 posted 但流水已存在（例如手工改回 draft）一律拒绝
  IF EXISTS (
    SELECT 1 FROM public.erp_inventory_transactions_s_539dcf81_b t
     WHERE t.reference_type = p_document_type
       AND t.reference_id = p_document_id AND t.is_deleted = 'n'
  ) THEN
    RAISE EXCEPTION 'Document already has active inventory transactions'
      USING ERRCODE = '23505';
  END IF;

  -- 订单校验（有订单时）：租户必须一致，否则就是跨租户串单
  IF h.order_id IS NOT NULL THEN
    SELECT x.id, x.order_no, x.status, x.quantity, x.product_id,
           x.issued_quantity, x.received_quantity, x.tenant_id
      INTO o FROM public.erp_subcontract_orders_s_539dcf81_b x
     WHERE x.id = h.order_id AND x.is_deleted = 'n' FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Subcontract order % does not exist or is deleted', h.order_id
        USING ERRCODE = 'P0002';
    END IF;
    IF o.tenant_id <> h.tenant_id THEN
      RAISE EXCEPTION 'Order % belongs to another tenant', o.order_no
        USING ERRCODE = '42501';
    END IF;
    IF COALESCE(o.status, '') IN ('cancelled', 'closed') THEN
      RAISE EXCEPTION 'Order % is %, cannot post against it', o.order_no, o.status
        USING ERRCODE = '55000';
    END IF;
    -- 注意：h 是 RECORD，发料分支的 SELECT 里没有 product_id 字段。
    -- 这里必须嵌套一层 IF，让引用 h.product_id 的语句只在入库分支才被解析/执行，
    -- 否则发料过账时会报 42703 record "h" has no field "product_id"。
    IF NOT v_is_issue THEN
      IF o.product_id IS DISTINCT FROM h.product_id THEN
        RAISE EXCEPTION
          '入库物料 % 与订单 % 的成品 % 不一致', h.product_id, o.order_no, o.product_id
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;

  SELECT COALESCE(w.is_negative_stock_allowed, FALSE)
    INTO allow_negative FROM public.erp_warehouses_s_539dcf81_b w
   WHERE w.id = h.warehouse_id AND w.is_deleted = 'n' FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Warehouse does not exist or is deleted' USING ERRCODE = 'P0002';
  END IF;

  -- ==========================================================================
  -- 4.1 委外发料：出库
  -- ==========================================================================
  IF v_is_issue THEN
    PERFORM x.id FROM public.erp_subcontract_issue_details_s_539dcf81_b x
     WHERE x.issue_id = p_document_id AND x.is_deleted = 'n' ORDER BY x.id FOR UPDATE;

    FOR d IN
      SELECT x.id AS detail_id, x.order_detail_id, x.material_id AS product_id,
             x.quantity, x.unit_cost AS document_unit_cost,
             COALESCE(NULLIF(p.cost_price, 0), NULLIF(p.purchase_price, 0), 0) AS product_unit_cost,
             NULLIF(BTRIM(x.batch_no), '') AS batch_no,
             x.location_id AS detail_location_id
        FROM public.erp_subcontract_issue_details_s_539dcf81_b x
        LEFT JOIN public.erp_products_s_539dcf81_b p ON p.id = x.material_id
       WHERE x.issue_id = p_document_id AND x.is_deleted = 'n'
       ORDER BY x.material_id, x.id
    LOOP
      line_count := line_count + 1;
      IF d.product_id IS NULL OR d.quantity IS NULL OR d.quantity <= 0 THEN
        RAISE EXCEPTION 'Detail % has no product or non-positive quantity', d.detail_id
          USING ERRCODE = '23514';
      END IF;
      normalized_batch := NULLIF(BTRIM(d.batch_no), '');
      v_location_id := COALESCE(d.detail_location_id, h.header_location_id);

      IF v_location_id IS NOT NULL THEN
        PERFORM 1 FROM public.erp_bins_s_539dcf81_b b
         WHERE b.id = v_location_id AND b.warehouse_id = h.warehouse_id
           AND b.tenant_id = h.tenant_id AND b.is_deleted = 'n';
        IF NOT FOUND THEN
          RAISE EXCEPTION 'Location % is not valid for warehouse %', v_location_id, h.warehouse_id
            USING ERRCODE = '23503';
        END IF;
      END IF;

      v_inv_unit_cost := COALESCE((
        SELECT x.unit_cost FROM public.erp_inventory_s_539dcf81_b x
         WHERE x.product_id = d.product_id AND x.warehouse_id = h.warehouse_id
           AND x.tenant_id = h.tenant_id
           AND COALESCE(x.location_id, 0) = COALESCE(v_location_id, 0)
           AND COALESCE(NULLIF(BTRIM(x.batch_no), ''), '') = COALESCE(normalized_batch, '')
           AND x.stock_status = 'available' AND x.is_deleted = 'n'), 0);

      v_unit_cost := COALESCE(NULLIF(v_inv_unit_cost, 0),
        NULLIF(d.document_unit_cost, 0), NULLIF(d.product_unit_cost, 0), 0);

      -- 出库先消耗预占，再扣库存（顺序反了会误判超发）
      v_consumed := public.inventory_consume_reservations(
        h.tenant_id, d.product_id, h.warehouse_id, v_location_id,
        normalized_batch, 'available', d.quantity);

      v_move := public.inventory_apply_move(
        p_tenant_id      => h.tenant_id,
        p_corp_id        => h.corp_id,
        p_actor_id       => actor_id,
        p_product_id     => d.product_id,
        p_warehouse_id   => h.warehouse_id,
        p_location_id    => v_location_id,
        p_batch_no       => normalized_batch,
        p_stock_status   => 'available',
        p_qty_delta      => -d.quantity,
        p_unit_cost      => v_unit_cost,
        p_cost_delta     => NULL,
        p_expiry_date    => NULL,
        p_allow_negative => allow_negative);
      v_unit_cost := COALESCE((v_move ->> 'unit_cost')::NUMERIC, v_unit_cost);
      v_leg_cost  := ABS(COALESCE((v_move ->> 'cost_delta')::NUMERIC, 0));

      v_transaction_no := 'IT' || TO_CHAR(clock_timestamp(), 'YYYYMMDDHH24MISSMS')
        || LPAD(d.detail_id::TEXT, 6, '0');
      INSERT INTO public.erp_inventory_transactions_s_539dcf81_b (
        corp_id, emp_id, is_deleted, transaction_no, transaction_type,
        transaction_date, product_id, warehouse_id, location_id, batch_no,
        stock_status, quantity, unit_cost, total_cost, reference_type, reference_id,
        reference_detail_id, posting_idempotency_key, remark, tenant_id
      ) VALUES (
        h.corp_id, actor_id::TEXT, 'n', LEFT(v_transaction_no, 50),
        public.resolve_inventory_transaction_type(p_document_type, 'out'),
        h.document_date, d.product_id, h.warehouse_id, v_location_id,
        normalized_batch, 'available', -d.quantity, v_unit_cost, -v_leg_cost,
        p_document_type, p_document_id, d.detail_id, p_idempotency_key,
        format('委外发料 %s 过账', h.document_no), h.tenant_id);

      v_total_cost := v_total_cost + v_leg_cost;
      v_total_qty  := v_total_qty + d.quantity;

      -- 回写应发料明细的「已发」跟踪
      IF d.order_detail_id IS NOT NULL THEN
        UPDATE public.erp_subcontract_order_details_s_539dcf81_b
           SET issued_quantity = COALESCE(issued_quantity, 0) + d.quantity,
               issued_amount   = COALESCE(issued_amount, 0) + v_leg_cost,
               unit_cost = CASE
                 WHEN COALESCE(issued_quantity, 0) + d.quantity <> 0
                 THEN (COALESCE(issued_amount, 0) + v_leg_cost)
                      / (COALESCE(issued_quantity, 0) + d.quantity)
                 ELSE unit_cost END,
               updated_at = NOW()
         WHERE id = d.order_detail_id AND order_id = h.order_id AND is_deleted = 'n';
        IF NOT FOUND THEN
          RAISE EXCEPTION
            'Issue detail % references order material % which does not belong to order %',
            d.detail_id, d.order_detail_id, h.order_id USING ERRCODE = '23503';
        END IF;

        -- 超发只是业务判断，不阻断，但必须让用户看见
        IF EXISTS (
          SELECT 1 FROM public.erp_subcontract_order_details_s_539dcf81_b x
           WHERE x.id = d.order_detail_id
             AND COALESCE(x.issued_quantity, 0) > COALESCE(x.required_quantity, 0)
             AND COALESCE(x.required_quantity, 0) > 0
        ) THEN
          v_warnings := v_warnings || jsonb_build_object(
            'code', 'over_issued', 'order_detail_id', d.order_detail_id,
            'material_id', d.product_id);
        END IF;
      ELSIF h.order_id IS NOT NULL THEN
        -- 有订单但这一行没挂应发料：可能是「客供料 / 临时补料」，属业务判断不阻断，
        -- 但**必须**提示 —— 否则这条发料不会计入订单进度，用户会以为跟踪丢了。
        v_warnings := v_warnings || jsonb_build_object(
          'code', 'unlinked_material', 'line_no', d.detail_id, 'material_id', d.product_id);
      END IF;
    END LOOP;

    IF line_count = 0 THEN
      RAISE EXCEPTION 'Subcontract issue has no active details' USING ERRCODE = '23514';
    END IF;

    UPDATE public.erp_subcontract_issues_s_539dcf81_b
       SET total_cost = v_total_cost,
           status = 'posted', posting_idempotency_key = p_idempotency_key,
           reversal_idempotency_key = NULL, posted_at = NOW(), reversed_at = NULL,
           updated_at = NOW()
     WHERE id = p_document_id;

    -- 订单「已发量」**派生自应发料明细**，而不是本次发料的原始合计：
    -- 未挂应发料的临时补料不该计入订单进度，而且派生值天然与明细一致，
    -- 反过账时也不用再维护一份容易漂移的累加值。
    IF h.order_id IS NOT NULL THEN
      -- 别名不能叫 o / d / h / t —— 这些是 PL/pgSQL 里已声明的 RECORD 变量，
      -- 限定名 o.id 会被判成「既像变量又像列」而报 42702 ambiguous。
      UPDATE public.erp_subcontract_orders_s_539dcf81_b sco
         SET issued_quantity = (
               SELECT COALESCE(SUM(sd.issued_quantity), 0)
                 FROM public.erp_subcontract_order_details_s_539dcf81_b sd
                WHERE sd.order_id = sco.id AND sd.is_deleted = 'n'),
             status = CASE WHEN COALESCE(sco.status, '') IN ('draft', 'approved', 'released')
                           THEN 'in_progress' ELSE sco.status END,
             updated_at = NOW()
       WHERE sco.id = h.order_id;
    END IF;

    v_voucher_result := public.inventory_sync_voucher(
      p_source_type   => p_document_type,
      p_source_id     => p_document_id,
      p_document_no   => h.document_no,
      p_document_date => h.document_date,
      p_tenant_id     => h.tenant_id,
      p_remark        => format('委外发料 %s', h.document_no));

    RETURN jsonb_build_object('ok', TRUE, 'idempotent', FALSE,
      'document_type', p_document_type, 'document_id', p_document_id,
      'status', 'posted', 'line_count', line_count,
      'total_quantity', ROUND(v_total_qty, 6),
      'total_cost', ROUND(v_total_cost, 2),
      'voucher', v_voucher_result, 'warnings', v_warnings,
      'idempotency_key', p_idempotency_key);
  END IF;

  -- ==========================================================================
  -- 4.2 委外入库：核销应发料 + 成品入库 + 确认加工费
  -- ==========================================================================
  IF h.quantity IS NULL OR h.quantity <= 0 THEN
    RAISE EXCEPTION 'Receipt % has non-positive quantity', h.document_no
      USING ERRCODE = '23514';
  END IF;
  IF h.product_id IS NULL THEN
    RAISE EXCEPTION 'Receipt % has no product', h.document_no USING ERRCODE = '23502';
  END IF;

  normalized_batch := NULLIF(BTRIM(h.batch_no), '');
  v_location_id := h.header_location_id;
  IF v_location_id IS NOT NULL THEN
    PERFORM 1 FROM public.erp_bins_s_539dcf81_b b
     WHERE b.id = v_location_id AND b.warehouse_id = h.warehouse_id
       AND b.tenant_id = h.tenant_id AND b.is_deleted = 'n';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Location % is not valid for warehouse %', v_location_id, h.warehouse_id
        USING ERRCODE = '23503';
    END IF;
  END IF;

  -- 核销：按订单应发料的「单位用量比例 × 本次入库数量」倒扣，上限是「已发未核销」
  IF h.order_id IS NOT NULL THEN
    FOR d IN
      SELECT x.id, x.material_id, x.required_quantity, x.issued_quantity,
             x.issued_amount, x.consumed_quantity, x.unit_cost
        FROM public.erp_subcontract_order_details_s_539dcf81_b x
       WHERE x.order_id = h.order_id AND x.is_deleted = 'n'
       ORDER BY x.line_no, x.id
       FOR UPDATE
    LOOP
      v_need := CASE WHEN COALESCE(o.quantity, 0) <> 0
                     THEN COALESCE(d.required_quantity, 0) / o.quantity * h.quantity
                     ELSE 0 END;
      CONTINUE WHEN v_need <= 0;

      v_avail := GREATEST(COALESCE(d.issued_quantity, 0) - COALESCE(d.consumed_quantity, 0), 0);
      v_take  := LEAST(v_need, v_avail);
      v_shortfall := v_shortfall + (v_need - v_take);
      CONTINUE WHEN v_take <= 0;

      v_detail_unit := CASE WHEN COALESCE(d.issued_quantity, 0) <> 0
                            THEN COALESCE(d.issued_amount, 0) / d.issued_quantity
                            ELSE COALESCE(d.unit_cost, 0) END;

      UPDATE public.erp_subcontract_order_details_s_539dcf81_b
         SET consumed_quantity = COALESCE(consumed_quantity, 0) + v_take,
             consumed_amount   = COALESCE(consumed_amount, 0) + v_take * v_detail_unit,
             updated_at = NOW()
       WHERE id = d.id;

      v_material_cost := v_material_cost + v_take * v_detail_unit;
      -- 落库逐条核销明细：反过账要按原样退回，重算会因订单量变更 / 多次入库而漂移
      v_consumed_lines := v_consumed_lines || jsonb_build_object(
        'order_detail_id', d.id,
        'material_id', d.material_id,
        'quantity', v_take,
        'unit_cost', v_detail_unit,
        'amount', v_take * v_detail_unit);
    END LOOP;
  END IF;

  IF v_shortfall > 0 THEN
    v_warnings := v_warnings || jsonb_build_object(
      'code', 'material_shortfall', 'quantity', ROUND(v_shortfall, 6));
  END IF;

  -- 成本：材料成本 + 加工费，一起进库存行（账实一致）
  v_receipt_total := v_material_cost + COALESCE(h.processing_fee, 0);
  v_receipt_unit_cost := CASE WHEN h.quantity <> 0 THEN v_receipt_total / h.quantity ELSE 0 END;

  v_target_status := public.inventory_receipt_stock_status(h.tenant_id);

  v_move := public.inventory_apply_move(
    p_tenant_id      => h.tenant_id,
    p_corp_id        => h.corp_id,
    p_actor_id       => actor_id,
    p_product_id     => h.product_id,
    p_warehouse_id   => h.warehouse_id,
    p_location_id    => v_location_id,
    p_batch_no       => normalized_batch,
    p_stock_status   => v_target_status,
    p_qty_delta      => h.quantity,
    p_unit_cost      => v_receipt_unit_cost,
    p_cost_delta     => NULL,
    p_expiry_date    => h.expiry_date,
    p_allow_negative => allow_negative);
  v_receipt_unit_cost := COALESCE((v_move ->> 'unit_cost')::NUMERIC, v_receipt_unit_cost);

  -- 腿 1：材料成本（数量 +N）
  v_transaction_no := 'IT' || TO_CHAR(clock_timestamp(), 'YYYYMMDDHH24MISSMS')
    || LPAD(p_document_id::TEXT, 6, '0') || 'M';
  INSERT INTO public.erp_inventory_transactions_s_539dcf81_b (
    corp_id, emp_id, is_deleted, transaction_no, transaction_type,
    transaction_date, product_id, warehouse_id, location_id, batch_no,
    stock_status, quantity, unit_cost, total_cost, reference_type, reference_id,
    reference_detail_id, posting_idempotency_key, remark, tenant_id
  ) VALUES (
    h.corp_id, actor_id::TEXT, 'n', LEFT(v_transaction_no, 50),
    'subcontract_receipt_in',
    h.document_date, h.product_id, h.warehouse_id, v_location_id,
    normalized_batch, v_target_status, h.quantity,
    CASE WHEN h.quantity <> 0 THEN v_material_cost / h.quantity ELSE 0 END,
    v_material_cost,
    p_document_type, p_document_id, NULL, p_idempotency_key,
    format('委外入库 %s 材料成本', h.document_no), h.tenant_id);

  -- 腿 2：加工费（数量 0、纯金额）—— 单独一条 transaction_type 让凭证多出「贷 应付账款」一行
  IF COALESCE(h.processing_fee, 0) <> 0 THEN
    v_transaction_no := 'IT' || TO_CHAR(clock_timestamp(), 'YYYYMMDDHH24MISSMS')
      || LPAD(p_document_id::TEXT, 6, '0') || 'F';
    INSERT INTO public.erp_inventory_transactions_s_539dcf81_b (
      corp_id, emp_id, is_deleted, transaction_no, transaction_type,
      transaction_date, product_id, warehouse_id, location_id, batch_no,
      stock_status, quantity, unit_cost, total_cost, reference_type, reference_id,
      reference_detail_id, posting_idempotency_key, remark, tenant_id
    ) VALUES (
      h.corp_id, actor_id::TEXT, 'n', LEFT(v_transaction_no, 50),
      'subcontract_fee_in',
      h.document_date, h.product_id, h.warehouse_id, v_location_id,
      normalized_batch, v_target_status, 0, 0, h.processing_fee,
      p_document_type, p_document_id, NULL, p_idempotency_key,
      format('委外入库 %s 加工费', h.document_no), h.tenant_id);
    v_fee := TRUE;
    line_count := line_count + 1;
  END IF;
  line_count := line_count + 1;

  -- 外币口径与采购入库一致（deploy_93）：base_amount = 金额 × 汇率，四舍五入 2 位。
  -- 汇率缺失按 1 处理只在「币种就是本位币」时才是对的，所以取不到时宁可记 0 风险更低 ——
  -- 这里沿用付款侧约定：exchange_rate 为 0 / NULL 时取 1（单据本来就存了汇率，不查表）。
  v_exchange_rate := COALESCE(NULLIF(h.exchange_rate, 0), 1);

  UPDATE public.erp_subcontract_receipts_s_539dcf81_b
     SET material_cost = v_material_cost,
         consumed_materials = v_consumed_lines,
         total_cost    = v_receipt_total,
         unit_cost     = v_receipt_unit_cost,
         base_amount   = ROUND(v_receipt_total * v_exchange_rate, 2),
         status = 'posted', posting_idempotency_key = p_idempotency_key,
         reversal_idempotency_key = NULL, posted_at = NOW(), reversed_at = NULL,
         updated_at = NOW()
   WHERE id = p_document_id;

  IF h.order_id IS NOT NULL THEN
    UPDATE public.erp_subcontract_orders_s_539dcf81_b
       SET received_quantity = COALESCE(received_quantity, 0) + h.quantity,
           status = CASE
             WHEN COALESCE(received_quantity, 0) + h.quantity >= COALESCE(quantity, 0)
                  THEN 'completed'
             WHEN COALESCE(status, '') IN ('draft', 'approved', 'released')
                  THEN 'in_progress'
             ELSE status END,
           updated_at = NOW()
     WHERE id = h.order_id;

    IF EXISTS (
      SELECT 1 FROM public.erp_subcontract_orders_s_539dcf81_b x
       WHERE x.id = h.order_id AND COALESCE(x.received_quantity, 0) > COALESCE(x.quantity, 0)
    ) THEN
      v_warnings := v_warnings || jsonb_build_object('code', 'over_received');
    END IF;
  END IF;

  -- 应付：加工费挂供应商往来（与采购入库同构；金额为 0 时不建行）
  IF COALESCE(h.processing_fee, 0) > 0 THEN
    INSERT INTO public.erp_payables_s_539dcf81_b (
      corp_id, emp_id, is_deleted, supplier_id, doc_type, doc_no,
      source_type, source_id, source_no, doc_date, due_date, amount,
      paid_amount, balance, currency, exchange_rate, base_amount,
      base_paid_amount, base_balance, status, remark, tenant_id
    ) VALUES (
      h.corp_id, actor_id::TEXT, 'n', h.supplier_id, p_document_type, h.document_no,
      p_document_type, p_document_id, h.document_no, h.document_date, h.document_date,
      h.processing_fee, 0, h.processing_fee,
      COALESCE(h.currency, 'CNY'), v_exchange_rate,
      ROUND(h.processing_fee * v_exchange_rate, 2),
      0, ROUND(h.processing_fee * v_exchange_rate, 2), 'open',
      format('委外入库单 %s 加工费自动生成', h.document_no), h.tenant_id);
  END IF;

  v_voucher_result := public.inventory_sync_voucher(
    p_source_type   => p_document_type,
    p_source_id     => p_document_id,
    p_document_no   => h.document_no,
    p_document_date => h.document_date,
    p_tenant_id     => h.tenant_id,
    p_remark        => format('委外入库 %s', h.document_no));

  RETURN jsonb_build_object('ok', TRUE, 'idempotent', FALSE,
    'document_type', p_document_type, 'document_id', p_document_id,
    'status', 'posted', 'line_count', line_count,
    'stock_status', v_target_status,
    'material_cost', ROUND(v_material_cost, 2),
    'processing_fee', ROUND(COALESCE(h.processing_fee, 0), 2),
    'total_cost', ROUND(v_receipt_total, 2),
    'unit_cost', ROUND(v_receipt_unit_cost, 6),
    'material_shortfall', ROUND(v_shortfall, 6),
    'has_fee_leg', v_fee,
    'voucher', v_voucher_result, 'warnings', v_warnings,
    'idempotency_key', p_idempotency_key);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.post_subcontract_document(TEXT, INTEGER, UUID) TO authenticated;


-- ============================================================================
-- 5. 反过账
-- ============================================================================
CREATE OR REPLACE FUNCTION public.reverse_subcontract_document(
  p_document_type   TEXT,
  p_document_id     INTEGER,
  p_idempotency_key UUID
) RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
DECLARE
  h RECORD;
  t RECORD;
  actor_id INTEGER;
  line_count INTEGER := 0;
  v_target_status TEXT;
  v_move JSONB;
  v_total_cost NUMERIC := 0;
  v_qty NUMERIC := 0;
  v_voucher_result JSONB;
BEGIN
  IF p_document_type NOT IN ('subcontract_issue', 'subcontract_receipt') THEN
    RAISE EXCEPTION 'Unsupported subcontract document type: %', p_document_type
      USING ERRCODE = '22023';
  END IF;
  IF p_document_id IS NULL OR p_document_id <= 0 OR p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'A positive document ID and idempotency key are required'
      USING ERRCODE = '22023';
  END IF;
  actor_id := public.current_sys_user_id();

  IF p_document_type = 'subcontract_issue' THEN
    SELECT x.id, x.issue_no AS document_no, x.order_id, x.status,
           x.reversal_idempotency_key, x.tenant_id
      INTO h FROM public.erp_subcontract_issues_s_539dcf81_b x
     WHERE x.id = p_document_id AND x.is_deleted = 'n' FOR UPDATE;
  ELSE
    SELECT x.id, x.receipt_no AS document_no, x.order_id, x.status,
           x.reversal_idempotency_key, x.tenant_id
      INTO h FROM public.erp_subcontract_receipts_s_539dcf81_b x
     WHERE x.id = p_document_id AND x.is_deleted = 'n' FOR UPDATE;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Subcontract document does not exist or is deleted'
      USING ERRCODE = 'P0002';
  END IF;
  IF h.status = 'draft' AND h.reversal_idempotency_key = p_idempotency_key THEN
    RETURN jsonb_build_object('ok', TRUE, 'idempotent', TRUE,
      'document_type', p_document_type, 'document_id', p_document_id, 'status', 'draft');
  END IF;
  IF h.status <> 'posted' THEN
    RAISE EXCEPTION 'Only posted documents can be reversed; current status: %',
      COALESCE(h.status, '<null>') USING ERRCODE = '55000';
  END IF;

  -- 按流水行逐条反算。stock_status 必须带上 —— 同库位同批次可能有多行不同状态。
  -- 加工费腿 quantity = 0，反算时只把金额退回去，不影响数量。
  FOR t IN
    SELECT x.* FROM public.erp_inventory_transactions_s_539dcf81_b x
     WHERE x.reference_type = p_document_type
       AND x.reference_id = p_document_id
       AND x.tenant_id = h.tenant_id
       AND x.is_deleted = 'n'
     ORDER BY x.product_id, x.warehouse_id, COALESCE(x.location_id, 0),
              x.batch_no NULLS FIRST, COALESCE(x.stock_status, 'available'), x.id
     FOR UPDATE
  LOOP
    line_count := line_count + 1;
    v_target_status := COALESCE(NULLIF(BTRIM(t.stock_status), ''), 'available');
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

    -- 冲销发料会把库存加回来；这批货当初消耗的预占不恢复
    -- （预占在过账时已履行完毕，恢复会凭空占住库存）。
    IF p_document_type = 'subcontract_issue' THEN
      v_qty := v_qty + COALESCE(t.quantity, 0);
      v_total_cost := v_total_cost + COALESCE(t.total_cost, 0);
    END IF;
  END LOOP;
  IF line_count = 0 THEN
    RAISE EXCEPTION 'No active inventory transactions found' USING ERRCODE = 'P0002';
  END IF;

  UPDATE public.erp_inventory_transactions_s_539dcf81_b
     SET is_deleted = 'y', reversal_idempotency_key = p_idempotency_key,
         reversed_at = NOW(), updated_at = NOW()
   WHERE reference_type = p_document_type
     AND reference_id = p_document_id
     AND tenant_id = h.tenant_id
     AND is_deleted = 'n';

  IF p_document_type = 'subcontract_issue' THEN
    -- 回滚应发料跟踪：按明细逐条扣回（负数 → 用流水的 reference_detail_id 定位）
    FOR t IN
      SELECT x.reference_detail_id AS detail_id, x.quantity, x.total_cost
        FROM public.erp_inventory_transactions_s_539dcf81_b x
       WHERE x.reference_type = p_document_type AND x.reference_id = p_document_id
         AND x.reversal_idempotency_key = p_idempotency_key
         AND x.reference_detail_id IS NOT NULL
    LOOP
      UPDATE public.erp_subcontract_order_details_s_539dcf81_b d
         SET issued_quantity = GREATEST(COALESCE(d.issued_quantity, 0) + t.quantity, 0),
             issued_amount   = GREATEST(COALESCE(d.issued_amount, 0) + t.total_cost, 0),
             unit_cost = CASE
               WHEN GREATEST(COALESCE(d.issued_quantity, 0) + t.quantity, 0) <> 0
               THEN GREATEST(COALESCE(d.issued_amount, 0) + t.total_cost, 0)
                    / GREATEST(COALESCE(d.issued_quantity, 0) + t.quantity, 0)
               ELSE 0 END,
             updated_at = NOW()
       WHERE d.id = (
         SELECT e.order_detail_id FROM public.erp_subcontract_issue_details_s_539dcf81_b e
          WHERE e.id = t.detail_id AND e.is_deleted = 'n');
    END LOOP;

    IF h.order_id IS NOT NULL THEN
      -- 同样派生自明细（见 post 分支的说明）
      UPDATE public.erp_subcontract_orders_s_539dcf81_b o
         SET issued_quantity = (
               SELECT COALESCE(SUM(d.issued_quantity), 0)
                 FROM public.erp_subcontract_order_details_s_539dcf81_b d
                WHERE d.order_id = o.id AND d.is_deleted = 'n'),
             updated_at = NOW()
       WHERE o.id = h.order_id;
    END IF;

    UPDATE public.erp_subcontract_issues_s_539dcf81_b
       SET status = 'draft', reversal_idempotency_key = p_idempotency_key,
           reversed_at = NOW(), updated_at = NOW()
     WHERE id = p_document_id;
  ELSE
    -- 入库冲销：按过账时落库的核销明细**原样退回**。
    -- 为什么不重新按 BOM 倒算：订单量可能被改过、同一订单可能已入库多次，
    -- 重算出来的份额与当初实际核销的不一致 → consumed_quantity 会越冲越偏。
    FOR t IN
      SELECT (e ->> 'order_detail_id')::INTEGER  AS order_detail_id,
             COALESCE((e ->> 'quantity')::NUMERIC, 0) AS quantity,
             COALESCE((e ->> 'amount')::NUMERIC, 0)   AS amount
        FROM public.erp_subcontract_receipts_s_539dcf81_b r
        CROSS JOIN LATERAL jsonb_array_elements(
               COALESCE(r.consumed_materials, '[]'::JSONB)) e
       WHERE r.id = p_document_id AND r.is_deleted = 'n'
    LOOP
      CONTINUE WHEN t.order_detail_id IS NULL;
      UPDATE public.erp_subcontract_order_details_s_539dcf81_b d
         SET consumed_quantity = GREATEST(COALESCE(d.consumed_quantity, 0) - t.quantity, 0),
             consumed_amount   = GREATEST(COALESCE(d.consumed_amount, 0) - t.amount, 0),
             updated_at = NOW()
       WHERE d.id = t.order_detail_id;
    END LOOP;

    IF h.order_id IS NOT NULL THEN
      UPDATE public.erp_subcontract_orders_s_539dcf81_b
         SET received_quantity = GREATEST(
               COALESCE(received_quantity, 0)
               - (SELECT COALESCE(quantity, 0) FROM public.erp_subcontract_receipts_s_539dcf81_b
                   WHERE id = p_document_id), 0),
             status = CASE WHEN COALESCE(status, '') = 'completed' THEN 'in_progress' ELSE status END,
             updated_at = NOW()
       WHERE id = h.order_id;
    END IF;

    -- 冲销加工费应付
    UPDATE public.erp_payables_s_539dcf81_b
       SET is_deleted = 'y', status = 'cancelled', updated_at = NOW()
     WHERE tenant_id = h.tenant_id AND source_type = p_document_type
       AND source_id = p_document_id AND is_deleted = 'n';

    UPDATE public.erp_subcontract_receipts_s_539dcf81_b
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
    'reversed_quantity', ROUND(ABS(v_qty), 6),
    'voucher', v_voucher_result, 'idempotency_key', p_idempotency_key);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.reverse_subcontract_document(TEXT, INTEGER, UUID) TO authenticated;


-- ============================================================================
-- 6. 委外结算确认
-- ============================================================================
-- 为什么不做库存也不做凭证：
--   加工费应付在**入库时**已经确认（凭证「贷 2202」+ erp_payables 行），委外成品成本
--   也已含加工费。结算单是「与供应商核发票」这一步：如果这里再生成一次凭证，就会
--   重复计价。所以它只做三件事 —— 校验、记差异、推进订单结算进度。
--   差异（variance）留给财务用「应付调整 / 费用单」处理，系统不擅自入账。
CREATE OR REPLACE FUNCTION public.confirm_subcontract_settlement(
  p_settlement_id   INTEGER,
  p_idempotency_key UUID
) RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
DECLARE
  h RECORD;
  actor_id INTEGER;
  v_variance NUMERIC;
BEGIN
  IF p_settlement_id IS NULL OR p_settlement_id <= 0 OR p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'A positive settlement ID and idempotency key are required'
      USING ERRCODE = '22023';
  END IF;
  actor_id := public.current_sys_user_id();

  SELECT x.* INTO h FROM public.erp_subcontract_settlements_s_539dcf81_b x
   WHERE x.id = p_settlement_id AND x.is_deleted = 'n' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Settlement does not exist or is deleted' USING ERRCODE = 'P0002';
  END IF;
  IF h.status = 'confirmed' AND h.confirm_idempotency_key = p_idempotency_key THEN
    RETURN jsonb_build_object('ok', TRUE, 'idempotent', TRUE,
      'settlement_id', p_settlement_id, 'status', 'confirmed');
  END IF;
  IF COALESCE(h.status, '') <> 'draft' THEN
    RAISE EXCEPTION 'Only draft settlements can be confirmed; current status: %',
      COALESCE(h.status, '<null>') USING ERRCODE = '55000';
  END IF;
  IF h.supplier_id IS NULL THEN
    RAISE EXCEPTION 'Settlement % has no supplier', h.settlement_no
      USING ERRCODE = '23502';
  END IF;
  IF COALESCE(h.quantity, 0) <= 0 THEN
    RAISE EXCEPTION 'Settlement % has non-positive quantity', h.settlement_no
      USING ERRCODE = '23514';
  END IF;

  v_variance := COALESCE(h.invoiced_amount, 0) - COALESCE(h.processing_fee_amount, 0);

  UPDATE public.erp_subcontract_settlements_s_539dcf81_b
     SET variance_amount = v_variance,
         status = 'confirmed',
         confirm_idempotency_key = p_idempotency_key,
         confirmed_at = NOW(), confirmed_by = actor_id, updated_at = NOW()
   WHERE id = p_settlement_id;

  IF h.order_id IS NOT NULL THEN
    UPDATE public.erp_subcontract_orders_s_539dcf81_b
       SET settled_quantity = COALESCE(settled_quantity, 0) + h.quantity,
           updated_at = NOW()
     WHERE id = h.order_id AND is_deleted = 'n';
  END IF;

  RETURN jsonb_build_object('ok', TRUE, 'idempotent', FALSE,
    'settlement_id', p_settlement_id, 'status', 'confirmed',
    'variance_amount', ROUND(v_variance, 2),
    'confirm_idempotency_key', p_idempotency_key);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.confirm_subcontract_settlement(INTEGER, UUID) TO authenticated;


-- ============================================================================
-- 7. 自检（fail-loud）：断言委外的关键实现真的在函数体/视图定义里
-- ============================================================================
DO $$
DECLARE
  v_missing TEXT := '';
  v_src TEXT;
  v_def TEXT;
BEGIN
  -- 7.1 三个 RPC 必须存在
  IF to_regprocedure('public.post_subcontract_document(text,integer,uuid)') IS NULL THEN
    v_missing := v_missing || 'post_subcontract_document 未建立;';
  END IF;
  IF to_regprocedure('public.reverse_subcontract_document(text,integer,uuid)') IS NULL THEN
    v_missing := v_missing || 'reverse_subcontract_document 未建立;';
  END IF;
  IF to_regprocedure('public.build_subcontract_order_materials(integer,bigint,boolean)') IS NULL THEN
    v_missing := v_missing || 'build_subcontract_order_materials 未建立;';
  END IF;
  IF to_regprocedure('public.confirm_subcontract_settlement(integer,uuid)') IS NULL THEN
    v_missing := v_missing || 'confirm_subcontract_settlement 未建立;';
  END IF;

  -- 7.2 必须走唯一入口 + 消耗预占 + 写凭证
  SELECT prosrc INTO v_src FROM pg_proc
   WHERE proname = 'post_subcontract_document' AND pronamespace = 'public'::regnamespace;
  IF v_src NOT ILIKE '%inventory_apply_move%' THEN
    v_missing := v_missing || 'post_subcontract_document 未走 inventory_apply_move;';
  END IF;
  IF v_src NOT ILIKE '%inventory_consume_reservations%' THEN
    v_missing := v_missing || 'post_subcontract_document 未消耗预占;';
  END IF;
  IF v_src NOT ILIKE '%inventory_sync_voucher%' THEN
    v_missing := v_missing || 'post_subcontract_document 未生成凭证;';
  END IF;
  -- 加工费腿必须显式写出（漏了就会少「贷 应付账款」一行，凭证仍然平衡但科目错）
  IF v_src NOT ILIKE '%subcontract_fee_in%' THEN
    v_missing := v_missing || 'post_subcontract_document 未写加工费金额腿;';
  END IF;
  -- 出库必须先消耗预占再扣库存
  IF position('inventory_consume_reservations' IN v_src)
     > position('inventory_apply_move' IN v_src) THEN
    v_missing := v_missing || 'post_subcontract_document 的预占释放排在扣库存之后;';
  END IF;

  SELECT prosrc INTO v_src FROM pg_proc
   WHERE proname = 'reverse_subcontract_document' AND pronamespace = 'public'::regnamespace;
  IF v_src NOT ILIKE '%inventory_apply_move%' OR v_src NOT ILIKE '%inventory_void_voucher%' THEN
    v_missing := v_missing || 'reverse_subcontract_document 未走 apply_move / 未作废凭证;';
  END IF;
  IF v_src NOT ILIKE '%stock_status%' THEN
    v_missing := v_missing || 'reverse_subcontract_document 未按 stock_status 定位库存行;';
  END IF;
  IF v_src NOT ILIKE '%erp_payables%' THEN
    v_missing := v_missing || 'reverse_subcontract_document 未冲销加工费应付;';
  END IF;

  -- 7.3 修改过的上游对象：兜底科目必须含委外三型
  SELECT prosrc INTO v_src FROM pg_proc
   WHERE proname = 'inventory_voucher_plan' AND pronamespace = 'public'::regnamespace;
  IF v_src IS NULL THEN
    v_missing := v_missing || 'inventory_voucher_plan 不存在（deploy_87 未跑？）;';
  ELSIF v_src NOT ILIKE '%subcontract_issue_out%'
     OR v_src NOT ILIKE '%subcontract_receipt_in%'
     OR v_src NOT ILIKE '%subcontract_fee_in%' THEN
    v_missing := v_missing || 'inventory_voucher_plan 缺少委外科目兜底（会静默不出凭证）;';
  END IF;

  -- 7.4 收发存汇总必须按金额符号判定（否则漏掉加工费金额腿）
  --     注意：pg_get_viewdef 会把数字常量渲染成 (0)::numeric，断言要兼容两种写法。
  SELECT pg_get_viewdef('public.vw_erp_inventory_summary'::regclass) INTO v_def;
  IF v_def NOT ILIKE '%total_cost > (0)%' AND v_def NOT ILIKE '%total_cost > 0%' THEN
    v_missing := v_missing || 'vw_erp_inventory_summary 金额仍按数量符号判定;';
  END IF;

  -- 7.5 订单应发料的两列金额跟踪必须存在（核销单价靠它算）
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'erp_subcontract_order_details_s_539dcf81_b'
       AND column_name = 'issued_amount' AND is_nullable = 'NO'
  ) THEN
    v_missing := v_missing || 'erp_subcontract_order_details.issued_amount 缺失;';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'erp_subcontract_order_details_s_539dcf81_b'
       AND column_name = 'consumed_amount' AND is_nullable = 'NO'
  ) THEN
    v_missing := v_missing || 'erp_subcontract_order_details.consumed_amount 缺失;';
  END IF;

  -- 7.5b 入库单必须落库核销明细（反过账靠它原样退回）
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'erp_subcontract_receipts_s_539dcf81_b'
       AND column_name = 'consumed_materials' AND is_nullable = 'NO'
  ) THEN
    v_missing := v_missing || 'erp_subcontract_receipts.consumed_materials 缺失;';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc
   WHERE proname = 'post_subcontract_document' AND pronamespace = 'public'::regnamespace;
  IF v_src NOT ILIKE '%consumed_materials%' THEN
    v_missing := v_missing || 'post_subcontract_document 未落库核销明细;';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc
   WHERE proname = 'reverse_subcontract_document' AND pronamespace = 'public'::regnamespace;
  IF v_src NOT ILIKE '%consumed_materials%' THEN
    v_missing := v_missing || 'reverse_subcontract_document 未按落库明细退回核销;';
  END IF;

  -- 7.6 加工费腿的交易类型必须标 affects_stock = FALSE
  IF NOT EXISTS (
    SELECT 1 FROM public.sys_inventory_transaction_types
     WHERE code = 'subcontract_fee_in' AND NOT affects_stock AND is_deleted = 'n'
  ) THEN
    v_missing := v_missing || 'subcontract_fee_in 未标 affects_stock=FALSE（会被当成真实库存移动）;';
  END IF;

  -- 7.7 外币口径：base_amount 必须是「金额 × 汇率」，不能直接把外币金额当本位币
  --     （deploy_93 采购入库就是这个口径）。判断方式：函数体必须出现 exchange_rate 乘法。
  SELECT prosrc INTO v_src FROM pg_proc
   WHERE proname = 'post_subcontract_document' AND pronamespace = 'public'::regnamespace;
  IF v_src NOT ILIKE '%v_exchange_rate%' THEN
    v_missing := v_missing || 'post_subcontract_document 未按汇率折算 base_amount（外币会被当本位币入账）;';
  END IF;

  IF v_missing <> '' THEN
    RAISE EXCEPTION 'deploy_103 自检失败：%', v_missing;
  END IF;

  RAISE NOTICE 'deploy_103 OK：委外过账/反过账/结算确认 RPC + 科目兜底 + 收发存金额口径 就绪';
END;
$$;
