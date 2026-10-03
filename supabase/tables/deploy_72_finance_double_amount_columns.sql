-- ============================================================================
-- deploy_72_finance_double_amount_columns.sql
-- 多币别改造 · 第 3 期（财务）· 步骤 2/5：凭证/总账双金额 + 本位币余额
--
-- 依赖 deploy_68 / deploy_69（AR/AP 已有 currency / exchange_rate / base_amount）、
--      deploy_71（6603 科目）。
--
-- 本脚本只做列与回填，不碰任何函数逻辑（函数在 deploy_73 重写）。
--
-- 口径约定（沿用全期已拍板决策）：
--   · 汇率方向写死 `1 单位外币 = exchange_rate 单位本位币`，不许反用。
--   · 原币金额列一律用 `_fc` 后缀（fc = foreign currency）。
--   · 借贷金额成对：`debit_amount`/`credit_amount` = **本位币**（语义不变，
--     本次只是把这件事写进注释与视图），`debit_fc`/`credit_fc` = **原币**。
--   · 不采用「本位币 ÷ 汇率」反算原币（逐行四舍五入会对不上账）。
--
-- 加列清单：
--   erp_vouchers          : currency, exchange_rate
--   erp_voucher_details   : currency, exchange_rate, debit_fc, credit_fc
--   erp_gl_entries        : currency, exchange_rate, debit_fc, credit_fc
--   erp_receivables       : base_paid_amount, base_balance
--   erp_payables          : base_paid_amount, base_balance
--   erp_ar_ap_settlements : settlement_rate, base_amount, book_base_amount, fx_gain_loss
--
-- 回填策略（幂等）：
--   用「NULL 闸门」而不是「是否第一次加列」——加列时一律**不带 DEFAULT**，
--   旧行即为 NULL，回填后置 NOT NULL + DEFAULT。这样重复执行本脚本时
--   回填条件自然不成立，不会把已经正确的数据再刷一遍。
--   currency 列例外：它有语义（NULL = 本位币），保留可空。
--
-- 运行环境：由 000_run_all.local.sh 以 psql --single-transaction 执行，
--           脚本内**不要**写 BEGIN / COMMIT。
-- ============================================================================

\echo '[deploy_72] 凭证/总账双金额列 + 往来本位币余额...'

-- ---------------------------------------------------------------------------
-- A. erp_vouchers：凭证级币种（多币种凭证留 NULL）
-- ---------------------------------------------------------------------------
ALTER TABLE public.erp_vouchers_s_539dcf81_b
  ADD COLUMN IF NOT EXISTS currency      VARCHAR(10),
  ADD COLUMN IF NOT EXISTS exchange_rate NUMERIC(18,8);

COMMENT ON COLUMN public.erp_vouchers_s_539dcf81_b.currency IS
  '凭证币种（本位币一律为 NULL，多币种凭证也为 NULL）；原币金额见分录的 *_fc 列';
COMMENT ON COLUMN public.erp_vouchers_s_539dcf81_b.exchange_rate IS
  '凭证级汇率 1 外币 = N 本位币；凭证含多币种分录时无意义';
COMMENT ON COLUMN public.erp_vouchers_s_539dcf81_b.total_amount IS
  '本位币合计（过账时被置为借方本位币合计）';

-- ---------------------------------------------------------------------------
-- B. erp_voucher_details：分录双金额
-- ---------------------------------------------------------------------------
ALTER TABLE public.erp_voucher_details_s_539dcf81_b
  ADD COLUMN IF NOT EXISTS currency      VARCHAR(10),
  ADD COLUMN IF NOT EXISTS exchange_rate NUMERIC(18,8),
  ADD COLUMN IF NOT EXISTS debit_fc      NUMERIC(18,2),
  ADD COLUMN IF NOT EXISTS credit_fc     NUMERIC(18,2);

COMMENT ON COLUMN public.erp_voucher_details_s_539dcf81_b.debit_amount IS
  '借方**本位币**金额（口径与 debit_fc × exchange_rate 一致）';
COMMENT ON COLUMN public.erp_voucher_details_s_539dcf81_b.credit_amount IS
  '贷方**本位币**金额';
COMMENT ON COLUMN public.erp_voucher_details_s_539dcf81_b.debit_fc IS
  '借方**原币**金额';
COMMENT ON COLUMN public.erp_voucher_details_s_539dcf81_b.credit_fc IS
  '贷方**原币**金额';

-- ---------------------------------------------------------------------------
-- C. erp_gl_entries：总账双金额
--    注意该表**没有** _s_539dcf81_b 后缀（历史原因），别顺手改名。
-- ---------------------------------------------------------------------------
ALTER TABLE public.erp_gl_entries
  ADD COLUMN IF NOT EXISTS currency      VARCHAR(10),
  ADD COLUMN IF NOT EXISTS exchange_rate NUMERIC(18,8),
  ADD COLUMN IF NOT EXISTS debit_fc      NUMERIC(18,2),
  ADD COLUMN IF NOT EXISTS credit_fc     NUMERIC(18,2);

COMMENT ON COLUMN public.erp_gl_entries.debit_amount IS
  '借方**本位币**金额（试算平衡/科目余额一律按本列汇总）';
COMMENT ON COLUMN public.erp_gl_entries.credit_amount IS
  '贷方**本位币**金额';
COMMENT ON COLUMN public.erp_gl_entries.debit_fc IS
  '借方**原币**金额，仅用于「原币余额」视图，不参与试算平衡';

-- ---------------------------------------------------------------------------
-- D. erp_receivables / erp_payables：本位币已核销额与本位币余额
--    base_amount（deploy_68 已加）= 入账时的本位币金额
--    base_paid_amount             = 已核销的本位币累计
--    base_balance                 = **账面**本位币余额（期末调汇后可能不等于
--                                   base_amount - base_paid_amount，这正是调汇的意义）
-- ---------------------------------------------------------------------------
ALTER TABLE public.erp_receivables_s_539dcf81_b
  ADD COLUMN IF NOT EXISTS base_paid_amount NUMERIC(18,2),
  ADD COLUMN IF NOT EXISTS base_balance     NUMERIC(18,2);

ALTER TABLE public.erp_payables_s_539dcf81_b
  ADD COLUMN IF NOT EXISTS base_paid_amount NUMERIC(18,2),
  ADD COLUMN IF NOT EXISTS base_balance     NUMERIC(18,2);

COMMENT ON COLUMN public.erp_receivables_s_539dcf81_b.base_paid_amount IS
  '已核销的**本位币**累计额（按核销汇率折算）';
COMMENT ON COLUMN public.erp_receivables_s_539dcf81_b.base_balance IS
  '**账面本位币余额**；期末调汇会改写本列，故它未必等于 base_amount - base_paid_amount';
COMMENT ON COLUMN public.erp_payables_s_539dcf81_b.base_paid_amount IS
  '已核销的**本位币**累计额（按核销汇率折算）';
COMMENT ON COLUMN public.erp_payables_s_539dcf81_b.base_balance IS
  '**账面本位币余额**；期末调汇会改写本列，故它未必等于 base_amount - base_paid_amount';

-- ---------------------------------------------------------------------------
-- E. erp_ar_ap_settlements：核销双币与汇兑损益
--    amount             = 核销**原币**金额（语义不变）
--    settlement_rate    = 核销汇率（1 外币 = N 本位币）
--    base_amount        = 核销**本位币**金额 = amount × settlement_rate
--    book_base_amount   = 被冲减的**账面本位币**（按账面余额比率冲减；
--                         未调汇时即 amount × 单据汇率）
--    fx_gain_loss       = 汇兑损益（本位币）：> 0 为**损失**，< 0 为**收益**
-- ---------------------------------------------------------------------------
ALTER TABLE public.erp_ar_ap_settlements
  ADD COLUMN IF NOT EXISTS settlement_rate  NUMERIC(18,8),
  ADD COLUMN IF NOT EXISTS base_amount      NUMERIC(18,2),
  ADD COLUMN IF NOT EXISTS book_base_amount NUMERIC(18,2),
  ADD COLUMN IF NOT EXISTS fx_gain_loss     NUMERIC(18,2);

COMMENT ON COLUMN public.erp_ar_ap_settlements.amount IS
  '核销**原币**金额';
COMMENT ON COLUMN public.erp_ar_ap_settlements.base_amount IS
  '核销**本位币**金额 = amount × settlement_rate';
COMMENT ON COLUMN public.erp_ar_ap_settlements.book_base_amount IS
  '被冲减的**账面本位币**；按核销时账面余额比率冲减，故期末调汇后不等于 amount × 单据汇率';
COMMENT ON COLUMN public.erp_ar_ap_settlements.fx_gain_loss IS
  '汇兑损益（本位币）：**6603 的净借方发生额**，正数为损失、负数为收益';

-- ---------------------------------------------------------------------------
-- F. 回填（按行所在租户取本位币，而不是一律 'CNY'）
--    表当前为空，这些语句在既有库上是 no-op；保留是为了升级路径正确。
-- ---------------------------------------------------------------------------

-- F1. 凭证：币种取该租户的本位币
UPDATE public.erp_vouchers_s_539dcf81_b v
   SET currency = COALESCE((
         SELECT c.code FROM public.erp_currencies_s_539dcf81_b c
          WHERE c.tenant_id = v.tenant_id AND c.is_base AND c.is_deleted = 'n'
          LIMIT 1), public.current_base_currency(), 'CNY'),
       exchange_rate = 1
 WHERE v.currency IS NULL;

-- F2. 分录：历史上都是本位币 @ 1，原币金额 = 本位币金额
UPDATE public.erp_voucher_details_s_539dcf81_b d
   SET currency = COALESCE((
         SELECT c.code FROM public.erp_currencies_s_539dcf81_b c
          WHERE c.tenant_id = d.tenant_id AND c.is_base AND c.is_deleted = 'n'
          LIMIT 1), public.current_base_currency(), 'CNY'),
       exchange_rate = 1,
       debit_fc      = COALESCE(d.debit_amount, 0),
       credit_fc     = COALESCE(d.credit_amount, 0)
 WHERE d.currency IS NULL;

-- F3. 总账同上
UPDATE public.erp_gl_entries e
   SET currency = COALESCE((
         SELECT c.code FROM public.erp_currencies_s_539dcf81_b c
          WHERE c.tenant_id = e.tenant_id AND c.is_base AND c.is_deleted = 'n'
          LIMIT 1), public.current_base_currency(), 'CNY'),
       exchange_rate = 1,
       debit_fc      = COALESCE(e.debit_amount, 0),
       credit_fc     = COALESCE(e.credit_amount, 0)
 WHERE e.currency IS NULL;

-- F4. 往来：账面本位币余额 = 原币余额 × 单据汇率（历史上汇率恒为 1）
UPDATE public.erp_receivables_s_539dcf81_b r
   SET base_paid_amount = COALESCE(r.paid_amount, 0) * COALESCE(r.exchange_rate, 1),
       base_balance     = COALESCE(r.balance, COALESCE(r.amount, 0) - COALESCE(r.paid_amount, 0))
                          * COALESCE(r.exchange_rate, 1)
 WHERE r.base_paid_amount IS NULL OR r.base_balance IS NULL;

UPDATE public.erp_payables_s_539dcf81_b p
   SET base_paid_amount = COALESCE(p.paid_amount, 0) * COALESCE(p.exchange_rate, 1),
       base_balance     = COALESCE(p.balance, COALESCE(p.amount, 0) - COALESCE(p.paid_amount, 0))
                          * COALESCE(p.exchange_rate, 1)
 WHERE p.base_paid_amount IS NULL OR p.base_balance IS NULL;

-- F5. 核销记录：历史上没有汇率维度，一律 1:1
UPDATE public.erp_ar_ap_settlements s
   SET settlement_rate  = 1,
       base_amount      = COALESCE(s.amount, 0),
       book_base_amount = COALESCE(s.amount, 0),
       fx_gain_loss     = 0
 WHERE s.settlement_rate IS NULL;

-- ---------------------------------------------------------------------------
-- G. 回填完成后收紧约束
--    顺序：先 DEFAULT 再 NOT NULL。currency 保持可空（NULL = 本位币）。
-- ---------------------------------------------------------------------------
ALTER TABLE public.erp_vouchers_s_539dcf81_b
  ALTER COLUMN exchange_rate SET DEFAULT 1,
  ALTER COLUMN exchange_rate SET NOT NULL;

ALTER TABLE public.erp_voucher_details_s_539dcf81_b
  ALTER COLUMN exchange_rate SET DEFAULT 1,
  ALTER COLUMN exchange_rate SET NOT NULL,
  ALTER COLUMN debit_fc      SET DEFAULT 0,
  ALTER COLUMN debit_fc      SET NOT NULL,
  ALTER COLUMN credit_fc     SET DEFAULT 0,
  ALTER COLUMN credit_fc     SET NOT NULL;

ALTER TABLE public.erp_gl_entries
  ALTER COLUMN exchange_rate SET DEFAULT 1,
  ALTER COLUMN exchange_rate SET NOT NULL,
  ALTER COLUMN debit_fc      SET DEFAULT 0,
  ALTER COLUMN debit_fc      SET NOT NULL,
  ALTER COLUMN credit_fc     SET DEFAULT 0,
  ALTER COLUMN credit_fc     SET NOT NULL;

ALTER TABLE public.erp_receivables_s_539dcf81_b
  ALTER COLUMN base_paid_amount SET DEFAULT 0,
  ALTER COLUMN base_paid_amount SET NOT NULL,
  ALTER COLUMN base_balance     SET DEFAULT 0,
  ALTER COLUMN base_balance     SET NOT NULL;

ALTER TABLE public.erp_payables_s_539dcf81_b
  ALTER COLUMN base_paid_amount SET DEFAULT 0,
  ALTER COLUMN base_paid_amount SET NOT NULL,
  ALTER COLUMN base_balance     SET DEFAULT 0,
  ALTER COLUMN base_balance     SET NOT NULL;

ALTER TABLE public.erp_ar_ap_settlements
  ALTER COLUMN settlement_rate  SET DEFAULT 1,
  ALTER COLUMN settlement_rate  SET NOT NULL,
  ALTER COLUMN base_amount      SET DEFAULT 0,
  ALTER COLUMN base_amount      SET NOT NULL,
  ALTER COLUMN book_base_amount SET DEFAULT 0,
  ALTER COLUMN book_base_amount SET NOT NULL,
  ALTER COLUMN fx_gain_loss     SET DEFAULT 0,
  ALTER COLUMN fx_gain_loss     SET NOT NULL;

-- 汇率必须为正：0 或负数会让整个折算静默得出垃圾数据
ALTER TABLE public.erp_vouchers_s_539dcf81_b
  DROP CONSTRAINT IF EXISTS chk_vouchers_exchange_rate_positive;
ALTER TABLE public.erp_vouchers_s_539dcf81_b
  ADD CONSTRAINT chk_vouchers_exchange_rate_positive CHECK (exchange_rate > 0);

ALTER TABLE public.erp_voucher_details_s_539dcf81_b
  DROP CONSTRAINT IF EXISTS chk_voucher_details_exchange_rate_positive;
ALTER TABLE public.erp_voucher_details_s_539dcf81_b
  ADD CONSTRAINT chk_voucher_details_exchange_rate_positive CHECK (exchange_rate > 0);

ALTER TABLE public.erp_gl_entries
  DROP CONSTRAINT IF EXISTS chk_gl_entries_exchange_rate_positive;
ALTER TABLE public.erp_gl_entries
  ADD CONSTRAINT chk_gl_entries_exchange_rate_positive CHECK (exchange_rate > 0);

ALTER TABLE public.erp_ar_ap_settlements
  DROP CONSTRAINT IF EXISTS chk_settlements_rate_positive;
ALTER TABLE public.erp_ar_ap_settlements
  ADD CONSTRAINT chk_settlements_rate_positive CHECK (settlement_rate > 0);

-- 外币往来必须有汇率来源，否则折算无依据
ALTER TABLE public.erp_receivables_s_539dcf81_b
  DROP CONSTRAINT IF EXISTS chk_receivables_base_currency_rate;
ALTER TABLE public.erp_receivables_s_539dcf81_b
  ADD CONSTRAINT chk_receivables_base_currency_rate
  CHECK (currency IS NULL OR exchange_rate IS NOT NULL AND exchange_rate > 0);

ALTER TABLE public.erp_payables_s_539dcf81_b
  DROP CONSTRAINT IF EXISTS chk_payables_base_currency_rate;
ALTER TABLE public.erp_payables_s_539dcf81_b
  ADD CONSTRAINT chk_payables_base_currency_rate
  CHECK (currency IS NULL OR exchange_rate IS NOT NULL AND exchange_rate > 0);

-- ---------------------------------------------------------------------------
-- H. fail-loud 自检
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_missing TEXT := '';
  v_cnt     INTEGER;
BEGIN
  -- H1. 所有目标列都必须存在
  SELECT string_agg(t.tbl || '.' || t.col, ', ') INTO v_missing
    FROM (VALUES
      ('erp_vouchers_s_539dcf81_b', 'currency'),
      ('erp_vouchers_s_539dcf81_b', 'exchange_rate'),
      ('erp_voucher_details_s_539dcf81_b', 'currency'),
      ('erp_voucher_details_s_539dcf81_b', 'exchange_rate'),
      ('erp_voucher_details_s_539dcf81_b', 'debit_fc'),
      ('erp_voucher_details_s_539dcf81_b', 'credit_fc'),
      ('erp_gl_entries', 'currency'),
      ('erp_gl_entries', 'exchange_rate'),
      ('erp_gl_entries', 'debit_fc'),
      ('erp_gl_entries', 'credit_fc'),
      ('erp_receivables_s_539dcf81_b', 'base_paid_amount'),
      ('erp_receivables_s_539dcf81_b', 'base_balance'),
      ('erp_payables_s_539dcf81_b', 'base_paid_amount'),
      ('erp_payables_s_539dcf81_b', 'base_balance'),
      ('erp_ar_ap_settlements', 'settlement_rate'),
      ('erp_ar_ap_settlements', 'base_amount'),
      ('erp_ar_ap_settlements', 'book_base_amount'),
      ('erp_ar_ap_settlements', 'fx_gain_loss')
    ) AS t(tbl, col)
   WHERE NOT EXISTS (
     SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema = 'public' AND c.table_name = t.tbl AND c.column_name = t.col
   );
  IF v_missing <> '' THEN
    RAISE EXCEPTION '[deploy_72] 以下列缺失：%', v_missing;
  END IF;

  -- H2. 回填必须完成（不应再有 NULL 闸门未闭合的行）
  SELECT COUNT(*) INTO v_cnt FROM public.erp_voucher_details_s_539dcf81_b WHERE currency IS NULL;
  IF v_cnt > 0 THEN
    RAISE EXCEPTION '[deploy_72] 明细表仍有 % 行未回填币种', v_cnt;
  END IF;
  SELECT COUNT(*) INTO v_cnt FROM public.erp_gl_entries WHERE currency IS NULL;
  IF v_cnt > 0 THEN
    RAISE EXCEPTION '[deploy_72] 总账仍有 % 行未回填币种', v_cnt;
  END IF;
  SELECT COUNT(*) INTO v_cnt FROM public.erp_receivables_s_539dcf81_b
   WHERE base_balance IS NULL OR base_paid_amount IS NULL;
  IF v_cnt > 0 THEN
    RAISE EXCEPTION '[deploy_72] 应收仍有 % 行未回填本位币余额', v_cnt;
  END IF;
  SELECT COUNT(*) INTO v_cnt FROM public.erp_payables_s_539dcf81_b
   WHERE base_balance IS NULL OR base_paid_amount IS NULL;
  IF v_cnt > 0 THEN
    RAISE EXCEPTION '[deploy_72] 应付仍有 % 行未回填本位币余额', v_cnt;
  END IF;

  -- H3. 汇率正数约束必须生效（防有人把 CHECK 删掉）
  SELECT COUNT(*) INTO v_cnt FROM pg_constraint
   WHERE conname IN ('chk_vouchers_exchange_rate_positive',
                     'chk_voucher_details_exchange_rate_positive',
                     'chk_gl_entries_exchange_rate_positive',
                     'chk_settlements_rate_positive',
                     'chk_receivables_base_currency_rate',
                     'chk_payables_base_currency_rate');
  IF v_cnt <> 6 THEN
    RAISE EXCEPTION '[deploy_72] 汇率正数/币种配套 CHECK 只找到 % 个，应为 6 个', v_cnt;
  END IF;

  RAISE NOTICE '[deploy_72] 自检通过：18 列齐备，回填已闭合，6 条 CHECK 生效。';
END $$;
