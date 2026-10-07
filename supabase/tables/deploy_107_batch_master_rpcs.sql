-- ============================================================================
-- P2-12：批次管理 + 批次追溯（RPC 与视图）
-- ============================================================================
--
-- 承接 deploy_106 的批次主数据表，这一层解决三件事：
--   E1 批次管理开关**真正生效**（而不是只加一个字段摆着）
--   E5 批次追溯查询（正向 / 反向）
--   E4 近效期 / 过期预警（批次主数据 + 效期维度）
--
-- ---------------------------------------------------------------------------
-- 设计要点
-- ---------------------------------------------------------------------------
-- 1. 批次强制点放在 **`inventory_apply_move()` 这一个漏斗**，不是 9 个过账 RPC
--    理由：全库所有库存增减都过它（deploy_88 起的铁律）。
--    在这里加校验，将来任何新增单据（组装、循环盘点……）自动获得批次校验，
--    不需要逐个 RPC 打补丁 —— 也不会漏掉某个 RPC。
--    代价是动了核心函数，所以本文件带 8 条自检断言，且必须跑全量回归。
--
-- 2. 反过账**同样受批次冻结拦截**（故意如此）
--    冻结整批通常意味着质量事故。此时连冲销也要先走「解冻」这个留痕动作 ——
--    否则错误批次可以悄悄冲回库存再悄悄出库，冻结形同虚设。
--    报错消息里直接告诉使用者去哪里解冻，不让人卡死。
--
-- 3. 效期「一次录入，全链路复用」，但**只补不猜**
--    入库时明细没填效期 → 取批次档案上已登记的效期。
--    **只在入库方向补**：出库行的效期应来自库存行本身，用档案去覆盖会掩盖
--    库存行的真实效期，让预警失真。
--    **绝不用 shelf_life_days 隐式推算效期** —— 猜错的生产日期会静默造出
--    错误的效期，比没有效期更糟（预警误报/漏报都查不出源头）。
--
-- 4. 追溯分两个方向，实现方式不同
--    * 上游（我的料哪来的）：必须靠**单据谱系**推导 ——
--      生产入库批 ← 同一生产订单的领料批；委外入库批 ← 同一委外订单的发料批。
--      这是「物料变了」的转换，只有单据能表达，库存流水表达不了。
--    * 下游（这批去哪了）：主要靠**库存流水**（`reference_type` + `reference_id`
--      已经指向来源单据），再对「被领用 → 产出新批」的分支做单据谱系递归。
--
-- 5. 递归深度**硬顶 10 层**
--    数据异常（比如批次号成环）会让递归停不下来。SQL 递归 CTE 不会自动保护，
--    这里统一 `LEAST(COALESCE(p_max_depth, 5), 10)`。
--
-- 6. 视图一律 `security_invoker = true`（deploy_96 起的铁律）
--    视图不提升权限，底层 erp_* 的 fail-closed RLS 按调用者身份生效。
--
-- 7. 三个新函数的租户口径统一为 `COALESCE(p_tenant_id, current_tenant_id())`
--    前端经 PostgREST 调用时通常**不传** tenant_id（由 JWT 决定身份），
--    所以「传 null」必须是正常工作路径，只有**解析不出租户**才抛错（fail-loud）。
--    erp_batch_upsert 早期版本写的是 `p_tenant_id IS NULL → 23502`，
--    会让批次管理页的建档/批量导入整页不可用 —— 已改为先解析到 v_tenant 再用。
--
-- 本脚本由 000_run_all 用 psql --single-transaction 执行，**不要写 BEGIN/COMMIT**。
-- 依赖：deploy_88（inventory_apply_move 原定义）、deploy_96（视图口径）、
--       deploy_106（erp_batches / 批次开关）。
-- ============================================================================


-- ============================================================================
-- 1. 库存增减的唯一漏斗：加入批次管理
--    本函数自 deploy_88 起是本函数的**唯一权威定义**（此前只有 deploy_88 一处），
--    本文件是它的**最新定义**，后续改动请只改这里并同步更新本注释。
-- ============================================================================
CREATE OR REPLACE FUNCTION public.inventory_apply_move(
  p_tenant_id      BIGINT,
  p_corp_id        VARCHAR,
  p_actor_id       INTEGER,
  p_product_id     INTEGER,
  p_warehouse_id   INTEGER,
  p_location_id    INTEGER,
  p_batch_no       TEXT,
  p_stock_status   TEXT,
  p_qty_delta      NUMERIC,
  p_unit_cost      NUMERIC DEFAULT NULL,
  p_cost_delta     NUMERIC DEFAULT NULL,
  p_expiry_date    DATE    DEFAULT NULL,
  p_allow_negative BOOLEAN DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_status TEXT := LOWER(COALESCE(NULLIF(BTRIM(p_stock_status), ''), 'available'));
  v_batch  TEXT := NULLIF(BTRIM(p_batch_no), '');
  v_expiry DATE;
  i RECORD;
  old_qty NUMERIC; old_available NUMERIC; old_cost NUMERIC; old_locked NUMERIC;
  new_qty NUMERIC; new_available NUMERIC; new_cost NUMERIC;
  v_unit_cost NUMERIC; v_cost_delta NUMERIC; v_allow BOOLEAN;
BEGIN
  IF p_tenant_id IS NULL OR p_product_id IS NULL OR p_warehouse_id IS NULL THEN
    RAISE EXCEPTION 'inventory_apply_move 需要 tenant/product/warehouse'
      USING ERRCODE = '23502';
  END IF;
  IF v_status NOT IN ('available', 'inspection', 'hold', 'rejected') THEN
    RAISE EXCEPTION '非法库存状态：%', p_stock_status USING ERRCODE = '23514';
  END IF;

  -- ---- 批次管理校验（deploy_107 新增）------------------------------------
  -- 1) 物料开了批次管理却没给批次号 → 拒绝过账。
  --    不拦的话「批次管理」只是个摆设：同一物料一半带批次、一半不带，
  --    而那部分无批次库存永远追溯不到源头。
  IF v_batch IS NULL AND EXISTS (
    SELECT 1 FROM public.erp_products_s_539dcf81_b p
     WHERE p.id = p_product_id AND p.tenant_id = COALESCE(p_tenant_id, current_tenant_id())
       AND p.is_deleted = 'n' AND p.is_batch_managed IS TRUE
  ) THEN
    RAISE EXCEPTION '物料 % 已启用批次管理，过账必须填写批次号', p_product_id
      USING ERRCODE = '23514';
  END IF;

  -- 2) 批次被冻结（blocked）时禁止出库，**反过账同样被拦**（见文件头说明）。
  IF v_batch IS NOT NULL AND COALESCE(p_qty_delta, 0) < 0 AND EXISTS (
    SELECT 1 FROM public.erp_batches_s_539dcf81_b b
     WHERE b.tenant_id = COALESCE(p_tenant_id, current_tenant_id()) AND b.product_id = p_product_id
       AND b.batch_no = v_batch AND b.is_deleted = 'n' AND b.status = 'blocked'
  ) THEN
    RAISE EXCEPTION '批次 % 已被冻结，不能出库或冲销；确需使用请先在「批次管理」中解冻', v_batch
      USING ERRCODE = '23514';
  END IF;
  -- -----------------------------------------------------------------------

  v_allow := p_allow_negative;
  IF v_allow IS NULL THEN
    SELECT COALESCE(w.is_negative_stock_allowed, FALSE) INTO v_allow
      FROM public.erp_warehouses_s_539dcf81_b w
     WHERE w.id = p_warehouse_id AND w.tenant_id = COALESCE(p_tenant_id, current_tenant_id()) AND w.is_deleted = 'n';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Warehouse does not exist or is deleted' USING ERRCODE = 'P0002';
    END IF;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    format('erp_inventory:%s:%s:%s:%s:%s', p_product_id, p_warehouse_id,
           COALESCE(p_location_id, 0), COALESCE(v_batch, ''), v_status), 0));

  SELECT x.* INTO i FROM public.erp_inventory_s_539dcf81_b x
   WHERE x.product_id = p_product_id
     AND x.warehouse_id = p_warehouse_id
     AND x.tenant_id = COALESCE(p_tenant_id, current_tenant_id())
     AND COALESCE(x.location_id, 0) = COALESCE(p_location_id, 0)
     AND COALESCE(NULLIF(BTRIM(x.batch_no), ''), '') = COALESCE(v_batch, '')
     AND x.stock_status = v_status
     AND x.is_deleted = 'n'
   FOR UPDATE;

  IF FOUND THEN
    old_qty      := COALESCE(i.quantity, 0);
    old_available := COALESCE(i.available_quantity, 0);
    old_cost     := COALESCE(i.total_cost, 0);
    old_locked   := COALESCE(i.locked_quantity, 0);
  ELSE
    old_qty := 0; old_available := 0; old_cost := 0; old_locked := 0;
  END IF;

  -- ---- 效期补全（deploy_107 新增）----------------------------------------
  -- 入库时明细没填效期 → 复用批次档案上已登记的效期：效期只需在建批时录一次。
  -- 只在**入库**方向补；出库行的效期要忠于库存行本身。
  v_expiry := p_expiry_date;
  IF v_expiry IS NULL AND v_batch IS NOT NULL AND COALESCE(p_qty_delta, 0) > 0 THEN
    SELECT b.expiry_date INTO v_expiry
      FROM public.erp_batches_s_539dcf81_b b
     WHERE b.tenant_id = COALESCE(p_tenant_id, current_tenant_id()) AND b.product_id = p_product_id
       AND b.batch_no = v_batch AND b.is_deleted = 'n';
  END IF;
  -- ------------------------------------------------------------------------

  -- 成本单价口径：入库优先用单据价，出库优先用库存移动加权
  IF COALESCE(p_qty_delta, 0) >= 0 THEN
    v_unit_cost := COALESCE(NULLIF(p_unit_cost, 0), NULLIF(i.unit_cost, 0), 0);
  ELSE
    v_unit_cost := COALESCE(NULLIF(i.unit_cost, 0), NULLIF(p_unit_cost, 0), 0);
  END IF;

  v_cost_delta := COALESCE(p_cost_delta, COALESCE(p_qty_delta, 0) * v_unit_cost);
  new_qty      := old_qty + COALESCE(p_qty_delta, 0);
  new_cost     := old_cost + v_cost_delta;
  new_available := CASE WHEN v_status = 'available' THEN new_qty - old_locked ELSE 0 END;

  IF NOT v_allow AND (new_qty < 0 OR new_available < 0) THEN
    RAISE EXCEPTION
      'Insufficient stock for product %, warehouse %, location %, status %: on hand %, available %, requested %',
      p_product_id, p_warehouse_id, COALESCE(p_location_id, 0), v_status,
      old_qty, old_available, ABS(COALESCE(p_qty_delta, 0))
      USING ERRCODE = '23514';
  END IF;
  IF i.id IS NULL AND COALESCE(p_qty_delta, 0) < 0 AND NOT v_allow THEN
    RAISE EXCEPTION
      '无法出库：物料 % 在仓库 % 库位 % 状态 % 下没有库存行',
      p_product_id, p_warehouse_id, COALESCE(p_location_id, 0), v_status
      USING ERRCODE = '23514';
  END IF;

  IF i.id IS NULL THEN
    INSERT INTO public.erp_inventory_s_539dcf81_b (
      corp_id, emp_id, is_deleted, product_id, warehouse_id, location_id,
      stock_status, quantity, available_quantity, locked_quantity,
      unit_cost, total_cost, batch_no, expiry_date, tenant_id
    ) VALUES (
      p_corp_id, p_actor_id::TEXT, 'n', p_product_id, p_warehouse_id, p_location_id,
      v_status, new_qty, new_available, 0,
      CASE WHEN new_qty = 0 THEN v_unit_cost ELSE ABS(new_cost / new_qty) END,
      new_cost, v_batch, v_expiry, p_tenant_id
    ) RETURNING * INTO i;
  ELSE
    UPDATE public.erp_inventory_s_539dcf81_b
       SET quantity           = new_qty,
           available_quantity = new_available,
           unit_cost          = CASE WHEN new_qty = 0 THEN v_unit_cost
                                     ELSE ABS(new_cost / new_qty) END,
           total_cost         = new_cost,
           expiry_date        = COALESCE(v_expiry, expiry_date),
           updated_at         = NOW()
     WHERE id = i.id;
  END IF;

  -- ---- 批次档案自动建档（deploy_107 新增）--------------------------------
  -- 入库且带批次号时，批次首次出现即建档（标准 ERP 的「随入库自动建批」）。
  -- 已存在则**只补齐缺失项，不覆盖人工维护的值** —— 质检状态、冻结状态、
  -- 供应商批号都是人填的，机器不该按过账先后把它们改掉。
  IF COALESCE(p_qty_delta, 0) > 0 AND v_batch IS NOT NULL THEN
    INSERT INTO public.erp_batches_s_539dcf81_b (
      corp_id, emp_id, is_deleted, batch_no, product_id, expiry_date,
      source_type, unit_cost, created_by, tenant_id
    ) VALUES (
      p_corp_id, p_actor_id::TEXT, 'n', v_batch, p_product_id, v_expiry,
      'auto', COALESCE(v_unit_cost, 0), p_actor_id, p_tenant_id
    )
    ON CONFLICT (tenant_id, product_id, batch_no) WHERE is_deleted = 'n'
    DO UPDATE SET
      expiry_date = COALESCE(erp_batches_s_539dcf81_b.expiry_date, EXCLUDED.expiry_date),
      unit_cost   = CASE WHEN erp_batches_s_539dcf81_b.unit_cost = 0
                         THEN EXCLUDED.unit_cost
                         ELSE erp_batches_s_539dcf81_b.unit_cost END,
      updated_at  = NOW();
  END IF;
  -- ------------------------------------------------------------------------

  RETURN jsonb_build_object(
    'id', i.id,
    'batch_no', v_batch,
    'expiry_date', v_expiry,
    'stock_status', v_status,
    'unit_cost', v_unit_cost,
    'cost_delta', v_cost_delta,
    'old_qty', old_qty, 'old_available', old_available, 'old_cost', old_cost,
    'new_qty', new_qty, 'new_available', new_available, 'new_cost', new_cost);
END;
$$;

GRANT EXECUTE ON FUNCTION public.inventory_apply_move(
  BIGINT, VARCHAR, INTEGER, INTEGER, INTEGER, INTEGER, TEXT, TEXT, NUMERIC, NUMERIC, NUMERIC, DATE, BOOLEAN
) TO authenticated;


-- ============================================================================
-- 2. 批次流水视图（追溯的明细底座）
--    把 reference_type → 来源单据号 / 单据日期 / 往来对象 的映射固化下来，
--    追溯与批次流水页共用，避免每处各写一遍 15 个分支的 CASE。
-- ============================================================================
CREATE OR REPLACE VIEW public.vw_erp_batch_movement
  WITH (security_invoker = true) AS
SELECT
  t.tenant_id,
  t.id                       AS transaction_id,
  t.transaction_no,
  t.transaction_date,
  t.product_id,
  p.code                     AS product_code,
  p.name                     AS product_name,
  p.unit,
  COALESCE(NULLIF(BTRIM(t.batch_no), ''), '') AS batch_no,
  t.warehouse_id,
  w.name                     AS warehouse_name,
  t.location_id,
  bn.name                    AS bin_name,
  t.stock_status,
  t.transaction_type,
  tt.name                    AS transaction_type_name,
  tt.direction,
  t.quantity,
  t.unit_cost,
  t.total_cost,
  t.reference_type,
  t.reference_id,
  t.reference_detail_id,
  -- 来源单据号（15 种 reference_type 覆盖全量过账 RPC，见文件头）
  COALESCE(pr.receipt_no, prn.return_no, sd.delivery_no, srn.return_no,
           mi.issue_no, mrn.return_no, prc.receipt_no, tr.transfer_no,
           sa.adjust_no, scnt.count_no, si.issue_no, sr.receipt_no,
           osd.document_no, ob.document_no)          AS document_no,
  COALESCE(pr.receipt_date, prn.return_date, sd.delivery_date, srn.return_date,
           mi.issue_date, mrn.return_date, prc.receipt_date, tr.transfer_date,
           sa.adjust_date, scnt.count_date, si.issue_date, sr.receipt_date,
           osd.document_date, ob.document_date)      AS document_date,
  sup.name                   AS supplier_name,
  cus.name                   AS customer_name,
  osd.counterparty           AS document_party,
  -- 往来对象统一出口：采购/委外找供应商，销售找客户，其他出入库用自由文本
  COALESCE(sup.name, cus.name, osd.counterparty) AS party_name
FROM public.erp_inventory_transactions_s_539dcf81_b t
-- 内连接：过账时的 transaction_type 必然来自字典（resolve_inventory_transaction_type），
-- 字典里没有的类型根本过不了账，所以不会因此丢行；direction 也是追溯判向的依据。
JOIN public.sys_inventory_transaction_types tt ON tt.code = t.transaction_type
LEFT JOIN public.erp_products_s_539dcf81_b p            ON p.id = t.product_id
LEFT JOIN public.erp_warehouses_s_539dcf81_b w          ON w.id = t.warehouse_id
LEFT JOIN public.erp_bins_s_539dcf81_b bn               ON bn.id = t.location_id
LEFT JOIN public.erp_purchase_receipts_s_539dcf81_b pr
       ON t.reference_type = 'purchase_receipt' AND pr.id = t.reference_id
LEFT JOIN public.erp_purchase_returns_s_539dcf81_b prn
       ON t.reference_type = 'purchase_return' AND prn.id = t.reference_id
LEFT JOIN public.erp_sales_deliveries_s_539dcf81_b sd
       ON t.reference_type = 'sales_delivery' AND sd.id = t.reference_id
LEFT JOIN public.erp_sales_returns_s_539dcf81_b srn
       ON t.reference_type = 'sales_return' AND srn.id = t.reference_id
LEFT JOIN public.erp_material_issues_s_539dcf81_b mi
       ON t.reference_type = 'material_issue' AND mi.id = t.reference_id
LEFT JOIN public.erp_material_returns_s_539dcf81_b mrn
       ON t.reference_type = 'material_return' AND mrn.id = t.reference_id
LEFT JOIN public.erp_production_receipts_s_539dcf81_b prc
       ON t.reference_type = 'production_receipt' AND prc.id = t.reference_id
-- 调拨有三个取值（见 inventory_document_ref_types），都要指向同一张调拨单
LEFT JOIN public.erp_inventory_transfers_s_539dcf81_b tr
       ON t.reference_type IN ('inventory_transfer', 'inventory_transfer_in', 'inventory_transfer_out')
      AND tr.id = t.reference_id
LEFT JOIN public.erp_stock_adjustments_s_539dcf81_b sa
       ON t.reference_type = 'stock_adjustment' AND sa.id = t.reference_id
LEFT JOIN public.erp_stock_counts_s_539dcf81_b scnt
       ON t.reference_type = 'stock_count' AND scnt.id = t.reference_id
LEFT JOIN public.erp_subcontract_issues_s_539dcf81_b si
       ON t.reference_type = 'subcontract_issue' AND si.id = t.reference_id
LEFT JOIN public.erp_subcontract_receipts_s_539dcf81_b sr
       ON t.reference_type = 'subcontract_receipt' AND sr.id = t.reference_id
LEFT JOIN public.erp_other_stock_documents_s_539dcf81_b osd
       ON t.reference_type = 'other_stock_document' AND osd.id = t.reference_id
LEFT JOIN public.erp_opening_balances_s_539dcf81_b ob
       ON t.reference_type = 'opening_balance' AND ob.id = t.reference_id
LEFT JOIN public.erp_suppliers_s_539dcf81_b sup
       ON sup.id = COALESCE(pr.supplier_id, prn.supplier_id, si.supplier_id, sr.supplier_id)
LEFT JOIN public.erp_customers_s_539dcf81_b cus
       ON cus.id = COALESCE(sd.customer_id, srn.customer_id)
WHERE t.is_deleted = 'n';


-- ============================================================================
-- 3. 批次存量视图（批次管理页主数据源 + 效期状态判定）
-- ============================================================================
CREATE OR REPLACE VIEW public.vw_erp_batch_stock
  WITH (security_invoker = true) AS
SELECT
  b.tenant_id,
  b.id                       AS batch_id,
  b.batch_no,
  b.product_id,
  p.code                     AS product_code,
  p.name                     AS product_name,
  p.specification,
  p.unit,
  p.is_batch_managed,
  b.supplier_id,
  s.name                     AS supplier_name,
  b.supplier_batch_no,
  b.production_date,
  b.expiry_date,
  b.shelf_life_days,
  b.qc_status,
  b.status                   AS batch_status,
  b.source_type,
  b.source_document_no,
  b.unit_cost                AS ref_unit_cost,
  b.remark,
  b.created_at,
  b.created_by,
  COALESCE(st.on_hand_qty, 0)     AS on_hand_qty,
  COALESCE(st.on_hand_amount, 0)  AS on_hand_amount,
  COALESCE(st.available_qty, 0)   AS available_qty,
  COALESCE(st.locked_qty, 0)      AS locked_qty,
  COALESCE(st.warehouse_count, 0) AS warehouse_count,
  (b.expiry_date - CURRENT_DATE)  AS days_to_expiry,
  -- 效期状态分级：阈值 7 / 30 天为固定口径（视图不接参数，页面可按 days_to_expiry 自行调整）
  CASE
    WHEN b.status = 'blocked'                     THEN 'blocked'
    WHEN b.expiry_date IS NULL                    THEN 'normal'
    WHEN b.expiry_date < CURRENT_DATE             THEN 'expired'
    WHEN b.expiry_date - CURRENT_DATE <= 7        THEN 'critical'
    WHEN b.expiry_date - CURRENT_DATE <= 30       THEN 'warning'
    ELSE 'normal'
  END                        AS expiry_state
FROM public.erp_batches_s_539dcf81_b b
LEFT JOIN public.erp_products_s_539dcf81_b p
       ON p.id = b.product_id AND p.tenant_id = b.tenant_id
LEFT JOIN public.erp_suppliers_s_539dcf81_b s
       ON s.id = b.supplier_id AND s.tenant_id = b.tenant_id
LEFT JOIN LATERAL (
  SELECT
    SUM(i.quantity)                                   AS on_hand_qty,
    SUM(i.total_cost)                                 AS on_hand_amount,
    SUM(CASE WHEN i.stock_status = 'available'
             THEN COALESCE(i.available_quantity, 0) ELSE 0 END) AS available_qty,
    SUM(CASE WHEN i.stock_status = 'available'
             THEN COALESCE(i.locked_quantity, 0) ELSE 0 END)    AS locked_qty,
    COUNT(DISTINCT i.warehouse_id)                    AS warehouse_count
  FROM public.erp_inventory_s_539dcf81_b i
  WHERE i.tenant_id = b.tenant_id
    AND i.product_id = b.product_id
    AND COALESCE(NULLIF(BTRIM(i.batch_no), ''), '') = b.batch_no
    AND i.is_deleted = 'n'
) st ON TRUE
WHERE b.is_deleted = 'n';


-- ============================================================================
-- 4. 近效期 / 过期预警视图
--    只列**还有实体库存**的批次 —— 账上已出完的批次过期了不需要人处理。
-- ============================================================================
CREATE OR REPLACE VIEW public.vw_erp_batch_expiry_alert
  WITH (security_invoker = true) AS
SELECT
  tenant_id, batch_id, batch_no, product_id, product_code, product_name, unit,
  specification, supplier_name, supplier_batch_no,
  production_date, expiry_date, days_to_expiry, expiry_state,
  qc_status, batch_status, on_hand_qty, available_qty, on_hand_amount,
  warehouse_count, remark
FROM public.vw_erp_batch_stock
WHERE on_hand_qty > 0
  AND expiry_state IN ('expired', 'critical', 'warning');


-- ============================================================================
-- 5. 手工建档 / 批量导入批次（页面用）
-- ============================================================================
CREATE OR REPLACE FUNCTION public.erp_batch_upsert(
  p_tenant_id         BIGINT,
  p_product_id        INTEGER,
  p_batch_no          TEXT,
  p_production_date   DATE    DEFAULT NULL,
  p_expiry_date       DATE    DEFAULT NULL,
  p_shelf_life_days   INTEGER DEFAULT NULL,
  p_supplier_id       INTEGER DEFAULT NULL,
  p_supplier_batch_no TEXT    DEFAULT NULL,
  p_qc_status         TEXT    DEFAULT NULL,
  p_status            TEXT    DEFAULT NULL,
  p_remark            TEXT    DEFAULT NULL,
  p_actor_id          INTEGER DEFAULT NULL,
  p_update_existing   BOOLEAN DEFAULT FALSE
) RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_batch   TEXT   := NULLIF(BTRIM(p_batch_no), '');
  -- 租户解析口径与 apply_move / 两个追溯函数**一致**：
  -- 前端经 PostgREST 调用时通常不传 tenant_id（由 JWT 决定），传 null 必须能工作；
  -- 解析不出租户才抛错（fail-loud），而不是拿「参数为空」当错误。
  v_tenant  BIGINT := COALESCE(p_tenant_id, current_tenant_id());
  v_id      INTEGER;
  v_created BOOLEAN := FALSE;
BEGIN
  IF v_tenant IS NULL OR p_product_id IS NULL THEN
    RAISE EXCEPTION 'erp_batch_upsert 需要 tenant/product' USING ERRCODE = '23502';
  END IF;
  IF v_batch IS NULL THEN
    RAISE EXCEPTION '批次号不能为空' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.erp_products_s_539dcf81_b p
     WHERE p.id = p_product_id AND p.tenant_id = v_tenant AND p.is_deleted = 'n'
  ) THEN
    RAISE EXCEPTION '物料 % 不存在或不属于当前租户', p_product_id USING ERRCODE = 'P0002';
  END IF;
  -- 两个日期都给了才校验；只给一个时由表级 CHECK 兜底
  IF p_expiry_date IS NOT NULL AND p_production_date IS NOT NULL
     AND p_expiry_date < p_production_date THEN
    RAISE EXCEPTION '效期不能早于生产日期' USING ERRCODE = '23514';
  END IF;

  SELECT b.id INTO v_id
    FROM public.erp_batches_s_539dcf81_b b
   WHERE b.tenant_id = v_tenant AND b.product_id = p_product_id
     AND b.batch_no = v_batch AND b.is_deleted = 'n';

  IF v_id IS NULL THEN
    INSERT INTO public.erp_batches_s_539dcf81_b (
      emp_id, is_deleted, batch_no, product_id, production_date, expiry_date,
      shelf_life_days, supplier_id, supplier_batch_no, source_type,
      qc_status, status, remark, created_by, tenant_id
    ) VALUES (
      p_actor_id::TEXT, 'n', v_batch, p_product_id, p_production_date, p_expiry_date,
      p_shelf_life_days, p_supplier_id, NULLIF(BTRIM(p_supplier_batch_no), ''), 'manual',
      COALESCE(p_qc_status, 'pending'), COALESCE(p_status, 'active'), p_remark,
      p_actor_id, v_tenant
    ) RETURNING id INTO v_id;
    v_created := TRUE;
  ELSIF p_update_existing THEN
    UPDATE public.erp_batches_s_539dcf81_b
       SET production_date   = COALESCE(p_production_date, production_date),
           expiry_date       = COALESCE(p_expiry_date, expiry_date),
           shelf_life_days   = COALESCE(p_shelf_life_days, shelf_life_days),
           supplier_id       = COALESCE(p_supplier_id, supplier_id),
           supplier_batch_no = COALESCE(NULLIF(BTRIM(p_supplier_batch_no), ''), supplier_batch_no),
           qc_status         = COALESCE(p_qc_status, qc_status),
           status            = COALESCE(p_status, status),
           remark            = COALESCE(p_remark, remark),
           updated_at        = NOW()
     WHERE id = v_id;
  END IF;

  RETURN jsonb_build_object(
    'ok', TRUE, 'created', v_created,
    'updated', (NOT v_created AND p_update_existing),
    'id', v_id, 'batch_no', v_batch, 'product_id', p_product_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.erp_batch_upsert(
  BIGINT, INTEGER, TEXT, DATE, DATE, INTEGER, INTEGER, TEXT, TEXT, TEXT, TEXT, INTEGER, BOOLEAN
) TO authenticated;


-- ============================================================================
-- 6. 反向追溯：这个批次（成品）用了哪些料 / 哪一批原料
--    只能靠单据谱系推导 —— 「物料变了」的转换（原料→成品）流水表达不了。
-- ============================================================================
CREATE OR REPLACE FUNCTION public.trace_batch_upstream(
  p_tenant_id  BIGINT,
  p_product_id INTEGER,
  p_batch_no   TEXT,
  p_max_depth  INTEGER DEFAULT 5
) RETURNS TABLE (
  depth              INTEGER,
  product_id         INTEGER,
  product_code       VARCHAR,
  product_name       VARCHAR,
  batch_no           TEXT,
  via                TEXT,
  source_document_no TEXT,
  source_date        DATE,
  quantity           NUMERIC,
  batch_status       VARCHAR,
  qc_status          VARCHAR
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
WITH RECURSIVE up AS (
  -- 起点：被查询的批次本身
  SELECT
    0                                                      AS depth,
    p_product_id                                           AS product_id,
    NULLIF(BTRIM(p_batch_no), '')::TEXT                    AS batch_no,
    'self'::TEXT                                           AS via,
    NULL::TEXT                                             AS source_document_no,
    NULL::DATE                                             AS source_date,
    NULL::NUMERIC                                          AS quantity
  UNION ALL
  SELECT
    u.depth + 1,
    src.product_id,
    src.batch_no,
    src.via,
    src.source_document_no,
    src.source_date,
    src.quantity
  FROM up u
  CROSS JOIN LATERAL (
    -- (a) 生产入库：该批次作为成品出现 → 同一生产订单的领料批次
    SELECT
      mid.material_id        AS product_id,
      BTRIM(mid.batch_no)::TEXT AS batch_no,
      'material_issue'::TEXT    AS via,
      mi.issue_no::TEXT         AS source_document_no,
      mi.issue_date             AS source_date,
      mid.quantity              AS quantity
    FROM public.erp_production_receipts_s_539dcf81_b pr
    JOIN public.erp_material_issues_s_539dcf81_b mi
      ON mi.production_order_id = pr.production_order_id AND mi.is_deleted = 'n'
    JOIN public.erp_material_issue_details_s_539dcf81_b mid
      ON mid.issue_id = mi.id AND mid.is_deleted = 'n'
    WHERE pr.tenant_id = COALESCE(p_tenant_id, current_tenant_id())
      AND pr.is_deleted = 'n'
      AND pr.product_id = u.product_id
      AND COALESCE(NULLIF(BTRIM(pr.batch_no), ''), '') = COALESCE(u.batch_no, '')
      AND mid.batch_no IS NOT NULL AND BTRIM(mid.batch_no) <> ''
    UNION ALL
    -- (b) 委外入库：该批次作为委外成品出现 → 同一委外订单的发料批次
    SELECT
      sid.material_id,
      BTRIM(sid.batch_no)::TEXT,
      'subcontract_issue'::TEXT,
      si.issue_no::TEXT,
      si.issue_date,
      sid.quantity
    FROM public.erp_subcontract_receipts_s_539dcf81_b sr
    JOIN public.erp_subcontract_issues_s_539dcf81_b si
      ON si.order_id = sr.order_id AND si.is_deleted = 'n'
    JOIN public.erp_subcontract_issue_details_s_539dcf81_b sid
      ON sid.issue_id = si.id AND sid.is_deleted = 'n'
    WHERE sr.tenant_id = COALESCE(p_tenant_id, current_tenant_id())
      AND sr.is_deleted = 'n'
      AND sr.product_id = u.product_id
      AND COALESCE(NULLIF(BTRIM(sr.batch_no), ''), '') = COALESCE(u.batch_no, '')
      AND sid.batch_no IS NOT NULL AND BTRIM(sid.batch_no) <> ''
  ) src
  WHERE u.depth < LEAST(COALESCE(p_max_depth, 5), 10)   -- 硬顶 10 层，防数据成环时死循环
    AND u.batch_no IS NOT NULL
)
SELECT
  u.depth,
  u.product_id,
  p.code::VARCHAR  AS product_code,
  p.name::VARCHAR  AS product_name,
  u.batch_no,
  u.via,
  u.source_document_no,
  u.source_date,
  u.quantity,
  b.status::VARCHAR    AS batch_status,
  b.qc_status::VARCHAR AS qc_status
FROM up u
LEFT JOIN public.erp_products_s_539dcf81_b p
       ON p.id = u.product_id AND p.tenant_id = COALESCE(p_tenant_id, current_tenant_id())
LEFT JOIN public.erp_batches_s_539dcf81_b b
       ON b.tenant_id = COALESCE(p_tenant_id, current_tenant_id()) AND b.product_id = u.product_id
      AND b.batch_no = u.batch_no AND b.is_deleted = 'n'
ORDER BY u.depth, u.product_id, u.batch_no;
$$;

GRANT EXECUTE ON FUNCTION public.trace_batch_upstream(BIGINT, INTEGER, TEXT, INTEGER)
  TO authenticated, anon, service_role;


-- ============================================================================
-- 7. 正向追溯：这个批次发给了谁 / 被哪些成品批消耗掉
-- ============================================================================
CREATE OR REPLACE FUNCTION public.trace_batch_downstream(
  p_tenant_id  BIGINT,
  p_product_id INTEGER,
  p_batch_no   TEXT,
  p_max_depth  INTEGER DEFAULT 5
) RETURNS TABLE (
  depth          INTEGER,
  node_type      TEXT,
  product_id     INTEGER,
  product_code   VARCHAR,
  product_name   VARCHAR,
  batch_no       TEXT,
  document_type  TEXT,
  document_no    TEXT,
  document_date  DATE,
  party_name     VARCHAR,
  warehouse_id   INTEGER,
  warehouse_name VARCHAR,
  quantity       NUMERIC,
  unit_cost      NUMERIC
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
WITH RECURSIVE down AS (
  SELECT
    0                                          AS depth,
    'self'::TEXT                               AS node_type,
    p_product_id                               AS product_id,
    NULLIF(BTRIM(p_batch_no), '')::TEXT        AS batch_no,
    NULL::TEXT                                 AS document_type,
    NULL::TEXT                                 AS document_no,
    NULL::DATE                                 AS document_date,
    NULL::TEXT                                 AS party_name,
    NULL::INTEGER                              AS warehouse_id,
    NULL::NUMERIC                              AS quantity,
    NULL::NUMERIC                              AS unit_cost
  UNION ALL
  SELECT
    d.depth + 1,
    x.node_type,
    x.product_id,
    x.batch_no,
    x.document_type,
    x.document_no,
    x.document_date,
    x.party_name,
    x.warehouse_id,
    x.quantity,
    x.unit_cost
  FROM down d
  CROSS JOIN LATERAL (
    -- (a) 出库流水：这批货实际发去了哪里（销售发货→客户、领料→生产订单、其他出库…）
    SELECT
      'issue'::TEXT        AS node_type,
      m.product_id,
      m.batch_no::TEXT,
      m.reference_type::TEXT AS document_type,
      m.document_no::TEXT,
      m.document_date,
      m.party_name::TEXT,
      m.warehouse_id,
      m.quantity,
      m.unit_cost
    FROM public.vw_erp_batch_movement m
    WHERE m.tenant_id = COALESCE(p_tenant_id, current_tenant_id())
      AND m.product_id = d.product_id
      AND m.batch_no = COALESCE(d.batch_no, '')
      AND m.direction = 'out'
    UNION ALL
    -- (b) 被生产领用 → 该生产订单产出的成品批（继续向上/向下递归）
    SELECT
      'product'::TEXT,
      pr.product_id,
      BTRIM(pr.batch_no)::TEXT,
      'production_receipt'::TEXT,
      pr.receipt_no::TEXT,
      pr.receipt_date,
      NULL::TEXT,
      pr.warehouse_id,
      pr.quantity,
      pr.unit_cost
    FROM public.erp_material_issue_details_s_539dcf81_b mid
    JOIN public.erp_material_issues_s_539dcf81_b mi
      ON mi.id = mid.issue_id AND mi.is_deleted = 'n'
    JOIN public.erp_production_receipts_s_539dcf81_b pr
      ON pr.production_order_id = mi.production_order_id AND pr.is_deleted = 'n'
    WHERE mid.is_deleted = 'n'
      AND mid.material_id = d.product_id
      AND BTRIM(mid.batch_no) = COALESCE(d.batch_no, '')
      AND pr.batch_no IS NOT NULL AND BTRIM(pr.batch_no) <> ''
    UNION ALL
    -- (c) 被委外领用 → 委外入库批
    SELECT
      'product'::TEXT,
      sr.product_id,
      BTRIM(sr.batch_no)::TEXT,
      'subcontract_receipt'::TEXT,
      sr.receipt_no::TEXT,
      sr.receipt_date,
      NULL::TEXT,
      sr.warehouse_id,
      sr.quantity,
      sr.unit_cost
    FROM public.erp_subcontract_issue_details_s_539dcf81_b sid
    JOIN public.erp_subcontract_issues_s_539dcf81_b si
      ON si.id = sid.issue_id AND si.is_deleted = 'n'
    JOIN public.erp_subcontract_receipts_s_539dcf81_b sr
      ON sr.order_id = si.order_id AND sr.is_deleted = 'n'
    WHERE sid.is_deleted = 'n'
      AND sid.material_id = d.product_id
      AND BTRIM(sid.batch_no) = COALESCE(d.batch_no, '')
      AND sr.batch_no IS NOT NULL AND BTRIM(sr.batch_no) <> ''
  ) x
  WHERE d.depth < LEAST(COALESCE(p_max_depth, 5), 10)   -- 硬顶 10 层
    AND d.node_type IN ('self', 'product')              -- issue 是终端节点，不再展开
    AND d.batch_no IS NOT NULL
)
SELECT
  d.depth,
  d.node_type,
  d.product_id,
  p.code::VARCHAR AS product_code,
  p.name::VARCHAR AS product_name,
  d.batch_no,
  d.document_type,
  d.document_no,
  d.document_date,
  d.party_name,
  d.warehouse_id,
  w.name::VARCHAR AS warehouse_name,
  d.quantity,
  d.unit_cost
FROM down d
LEFT JOIN public.erp_products_s_539dcf81_b p
       ON p.id = d.product_id AND p.tenant_id = COALESCE(p_tenant_id, current_tenant_id())
LEFT JOIN public.erp_warehouses_s_539dcf81_b w ON w.id = d.warehouse_id
ORDER BY d.depth, d.node_type DESC, d.document_date;
$$;

GRANT EXECUTE ON FUNCTION public.trace_batch_downstream(BIGINT, INTEGER, TEXT, INTEGER)
  TO authenticated, anon, service_role;


-- ============================================================================
-- 8. 视图授权
-- ============================================================================
GRANT SELECT ON public.vw_erp_batch_movement     TO authenticated, anon, service_role;
GRANT SELECT ON public.vw_erp_batch_stock        TO authenticated, anon, service_role;
GRANT SELECT ON public.vw_erp_batch_expiry_alert TO authenticated, anon, service_role;


-- ============================================================================
-- 9. 自检（fail-loud）
-- ============================================================================
DO $$
DECLARE
  v_missing TEXT := '';
  v_body    TEXT;
  v_n       INTEGER;
  v_view    RECORD;
BEGIN
  -- 9.1 核心漏斗：批次四段新逻辑都在（缺一条就说明 CREATE OR REPLACE 被老定义覆盖了）
  SELECT prosrc INTO v_body FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'inventory_apply_move';
  IF v_body IS NULL THEN
    v_missing := v_missing || '缺函数 inventory_apply_move;';
  ELSE
    IF position('已启用批次管理' IN v_body) = 0 THEN
      v_missing := v_missing || 'inventory_apply_move 缺「批次必填」守卫;';
    END IF;
    IF position('已被冻结' IN v_body) = 0 THEN
      v_missing := v_missing || 'inventory_apply_move 缺「批次冻结」守卫;';
    END IF;
    IF position('erp_batches_s_539dcf81_b' IN v_body) = 0 OR position('ON CONFLICT' IN v_body) = 0 THEN
      v_missing := v_missing || 'inventory_apply_move 缺批次档案自动建档（ON CONFLICT）;';
    END IF;
    IF position('v_expiry' IN v_body) = 0 THEN
      v_missing := v_missing || 'inventory_apply_move 缺效期补全变量;';
    END IF;
  END IF;

  -- 9.2 批次建档 RPC（且租户是「解析」出来的，前端传 null 也能用）
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'erp_batch_upsert';
  IF COALESCE(v_n, 0) <> 1 THEN
    v_missing := v_missing || '缺函数 erp_batch_upsert;';
  END IF;
  SELECT prosrc INTO v_body FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'erp_batch_upsert';
  IF v_body IS NULL OR position('current_tenant_id()' IN v_body) = 0 THEN
    v_missing := v_missing || 'erp_batch_upsert 未按 current_tenant_id() 解析租户（前端传 null 会整页不可用）;';
  END IF;

  -- 9.3 两个追溯 RPC，且都带深度硬顶
  FOR v_view IN
    SELECT * FROM (VALUES ('trace_batch_upstream'), ('trace_batch_downstream')) AS x(name)
  LOOP
    SELECT prosrc INTO v_body FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_view.name;
    IF v_body IS NULL THEN
      v_missing := v_missing || format('缺函数 %s;', v_view.name);
    ELSIF position('LEAST(COALESCE(p_max_depth, 5), 10)' IN v_body) = 0 THEN
      v_missing := v_missing || format('%s 缺递归深度硬顶;', v_view.name);
    END IF;
  END LOOP;

  -- 9.4 三个视图：存在 + security_invoker + 关键列
  FOR v_view IN
    SELECT * FROM (VALUES
      ('vw_erp_batch_movement',     'party_name'),
      ('vw_erp_batch_stock',        'days_to_expiry'),
      ('vw_erp_batch_expiry_alert', 'expiry_state')
    ) AS x(name, probe)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = v_view.name AND c.relkind = 'v'
    ) THEN
      v_missing := v_missing || format('缺视图 %s;', v_view.name);
      CONTINUE;
    END IF;

    SELECT count(*) INTO v_n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = v_view.name
       AND c.reloptions::TEXT ILIKE '%security_invoker=true%';
    IF COALESCE(v_n, 0) <> 1 THEN
      v_missing := v_missing || format('%s 不是 security_invoker=true（会成为绕过租户隔离的后门）;', v_view.name);
    END IF;

    SELECT count(*) INTO v_n FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = v_view.name
       AND column_name = v_view.probe;
    IF COALESCE(v_n, 0) <> 1 THEN
      v_missing := v_missing || format('%s 缺列 %s;', v_view.name, v_view.probe);
    END IF;
  END LOOP;

  -- 9.5 批次流水视图必须能翻出「往来对象」和「来源单据号」（追溯的可读性全靠它们）
  SELECT count(*) INTO v_n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'vw_erp_batch_movement'
     AND column_name IN ('document_no', 'document_date', 'direction', 'batch_no');
  IF COALESCE(v_n, 0) <> 4 THEN
    v_missing := v_missing || format('vw_erp_batch_movement 的关键列只到 %s/4;', v_n);
  END IF;

  -- 9.6 物料批次开关仍在（后置检查，防止别的迁移把它冲掉）
  SELECT count(*) INTO v_n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'erp_products_s_539dcf81_b'
     AND column_name = 'is_batch_managed';
  IF COALESCE(v_n, 0) <> 1 THEN
    v_missing := v_missing || 'erp_products 的 is_batch_managed 不见了;';
  END IF;

  IF v_missing <> '' THEN
    RAISE EXCEPTION 'deploy_107 自检失败：%', v_missing;
  END IF;

  RAISE NOTICE 'deploy_107 OK：apply_move 批次四段逻辑 / 3 视图 / 3 RPC 就绪';
END;
$$;
