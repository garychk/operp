-- ============================================================================
-- deploy_74_finance_fx_revaluation.sql
-- 多币别改造 · 第 3 期（财务）· 步骤 4/5：期末调汇
--
-- 依赖 deploy_71（6603 + finance_subject_id_for）、deploy_72（双金额列）、
--      deploy_73（核销双币 —— 调汇后的账面口径必须与它配套）。
--
-- 这是「汇兑损益确认时点 = 核销差额 + 期末调汇」里的第二半。
--
-- ── 会计逻辑 ──────────────────────────────────────────────────────────────
-- 期末把外币货币性项目（未核销的应收/应付）按**期末汇率**重新计量，
-- 差额计入 6603：
--     应收：账面本位币 7200 → 按期末汇率重估 7300
--           借 1122 应收账款 100       ← 资产增加 = 汇兑收益
--           贷 6603 汇兑损益  100
--     应付：账面本位币 3600 → 按期末汇率重估 3700
--           借 6603 汇兑损益  100       ← 负债增加 = 汇兑损失
--           贷 2202 应付账款  100
--
-- fx_gain_loss 与 deploy_73 同口径：**6603 的净借方发生额**，
--     正 = 损失，负 = 收益。
--     由上面两例：ar_diff = +100（收益）、ap_diff = +100（损失）
--     → fx = ap_diff − ar_diff = 0，两张调整分录自成平衡。
-- 一般式：fx = Σ(应付重估差) − Σ(应收重估差)。
--
-- ── 为什么调汇分录不标外币 ────────────────────────────────────────────────
-- 调汇分录记的是**本位币重估差额**，不是外币交易：金额 100 不对应任何原币
-- 数量（原币余额没变，变的只是折算率）。因此这些分录的 currency 留 NULL、
-- exchange_rate = 1，即「本位币调整」，否则会撞上 post_voucher_document 的
-- 「外币行必须满足 本位币 ≈ 原币 × 汇率」自洽校验。币种信息由
-- erp_fx_revaluation 记录本身承载（凭证头也带上 currency 供检索）。
--
-- ── 幂等与可逆 ────────────────────────────────────────────────────────────
--   · 同一 (租户, 期间, 币种) 只允许一条**有效**调汇记录（部分唯一索引），
--     重复调用同一个 idempotency_key 返回 idempotent:true。
--   · 录错汇率要重来时，先 reverse_fx_revaluation() 作废，再重跑。
--   · reverse 会把调汇凭证的 gl_entries 删除并把凭证置为 cancelled ——
--     自动生成的调整凭证不该被人手工再拿去过账。
--
-- 运行环境：由 000_run_all.local.sh 以 psql --single-transaction 执行，
--           脚本内**不要**写 BEGIN / COMMIT。
-- ============================================================================

\echo '[deploy_74] 期末调汇表与 RPC...'

-- ---------------------------------------------------------------------------
-- 1) 调汇记录表
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.erp_fx_revaluation_s_539dcf81_b (
  id SERIAL PRIMARY KEY,
  corp_id VARCHAR(128),
  emp_id VARCHAR(128),
  is_deleted CHAR(1) NOT NULL DEFAULT 'n',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revaluation_no VARCHAR(64) NOT NULL,
  period_id INTEGER NOT NULL,
  revaluation_date DATE NOT NULL,
  currency VARCHAR(10) NOT NULL,
  rate NUMERIC(18,8) NOT NULL,
  -- 应收侧
  ar_original_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  ar_base_before     NUMERIC(18,2) NOT NULL DEFAULT 0,
  ar_base_after      NUMERIC(18,2) NOT NULL DEFAULT 0,
  -- 应付侧
  ap_original_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  ap_base_before     NUMERIC(18,2) NOT NULL DEFAULT 0,
  ap_base_after      NUMERIC(18,2) NOT NULL DEFAULT 0,
  -- 6603 净借方（正 = 损失）
  fx_gain_loss NUMERIC(18,2) NOT NULL DEFAULT 0,
  voucher_id INTEGER,
  status VARCHAR(20) NOT NULL DEFAULT 'posted',
  idempotency_key UUID NOT NULL,
  created_by INTEGER,
  tenant_id BIGINT NOT NULL DEFAULT current_tenant_id(),
  CONSTRAINT chk_fx_reval_rate_positive CHECK (rate > 0),
  CONSTRAINT chk_fx_reval_status CHECK (status IN ('posted', 'cancelled')),
  CONSTRAINT fk_fx_reval_tenant FOREIGN KEY (tenant_id)
    REFERENCES public.sys_tenants(id) ON DELETE RESTRICT,
  CONSTRAINT fk_fx_reval_period FOREIGN KEY (period_id)
    REFERENCES public.erp_accounting_periods_s_539dcf81_b(id)
);

COMMENT ON TABLE public.erp_fx_revaluation_s_539dcf81_b IS
  '期末调汇记录：按 (租户, 期间, 币种) 一条有效记录；作废走 reverse_fx_revaluation()。';
COMMENT ON COLUMN public.erp_fx_revaluation_s_539dcf81_b.fx_gain_loss IS
  '6603 的净借方发生额：正 = 汇兑损失，负 = 汇兑收益（与 erp_ar_ap_settlements 同口径）';
COMMENT ON COLUMN public.erp_fx_revaluation_s_539dcf81_b.ar_base_after IS
  '重估后的应收本位币合计（= Σ round(该币种各行原币余额 × 期末汇率, 2)），调汇时同步写入 erp_receivables.base_balance';

-- 一个期间一个币种只允许一条有效调汇（cancelled 的释放名额）
CREATE UNIQUE INDEX IF NOT EXISTS uq_fx_reval_active_period_currency
  ON public.erp_fx_revaluation_s_539dcf81_b (tenant_id, period_id, currency)
  WHERE is_deleted = 'n' AND status <> 'cancelled';

-- 幂等键
CREATE UNIQUE INDEX IF NOT EXISTS uq_fx_reval_idempotency
  ON public.erp_fx_revaluation_s_539dcf81_b (tenant_id, period_id, currency, idempotency_key)
  WHERE is_deleted = 'n';

CREATE INDEX IF NOT EXISTS idx_fx_reval_tenant_date
  ON public.erp_fx_revaluation_s_539dcf81_b (tenant_id, revaluation_date DESC);

-- ---------------------------------------------------------------------------
-- 2) 权限、RLS 与目录登记
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON public.erp_fx_revaluation_s_539dcf81_b TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.erp_fx_revaluation_s_539dcf81_b_id_seq TO authenticated;

SELECT public.install_role_table_rls('erp_fx_revaluation_s_539dcf81_b');
SELECT public.refresh_sys_tables();

-- 基线角色授权（调汇是纯财务动作，不给其他角色）
INSERT INTO public.sys_role_table_permissions
  (role_id, table_id, can_select, can_insert, can_update, can_delete, is_deleted, tenant_id)
SELECT r.id, t.id, TRUE, TRUE, TRUE, TRUE, 'n', NULL
FROM public.sys_roles r
CROSS JOIN public.sys_tables t
WHERE r.tenant_id IS NULL
  AND COALESCE(r.is_deleted, 'n') = 'n'
  AND r.role_code IN ('super_admin', 'tenant_admin', 'finance_manager')
  AND t.table_name = 'erp_fx_revaluation_s_539dcf81_b'
  AND COALESCE(t.is_deleted, 'n') = 'n'
  AND NOT EXISTS (
    SELECT 1 FROM public.sys_role_table_permissions rp
    WHERE rp.role_id = r.id AND rp.table_id = t.id
      AND rp.tenant_id IS NULL AND COALESCE(rp.is_deleted, 'n') = 'n'
  );

-- 已物化租户补表权限副本
DO $$
DECLARE
  v_tenant RECORD;
  v_result JSONB;
  v_count INTEGER := 0;
BEGIN
  FOR v_tenant IN
    SELECT t.id, t.code FROM public.sys_tenants t
     WHERE COALESCE(t.is_deleted, 'n') = 'n'
       AND COALESCE(t.metadata_materialized, FALSE)
     ORDER BY t.id
  LOOP
    v_result := public.clone_platform_baseline_to_tenant(v_tenant.id, FALSE, TRUE);
    RAISE NOTICE '租户 % (%) 调汇表权限补差：%', v_tenant.id, v_tenant.code, v_result;
    v_count := v_count + 1;
  END LOOP;
  RAISE NOTICE '已给 % 个已物化租户补调汇表权限副本', v_count;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3) run_fx_revaluation：按期末汇率重估外币往来
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.run_fx_revaluation(
  p_period_id        INTEGER,
  p_revaluation_date DATE,
  p_idempotency_key  UUID,
  p_currency         VARCHAR DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_period    RECORD;
  v_ccy       RECORD;
  v_tenant    BIGINT := public.current_tenant_id();
  v_base_ccy  TEXT;
  v_rate      NUMERIC;
  v_ar_orig   NUMERIC;
  v_ar_before NUMERIC;
  v_ar_after  NUMERIC;
  v_ap_orig   NUMERIC;
  v_ap_before NUMERIC;
  v_ap_after  NUMERIC;
  v_ar_diff   NUMERIC;
  v_ap_diff   NUMERIC;
  v_fx        NUMERIC;
  v_dr        NUMERIC;
  v_cr        NUMERIC;
  v_line      INTEGER;
  -- 科目
  v_ar_subject INTEGER;
  v_ap_subject INTEGER;
  v_fx_subject INTEGER;
  -- 凭证
  v_voucher_id INTEGER;
  v_voucher_no TEXT;
  -- 结果
  v_processed  JSONB := '[]'::jsonb;
  v_skipped    JSONB := '[]'::jsonb;
  v_prev       RECORD;
  v_actor      INTEGER := public.current_sys_user_id();
BEGIN
  IF p_period_id IS NULL OR p_revaluation_date IS NULL OR p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'Period, revaluation date and idempotency key are all required'
      USING ERRCODE = '22023';
  END IF;

  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'No tenant context: cannot run FX revaluation' USING ERRCODE = '28000';
  END IF;

  IF p_currency IS NOT NULL AND upper(btrim(p_currency)) <> btrim(p_currency) THEN
    RAISE EXCEPTION 'Currency code must be upper-case' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_period FROM public.erp_accounting_periods_s_539dcf81_b
   WHERE id = p_period_id AND tenant_id = v_tenant AND is_deleted = 'n' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Accounting period does not exist or is deleted' USING ERRCODE = 'P0002';
  END IF;
  IF COALESCE(v_period.is_locked, FALSE) THEN
    RAISE EXCEPTION 'Accounting period is locked' USING ERRCODE = '55000';
  END IF;
  IF COALESCE(v_period.is_closed, FALSE) THEN
    RAISE EXCEPTION 'Accounting period is closed' USING ERRCODE = '55000';
  END IF;
  IF NOT COALESCE(v_period.is_enabled, FALSE) THEN
    RAISE EXCEPTION 'Accounting period is not enabled' USING ERRCODE = '55000';
  END IF;

  v_base_ccy := COALESCE((
      SELECT c.code FROM public.erp_currencies_s_539dcf81_b c
       WHERE c.tenant_id = v_tenant AND c.is_base AND c.is_deleted = 'n'
       LIMIT 1), public.current_base_currency(), 'CNY');

  IF p_currency IS NOT NULL AND p_currency = v_base_ccy THEN
    RAISE EXCEPTION 'Base currency (%) needs no revaluation', v_base_ccy USING ERRCODE = '22023';
  END IF;

  -- 外币货币性项目：应收/应付里还有未核销原币余额的币种
  FOR v_ccy IN
    SELECT x.code
      FROM (
        SELECT DISTINCT r.currency AS code
          FROM public.erp_receivables_s_539dcf81_b r
         WHERE r.tenant_id = v_tenant AND r.is_deleted = 'n'
           AND r.currency IS NOT NULL AND COALESCE(r.balance, 0) <> 0
        UNION
        SELECT DISTINCT p.currency
          FROM public.erp_payables_s_539dcf81_b p
         WHERE p.tenant_id = v_tenant AND p.is_deleted = 'n'
           AND p.currency IS NOT NULL AND COALESCE(p.balance, 0) <> 0
      ) x
     WHERE x.code <> v_base_ccy
       AND (p_currency IS NULL OR x.code = p_currency)
     ORDER BY x.code
  LOOP
    -- 幂等：同期间同币种已有有效记录
    SELECT * INTO v_prev FROM public.erp_fx_revaluation_s_539dcf81_b
     WHERE tenant_id = v_tenant AND period_id = p_period_id
       AND currency = v_ccy.code AND is_deleted = 'n' AND status <> 'cancelled';
    IF FOUND THEN
      IF v_prev.idempotency_key = p_idempotency_key THEN
        v_skipped := v_skipped || jsonb_build_object(
          'currency', v_ccy.code, 'reason', 'idempotent', 'revaluation_id', v_prev.id);
        CONTINUE;
      ELSE
        RAISE EXCEPTION
          'Period % already has an active FX revaluation for % (id=%). Reverse it first.',
          p_period_id, v_ccy.code, v_prev.id USING ERRCODE = '23505';
      END IF;
    END IF;

    -- 期末汇率：拿不到必须报错，不许静默按 1 处理
    v_rate := public.get_exchange_rate(v_ccy.code, p_revaluation_date, 'spot');
    IF v_rate IS NULL OR v_rate <= 0 THEN
      RAISE EXCEPTION
        'No effective exchange rate for % on or before %; add it to exchange rates first',
        v_ccy.code, p_revaluation_date USING ERRCODE = 'P0002';
    END IF;

    -- 应收：原币余额、账面本位币、按期末汇率重估后的本位币（逐行取整后求和，
    -- 保证与随后逐行 UPDATE 的结果严格一致）
    SELECT COALESCE(SUM(r.balance), 0),
           COALESCE(SUM(COALESCE(r.base_balance, 0)), 0),
           COALESCE(SUM(ROUND(r.balance * v_rate, 2)), 0)
      INTO v_ar_orig, v_ar_before, v_ar_after
      FROM public.erp_receivables_s_539dcf81_b r
     WHERE r.tenant_id = v_tenant AND r.currency = v_ccy.code AND r.is_deleted = 'n'
       AND COALESCE(r.balance, 0) <> 0;

    SELECT COALESCE(SUM(p.balance), 0),
           COALESCE(SUM(COALESCE(p.base_balance, 0)), 0),
           COALESCE(SUM(ROUND(p.balance * v_rate, 2)), 0)
      INTO v_ap_orig, v_ap_before, v_ap_after
      FROM public.erp_payables_s_539dcf81_b p
     WHERE p.tenant_id = v_tenant AND p.currency = v_ccy.code AND p.is_deleted = 'n'
       AND COALESCE(p.balance, 0) <> 0;

    v_ar_diff := v_ar_after - v_ar_before;
    v_ap_diff := v_ap_after - v_ap_before;

    IF ABS(v_ar_diff) < 0.005 AND ABS(v_ap_diff) < 0.005 THEN
      v_skipped := v_skipped || jsonb_build_object(
        'currency', v_ccy.code, 'reason', 'no_difference',
        'ar_diff', v_ar_diff, 'ap_diff', v_ap_diff);
      CONTINUE;
    END IF;

    -- 6603 净借方 = Σ(应付重估差) − Σ(应收重估差)
    v_fx := v_ap_diff - v_ar_diff;

    v_ar_subject := public.finance_subject_id_for(ARRAY['1122'], v_tenant);
    v_ap_subject := public.finance_subject_id_for(ARRAY['2202'], v_tenant);
    v_fx_subject := public.finance_subject_id_for(ARRAY['6603'], v_tenant);
    IF v_ar_subject IS NULL OR v_ap_subject IS NULL OR v_fx_subject IS NULL THEN
      RAISE EXCEPTION
        'Subjects 1122 / 2202 / 6603 are required for FX revaluation (tenant %)', v_tenant
        USING ERRCODE = 'P0001';
    END IF;

    v_dr := GREATEST(v_ar_diff, 0) + GREATEST(-v_ap_diff, 0) + GREATEST(v_fx, 0);
    v_cr := GREATEST(-v_ar_diff, 0) + GREATEST(v_ap_diff, 0) + GREATEST(-v_fx, 0);
    IF ABS(v_dr - v_cr) >= 0.005 THEN
      RAISE EXCEPTION
        'FX revaluation not balanced for %: debit %, credit %', v_ccy.code, v_dr, v_cr
        USING ERRCODE = '23514';
    END IF;

    v_voucher_no := format('FXR-%s-%s-%s', p_period_id, v_ccy.code,
                           left(md5(p_idempotency_key::text || v_ccy.code), 8));

    INSERT INTO public.erp_vouchers_s_539dcf81_b
      (corp_id, emp_id, voucher_no, voucher_date, period_id, type, source_doc_no,
       total_amount, remark, status, currency, exchange_rate, tenant_id)
    VALUES (NULL, NULL, v_voucher_no, p_revaluation_date, p_period_id, 'general', NULL,
       v_dr, format('期末调汇 %s @ %s', v_ccy.code, v_rate), 'draft',
       v_ccy.code, v_rate, v_tenant)
    RETURNING id INTO v_voucher_id;

    v_line := 0;

    -- 应收调整
    IF ABS(v_ar_diff) >= 0.005 THEN
      v_line := v_line + 1;
      INSERT INTO public.erp_voucher_details_s_539dcf81_b
        (corp_id, emp_id, voucher_id, line_no, subject_id, summary,
         debit_amount, credit_amount, currency, exchange_rate, debit_fc, credit_fc, tenant_id)
      VALUES (NULL, NULL, v_voucher_id, v_line, v_ar_subject,
        format('期末调汇 %s 应收账款', v_ccy.code),
        GREATEST(v_ar_diff, 0), GREATEST(-v_ar_diff, 0),
        NULL, 1, GREATEST(v_ar_diff, 0), GREATEST(-v_ar_diff, 0), v_tenant);
    END IF;

    -- 应付调整
    IF ABS(v_ap_diff) >= 0.005 THEN
      v_line := v_line + 1;
      INSERT INTO public.erp_voucher_details_s_539dcf81_b
        (corp_id, emp_id, voucher_id, line_no, subject_id, summary,
         debit_amount, credit_amount, currency, exchange_rate, debit_fc, credit_fc, tenant_id)
      VALUES (NULL, NULL, v_voucher_id, v_line, v_ap_subject,
        format('期末调汇 %s 应付账款', v_ccy.code),
        GREATEST(-v_ap_diff, 0), GREATEST(v_ap_diff, 0),
        NULL, 1, GREATEST(-v_ap_diff, 0), GREATEST(v_ap_diff, 0), v_tenant);
    END IF;

    -- 汇兑损益
    IF ABS(v_fx) >= 0.005 THEN
      v_line := v_line + 1;
      INSERT INTO public.erp_voucher_details_s_539dcf81_b
        (corp_id, emp_id, voucher_id, line_no, subject_id, summary,
         debit_amount, credit_amount, currency, exchange_rate, debit_fc, credit_fc, tenant_id)
      VALUES (NULL, NULL, v_voucher_id, v_line, v_fx_subject,
        CASE WHEN v_fx > 0 THEN '期末调汇汇兑损失' ELSE '期末调汇汇兑收益' END,
        GREATEST(v_fx, 0), GREATEST(-v_fx, 0),
        NULL, 1, GREATEST(v_fx, 0), GREATEST(-v_fx, 0), v_tenant);
    END IF;

    -- 往来账面本位币余额同步重估
    UPDATE public.erp_receivables_s_539dcf81_b r
       SET base_balance = ROUND(r.balance * v_rate, 2),
           updated_at   = NOW()
     WHERE r.tenant_id = v_tenant AND r.currency = v_ccy.code AND r.is_deleted = 'n'
       AND COALESCE(r.balance, 0) <> 0;

    UPDATE public.erp_payables_s_539dcf81_b p
       SET base_balance = ROUND(p.balance * v_rate, 2),
           updated_at   = NOW()
     WHERE p.tenant_id = v_tenant AND p.currency = v_ccy.code AND p.is_deleted = 'n'
       AND COALESCE(p.balance, 0) <> 0;

    INSERT INTO public.erp_fx_revaluation_s_539dcf81_b
      (revaluation_no, period_id, revaluation_date, currency, rate,
       ar_original_amount, ar_base_before, ar_base_after,
       ap_original_amount, ap_base_before, ap_base_after,
       fx_gain_loss, voucher_id, status, idempotency_key, created_by, tenant_id)
    VALUES (v_voucher_no, p_period_id, p_revaluation_date, v_ccy.code, v_rate,
       v_ar_orig, v_ar_before, v_ar_after,
       v_ap_orig, v_ap_before, v_ap_after,
       v_fx, v_voucher_id, 'posted', p_idempotency_key, v_actor, v_tenant);

    PERFORM public.post_voucher_document(v_voucher_id, p_idempotency_key);

    v_processed := v_processed || jsonb_build_object(
      'currency', v_ccy.code,
      'rate', v_rate,
      'ar_diff', v_ar_diff,
      'ap_diff', v_ap_diff,
      'fx_gain_loss', v_fx,
      'voucher_id', v_voucher_id,
      'voucher_no', v_voucher_no);
  END LOOP;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'period_id', p_period_id,
    'revaluation_date', p_revaluation_date,
    'base_currency', v_base_ccy,
    'tenant_id', v_tenant,
    'processed', v_processed,
    'skipped', v_skipped);
END;
$$;

REVOKE ALL ON FUNCTION public.run_fx_revaluation(INTEGER, DATE, UUID, VARCHAR) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.run_fx_revaluation(INTEGER, DATE, UUID, VARCHAR) TO authenticated;

-- ---------------------------------------------------------------------------
-- 4) reverse_fx_revaluation：作废一次调汇
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reverse_fx_revaluation(
  p_revaluation_id  INTEGER,
  p_idempotency_key UUID
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_rec       RECORD;
  v_tenant    BIGINT;
  v_dr_delta  NUMERIC;
  v_dp_delta  NUMERIC;
  v_ar_now    NUMERIC;
  v_ap_now    NUMERIC;
BEGIN
  IF p_revaluation_id IS NULL OR p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'Revaluation id and idempotency key are required' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_rec FROM public.erp_fx_revaluation_s_539dcf81_b
   WHERE id = p_revaluation_id AND is_deleted = 'n' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FX revaluation does not exist or is deleted' USING ERRCODE = 'P0002';
  END IF;

  v_tenant := v_rec.tenant_id;

  -- 租户守卫（同 deploy_73 的 settle_ar_ap）：super_admin 允许跨租户，
  -- 其余必须同租户。ai-server 走 service_role 时 BYPASSRLS，没有这道校验
  -- 就能凭任意 p_revaluation_id 反调汇别的租户的账。
  IF public.current_tenant_id() IS NOT NULL
     AND v_rec.tenant_id <> public.current_tenant_id()
     AND NOT public.current_user_is_super_admin() THEN
    RAISE EXCEPTION
      'Revaluation % belongs to tenant %, but the current tenant is %',
      p_revaluation_id, v_rec.tenant_id, public.current_tenant_id()
      USING ERRCODE = '42501';
  END IF;

  IF v_rec.status = 'cancelled' THEN
    RETURN jsonb_build_object('ok', TRUE, 'idempotent', TRUE, 'revaluation_id', p_revaluation_id);
  END IF;

  -- 调汇带来的账面增量（要撤掉的部分）
  v_dr_delta := v_rec.ar_base_after - v_rec.ar_base_before;
  v_dp_delta := v_rec.ap_base_after - v_rec.ap_base_before;

  IF v_rec.voucher_id IS NOT NULL THEN
    PERFORM public.reverse_voucher_document(v_rec.voucher_id, p_idempotency_key);
    -- 自动生成的调整凭证不再允许手工过账；与手工凭证「反过账退回 draft」的
    -- 既有约定刻意不同
    UPDATE public.erp_vouchers_s_539dcf81_b
       SET status = 'cancelled',
           remark = COALESCE(remark, '') || '（已反调汇）',
           updated_at = NOW()
     WHERE id = v_rec.voucher_id AND tenant_id = v_tenant;
  END IF;

  -- 按当前余额比例撤掉增量：这样即使调汇之后又发生了核销（余额已变小），
  -- 汇总层面仍然是精确的（Σ各行变化 = −delta），只是逐行分摊是近似的。
  SELECT COALESCE(SUM(r.base_balance), 0) INTO v_ar_now
    FROM public.erp_receivables_s_539dcf81_b r
   WHERE r.tenant_id = v_tenant AND r.currency = v_rec.currency AND r.is_deleted = 'n'
     AND COALESCE(r.base_balance, 0) <> 0;

  IF ABS(v_ar_now) > 0.005 AND ABS(v_dr_delta) > 0.005 THEN
    UPDATE public.erp_receivables_s_539dcf81_b r
       SET base_balance = ROUND(r.base_balance - v_dr_delta * (r.base_balance / v_ar_now), 2),
           updated_at   = NOW()
     WHERE r.tenant_id = v_tenant AND r.currency = v_rec.currency AND r.is_deleted = 'n'
       AND COALESCE(r.base_balance, 0) <> 0;
  END IF;

  SELECT COALESCE(SUM(p.base_balance), 0) INTO v_ap_now
    FROM public.erp_payables_s_539dcf81_b p
   WHERE p.tenant_id = v_tenant AND p.currency = v_rec.currency AND p.is_deleted = 'n'
     AND COALESCE(p.base_balance, 0) <> 0;

  IF ABS(v_ap_now) > 0.005 AND ABS(v_dp_delta) > 0.005 THEN
    UPDATE public.erp_payables_s_539dcf81_b p
       SET base_balance = ROUND(p.base_balance - v_dp_delta * (p.base_balance / v_ap_now), 2),
           updated_at   = NOW()
     WHERE p.tenant_id = v_tenant AND p.currency = v_rec.currency AND p.is_deleted = 'n'
       AND COALESCE(p.base_balance, 0) <> 0;
  END IF;

  UPDATE public.erp_fx_revaluation_s_539dcf81_b
     SET status = 'cancelled', updated_at = NOW()
   WHERE id = p_revaluation_id AND tenant_id = v_tenant;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'idempotent', FALSE,
    'revaluation_id', p_revaluation_id,
    'currency', v_rec.currency,
    'reverted_ar_delta', v_dr_delta,
    'reverted_ap_delta', v_dp_delta,
    'voucher_id', v_rec.voucher_id);
END;
$$;

REVOKE ALL ON FUNCTION public.reverse_fx_revaluation(INTEGER, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reverse_fx_revaluation(INTEGER, UUID) TO authenticated;

-- ---------------------------------------------------------------------------
-- 5) fail-loud 自检
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_cnt       INTEGER;
  v_body      TEXT;
  v_invoker   BOOLEAN;
BEGIN
  -- 5.1 表与关键列
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'erp_fx_revaluation_s_539dcf81_b'
  ) THEN
    RAISE EXCEPTION '[deploy_74] erp_fx_revaluation_s_539dcf81_b 未创建';
  END IF;

  -- 5.2 两个部分唯一索引（缺了就会重复调汇）
  SELECT COUNT(*) INTO v_cnt FROM pg_indexes
   WHERE tablename = 'erp_fx_revaluation_s_539dcf81_b'
     AND indexname IN ('uq_fx_reval_active_period_currency', 'uq_fx_reval_idempotency');
  IF v_cnt <> 2 THEN
    RAISE EXCEPTION '[deploy_74] 调汇表的两个部分唯一索引不全（实际 %）', v_cnt;
  END IF;

  -- 5.3 RLS 策略已装
  SELECT COUNT(*) INTO v_cnt FROM pg_policies
   WHERE tablename = 'erp_fx_revaluation_s_539dcf81_b' AND policyname LIKE 'role_%';
  IF v_cnt <> 4 THEN
    RAISE EXCEPTION '[deploy_74] 调汇表 RLS 策略应为 4 条，实际 %', v_cnt;
  END IF;

  -- 5.4 sys_tables 已登记（否则 has_table_permission 永不命中）
  SELECT COUNT(*) INTO v_cnt FROM public.sys_tables
   WHERE table_name = 'erp_fx_revaluation_s_539dcf81_b' AND COALESCE(is_deleted, 'n') = 'n';
  IF v_cnt <> 1 THEN
    RAISE EXCEPTION '[deploy_74] 调汇表未登记进 sys_tables';
  END IF;

  -- 5.5 基线授权 >= 3（3 个角色）
  SELECT COUNT(*) INTO v_cnt
    FROM public.sys_role_table_permissions rp
    JOIN public.sys_tables t ON t.id = rp.table_id
    JOIN public.sys_roles r ON r.id = rp.role_id
   WHERE t.table_name = 'erp_fx_revaluation_s_539dcf81_b'
     AND rp.tenant_id IS NULL AND COALESCE(rp.is_deleted, 'n') = 'n'
     AND r.tenant_id IS NULL AND COALESCE(r.is_deleted, 'n') = 'n'
     AND r.role_code IN ('super_admin', 'tenant_admin', 'finance_manager');
  IF v_cnt < 3 THEN
    RAISE EXCEPTION '[deploy_74] 调汇表基线授权不足（期望 3，实际 %）', v_cnt;
  END IF;

  -- 5.6 两个函数存在、是 INVOKER（靠 RLS 收敛租户）、函数体指纹正确
  SELECT p.prosrc, p.prosecdef INTO v_body, v_invoker
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'run_fx_revaluation';
  IF v_body IS NULL THEN
    RAISE EXCEPTION '[deploy_74] run_fx_revaluation 未创建';
  END IF;
  IF v_invoker THEN
    RAISE EXCEPTION '[deploy_74] run_fx_revaluation 不应是 SECURITY DEFINER（需靠 RLS 收敛租户）';
  END IF;
  IF v_body NOT LIKE '%6603%' OR v_body NOT LIKE '%finance_subject_id_for%'
     OR v_body NOT LIKE '%base_balance%' THEN
    RAISE EXCEPTION '[deploy_74] run_fx_revaluation 函数体未生效（缺少汇兑损益/科目/账面指纹）';
  END IF;

  SELECT p.prosrc INTO v_body
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'reverse_fx_revaluation';
  IF v_body IS NULL OR v_body NOT LIKE '%reverse_voucher_document%'
     OR v_body NOT LIKE '%42501%' THEN
    RAISE EXCEPTION '[deploy_74] reverse_fx_revaluation 未生效';
  END IF;

  RAISE NOTICE '[deploy_74] 自检通过：调汇表、两个部分唯一索引、RLS、表权限与两个 RPC 均就位。';
END $$;
