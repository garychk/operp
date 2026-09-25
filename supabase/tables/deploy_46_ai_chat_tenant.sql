-- ============================================================================
-- deploy_46_ai_chat_tenant.sql — AI 会话与消息的租户隔离
--
-- 依赖：deploy_41（sys_tenants / current_tenant_id()）
--
-- 背景：deploy_42 只处理了 sys_ai_chat_memory，漏了真正存对话内容的两张表。
--       sys_ai_chat_sessions（会话标题/摘要）和 sys_ai_chat_messages（完整对话）。
--
-- 现状比 sys_logs 更糟，这是本脚本最大的动因：
--   deploy_27 给这两张表建的策略是
--       FOR ALL TO authenticated USING (true) WITH CHECK (true)
--   即**任何登录用户都能读写全部会话和消息**，连表级权限校验都没有。
--   叠加 RESTRICTIVE 之后判定变成 (true) AND (租户条件) = 租户条件，正好收窄。
--
-- 为什么前端不用改：
--   所有 7 处读写都在 src/utils/aiChatSessions.ts，insert/upsert 都不带
--   tenant_id，靠列上的 DEFAULT public.current_tenant_id() 自动填充。
--   upsert 的 update 分支只改 payload 里出现的列，tenant_id 不在其中，保持不变。
--
-- 与 deploy_41 对 erp_* 做法的差异（同 deploy_45）：
--   erp_* 用 NOT NULL 做 fail-loud；这里用可空。
--   理由：无租户的用户本来就被 AIChatDrawer 拦住用不了 AI（C 阶段加的），
--        新数据不会产生 NULL；存量由回填处理。若仍为 NULL 则只有超管可见，
--        这比「写不进去导致对话丢失」可接受。
--
-- 执行方式（建议先干跑）：
--   BEGIN;  ... 本文件 ...  ROLLBACK;   -- 看 NOTICE
--   BEGIN;  ... 本文件 ...  COMMIT;     -- 确认后落地
-- ============================================================================


-- ============================================================================
-- 1. 加列 + 回填
-- ============================================================================

DO $$
DECLARE
    default_tenant BIGINT;
    v_added        BOOLEAN := FALSE;
    n_backfill     BIGINT;
    n_default      BIGINT;
    n_null         BIGINT;
BEGIN
    SELECT id INTO default_tenant
    FROM public.sys_tenants
    WHERE code = 'default' AND is_deleted = 'n'
    LIMIT 1;

    ---------------------------------------------------------------- sessions
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='sys_ai_chat_sessions' AND column_name='tenant_id'
    ) THEN
        EXECUTE 'ALTER TABLE public.sys_ai_chat_sessions '
                'ADD COLUMN tenant_id BIGINT DEFAULT public.current_tenant_id()';
        v_added := TRUE;
        RAISE NOTICE 'sys_ai_chat_sessions: 已加列';
    ELSE
        RAISE NOTICE 'sys_ai_chat_sessions: tenant_id 已存在，跳过加列';
    END IF;

    -- 会话表有 user_id，直接关联 sys_users 精确回填
    UPDATE public.sys_ai_chat_sessions s
    SET tenant_id = u.tenant_id
    FROM public.sys_users u
    WHERE s.tenant_id IS NULL
      AND s.user_id = u.id
      AND u.tenant_id IS NOT NULL;
    GET DIAGNOSTICS n_backfill = ROW_COUNT;
    RAISE NOTICE 'sys_ai_chat_sessions: 按 user_id 回填 % 行', n_backfill;

    UPDATE public.sys_ai_chat_sessions
    SET tenant_id = default_tenant
    WHERE tenant_id IS NULL;
    GET DIAGNOSTICS n_default = ROW_COUNT;
    RAISE NOTICE 'sys_ai_chat_sessions: 剩余 % 行落到 default 租户 (%)', n_default, default_tenant;

    ---------------------------------------------------------------- messages
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='sys_ai_chat_messages' AND column_name='tenant_id'
    ) THEN
        EXECUTE 'ALTER TABLE public.sys_ai_chat_messages '
                'ADD COLUMN tenant_id BIGINT DEFAULT public.current_tenant_id()';
        v_added := TRUE;
        RAISE NOTICE 'sys_ai_chat_messages: 已加列';
    ELSE
        RAISE NOTICE 'sys_ai_chat_messages: tenant_id 已存在，跳过加列';
    END IF;

    -- 消息表也有 user_id，同样精确回填
    UPDATE public.sys_ai_chat_messages m
    SET tenant_id = u.tenant_id
    FROM public.sys_users u
    WHERE m.tenant_id IS NULL
      AND m.user_id = u.id
      AND u.tenant_id IS NOT NULL;
    GET DIAGNOSTICS n_backfill = ROW_COUNT;
    RAISE NOTICE 'sys_ai_chat_messages: 按 user_id 回填 % 行', n_backfill;

    -- user_id 为空的消息：从所属会话继承（会话此时已回填完）
    UPDATE public.sys_ai_chat_messages m
    SET tenant_id = s.tenant_id
    FROM public.sys_ai_chat_sessions s
    WHERE m.tenant_id IS NULL
      AND m.session_id = s.id
      AND s.tenant_id IS NOT NULL;
    GET DIAGNOSTICS n_backfill = ROW_COUNT;
    RAISE NOTICE 'sys_ai_chat_messages: 按 session_id 继承回填 % 行', n_backfill;

    UPDATE public.sys_ai_chat_messages
    SET tenant_id = default_tenant
    WHERE tenant_id IS NULL;
    GET DIAGNOSTICS n_default = ROW_COUNT;
    RAISE NOTICE 'sys_ai_chat_messages: 剩余 % 行落到 default 租户 (%)', n_default, default_tenant;

    ------------------------------------------------------- 父子一致性校验
    -- 消息的租户必须和所属会话一致，不一致说明回填路径有问题，
    -- 只告警不自动改：自动改可能掩盖真实原因。
    SELECT count(*) INTO n_null
    FROM public.sys_ai_chat_messages m
    JOIN public.sys_ai_chat_sessions s ON s.id = m.session_id
    WHERE m.tenant_id IS DISTINCT FROM s.tenant_id;
    IF n_null > 0 THEN
        RAISE WARNING '有 % 条消息的租户与所属会话不一致，请人工核查', n_null;
    ELSE
        RAISE NOTICE '一致性校验通过：所有消息的租户与所属会话一致';
    END IF;

    IF v_added THEN
        RAISE NOTICE '两张表均已完成加列与回填';
    END IF;
END $$;


-- ============================================================================
-- 2. 索引
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_sys_ai_chat_sessions_tenant
    ON public.sys_ai_chat_sessions (tenant_id);

CREATE INDEX IF NOT EXISTS idx_sys_ai_chat_messages_tenant
    ON public.sys_ai_chat_messages (tenant_id);

-- fetchChatSessions 的主查询：本租户 + 未删除 + 按最后消息时间倒序
CREATE INDEX IF NOT EXISTS idx_sys_ai_chat_sessions_tenant_user_last
    ON public.sys_ai_chat_sessions (tenant_id, user_id, last_message_at DESC);

COMMENT ON COLUMN public.sys_ai_chat_sessions.tenant_id IS
    '所属租户，由 DEFAULT current_tenant_id() 自动填充';
COMMENT ON COLUMN public.sys_ai_chat_messages.tenant_id IS
    '所属租户，由 DEFAULT current_tenant_id() 自动填充，应与所属会话一致';


-- ============================================================================
-- 3. RESTRICTIVE 租户策略
--
--    deploy_27 的旧策略是 USING (true) WITH CHECK (true)，完全开放。
--    用 RESTRICTIVE 叠加后： (true) AND (下面这条) = 下面这条。
--    一条 FOR ALL 覆盖 SELECT/INSERT/UPDATE/DELETE，包括
--    deleteChatSession 里对 messages 的物理 DELETE。
-- ============================================================================

DROP POLICY IF EXISTS tenant_isolation_ai_chat_sessions ON public.sys_ai_chat_sessions;
CREATE POLICY tenant_isolation_ai_chat_sessions
ON public.sys_ai_chat_sessions
AS RESTRICTIVE
FOR ALL
TO authenticated
USING (
    public.current_user_is_super_admin()
    OR tenant_id = public.current_tenant_id()
)
WITH CHECK (
    public.current_user_is_super_admin()
    OR tenant_id = public.current_tenant_id()
);

DROP POLICY IF EXISTS tenant_isolation_ai_chat_messages ON public.sys_ai_chat_messages;
CREATE POLICY tenant_isolation_ai_chat_messages
ON public.sys_ai_chat_messages
AS RESTRICTIVE
FOR ALL
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
-- 4. 刷新 schema 缓存
-- ============================================================================

NOTIFY pgrst, 'reload schema';


-- ============================================================================
-- 5. 自检
-- ============================================================================

-- 5.1 各租户的会话/消息分布
-- SELECT t.code,
--        (SELECT count(*) FROM sys_ai_chat_sessions s
--          WHERE s.tenant_id = t.id AND s.is_deleted = 'n') AS sessions,
--        (SELECT count(*) FROM sys_ai_chat_messages m
--          WHERE m.tenant_id = t.id) AS messages
-- FROM sys_tenants t ORDER BY t.code;

-- 5.2 策略是否已生效（应看到 FOR ALL + RESTRICTIVE）
-- SELECT tablename, policyname, cmd, permissive
-- FROM pg_policies
-- WHERE schemaname='public'
--   AND tablename IN ('sys_ai_chat_sessions','sys_ai_chat_messages');

-- 5.3 兜底
-- SELECT count(*) FROM sys_ai_chat_sessions WHERE tenant_id IS NULL;
-- SELECT count(*) FROM sys_ai_chat_messages WHERE tenant_id IS NULL;

-- 5.4 回滚
-- DROP POLICY IF EXISTS tenant_isolation_ai_chat_sessions ON public.sys_ai_chat_sessions;
-- DROP POLICY IF EXISTS tenant_isolation_ai_chat_messages ON public.sys_ai_chat_messages;
-- ALTER TABLE public.sys_ai_chat_sessions DROP COLUMN IF EXISTS tenant_id;
-- ALTER TABLE public.sys_ai_chat_messages DROP COLUMN IF EXISTS tenant_id;
-- NOTIFY pgrst, 'reload schema';


-- ============================================================================
-- 已知边界
-- ============================================================================
-- 1. 消息的租户靠 DEFAULT 写入，与所属会话没有数据库级强制约束。
--    若前端拿到别的租户的 session_id 并写入消息，会产生跨租户孤儿数据。
--    现实风险低（fetchChatSessions 已被 RLS 收窄，拿不到别人的 session_id），
--    要彻底收紧可以加 BEFORE INSERT trigger 从 session 继承 tenant_id。
--
-- 2. deploy_43（JWT hook）未启用前，每次建会话/存消息都会因 DEFAULT
--    多查一次 sys_users。启用后走 app_metadata 即归零。
--
-- 3. sys_ai_chat_memory 的隔离在 deploy_42 完成，与本脚本是同一套打法。
-- ============================================================================
