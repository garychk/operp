-- ============================================================================
-- P2-11：其他出入库单 / 期初库存 过账与反过账 RPC
-- ============================================================================
--
-- 表结构与配置在 deploy_104。本文件是这两种单据**唯一的业务逻辑入口**。
--
-- 提供的对象
-- ----------
--   resolve_other_stock_transaction_type(business_type, direction)  业务类型 → 交易类型
--   post_other_stock_document                                       其他出入库过账
--   reverse_other_stock_document                                    其他出入库反过账
--   post_opening_balance_document                                   期初库存过账
--   reverse_opening_balance_document                                期初库存反过账
--
-- 同时修正两个上游对象（都只改函数体 / 视图定义，签名不变）
-- ------------------------------------------------------------
--   ① inventory_voucher_plan —— 补 5 条科目兜底（其他出入库 4 种 + 期初 1 条）。
--      ⚠️ 本函数在 deploy_87 首次定义、deploy_92 与 deploy_103 各覆盖过一次，
--         **本文件是它的最新定义**。它是「未配映射时的内置兜底」，
--         新租户没有 erp_inventory_subject_map 行时完全依赖它 ——
--         漏掉这里的任何一条，对应业务就会**静默不生成凭证**。
--         deploy_103 的内容在本文件里完整保留（委外那三条一条不少）。
--   ② vw_erp_inventory_summary —— 把「期初录入」从「本期收发」里拆出来。
--      理由见下。
--
-- 为什么必须改 vw_erp_inventory_summary
-- -------------------------------------
--   A6 要的不只是「能录期初」，还要「报表里分得清期初与本期发生额」。
--   期初录入写出来的是正数量的库存流水（quantity > 0），若沿用原口径
--   会被算进「本期收入」→ 收发存表的期初永远是 0、本期收入虚高，
--   客户根本看不出期初是多少。
--   改法：monthly CTE 里把 transaction_type 为 opening_balance_in/out 的行
--        单独累计成 opening_input_qty / opening_input_amount，
--        in_qty / out_qty / in_amount / out_amount 一律排除这两类；
--        期初 = 之前各月净额累计 + **本月的期初录入**（期初录入落在它自己的期间）；
--        期末 = 期初 + 本期收 - 本期发。
--
--   ⚠️ 这次改动对既有断言**零影响**：在 deploy_104 之前，全库没有任何代码路径
--     写 opening_balance_in/out（deploy_40 只建了字典行），所以历史数据里
--     这两类的条数恒为 0，排除它们不改变任何一行数字。
--     verify-96 / verify-99 对本期收发金额的断言因此保持不变。
--
-- 校验口径（哪些抛错、哪些只是警告）
-- ----------------------------------
--   其他出入库 —— 抛错：单据不存在 / 状态不允许 / 方向非法 / 无明细 /
--                       数量非正 / 目标仓库不存在 /
--                       其他入库未填单价且该物料在此仓库尚无有成本库存 /
--                       超发到负库存（由 apply_move 兜底）
--                警告：入库状态与「入库即待检」配置不一致（warnings 数组）
--   期初库存 —— 抛错：单据不存在 / 状态不允许 / 无明细 / 数量非正 /
--                     单价非正（**0 成本期初必拒**）/ 该仓库已有已过账期初单
--                警告：该物料在该仓库已有库存（会与现有库存合并计价）
--
-- 库存与预占
-- ----------
--   * 所有库存行变更一律经 `inventory_apply_move()`，不直接 UPDATE erp_inventory。
--   * 其他出库**先消耗预占、再扣库存**（顺序反了会误判超发，见 deploy_93 头注 ③）。
--   * 期初入库只增不减，不走预占。
--
-- 本脚本由 000_run_all 用 psql --single-transaction 执行，**不要写 BEGIN/COMMIT**。
-- 依赖：deploy_104（表与配置）、deploy_88（唯一入口 / 预占 / 入库状态）、
--       deploy_87（凭证助手）、deploy_93（过账骨架与口径）、deploy_96（报表视图）。
-- ============================================================================


-- ============================================================================
-- 1. 业务类型 → 交易类型
--    这是「其他出入库」区别于「库存调整」的核心：不同用途落不同对方科目。
--      scrap  报废 → scrap_out          借 6711 营业外支出 / 贷 库存商品
--      loss   损耗 → other_loss_out     借 6602 管理费用   / 贷 库存商品
--      gift/sample/lending 赠出/借出 → other_issue_out  借 1901 / 贷 库存商品
--      其余（lending_return 归还 / overturn 盘盈 / other / 未登记取值）
--           按方向落默认：in → other_receipt_in，out → other_issue_out
--    未登记的 business_type **不抛错**，按方向兜底 ——
--    「其他出入库」本身就是给计划外业务用的，把未知取值挡在门外没有意义，
--    但方向必须正确，否则借贷会反过来。
-- ============================================================================
CREATE OR REPLACE FUNCTION public.resolve_other_stock_transaction_type(
  p_business_type TEXT,
  p_direction     TEXT
) RETURNS TEXT
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_temp
AS $function$
  SELECT CASE
    WHEN LOWER(COALESCE(NULLIF(BTRIM(p_business_type), ''), 'other')) = 'scrap'
      THEN 'scrap_out'
    WHEN LOWER(COALESCE(NULLIF(BTRIM(p_business_type), ''), 'other')) = 'loss'
      THEN 'other_loss_out'
    ELSE CASE WHEN LOWER(COALESCE(p_direction, 'in')) = 'out'
              THEN 'other_issue_out'
              ELSE 'other_receipt_in' END
  END;
$function$;

COMMENT ON FUNCTION public.resolve_other_stock_transaction_type(TEXT, TEXT) IS
  '其他出入库：业务类型 + 方向 → 库存交易类型。报废/损耗单独落到营业外支出与管理费用，其余按方向兜底。';

GRANT EXECUTE ON FUNCTION public.resolve_other_stock_transaction_type(TEXT, TEXT) TO authenticated;


-- ============================================================================
-- 2. post_other_stock_document：其他入库 / 其他出库
--    方向在表头（h.direction），明细行方向一律跟随表头 ——
--    这一点与「库存调整」（明细行各自带 direction）不同，别混用。
-- ============================================================================
CREATE OR REPLACE FUNCTION public.post_other_stock_document(
  p_document_type   TEXT,
  p_document_id     INTEGER,
  p_idempotency_key UUID
) RETURNS JSONB
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  h RECORD;
  d RECORD;
  actor_id INTEGER;
  line_count INTEGER := 0;
  v_batch TEXT;
  v_status TEXT;
  v_receipt_status TEXT;
  v_allow_negative BOOLEAN;
  v_txn_type TEXT;
  v_inv_unit_cost NUMERIC;
  v_unit_cost NUMERIC;
  v_move JSONB;
  v_cost_delta NUMERIC;
  v_total_cost NUMERIC := 0;
  v_voucher JSONB;
  v_warnings TEXT[] := ARRAY[]::TEXT[];
BEGIN
  IF p_document_type IS DISTINCT FROM 'other_stock_document' THEN
    RAISE EXCEPTION 'Unsupported document type for post_other_stock_document: %', p_document_type
      USING ERRCODE = '22023';
  END IF;
  IF p_document_id IS NULL OR p_document_id <= 0 OR p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'A positive document ID and idempotency key are required'
      USING ERRCODE = '22023';
  END IF;
  actor_id := public.current_sys_user_id();

  SELECT * INTO h FROM public.erp_other_stock_documents_s_539dcf81_b
   WHERE id = p_document_id AND is_deleted = 'n' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Other stock document does not exist or is deleted'
      USING ERRCODE = 'P0002';
  END IF;
  IF h.status = 'posted' AND h.posting_idempotency_key = p_idempotency_key THEN
    RETURN jsonb_build_object('ok', TRUE, 'idempotent', TRUE,
      'document_type', p_document_type, 'document_id', p_document_id, 'status', 'posted');
  END IF;
  IF h.status <> 'approved' THEN
    RAISE EXCEPTION 'Only approved documents can be posted; current status: %',
      COALESCE(h.status, '<null>') USING ERRCODE = '55000';
  END IF;
  -- 表上已有 CHECK，这里再判一次是为了给出带方向/单号的可读错误
  IF h.direction NOT IN ('in', 'out') THEN
    RAISE EXCEPTION 'Other stock document % has an illegal direction: %',
      h.document_no, COALESCE(h.direction, '<null>') USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(w.is_negative_stock_allowed, FALSE) INTO v_allow_negative
    FROM public.erp_warehouses_s_539dcf81_b w
   WHERE w.id = h.warehouse_id AND w.tenant_id = h.tenant_id AND w.is_deleted = 'n'
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Warehouse does not exist or is deleted' USING ERRCODE = 'P0002';
  END IF;

  v_txn_type      := public.resolve_other_stock_transaction_type(h.business_type, h.direction);
  v_receipt_status := public.inventory_receipt_stock_status(h.tenant_id);

  FOR d IN
    SELECT * FROM public.erp_other_stock_document_details_s_539dcf81_b
     WHERE document_id = p_document_id AND is_deleted = 'n'
     ORDER BY line_no
  LOOP
    line_count := line_count + 1;
    IF COALESCE(d.quantity, 0) <= 0 THEN
      RAISE EXCEPTION '其他出入库单第 % 行数量必须为正（当前 %）', d.line_no, d.quantity
        USING ERRCODE = '23514';
    END IF;
    v_batch  := NULLIF(BTRIM(d.batch_no), '');
    v_status := LOWER(COALESCE(NULLIF(BTRIM(d.stock_status), ''), 'available'));

    -- 现有库存的移动加权单价：出库必须用它；入库在单据未填价时也用它
    SELECT COALESCE(x.unit_cost, 0) INTO v_inv_unit_cost
      FROM public.erp_inventory_s_539dcf81_b x
     WHERE x.product_id = d.product_id AND x.warehouse_id = h.warehouse_id
       AND x.tenant_id = h.tenant_id
       AND COALESCE(x.location_id, 0) = COALESCE(COALESCE(d.location_id, h.location_id), 0)
       AND COALESCE(NULLIF(BTRIM(x.batch_no), ''), '') = COALESCE(v_batch, '')
       AND x.stock_status = v_status AND x.is_deleted = 'n';
    IF NOT FOUND THEN v_inv_unit_cost := 0; END IF;

    IF h.direction = 'out' THEN
      -- 先释放预占、再扣库存（顺序反了会把「本次出库正是在消耗自己的预占」误判成超发）
      IF v_status = 'available' THEN
        PERFORM public.inventory_consume_reservations(
          h.tenant_id, d.product_id, h.warehouse_id,
          COALESCE(d.location_id, h.location_id), v_batch, v_status, d.quantity);
      END IF;
      v_unit_cost := COALESCE(NULLIF(v_inv_unit_cost, 0), NULLIF(d.unit_cost, 0), 0);
    ELSE
      v_unit_cost := COALESCE(NULLIF(d.unit_cost, 0), NULLIF(v_inv_unit_cost, 0), 0);
      -- 0 成本入库会让 apply_move 把 v_unit_cost 取成 0，把移动加权单价永久拉低，
      -- 而且**全程不报错** —— 宁可拦住不给过。
      IF v_unit_cost <= 0 THEN
        RAISE EXCEPTION
          '其他入库单第 % 行未填单价，且该物料在此仓库尚无有成本的库存。以 0 成本入库会把移动加权单价永久拉低且不报错，故拒绝过账（赠品请按公允价值填单价）',
          d.line_no USING ERRCODE = '23514';
      END IF;
      IF v_status <> v_receipt_status THEN
        v_warnings := v_warnings || format(
          '第 %s 行入库状态为 %s，与「入库即待检」配置(%s)不一致',
          d.line_no, v_status, v_receipt_status);
      END IF;
    END IF;

    v_move := public.inventory_apply_move(
      p_tenant_id      => h.tenant_id,
      p_corp_id        => h.corp_id,
      p_actor_id       => actor_id,
      p_product_id     => d.product_id,
      p_warehouse_id   => h.warehouse_id,
      p_location_id    => COALESCE(d.location_id, h.location_id),
      p_batch_no       => v_batch,
      p_stock_status   => v_status,
      p_qty_delta      => CASE WHEN h.direction = 'out' THEN -d.quantity ELSE d.quantity END,
      p_unit_cost      => v_unit_cost,
      p_cost_delta     => NULL,
      p_expiry_date    => d.expiry_date,
      p_allow_negative => v_allow_negative);
    v_unit_cost  := COALESCE((v_move ->> 'unit_cost')::NUMERIC, v_unit_cost);
    v_cost_delta := COALESCE((v_move ->> 'cost_delta')::NUMERIC, 0);
    v_total_cost := v_total_cost + ABS(v_cost_delta);

    INSERT INTO public.erp_inventory_transactions_s_539dcf81_b (
      corp_id, emp_id, is_deleted, transaction_no, transaction_type, transaction_date,
      product_id, warehouse_id, location_id, batch_no, stock_status, quantity,
      unit_cost, total_cost, reference_type, reference_id, reference_detail_id,
      posting_idempotency_key, remark, tenant_id
    ) VALUES (
      h.corp_id, actor_id::TEXT, 'n',
      LEFT('IT' || TO_CHAR(clock_timestamp(), 'YYYYMMDDHH24MISSMS')
           || LPAD(d.id::TEXT, 6, '0'), 50),
      v_txn_type,
      h.document_date, d.product_id, h.warehouse_id,
      COALESCE(d.location_id, h.location_id), v_batch, v_status,
      CASE WHEN h.direction = 'out' THEN -d.quantity ELSE d.quantity END,
      v_unit_cost, v_cost_delta,
      'other_stock_document', p_document_id, d.id, p_idempotency_key,
      format('其他%s（业务类型 %s）',
             CASE WHEN h.direction = 'out' THEN '出库' ELSE '入库' END,
             COALESCE(NULLIF(BTRIM(h.business_type), ''), 'other')),
      h.tenant_id);
  END LOOP;

  IF line_count = 0 THEN
    RAISE EXCEPTION 'No detail rows found for document' USING ERRCODE = 'P0002';
  END IF;

  UPDATE public.erp_other_stock_documents_s_539dcf81_b
     SET status = 'posted',
         posted_at = NOW(),
         posting_idempotency_key = p_idempotency_key,
         reversal_idempotency_key = NULL,
         reversed_at = NULL,
         total_cost = v_total_cost,
         updated_at = NOW()
   WHERE id = p_document_id;

  v_voucher := public.inventory_sync_voucher(
    p_source_type   => 'other_stock_document',
    p_source_id     => p_document_id,
    p_document_no   => h.document_no,
    p_document_date => h.document_date,
    p_tenant_id     => h.tenant_id,
    p_remark        => format('其他%s %s（业务类型 %s）',
      CASE WHEN h.direction = 'out' THEN '出库' ELSE '入库' END,
      h.document_no, COALESCE(NULLIF(BTRIM(h.business_type), ''), 'other')));

  RETURN jsonb_build_object(
    'ok', TRUE, 'document_type', p_document_type, 'document_id', p_document_id,
    'document_no', h.document_no, 'status', 'posted', 'line_count', line_count,
    'direction', h.direction, 'business_type', h.business_type,
    'transaction_type', v_txn_type, 'total_cost', v_total_cost,
    'warnings', to_jsonb(v_warnings),
    'voucher', v_voucher);
END;
$function$;

COMMENT ON FUNCTION public.post_other_stock_document(TEXT, INTEGER, UUID) IS
  '其他入库/其他出库过账：按 business_type 决定交易类型（报废→6711、损耗→6602、借出/赠出→1901），
  所有库存变更经 inventory_apply_move；出库先消耗预占再扣量；入库 0 成本直接拒绝。';

GRANT EXECUTE ON FUNCTION public.post_other_stock_document(TEXT, INTEGER, UUID) TO authenticated;


-- ============================================================================
-- 3. reverse_other_stock_document：其他出入库反过账
--    与 reverse_inventory_document 同构：逐条流水反向 apply_move →
--    软删流水 → 单据退回 approved（可改后重过）→ 作废凭证。
--    「减去本笔流水」= 撤销它的影响，方向自动正确，不需要判 in/out。
-- ============================================================================
CREATE OR REPLACE FUNCTION public.reverse_other_stock_document(
  p_document_type   TEXT,
  p_document_id     INTEGER,
  p_idempotency_key UUID
) RETURNS JSONB
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  h RECORD;
  t RECORD;
  actor_id INTEGER;
  line_count INTEGER := 0;
  v_ref_types TEXT[];
  v_target_status TEXT;
  v_move JSONB;
  v_voucher_result JSONB;
BEGIN
  IF p_document_type IS DISTINCT FROM 'other_stock_document' THEN
    RAISE EXCEPTION 'Unsupported document type for reverse_other_stock_document: %', p_document_type
      USING ERRCODE = '22023';
  END IF;
  IF p_document_id IS NULL OR p_document_id <= 0 OR p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'A positive document ID and idempotency key are required'
      USING ERRCODE = '22023';
  END IF;
  actor_id := public.current_sys_user_id();

  SELECT * INTO h FROM public.erp_other_stock_documents_s_539dcf81_b
   WHERE id = p_document_id AND is_deleted = 'n' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Other stock document does not exist or is deleted'
      USING ERRCODE = 'P0002';
  END IF;

  IF h.status = 'approved' AND h.reversal_idempotency_key = p_idempotency_key THEN
    RETURN jsonb_build_object('ok', TRUE, 'idempotent', TRUE,
      'document_type', p_document_type, 'document_id', p_document_id, 'status', 'approved');
  END IF;
  IF h.status <> 'posted' THEN
    RAISE EXCEPTION 'Only posted documents can be reversed; current status: %',
      COALESCE(h.status, '<null>') USING ERRCODE = '55000';
  END IF;

  v_ref_types := public.inventory_document_ref_types(p_document_type);

  IF NOT EXISTS (
    SELECT 1 FROM public.erp_inventory_transactions_s_539dcf81_b x
     WHERE x.reference_type = ANY (v_ref_types)
       AND x.reference_id = p_document_id AND x.is_deleted = 'n'
  ) THEN
    RAISE EXCEPTION 'No active inventory transactions found for % #% — 单据状态是 posted 但没有对应流水，请人工核对',
      p_document_type, p_document_id USING ERRCODE = 'P0002';
  END IF;

  FOR t IN
    SELECT x.* FROM public.erp_inventory_transactions_s_539dcf81_b x
     WHERE x.reference_type = ANY (v_ref_types)
       AND x.reference_id = p_document_id
       AND x.is_deleted = 'n'
     ORDER BY x.product_id, x.warehouse_id,
              x.location_id NULLS FIRST, x.batch_no NULLS FIRST,
              COALESCE(x.stock_status, 'available'), x.id
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
  END LOOP;

  UPDATE public.erp_inventory_transactions_s_539dcf81_b
     SET is_deleted = 'y',
         reversal_idempotency_key = p_idempotency_key,
         reversed_at = NOW(),
         updated_at = NOW()
   WHERE reference_type = ANY (v_ref_types)
     AND reference_id = p_document_id
     AND is_deleted = 'n';

  UPDATE public.erp_other_stock_documents_s_539dcf81_b
     SET status = 'approved',
         reversal_idempotency_key = p_idempotency_key,
         reversed_at = NOW(),
         updated_at = NOW()
   WHERE id = p_document_id;

  v_voucher_result := public.inventory_void_voucher(
    p_source_type     => 'other_stock_document',
    p_source_id       => p_document_id,
    p_tenant_id       => h.tenant_id,
    p_idempotency_key => p_idempotency_key);

  RETURN jsonb_build_object(
    'ok', TRUE, 'idempotent', FALSE,
    'document_type', p_document_type, 'document_id', p_document_id,
    'document_no', h.document_no, 'status', 'approved', 'line_count', line_count,
    'voucher', v_voucher_result,
    'idempotency_key', p_idempotency_key);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.reverse_other_stock_document(TEXT, INTEGER, UUID) TO authenticated;


-- ============================================================================
-- 4. post_opening_balance_document：期初库存建账
--    与其余过账 RPC 的三点不同，都是有意的：
--      ① 单价必填且 > 0。0 成本期初会把该物料此后所有出库的移动加权一起拉低，
--         且不报任何错 —— 这是最贵的一种「安静的错误」，必须在入口拦住。
--      ② 同一仓库同时只允许一份已过账的期初（表上有部分唯一索引兜底 +
--         这里先给一个可读的错误）。
--      ③ 默认**不生成凭证**：期初是余额不是本期发生额（见 deploy_104 头注 3）。
--         走 inventory_sync_voucher 而不是直接跳过，是为了让「客户把
--         generate_voucher 打开」时能真的出凭证 —— 返回值里会带
--         skipped_reason = 'no_voucher_required'，与配错科目导致的
--         subject_not_found 明确区分。
-- ============================================================================
CREATE OR REPLACE FUNCTION public.post_opening_balance_document(
  p_document_type   TEXT,
  p_document_id     INTEGER,
  p_idempotency_key UUID
) RETURNS JSONB
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  h RECORD;
  d RECORD;
  actor_id INTEGER;
  line_count INTEGER := 0;
  v_batch TEXT;
  v_status TEXT;
  v_allow_negative BOOLEAN;
  v_move JSONB;
  v_cost_delta NUMERIC;
  v_total_qty NUMERIC := 0;
  v_total_cost NUMERIC := 0;
  v_voucher JSONB;
  v_warnings TEXT[] := ARRAY[]::TEXT[];
BEGIN
  IF p_document_type IS DISTINCT FROM 'opening_balance' THEN
    RAISE EXCEPTION 'Unsupported document type for post_opening_balance_document: %', p_document_type
      USING ERRCODE = '22023';
  END IF;
  IF p_document_id IS NULL OR p_document_id <= 0 OR p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'A positive document ID and idempotency key are required'
      USING ERRCODE = '22023';
  END IF;
  actor_id := public.current_sys_user_id();

  SELECT * INTO h FROM public.erp_opening_balances_s_539dcf81_b
   WHERE id = p_document_id AND is_deleted = 'n' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Opening balance document does not exist or is deleted'
      USING ERRCODE = 'P0002';
  END IF;
  IF h.status = 'posted' AND h.posting_idempotency_key = p_idempotency_key THEN
    RETURN jsonb_build_object('ok', TRUE, 'idempotent', TRUE,
      'document_type', p_document_type, 'document_id', p_document_id, 'status', 'posted');
  END IF;
  IF h.status <> 'approved' THEN
    RAISE EXCEPTION 'Only approved documents can be posted; current status: %',
      COALESCE(h.status, '<null>') USING ERRCODE = '55000';
  END IF;

  -- 同一仓库只能有一份已过账期初：先给可读错误，避免直接撞部分唯一索引的 23505
  IF EXISTS (
    SELECT 1 FROM public.erp_opening_balances_s_539dcf81_b o
     WHERE o.tenant_id = h.tenant_id AND o.warehouse_id = h.warehouse_id
       AND o.status = 'posted' AND o.is_deleted = 'n' AND o.id <> p_document_id
  ) THEN
    RAISE EXCEPTION 'Warehouse % already has a posted opening balance (%); reverse it first',
      h.warehouse_id,
      (SELECT o.document_no FROM public.erp_opening_balances_s_539dcf81_b o
        WHERE o.tenant_id = h.tenant_id AND o.warehouse_id = h.warehouse_id
          AND o.status = 'posted' AND o.is_deleted = 'n' AND o.id <> p_document_id
        ORDER BY o.id LIMIT 1)
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(w.is_negative_stock_allowed, FALSE) INTO v_allow_negative
    FROM public.erp_warehouses_s_539dcf81_b w
   WHERE w.id = h.warehouse_id AND w.tenant_id = h.tenant_id AND w.is_deleted = 'n'
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Warehouse does not exist or is deleted' USING ERRCODE = 'P0002';
  END IF;

  FOR d IN
    SELECT * FROM public.erp_opening_balance_details_s_539dcf81_b
     WHERE document_id = p_document_id AND is_deleted = 'n'
     ORDER BY line_no
  LOOP
    line_count := line_count + 1;
    IF COALESCE(d.quantity, 0) <= 0 THEN
      RAISE EXCEPTION '期初库存第 % 行数量必须为正（当前 %）', d.line_no, d.quantity
        USING ERRCODE = '23514';
    END IF;
    IF COALESCE(d.unit_cost, 0) <= 0 THEN
      RAISE EXCEPTION
        '期初库存第 % 行单价必须为正（当前 %）。0 成本期初会把该物料此后所有出库的移动加权单价一起拉低，且全程不报错，故拒绝过账',
        d.line_no, COALESCE(d.unit_cost, 0) USING ERRCODE = '23514';
    END IF;
    v_batch  := NULLIF(BTRIM(d.batch_no), '');
    v_status := LOWER(COALESCE(NULLIF(BTRIM(d.stock_status), ''), 'available'));

    IF EXISTS (
      SELECT 1 FROM public.erp_inventory_s_539dcf81_b x
       WHERE x.product_id = d.product_id AND x.warehouse_id = h.warehouse_id
         AND x.tenant_id = h.tenant_id
         AND COALESCE(x.location_id, 0) = COALESCE(COALESCE(d.location_id, h.location_id), 0)
         AND COALESCE(NULLIF(BTRIM(x.batch_no), ''), '') = COALESCE(v_batch, '')
         AND x.stock_status = v_status AND x.is_deleted = 'n'
         AND COALESCE(x.quantity, 0) <> 0
    ) THEN
      v_warnings := v_warnings || format(
        '第 %s 行：该物料在此仓库同库位/批次已有库存，期初将与现有库存合并计价', d.line_no);
    END IF;

    v_move := public.inventory_apply_move(
      p_tenant_id      => h.tenant_id,
      p_corp_id        => h.corp_id,
      p_actor_id       => actor_id,
      p_product_id     => d.product_id,
      p_warehouse_id   => h.warehouse_id,
      p_location_id    => COALESCE(d.location_id, h.location_id),
      p_batch_no       => v_batch,
      p_stock_status   => v_status,
      p_qty_delta      => d.quantity,
      p_unit_cost      => d.unit_cost,
      p_cost_delta     => NULL,
      p_expiry_date    => d.expiry_date,
      p_allow_negative => v_allow_negative);
    v_cost_delta := COALESCE((v_move ->> 'cost_delta')::NUMERIC, 0);
    v_total_qty  := v_total_qty + d.quantity;
    v_total_cost := v_total_cost + ABS(v_cost_delta);

    INSERT INTO public.erp_inventory_transactions_s_539dcf81_b (
      corp_id, emp_id, is_deleted, transaction_no, transaction_type, transaction_date,
      product_id, warehouse_id, location_id, batch_no, stock_status, quantity,
      unit_cost, total_cost, reference_type, reference_id, reference_detail_id,
      posting_idempotency_key, remark, tenant_id
    ) VALUES (
      h.corp_id, actor_id::TEXT, 'n',
      LEFT('IT' || TO_CHAR(clock_timestamp(), 'YYYYMMDDHH24MISSMS')
           || LPAD(d.id::TEXT, 6, '0'), 50),
      'opening_balance_in',
      h.document_date, d.product_id, h.warehouse_id,
      COALESCE(d.location_id, h.location_id), v_batch, v_status,
      d.quantity, d.unit_cost, v_cost_delta,
      'opening_balance', p_document_id, d.id, p_idempotency_key,
      '期初库存建账', h.tenant_id);
  END LOOP;

  IF line_count = 0 THEN
    RAISE EXCEPTION 'No detail rows found for document' USING ERRCODE = 'P0002';
  END IF;

  UPDATE public.erp_opening_balances_s_539dcf81_b
     SET status = 'posted',
         posted_at = NOW(),
         posting_idempotency_key = p_idempotency_key,
         reversal_idempotency_key = NULL,
         reversed_at = NULL,
         total_quantity = v_total_qty,
         total_cost = v_total_cost,
         updated_at = NOW()
   WHERE id = p_document_id;

  v_voucher := public.inventory_sync_voucher(
    p_source_type   => 'opening_balance',
    p_source_id     => p_document_id,
    p_document_no   => h.document_no,
    p_document_date => h.document_date,
    p_tenant_id     => h.tenant_id,
    p_remark        => format('期初库存建账 %s', h.document_no));

  RETURN jsonb_build_object(
    'ok', TRUE, 'document_type', p_document_type, 'document_id', p_document_id,
    'document_no', h.document_no, 'status', 'posted', 'line_count', line_count,
    'total_quantity', v_total_qty, 'total_cost', v_total_cost,
    'warnings', to_jsonb(v_warnings),
    'voucher', v_voucher,
    'voucher_note', '期初是余额而非本期发生额，默认不进总账（存货科目映射里 generate_voucher=FALSE）');
END;
$function$;

COMMENT ON FUNCTION public.post_opening_balance_document(TEXT, INTEGER, UUID) IS
  '期初库存建账：单价强制 > 0；同一仓库仅允许一份已过账期初；默认不生成凭证（期初是余额不是发生额）。';

GRANT EXECUTE ON FUNCTION public.post_opening_balance_document(TEXT, INTEGER, UUID) TO authenticated;


-- ============================================================================
-- 5. reverse_opening_balance_document：期初库存反过账
--    反过账后单据退回 approved（唯一索引随之释放，可以改完重过）。
-- ============================================================================
CREATE OR REPLACE FUNCTION public.reverse_opening_balance_document(
  p_document_type   TEXT,
  p_document_id     INTEGER,
  p_idempotency_key UUID
) RETURNS JSONB
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  h RECORD;
  t RECORD;
  actor_id INTEGER;
  line_count INTEGER := 0;
  v_ref_types TEXT[];
  v_target_status TEXT;
  v_move JSONB;
  v_voucher_result JSONB;
BEGIN
  IF p_document_type IS DISTINCT FROM 'opening_balance' THEN
    RAISE EXCEPTION 'Unsupported document type for reverse_opening_balance_document: %', p_document_type
      USING ERRCODE = '22023';
  END IF;
  IF p_document_id IS NULL OR p_document_id <= 0 OR p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'A positive document ID and idempotency key are required'
      USING ERRCODE = '22023';
  END IF;
  actor_id := public.current_sys_user_id();

  SELECT * INTO h FROM public.erp_opening_balances_s_539dcf81_b
   WHERE id = p_document_id AND is_deleted = 'n' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Opening balance document does not exist or is deleted'
      USING ERRCODE = 'P0002';
  END IF;

  IF h.status = 'approved' AND h.reversal_idempotency_key = p_idempotency_key THEN
    RETURN jsonb_build_object('ok', TRUE, 'idempotent', TRUE,
      'document_type', p_document_type, 'document_id', p_document_id, 'status', 'approved');
  END IF;
  IF h.status <> 'posted' THEN
    RAISE EXCEPTION 'Only posted documents can be reversed; current status: %',
      COALESCE(h.status, '<null>') USING ERRCODE = '55000';
  END IF;

  v_ref_types := public.inventory_document_ref_types(p_document_type);

  IF NOT EXISTS (
    SELECT 1 FROM public.erp_inventory_transactions_s_539dcf81_b x
     WHERE x.reference_type = ANY (v_ref_types)
       AND x.reference_id = p_document_id AND x.is_deleted = 'n'
  ) THEN
    RAISE EXCEPTION 'No active inventory transactions found for % #% — 单据状态是 posted 但没有对应流水，请人工核对',
      p_document_type, p_document_id USING ERRCODE = 'P0002';
  END IF;

  FOR t IN
    SELECT x.* FROM public.erp_inventory_transactions_s_539dcf81_b x
     WHERE x.reference_type = ANY (v_ref_types)
       AND x.reference_id = p_document_id
       AND x.is_deleted = 'n'
     ORDER BY x.product_id, x.warehouse_id,
              x.location_id NULLS FIRST, x.batch_no NULLS FIRST,
              COALESCE(x.stock_status, 'available'), x.id
     FOR UPDATE
  LOOP
    line_count := line_count + 1;
    v_target_status := COALESCE(NULLIF(BTRIM(t.stock_status), ''), 'available');

    -- 期初反过账 = 把这笔期初加进来的量减回去。
    -- 若期初之后已经发生过其他出入库，这里可能触发负库存守卫 —— 那是**正确**的拦截：
    -- 先反过账期初再改数量会破坏后续出库的成本基础，应当先冲掉后续单据。
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

  UPDATE public.erp_inventory_transactions_s_539dcf81_b
     SET is_deleted = 'y',
         reversal_idempotency_key = p_idempotency_key,
         reversed_at = NOW(),
         updated_at = NOW()
   WHERE reference_type = ANY (v_ref_types)
     AND reference_id = p_document_id
     AND is_deleted = 'n';

  UPDATE public.erp_opening_balances_s_539dcf81_b
     SET status = 'approved',
         reversal_idempotency_key = p_idempotency_key,
         reversed_at = NOW(),
         updated_at = NOW()
   WHERE id = p_document_id;

  v_voucher_result := public.inventory_void_voucher(
    p_source_type     => 'opening_balance',
    p_source_id       => p_document_id,
    p_tenant_id       => h.tenant_id,
    p_idempotency_key => p_idempotency_key);

  RETURN jsonb_build_object(
    'ok', TRUE, 'idempotent', FALSE,
    'document_type', p_document_type, 'document_id', p_document_id,
    'document_no', h.document_no, 'status', 'approved', 'line_count', line_count,
    'voucher', v_voucher_result,
    'idempotency_key', p_idempotency_key);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.reverse_opening_balance_document(TEXT, INTEGER, UUID) TO authenticated;


-- ============================================================================
-- 6. 修正 inventory_voucher_plan：补 5 条科目兜底
--    ⚠️ 本文件是该函数的最新定义（deploy_87 → deploy_92 → deploy_103 → 本文件）。
--       deploy_103 的委外三条一条不少地保留在下面。
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
  ELSIF p_transaction_type_code = 'purchase_return_out' THEN
    -- 净额为负 → 借 2202 应付账款 / 贷 1405 库存商品
    RETURN QUERY SELECT '1405'::TEXT, '2202'::TEXT, TRUE;
  ELSIF p_transaction_type_code = 'sales_return_in' THEN
    -- 净额为正 → 借 1405 库存商品 / 贷 6401 主营业务成本
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
  -- ---- 其他出入库（deploy_104 起的三种新交易类型 + 复用的报废）------------
  -- 其他入库（赠品/归还/盘盈）：净额为正 → 借 1405 库存商品 / 贷 1901 待处理财产损溢
  ELSIF p_transaction_type_code = 'other_receipt_in' THEN
    RETURN QUERY SELECT '1405'::TEXT, '1901'::TEXT, TRUE;
  -- 其他出库（借出/赠出/样品）：净额为负 → 借 1901 待处理财产损溢 / 贷 1405 库存商品
  ELSIF p_transaction_type_code = 'other_issue_out' THEN
    RETURN QUERY SELECT '1405'::TEXT, '1901'::TEXT, TRUE;
  -- 损耗出库：净额为负 → 借 6602 管理费用 / 贷 1405 库存商品
  ELSIF p_transaction_type_code = 'other_loss_out' THEN
    RETURN QUERY SELECT '1405'::TEXT, '6602'::TEXT, TRUE;
  -- 报废出库：净额为负 → 借 6711 营业外支出 / 贷 1405 库存商品
  ELSIF p_transaction_type_code = 'scrap_out' THEN
    RETURN QUERY SELECT '1405'::TEXT, '6711'::TEXT, TRUE;
  -- 期初入库：**兜底也保持不进总账**（期初是余额不是本期发生额）。
  -- 新租户没有映射表行时也必须保持这个语义，否则期初会被算成「本期收」。
  ELSIF p_transaction_type_code = 'opening_balance_in' THEN
    RETURN QUERY SELECT '1405'::TEXT, '1901'::TEXT, FALSE;
  ELSIF p_transaction_type_code = 'opening_balance_out' THEN
    RETURN QUERY SELECT '1405'::TEXT, '1901'::TEXT, FALSE;
  END IF;

  -- ③ 其余（内部调拨两条腿、状态流转、质量冻结等中立类型）一律不进总账
  RETURN QUERY SELECT NULL::TEXT, NULL::TEXT, FALSE;
END;
$function$;


-- ============================================================================
-- 7. 修正 vw_erp_inventory_summary：把「期初录入」从「本期收发」里拆出来
--    ⚠️ 本文件是该视图的最新定义。改动对既有断言零影响 ——
--       deploy_104 之前全库没有任何代码路径写 opening_balance_in/out，
--       历史数据里这两类条数恒为 0，排除它们不改变任何一行数字。
-- ============================================================================
CREATE OR REPLACE VIEW public.vw_erp_inventory_summary
  WITH (security_invoker = true) AS
WITH monthly AS (
  SELECT t.tenant_id,
         t.product_id,
         t.warehouse_id,
         date_trunc('month', t.transaction_date)::date AS period_start,
         -- 本期收发：**排除**期初录入。期初是期初调整，不是本期发生额。
         SUM(CASE WHEN t.quantity > 0
                   AND t.transaction_type NOT IN ('opening_balance_in', 'opening_balance_out')
                  THEN t.quantity ELSE 0 END)  AS in_qty,
         SUM(CASE WHEN t.quantity < 0
                   AND t.transaction_type NOT IN ('opening_balance_in', 'opening_balance_out')
                  THEN -t.quantity ELSE 0 END) AS out_qty,
         -- 金额按**金额符号**判定而不是数量符号：委外加工费是 quantity = 0 的纯金额腿，
         -- 用数量判定会被漏掉，导致期末金额与库存表差一个加工费。
         SUM(CASE WHEN t.total_cost > 0
                   AND t.transaction_type NOT IN ('opening_balance_in', 'opening_balance_out')
                  THEN t.total_cost ELSE 0 END)  AS in_amount,
         SUM(CASE WHEN t.total_cost < 0
                   AND t.transaction_type NOT IN ('opening_balance_in', 'opening_balance_out')
                  THEN -t.total_cost ELSE 0 END) AS out_amount,
         -- 期初录入单独计量：并入它所在期间的期初，不进本期收发
         SUM(CASE WHEN t.transaction_type = 'opening_balance_in'  THEN t.quantity
                  WHEN t.transaction_type = 'opening_balance_out' THEN -t.quantity
                  ELSE 0 END) AS opening_input_qty,
         SUM(CASE WHEN t.transaction_type = 'opening_balance_in'  THEN t.total_cost
                  WHEN t.transaction_type = 'opening_balance_out' THEN -t.total_cost
                  ELSE 0 END) AS opening_input_amount,
         COUNT(*) AS txn_count
    FROM public.erp_inventory_transactions_s_539dcf81_b t
   WHERE t.is_deleted = 'n'
   GROUP BY t.tenant_id, t.product_id, t.warehouse_id,
            date_trunc('month', t.transaction_date)
),
net AS (
  SELECT m.*,
         (m.in_qty - m.out_qty + m.opening_input_qty)       AS net_qty,
         (m.in_amount - m.out_amount + m.opening_input_amount) AS net_amount
    FROM monthly m
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
       -- 期初 = 之前各月净额累计 + **本月的期初录入**（期初录入落在它自己的期间）
       COALESCE(SUM(c.net_qty) OVER (
         PARTITION BY c.tenant_id, c.product_id, c.warehouse_id
         ORDER BY c.period_start
         ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0)
         + c.opening_input_qty AS opening_qty,
       COALESCE(SUM(c.net_amount) OVER (
         PARTITION BY c.tenant_id, c.product_id, c.warehouse_id
         ORDER BY c.period_start
         ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0)
         + c.opening_input_amount AS opening_amount,
       c.in_qty,
       c.in_amount,
       c.out_qty,
       c.out_amount,
       -- 期末 = 期初 + 本期收 - 本期发
       COALESCE(SUM(c.net_qty) OVER (
         PARTITION BY c.tenant_id, c.product_id, c.warehouse_id
         ORDER BY c.period_start
         ROWS UNBOUNDED PRECEDING), 0) AS closing_qty,
       COALESCE(SUM(c.net_amount) OVER (
         PARTITION BY c.tenant_id, c.product_id, c.warehouse_id
         ORDER BY c.period_start
         ROWS UNBOUNDED PRECEDING), 0) AS closing_amount,
       c.txn_count
  FROM net c
  LEFT JOIN public.erp_products_s_539dcf81_b   p ON p.id = c.product_id   AND p.tenant_id = c.tenant_id
  LEFT JOIN public.erp_warehouses_s_539dcf81_b w ON w.id = c.warehouse_id AND w.tenant_id = c.tenant_id;

GRANT SELECT ON public.vw_erp_inventory_summary TO authenticated, anon, service_role;


-- ============================================================================
-- 8. 自检（fail-loud）
-- ============================================================================
DO $$
DECLARE
  v_missing TEXT := '';
  v_body    TEXT;
  v_def     TEXT;
  v_n       INTEGER;
BEGIN
  -- 8.1 五个函数都在
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('resolve_other_stock_transaction_type',
                       'post_other_stock_document',
                       'reverse_other_stock_document',
                       'post_opening_balance_document',
                       'reverse_opening_balance_document');
  IF COALESCE(v_n, 0) <> 5 THEN
    v_missing := v_missing || format('函数只到 %s/5;', v_n);
  END IF;

  -- 8.2 其他出入库过账：必须经 apply_move、带 tenant_id、含预占消耗、写正确 reference_type
  SELECT p.prosrc INTO v_body FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'post_other_stock_document';
  IF v_body IS NULL THEN
    v_missing := v_missing || 'post_other_stock_document 缺失;';
  ELSE
    IF position('inventory_apply_move' IN v_body) = 0 THEN
      v_missing := v_missing || 'post_other_stock_document 未走 inventory_apply_move;';
    END IF;
    IF position('inventory_consume_reservations' IN v_body) = 0 THEN
      v_missing := v_missing || 'post_other_stock_document 未消耗预占;';
    END IF;
    IF position('resolve_other_stock_transaction_type' IN v_body) = 0 THEN
      v_missing := v_missing || 'post_other_stock_document 未按业务类型解析交易类型;';
    END IF;
    IF position('''other_stock_document''' IN v_body) = 0 THEN
      v_missing := v_missing || 'post_other_stock_document 未写 reference_type = other_stock_document;';
    END IF;
    -- 出库必须先消耗预占、再 apply_move（顺序反了会把消耗自己预占误判成超发）
    IF position('inventory_consume_reservations' IN v_body)
       > position('inventory_apply_move' IN v_body) THEN
      v_missing := v_missing || 'post_other_stock_document 的预占消耗晚于扣库存（顺序反了）;';
    END IF;
    IF position('tenant_id' IN v_body) = 0 THEN
      v_missing := v_missing || 'post_other_stock_document 未显式带 tenant_id;';
    END IF;
  END IF;

  -- 8.3 期初过账：必须写 opening_balance_in、必须有单价守卫、必须走 sync_voucher
  SELECT p.prosrc INTO v_body FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'post_opening_balance_document';
  IF v_body IS NULL THEN
    v_missing := v_missing || 'post_opening_balance_document 缺失;';
  ELSE
    IF position('opening_balance_in' IN v_body) = 0 THEN
      v_missing := v_missing || 'post_opening_balance_document 未写 opening_balance_in 流水;';
    END IF;
    -- 0 成本期初必须被拒：断言函数体里真的有那条单价守卫
    IF position('单价必须为正' IN v_body) = 0 THEN
      v_missing := v_missing || 'post_opening_balance_document 缺「期初单价必须为正」守卫;';
    END IF;
    IF position('数量必须为正' IN v_body) = 0 THEN
      v_missing := v_missing || 'post_opening_balance_document 缺「期初数量必须为正」守卫;';
    END IF;
    IF position('inventory_sync_voucher' IN v_body) = 0 THEN
      v_missing := v_missing || 'post_opening_balance_document 未调用 inventory_sync_voucher（打开 generate_voucher 后要能出凭证）;';
    END IF;
    IF position('already has a posted opening balance' IN v_body) = 0 THEN
      v_missing := v_missing || 'post_opening_balance_document 缺「同一仓库只允许一份已过账期初」的前置守卫;';
    END IF;
  END IF;

  -- 8.4 两个反过账都要作废凭证
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('reverse_other_stock_document', 'reverse_opening_balance_document')
     AND position('inventory_void_voucher' IN p.prosrc) > 0
     AND position('inventory_apply_move' IN p.prosrc) > 0;
  IF COALESCE(v_n, 0) <> 2 THEN
    v_missing := v_missing || format('只有 %s/2 个反过账函数同时做了流水回冲与凭证作废;', v_n);
  END IF;

  -- 8.5 凭证兜底：5 条新科目映射都要在 inventory_voucher_plan 里
  SELECT p.prosrc INTO v_body FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'inventory_voucher_plan';
  IF v_body IS NULL THEN
    v_missing := v_missing || 'inventory_voucher_plan 缺失;';
  ELSE
    IF position('other_receipt_in' IN v_body) = 0
       OR position('other_issue_out' IN v_body) = 0
       OR position('other_loss_out' IN v_body) = 0
       OR position('scrap_out' IN v_body) = 0
       OR position('opening_balance_in' IN v_body) = 0 THEN
      v_missing := v_missing || 'inventory_voucher_plan 缺其他出入库/期初的科目兜底;';
    END IF;
    -- 委外三条不能丢（本文件覆盖了 deploy_103 的定义）
    IF position('subcontract_issue_out' IN v_body) = 0
       OR position('subcontract_receipt_in' IN v_body) = 0
       OR position('subcontract_fee_in' IN v_body) = 0 THEN
      v_missing := v_missing || 'inventory_voucher_plan 丢了委外三条兜底（deploy_103 定义被覆盖坏）;';
    END IF;
    IF position('6711' IN v_body) = 0 OR position('6602' IN v_body) = 0 THEN
      v_missing := v_missing || 'inventory_voucher_plan 缺报废(6711)/损耗(6602)对方科目;';
    END IF;
  END IF;

  -- 8.6 报表视图：期初必须从本期收发里拆出来
  SELECT pg_get_viewdef('public.vw_erp_inventory_summary'::regclass, TRUE) INTO v_def;
  IF v_def IS NULL THEN
    v_missing := v_missing || 'vw_erp_inventory_summary 缺失;';
  END IF;
  IF v_def NOT ILIKE '%opening_input_qty%' THEN
    v_missing := v_missing || 'vw_erp_inventory_summary 未把期初录入单独计量（opening_input_qty）;';
  END IF;
  IF v_def NOT ILIKE '%opening_balance_in%' THEN
    v_missing := v_missing || 'vw_erp_inventory_summary 未排除 opening_balance_in;';
  END IF;
  -- 委外那次的金额符号口径不能被打回去
  IF v_def NOT ILIKE '%total_cost > (0)%' AND v_def NOT ILIKE '%total_cost > 0%' THEN
    v_missing := v_missing || 'vw_erp_inventory_summary 金额又变回按数量符号判定;';
  END IF;

  IF v_missing <> '' THEN
    RAISE EXCEPTION 'deploy_105 自检失败：%', v_missing;
  END IF;

  RAISE NOTICE 'deploy_105 OK：其他出入库 / 期初 共 5 个 RPC + 5 条科目兜底 + 报表期初口径 就绪';
END;
$$;
