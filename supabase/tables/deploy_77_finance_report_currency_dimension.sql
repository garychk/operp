-- ============================================================================
-- deploy_77_finance_report_currency_dimension.sql
-- 多币别改造 · 第 3 期（财务）· 步骤 6/6：报表的「币种维度」
--
-- 依赖 deploy_72（gl_entries 的 currency / debit_fc / credit_fc）、
--      deploy_75（三个聚合视图的 tenant_id 维度）。
--
-- 为什么还需要这一步：
--
--   deploy_75 把试算平衡 / 科目余额 / 总账余额统一成**本位币口径**——这是
--   记账口径，也是"试算必须平"的口径，不能动。但评估文档 §3.5 要求的
--   「试算平衡、科目余额要能看到币种维度」还没落地：本位币汇总把 USD 和
--   CNY 折成一列之后，**没法回答"这个 USD 账户本月原币发生额是多少"**，
--   也无法核对"GL 里的 USD 原币合计 = 应收应付里 USD 的原币合计"。
--
--   所以这里不是改口径，而是**并列一张原币发生额表**：
--     · vw_erp_trial_balance_fc      按 (租户, 期间, 币种) 汇总原币借贷
--     · vw_erp_gl_balance_fc         按 (租户, 期间, 科目, 币种) 汇总原币借贷
--   前端在这两张表上提供「币种口径」切换，与本位币口径的报表并列展示。
--
-- ── 两个必须写对的地方 ─────────────────────────────────────────────────────
--
--  1) 只统计**外币行**（currency IS NOT NULL）。本位币行（含调汇分录）的
--     currency 为 NULL、debit_fc/credit_fc 为 0（见 deploy_73 的
--     post_voucher_document 与 deploy_74 的调汇分录），若不过滤就会混进
--     一堆 0，让"原币合计"看着像被吞掉了。
--
--  2) 原币借贷**不平是正常的**：一张凭证里外币行只有 1~2 行（例如
--     "借 1002 USD 1000 / 贷 1122 USD 1000"），但汇兑损益行是本位币行，
--     不参与原币合计。所以 fc_diff 只作参考，**不要**据此报"试算不平"。
--     真正的试算平衡永远看本位币口径的 vw_erp_trial_balance。
--
-- 视图是 SECURITY INVOKER，底层表 RLS 照旧生效（deploy_75 已让聚合带上
-- tenant_id，这里沿用同样的分组维度）。
--
-- 运行环境：由 000_run_all.local.sh 以 psql --single-transaction 执行，
--           脚本内**不要**写 BEGIN / COMMIT。
-- ============================================================================

\echo '[deploy_77] 报表币种维度（原币发生额视图）...'

-- ---------------------------------------------------------------------------
-- 1) vw_erp_trial_balance_fc：按币种的原币发生额试算
--    fc_diff 仅作参考（外币行不含汇兑损益行，天然不平）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.vw_erp_trial_balance_fc AS
SELECT
  e.tenant_id,
  e.period_id,
  e.currency,
  SUM(COALESCE(e.debit_fc, 0))                          AS total_fc_debit,
  SUM(COALESCE(e.credit_fc, 0))                         AS total_fc_credit,
  SUM(COALESCE(e.debit_fc, 0)) - SUM(COALESCE(e.credit_fc, 0)) AS fc_diff,
  COUNT(*)                                              AS line_count
FROM public.erp_gl_entries e
WHERE e.is_deleted = 'n' AND e.currency IS NOT NULL
GROUP BY e.tenant_id, e.period_id, e.currency;

COMMENT ON VIEW public.vw_erp_trial_balance_fc IS
  '按币种的原币发生额试算。只含外币行（currency IS NOT NULL）；fc_diff 仅作参考，外币行不含汇兑损益行故天然不平，试算平衡请用 vw_erp_trial_balance（本位币口径）。';

-- ---------------------------------------------------------------------------
-- 2) vw_erp_gl_balance_fc：按 (科目, 币种) 的原币发生额
--    总账余额页与科目余额页的「币种口径」共用这张表
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.vw_erp_gl_balance_fc AS
SELECT
  e.tenant_id,
  e.period_id,
  e.subject_id,
  e.currency,
  SUM(COALESCE(e.debit_fc, 0))  AS fc_debit,
  SUM(COALESCE(e.credit_fc, 0)) AS fc_credit,
  COUNT(*)                      AS line_count
FROM public.erp_gl_entries e
WHERE e.is_deleted = 'n' AND e.currency IS NOT NULL
GROUP BY e.tenant_id, e.period_id, e.subject_id, e.currency;

COMMENT ON VIEW public.vw_erp_gl_balance_fc IS
  '按 (科目, 币种) 汇总的原币借贷发生额。与 vw_erp_gl_balance（本位币口径）并列使用。';

GRANT SELECT ON public.vw_erp_trial_balance_fc TO authenticated;
GRANT SELECT ON public.vw_erp_gl_balance_fc TO authenticated;

-- ---------------------------------------------------------------------------
-- 3) fail-loud 自检
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_def   TEXT;
  v_miss  TEXT := '';
BEGIN
  -- 3.1 两个视图的列必须齐（前端按名取值，缺列会静默渲染成空）
  SELECT string_agg(t.v || '.' || t.c, ', ') INTO v_miss
    FROM (VALUES
      ('vw_erp_trial_balance_fc', 'tenant_id'),
      ('vw_erp_trial_balance_fc', 'period_id'),
      ('vw_erp_trial_balance_fc', 'currency'),
      ('vw_erp_trial_balance_fc', 'total_fc_debit'),
      ('vw_erp_trial_balance_fc', 'total_fc_credit'),
      ('vw_erp_trial_balance_fc', 'fc_diff'),
      ('vw_erp_trial_balance_fc', 'line_count'),
      ('vw_erp_gl_balance_fc', 'tenant_id'),
      ('vw_erp_gl_balance_fc', 'period_id'),
      ('vw_erp_gl_balance_fc', 'subject_id'),
      ('vw_erp_gl_balance_fc', 'currency'),
      ('vw_erp_gl_balance_fc', 'fc_debit'),
      ('vw_erp_gl_balance_fc', 'fc_credit'),
      ('vw_erp_gl_balance_fc', 'line_count')
    ) AS t(v, c)
   WHERE NOT EXISTS (
     SELECT 1 FROM information_schema.columns ic
      WHERE ic.table_schema = 'public' AND ic.table_name = t.v AND ic.column_name = t.c
   );
  IF v_miss <> '' THEN
    RAISE EXCEPTION '[deploy_77] 以下视图列缺失：%', v_miss;
  END IF;

  -- 3.2 必须过滤掉本位币行，否则原币合计被一堆 0 稀释
  SELECT pg_get_viewdef('public.vw_erp_trial_balance_fc'::regclass, true) INTO v_def;
  IF v_def NOT LIKE '%currency IS NOT NULL%' THEN
    RAISE EXCEPTION '[deploy_77] vw_erp_trial_balance_fc 未过滤 currency IS NOT NULL';
  END IF;
  IF v_def NOT LIKE '%GROUP BY%tenant_id%' THEN
    RAISE EXCEPTION '[deploy_77] vw_erp_trial_balance_fc 未按租户分组';
  END IF;

  SELECT pg_get_viewdef('public.vw_erp_gl_balance_fc'::regclass, true) INTO v_def;
  IF v_def NOT LIKE '%currency IS NOT NULL%' THEN
    RAISE EXCEPTION '[deploy_77] vw_erp_gl_balance_fc 未过滤 currency IS NOT NULL';
  END IF;
  IF v_def NOT LIKE '%GROUP BY%currency%' THEN
    RAISE EXCEPTION '[deploy_77] vw_erp_gl_balance_fc 未按币种分组';
  END IF;

  -- 3.3 本位币口径的两个视图不能被本脚本改动（回归断言）
  SELECT pg_get_viewdef('public.vw_erp_trial_balance'::regclass, true) INTO v_def;
  IF v_def LIKE '%debit_fc%' THEN
    RAISE EXCEPTION '[deploy_77] vw_erp_trial_balance 被改成原币口径了，本位币试算口径必须保留';
  END IF;

  RAISE NOTICE '[deploy_77] 自检通过：原币发生额视图就位，本位币口径视图未受影响。';
END $$;
