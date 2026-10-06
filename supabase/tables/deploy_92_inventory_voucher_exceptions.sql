-- ============================================================================
-- P1-9b 前置：把「库存凭证为什么没生成」落库
-- ============================================================================
--
-- deploy_87 已经保证「单据 ↔ 凭证」可反查（erp_vouchers.inventory_source_*），
-- 但**被跳过的原因只回传在 RPC 返回值里，没有落库**。于是：
--   · 月末想找「哪些单据没生成凭证」只能逐张重放；
--   · 对账视图无法显式列出差异原因。
--
-- 本文件建 `erp_inventory_voucher_exceptions`：每张「应交但未生成凭证」的库存单据
-- 一行，带原因码与明细，成功生成凭证时自动清除。
--
-- 同时给 `inventory_voucher_plan` 补上两条退货的科目兜底：
--   purchase_return_out  借 2202 应付账款  贷 1405 库存商品（净额为负 → 借对方/贷存货）
--   sales_return_in      借 1405 库存商品  贷 6401 主营业务成本（净额为正 → 借存货/贷对方）
-- 这里只需要给出「存货科目 / 对方科目」两个 code，借贷方向由流水净额符号决定
-- （deploy_87 的既有口径，不要在这里再判方向）。
--
-- 本脚本由 000_run_all 用 psql --single-transaction 执行，**不要写 BEGIN/COMMIT**。
-- 依赖：deploy_87（deploy_88 起依赖 inventory_apply_move 已就位）。
-- ============================================================================

-- ============================================================================
-- 1. 例外表
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.erp_inventory_voucher_exceptions_s_539dcf81_b (
  id SERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL DEFAULT current_tenant_id(),
  corp_id VARCHAR(128),
  emp_id VARCHAR(128),
  is_deleted CHAR(1) NOT NULL DEFAULT 'n',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source_type VARCHAR(50) NOT NULL,
  source_id INTEGER NOT NULL,
  document_no VARCHAR(60),
  document_date DATE,
  reason VARCHAR(40) NOT NULL,     -- no_accounting_period / period_closed / subject_not_found / ...
  detail TEXT,
  transaction_type VARCHAR(64),
  attempts INTEGER NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_inv_voucher_exception_source
  ON public.erp_inventory_voucher_exceptions_s_539dcf81_b (tenant_id, source_type, source_id)
  WHERE is_deleted = 'n';

CREATE INDEX IF NOT EXISTS idx_erp_inv_voucher_exception_reason
  ON public.erp_inventory_voucher_exceptions_s_539dcf81_b (tenant_id, reason)
  WHERE is_deleted = 'n';

GRANT SELECT, INSERT, UPDATE, DELETE ON public.erp_inventory_voucher_exceptions_s_539dcf81_b TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.erp_inventory_voucher_exceptions_s_539dcf81_b_id_seq TO authenticated;
SELECT public.install_role_table_rls('erp_inventory_voucher_exceptions_s_539dcf81_b');
SELECT public.refresh_sys_tables();

-- ============================================================================
-- 2. 记账助手（成功时清空）
-- ============================================================================
CREATE OR REPLACE FUNCTION public.inventory_record_voucher_exception(
  p_tenant_id        BIGINT,
  p_source_type      TEXT,
  p_source_id        INTEGER,
  p_document_no      TEXT DEFAULT NULL,
  p_document_date    DATE DEFAULT NULL,
  p_reason           TEXT DEFAULT NULL,
  p_detail           TEXT DEFAULT NULL,
  p_transaction_type TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_tenant BIGINT := p_tenant_id;
BEGIN
  IF p_source_type IS NULL OR p_source_id IS NULL THEN RETURN; END IF;
  IF v_tenant IS NULL THEN
    SELECT MIN(t.tenant_id) INTO v_tenant
      FROM public.erp_inventory_transactions_s_539dcf81_b t
     WHERE t.reference_type = p_source_type AND t.reference_id = p_source_id;
  END IF;
  IF v_tenant IS NULL THEN RETURN; END IF;

  -- 原因清空 = 之前的例外已解决
  IF p_reason IS NULL THEN
    UPDATE public.erp_inventory_voucher_exceptions_s_539dcf81_b
       SET is_deleted = 'y', updated_at = NOW()
     WHERE tenant_id = v_tenant AND source_type = p_source_type
       AND source_id = p_source_id AND is_deleted = 'n';
    RETURN;
  END IF;

  INSERT INTO public.erp_inventory_voucher_exceptions_s_539dcf81_b (
    source_type, source_id, document_no, document_date, reason, detail,
    transaction_type, attempts, tenant_id
  ) VALUES (
    p_source_type, p_source_id, p_document_no, p_document_date, p_reason,
    LEFT(p_detail, 1000), p_transaction_type, 1, v_tenant
  )
  ON CONFLICT (tenant_id, source_type, source_id) WHERE is_deleted = 'n'
  DO UPDATE SET
    document_no = EXCLUDED.document_no,
    document_date = EXCLUDED.document_date,
    reason = EXCLUDED.reason,
    detail = EXCLUDED.detail,
    transaction_type = EXCLUDED.transaction_type,
    attempts = public.erp_inventory_voucher_exceptions_s_539dcf81_b.attempts + 1,
    updated_at = NOW();
END;
$$;

GRANT EXECUTE ON FUNCTION public.inventory_record_voucher_exception(
  BIGINT, TEXT, INTEGER, TEXT, DATE, TEXT, TEXT, TEXT) TO authenticated;

-- ============================================================================
-- 3. 科目兜底：补两条退货
-- ============================================================================
CREATE OR REPLACE FUNCTION public.inventory_voucher_plan(p_source_type text, p_transaction_type_code text, p_tenant_id bigint)
 RETURNS TABLE(stock_subject_code text, counter_subject_code text, generate_voucher boolean)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
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
  END IF;

  -- ③ 其余（内部调拨两条腿、状态流转、质量冻结等中立类型）一律不进总账
  RETURN QUERY SELECT NULL::TEXT, NULL::TEXT, FALSE;
END;
$function$;

-- ============================================================================
-- 4. inventory_sync_voucher：在原有骨架上补「例外落库」
--    其余逻辑与 deploy_87 完全一致，只多三处调用：
--      · 每个 skip/return 分支写一条例外
--      · 凭证过账失败写一条例外
--      · 成功生成时清空该单据的历史例外
-- ============================================================================
CREATE OR REPLACE FUNCTION public.inventory_sync_voucher(p_source_type text, p_source_id integer, p_document_no text, p_document_date date, p_tenant_id bigint DEFAULT NULL::bigint, p_remark text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_ref_types   TEXT[];
  v_tenant      BIGINT;
  v_date        DATE;
  v_period      RECORD;
  v_existing    RECORD;
  v_group       RECORD;
  v_plan        RECORD;
  v_voucher_id  INTEGER;
  v_voucher_no  TEXT;
  v_line_no     INTEGER := 0;
  v_amount      NUMERIC;
  v_debit_total NUMERIC := 0;
  v_stock_id    INTEGER;
  v_counter_id  INTEGER;
  v_summary     TEXT;
  v_skipped     TEXT;
  v_pending     INTEGER := 0;
  v_result      JSONB;
BEGIN
  IF p_source_type IS NULL OR p_source_id IS NULL OR p_source_id <= 0 THEN
    RETURN jsonb_build_object('ok', FALSE, 'generated', FALSE,
                              'skipped_reason', 'invalid_arguments');
  END IF;

  v_ref_types := public.inventory_document_ref_types(p_source_type);

  -- ---- 租户：显式传入优先，否则从流水推导（流水行一定带 tenant_id）--------
  v_tenant := p_tenant_id;
  IF v_tenant IS NULL THEN
    SELECT MIN(t.tenant_id) INTO v_tenant
      FROM public.erp_inventory_transactions_s_539dcf81_b t
     WHERE t.reference_type = ANY (v_ref_types)
       AND t.reference_id = p_source_id
       AND t.is_deleted = 'n';
  END IF;
  IF v_tenant IS NULL THEN
    RETURN jsonb_build_object('ok', TRUE, 'generated', FALSE,
                              'skipped_reason', 'no_inventory_transactions');
  END IF;

  -- ---- 幂等：本单据已有活跃凭证吗？--------------------------------------
  SELECT v.id, v.voucher_no, v.status
    INTO v_existing
    FROM public.erp_vouchers_s_539dcf81_b v
   WHERE v.tenant_id = v_tenant
     AND v.inventory_source_type = p_source_type
     AND v.inventory_source_id = p_source_id
     AND v.is_deleted = 'n'
   LIMIT 1;

  IF FOUND THEN
    IF v_existing.status = 'posted' THEN
      PERFORM public.inventory_record_voucher_exception(
        v_tenant, p_source_type, p_source_id, p_document_no, p_document_date, NULL);
      RETURN jsonb_build_object('ok', TRUE, 'generated', FALSE,
        'skipped_reason', 'voucher_already_posted',
        'voucher_id', v_existing.id, 'voucher_no', v_existing.voucher_no);
    END IF;
    -- 草稿 / 已作废：清掉重来（重新过账场景）
    UPDATE public.erp_voucher_details_s_539dcf81_b
       SET is_deleted = 'y', updated_at = NOW()
     WHERE voucher_id = v_existing.id AND is_deleted = 'n';
    UPDATE public.erp_vouchers_s_539dcf81_b
       SET is_deleted = 'y', status = 'cancelled', updated_at = NOW()
     WHERE id = v_existing.id;
  END IF;

  -- ---- 先算有几组需要进总账；不需要就别去烦会计期间 ----------------------
  SELECT COUNT(*) INTO v_pending
    FROM (
      SELECT DISTINCT t.transaction_type AS code
        FROM public.erp_inventory_transactions_s_539dcf81_b t
       WHERE t.reference_type = ANY (v_ref_types)
         AND t.reference_id = p_source_id
         AND t.tenant_id = v_tenant
         AND t.is_deleted = 'n'
    ) g
   CROSS JOIN LATERAL public.inventory_voucher_plan(p_source_type, g.code, v_tenant) pl
   WHERE pl.generate_voucher IS TRUE;

  IF COALESCE(v_pending, 0) = 0 THEN
    -- 内部调拨 / 状态流转走这里：这是**预期**结果，不是错误
    PERFORM public.inventory_record_voucher_exception(
      v_tenant, p_source_type, p_source_id, p_document_no, p_document_date, NULL);
    RETURN jsonb_build_object('ok', TRUE, 'generated', FALSE,
                              'skipped_reason', 'no_voucher_required',
                              'document_no', p_document_no);
  END IF;

  -- ---- 会计期间 ----------------------------------------------------------
  v_date := COALESCE(p_document_date, CURRENT_DATE);
  SELECT p.id, p.is_enabled, p.is_closed, p.is_locked, p.year, p.month
    INTO v_period
    FROM public.erp_accounting_periods_s_539dcf81_b p
   WHERE p.is_deleted = 'n'
     AND p.tenant_id = v_tenant
     AND v_date BETWEEN p.start_date AND p.end_date
   ORDER BY p.id
   LIMIT 1;

  IF NOT FOUND THEN
    v_skipped := 'no_accounting_period';
  ELSIF NOT COALESCE(v_period.is_enabled, FALSE) THEN
    v_skipped := 'period_not_enabled';
  ELSIF COALESCE(v_period.is_closed, FALSE) THEN
    v_skipped := 'period_closed';
  ELSIF COALESCE(v_period.is_locked, FALSE) THEN
    v_skipped := 'period_locked';
  END IF;

  IF v_skipped IS NOT NULL THEN
    RAISE WARNING '库存凭证未生成（% %，单据日期 %）：%，请到「会计期间」处理后再反过账重过账',
      p_source_type, p_document_no, v_date, v_skipped;
    PERFORM public.inventory_record_voucher_exception(
      v_tenant, p_source_type, p_source_id, p_document_no, v_date, v_skipped,
      format('单据日期 %s 无可用会计期间（%s）', v_date, v_skipped));
    RETURN jsonb_build_object('ok', TRUE, 'generated', FALSE,
                              'skipped_reason', v_skipped,
                              'document_date', v_date,
                              'document_no', p_document_no);
  END IF;

  -- ---- 建凭证头 ----------------------------------------------------------
  v_voucher_no := LEFT(format('IV-%s', COALESCE(p_document_no, p_source_id::TEXT)), 60);

  INSERT INTO public.erp_vouchers_s_539dcf81_b (
    is_deleted, voucher_no, voucher_date, period_id, type, source_doc_no,
    total_amount, remark, status, currency, exchange_rate, tenant_id,
    inventory_source_type, inventory_source_id, created_at, updated_at
  ) VALUES (
    'n', v_voucher_no, v_date, v_period.id, 'general', p_document_no,
    0, COALESCE(p_remark, format('%s %s 自动生成', p_source_type, p_document_no)),
    'draft', NULL, 1, v_tenant,
    p_source_type, p_source_id, NOW(), NOW()
  ) RETURNING id INTO v_voucher_id;

  -- ---- 按交易类型聚合流水，逐组出两行分录 --------------------------------
  FOR v_group IN
    SELECT t.transaction_type AS code,
           SUM(COALESCE(t.total_cost, 0)) AS net_cost
      FROM public.erp_inventory_transactions_s_539dcf81_b t
     WHERE t.reference_type = ANY (v_ref_types)
       AND t.reference_id = p_source_id
       AND t.tenant_id = v_tenant
       AND t.is_deleted = 'n'
     GROUP BY t.transaction_type
     ORDER BY t.transaction_type
  LOOP
    SELECT * INTO v_plan
      FROM public.inventory_voucher_plan(p_source_type, v_group.code, v_tenant);

    CONTINUE WHEN NOT COALESCE(v_plan.generate_voucher, FALSE);

    v_amount := ROUND(ABS(COALESCE(v_group.net_cost, 0)), 2);
    CONTINUE WHEN v_amount <= 0;                       -- 零金额行不进凭证

    v_stock_id   := public.finance_subject_id_for(ARRAY[v_plan.stock_subject_code], v_tenant);
    v_counter_id := public.finance_subject_id_for(ARRAY[v_plan.counter_subject_code], v_tenant);

    IF v_stock_id IS NULL OR v_counter_id IS NULL THEN
      RAISE WARNING
        '库存凭证未生成（% %）：交易类型 % 的科目 % / % 在租户 % 下不存在',
        p_source_type, p_document_no, v_group.code,
        COALESCE(v_plan.stock_subject_code, '<未配置>'),
        COALESCE(v_plan.counter_subject_code, '<未配置>'), v_tenant;
      UPDATE public.erp_voucher_details_s_539dcf81_b
         SET is_deleted = 'y', updated_at = NOW()
       WHERE voucher_id = v_voucher_id AND is_deleted = 'n';
      UPDATE public.erp_vouchers_s_539dcf81_b
         SET is_deleted = 'y', status = 'cancelled', updated_at = NOW()
       WHERE id = v_voucher_id;
      PERFORM public.inventory_record_voucher_exception(
        v_tenant, p_source_type, p_source_id, p_document_no, v_date,
        'subject_not_found',
        format('交易类型 %s 需要科目 %s / %s，在租户 %s 下不存在',
               v_group.code, COALESCE(v_plan.stock_subject_code, '<未配置>'),
               COALESCE(v_plan.counter_subject_code, '<未配置>'), v_tenant),
        v_group.code);
      RETURN jsonb_build_object('ok', TRUE, 'generated', FALSE,
                                'skipped_reason', 'subject_not_found',
                                'transaction_type', v_group.code,
                                'document_no', p_document_no);
    END IF;

    v_summary := format('%s %s', COALESCE(p_remark, p_source_type), COALESCE(p_document_no, ''));

    -- 净额 > 0：存货增加 → 借存货 / 贷对方
    -- 净额 < 0：存货减少 → 借对方 / 贷存货
    IF COALESCE(v_group.net_cost, 0) > 0 THEN
      v_line_no := v_line_no + 1;
      INSERT INTO public.erp_voucher_details_s_539dcf81_b (
        is_deleted, voucher_id, line_no, subject_id, summary,
        debit_amount, credit_amount, currency, exchange_rate,
        debit_fc, credit_fc, tenant_id, created_at, updated_at
      ) VALUES ('n', v_voucher_id, v_line_no, v_stock_id, v_summary,
        v_amount, 0, NULL, 1, v_amount, 0, v_tenant, NOW(), NOW());
      v_line_no := v_line_no + 1;
      INSERT INTO public.erp_voucher_details_s_539dcf81_b (
        is_deleted, voucher_id, line_no, subject_id, summary,
        debit_amount, credit_amount, currency, exchange_rate,
        debit_fc, credit_fc, tenant_id, created_at, updated_at
      ) VALUES ('n', v_voucher_id, v_line_no, v_counter_id, v_summary,
        0, v_amount, NULL, 1, 0, v_amount, v_tenant, NOW(), NOW());
      v_debit_total := v_debit_total + v_amount;
    ELSE
      v_line_no := v_line_no + 1;
      INSERT INTO public.erp_voucher_details_s_539dcf81_b (
        is_deleted, voucher_id, line_no, subject_id, summary,
        debit_amount, credit_amount, currency, exchange_rate,
        debit_fc, credit_fc, tenant_id, created_at, updated_at
      ) VALUES ('n', v_voucher_id, v_line_no, v_counter_id, v_summary,
        v_amount, 0, NULL, 1, v_amount, 0, v_tenant, NOW(), NOW());
      v_line_no := v_line_no + 1;
      INSERT INTO public.erp_voucher_details_s_539dcf81_b (
        is_deleted, voucher_id, line_no, subject_id, summary,
        debit_amount, credit_amount, currency, exchange_rate,
        debit_fc, credit_fc, tenant_id, created_at, updated_at
      ) VALUES ('n', v_voucher_id, v_line_no, v_stock_id, v_summary,
        0, v_amount, NULL, 1, 0, v_amount, v_tenant, NOW(), NOW());
      v_debit_total := v_debit_total + v_amount;
    END IF;
  END LOOP;

  IF v_line_no = 0 THEN
    UPDATE public.erp_vouchers_s_539dcf81_b
       SET is_deleted = 'y', status = 'cancelled', updated_at = NOW()
     WHERE id = v_voucher_id;
    PERFORM public.inventory_record_voucher_exception(
      v_tenant, p_source_type, p_source_id, p_document_no, v_date, NULL);
    RETURN jsonb_build_object('ok', TRUE, 'generated', FALSE,
                              'skipped_reason', 'zero_amount',
                              'document_no', p_document_no);
  END IF;

  UPDATE public.erp_vouchers_s_539dcf81_b
     SET total_amount = v_debit_total, updated_at = NOW()
   WHERE id = v_voucher_id;

  -- ---- 过账 --------------------------------------------------------------
  -- 单独兜异常：凭证侧的失败绝不能把库存过账一起回滚掉（见 deploy_87 文件头取舍 a）。
  BEGIN
    v_result := public.post_voucher_document(v_voucher_id, gen_random_uuid());
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '库存凭证过账失败（% %，凭证 %）: %',
      p_source_type, p_document_no, v_voucher_no, SQLERRM;
    PERFORM public.inventory_record_voucher_exception(
      v_tenant, p_source_type, p_source_id, p_document_no, v_date,
      'voucher_post_failed', SQLERRM);
    RETURN jsonb_build_object('ok', FALSE, 'generated', TRUE,
                              'skipped_reason', 'voucher_post_failed',
                              'voucher_id', v_voucher_id,
                              'voucher_no', v_voucher_no,
                              'error', SQLERRM,
                              'document_no', p_document_no);
  END;

  -- 成功：清空历史例外
  PERFORM public.inventory_record_voucher_exception(
    v_tenant, p_source_type, p_source_id, p_document_no, v_date, NULL);

  RETURN jsonb_build_object(
    'ok', TRUE, 'generated', TRUE,
    'voucher_id', v_voucher_id, 'voucher_no', v_voucher_no,
    'status', COALESCE(v_result->>'status', 'posted'),
    'debit_total', v_debit_total, 'line_count', v_line_no,
    'period_id', v_period.id, 'document_no', p_document_no);
END;
$function$;

-- ============================================================================
-- 5. 自检
-- ============================================================================
DO $$
DECLARE
  v_missing TEXT := '';
BEGIN
  IF to_regclass('public.erp_inventory_voucher_exceptions_s_539dcf81_b') IS NULL THEN
    v_missing := v_missing || '例外表未建立;';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE tablename = 'erp_inventory_voucher_exceptions_s_539dcf81_b'
       AND indexname = 'uq_erp_inv_voucher_exception_source'
  ) THEN
    v_missing := v_missing || '例外表唯一键缺失（ON CONFLICT 会报错）;';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'inventory_record_voucher_exception'
  ) THEN
    v_missing := v_missing || 'inventory_record_voucher_exception 未建立;';
  END IF;
  -- 退货科目兜底必须真的在函数体里
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'inventory_voucher_plan'
       AND p.prosrc ILIKE '%purchase_return_out%'
       AND p.prosrc ILIKE '%sales_return_in%'
  ) THEN
    v_missing := v_missing || 'inventory_voucher_plan 未补退货科目兜底;';
  END IF;
  -- sync_voucher 必须接上例外落库
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'inventory_sync_voucher'
       AND p.prosrc ILIKE '%inventory_record_voucher_exception%'
  ) THEN
    v_missing := v_missing || 'inventory_sync_voucher 未接例外落库;';
  END IF;

  IF v_missing <> '' THEN
    RAISE EXCEPTION 'deploy_92 自检失败：%', v_missing;
  END IF;

  RAISE NOTICE 'deploy_92 OK：凭证例外表 / 退货科目兜底 / sync_voucher 落库齐备';
END;
$$;
