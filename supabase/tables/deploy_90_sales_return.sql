-- ============================================================================
-- P1-2：销售退货过账（补列 + 单据类型 + 交易类型映射 + 菜单 + 权限）
-- ============================================================================
--
-- 差距清单 A2：`erp_sales_returns` / `erp_sales_return_details` 在 deploy_10 就建了表，
-- 但**没有任何过账 RPC**，只被 QualityInspections.tsx 当归档来源引用 ——
-- 退货商品在系统里「不存在」，库存虚高。
--
-- 本文件把两张表补成「可过账的单据」：补金额/币种/库位/过账幂等键等列，
-- 补分租户唯一键、单据类型、业务类型映射、菜单、RLS。
-- 过账逻辑在 deploy_92（post_stock_document 的 sales_return 分支）：
--   方向 in（加库存），同时生成一条**负数应收**冲减 erp_receivables.balance。
--
-- 本脚本由 000_run_all 用 psql --single-transaction 执行，**不要写 BEGIN/COMMIT**。
-- 依赖：deploy_88（库存状态维度）、deploy_10（销售退货表）。
-- ============================================================================

-- ============================================================================
-- 1. 主表补列
-- ============================================================================
ALTER TABLE public.erp_sales_returns_s_539dcf81_b
  ADD COLUMN IF NOT EXISTS total_amount NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS currency VARCHAR(10) NOT NULL DEFAULT 'CNY',
  ADD COLUMN IF NOT EXISTS exchange_rate NUMERIC NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS base_total_amount NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS location_id INTEGER,
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS approved_by INTEGER,
  ADD COLUMN IF NOT EXISTS posting_idempotency_key UUID,
  ADD COLUMN IF NOT EXISTS reversal_idempotency_key UUID,
  ADD COLUMN IF NOT EXISTS posted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ;

-- ============================================================================
-- 2. 明细表补列
-- ============================================================================
ALTER TABLE public.erp_sales_return_details_s_539dcf81_b
  ADD COLUMN IF NOT EXISTS unit_price NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS amount NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS base_unit_price NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS base_amount NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS location_id INTEGER,
  ADD COLUMN IF NOT EXISTS expiry_date DATE;

-- ============================================================================
-- 3. 索引与唯一键
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_erp_sales_returns_tenant
  ON public.erp_sales_returns_s_539dcf81_b (tenant_id);
CREATE INDEX IF NOT EXISTS idx_erp_sales_returns_date
  ON public.erp_sales_returns_s_539dcf81_b (tenant_id, return_date DESC)
  WHERE is_deleted = 'n';
CREATE INDEX IF NOT EXISTS idx_erp_sales_returns_delivery
  ON public.erp_sales_returns_s_539dcf81_b (delivery_id)
  WHERE is_deleted = 'n';
CREATE INDEX IF NOT EXISTS idx_erp_sales_return_details_return
  ON public.erp_sales_return_details_s_539dcf81_b (return_id)
  WHERE is_deleted = 'n';

-- 原表建在 deploy_10，当时 return_no 没有做分租户唯一约束（多租户下会串号）
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_sales_returns_no
  ON public.erp_sales_returns_s_539dcf81_b (tenant_id, return_no)
  WHERE is_deleted = 'n';
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_sales_returns_posting_key
  ON public.erp_sales_returns_s_539dcf81_b (posting_idempotency_key)
  WHERE posting_idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_sales_returns_reversal_key
  ON public.erp_sales_returns_s_539dcf81_b (reversal_idempotency_key)
  WHERE reversal_idempotency_key IS NOT NULL;

-- 应收：红字行同样要有「单据 ↔ 应收」唯一约束
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_receivables_active_sales_return
  ON public.erp_receivables_s_539dcf81_b (tenant_id, source_type, source_id)
  WHERE is_deleted = 'n' AND source_type = 'sales_return' AND source_id IS NOT NULL;

-- ============================================================================
-- 4. 权限与 RLS（原表可能只在 deploy_10 建了裸表，这里幂等重装）
-- ============================================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON public.erp_sales_returns_s_539dcf81_b TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.erp_sales_returns_s_539dcf81_b_id_seq TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.erp_sales_return_details_s_539dcf81_b TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.erp_sales_return_details_s_539dcf81_b_id_seq TO authenticated;

SELECT public.install_role_table_rls('erp_sales_returns_s_539dcf81_b');
SELECT public.install_role_table_rls('erp_sales_return_details_s_539dcf81_b');
SELECT public.refresh_sys_tables();

-- ============================================================================
-- 5. 单据类型与业务类型映射
-- ============================================================================
INSERT INTO public.sys_document_types (
  document_type, document_name, primary_key_field, module_code, route_path,
  table_name, naming_rule, is_submittable, status, sort_order, is_deleted
)
VALUES (
  'sales_return', '销售退货', 'id', 'inventory', '/inventory/sales-returns',
  'erp_sales_returns_s_539dcf81_b', 'SRN{YYYY}{####}', TRUE, '1', 40, 'n'
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
  ('sales_return_in', 'in', TRUE, '销售退货入库', 10)
) AS x(code, direction, is_default, note, sort_order) ON TRUE
WHERE d.document_type = 'sales_return' AND d.is_deleted = 'n'
ON CONFLICT (document_type_id, transaction_type_code) DO UPDATE SET
  direction = EXCLUDED.direction, is_default = EXCLUDED.is_default,
  condition_note = EXCLUDED.condition_note, sort_order = EXCLUDED.sort_order,
  is_deleted = 'n', updated_at = NOW();

-- ============================================================================
-- 6. 菜单（三步法）
-- ============================================================================
INSERT INTO public.sys_menus (
  corp_id, emp_id, parent_id, menu_name, menu_code, menu_type, icon,
  path, component, sort_order, status, is_deleted, tenant_id
)
SELECT
  NULL, NULL,
  COALESCE((
    SELECT p.id FROM public.sys_menus p
    WHERE p.tenant_id IS NULL AND p.menu_code = 'inventory'
      AND COALESCE(p.is_deleted, 'n') = 'n'
    LIMIT 1
  ), 0),
  '销售退货', 'inventory_sales-returns', 'C', 'RollbackOutlined',
  '/inventory/sales-returns', './pages/inventory/SalesReturns', 15, '1', 'n', NULL
WHERE NOT EXISTS (
  SELECT 1 FROM public.sys_menus m
  WHERE m.tenant_id IS NULL AND m.menu_code = 'inventory_sales-returns'
);

INSERT INTO public.sys_role_menus (role_id, menu_id, is_deleted, tenant_id)
SELECT r.id, m.id, 'n', NULL
FROM public.sys_roles r
CROSS JOIN public.sys_menus m
WHERE r.tenant_id IS NULL
  AND COALESCE(r.is_deleted, 'n') = 'n'
  AND r.role_code IN ('super_admin', 'tenant_admin', 'inventory_manager')
  AND m.tenant_id IS NULL
  AND m.menu_code = 'inventory_sales-returns'
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
-- 7. 自检
-- ============================================================================
DO $$
DECLARE
  v_missing TEXT := '';
  v_n INTEGER;
  v_tenant RECORD;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'erp_sales_returns_s_539dcf81_b' AND column_name = 'total_amount'
       AND is_nullable = 'NO'
  ) THEN
    v_missing := v_missing || 'erp_sales_returns.total_amount 缺失或可空;';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'erp_sales_return_details_s_539dcf81_b' AND column_name = 'amount'
  ) THEN
    v_missing := v_missing || 'erp_sales_return_details.amount 缺失;';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'erp_sales_returns_s_539dcf81_b' AND column_name = 'posting_idempotency_key'
  ) THEN
    v_missing := v_missing || 'erp_sales_returns 缺少过账幂等键;';
  END IF;

  SELECT count(*) INTO v_n FROM public.sys_document_types
   WHERE document_type = 'sales_return' AND is_deleted = 'n';
  IF v_n <> 1 THEN v_missing := v_missing || 'DocType sales_return 缺失;'; END IF;

  SELECT count(*) INTO v_n
    FROM public.sys_document_transaction_types m
    JOIN public.sys_document_types d ON d.id = m.document_type_id
   WHERE d.document_type = 'sales_return'
     AND m.transaction_type_code = 'sales_return_in'
     AND m.direction = 'in' AND m.is_default AND m.is_deleted = 'n';
  IF v_n <> 1 THEN v_missing := v_missing || 'sales_return 的业务类型映射缺失;'; END IF;

  SELECT count(*) INTO v_n FROM public.sys_menus
   WHERE tenant_id IS NULL AND menu_code = 'inventory_sales-returns'
     AND COALESCE(is_deleted, 'n') = 'n';
  IF v_n <> 1 THEN v_missing := v_missing || '销售退货基线菜单缺失;'; END IF;

  SELECT count(*) INTO v_n
    FROM public.sys_role_menus rm
    JOIN public.sys_roles r ON r.id = rm.role_id
    JOIN public.sys_menus m ON m.id = rm.menu_id
   WHERE r.tenant_id IS NULL AND rm.tenant_id IS NULL
     AND m.menu_code = 'inventory_sales-returns'
     AND COALESCE(rm.is_deleted, 'n') = 'n'
     AND r.role_code IN ('super_admin', 'tenant_admin', 'inventory_manager');
  IF v_n < 3 THEN v_missing := v_missing || format('菜单基线授权不足（% < 3）;', v_n); END IF;

  FOR v_tenant IN
    SELECT t.id FROM public.sys_tenants t
    WHERE COALESCE(t.is_deleted, 'n') = 'n' AND COALESCE(t.metadata_materialized, FALSE)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.sys_menus m
      WHERE m.tenant_id = v_tenant.id AND m.menu_code = 'inventory_sales-returns'
        AND COALESCE(m.is_deleted, 'n') = 'n'
    ) THEN
      v_missing := v_missing || format('租户%s缺销售退货菜单副本;', v_tenant.id);
    END IF;
  END LOOP;

  SELECT count(*) INTO v_n FROM pg_policies
   WHERE tablename IN ('erp_sales_returns_s_539dcf81_b', 'erp_sales_return_details_s_539dcf81_b');
  IF v_n < 8 THEN
    v_missing := v_missing || format('销售退货表 RLS 策略偏少（% < 8）;', v_n);
  END IF;

  IF v_missing <> '' THEN
    RAISE EXCEPTION 'deploy_90 自检失败：%', v_missing;
  END IF;

  RAISE NOTICE 'deploy_90 OK：销售退货表补列 / DocType / 映射 / 菜单 / RLS 齐备';
END;
$$;
