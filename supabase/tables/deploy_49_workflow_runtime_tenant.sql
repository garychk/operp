-- ============================================================================
-- deploy_49：工作流运行数据租户隔离
--   wf_process_instances（流程实例，10 行）
--   wf_process_actions （审批动作，31 行）
--
-- 前置：deploy_41（sys_tenants / current_tenant_id）、deploy_48（install_tenant_scope
--       用的辅助函数）已执行。本脚本自带兜底，不依赖 deploy_48 的策略函数。
--
-- 为什么不用 deploy_48 的「平台基线 + 租户私有」：
--   这两张是**业务运行数据**，不是元数据。实例带着 document_type / document_no，
--   泄露出去等于别人能看到你的单据号和审批轨迹。跟 erp_* 同类，走 fail-closed：
--   tenant_id NOT NULL，看不到 NULL 行，解析不到租户就报错（响亮失败）。
--   代价：极端情况下（调用链拿不到 JWT 上下文）提交审批会直接报错而不是静默写入，
--   这正是想要的 —— 宁可报错，不要写出一条谁都能看到的流程实例。
--
-- 已确认的关键事实（决定脚本这样写）：
--   * public.workflow_execute_action() 是 SECURITY INVOKER（deploy_16:301），
--     RLS 对它生效，所以不需要像 deploy_48 那样去加固 definer 函数体。
--   * wf_process_instances.started_by / wf_process_actions.actor_id 都是 integer，
--     存的是 sys_users.id，可以据此回填租户。
--   * 两张表都没有需要改造的唯一键（不存在跨租户 conflict 问题）。
-- ============================================================================


-- ============================================================================
-- 1. 加列（可空 -> 回填 -> NOT NULL，不要一步 NOT NULL DEFAULT volatile）
-- ============================================================================

DO $$
DECLARE
    target_tables TEXT[] := ARRAY['wf_process_instances', 'wf_process_actions'];
    table_item TEXT;
BEGIN
    FOREACH table_item IN ARRAY target_tables
    LOOP
        IF NOT EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = table_item
              AND column_name = 'tenant_id'
        ) THEN
            EXECUTE format('ALTER TABLE public.%I ADD COLUMN tenant_id BIGINT', table_item);
        END IF;

        EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I',
            table_item, 'fk_' || table_item || '_tenant');
        EXECUTE format(
            'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (tenant_id) REFERENCES public.sys_tenants(id) ON DELETE RESTRICT',
            table_item, 'fk_' || table_item || '_tenant');

        EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON public.%I (tenant_id)',
            'idx_' || table_item || '_tenant_id', table_item);
    END LOOP;

    RAISE NOTICE 'tenant_id 列已就绪（wf_process_instances / wf_process_actions）';
END $$;


-- ============================================================================
-- 2. 回填
--    实例：流程定义 -> 发起人用户 -> 默认租户（三级兜底，顺序不能反）
--    动作：跟随所属实例 -> 操作人用户 -> 默认租户
--    动作必须后于实例回填，否则继承到的是 NULL。
-- ============================================================================

DO $$
DECLARE
    default_tenant_id BIGINT;
BEGIN
    SELECT id INTO default_tenant_id
    FROM public.sys_tenants
    WHERE code = 'default'
    ORDER BY id
    LIMIT 1;

    IF default_tenant_id IS NULL THEN
        SELECT id INTO default_tenant_id FROM public.sys_tenants ORDER BY id LIMIT 1;
    END IF;

    IF default_tenant_id IS NULL THEN
        RAISE EXCEPTION 'sys_tenants 为空，请先执行 deploy_41';
    END IF;

    -- 2.1 实例：跟随流程定义的租户。
    --     定义是基线（tenant_id IS NULL）时不生效，落到下一级 —— 基线定义不代表
    --     基线租户，谁发起的就归谁。
    UPDATE public.wf_process_instances i
    SET tenant_id = d.tenant_id
    FROM public.wf_process_definitions d
    WHERE i.tenant_id IS NULL
      AND d.id = i.process_id
      AND d.tenant_id IS NOT NULL;

    -- 2.2 实例：跟随发起人
    UPDATE public.wf_process_instances i
    SET tenant_id = u.tenant_id
    FROM public.sys_users u
    WHERE i.tenant_id IS NULL
      AND u.id = i.started_by
      AND u.tenant_id IS NOT NULL;

    -- 2.3 实例：剩余落默认租户
    UPDATE public.wf_process_instances
    SET tenant_id = default_tenant_id
    WHERE tenant_id IS NULL;

    -- 2.4 动作：跟随所属实例
    UPDATE public.wf_process_actions a
    SET tenant_id = i.tenant_id
    FROM public.wf_process_instances i
    WHERE a.tenant_id IS NULL
      AND i.id = a.instance_id
      AND i.tenant_id IS NOT NULL;

    -- 2.5 动作：跟随操作人（孤儿动作，实例已被删）
    UPDATE public.wf_process_actions a
    SET tenant_id = u.tenant_id
    FROM public.sys_users u
    WHERE a.tenant_id IS NULL
      AND u.id = a.actor_id
      AND u.tenant_id IS NOT NULL;

    -- 2.6 动作：剩余落默认租户
    UPDATE public.wf_process_actions
    SET tenant_id = default_tenant_id
    WHERE tenant_id IS NULL;

    RAISE NOTICE '工作流运行数据已回填（默认租户 %）', default_tenant_id;
END $$;


-- ============================================================================
-- 3. 父子一致性自检（只告警，不阻断）
--    动作跟实例租户不一致说明回填逻辑有盲区，需要人工看。
-- ============================================================================

DO $$
DECLARE
    mismatch_count BIGINT;
BEGIN
    SELECT count(*) INTO mismatch_count
    FROM public.wf_process_actions a
    JOIN public.wf_process_instances i ON i.id = a.instance_id
    WHERE a.tenant_id IS DISTINCT FROM i.tenant_id;

    IF mismatch_count > 0 THEN
        RAISE WARNING '有 % 条审批动作与所属实例的租户不一致，请人工核对', mismatch_count;
    ELSE
        RAISE NOTICE '父子租户一致性检查通过：0 条不一致';
    END IF;
END $$;


-- ============================================================================
-- 4. 设 DEFAULT + NOT NULL
--    DEFAULT 让 workflow_execute_action() 的 INSERT 无需改代码就能带上租户；
--    之后的 NOT NULL 保证不会再出现「谁都能看到」的 NULL 行。
-- ============================================================================

ALTER TABLE public.wf_process_instances
    ALTER COLUMN tenant_id SET DEFAULT public.current_tenant_id();
ALTER TABLE public.wf_process_actions
    ALTER COLUMN tenant_id SET DEFAULT public.current_tenant_id();

ALTER TABLE public.wf_process_instances ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE public.wf_process_actions  ALTER COLUMN tenant_id SET NOT NULL;


-- ============================================================================
-- 5. 装 fail-closed 租户策略
--    与 deploy_41 给 erp_* 用的一致：tenant_id = current_tenant_id()，
--    超管例外。RESTRICTIVE FOR ALL（含 DELETE），不动原有权限语义。
-- ============================================================================

DO $$
DECLARE
    target_tables TEXT[] := ARRAY['wf_process_instances', 'wf_process_actions'];
    table_item TEXT;
    has_base BOOLEAN;
BEGIN
    FOREACH table_item IN ARRAY target_tables
    LOOP
        -- RLS 要求至少一条 permissive 通过，否则 RESTRICTIVE 会让整表读不到
        SELECT EXISTS (
            SELECT 1 FROM pg_policies
            WHERE schemaname = 'public'
              AND tablename = table_item
              AND permissive = 'PERMISSIVE'
        ) INTO has_base;

        IF NOT has_base THEN
            EXECUTE format(
                'CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (TRUE) WITH CHECK (TRUE)',
                'tenant_base_' || table_item, table_item);
            RAISE NOTICE '  % : 补了兜底 permissive 策略', table_item;
        END IF;

        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I',
            'tenant_scope_' || table_item, table_item);
        EXECUTE format(
            'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR ALL TO authenticated '
            'USING (tenant_id = public.current_tenant_id() OR public.current_user_is_super_admin()) '
            'WITH CHECK (tenant_id = public.current_tenant_id() OR public.current_user_is_super_admin())',
            'tenant_scope_' || table_item, table_item);

        RAISE NOTICE '  % : fail-closed 租户策略已装', table_item;
    END LOOP;
END $$;


-- ============================================================================
-- 6. 自检
-- ============================================================================

DO $$
DECLARE
    table_item TEXT;
    null_count BIGINT;
    private_count BIGINT;
    policy_count INTEGER;
    target_tables TEXT[] := ARRAY['wf_process_instances', 'wf_process_actions'];
BEGIN
    RAISE NOTICE '--- 表 / 缺租户(NULL) / 已归属 / RESTRICTIVE 策略 ---';
    FOREACH table_item IN ARRAY target_tables
    LOOP
        EXECUTE format(
            'SELECT count(*) FILTER (WHERE tenant_id IS NULL), count(*) FILTER (WHERE tenant_id IS NOT NULL) FROM public.%I',
            table_item)
        INTO null_count, private_count;

        SELECT count(*) INTO policy_count
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = table_item
          AND policyname = 'tenant_scope_' || table_item
          AND permissive = 'RESTRICTIVE';

        IF policy_count = 0 THEN
            RAISE WARNING '% : 缺少 tenant_scope 策略！', table_item;
        END IF;

        RAISE NOTICE '% : null=% assigned=% policy=%', table_item, null_count, private_count, policy_count;
    END LOOP;
END $$;


-- 新策略对已有连接即刻生效，策略表达式是文本，不需要重刷
NOTIFY pgrst, 'reload schema';


-- ============================================================================
-- 回滚（需要撤销时手动执行）
--
-- DO $$
-- DECLARE t TEXT;
-- BEGIN
--     FOREACH t IN ARRAY ARRAY['wf_process_instances','wf_process_actions'] LOOP
--         EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'tenant_scope_' || t, t);
--         EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'tenant_base_' || t, t);
--         EXECUTE format('ALTER TABLE public.%I ALTER COLUMN tenant_id DROP DEFAULT', t);
--         EXECUTE format('ALTER TABLE public.%I ALTER COLUMN tenant_id DROP NOT NULL', t);
--         EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I', t, 'fk_' || t || '_tenant');
--         EXECUTE format('DROP INDEX IF EXISTS public.%I', 'idx_' || t || '_tenant_id');
--         EXECUTE format('ALTER TABLE public.%I DROP COLUMN IF EXISTS tenant_id', t);
--     END LOOP;
-- END $$;
-- ============================================================================
