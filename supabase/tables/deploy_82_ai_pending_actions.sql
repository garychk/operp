-- ============================================================================
-- deploy_82_ai_pending_actions.sql — AI 写库确认回路 + 操作审计
--
-- 背景：AI 创建/修改实体此前是「推断完直接 insert/update」，LLM 幻觉字段
-- 直接落库且不留痕。本脚本提供两段式写入的存储侧：
--
--   1. sys_ai_pending_actions —— AI 产出的「待确认草稿」：
--      prepare 阶段（ai-server erpTools）把最终 payload 存进来，不写业务表；
--      用户在对话里回复「确认」（或 POST /api/ai/confirm）后才执行。
--      状态机：pending → executed | cancelled | expired（30 分钟 TTL）。
--
--   2. sys_ai_operation_logs —— AI 操作审计：
--      草稿创建、确认执行、BAQ 保存、分析 SQL 执行都记一条
--      （谁 / 哪个租户 / 哪个会话 / 对哪张表 / 请求与结果）。
--
-- 两张表都是服务表：写入走 ai-server 的 service_role（BYPASSRLS，应用层
-- 显式带 tenant_id/user_id）；前端直连场景下 RLS 收敛到本人/本租户。
-- 不走 sys_role_table_permissions 基线授权（同 sys_mcp_api_keys 的例外策略）。
-- ============================================================================

-- ============================================================================
-- 1. sys_ai_pending_actions
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.sys_ai_pending_actions (
    id BIGSERIAL PRIMARY KEY,
    session_id VARCHAR(64) NOT NULL,
    user_id BIGINT NOT NULL,
    tenant_id BIGINT,
    action_type VARCHAR(32) NOT NULL,          -- entity.create | entity.update
    entity_key VARCHAR(64) NOT NULL,           -- 实体 key（entityRegistry）
    table_name VARCHAR(128) NOT NULL,          -- 目标物理表
    payload JSONB NOT NULL,                    -- 最终写入 payload（已过 insertable 过滤）
    existing_id BIGINT,                        -- update 时的目标行 id
    context JSONB,                             -- 展示/执行上下文（label、route、tenantScoped 等）
    status VARCHAR(16) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'executed', 'cancelled', 'expired')),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '30 minutes',
    executed_at TIMESTAMPTZ,
    executed_row_id BIGINT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

COMMENT ON TABLE public.sys_ai_pending_actions IS
  'AI 写库确认回路的待确认草稿：prepare 存草稿不落业务表，确认后才执行（30 分钟 TTL）';

CREATE INDEX IF NOT EXISTS idx_sys_ai_pending_actions_session
    ON public.sys_ai_pending_actions (session_id)
    WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_sys_ai_pending_actions_user
    ON public.sys_ai_pending_actions (user_id, status);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_sys_ai_pending_actions_tenant'
          AND conrelid = 'public.sys_ai_pending_actions'::regclass
    ) THEN
        ALTER TABLE public.sys_ai_pending_actions
            ADD CONSTRAINT fk_sys_ai_pending_actions_tenant
            FOREIGN KEY (tenant_id) REFERENCES public.sys_tenants (id);
    END IF;
END $$;

ALTER TABLE public.sys_ai_pending_actions ENABLE ROW LEVEL SECURITY;

-- 租户收敛（RESTRICTIVE）：与 deploy_67 同构
DROP POLICY IF EXISTS tenant_scope_sys_ai_pending_actions ON public.sys_ai_pending_actions;
CREATE POLICY tenant_scope_sys_ai_pending_actions
ON public.sys_ai_pending_actions
AS RESTRICTIVE
FOR ALL
TO authenticated
USING (tenant_id = public.current_tenant_id())
WITH CHECK (tenant_id = public.current_tenant_id());

-- 本人可见（PERMISSIVE）：前端「待确认」提示只读自己的草稿
DROP POLICY IF EXISTS owner_read_sys_ai_pending_actions ON public.sys_ai_pending_actions;
CREATE POLICY owner_read_sys_ai_pending_actions
ON public.sys_ai_pending_actions
AS PERMISSIVE
FOR SELECT
TO authenticated
USING (user_id = public.current_sys_user_id());

-- ============================================================================
-- 2. sys_ai_operation_logs
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.sys_ai_operation_logs (
    id BIGSERIAL PRIMARY KEY,
    created_at TIMESTAMPTZ DEFAULT now(),
    tenant_id BIGINT,
    user_id BIGINT,
    session_id VARCHAR(64),
    operation VARCHAR(64) NOT NULL,   -- ai.entity.draft_create / ai.entity.execute_create / ai.baq.upsert / ai.analysis.sql ...
    target_table VARCHAR(128),
    target_id BIGINT,
    request JSONB,
    result JSONB,
    status VARCHAR(16) DEFAULT 'success'
);

COMMENT ON TABLE public.sys_ai_operation_logs IS
  'AI 操作审计：AI 发起的草稿/写入/BAQ/分析 SQL 全部留痕（who/tenant/session/table/request/result）';

CREATE INDEX IF NOT EXISTS idx_sys_ai_operation_logs_tenant_time
    ON public.sys_ai_operation_logs (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sys_ai_operation_logs_user
    ON public.sys_ai_operation_logs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sys_ai_operation_logs_operation
    ON public.sys_ai_operation_logs (operation);

ALTER TABLE public.sys_ai_operation_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_scope_sys_ai_operation_logs ON public.sys_ai_operation_logs;
CREATE POLICY tenant_scope_sys_ai_operation_logs
ON public.sys_ai_operation_logs
AS RESTRICTIVE
FOR ALL
TO authenticated
USING (tenant_id = public.current_tenant_id())
WITH CHECK (tenant_id = public.current_tenant_id());

DROP POLICY IF EXISTS owner_read_sys_ai_operation_logs ON public.sys_ai_operation_logs;
CREATE POLICY owner_read_sys_ai_operation_logs
ON public.sys_ai_operation_logs
AS PERMISSIVE
FOR SELECT
TO authenticated
USING (user_id = public.current_sys_user_id());

-- ============================================================================
-- 3. 自检
-- ============================================================================

DO $$
DECLARE
  tbl_count INT;
  pol_count INT;
BEGIN
  RAISE NOTICE '--- deploy_82 自检 ---';

  SELECT count(*) INTO tbl_count
  FROM information_schema.tables
  WHERE table_schema = 'public'
    AND table_name IN ('sys_ai_pending_actions', 'sys_ai_operation_logs');
  IF tbl_count <> 2 THEN
    RAISE EXCEPTION '自检失败：两张表未全部创建';
  END IF;

  SELECT count(*) INTO pol_count
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename IN ('sys_ai_pending_actions', 'sys_ai_operation_logs');
  IF pol_count < 4 THEN
    RAISE EXCEPTION '自检失败：RLS 策略缺失（当前 % 条，应至少 4 条）', pol_count;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'idx_sys_ai_pending_actions_session'
  ) THEN
    RAISE EXCEPTION '自检失败：pending_actions 会话索引缺失';
  END IF;

  RAISE NOTICE '两张表 + RLS 策略（%）+ 索引: OK', pol_count;
END $$;
