-- ============================================================================
-- P1-3：生产退料单（表 + 单据类型 + 交易类型映射 + 菜单）
-- ============================================================================
--
-- 差距清单 A3：字典里有 `material_return_in`（deploy_40:123），但**无表、无 RPC** ——
-- 车间余料无法回库，领料成本虚高。
--
-- 结构对齐 `erp_material_issues` / `erp_material_issue_details`（deploy_56），
-- 这样 deploy_92 里两边的过账分支可以用同一套代码，只是方向相反。
-- 过账逻辑在 deploy_92（post_production_document 的 material_return 分支）：
--   方向 in（余料回库），借 原材料 / 贷 生产成本 —— 正好回冲领料成本。
--
-- 本脚本由 000_run_all 用 psql --single-transaction 执行，**不要写 BEGIN/COMMIT**。
-- 依赖：deploy_88（库存状态维度）、deploy_56（领料单表）。
-- ============================================================================

-- ============================================================================
-- 1. 主表
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.erp_material_returns_s_539dcf81_b (
  id SERIAL PRIMARY KEY,
  corp_id VARCHAR(128),
  emp_id VARCHAR(128),
  is_deleted CHAR(1) NOT NULL DEFAULT 'n',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  return_no VARCHAR(50) NOT NULL,
  return_date DATE NOT NULL,
  production_order_id INTEGER,
  issue_id INTEGER REFERENCES public.erp_material_issues_s_539dcf81_b(id),
  warehouse_id INTEGER,
  location_id INTEGER,
  total_amount NUMERIC NOT NULL DEFAULT 0,
  reason TEXT,
  remark TEXT,
  status VARCHAR(30) NOT NULL DEFAULT 'draft',
  approved_at TIMESTAMP,
  approved_by INTEGER,
  posting_idempotency_key UUID,
  reversal_idempotency_key UUID,
  posted_at TIMESTAMPTZ,
  reversed_at TIMESTAMPTZ,
  tenant_id BIGINT NOT NULL DEFAULT current_tenant_id()
);

CREATE INDEX IF NOT EXISTS idx_erp_material_returns_tenant
  ON public.erp_material_returns_s_539dcf81_b (tenant_id);
CREATE INDEX IF NOT EXISTS idx_erp_material_returns_date
  ON public.erp_material_returns_s_539dcf81_b (tenant_id, return_date DESC)
  WHERE is_deleted = 'n';
CREATE INDEX IF NOT EXISTS idx_erp_material_returns_order
  ON public.erp_material_returns_s_539dcf81_b (production_order_id)
  WHERE is_deleted = 'n';
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_material_returns_no
  ON public.erp_material_returns_s_539dcf81_b (tenant_id, return_no)
  WHERE is_deleted = 'n';
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_material_returns_posting_key
  ON public.erp_material_returns_s_539dcf81_b (posting_idempotency_key)
  WHERE posting_idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_material_returns_reversal_key
  ON public.erp_material_returns_s_539dcf81_b (reversal_idempotency_key)
  WHERE reversal_idempotency_key IS NOT NULL;

-- ============================================================================
-- 2. 明细表（字段与 erp_material_issue_details 对齐 + 回指领料明细）
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.erp_material_return_details_s_539dcf81_b (
  id SERIAL PRIMARY KEY,
  corp_id VARCHAR(128),
  emp_id VARCHAR(128),
  is_deleted CHAR(1) NOT NULL DEFAULT 'n',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  return_id INTEGER NOT NULL REFERENCES public.erp_material_returns_s_539dcf81_b(id),
  line_no INTEGER NOT NULL,
  material_id INTEGER NOT NULL,
  quantity NUMERIC NOT NULL DEFAULT 0,
  unit_cost NUMERIC NOT NULL DEFAULT 0,
  amount NUMERIC NOT NULL DEFAULT 0,
  batch_no VARCHAR(100),
  location_id INTEGER,
  issue_detail_id INTEGER REFERENCES public.erp_material_issue_details_s_539dcf81_b(id),
  remark TEXT,
  tenant_id BIGINT NOT NULL DEFAULT current_tenant_id()
);

CREATE INDEX IF NOT EXISTS idx_erp_material_return_details_return
  ON public.erp_material_return_details_s_539dcf81_b (return_id)
  WHERE is_deleted = 'n';
CREATE INDEX IF NOT EXISTS idx_erp_material_return_details_material
  ON public.erp_material_return_details_s_539dcf81_b (material_id)
  WHERE is_deleted = 'n';

-- ============================================================================
-- 3. 权限与 RLS
-- ============================================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON public.erp_material_returns_s_539dcf81_b TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.erp_material_returns_s_539dcf81_b_id_seq TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.erp_material_return_details_s_539dcf81_b TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.erp_material_return_details_s_539dcf81_b_id_seq TO authenticated;

SELECT public.install_role_table_rls('erp_material_returns_s_539dcf81_b');
SELECT public.install_role_table_rls('erp_material_return_details_s_539dcf81_b');
SELECT public.refresh_sys_tables();

-- ============================================================================
-- 4. 单据类型与业务类型映射
-- ============================================================================
INSERT INTO public.sys_document_types (
  document_type, document_name, primary_key_field, module_code, route_path,
  table_name, naming_rule, is_submittable, status, sort_order, is_deleted
)
VALUES (
  'material_return', '生产退料', 'id', 'mrp', '/mrp/material-returns',
  'erp_material_returns_s_539dcf81_b', 'MRN{YYYY}{####}', TRUE, '1', 68, 'n'
)
ON CONFLICT (document_type) DO UPDATE SET
  document_name = EXCLUDED.document_name,
  module_code   = EXCLUDED.module_code,
  route_path    = EXCLUDED.route_path,
  table_name    = EXCLUDED.table_name,
  naming_rule   = EXCLUDED.naming_rule,
  is_deleted    = 'n',
  updated_at    = NOW();

INSERT INTO public.sys_document_transaction_types
  (document_type_id, transaction_type_code, direction, is_default, condition_note, sort_order)
SELECT d.id, x.code, x.direction, x.is_default, x.note, x.sort_order
FROM public.sys_document_types d
JOIN (VALUES
  ('material_return_in', 'in', TRUE, '生产退料入库', 10)
) AS x(code, direction, is_default, note, sort_order) ON TRUE
WHERE d.document_type = 'material_return' AND d.is_deleted = 'n'
ON CONFLICT (document_type_id, transaction_type_code) DO UPDATE SET
  direction = EXCLUDED.direction, is_default = EXCLUDED.is_default,
  condition_note = EXCLUDED.condition_note, sort_order = EXCLUDED.sort_order,
  is_deleted = 'n', updated_at = NOW();

-- ============================================================================
-- 5. 菜单（三步法）
-- ============================================================================
INSERT INTO public.sys_menus (
  corp_id, emp_id, parent_id, menu_name, menu_code, menu_type, icon,
  path, component, sort_order, status, is_deleted, tenant_id
)
SELECT
  NULL, NULL,
  COALESCE((
    SELECT p.id FROM public.sys_menus p
    WHERE p.tenant_id IS NULL AND p.menu_code = 'mrp'
      AND COALESCE(p.is_deleted, 'n') = 'n'
    LIMIT 1
  ), 0),
  '生产退料', 'mrp_material-returns', 'C', 'RollbackOutlined',
  '/mrp/material-returns', './pages/mrp/MaterialReturns', 14, '1', 'n', NULL
WHERE NOT EXISTS (
  SELECT 1 FROM public.sys_menus m
  WHERE m.tenant_id IS NULL AND m.menu_code = 'mrp_material-returns'
);

INSERT INTO public.sys_role_menus (role_id, menu_id, is_deleted, tenant_id)
SELECT r.id, m.id, 'n', NULL
FROM public.sys_roles r
CROSS JOIN public.sys_menus m
WHERE r.tenant_id IS NULL
  AND COALESCE(r.is_deleted, 'n') = 'n'
  AND r.role_code IN ('super_admin', 'tenant_admin', 'mrp_manager', 'inventory_manager')
  AND m.tenant_id IS NULL
  AND m.menu_code = 'mrp_material-returns'
  AND COALESCE(m.is_deleted, 'n') = 'n'
  AND NOT EXISTS (
    SELECT 1 FROM public.sys_role_menus dup
    WHERE dup.role_id = r.id AND dup.menu_id = m.id
  );

DO $$
DECLARE
  v_tenant RECORD;
  v_result JSONB;
  v_count  INTEGER := 0;
BEGIN
  FOR v_tenant IN
    SELECT t.id, t.code FROM public.sys_tenants t
    WHERE COALESCE(t.is_deleted, 'n') = 'n' AND COALESCE(t.metadata_materialized, FALSE)
    ORDER BY t.id
  LOOP
    v_result := public.clone_platform_baseline_to_tenant(v_tenant.id, FALSE, TRUE);
    RAISE NOTICE '租户 % (%) 元数据补差：%', v_tenant.id, v_tenant.code, v_result;
    v_count := v_count + 1;
  END LOOP;
  RAISE NOTICE '已给 % 个已物化租户补差', v_count;
END;
$$;

-- ============================================================================
-- 6. 自检
-- ============================================================================
DO $$
DECLARE
  v_missing TEXT := '';
  v_n INTEGER;
  v_tenant RECORD;
BEGIN
  IF to_regclass('public.erp_material_returns_s_539dcf81_b') IS NULL THEN
    v_missing := v_missing || 'erp_material_returns 表未建立;';
  END IF;
  IF to_regclass('public.erp_material_return_details_s_539dcf81_b') IS NULL THEN
    v_missing := v_missing || 'erp_material_return_details 表未建立;';
  END IF;

  SELECT count(*) INTO v_n FROM public.sys_document_types
   WHERE document_type = 'material_return' AND is_deleted = 'n';
  IF v_n <> 1 THEN v_missing := v_missing || 'DocType material_return 缺失;'; END IF;

  SELECT count(*) INTO v_n
    FROM public.sys_document_transaction_types m
    JOIN public.sys_document_types d ON d.id = m.document_type_id
   WHERE d.document_type = 'material_return'
     AND m.transaction_type_code = 'material_return_in'
     AND m.direction = 'in' AND m.is_default AND m.is_deleted = 'n';
  IF v_n <> 1 THEN v_missing := v_missing || 'material_return 的业务类型映射缺失;'; END IF;

  SELECT count(*) INTO v_n FROM public.sys_menus
   WHERE tenant_id IS NULL AND menu_code = 'mrp_material-returns'
     AND COALESCE(is_deleted, 'n') = 'n';
  IF v_n <> 1 THEN v_missing := v_missing || '生产退料基线菜单缺失;'; END IF;

  SELECT count(*) INTO v_n
    FROM public.sys_role_menus rm
    JOIN public.sys_roles r ON r.id = rm.role_id
    JOIN public.sys_menus m ON m.id = rm.menu_id
   WHERE r.tenant_id IS NULL AND rm.tenant_id IS NULL
     AND m.menu_code = 'mrp_material-returns'
     AND COALESCE(rm.is_deleted, 'n') = 'n'
     AND r.role_code IN ('super_admin', 'tenant_admin', 'mrp_manager', 'inventory_manager');
  IF v_n < 4 THEN v_missing := v_missing || format('菜单基线授权不足（% < 4）;', v_n); END IF;

  FOR v_tenant IN
    SELECT t.id FROM public.sys_tenants t
    WHERE COALESCE(t.is_deleted, 'n') = 'n' AND COALESCE(t.metadata_materialized, FALSE)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.sys_menus m
      WHERE m.tenant_id = v_tenant.id AND m.menu_code = 'mrp_material-returns'
        AND COALESCE(m.is_deleted, 'n') = 'n'
    ) THEN
      v_missing := v_missing || format('租户%s缺生产退料菜单副本;', v_tenant.id);
    END IF;
  END LOOP;

  SELECT count(*) INTO v_n FROM pg_policies
   WHERE tablename IN ('erp_material_returns_s_539dcf81_b', 'erp_material_return_details_s_539dcf81_b');
  IF v_n < 8 THEN
    v_missing := v_missing || format('生产退料表 RLS 策略偏少（% < 8）;', v_n);
  END IF;

  IF v_missing <> '' THEN
    RAISE EXCEPTION 'deploy_91 自检失败：%', v_missing;
  END IF;

  RAISE NOTICE 'deploy_91 OK：生产退料单表 / DocType / 映射 / 菜单 / RLS 齐备';
END;
$$;
