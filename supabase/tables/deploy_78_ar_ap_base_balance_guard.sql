-- ============================================================================
-- deploy_78_ar_ap_base_balance_guard.sql
-- 多币别改造 · 第 3 期（财务）· 步骤 7/7：应收应付「账面本位币」的写入守卫
--
-- ── 为什么必须补这一步（第 3 期自查发现的**资金级隐患**）──────────────────
--
--   第 3 期让 settle_ar_ap 按「核销时账面余额比率」冲减账面本位币：
--
--       book_base_amount := ROUND(COALESCE(r.base_balance, 0) * p_amount / v_balance, 2)
--
--   但 base_balance 这一列**在所有真实写入路径上从来没人赋值**：
--     · deploy_69 自动生成的应收/应付：只写了 base_amount，base_balance 走默认 0
--     · 财务页手工新增（Receivables.tsx / Payables.tsx）：只写 amount / balance
--     · 任何 AI / ai-server 直写：同样不会知道要填它
--
--   于是「balance = 1000 CNY、base_balance = 0」这种行一旦核销：
--       book = 0 * 1000 / 1000 = 0
--       fx（应收）= book − base_amount = 0 − 1000 = −1000  →  凭空记 1000 元汇兑**收益**
--   数字不大但方向完全错，而且**全程不报错**（风险 4「静默串币」的账务版）。
--   第 3 期的冒烟测试之所以全绿，是因为测试数据是我手工 INSERT 的、
--   显式带了 base_balance —— 真实路径根本没走到。
--
-- ── 修法：一个 BEFORE 触发器把不变式钉在表上 ──────────────────────────────
--
--   不变式：**新单据的 base_amount = base_balance = amount × exchange_rate，
--   base_paid_amount = 0。**
--
--   1) INSERT：无条件按上式重算三列。调用方写什么都无所谓，这是"本位币记账"
--      的口径定义，不该让每个调用方各自实现一遍。
--
--   2) UPDATE：只在「单据金额/币种/汇率被改动」且「该行从未核销、且账面未被
--      调汇改写」时重算。这两个条件缺一不可：
--        · 不判"金额是否变了"：settle_ar_ap 的 UPDATE 会撞上
--          OLD.base_paid_amount = 0 且 OLD.base_balance = OLD.base_amount
--          （第一次核销前恰好成立）→ 把刚写进去的核销结果冲回原值。
--        · 不判"是否从未核销/未调汇"：会把期末调汇的成果抹掉。
--
--   3) 历史数据：一次性把「三列全零」的行补齐（调汇过的行 base_amount ≠ 0，
--      天然被排除，不会被覆盖）。
--
--   注意这**不是**在做记账：只是把 amount × rate 的乘积填进去。
--   期末调汇改写 base_balance 之后，触发器不会再插手该行。
--
-- 运行环境：由 000_run_all.local.sh 以 psql --single-transaction 执行，
--           脚本内**不要**写 BEGIN / COMMIT。
-- ============================================================================

\echo '[deploy_78] 应收应付账面本位币写入守卫...'

-- ---------------------------------------------------------------------------
-- 1) 历史数据补齐
--    判据刻意**不**是"三列全零"：deploy_69 自动生成的应收/应付写了 base_amount
--    却没写 base_balance，正是最危险的那一类（核销时 book 取到 0）。
--    正确判据 = 「账面为 0 但确实还有余额」且「没有核销/调汇痕迹」：
--      · base_paid_amount = 0  →  从未核销过
--      · base_balance ≠ 0 的行被 WHERE 排除  →  已被期末调汇改写，不能覆盖
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_rec INTEGER := 0;
  v_pay INTEGER := 0;
BEGIN
  UPDATE public.erp_receivables_s_539dcf81_b
     SET base_amount      = ROUND(COALESCE(amount, 0) * COALESCE(exchange_rate, 1), 2),
         base_balance     = ROUND(COALESCE(balance, 0) * COALESCE(exchange_rate, 1), 2),
         base_paid_amount = ROUND(COALESCE(paid_amount, 0) * COALESCE(exchange_rate, 1), 2)
   WHERE COALESCE(base_balance, 0) = 0
     AND COALESCE(balance, 0) <> 0
     AND COALESCE(base_paid_amount, 0) = 0;
  GET DIAGNOSTICS v_rec = ROW_COUNT;

  UPDATE public.erp_payables_s_539dcf81_b
     SET base_amount      = ROUND(COALESCE(amount, 0) * COALESCE(exchange_rate, 1), 2),
         base_balance     = ROUND(COALESCE(balance, 0) * COALESCE(exchange_rate, 1), 2),
         base_paid_amount = ROUND(COALESCE(paid_amount, 0) * COALESCE(exchange_rate, 1), 2)
   WHERE COALESCE(base_balance, 0) = 0
     AND COALESCE(balance, 0) <> 0
     AND COALESCE(base_paid_amount, 0) = 0;
  GET DIAGNOSTICS v_pay = ROW_COUNT;

  RAISE NOTICE '[deploy_78] 历史数据补齐：应收 % 行、应付 % 行', v_rec, v_pay;
END $$;

-- ---------------------------------------------------------------------------
-- 2) 触发器函数：把"新单据的账面本位币"钉死成 amount × exchange_rate
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sync_ar_ap_base_amount()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public'
AS $function$
DECLARE
  v_base NUMERIC;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_base := ROUND(COALESCE(NEW.amount, 0) * COALESCE(NEW.exchange_rate, 1), 2);
    NEW.base_amount      := v_base;
    NEW.base_balance     := v_base;
    NEW.base_paid_amount := 0;

  ELSIF TG_OP = 'UPDATE' THEN
    -- 只在「单据口径被改动」且「该行没有核销/调汇痕迹」时才跟随重算
    IF (NEW.amount        IS DISTINCT FROM OLD.amount
        OR NEW.exchange_rate IS DISTINCT FROM OLD.exchange_rate
        OR NEW.currency      IS DISTINCT FROM OLD.currency)
       AND COALESCE(OLD.base_paid_amount, 0) = 0
       AND COALESCE(OLD.base_balance, 0) = COALESCE(OLD.base_amount, 0) THEN
      v_base := ROUND(COALESCE(NEW.amount, 0) * COALESCE(NEW.exchange_rate, 1), 2);
      NEW.base_amount      := v_base;
      NEW.base_balance     := v_base;
      NEW.base_paid_amount := 0;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.sync_ar_ap_base_amount() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_sync_ar_ap_base_amount ON public.erp_receivables_s_539dcf81_b;
CREATE TRIGGER trg_sync_ar_ap_base_amount
  BEFORE INSERT OR UPDATE ON public.erp_receivables_s_539dcf81_b
  FOR EACH ROW EXECUTE FUNCTION public.sync_ar_ap_base_amount();

DROP TRIGGER IF EXISTS trg_sync_ar_ap_base_amount ON public.erp_payables_s_539dcf81_b;
CREATE TRIGGER trg_sync_ar_ap_base_amount
  BEFORE INSERT OR UPDATE ON public.erp_payables_s_539dcf81_b
  FOR EACH ROW EXECUTE FUNCTION public.sync_ar_ap_base_amount();

-- ---------------------------------------------------------------------------
-- 3) fail-loud 自检（含行为验证：静态断言查不出"触发器写反了"）
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_cnt    INTEGER;
  v_miss   TEXT := '';
  v_body   TEXT;
  v_probe  NUMERIC;
  v_tenant BIGINT;
BEGIN
  -- 3.1 两个触发器都必须挂上
  SELECT string_agg(t.t, ', ') INTO v_miss
    FROM (VALUES ('erp_receivables_s_539dcf81_b'), ('erp_payables_s_539dcf81_b')) AS t(t)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_trigger
      WHERE tgrelid = ('public.' || t.t)::regclass
        AND tgname = 'trg_sync_ar_ap_base_amount' AND NOT tgisinternal
   );
  IF v_miss <> '' THEN
    RAISE EXCEPTION '[deploy_78] 以下表缺少 trg_sync_ar_ap_base_amount 触发器：%', v_miss;
  END IF;

  -- 3.2 函数不能是 SECURITY DEFINER（它是行级守卫，不需要越权）
  SELECT pg_get_functiondef(p.oid) INTO v_body
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'sync_ar_ap_base_amount';
  IF v_body IS NULL THEN
    RAISE EXCEPTION '[deploy_78] sync_ar_ap_base_amount 不存在';
  END IF;
  IF v_body LIKE '%SECURITY DEFINER%' THEN
    RAISE EXCEPTION '[deploy_78] sync_ar_ap_base_amount 不应是 SECURITY DEFINER';
  END IF;
  IF v_body NOT LIKE '%NEW.base_balance%' THEN
    RAISE EXCEPTION '[deploy_78] sync_ar_ap_base_amount 没有写 base_balance';
  END IF;

  -- 3.3 行为验证：真插一行外币应收，看三列是否按 amount × rate 落库。
  --     tenant_id 显式取一个在册租户：psql 直连时 current_tenant_id() 取不到值。
  SELECT id INTO v_tenant
    FROM public.sys_tenants WHERE is_deleted = 'n' ORDER BY id LIMIT 1;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION '[deploy_78] 找不到任何在册租户，无法做行为验证';
  END IF;

  INSERT INTO public.erp_receivables_s_539dcf81_b (
    is_deleted, customer_id, doc_type, doc_no, doc_date,
    amount, paid_amount, balance, currency, exchange_rate, status, tenant_id
  ) VALUES (
    'n', NULL, 'other', '__deploy_78_probe__', CURRENT_DATE,
    200, 0, 200, 'USD', 7.25, 'open', v_tenant
  );
  SELECT base_balance INTO v_probe
    FROM public.erp_receivables_s_539dcf81_b
   WHERE doc_no = '__deploy_78_probe__' AND is_deleted = 'n';

  IF v_probe IS DISTINCT FROM ROUND(200 * 7.25, 2) THEN
    RAISE EXCEPTION '[deploy_78] 触发器未按 amount × rate 填充 base_balance（实测 %，期望 %）',
      v_probe, ROUND(200 * 7.25, 2);
  END IF;

  -- 3.3b 反向验证：核销式的 UPDATE（只改 paid_amount/balance/base_*）**不能**被触发器冲掉
  UPDATE public.erp_receivables_s_539dcf81_b
     SET paid_amount = 100, balance = 100,
         base_paid_amount = 725, base_balance = 725
   WHERE doc_no = '__deploy_78_probe__' AND is_deleted = 'n';
  SELECT base_balance INTO v_probe
    FROM public.erp_receivables_s_539dcf81_b
   WHERE doc_no = '__deploy_78_probe__' AND is_deleted = 'n';
  IF v_probe IS DISTINCT FROM 725 THEN
    RAISE EXCEPTION '[deploy_78] 触发器把核销结果冲掉了（实测 base_balance = %，期望 725）', v_probe;
  END IF;

  -- 3.3c 正向验证：改单据金额时应跟随重算
  UPDATE public.erp_receivables_s_539dcf81_b
     SET amount = 400 WHERE doc_no = '__deploy_78_probe__' AND is_deleted = 'n';
  -- 该行已有核销痕迹（base_paid_amount = 725 ≠ 0），按设计**不**重算
  SELECT base_amount INTO v_probe
    FROM public.erp_receivables_s_539dcf81_b
   WHERE doc_no = '__deploy_78_probe__' AND is_deleted = 'n';
  IF v_probe IS DISTINCT FROM ROUND(200 * 7.25, 2) THEN
    RAISE EXCEPTION '[deploy_78] 已核销行被误重算（实测 base_amount = %）', v_probe;
  END IF;

  -- 3.4 清理探针（触发器是 BEFORE 类型，删掉即可，不进任何账）
  DELETE FROM public.erp_receivables_s_539dcf81_b WHERE doc_no = '__deploy_78_probe__';

  -- 3.5 历史数据不留「账面为 0 却仍有余额」的行
  SELECT count(*) INTO v_cnt
    FROM public.erp_receivables_s_539dcf81_b
   WHERE COALESCE(balance, 0) <> 0 AND COALESCE(base_balance, 0) = 0;
  SELECT count(*) + v_cnt INTO v_cnt
    FROM public.erp_payables_s_539dcf81_b
   WHERE COALESCE(balance, 0) <> 0 AND COALESCE(base_balance, 0) = 0;
  IF v_cnt <> 0 THEN
    RAISE EXCEPTION '[deploy_78] 仍有 % 行「有余额但账面本位币为 0」，核销会算出假汇兑损益', v_cnt;
  END IF;

  RAISE NOTICE '[deploy_78] 自检通过：插入/更新守卫就位，历史行已补齐，无残留脏行。';
END $$;
