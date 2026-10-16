-- ============================================================================
-- deploy_125_ai_token_usage.sql — AI Token 消耗明细
--
-- 背景：AI 对话此前不统计模型 Token 消耗，用户/租户管理员/超管都看不到
--       谁、在哪个会话、消耗了多少 Token。本脚本新增一张明细表
--       sys_ai_token_usage，由 ai-server 在每次 LLM 调用（对话 / 路由 /
--       字段提取 / embedding / 分析）返回 usage 时旁路写入。
--
-- 记录粒度：一次模型调用一条（同一次对话里意图路由、工具执行、收尾回复
--           分别各记一条，operation 字段区分调用来源）。
--
-- 三级可见性（与 sys_ai_operation_logs 同构，靠 RLS + 前端过滤）：
--   · 普通用户  → 只能看到自己（user_id = 本人）的消耗
--   · 租户管理员 → 看到本租户所有用户的消耗
--   · 超级管理员 → 看到全部租户全部用户的消耗
--
-- 表是服务表：写入走 ai-server 的 service_role（BYPASSRLS，应用层显式带
-- tenant_id/user_id/session_id）；前端直连只读，RLS 收敛到本人/本租户。
--
-- 注：本脚本由 000_run_all 用 psql --single-transaction 执行，不要写 BEGIN/COMMIT。
-- ============================================================================

-- 1. 明细表
CREATE TABLE IF NOT EXISTS public.sys_ai_token_usage (
    id BIGSERIAL PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    tenant_id BIGINT,
    user_id BIGINT,
    session_id VARCHAR(64),
    -- 调用来源：chat / intent_route / field_extract / baq_design /
    --           document_* / embedding_query / embedding_index / analysis ...
    operation VARCHAR(64) NOT NULL DEFAULT 'chat',
    -- 模型名（provider.model），便于按模型维度统计成本
    model VARCHAR(128),
    prompt_tokens BIGINT NOT NULL DEFAULT 0,
    completion_tokens BIGINT NOT NULL DEFAULT 0,
    total_tokens BIGINT NOT NULL DEFAULT 0
);

COMMENT ON TABLE public.sys_ai_token_usage IS
  'AI Token 消耗明细：每次 LLM 调用的 prompt/completion/total token（who/tenant/session/operation/model）';

CREATE INDEX IF NOT EXISTS idx_sys_ai_token_usage_tenant_time
    ON public.sys_ai_token_usage (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sys_ai_token_usage_user_time
    ON public.sys_ai_token_usage (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sys_ai_token_usage_session
    ON public.sys_ai_token_usage (session_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_sys_ai_token_usage_operation
    ON public.sys_ai_token_usage (operation);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_sys_ai_token_usage_tenant'
          AND conrelid = 'public.sys_ai_token_usage'::regclass
    ) THEN
        ALTER TABLE public.sys_ai_token_usage
            ADD CONSTRAINT fk_sys_ai_token_usage_tenant
            FOREIGN KEY (tenant_id) REFERENCES public.sys_tenants (id);
    END IF;
END $$;

-- 2. RLS：租户收敛（RESTRICTIVE）+ 本人可见（PERMISSIVE）
ALTER TABLE public.sys_ai_token_usage ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_scope_sys_ai_token_usage ON public.sys_ai_token_usage;
CREATE POLICY tenant_scope_sys_ai_token_usage
ON public.sys_ai_token_usage
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

-- 本人可见：普通用户只读自己的消耗（PERMISSIVE 与 RESTRICTIVE 叠加 = 取交集）
DROP POLICY IF EXISTS owner_read_sys_ai_token_usage ON public.sys_ai_token_usage;
CREATE POLICY owner_read_sys_ai_token_usage
ON public.sys_ai_token_usage
AS PERMISSIVE
FOR SELECT
TO authenticated
USING (
    public.current_user_is_super_admin()
    OR user_id = public.current_sys_user_id()
);

-- 3. 刷新 schema 缓存
NOTIFY pgrst, 'reload schema';

-- 4. 自检
DO $$
DECLARE
  tbl_count INT;
  pol_count INT;
BEGIN
  RAISE NOTICE '--- deploy_125 自检 ---';

  SELECT count(*) INTO tbl_count
  FROM information_schema.tables
  WHERE table_schema = 'public'
    AND table_name = 'sys_ai_token_usage';
  IF tbl_count <> 1 THEN
    RAISE EXCEPTION '自检失败：sys_ai_token_usage 未创建';
  END IF;

  SELECT count(*) INTO pol_count
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename = 'sys_ai_token_usage';
  IF pol_count < 2 THEN
    RAISE EXCEPTION '自检失败：RLS 策略缺失（当前 % 条，应至少 2 条）', pol_count;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'idx_sys_ai_token_usage_tenant_time'
  ) THEN
    RAISE EXCEPTION '自检失败：租户时间索引缺失';
  END IF;

  RAISE NOTICE 'sys_ai_token_usage + RLS 策略（%）+ 索引: OK', pol_count;
END $$;
