-- ============================================================================
-- deploy_45_sys_logs_tenant.sql — 系统日志的租户隔离
--
-- 依赖：deploy_41_tenant_isolation.sql（sys_tenants / current_tenant_id()）
--
-- 为什么单独一个脚本：deploy_41 的循环条件是 table_name LIKE 'erp\_%'，
-- sys_logs 属 sys_ 前缀，没被覆盖，所以现在日志仍然全局可见。
--
-- 与 deploy_41 对 erp_* 表做法的一处关键差异（重要）：
--   erp_* 表：tenant_id NOT NULL，解析失败直接报错（fail-loud）
--   sys_logs：tenant_id 可空
--   理由：日志是诊断数据，不该因为租户解析失败就丢日志或阻断业务。
--         logger.ts 的 logOperation 已经 try/catch 包住写入，
--         但「写不进去」比「记成 NULL 只有超管可见」更糟 ——
--         排查线上问题时缺日志是完全被动的。
--         代价：无租户用户的日志对普通用户不可见（本就 fail-closed）。
--
-- 覆盖的入口：
--   1. src/utils/logger.ts        —— 前端 93 处调用（4 处 logOperation + 89 处 logWithTiming）
--   2. src/pages/system/Logs.tsx  —— 日志列表 / 单条删除 / 批量删除
--   3. src/components/SupaModal.tsx —— 单据操作历史（靠 params->>recordId 反查）
--   以上全靠 RLS 收敛，前端一行都不用改。
--
-- 执行方式（建议先干跑）：
--   BEGIN;  ... 本文件 ...  ROLLBACK;   -- 看 NOTICE
--   BEGIN;  ... 本文件 ...  COMMIT;     -- 确认后落地
-- ============================================================================


-- ============================================================================
-- 1. 加列：带 DEFAULT，前端 93 处调用点不用改
-- ============================================================================

DO $$
DECLARE
    default_tenant BIGINT;
    col_exists     BOOLEAN;
    backfilled     BIGINT;
    still_null     BIGINT;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name   = 'sys_logs'
          AND column_name  = 'tenant_id'
    ) INTO col_exists;

    IF col_exists THEN
        RAISE NOTICE 'sys_logs.tenant_id 已存在，跳过加列';
    ELSE
        SELECT id INTO default_tenant
        FROM public.sys_tenants
        WHERE code = 'default' AND is_deleted = 'n'
        LIMIT 1;

        -- 可空，理由见文件头。DEFAULT 让存量 insert 语句自动带上租户。
        EXECUTE 'ALTER TABLE public.sys_logs '
                'ADD COLUMN tenant_id BIGINT DEFAULT public.current_tenant_id()';

        RAISE NOTICE 'sys_logs: tenant_id 列已加入（可空，DEFAULT = current_tenant_id()）';

        -- 回填策略：先按 username 关联 sys_users 精确匹配，
        -- 匹配不到的（anonymous、已删除用户）落到 default 租户，
        -- 避免加了隔离之后历史日志对用户「凭空消失」。
        EXECUTE '
            UPDATE public.sys_logs l
            SET tenant_id = COALESCE(u.tenant_id, $1)
            FROM public.sys_users u
            WHERE l.tenant_id IS NULL
              AND l.username = u.username
        ' USING default_tenant;

        GET DIAGNOSTICS backfilled = ROW_COUNT;
        RAISE NOTICE 'sys_logs: 按 username 回填 % 行', backfilled;

        UPDATE public.sys_logs
        SET tenant_id = default_tenant
        WHERE tenant_id IS NULL;
        GET DIAGNOSTICS backfilled = ROW_COUNT;
        RAISE NOTICE 'sys_logs: 剩余 % 行落到 default 租户 (%)', backfilled, default_tenant;

        SELECT count(*) INTO still_null FROM public.sys_logs WHERE tenant_id IS NULL;
        IF still_null > 0 THEN
            RAISE WARNING 'sys_logs: 仍有 % 行 tenant_id 为 NULL（default 租户不存在？）', still_null;
        END IF;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_sys_logs_tenant_id
    ON public.sys_logs (tenant_id);

-- 日志页默认按 created_at 倒序分页，租户过滤后这个复合索引能吃下主查询
CREATE INDEX IF NOT EXISTS idx_sys_logs_tenant_created
    ON public.sys_logs (tenant_id, created_at DESC);

COMMENT ON COLUMN public.sys_logs.tenant_id IS
    '所属租户。由 DEFAULT current_tenant_id() 自动填充，前端写入无需显式传值';


-- ============================================================================
-- 2. RESTRICTIVE 租户策略
--
--    和 deploy_42 同一套打法：用 AS RESTRICTIVE 与 deploy_03 已有的
--    permissive 角色策略 AND 叠加，不改动旧策略。
--
--    最终判定 = (permissive 们 OR) AND (restrictive 们)
--    所以即使某个角色本来就有 sys_logs 的全部权限，这里也能把它收窄到本租户。
-- ============================================================================

DROP POLICY IF EXISTS tenant_isolation_sys_logs ON public.sys_logs;
CREATE POLICY tenant_isolation_sys_logs
ON public.sys_logs
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

-- 上面这一条同时覆盖 SELECT / INSERT / UPDATE / DELETE。
-- 效果：
--   SELECT —— 只能看本租户日志（超管看全部）
--   INSERT —— 不能伪造别的租户写日志
--   UPDATE/DELETE —— 日志页的删除/批量删除不能跨租户，
--                    否则租户 A 的管理员能抹掉租户 B 的操作痕迹


-- ============================================================================
-- 3. 可选的存量修复：user_id 一直是 NULL
--
--    这不是租户隔离的问题，是既有缺陷 —— logger.ts 只写了 username 字符串，
--    user_id 列从没被填过，导致日志无法直接关联到用户记录。
--    反查成本很低（username 就能匹配），顺手补上。
--    新写入的日志仍然不带 user_id（前端没传），要彻底修得改 logger.ts。
-- ============================================================================

DO $$
DECLARE
    fixed BIGINT;
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'sys_logs' AND column_name = 'user_id'
    ) THEN
        UPDATE public.sys_logs l
        SET user_id = u.id
        FROM public.sys_users u
        WHERE l.user_id IS NULL
          AND l.username = u.username;

        GET DIAGNOSTICS fixed = ROW_COUNT;
        RAISE NOTICE 'sys_logs: 回填 user_id % 行', fixed;
    ELSE
        RAISE NOTICE 'sys_logs: 无 user_id 列，跳过';
    END IF;
END $$;


-- ============================================================================
-- 4. 让 schema 缓存生效
-- ============================================================================

NOTIFY pgrst, 'reload schema';


-- ============================================================================
-- 5. 自检（单独跑，不要和上面混在一个事务里看结果）
-- ============================================================================

-- 5.1 各租户的日志分布
-- SELECT t.code, count(l.id) AS log_count
-- FROM public.sys_tenants t
-- LEFT JOIN public.sys_logs l ON l.tenant_id = t.id AND l.is_deleted = 'n'
-- GROUP BY t.code
-- ORDER BY t.code;

-- 5.2 策略是否已生效
-- SELECT policyname, cmd, permissive, qual
-- FROM pg_policies
-- WHERE schemaname = 'public' AND tablename = 'sys_logs';

-- 5.3 兜底：还有多少行没归属
-- SELECT count(*) FROM public.sys_logs WHERE tenant_id IS NULL AND is_deleted = 'n';

-- 5.4 回滚（加列和策略都可逆）
-- DROP POLICY IF EXISTS tenant_isolation_sys_logs ON public.sys_logs;
-- ALTER TABLE public.sys_logs DROP COLUMN IF EXISTS tenant_id;
-- NOTIFY pgrst, 'reload schema';


-- ============================================================================
-- 已知边界（不是 bug，但要知道）
-- ============================================================================
-- 1. 超管跨租户操作时的日志归属不准：
--    super_admin 操作租户 2 的数据，日志仍记在超管自己所属租户下。
--    要精确就得让 logger 显式传被操作数据的租户，那要动 93 处调用点，
--    收益不匹配成本，暂不做。
--
-- 2. deploy_43（JWT hook）未启用时，每次写日志都会因 DEFAULT 多查一次
--    sys_users。日志是高频写入，启用 hook 后走 app_metadata 即归零。
--
-- 3. anonymous 的日志会落到 default 租户。将来若开放公开注册，
--    登录前产生的日志归属需要重新定义。
-- ============================================================================
