-- ============================================================================
-- 阶段 5 · 主生产计划 MPS（deploy_63）
--
-- 交付：
--   1) erp_mps_plans_s_539dcf81_b        主生产计划头（draft | confirmed）
--   2) erp_mps_plan_details_s_539dcf81_b 计划行（产品 × 日期：forecast_qty / mps_qty）
--   3) 确认锁触发器：计划 confirmed 后行不可改/删（取消确认解锁）
--   4) DocType mps_plan（取号 MPS{YYYY}{####}，页面 /mrp/mps）
--   5) doc_flow_source_meta 元数据行 —— 复用单据下推台账：
--      · 下推生产订单时由 ai-server 调 doc_flow_ledger_convert 记 doc_flow_transfers
--        （自动校验「累计下推 ≤ mps_qty」，防重复下推）
--      · doc_flow_sync_source_progress 自动回写 pushed_quantity
--      ⚠️ 刻意**不**建 doc_flow_rules 规则行、**不**在 erp_production_order_details
--        上挂台账触发器：doc_flow_generate 是「单头 → 单头」转换，而 MPS 是
--        「一行一个产品 → 一张 MO」，生产订单表头只有一个 product_id，行级转换
--        与通用引擎形状不匹配。复用的是台账与进度回写，不是 generate 入口。
--
-- 设计取舍（v1，刻意如此）：
--   · 日桶（requirement_date）与 MRP 引擎的日期粒度一致，不建周/月桶。
--   · forecast_qty（预测/独立需求）本期只做展示与计划参考，**不**接入 MRP 需求源
--     （MRP 仍是订单驱动）；MRP 侧接入的是「确认后未下推的 mps_qty」= 计划供给。
--   · 确认 = 整单锁定（无 DTF/PTF 分级时界），frozen_days 字段先落库、v2 再启用。
--   · RCCP 粗能力校验不落表（纯计算接口），产能口径：单件工时 = 默认工艺路线的
--     Σ(标准工时+准备工时)，回退 total_standard_hours；月产能 = capacity_per_day × 自然日数。
--
-- 注：脚本由 000_run_all 用 psql --single-transaction 执行，**不要写 BEGIN/COMMIT**。
-- 依赖：deploy_01（erp_products）、deploy_32/47（取号）、deploy_36（doc_flow_source_meta）、
--       deploy_41（install_role_table_rls / refresh_sys_tables）、deploy_52（clone 函数）。
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) 主表
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.erp_mps_plans_s_539dcf81_b (
  id SERIAL PRIMARY KEY,
  corp_id VARCHAR(128),
  emp_id VARCHAR(128),
  is_deleted CHAR(1) NOT NULL DEFAULT 'n',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  plan_no VARCHAR(50) NOT NULL,
  plan_date DATE NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  -- 计划展望期内的冻结天数（v1 仅落库展示；确认后整单锁定，v2 再启用分级时界）
  frozen_days INTEGER NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'draft',
  remark TEXT,
  tenant_id BIGINT NOT NULL DEFAULT current_tenant_id()
);

COMMENT ON TABLE public.erp_mps_plans_s_539dcf81_b IS
  '主生产计划 MPS：计划员按产品 × 日期维护计划产出量（mps_qty），确认后可下推生产订单';
COMMENT ON COLUMN public.erp_mps_plans_s_539dcf81_b.status IS 'draft | confirmed';

-- deploy_51 惯例：业务唯一键租户内唯一；软删后允许复用编号 → 部分唯一索引
CREATE UNIQUE INDEX IF NOT EXISTS uq_mps_plans_tenant_no
  ON public.erp_mps_plans_s_539dcf81_b (tenant_id, plan_no)
  WHERE is_deleted = 'n';

CREATE INDEX IF NOT EXISTS idx_mps_plans_tenant_date
  ON public.erp_mps_plans_s_539dcf81_b (tenant_id, plan_date)
  WHERE is_deleted = 'n';

-- ----------------------------------------------------------------------------
-- 2) 明细表
--    ⚠️ 表名必须能被 doc_flow_detail_table('mps_plan') 推导出：
--    erp_mps_plans（去尾 s）+ _details = erp_mps_plan_details_s_539dcf81_b。
--    改名会直接弄断下推台账与进度回写。
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.erp_mps_plan_details_s_539dcf81_b (
  id SERIAL PRIMARY KEY,
  corp_id VARCHAR(128),
  emp_id VARCHAR(128),
  is_deleted CHAR(1) NOT NULL DEFAULT 'n',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  plan_id INTEGER NOT NULL REFERENCES public.erp_mps_plans_s_539dcf81_b(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES public.erp_products_s_539dcf81_b(id),
  requirement_date DATE NOT NULL,
  forecast_qty DECIMAL(18, 4) NOT NULL DEFAULT 0,
  mps_qty DECIMAL(18, 4) NOT NULL DEFAULT 0,
  -- 下推进度：由 doc_flow_sync_source_progress 维护（doc_flow_source_meta.progress_field）
  pushed_quantity DECIMAL(18, 4) NOT NULL DEFAULT 0,
  remark TEXT,
  tenant_id BIGINT NOT NULL DEFAULT current_tenant_id()
);

COMMENT ON COLUMN public.erp_mps_plan_details_s_539dcf81_b.forecast_qty IS
  '预测/独立需求（本期仅展示，不接入 MRP 需求源；与销售订单去重由计划员负责）';
COMMENT ON COLUMN public.erp_mps_plan_details_s_539dcf81_b.mps_qty IS
  '主生产计划量（计划产出）。确认后 = MRP 的计划供给源 + 下推生产订单的来源';
COMMENT ON COLUMN public.erp_mps_plan_details_s_539dcf81_b.pushed_quantity IS
  '已下推生产订单数量（doc_flow_transfers 台账回写），剩余可下推 = mps_qty - pushed_quantity';

-- 同一计划内同一产品同一天只有一行（软删行除外）
CREATE UNIQUE INDEX IF NOT EXISTS uq_mps_plan_details_line
  ON public.erp_mps_plan_details_s_539dcf81_b (tenant_id, plan_id, product_id, requirement_date)
  WHERE is_deleted = 'n';

CREATE INDEX IF NOT EXISTS idx_mps_plan_details_plan
  ON public.erp_mps_plan_details_s_539dcf81_b (tenant_id, plan_id)
  WHERE is_deleted = 'n';

CREATE INDEX IF NOT EXISTS idx_mps_plan_details_product_date
  ON public.erp_mps_plan_details_s_539dcf81_b (tenant_id, product_id, requirement_date)
  WHERE is_deleted = 'n';

-- ----------------------------------------------------------------------------
-- 3) 确认锁触发器：计划 confirmed 后，行不可改/删（含软删），取消确认解锁。
--    ⚠️ 只锁业务字段（UPDATE OF），pushed_quantity 的台账回写不走本触发器。
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mps_plan_detail_lock()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status TEXT;
BEGIN
  SELECT status INTO v_status
  FROM public.erp_mps_plans_s_539dcf81_b
  WHERE id = COALESCE(NEW.plan_id, OLD.plan_id);

  IF v_status = 'confirmed' THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION '主生产计划已确认，计划行不可删除（请先取消确认）'
        USING ERRCODE = '23514';
    END IF;
    RAISE EXCEPTION '主生产计划已确认，计划行已锁定（请先取消确认再修改）'
      USING ERRCODE = '23514';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_mps_plan_detail_lock ON public.erp_mps_plan_details_s_539dcf81_b;
CREATE TRIGGER trg_mps_plan_detail_lock
BEFORE DELETE OR UPDATE OF plan_id, product_id, requirement_date,
  forecast_qty, mps_qty, remark, is_deleted
ON public.erp_mps_plan_details_s_539dcf81_b
FOR EACH ROW EXECUTE FUNCTION public.mps_plan_detail_lock();

-- ----------------------------------------------------------------------------
-- 4) RLS + 授权 + sys_tables 登记 + 基线角色表权限
-- ----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON public.erp_mps_plans_s_539dcf81_b TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.erp_mps_plan_details_s_539dcf81_b TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.erp_mps_plans_s_539dcf81_b_id_seq TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.erp_mps_plan_details_s_539dcf81_b_id_seq TO authenticated;

SELECT public.install_role_table_rls('erp_mps_plans_s_539dcf81_b');
SELECT public.install_role_table_rls('erp_mps_plan_details_s_539dcf81_b');

-- 目录登记（has_table_permission 走 sys_tables，漏登记 = 表级权限永远不命中）
SELECT public.refresh_sys_tables();

-- 基线角色授权（tenant_id IS NULL，三个角色全权；租户副本由下方 clone 补差）
INSERT INTO public.sys_role_table_permissions
  (role_id, table_id, can_select, can_insert, can_update, can_delete, is_deleted, tenant_id)
SELECT r.id, t.id, TRUE, TRUE, TRUE, TRUE, 'n', NULL
FROM public.sys_roles r
CROSS JOIN public.sys_tables t
WHERE r.tenant_id IS NULL
  AND COALESCE(r.is_deleted, 'n') = 'n'
  AND r.role_code IN ('super_admin', 'tenant_admin', 'mrp_manager')
  AND t.table_name IN ('erp_mps_plans_s_539dcf81_b', 'erp_mps_plan_details_s_539dcf81_b')
  AND COALESCE(t.is_deleted, 'n') = 'n'
  AND NOT EXISTS (
    SELECT 1 FROM public.sys_role_table_permissions rp
    WHERE rp.role_id = r.id AND rp.table_id = t.id
      AND rp.tenant_id IS NULL AND COALESCE(rp.is_deleted, 'n') = 'n'
  );

-- 给已物化租户补差（表权限副本）
DO $$
DECLARE
  v_tenant RECORD;
  v_result JSONB;
  v_count INTEGER := 0;
BEGIN
  FOR v_tenant IN
    SELECT t.id, t.code
    FROM public.sys_tenants t
    WHERE COALESCE(t.is_deleted, 'n') = 'n'
      AND COALESCE(t.metadata_materialized, FALSE)
    ORDER BY t.id
  LOOP
    v_result := public.clone_platform_baseline_to_tenant(v_tenant.id, FALSE, TRUE);
    RAISE NOTICE '租户 % (%) 表权限补差：%', v_tenant.id, v_tenant.code, v_result;
    v_count := v_count + 1;
  END LOOP;
  RAISE NOTICE '已给 % 个已物化租户补表权限副本', v_count;
END;
$$;

-- ----------------------------------------------------------------------------
-- 5) DocType mps_plan（MPS 页取号 + route_path）
-- ----------------------------------------------------------------------------
INSERT INTO public.sys_document_types
  (document_type, document_name, module_code, route_path, table_name, naming_rule, sort_order, status)
VALUES
  ('mps_plan', '主生产计划', 'mrp', '/mrp/mps',
   'erp_mps_plans_s_539dcf81_b', 'MPS{YYYY}{####}', 67, '1')
ON CONFLICT (document_type) DO UPDATE SET
  document_name = EXCLUDED.document_name,
  module_code   = EXCLUDED.module_code,
  route_path    = EXCLUDED.route_path,
  table_name    = EXCLUDED.table_name,
  naming_rule   = EXCLUDED.naming_rule,
  sort_order    = EXCLUDED.sort_order,
  updated_at    = NOW();

-- ----------------------------------------------------------------------------
-- 6) 下推台账元数据（复用 doc_flow 的防重复下推 + 进度回写，不建规则行）
--    sync_status = FALSE：MPS 状态由「确认/取消确认」人工控制，不按下推进度自动改。
-- ----------------------------------------------------------------------------
INSERT INTO public.doc_flow_source_meta (
  source_document_type, parent_field, quantity_field, progress_field,
  sync_status, none_status, partial_status, full_status, remark
) VALUES
  ('mps_plan', 'plan_id', 'mps_qty', 'pushed_quantity', FALSE,
   'confirmed', 'partially_pushed', 'fully_pushed',
   '主生产计划：下推生产订单按行记账，防超下推；状态由确认/取消确认人工控制')
ON CONFLICT (source_document_type) DO UPDATE SET
  parent_field    = EXCLUDED.parent_field,
  quantity_field  = EXCLUDED.quantity_field,
  progress_field  = EXCLUDED.progress_field,
  sync_status     = EXCLUDED.sync_status,
  none_status     = EXCLUDED.none_status,
  partial_status  = EXCLUDED.partial_status,
  full_status     = EXCLUDED.full_status,
  remark          = EXCLUDED.remark;

-- ----------------------------------------------------------------------------
-- 7) 自检：缺任何一项直接报错（不静默）
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_missing TEXT[] := ARRAY[]::TEXT[];
  v_tenant RECORD;
  v_perm_count INTEGER;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'erp_mps_plans_s_539dcf81_b'
  ) THEN
    v_missing := v_missing || 'table erp_mps_plans';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'erp_mps_plan_details_s_539dcf81_b'
  ) THEN
    v_missing := v_missing || 'table erp_mps_plan_details';
  END IF;

  IF public.doc_flow_detail_table('mps_plan')
      IS DISTINCT FROM 'erp_mps_plan_details_s_539dcf81_b' THEN
    v_missing := v_missing || format(
      'doc_flow_detail_table(mps_plan) = %s (期望 erp_mps_plan_details_s_539dcf81_b)',
      COALESCE(public.doc_flow_detail_table('mps_plan'), 'NULL'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.erp_mps_plan_details_s_539dcf81_b'::regclass
      AND tgname = 'trg_mps_plan_detail_lock' AND NOT tgisinternal
  ) THEN
    v_missing := v_missing || 'trigger trg_mps_plan_detail_lock';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.sys_document_types
    WHERE document_type = 'mps_plan' AND naming_rule = 'MPS{YYYY}{####}'
  ) THEN
    v_missing := v_missing || 'sys_document_types.mps_plan';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.doc_flow_source_meta
    WHERE source_document_type = 'mps_plan'
      AND quantity_field = 'mps_qty' AND progress_field = 'pushed_quantity'
  ) THEN
    v_missing := v_missing || 'doc_flow_source_meta.mps_plan';
  END IF;

  -- 基线表权限：3 角色 × 2 表 = 6
  SELECT count(*) INTO v_perm_count
  FROM public.sys_role_table_permissions rp
  JOIN public.sys_roles r ON r.id = rp.role_id
  JOIN public.sys_tables t ON t.id = rp.table_id
  WHERE rp.tenant_id IS NULL AND COALESCE(rp.is_deleted, 'n') = 'n'
    AND r.tenant_id IS NULL
    AND r.role_code IN ('super_admin', 'tenant_admin', 'mrp_manager')
    AND t.table_name IN ('erp_mps_plans_s_539dcf81_b', 'erp_mps_plan_details_s_539dcf81_b');
  IF v_perm_count < 6 THEN
    v_missing := v_missing || format('基线表权限只有 %s/6 行', v_perm_count);
  END IF;

  -- 已物化租户的 tenant_admin 必须能看到两张新表（漏 clone 是静默的）
  FOR v_tenant IN
    SELECT t.id FROM public.sys_tenants t
    WHERE COALESCE(t.is_deleted, 'n') = 'n'
      AND COALESCE(t.metadata_materialized, FALSE)
  LOOP
    SELECT count(*) INTO v_perm_count
    FROM public.sys_role_table_permissions rp
    JOIN public.sys_roles r ON r.id = rp.role_id
    JOIN public.sys_tables t ON t.id = rp.table_id
    WHERE rp.tenant_id = v_tenant.id
      AND COALESCE(rp.is_deleted, 'n') = 'n'
      AND r.tenant_id = v_tenant.id AND r.role_code = 'tenant_admin'
      AND t.table_name IN ('erp_mps_plans_s_539dcf81_b', 'erp_mps_plan_details_s_539dcf81_b');
    IF v_perm_count < 2 THEN
      v_missing := v_missing || format('租户%s的tenant_admin缺新表权限副本', v_tenant.id);
    END IF;
  END LOOP;

  IF array_length(v_missing, 1) > 0 THEN
    RAISE EXCEPTION 'deploy_63 自检失败，缺少: %', array_to_string(v_missing, ', ');
  END IF;

  RAISE NOTICE 'deploy_63 OK: MPS 主表/明细表 + 确认锁 + DocType + 下推台账元数据已就绪';
END $$;
