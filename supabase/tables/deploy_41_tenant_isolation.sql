-- ============================================================================
-- deploy_41_tenant_isolation.sql
--
-- 多租户改造：共享库 + tenant_id 列 + RLS（pool 模型）
--
-- 前置：deploy_01 ~ deploy_40 已执行。
-- 需要 PostgreSQL 15+（用到 security_invoker），Supabase 本地/托管均满足。
--
-- 设计要点
--   1. 隔离由数据库引擎强制执行，不依赖应用层 WHERE。
--   2. 前端 .insert() 不用改：tenant_id 列带 DEFAULT public.current_tenant_id()。
--   3. 59 张 erp_* 表的 RLS 策略由 install_role_table_rls() 动态生成，
--      本脚本只改这一个函数，再重跑一遍即可全量重建（最大杠杆点）。
--   4. 租户谓词必须 AND 进原有策略，不能另建一条策略：
--      Postgres 多条 permissive 策略是 OR 关系，另建会直接漏数据。
--   5. super_admin 豁免，运维需要跨租户可见。
--   6. service_role（ai-server）拿不到 auth.uid()，current_tenant_id() 返回 NULL，
--      写入会因 NOT NULL 报错 —— 这是故意的 fail-loud，逼 ai-server 显式传
--      tenant_id，避免静默写到默认租户。
--
-- 未在本次处理的（见文件末尾 ROLLBACK 之后的 TODO 段）：
--   - ai-server 的 service_role 查询补 tenant_id 过滤
--   - 业务唯一键改 (tenant_id, xxx) 复合唯一
--   - 登录入口的租户识别（前端）
--
-- 如何执行（建议先干跑）：
--   首个可执行语句在第 32 行，最后一个在第 523 行结束。
--   在文件最前面加 BEGIN;，在最后加 ROLLBACK; 即是干跑 ——
--   所有 RAISE NOTICE 照常输出，可以据此确认范围，确认无误后把
--   ROLLBACK; 换成 COMMIT; 再跑一次。
--   注意：中途报错后只能 ROLLBACK，不能 COMMIT（事务已被标记为 aborted）。
-- ============================================================================


-- ============================================================================
-- 1. 租户表
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.sys_tenants (
    id SERIAL PRIMARY KEY,
    code VARCHAR(64) NOT NULL,
    name VARCHAR(200) NOT NULL,
    status CHAR(1) NOT NULL DEFAULT '1',
    is_deleted CHAR(1) NOT NULL DEFAULT 'n',
    remark TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_sys_tenants_code_active
    ON public.sys_tenants (code)
    WHERE is_deleted = 'n';

COMMENT ON TABLE public.sys_tenants IS '租户（客户公司）主数据';


-- ============================================================================
-- 2. sys_users 增加 tenant_id
-- ============================================================================

ALTER TABLE public.sys_users ADD COLUMN IF NOT EXISTS tenant_id BIGINT;

ALTER TABLE public.sys_users
    DROP CONSTRAINT IF EXISTS fk_sys_users_tenant;

ALTER TABLE public.sys_users
    ADD CONSTRAINT fk_sys_users_tenant
    FOREIGN KEY (tenant_id) REFERENCES public.sys_tenants(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_sys_users_tenant_id
    ON public.sys_users (tenant_id);

COMMENT ON COLUMN public.sys_users.tenant_id IS '所属租户，为空表示该用户未分配租户';


-- ============================================================================
-- 3. current_tenant_id()：租户上下文的唯一入口
--
--    解析顺序（先便宜后昂贵，且向前兼容）：
--      a) SET app.tenant_id  —— 给 service_role / psql / 后台脚本的逃生口
--      b) JWT app_metadata.tenant_id —— 接上 Custom Access Token Hook 后的目标形态
--      c) sys_users.tenant_id —— 当前形态，照抄 current_sys_user_id() 的套路
--
--    SECURITY DEFINER：避免读 sys_users 时被 sys_users 自己的 RLS 递归。
--    STABLE：让 planner 每条查询只求值一次，而不是每行一次。
-- ============================================================================

CREATE OR REPLACE FUNCTION public.current_tenant_id()
RETURNS BIGINT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    -- a) 逃生口：只在没有用户 JWT 时生效（service_role / psql / 后台脚本）。
    --    带 JWT 的真实用户请求不走这条，避免有人伪造 GUC 跨租户。
    CASE
      WHEN NULLIF(current_setting('request.jwt.claims', true), '') IS NULL
        THEN NULLIF(current_setting('app.tenant_id', true), '')::BIGINT
      ELSE NULL
    END,
    -- b) JWT app_metadata：接上 Custom Access Token Hook 后自动生效，零查库
    NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::BIGINT,
    -- c) 查 sys_users：当前形态
    (
      SELECT u.tenant_id
      FROM public.sys_users u
      WHERE u.auth_id = auth.uid()
        AND u.is_deleted = 'n'
      LIMIT 1
    )
  );
$$;

GRANT EXECUTE ON FUNCTION public.current_tenant_id() TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_tenant_id() TO service_role;


-- 原函数默认 VOLATILE，在 policy 里会逐行求值。改成 STABLE：
-- 同一条语句内 sys_users / sys_user_roles 不会变化，planner 可缓存结果。
-- 用 ALTER FUNCTION 而不是重定义，避免和 deploy_02 的正文产生漂移。
ALTER FUNCTION public.current_sys_user_id() STABLE;
ALTER FUNCTION public.has_table_permission(TEXT, TEXT) STABLE;
ALTER FUNCTION public.current_user_is_super_admin() STABLE;


-- ============================================================================
-- 4. 59 张 erp_* 表加 tenant_id
--
--    顺序很关键：先加可空列 -> 回填 -> 设 DEFAULT -> 设 NOT NULL。
--    不要一步到位 ADD COLUMN ... NOT NULL DEFAULT current_tenant_id()：
--    volatile 默认值会在 ALTER 当场求值（迁移者是 service_role，auth.uid() 为空），
--    直接撞 NOT NULL 约束。
-- ============================================================================

DO $$
DECLARE
    table_record RECORD;
    default_tenant_id BIGINT;
    default_tenant_code CONSTANT TEXT := 'default';
BEGIN
    INSERT INTO public.sys_tenants (code, name, remark)
    VALUES (default_tenant_code, '默认租户', '存量数据归属，由 deploy_41 自动创建')
    ON CONFLICT DO NOTHING;

    SELECT id INTO default_tenant_id
    FROM public.sys_tenants
    WHERE code = default_tenant_code
    LIMIT 1;

    -- 存量用户归属默认租户
    UPDATE public.sys_users
    SET tenant_id = default_tenant_id
    WHERE tenant_id IS NULL
      AND is_deleted = 'n';

    FOR table_record IN
        -- 以 information_schema 为准，不用 sys_tables 目录。
        -- 目录滞后会让某张表漏加 tenant_id，而漏掉的表不会被隔离 —— 静默泄露。
        SELECT c.table_name
        FROM information_schema.tables c
        WHERE c.table_schema = 'public'
          AND c.table_type = 'BASE TABLE'
          AND c.table_name LIKE 'erp\_%' ESCAPE '\'
        ORDER BY c.table_name
    LOOP
        EXECUTE format(
            'ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS tenant_id BIGINT',
            table_record.table_name
        );

        EXECUTE format(
            'UPDATE public.%I SET tenant_id = %s WHERE tenant_id IS NULL',
            table_record.table_name,
            default_tenant_id
        );

        EXECUTE format(
            'ALTER TABLE public.%I ALTER COLUMN tenant_id SET DEFAULT public.current_tenant_id()',
            table_record.table_name
        );

        EXECUTE format(
            'ALTER TABLE public.%I ALTER COLUMN tenant_id SET NOT NULL',
            table_record.table_name
        );

        EXECUTE format(
            'CREATE INDEX IF NOT EXISTS %I ON public.%I (tenant_id)',
            'idx_' || table_record.table_name || '_tenant_id',
            table_record.table_name
        );

        EXECUTE format(
            'ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I',
            table_record.table_name,
            'fk_' || table_record.table_name || '_tenant'
        );

        EXECUTE format(
            'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (tenant_id) REFERENCES public.sys_tenants(id) ON DELETE RESTRICT',
            table_record.table_name,
            'fk_' || table_record.table_name || '_tenant'
        );

        RAISE NOTICE 'tenant_id applied: %', table_record.table_name;
    END LOOP;
END $$;


-- ============================================================================
-- 5. 改造 install_role_table_rls()：把租户谓词 AND 进原有策略
--
--    兼容没有 tenant_id 列的表（sys_* 表走这条路），只加角色权限谓词。
--    策略名保持不变，重复执行是幂等的。
-- ============================================================================

CREATE OR REPLACE FUNCTION public.install_role_table_rls(target_table_name TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    has_tenant_column BOOLEAN;
    tenant_predicate TEXT;
    select_predicate TEXT;
    insert_predicate TEXT;
    update_predicate TEXT;
    delete_predicate TEXT;
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_type = 'BASE TABLE'
          AND table_name = target_table_name
    ) THEN
        RAISE EXCEPTION 'public.% does not exist', target_table_name;
    END IF;

    SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = target_table_name
          AND column_name = 'tenant_id'
    ) INTO has_tenant_column;

    IF has_tenant_column THEN
        -- super_admin 豁免：运维需要跨租户可见
        tenant_predicate := '(public.current_user_is_super_admin() OR tenant_id = public.current_tenant_id())';
    ELSE
        tenant_predicate := 'TRUE';
    END IF;

    select_predicate := format(
        '(%s AND public.has_table_permission(%L, %L))', tenant_predicate, target_table_name, 'select');
    insert_predicate := format(
        '(%s AND public.has_table_permission(%L, %L))', tenant_predicate, target_table_name, 'insert');
    update_predicate := format(
        '(%s AND public.has_table_permission(%L, %L))', tenant_predicate, target_table_name, 'update');
    delete_predicate := format(
        '(%s AND public.has_table_permission(%L, %L))', tenant_predicate, target_table_name, 'delete');

    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', target_table_name);

    -- SELECT
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'role_select_' || target_table_name, target_table_name);
    EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (%s)',
        'role_select_' || target_table_name, target_table_name, select_predicate);

    -- INSERT
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'role_insert_' || target_table_name, target_table_name);
    EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (%s)',
        'role_insert_' || target_table_name, target_table_name, insert_predicate);

    -- UPDATE
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'role_update_' || target_table_name, target_table_name);
    EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (%s) WITH CHECK (%s)',
        'role_update_' || target_table_name, target_table_name, update_predicate, update_predicate);

    -- DELETE
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'role_delete_' || target_table_name, target_table_name);
    EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING (%s)',
        'role_delete_' || target_table_name, target_table_name, delete_predicate);
END;
$$;


-- ============================================================================
-- 6. 重刷全部 erp_* 表的策略
--
--    与 deploy_04 的区别：deploy_04 遍历 sys_tables 目录，这里遍历
--    information_schema。理由同上 —— 目录漏一张表就是一次静默泄露。
-- ============================================================================

DO $$
DECLARE
    table_record RECORD;
BEGIN
    PERFORM public.refresh_sys_tables();

    FOR table_record IN
        -- 以 information_schema 为准，不用 sys_tables 目录。
        -- 目录滞后会让某张表漏加 tenant_id，而漏掉的表不会被隔离 —— 静默泄露。
        SELECT c.table_name
        FROM information_schema.tables c
        WHERE c.table_schema = 'public'
          AND c.table_type = 'BASE TABLE'
          AND c.table_name LIKE 'erp\_%' ESCAPE '\'
        ORDER BY c.table_name
    LOOP
        EXECUTE format(
            'GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated',
            table_record.table_name
        );

        IF EXISTS (
            SELECT 1
            FROM pg_class sequence_class
            JOIN pg_namespace sequence_schema ON sequence_schema.oid = sequence_class.relnamespace
            WHERE sequence_schema.nspname = 'public'
              AND sequence_class.relkind = 'S'
              AND sequence_class.relname = table_record.table_name || '_id_seq'
        ) THEN
            EXECUTE format(
                'GRANT USAGE, SELECT ON SEQUENCE public.%I TO authenticated',
                table_record.table_name || '_id_seq'
            );
        END IF;

        PERFORM public.install_role_table_rls(table_record.table_name);
    END LOOP;
END $$;


-- ============================================================================
-- 7. sys_users 的策略加租户范围
--
--    只收紧「按角色权限读/改用户」那两条（用户列表页走这条）。
--    自建 profile 的两条保持原样：首次登录时该行还不存在，
--    current_tenant_id() 必然为空，加租户谓词会让注册直接失败。
-- ============================================================================

DROP POLICY IF EXISTS "Role table permission can read users" ON public.sys_users;
CREATE POLICY "Role table permission can read users"
ON public.sys_users
FOR SELECT
TO authenticated
USING (
    public.has_table_permission('sys_users', 'select')
    AND (
        public.current_user_is_super_admin()
        OR tenant_id = public.current_tenant_id()
    )
);

DROP POLICY IF EXISTS "Role table permission can update users" ON public.sys_users;
CREATE POLICY "Role table permission can update users"
ON public.sys_users
FOR UPDATE
TO authenticated
USING (
    public.has_table_permission('sys_users', 'update')
    AND (
        public.current_user_is_super_admin()
        OR tenant_id = public.current_tenant_id()
    )
)
WITH CHECK (
    public.has_table_permission('sys_users', 'update')
    AND (
        public.current_user_is_super_admin()
        OR tenant_id = public.current_tenant_id()
    )
);


-- ============================================================================
-- 8. 财务视图补 security_invoker
--
--    Postgres 视图默认以 owner（postgres，带 BYPASSRLS）身份执行，
--    会完全绕过底层表的 RLS。deploy_18 的这 4 个视图漏了该选项，
--    不加上的话租户 A 的试算平衡表会把租户 B 的凭证一起汇总。
-- ============================================================================

CREATE OR REPLACE VIEW public.vw_erp_gl_balance
WITH (security_invoker = true) AS
SELECT
  e.period_id,
  e.subject_id,
  SUM(COALESCE(e.debit_amount, 0)) AS period_debit,
  SUM(COALESCE(e.credit_amount, 0)) AS period_credit
FROM public.erp_gl_entries e
WHERE e.is_deleted = 'n'
GROUP BY e.period_id, e.subject_id;

CREATE OR REPLACE VIEW public.vw_erp_trial_balance
WITH (security_invoker = true) AS
SELECT
  e.period_id,
  SUM(COALESCE(e.debit_amount, 0)) AS total_debit,
  SUM(COALESCE(e.credit_amount, 0)) AS total_credit,
  SUM(COALESCE(e.debit_amount, 0)) - SUM(COALESCE(e.credit_amount, 0)) AS balance_diff
FROM public.erp_gl_entries e
WHERE e.is_deleted = 'n'
GROUP BY e.period_id;

CREATE OR REPLACE VIEW public.vw_erp_subject_balance
WITH (security_invoker = true) AS
SELECT
  e.period_id,
  e.subject_id,
  SUM(COALESCE(e.debit_amount, 0)) AS debit_total,
  SUM(COALESCE(e.credit_amount, 0)) AS credit_total,
  SUM(COALESCE(e.debit_amount, 0)) - SUM(COALESCE(e.credit_amount, 0)) AS net_amount
FROM public.erp_gl_entries e
WHERE e.is_deleted = 'n'
GROUP BY e.period_id, e.subject_id;

CREATE OR REPLACE VIEW public.vw_erp_ledger_detail
WITH (security_invoker = true) AS
SELECT
  e.id,
  e.period_id,
  e.subject_id,
  e.voucher_id,
  e.voucher_detail_id,
  e.voucher_no,
  e.voucher_date,
  e.summary,
  e.debit_amount,
  e.credit_amount,
  e.source_type,
  e.source_id,
  e.source_detail_id,
  e.posted_at,
  e.posted_by,
  e.corp_id,
  e.emp_id,
  e.is_deleted,
  e.created_at,
  e.updated_at
FROM public.erp_gl_entries e
WHERE e.is_deleted = 'n';


-- ============================================================================
-- 9. 权限与目录同步
-- ============================================================================

GRANT SELECT, INSERT, UPDATE ON public.sys_tenants TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.sys_tenants_id_seq TO authenticated;

ALTER TABLE public.sys_tenants ENABLE ROW LEVEL SECURITY;

-- 租户表本身：只能看自己所属的那条；super_admin 全可见。
-- 注意 has_table_permission 在这里刻意没用：租户表是平台级数据，
-- 一旦角色拿到 select 权限就会看到全部租户，等于绕开隔离。
DROP POLICY IF EXISTS "Read own tenant" ON public.sys_tenants;
CREATE POLICY "Read own tenant"
ON public.sys_tenants
FOR SELECT
TO authenticated
USING (
    public.current_user_is_super_admin()
    OR id = public.current_tenant_id()
);

-- 增改租户只放开 super_admin。
-- super_admin 只是业务角色，Postgres 角色仍是 authenticated，照样受 RLS 约束，
-- 不建这条策略的话超管也插不进租户。
DROP POLICY IF EXISTS "Super admin can insert tenants" ON public.sys_tenants;
CREATE POLICY "Super admin can insert tenants"
ON public.sys_tenants
FOR INSERT
TO authenticated
WITH CHECK (public.current_user_is_super_admin());

DROP POLICY IF EXISTS "Super admin can update tenants" ON public.sys_tenants;
CREATE POLICY "Super admin can update tenants"
ON public.sys_tenants
FOR UPDATE
TO authenticated
USING (public.current_user_is_super_admin())
WITH CHECK (public.current_user_is_super_admin());

-- 让租户表进入数据驱动的表权限目录，后续可在系统管理界面配角色权限
SELECT public.refresh_sys_tables();


-- ============================================================================
-- 10. 自检：列出仍需人工处理的业务唯一键
--
--    下面这些唯一索引不含 tenant_id，多租户后会跨租户冲突
--    （例如租户 B 建 2026-01 会计期间会撞上租户 A 的）。
--    执行后把 NOTICE 里的清单抄出来，逐个改成 (tenant_id, ...) 复合唯一。
-- ============================================================================

DO $$
DECLARE
    index_record RECORD;
BEGIN
    RAISE NOTICE '--- 需要人工处理的唯一索引（不含 tenant_id）---';
    FOR index_record IN
        SELECT
            i.relname AS index_name,
            t.relname AS table_name,
            pg_get_indexdef(ix.indexrelid) AS definition
        FROM pg_class t
        JOIN pg_index ix ON t.oid = ix.indrelid
        JOIN pg_class i ON i.oid = ix.indexrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'public'
          AND t.relname LIKE 'erp\_%' ESCAPE '\'
          AND ix.indisunique
          AND NOT ix.indisprimary
          AND pg_get_indexdef(ix.indexrelid) NOT ILIKE '%tenant_id%'
        ORDER BY t.relname, i.relname
    LOOP
        RAISE NOTICE '% | % | %', index_record.table_name, index_record.index_name, index_record.definition;
    END LOOP;
    RAISE NOTICE '--- 清单结束 ---';
END $$;


-- ============================================================================
-- ROLLBACK（需要时单独执行，默认不跑）
--
-- DROP POLICY IF EXISTS "Read own tenant" ON public.sys_tenants;
-- DROP POLICY IF EXISTS "Super admin can insert tenants" ON public.sys_tenants;
-- DROP POLICY IF EXISTS "Super admin can update tenants" ON public.sys_tenants;
-- DROP VIEW IF EXISTS public.vw_erp_gl_balance;
-- DROP VIEW IF EXISTS public.vw_erp_trial_balance;
-- DROP VIEW IF EXISTS public.vw_erp_subject_balance;
-- DROP VIEW IF EXISTS public.vw_erp_ledger_detail;
-- -- 恢复策略：把 install_role_table_rls 还原成不带租户谓词的原版
-- --   （deploy_02_permissions_core.sql 第 220 行），再重跑第 6 节的循环
-- -- 去掉列（会丢数据，谨慎）：
-- -- DO $$ DECLARE r RECORD; BEGIN
-- --   FOR r IN SELECT table_name FROM public.sys_tables
-- --            WHERE table_name LIKE 'erp\_%' ESCAPE '\' LOOP
-- --     EXECUTE format('ALTER TABLE public.%I DROP COLUMN IF EXISTS tenant_id', r.table_name);
-- --   END LOOP;
-- -- END $$;
-- -- ALTER TABLE public.sys_users DROP COLUMN IF EXISTS tenant_id;
-- -- DROP TABLE IF EXISTS public.sys_tenants;
-- ============================================================================


-- ============================================================================
-- TODO：本次未做，按顺序跟进
--
--   A. ai-server（service_role，绕过 RLS）所有查询加 tenant_id 过滤。
--      过账类 RPC（post_inventory_document / 凭证过账等）目前靠 auth.uid()
--      取不到租户，需要加 p_tenant_id 入参由调用方显式传入。
--   B. 上面第 10 节列出来的唯一索引改成 (tenant_id, ...) 复合唯一。
--   C. 登录入口识别租户：邮箱域名映射 或 登录页加租户选择；
--      登录后校验 sys_users.tenant_id 与所选租户一致，不一致直接拒绝。
--   D. 接 Custom Access Token Hook，把 tenant_id 写进 JWT 的 app_metadata
--      （注意：只能用 app_metadata，raw_user_meta_data 用户可自行写入，
--        用来做授权等于自己给自己提权）。接上后 current_tenant_id() 会
--      自动优先走 JWT 分支，少一次查库。
--   E. 前端处理「用户未分配租户」：此时 current_tenant_id() 为空，
--      所有 erp 数据都查不到（fail-closed），需要给出明确提示而不是空白页。
-- ============================================================================
