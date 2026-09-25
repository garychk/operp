-- ============================================================================
-- deploy_42_ai_tenant.sql — ai-server 侧的多租户支撑
--
-- 依赖：deploy_41_tenant_isolation.sql（sys_tenants / current_tenant_id()）
--
-- 背景：ai-server 用 service_role 连接 PostgREST，service_role 带 BYPASSRLS，
--       数据库里的租户 RLS 对它完全无效。所以 ai-server 必须在应用层显式过滤，
--       本脚本只负责提供「能被过滤的东西」：
--
--   1. sys_baq_queries / sys_ai_chat_memory 补 tenant_id 列（erp_* 已在 deploy_41 完成）
--   2. 这两张表补 RESTRICTIVE 策略，让前端直连时也受租户约束
--   3. execute_ai_analysis 增加带租户校验的重载，给任意 SQL 加一层数据库侧兜底
--
-- 执行方式（建议先在事务里干跑）：
--   BEGIN;  ... 本文件 ...  ROLLBACK;   -- 看 NOTICE 输出
--   BEGIN;  ... 本文件 ...  COMMIT;     -- 确认无误后落地
-- ============================================================================


-- ============================================================================
-- 1. sys_baq_queries 补 tenant_id
--    BAQ 查询定义属于租户私有资产：租户 A 不该看到租户 B 设计的查询。
-- ============================================================================

DO $$
DECLARE
    default_tenant BIGINT;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'sys_baq_queries' AND column_name = 'tenant_id'
    ) THEN
        SELECT id INTO default_tenant FROM public.sys_tenants WHERE code = 'default' LIMIT 1;
        IF default_tenant IS NULL THEN
            SELECT id INTO default_tenant FROM public.sys_tenants ORDER BY id LIMIT 1;
        END IF;
        IF default_tenant IS NULL THEN
            RAISE EXCEPTION 'sys_tenants 为空，请先执行 deploy_41_tenant_isolation.sql';
        END IF;

        -- 分三步：先加可空列，再回填，最后收紧。
        -- 不能一步 ADD COLUMN NOT NULL DEFAULT current_tenant_id()：
        -- 迁移执行时 auth.uid() 为 NULL，默认值解析不出租户，会直接撞 NOT NULL。
        ALTER TABLE public.sys_baq_queries ADD COLUMN tenant_id BIGINT;
        UPDATE public.sys_baq_queries SET tenant_id = default_tenant WHERE tenant_id IS NULL;

        -- BAQ 编码目前全局唯一，多租户下应改成 (tenant_id, code)。
        -- 这里只做检查并提示，不自动改——重名要先由业务确认保留哪一条。
        RAISE NOTICE 'sys_baq_queries: tenant_id 已加入并回填为 %', default_tenant;
    ELSE
        RAISE NOTICE 'sys_baq_queries: tenant_id 已存在，跳过';
    END IF;
END $$;

DO $$
DECLARE
    dup_count INT;
BEGIN
    SELECT count(*) INTO dup_count
    FROM (
        SELECT tenant_id, code
        FROM public.sys_baq_queries
        WHERE is_deleted = 'n'
        GROUP BY tenant_id, code
        HAVING count(*) > 1
    ) d;

    IF dup_count > 0 THEN
        RAISE WARNING '--- sys_baq_queries 存在跨租户重名编码：% 组 ---', dup_count;
        RAISE WARNING '建议把 uq 改成 (tenant_id, code)，但需先由业务确认保留哪一条';
    ELSE
        RAISE NOTICE 'sys_baq_queries: 无跨租户重名编码';
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_sys_baq_queries_tenant_id
    ON public.sys_baq_queries (tenant_id);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_sys_baq_queries_tenant'
          AND conrelid = 'public.sys_baq_queries'::regclass
    ) THEN
        ALTER TABLE public.sys_baq_queries
            ADD CONSTRAINT fk_sys_baq_queries_tenant
            FOREIGN KEY (tenant_id) REFERENCES public.sys_tenants (id);
        RAISE NOTICE 'sys_baq_queries: 租户外键已建立';
    END IF;
END $$;


-- ============================================================================
-- 2. sys_ai_chat_memory 补 tenant_id
--    会话记忆按 session_id 检索，本身不容易串租户，但补上列才能在写入侧留痕，
--    也方便日后做「按租户清理会话」。
-- ============================================================================

DO $$
DECLARE
    default_tenant BIGINT;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'sys_ai_chat_memory' AND column_name = 'tenant_id'
    ) THEN
        SELECT id INTO default_tenant FROM public.sys_tenants WHERE code = 'default' LIMIT 1;
        IF default_tenant IS NULL THEN
            SELECT id INTO default_tenant FROM public.sys_tenants ORDER BY id LIMIT 1;
        END IF;

        ALTER TABLE public.sys_ai_chat_memory ADD COLUMN tenant_id BIGINT;
        UPDATE public.sys_ai_chat_memory SET tenant_id = default_tenant WHERE tenant_id IS NULL;
        RAISE NOTICE 'sys_ai_chat_memory: tenant_id 已加入并回填为 %', default_tenant;
    ELSE
        RAISE NOTICE 'sys_ai_chat_memory: tenant_id 已存在，跳过';
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_sys_ai_chat_memory_tenant_id
    ON public.sys_ai_chat_memory (tenant_id);


-- ============================================================================
-- 3. 两张表补 RESTRICTIVE 租户策略（面向前端直连场景）
--
--    用 AS RESTRICTIVE 是为了和 deploy_03 已有的 permissive 策略叠加：
--    Postgres 的最终判定是 (permissive 们 OR 起来) AND (restrictive 们)，
--    所以不必改动已有策略，也不会意外放开权限。
--    注意：ai-server 走 service_role 会绕过这些策略，那边靠应用层过滤。
-- ============================================================================

DROP POLICY IF EXISTS tenant_isolation_baq ON public.sys_baq_queries;
CREATE POLICY tenant_isolation_baq
ON public.sys_baq_queries
AS RESTRICTIVE
TO authenticated
USING (
    public.current_user_is_super_admin()
    OR tenant_id = public.current_tenant_id()
)
WITH CHECK (
    public.current_user_is_super_admin()
    OR tenant_id = public.current_tenant_id()
);

DROP POLICY IF EXISTS tenant_isolation_ai_memory ON public.sys_ai_chat_memory;
CREATE POLICY tenant_isolation_ai_memory
ON public.sys_ai_chat_memory
AS RESTRICTIVE
TO authenticated
USING (
    public.current_user_is_super_admin()
    OR tenant_id = public.current_tenant_id()
)
WITH CHECK (
    public.current_user_is_super_admin()
    OR tenant_id = public.current_tenant_id()
);


-- ============================================================================
-- 4. execute_ai_analysis 的租户安全重载
--
--    原函数 execute_ai_analysis(sql_text) 是 SECURITY DEFINER，
--    service_role 调用时 RLS 不生效，它执行的 SQL 必须自己带 tenant_id。
--
--    这里新增一个两参数重载（不动原函数，避免破坏现有调用方）：
--      execute_ai_analysis(sql_text text, p_tenant_id bigint)
--    内部做文本级兜底校验后再委托给原函数。
--
--    这层是「兜底」不是「强隔离」：文本校验挡不住语义正确但条件写错表的 SQL。
--    真正的强隔离方向是让分析走 BAQ 结构化查询——SQL 由服务端拼装，可 100% 注入租户条件。
-- ============================================================================

CREATE OR REPLACE FUNCTION public.execute_ai_analysis(sql_text text, p_tenant_id bigint)
RETURNS json
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
    erp_refs INT;
    tenant_hits INT;
BEGIN
    -- p_tenant_id 为空表示调用方放弃租户校验，直接走原行为
    IF p_tenant_id IS NULL THEN
        RETURN public.execute_ai_analysis(sql_text);
    END IF;

    -- SQL 只要引用了业务表，就必须出现 tenant_id 条件
    erp_refs := (SELECT count(*) FROM (
        SELECT regexp_matches(sql_text, '(^|[^a-z0-9_])(erp_[a-z0-9_]+)', 'gi') AS m
    ) x);

    IF erp_refs > 0 THEN
        tenant_hits := (SELECT count(*) FROM (
            SELECT regexp_matches(sql_text, 'tenant_id', 'gi') AS m
        ) y);

        IF tenant_hits < erp_refs THEN
            RAISE EXCEPTION
                'execute_ai_analysis: SQL 引用了 % 张业务表，但只出现 % 处 tenant_id 条件，已拒绝执行',
                erp_refs, tenant_hits;
        END IF;
    END IF;

    RETURN public.execute_ai_analysis(sql_text);
END;
$$;

COMMENT ON FUNCTION public.execute_ai_analysis(text, bigint) IS
    '带租户校验的重载：引用业务表时强制要求 tenant_id 条件，随后委托给单参数版本执行';

-- 让 PostgREST 重新加载 schema cache，否则新重载对 REST 不可见
NOTIFY pgrst, 'reload schema';


-- ============================================================================
-- 5. 自检
-- ============================================================================

DO $$
DECLARE
    baq_rows INT;
    baq_null INT;
    mem_rows INT;
    mem_null INT;
BEGIN
    EXECUTE 'SELECT count(*) FROM public.sys_baq_queries' INTO baq_rows;
    EXECUTE 'SELECT count(*) FROM public.sys_baq_queries WHERE tenant_id IS NULL' INTO baq_null;
    EXECUTE 'SELECT count(*) FROM public.sys_ai_chat_memory' INTO mem_rows;
    EXECUTE 'SELECT count(*) FROM public.sys_ai_chat_memory WHERE tenant_id IS NULL' INTO mem_null;

    RAISE NOTICE '--- deploy_42 自检 ---';
    RAISE NOTICE 'sys_baq_queries    : 共 % 行，tenant_id 为空 % 行', baq_rows, baq_null;
    RAISE NOTICE 'sys_ai_chat_memory : 共 % 行，tenant_id 为空 % 行', mem_rows, mem_null;
    IF baq_null > 0 OR mem_null > 0 THEN
        RAISE WARNING '仍存在 tenant_id 为空的行，请人工回填后再收紧为 NOT NULL';
    END IF;
END $$;


-- ----------------------------------------------------------------------------
-- 执行后仍待处理（ai-server 侧已完成应用层过滤，以下为后续项）：
--   - 唯一键复合化：(tenant_id, code) / (tenant_id, year, month) 等，见 deploy_41 第 10 节清单
--   - BAQ 定义生成的 SQL 执行路径：目前 BAQ 只存定义未由 ai-server 执行，执行时要注入租户条件
--   - 知识库 sys_ai_knowledge_* 目前是全局共享，若需租户隔离要另行加列
-- ----------------------------------------------------------------------------
