-- ============================================================================
-- deploy_67_currency_tenant_scope.sql
-- 币别 / 汇率：把「租户可见性」从 PERMISSIVE 收敛为 RESTRICTIVE
--
-- 背景（2026-10-03 实测发现）：
--   deploy_65 用 install_role_table_rls() 给这两张表装的是 PERMISSIVE 策略：
--     (current_user_is_super_admin() OR tenant_id = current_tenant_id())
--     AND has_table_permission(<表>, <动作>)
--   「super_admin」那个 OR 分支**对 tenant_id 完全不设限** —— 只要当前用户是超管，
--   tenant_id 这一侧就被短路跳过，整张表（所有租户）都可见。
--
--   币别是唯一一张**每个租户都被主动播了种子**的表（seed_tenant_currencies +
--   trg_sys_tenants_seed_currencies），所以只有它一上来就暴露：
--     tenant 1 有 6 行 + tenant 2 有 6 行 = 12 行
--     超管打开「币别管理」→ 列表 12 行、汇率表单币别下拉 12 条 → 看着是每个币种双份。
--   （其他 erp_* 业务表 tenant 2 目前是空的，所以同样的问题只是暂时没显形。）
--
--   危害不止「显示重复」：页面上那 12 行的操作按钮拿的是真实行 id，超管点到别的租户
--   那一行做编辑/删除时，会**静默改掉另一个租户的币别**，界面没有任何提示。
--
-- 本脚本做什么：
--   给两张表各加一条 RESTRICTIVE 租户策略，与既有 PERMISSIVE 策略按 AND 组合：
--     (super_admin OR tenant_id = current_tenant_id()) AND has_table_permission(...)
--     AND (tenant_id = current_tenant_id())
--   化简后即 tenant_id = current_tenant_id() AND has_table_permission(...)，
--   超管不再跨租户可见这两张表（币别/汇率是租户业务主数据，跨租户查看没有业务语义）。
--
-- 影响面（已逐条核对）：
--   · 前端 authenticated 路径 —— 受约束，只返回当前租户的行【本次要修的就是它】
--   · service_role（ai-server）—— 有 BYPASSRLS，不受策略影响；但 ai-server 本来就
--     必须显式带 tenant_id（service_role 无 RLS 兜底），规则不变
--   · postgres / 表 owner —— relforcerowsecurity = false，owner 默认绕过 RLS，不受影响
--   · 写币别的那些函数（seed_tenant_currencies / trg_sys_tenants_seed_currencies /
--     set_base_currency）—— 全部 SECURITY DEFINER 且 owner = postgres，天然绕过 RLS，
--     **不会被新策略拦住**；尤其是「新建租户时播种币别」这条路径必须继续可用
--   · current_base_currency() / get_exchange_rate() —— SECURITY DEFINER，且函数体内部
--     已显式带 tenant_id = current_tenant_id()，行为不变
--   · 未分配租户（current_tenant_id() IS NULL）—— fail-closed，看不到任何币别（符合全站语义）
--
-- 注：脚本由 000_run_all 用 psql --single-transaction 执行，**不要写 BEGIN/COMMIT**。
-- 依赖：deploy_65（两张表 + 策略 + 相关函数）、deploy_41（install_role_table_rls）。
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) 加 RESTRICTIVE 租户策略
--    命名沿用项目里既有的 RESTRICTIVE 约定（见 sys_user_roles 的 tenant_scope_sys_user_roles）。
--    DROP + CREATE 保证可重复执行；表不存在会直接报错（fail-loud，说明前置脚本没跑）。
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS tenant_scope_erp_currencies_s_539dcf81_b
  ON public.erp_currencies_s_539dcf81_b;
CREATE POLICY tenant_scope_erp_currencies_s_539dcf81_b
  ON public.erp_currencies_s_539dcf81_b
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (tenant_id = public.current_tenant_id())
  WITH CHECK (tenant_id = public.current_tenant_id());

DROP POLICY IF EXISTS tenant_scope_erp_exchange_rates_s_539dcf81_b
  ON public.erp_exchange_rates_s_539dcf81_b;
CREATE POLICY tenant_scope_erp_exchange_rates_s_539dcf81_b
  ON public.erp_exchange_rates_s_539dcf81_b
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (tenant_id = public.current_tenant_id())
  WITH CHECK (tenant_id = public.current_tenant_id());

COMMENT ON POLICY tenant_scope_erp_currencies_s_539dcf81_b
  ON public.erp_currencies_s_539dcf81_b IS
  '租户收敛：连超管也只看得到自己租户的币别。与 PERMISSIVE 策略 AND 组合，见 deploy_67 头部说明。';
COMMENT ON POLICY tenant_scope_erp_exchange_rates_s_539dcf81_b
  ON public.erp_exchange_rates_s_539dcf81_b IS
  '租户收敛：连超管也只看得到自己租户的汇率。与 PERMISSIVE 策略 AND 组合，见 deploy_67 头部说明。';

-- ----------------------------------------------------------------------------
-- 2) 自检（fail-loud）
--    重点不是「策略建出来了」，而是「别把写币别的函数顺手改坏」——
--    trg_sys_tenants_seed_currencies 内部是 RAISE WARNING 不阻断开通的，
--    一旦函数不再是 SECURITY DEFINER，新租户会**静默地**没有币别。
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_rec RECORD;
  v_n INTEGER;
  v_bad TEXT := '';
  v_proc_missing TEXT;
BEGIN
  FOR v_rec IN
    SELECT * FROM (VALUES
      ('erp_currencies_s_539dcf81_b',     'tenant_scope_erp_currencies_s_539dcf81_b'),
      ('erp_exchange_rates_s_539dcf81_b', 'tenant_scope_erp_exchange_rates_s_539dcf81_b')
    ) AS t(tbl, pol)
  LOOP
    -- a) 策略存在，且必须是 RESTRICTIVE（建成 PERMISSIVE 就完全达不到目的）
    SELECT count(*) INTO v_n
    FROM pg_policies
    WHERE schemaname = 'public' AND tablename = v_rec.tbl
      AND policyname = v_rec.pol AND permissive = 'RESTRICTIVE';

    IF v_n <> 1 THEN
      v_bad := v_bad || format(' %s 缺少 RESTRICTIVE 策略 %s;', v_rec.tbl, v_rec.pol);
    END IF;

    -- b) 谓词必须真的引用 current_tenant_id()（防被写成 TRUE 之类的永真条件）
    SELECT count(*) INTO v_n
    FROM pg_policies
    WHERE schemaname = 'public' AND tablename = v_rec.tbl
      AND policyname = v_rec.pol
      AND qual LIKE '%current_tenant_id%'
      AND with_check LIKE '%current_tenant_id%';

    IF v_n <> 1 THEN
      v_bad := v_bad || format(' %s 的租户策略未引用 current_tenant_id();', v_rec.tbl);
    END IF;

    -- c) 表必须启用 RLS（策略不生效等于没装）
    SELECT count(*) INTO v_n
    FROM pg_class
    WHERE relname = v_rec.tbl
      AND relnamespace = 'public'::regnamespace
      AND relrowsecurity;

    IF v_n <> 1 THEN
      v_bad := v_bad || format(' %s 未启用 RLS;', v_rec.tbl);
    END IF;

    -- d) owner 不得 FORCE RLS：函数以 postgres 身份写表，force 之后连函数都会被拦
    SELECT count(*) INTO v_n
    FROM pg_class
    WHERE relname = v_rec.tbl
      AND relnamespace = 'public'::regnamespace
      AND relforcerowsecurity;

    IF v_n <> 0 THEN
      v_bad := v_bad || format(' %s 被 FORCE ROW LEVEL SECURITY，写入函数会被拦;', v_rec.tbl);
    END IF;
  END LOOP;

  -- e) 写币别 / 读币别的关键函数必须仍是 SECURITY DEFINER，否则会被新策略拦住
  SELECT string_agg(x.n, ', ') INTO v_proc_missing
  FROM (VALUES
    ('seed_tenant_currencies'), ('trg_sys_tenants_seed_currencies'),
    ('set_base_currency'), ('current_base_currency'), ('get_exchange_rate')
  ) AS x(n)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.proname = x.n AND p.prosecdef
  );

  IF v_proc_missing IS NOT NULL THEN
    v_bad := v_bad || format(' 以下函数不是 SECURITY DEFINER，会被租户策略拦住：%s;', v_proc_missing);
  END IF;

  IF v_bad <> '' THEN
    RAISE EXCEPTION '币别/汇率租户收敛自检未通过：%', v_bad;
  END IF;

  RAISE NOTICE 'deploy_67 OK：币别/汇率已收敛为「仅当前租户可见」，超管不再跨租户读取';
END;
$$;

-- ----------------------------------------------------------------------------
-- 3) 人工核验（部署后建议在本地实例上跑一次，确认超管只剩本租户的行）
--
--   BEGIN;
--   SET LOCAL ROLE authenticated;
--   SET LOCAL request.jwt.claims =
--     '{"sub":"<超管的 auth.users.id>","role":"authenticated"}';
--   SELECT current_tenant_id() AS 当前租户, count(*) AS 可见币别数
--     FROM public.erp_currencies_s_539dcf81_b WHERE is_deleted = 'n';
--   -- 期望：当前租户 = 该超管的 tenant_id，可见币别数 = 本租户币别数（不再翻倍）
--   ROLLBACK;
-- ----------------------------------------------------------------------------

-- 回滚提示
--   DROP POLICY IF EXISTS tenant_scope_erp_currencies_s_539dcf81_b
--     ON public.erp_currencies_s_539dcf81_b;
--   DROP POLICY IF EXISTS tenant_scope_erp_exchange_rates_s_539dcf81_b
--     ON public.erp_exchange_rates_s_539dcf81_b;
--   （回滚后恢复「超管跨租户可见」，前端若仍带 tenant_id 过滤，界面表现不变。）
