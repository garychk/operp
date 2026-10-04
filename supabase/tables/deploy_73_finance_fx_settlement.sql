-- ============================================================================
-- deploy_73_finance_fx_settlement.sql
-- 多币别改造 · 第 3 期（财务）· 步骤 3/5：过账双金额 + 核销双币与汇兑损益
--
-- 依赖 deploy_71（6603 科目 + finance_subject_id_for）、deploy_72（双金额列）。
--
-- 本脚本做两件事：
--   A. 重写 post_voucher_document：把分录的 currency / exchange_rate /
--      debit_fc / credit_fc 透传到 erp_gl_entries，并显式写 tenant_id。
--   B. 重写 settle_ar_ap：核销时引入**核销汇率**，把「账面冲减本位币」
--      与「实际收付本位币」的差额确认为汇兑损益（6603）。
--
-- ── 汇兑损益的符号约定（重要，改前务必看懂）────────────────────────────────
--   fx_gain_loss 定义为 **6603 科目的净借方发生额**：
--       正数 = 净借方 = 汇兑**损失**（费用增加）
--       负数 = 净贷方 = 汇兑**收益**
--   与往来方向的关系：
--     · 应付（负债）：实付本位币 > 账面本位币 → 多付了 → 损失
--         fx = 核销本位币 − 账面本位币
--     · 应收（资产）：实收本位币 < 账面本位币 → 少收了 → 损失
--         fx = 账面本位币 − 核销本位币
--   两者合起来即 CASE 表达式，不是随手取的符号，别"简化"成同一个方向。
--
-- ── 分录取数（以应付、原币 1000、单据汇率 7.2、核销汇率 7.3 为例）────────
--     借 2202 应付账款      7200   原币 1000 @7.2   ← 冲减账面
--     借 6603 汇兑损益       100                  ← 差额确认为损失
--     贷 1002 银行存款      7300   原币 1000 @7.3   ← 实际支付
--   应收方向相反（差额为收益时贷 6603）。同一张凭证里两行的 exchange_rate
--   本来就**不相等**，这是汇兑损益的必然形态，故 post_voucher_document
--   不做「整单同一汇率」的假设。
--
-- ── 兼容性与破坏性变更 ────────────────────────────────────────────────────
--   settle_ar_ap 增加了第 8 个参数 p_settlement_rate（带 DEFAULT）。
--   Postgres 不允许 CREATE OR REPLACE 改参数列表（会变成重载，且 7 参调用
--   仍会命中旧函数、新逻辑静默不生效），因此这里 **DROP 旧签名再 CREATE**，
--   并重建 GRANT。前端调用需要传第 8 个参数（可传 null）。
--
-- 加固（与 deploy_69 同一类问题，顺带修）：
--   · 两个函数内所有查询/写入显式带 tenant_id。RLS 的 super_admin 分支是
--     「跨租户可见」，超管代租户核销时会按 source_id 命中别的租户同 id 的行。
--   · 核销记录、凭证、凭证分录、总账四张表的 tenant_id 一律显式取**来源单据
--     的租户**，而不是靠 DEFAULT current_tenant_id()（那会是超管自己的租户）。
--
-- 运行环境：由 000_run_all.local.sh 以 psql --single-transaction 执行，
--           脚本内**不要**写 BEGIN / COMMIT。
-- ============================================================================

\echo '[deploy_73] 过账双金额 + 核销双币与汇兑损益...'

-- ---------------------------------------------------------------------------
-- A. 重写 post_voucher_document（透传双金额到总账）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.post_voucher_document(
  p_voucher_id INTEGER,
  p_idempotency_key UUID
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_voucher RECORD;
  v_period RECORD;
  v_detail RECORD;
  v_total_debit NUMERIC := 0;
  v_total_credit NUMERIC := 0;
  v_line_count INTEGER := 0;
  v_actor_id INTEGER := public.current_sys_user_id();
  v_tenant BIGINT;
  v_rate NUMERIC;
  v_debit_fc NUMERIC;
  v_credit_fc NUMERIC;
  v_fx_lines INTEGER := 0;
BEGIN
  IF p_voucher_id IS NULL OR p_voucher_id <= 0 OR p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'A positive voucher ID and idempotency key are required'
      USING ERRCODE = '22023';
  END IF;

  SELECT *
  INTO v_voucher
  FROM public.erp_vouchers_s_539dcf81_b
  WHERE id = p_voucher_id AND is_deleted = 'n'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Voucher does not exist or is deleted'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_voucher.status = 'posted' THEN
    RETURN jsonb_build_object('ok', TRUE, 'idempotent', TRUE, 'status', 'posted');
  END IF;

  IF v_voucher.status = 'cancelled' THEN
    RAISE EXCEPTION 'Cancelled voucher cannot be posted'
      USING ERRCODE = '55000';
  END IF;

  SELECT *
  INTO v_period
  FROM public.erp_accounting_periods_s_539dcf81_b
  WHERE id = v_voucher.period_id AND is_deleted = 'n';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Accounting period does not exist or is deleted'
      USING ERRCODE = 'P0002';
  END IF;

  IF COALESCE(v_period.is_locked, FALSE) THEN
    RAISE EXCEPTION 'Accounting period is locked'
      USING ERRCODE = '55000';
  END IF;

  IF COALESCE(v_period.is_closed, FALSE) THEN
    RAISE EXCEPTION 'Accounting period is closed'
      USING ERRCODE = '55000';
  END IF;

  IF NOT COALESCE(v_period.is_enabled, FALSE) THEN
    RAISE EXCEPTION 'Accounting period is not enabled'
      USING ERRCODE = '55000';
  END IF;

  -- 凭证所属租户：显式落定，总账行不许靠 DEFAULT current_tenant_id() 取
  v_tenant := COALESCE(v_voucher.tenant_id, public.current_tenant_id());

  -- 平衡校验：**本位币**口径（原币不参与，多币种凭证的原币本来就不成对）
  SELECT COALESCE(SUM(debit_amount), 0), COALESCE(SUM(credit_amount), 0)
  INTO v_total_debit, v_total_credit
  FROM public.erp_voucher_details_s_539dcf81_b
  WHERE voucher_id = p_voucher_id AND is_deleted = 'n';

  IF v_total_debit <= 0 OR v_total_credit <= 0 THEN
    RAISE EXCEPTION 'Voucher debit and credit totals must both be greater than zero'
      USING ERRCODE = '23514';
  END IF;

  IF ABS(v_total_debit - v_total_credit) >= 0.005 THEN
    RAISE EXCEPTION 'Voucher is not balanced: debit %, credit %',
      v_total_debit, v_total_credit USING ERRCODE = '23514';
  END IF;

  -- 总账重建：先作废旧行（保留 is_deleted 语义由 DELETE 承担，与既有实现一致）
  IF EXISTS (
    SELECT 1
    FROM public.erp_gl_entries e
    WHERE e.voucher_id = p_voucher_id AND e.is_deleted = 'n'
      AND e.tenant_id = v_tenant
  ) THEN
    DELETE FROM public.erp_gl_entries
    WHERE voucher_id = p_voucher_id AND tenant_id = v_tenant;
  END IF;

  FOR v_detail IN
    SELECT *
    FROM public.erp_voucher_details_s_539dcf81_b
    WHERE voucher_id = p_voucher_id AND is_deleted = 'n'
    ORDER BY line_no, id
  LOOP
    v_line_count := v_line_count + 1;

    v_rate := COALESCE(v_detail.exchange_rate, 1);
    IF v_rate IS NULL OR v_rate <= 0 THEN
      RAISE EXCEPTION 'Voucher line % has a non-positive exchange rate (%)',
        v_detail.line_no, v_rate USING ERRCODE = '23514';
    END IF;

    v_debit_fc  := COALESCE(v_detail.debit_fc, 0);
    v_credit_fc := COALESCE(v_detail.credit_fc, 0);

    -- 兜底：只填了本位币金额时，按冻结汇率反算原币。
    -- 这是**兼容手工录入**的退路，不是主路径——评估文档明确反对把反算当作
    -- 唯一手段（逐行四舍五入会对不上账），所以能显式给原币的地方都要显式给。
    IF v_debit_fc = 0 AND COALESCE(v_detail.debit_amount, 0) <> 0 THEN
      v_debit_fc := ROUND(COALESCE(v_detail.debit_amount, 0) / v_rate, 2);
    END IF;
    IF v_credit_fc = 0 AND COALESCE(v_detail.credit_amount, 0) <> 0 THEN
      v_credit_fc := ROUND(COALESCE(v_detail.credit_amount, 0) / v_rate, 2);
    END IF;

    -- 自洽校验：外币行必须满足 本位币 ≈ 原币 × 汇率。
    -- 允许 0.05 的舍入余量（会计上超过一分的差额必须纠正）。
    IF v_detail.currency IS NOT NULL THEN
      IF COALESCE(v_detail.debit_amount, 0) <> 0
         AND ABS(COALESCE(v_detail.debit_amount, 0) - v_debit_fc * v_rate) > 0.05 THEN
        RAISE EXCEPTION
          'Voucher line % is inconsistent: debit % <> original %.2f × rate %',
          v_detail.line_no, v_detail.debit_amount, v_debit_fc, v_rate
          USING ERRCODE = '23514';
      END IF;
      IF COALESCE(v_detail.credit_amount, 0) <> 0
         AND ABS(COALESCE(v_detail.credit_amount, 0) - v_credit_fc * v_rate) > 0.05 THEN
        RAISE EXCEPTION
          'Voucher line % is inconsistent: credit % <> original %.2f × rate %',
          v_detail.line_no, v_detail.credit_amount, v_credit_fc, v_rate
          USING ERRCODE = '23514';
      END IF;
    END IF;

    -- 分录里没有币种但有原币金额 → 说明录入侧漏填币种，直接拒绝（否则本位币行
    -- 会带着一个看起来像外币的原币数进总账）
    IF v_detail.currency IS NULL
       AND (v_debit_fc <> COALESCE(v_detail.debit_amount, 0)
            OR v_credit_fc <> COALESCE(v_detail.credit_amount, 0)) THEN
      RAISE EXCEPTION
        'Voucher line % has original-currency amounts without a currency',
        v_detail.line_no USING ERRCODE = '23514';
    END IF;

    INSERT INTO public.erp_gl_entries (
      corp_id, emp_id, is_deleted, voucher_id, voucher_detail_id,
      period_id, subject_id, voucher_no, voucher_date, summary,
      debit_amount, credit_amount, source_type, source_id, source_detail_id,
      currency, exchange_rate, debit_fc, credit_fc,
      posted_at, posted_by, tenant_id
    ) VALUES (
      v_voucher.corp_id, v_voucher.emp_id, 'n', v_voucher.id, v_detail.id,
      v_voucher.period_id, v_detail.subject_id, v_voucher.voucher_no, v_voucher.voucher_date,
      v_detail.summary, COALESCE(v_detail.debit_amount, 0), COALESCE(v_detail.credit_amount, 0),
      'voucher', v_voucher.id, v_detail.id,
      v_detail.currency, v_rate, v_debit_fc, v_credit_fc,
      NOW(), v_actor_id, v_tenant
    );
  END LOOP;

  IF v_line_count = 0 THEN
    RAISE EXCEPTION 'Voucher has no active details'
      USING ERRCODE = '23514';
  END IF;

  SELECT COUNT(*) INTO v_fx_lines
  FROM public.erp_gl_entries e
  WHERE e.voucher_id = p_voucher_id AND e.tenant_id = v_tenant AND e.is_deleted = 'n'
    AND e.currency IS NOT NULL;

  UPDATE public.erp_vouchers_s_539dcf81_b
  SET status = 'posted',
      total_amount = v_total_debit,
      posted_at = NOW(),
      posted_by = v_actor_id,
      updated_at = NOW()
  WHERE id = p_voucher_id;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'idempotent', FALSE,
    'voucher_id', p_voucher_id,
    'status', 'posted',
    'debit_total', v_total_debit,
    'credit_total', v_total_credit,
    'line_count', v_line_count,
    'fx_line_count', v_fx_lines,
    'idempotency_key', p_idempotency_key
  );
END;
$$;

-- post_voucher_document 是 SECURITY DEFINER，保持既有 ACL 不变（无 REVOKE/GRANT）。

-- ---------------------------------------------------------------------------
-- B. 重写 settle_ar_ap（核销双币 + 汇兑损益）
--    DROP 旧签名是必须的：CREATE OR REPLACE 无法改参数列表，加一个带 DEFAULT
--    的新参数会形成重载，7 参调用仍命中旧函数 → 新逻辑静默不生效。
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.settle_ar_ap(VARCHAR, INTEGER, INTEGER, NUMERIC, DATE, TEXT, UUID);

CREATE OR REPLACE FUNCTION public.settle_ar_ap(
  p_settlement_type VARCHAR,
  p_source_id       INTEGER,
  p_period_id       INTEGER,
  p_amount          NUMERIC,
  p_settlement_date DATE,
  p_remark          TEXT,
  p_idempotency_key UUID,
  p_settlement_rate NUMERIC DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  r RECORD;
  p RECORD;
  v_tenant            BIGINT;
  v_date              DATE;
  v_balance           NUMERIC;
  v_voucher_id        INTEGER;
  v_debit_subject_id  INTEGER;
  v_credit_subject_id INTEGER;
  v_fx_subject_id     INTEGER;
  v_base_ccy          TEXT;
  v_line_currency     TEXT;
  v_doc_rate          NUMERIC;
  v_settle_rate       NUMERIC;
  v_base_amount       NUMERIC;   -- 核销的本位币金额（按核销汇率）
  v_book_base_amount  NUMERIC;   -- 被冲减的账面本位币（按单据汇率）
  v_fx                NUMERIC;   -- 6603 净借方（正=损失）
  v_actor             INTEGER := public.current_sys_user_id();
BEGIN
  IF p_settlement_type NOT IN ('receivable', 'payable') OR p_source_id IS NULL OR
     p_period_id IS NULL OR p_amount IS NULL OR p_amount <= 0 OR p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'Settlement parameters are invalid' USING ERRCODE = '22023';
  END IF;

  IF p_settlement_rate IS NOT NULL AND p_settlement_rate <= 0 THEN
    RAISE EXCEPTION 'Settlement exchange rate must be positive (got %)', p_settlement_rate
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO p FROM public.erp_accounting_periods_s_539dcf81_b
    WHERE id = p_period_id AND is_deleted = 'n' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Accounting period does not exist or is deleted' USING ERRCODE = 'P0002';
  END IF;
  IF COALESCE(p.is_locked, FALSE) OR COALESCE(p.is_closed, FALSE) OR NOT COALESCE(p.is_enabled, FALSE) THEN
    RAISE EXCEPTION 'Accounting period is not open for settlement' USING ERRCODE = '55000';
  END IF;

  IF EXISTS (SELECT 1 FROM public.erp_ar_ap_settlements
             WHERE settlement_type = p_settlement_type AND source_id = p_source_id
               AND idempotency_key = p_idempotency_key AND tenant_id = p.tenant_id
               AND is_deleted = 'n') THEN
    RETURN jsonb_build_object('ok', TRUE, 'idempotent', TRUE, 'source_id', p_source_id);
  END IF;

  -- 往来单据：以它自己的 tenant_id 为准向下收敛（超管代租户核销时，
  -- current_tenant_id() 是超管自己的租户，不能用它过滤）
  IF p_settlement_type = 'receivable' THEN
    SELECT * INTO r FROM public.erp_receivables_s_539dcf81_b
      WHERE id = p_source_id AND is_deleted = 'n' FOR UPDATE;
  ELSE
    SELECT * INTO r FROM public.erp_payables_s_539dcf81_b
      WHERE id = p_source_id AND is_deleted = 'n' FOR UPDATE;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Settlement source does not exist or is deleted' USING ERRCODE = 'P0002';
  END IF;

  v_tenant := r.tenant_id;

  -- 租户守卫：super_admin 允许跨租户代操作（既有语义），其余一律必须同租户。
  -- 这一道是给 **service_role 路径**准备的 —— ai-server 用 service_role 直连
  -- 时 BYPASSRLS，RLS 不再兜底，没有这道校验就等于留了个跨租户后门。
  -- （current_tenant_id() 为 NULL 时放行，那是本机 psql 排障场景。）
  IF public.current_tenant_id() IS NOT NULL
     AND r.tenant_id <> public.current_tenant_id()
     AND NOT public.current_user_is_super_admin() THEN
    RAISE EXCEPTION
      'Document % belongs to tenant %, but the current tenant is %',
      p_source_id, r.tenant_id, public.current_tenant_id()
      USING ERRCODE = '42501';
  END IF;

  v_date   := COALESCE(p_settlement_date, CURRENT_DATE);

  -- 该租户的本位币（不能用 current_base_currency()：那是**当前登录租户**的本位币）
  v_base_ccy := COALESCE((
      SELECT c.code FROM public.erp_currencies_s_539dcf81_b c
       WHERE c.tenant_id = v_tenant AND c.is_base AND c.is_deleted = 'n'
       LIMIT 1), public.current_base_currency(), 'CNY');

  -- 本位币单据一律折算率 1（历史脏数据里 exchange_rate 可能不是 1）
  IF r.currency IS NULL OR r.currency = v_base_ccy THEN
    v_line_currency := NULL;
    v_doc_rate      := 1;
    v_settle_rate   := 1;
  ELSE
    v_line_currency := r.currency;
    v_doc_rate      := COALESCE(r.exchange_rate, 1);

    IF p_settlement_rate IS NOT NULL THEN
      v_settle_rate := p_settlement_rate;
    ELSE
      -- 未显式给核销汇率 → 取核销日即期汇率；取不到则退回单据汇率
      -- （退回等于「不确认汇兑损益」，是保守且可解释的行为）
      v_settle_rate := COALESCE(
        public.get_exchange_rate(v_line_currency, v_date, 'spot'),
        v_doc_rate);
    END IF;
  END IF;

  IF v_settle_rate IS NULL OR v_settle_rate <= 0 THEN
    RAISE EXCEPTION 'A positive settlement exchange rate is required for %', v_line_currency
      USING ERRCODE = '23514';
  END IF;

  -- 原币余额校验（沿用原实现）
  v_balance := COALESCE(r.balance, COALESCE(r.amount, 0) - COALESCE(r.paid_amount, 0));
  IF p_amount > v_balance + 0.005 THEN
    RAISE EXCEPTION 'Settlement amount exceeds outstanding balance' USING ERRCODE = '23514';
  END IF;

  v_base_amount      := ROUND(p_amount * v_settle_rate, 2);

  -- 账面冲减额：按**当前账面本位币余额的比率**冲减，而不是固定用单据汇率。
  -- 为什么不能用 单据汇率：期末调汇（deploy_74）会改写 base_balance，若核销
  -- 仍按单据汇率冲减，一张调汇过的单据在**全额核销后仍会残留** base_balance
  -- （例：账面 7200 被调汇成 7300，全额核销只冲 7200 → 残留 100 永远挂账）。
  -- 未调汇时该式退化为 p_amount × 单据汇率，与旧行为完全一致。
  v_book_base_amount := CASE
    WHEN v_balance > 0.005
      THEN ROUND(COALESCE(r.base_balance, 0) * p_amount / v_balance, 2)
    ELSE ROUND(p_amount * v_doc_rate, 2)
  END;

  -- 6603 净借方：应收与应付方向相反（见文件头符号约定）
  IF p_settlement_type = 'receivable' THEN
    v_fx := v_book_base_amount - v_base_amount;
  ELSE
    v_fx := v_base_amount - v_book_base_amount;
  END IF;

  -- 科目：按**单据所属租户**取（finance_subject_id_for 是 SECURITY DEFINER，
  -- 能跨租户读科目；finance_subject_id 受 RLS，超管场景会取错租户）
  IF p_settlement_type = 'receivable' THEN
    v_debit_subject_id  := public.finance_subject_id_for(ARRAY['1002', '1001'], v_tenant);
    v_credit_subject_id := public.finance_subject_id_for(ARRAY['1122'], v_tenant);
  ELSE
    v_debit_subject_id  := public.finance_subject_id_for(ARRAY['2202'], v_tenant);
    v_credit_subject_id := public.finance_subject_id_for(ARRAY['1002', '1001'], v_tenant);
  END IF;
  IF v_debit_subject_id IS NULL OR v_credit_subject_id IS NULL THEN
    RAISE EXCEPTION 'Settlement subjects are missing: AR 1122, AP 2202, bank 1002 or cash 1001 are required'
      USING ERRCODE = 'P0001';
  END IF;

  IF ABS(v_fx) > 0.005 THEN
    v_fx_subject_id := public.finance_subject_id_for(ARRAY['6603'], v_tenant);
    IF v_fx_subject_id IS NULL THEN
      RAISE EXCEPTION 'FX gain/loss subject 6603 is missing for tenant %', v_tenant
        USING ERRCODE = 'P0001';
    END IF;
  ELSE
    v_fx := 0;
  END IF;

  INSERT INTO public.erp_ar_ap_settlements
    (corp_id, emp_id, settlement_type, source_id, period_id, amount, settlement_date,
     remark, idempotency_key, settled_by,
     settlement_rate, base_amount, book_base_amount, fx_gain_loss, tenant_id)
  VALUES (r.corp_id, r.emp_id, p_settlement_type, p_source_id, p_period_id, p_amount, v_date,
     p_remark, p_idempotency_key, v_actor,
     v_settle_rate, v_base_amount, v_book_base_amount, v_fx, v_tenant);

  IF p_settlement_type = 'receivable' THEN
    UPDATE public.erp_receivables_s_539dcf81_b ar
       SET paid_amount      = COALESCE(ar.paid_amount, 0) + p_amount,
           balance          = COALESCE(ar.balance, 0) - p_amount,
           base_paid_amount = COALESCE(ar.base_paid_amount, 0) + v_base_amount,
           base_balance     = COALESCE(ar.base_balance, 0) - v_book_base_amount,
           status = CASE WHEN COALESCE(ar.balance, 0) - p_amount <= 0.005 THEN 'closed' ELSE 'partially_paid' END,
           updated_at = NOW()
     WHERE ar.id = p_source_id AND ar.tenant_id = v_tenant;
  ELSE
    UPDATE public.erp_payables_s_539dcf81_b ap
       SET paid_amount      = COALESCE(ap.paid_amount, 0) + p_amount,
           balance          = COALESCE(ap.balance, 0) - p_amount,
           base_paid_amount = COALESCE(ap.base_paid_amount, 0) + v_base_amount,
           base_balance     = COALESCE(ap.base_balance, 0) - v_book_base_amount,
           status = CASE WHEN COALESCE(ap.balance, 0) - p_amount <= 0.005 THEN 'closed' ELSE 'partially_paid' END,
           updated_at = NOW()
     WHERE ap.id = p_source_id AND ap.tenant_id = v_tenant;
  END IF;

  -- 凭证头：单号带幂等键短码（原来只用 type+source+period，同一单据在一个
  -- 期间多次部分核销会产生重号凭证）
  INSERT INTO public.erp_vouchers_s_539dcf81_b
    (corp_id, emp_id, voucher_no, voucher_date, period_id, type, source_doc_no,
     total_amount, remark, status, currency, exchange_rate, tenant_id)
  VALUES (
    r.corp_id, r.emp_id,
    format('SET-%s-%s-%s', p_settlement_type, p_source_id,
           left(replace(p_idempotency_key::text, '-', ''), 8)),
    v_date, p_period_id, 'general', r.doc_no,
    CASE WHEN p_settlement_type = 'receivable' THEN v_base_amount ELSE v_book_base_amount END,
    CASE WHEN p_settlement_type = 'receivable' THEN '应收账款核销' ELSE '应付账款核销' END,
    'draft', v_line_currency,
    CASE WHEN v_line_currency IS NOT NULL THEN v_settle_rate ELSE 1 END,
    v_tenant)
  RETURNING id INTO v_voucher_id;

  -- 分录 1/2：往来与银行（外币行带原币金额与各自汇率）
  IF p_settlement_type = 'receivable' THEN
    INSERT INTO public.erp_voucher_details_s_539dcf81_b
      (corp_id, emp_id, voucher_id, line_no, subject_id, summary,
       debit_amount, credit_amount, currency, exchange_rate, debit_fc, credit_fc, tenant_id)
    VALUES
      (r.corp_id, r.emp_id, v_voucher_id, 1, v_debit_subject_id, '往来核销',
       v_base_amount, 0, v_line_currency, v_settle_rate, p_amount, 0, v_tenant),
      (r.corp_id, r.emp_id, v_voucher_id, 2, v_credit_subject_id, '往来核销',
       0, v_book_base_amount, v_line_currency, v_doc_rate, 0, p_amount, v_tenant);
  ELSE
    INSERT INTO public.erp_voucher_details_s_539dcf81_b
      (corp_id, emp_id, voucher_id, line_no, subject_id, summary,
       debit_amount, credit_amount, currency, exchange_rate, debit_fc, credit_fc, tenant_id)
    VALUES
      (r.corp_id, r.emp_id, v_voucher_id, 1, v_debit_subject_id, '往来核销',
       v_book_base_amount, 0, v_line_currency, v_doc_rate, p_amount, 0, v_tenant),
      (r.corp_id, r.emp_id, v_voucher_id, 2, v_credit_subject_id, '往来核销',
       0, v_base_amount, v_line_currency, v_settle_rate, 0, p_amount, v_tenant);
  END IF;

  -- 分录 3：汇兑损益（本位币行，故 currency 为 NULL）
  IF v_fx <> 0 THEN
    INSERT INTO public.erp_voucher_details_s_539dcf81_b
      (corp_id, emp_id, voucher_id, line_no, subject_id, summary,
       debit_amount, credit_amount, currency, exchange_rate, debit_fc, credit_fc, tenant_id)
    VALUES (
      r.corp_id, r.emp_id, v_voucher_id, 3, v_fx_subject_id,
      CASE WHEN v_fx > 0 THEN '核销汇兑损失' ELSE '核销汇兑收益' END,
      CASE WHEN v_fx > 0 THEN v_fx ELSE 0 END,
      CASE WHEN v_fx < 0 THEN -v_fx ELSE 0 END,
      NULL, 1,
      CASE WHEN v_fx > 0 THEN v_fx ELSE 0 END,
      CASE WHEN v_fx < 0 THEN -v_fx ELSE 0 END,
      v_tenant);
  END IF;

  -- 借贷平衡守卫（本位币口径）：过账函数里也有一道，这里提前拦，
  -- 报错信息能带上单据信息，排查更快
  DECLARE
    v_chk_debit  NUMERIC;
    v_chk_credit NUMERIC;
  BEGIN
    SELECT COALESCE(SUM(debit_amount), 0), COALESCE(SUM(credit_amount), 0)
      INTO v_chk_debit, v_chk_credit
      FROM public.erp_voucher_details_s_539dcf81_b
     WHERE voucher_id = v_voucher_id AND tenant_id = v_tenant AND is_deleted = 'n';
    IF ABS(v_chk_debit - v_chk_credit) >= 0.005 THEN
      RAISE EXCEPTION
        'Settlement voucher is not balanced: debit %, credit % (type %, source %)',
        v_chk_debit, v_chk_credit, p_settlement_type, p_source_id
        USING ERRCODE = '23514';
    END IF;
  END;

  PERFORM public.post_voucher_document(v_voucher_id, p_idempotency_key);

  UPDATE public.erp_ar_ap_settlements SET voucher_id = v_voucher_id
    WHERE settlement_type = p_settlement_type AND source_id = p_source_id
      AND idempotency_key = p_idempotency_key AND tenant_id = v_tenant;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'idempotent', FALSE,
    'source_id', p_source_id,
    'settled_amount', p_amount,
    'settlement_rate', v_settle_rate,
    'document_rate', v_doc_rate,
    'settled_base_amount', v_base_amount,
    'book_base_amount', v_book_base_amount,
    'fx_gain_loss', v_fx,
    'currency', v_line_currency,
    'voucher_id', v_voucher_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.settle_ar_ap(VARCHAR, INTEGER, INTEGER, NUMERIC, DATE, TEXT, UUID, NUMERIC) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.settle_ar_ap(VARCHAR, INTEGER, INTEGER, NUMERIC, DATE, TEXT, UUID, NUMERIC) TO authenticated;

-- ---------------------------------------------------------------------------
-- C. fail-loud 自检
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_body      TEXT;
  v_definer   BOOLEAN;
  v_old_count INTEGER;
  v_new_count INTEGER;
BEGIN
  -- C1. 旧的 7 参数版本必须已经不存在（否则前端 7 参调用会静默命中旧逻辑）
  SELECT COUNT(*) INTO v_old_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'settle_ar_ap'
     AND pg_get_function_identity_arguments(p.oid) =
         'p_settlement_type character varying, p_source_id integer, p_period_id integer, p_amount numeric, p_settlement_date date, p_remark text, p_idempotency_key uuid';
  IF v_old_count > 0 THEN
    RAISE EXCEPTION '[deploy_73] 旧的 7 参数 settle_ar_ap 仍然存在，会造成调用歧义';
  END IF;

  SELECT COUNT(*) INTO v_new_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'settle_ar_ap'
     AND pg_get_function_identity_arguments(p.oid) LIKE '%p_settlement_rate%';
  IF v_new_count <> 1 THEN
    RAISE EXCEPTION '[deploy_73] 新签名 settle_ar_ap 未找到（找到 % 个）', v_new_count;
  END IF;

  -- C2. 函数体指纹：必须真的在用 6603（汇兑损益）与 finance_subject_id_for
  SELECT p.prosrc INTO v_body
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'settle_ar_ap';
  IF v_body IS NULL
     OR v_body NOT LIKE '%6603%'
     OR v_body NOT LIKE '%finance_subject_id_for%'
     OR v_body NOT LIKE '%fx_gain_loss%'
     OR v_body NOT LIKE '%42501%' THEN
    RAISE EXCEPTION '[deploy_73] settle_ar_ap 未生效（缺少汇兑损益相关指纹）';
  END IF;

  -- C3. post_voucher_document 必须透传原币列
  SELECT p.prosrc INTO v_body
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'post_voucher_document';
  IF v_body IS NULL OR v_body NOT LIKE '%debit_fc%' OR v_body NOT LIKE '%tenant_id%' THEN
    RAISE EXCEPTION '[deploy_73] post_voucher_document 未生效（未透传原币/租户）';
  END IF;

  -- C4. post_voucher_document 必须仍是 SECURITY DEFINER（它要写 gl_entries，
  --     且原来就是 DEFINER，别在重写时把属性丢了）
  SELECT p.prosecdef INTO v_definer
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'post_voucher_document';
  IF v_definer IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION '[deploy_73] post_voucher_document 丢失了 SECURITY DEFINER';
  END IF;

  RAISE NOTICE '[deploy_73] 自检通过：旧签名已移除、汇兑损益与双金额透传均生效。';
END $$;
