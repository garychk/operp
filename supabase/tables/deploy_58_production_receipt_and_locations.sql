-- ============================================================================
-- deploy_58: 完工入库 DocType 注册 + 领料/完工入库库位化
-- ============================================================================
--
-- 背景（deploy_56 的两处遗留）：
--
--   1. `production_receipt` 从未注册进 sys_document_types。
--      deploy_56 只给过账留了 NOTICE 提示，因为过账走
--      resolve_inventory_transaction_type 的硬编码回退分支不受影响；
--      但缺失的后果是：nextDocumentNo('production_receipt') 会抛
--      「No naming rule configured for document type」——完工入库页建不出单号。
--      sys_document_types 是**全局表**（document_type 单列 UNIQUE、无租户部分索引），
--      所以补一行即对所有租户生效，不需要按租户补。
--
--   2. 领料单与完工入库单都没有库位字段，过账时 v_location_id 恒为 NULL，
--      只能扣「仓库级无库位库存行」（COALESCE(location_id,0)=0）。
--      一旦某仓库的库存全在库位上，领料就必然报缺口。
--
--      本次把库位放到**明细级**：
--        - erp_material_issue_details.location_id  ← 每行可指定不同库位
--        - erp_production_receipts.location_id     ← 完工入库是单行单据，主表即明细
--
--      deploy_56 里 `v_location_id := COALESCE(d.detail_location_id,
--      h.header_location_id)` 的取值链、库位校验分支、advisory lock 键、
--      流水写入、反过账**全部不用动** —— 库位只是从「恒 NULL」变成「有值」。
--      因此本脚本只重定义 post_production_document，且只改明细流的两个
--      location 取值处（header_location_id 仍为 NULL，两单的主表都没有库位列）。
--
-- 幂等性：
--   - ALTER TABLE ... ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS
--   - sys_document_types 走 ON CONFLICT (document_type)（普通唯一索引，安全）
--   - sys_document_transaction_types 走 ON CONFLICT (document_type_id, transaction_type_code)
--   - 函数是 CREATE OR REPLACE
--
-- 依赖：deploy_56（post_production_document / reverse_production_document）、
--       deploy_32（sys_document_types 与取号）、
--       deploy_40（sys_document_transaction_types 与 production_receipt_in 字典）、
--       deploy_25_bins_and_location（erp_bins）
-- ============================================================================

-- 注意：本文件不要写 BEGIN;/COMMIT; —— 执行器是 `psql --single-transaction`，
-- 每个文件已经在自己的事务里，再套一层会提前提交掉。

-- ----------------------------------------------------------------------------
-- 1. 领料明细补库位
--    明细级而非主表级：同一张领料单的不同行经常来自不同货位，
--    这是标准 ERP 的做法，也让「一张单拆多个库位」不需要拆单。
-- ----------------------------------------------------------------------------
ALTER TABLE public.erp_material_issue_details_s_539dcf81_b
  ADD COLUMN IF NOT EXISTS location_id INTEGER
    REFERENCES public.erp_bins_s_539dcf81_b(id);

CREATE INDEX IF NOT EXISTS idx_erp_material_issue_details_location_id
  ON public.erp_material_issue_details_s_539dcf81_b(location_id);


-- ----------------------------------------------------------------------------
-- 2. 完工入库单补库位
--    该单没有明细表（主表即唯一明细行），所以库位落在主表上。
-- ----------------------------------------------------------------------------
ALTER TABLE public.erp_production_receipts_s_539dcf81_b
  ADD COLUMN IF NOT EXISTS location_id INTEGER
    REFERENCES public.erp_bins_s_539dcf81_b(id);

CREATE INDEX IF NOT EXISTS idx_erp_production_receipts_location_id
  ON public.erp_production_receipts_s_539dcf81_b(location_id);


-- ----------------------------------------------------------------------------
-- 3. 过账函数：明细流改为读取明细库位
--    与 deploy_56 的唯一差异就是 UNION ALL 两支里的 location 取值：
--      material_issue   : NULL::INTEGER  ->  x.location_id
--      production_receipt: NULL::INTEGER ->  x.location_id
--    header_location_id 两处仍是 NULL（两张主表都没有库位列）。
--    ⚠️ 本函数是 deploy_56 的完整替代版本；改动时两处要一起看。
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

  -- 主表加锁。两张主表都没有库位列，header_location_id 恒为 NULL；
  -- 库位一律来自明细（完工入库单的「明细」就是主表那一行，见下面的 UNION ALL）。
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
  -- detail_location_id 就是本脚本新增的库位来源（deploy_56 时恒为 NULL）。
  FOR d IN
    SELECT x.id AS detail_id, x.material_id AS product_id, x.quantity,
      x.unit_cost AS document_unit_cost,
      COALESCE(NULLIF(p.cost_price, 0), NULLIF(p.purchase_price, 0), 0)
        AS product_unit_cost,
      NULLIF(BTRIM(x.batch_no), '') AS batch_no,
      NULL::DATE AS expiry_date, x.location_id AS detail_location_id
    FROM public.erp_material_issue_details_s_539dcf81_b x
    LEFT JOIN public.erp_products_s_539dcf81_b p ON p.id = x.material_id
    WHERE p_document_type = 'material_issue'
      AND x.issue_id = p_document_id AND x.is_deleted = 'n'
    UNION ALL
    SELECT x.id, x.product_id, x.quantity,
      x.unit_cost,
      COALESCE(NULLIF(p.cost_price, 0), NULLIF(p.purchase_price, 0), 0),
      NULLIF(BTRIM(x.batch_no), ''), NULL::DATE, x.location_id
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
        -- 补库位后这条提示仍有用：明细没指定库位时才可能落到这里
        RAISE EXCEPTION
          'Insufficient warehouse-level stock for product %, warehouse %: available %, requested % (明细未指定库位，只能扣无库位库存行；请给领料明细指定库位，或补建无库位库存)',
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

REVOKE ALL ON FUNCTION public.post_production_document(TEXT, INTEGER, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.post_production_document(TEXT, INTEGER, UUID) TO authenticated;


-- ----------------------------------------------------------------------------
-- 4. 注册 production_receipt DocType
--    缺了它 generate_document_no 找不到命名规则 -> 完工入库页建不出单号。
--    sys_document_types.document_type 是普通唯一索引（无租户部分索引），
--    所以 ON CONFLICT (document_type) 可用，且一行即覆盖所有租户。
--    前缀 PRT 而非 PR：PR 已被 purchase_receipt 占用。
-- ----------------------------------------------------------------------------
INSERT INTO public.sys_document_types
  (document_type, document_name, module_code, route_path, table_name, naming_rule, sort_order)
VALUES
  ('production_receipt', '完工入库单', 'mrp', '/mrp/production-receipts',
   'erp_production_receipts_s_539dcf81_b', 'PRT{YYYY}{####}', 65)
ON CONFLICT (document_type) DO UPDATE SET
  document_name = EXCLUDED.document_name,
  module_code = EXCLUDED.module_code,
  route_path = EXCLUDED.route_path,
  table_name = EXCLUDED.table_name,
  naming_rule = EXCLUDED.naming_rule,
  sort_order = EXCLUDED.sort_order,
  updated_at = NOW();


-- ----------------------------------------------------------------------------
-- 5. DocType -> 交易类型映射
--    deploy_56 因为 DocType 没注册，这一步被 JOIN 静默跳过了（当时打了 NOTICE）。
--    补上之后 resolve_inventory_transaction_type 走 JOIN 分支，
--    与硬编码回退分支给出同一个 code（production_receipt_in），
--    但顺带让 sys_inventory_transaction_types.affects_stock 之类的字典属性真正生效。
-- ----------------------------------------------------------------------------
INSERT INTO public.sys_document_transaction_types
  (document_type_id, transaction_type_code, direction, is_default,
   condition_note, status, sort_order)
SELECT d.id, 'production_receipt_in', 'in', TRUE,
       '生产完工入库', '1', 10
FROM public.sys_document_types d
WHERE d.document_type = 'production_receipt'
ON CONFLICT (document_type_id, transaction_type_code) DO UPDATE SET
  direction = EXCLUDED.direction,
  is_default = EXCLUDED.is_default,
  condition_note = EXCLUDED.condition_note,
  status = EXCLUDED.status,
  sort_order = EXCLUDED.sort_order,
  is_deleted = 'n',
  updated_at = NOW();


-- ----------------------------------------------------------------------------
-- 6. 自检
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_naming TEXT;
  v_cols INTEGER;
  v_maps INTEGER;
BEGIN
  SELECT naming_rule INTO v_naming FROM public.sys_document_types
  WHERE document_type = 'production_receipt' AND status = '1' AND is_deleted = 'n';
  IF v_naming IS NULL THEN
    RAISE EXCEPTION 'production_receipt DocType 注册失败或未启用';
  END IF;

  SELECT count(*) INTO v_cols FROM information_schema.columns
  WHERE table_schema = 'public'
    AND ((table_name = 'erp_material_issue_details_s_539dcf81_b' AND column_name = 'location_id')
      OR (table_name = 'erp_production_receipts_s_539dcf81_b' AND column_name = 'location_id'));
  IF v_cols <> 2 THEN
    RAISE EXCEPTION '库位列未建齐（期望 2，实际 %）', v_cols;
  END IF;

  SELECT count(*) INTO v_maps FROM public.sys_document_transaction_types m
  JOIN public.sys_document_types d ON d.id = m.document_type_id
  WHERE d.document_type = 'production_receipt'
    AND m.transaction_type_code = 'production_receipt_in' AND m.is_deleted = 'n';
  IF v_maps = 0 THEN
    RAISE EXCEPTION 'production_receipt 的交易类型映射行未写入';
  END IF;

  RAISE NOTICE 'deploy_58 OK：naming_rule=%，库位列 2 个，交易类型映射 % 行', v_naming, v_maps;
END;
$$;
