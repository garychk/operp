-- ============================================================================
-- P1-1：采购退货单（表 + 单据类型 + 交易类型映射 + 菜单）
-- ============================================================================
--
-- 差距清单 A1：改造前全库搜 `purchase_return` 只命中字典项与前端常量，
-- **无表、无 RPC、无页面** —— 退货只能靠「库存调整」硬凑，账实、账账都对不上。
--
-- 本文件负责「有单据」这一半：表结构、单据类型、业务类型映射、菜单与权限。
-- 过账逻辑在 deploy_92（post_stock_document 的 purchase_return 分支）：
--   方向 out（减库存），同时生成一条**负数应付**冲减 erp_payables.balance。
--
-- 红字应付的选择理由：供应商往来要可审计、可追溯。把原入库单的应付行直接改小
-- （balance -= x）会抹掉历史、并且在原单已部分付款时把 paid_amount 与 balance 弄矛盾；
-- 新开一条金额为负的应付行等价于标准 ERP 的「贷项通知单」，供应商余额合计自然被冲减，
-- 且每一笔冲减都有独立的单据号与凭证。
--
-- 本脚本由 000_run_all 用 psql --single-transaction 执行，**不要写 BEGIN/COMMIT**。
-- 依赖：deploy_88（库存状态维度）、deploy_01（供应商/仓库/物料主数据）。
-- ============================================================================

-- ============================================================================
-- 1. 主表
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.erp_purchase_returns_s_539dcf81_b (
  id SERIAL PRIMARY KEY,
  corp_id VARCHAR(128),
  emp_id VARCHAR(128),
  is_deleted CHAR(1) NOT NULL DEFAULT 'n',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  return_no VARCHAR(50) NOT NULL,
  return_date DATE NOT NULL,
  receipt_id INTEGER REFERENCES public.erp_purchase_receipts_s_539dcf81_b(id),
  supplier_id INTEGER,
  warehouse_id INTEGER,
  location_id INTEGER,
  total_amount NUMERIC NOT NULL DEFAULT 0,
  currency VARCHAR(10) NOT NULL DEFAULT 'CNY',
  exchange_rate NUMERIC NOT NULL DEFAULT 1,
  base_total_amount NUMERIC NOT NULL DEFAULT 0,
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

CREATE INDEX IF NOT EXISTS idx_erp_purchase_returns_tenant
  ON public.erp_purchase_returns_s_539dcf81_b (tenant_id);
CREATE INDEX IF NOT EXISTS idx_erp_purchase_returns_date
  ON public.erp_purchase_returns_s_539dcf81_b (tenant_id, return_date DESC)
  WHERE is_deleted = 'n';
CREATE INDEX IF NOT EXISTS idx_erp_purchase_returns_receipt
  ON public.erp_purchase_returns_s_539dcf81_b (receipt_id)
  WHERE is_deleted = 'n';
-- 单据号分租户唯一（不写成全表 UNIQUE，避免多租户串号；口径与 deploy_51 一致）
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_purchase_returns_no
  ON public.erp_purchase_returns_s_539dcf81_b (tenant_id, return_no)
  WHERE is_deleted = 'n';
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_purchase_returns_posting_key
  ON public.erp_purchase_returns_s_539dcf81_b (posting_idempotency_key)
  WHERE posting_idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_purchase_returns_reversal_key
  ON public.erp_purchase_returns_s_539dcf81_b (reversal_idempotency_key)
  WHERE reversal_idempotency_key IS NOT NULL;

-- ============================================================================
-- 2. 明细表
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.erp_purchase_return_details_s_539dcf81_b (
  id SERIAL PRIMARY KEY,
  corp_id VARCHAR(128),
  emp_id VARCHAR(128),
  is_deleted CHAR(1) NOT NULL DEFAULT 'n',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  return_id INTEGER NOT NULL REFERENCES public.erp_purchase_returns_s_539dcf81_b(id),
  line_no INTEGER NOT NULL,
  receipt_detail_id INTEGER REFERENCES public.erp_purchase_receipt_details_s_539dcf81_b(id),
  product_id INTEGER NOT NULL,
  quantity NUMERIC NOT NULL DEFAULT 0,
  unit_price NUMERIC NOT NULL DEFAULT 0,
  amount NUMERIC NOT NULL DEFAULT 0,
  base_unit_price NUMERIC NOT NULL DEFAULT 0,
  base_amount NUMERIC NOT NULL DEFAULT 0,
  batch_no VARCHAR(100),
  location_id INTEGER,
  expiry_date DATE,
  reason TEXT,
  remark TEXT,
  tenant_id BIGINT NOT NULL DEFAULT current_tenant_id()
);

CREATE INDEX IF NOT EXISTS idx_erp_purchase_return_details_return
  ON public.erp_purchase_return_details_s_539dcf81_b (return_id)
  WHERE is_deleted = 'n';
CREATE INDEX IF NOT EXISTS idx_erp_purchase_return_details_product
  ON public.erp_purchase_return_details_s_539dcf81_b (product_id)
  WHERE is_deleted = 'n';

-- ============================================================================
-- 3. 权限与 RLS（fail-closed，与其余 erp_* 一致）
-- ============================================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON public.erp_purchase_returns_s_539dcf81_b TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.erp_purchase_returns_s_539dcf81_b_id_seq TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.erp_purchase_return_details_s_539dcf81_b TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.erp_purchase_return_details_s_539dcf81_b_id_seq TO authenticated;

SELECT public.install_role_table_rls('erp_purchase_returns_s_539dcf81_b');
SELECT public.install_role_table_rls('erp_purchase_return_details_s_539dcf81_b');
SELECT public.refresh_sys_tables();

-- ============================================================================
-- 4. 应付：红字行也要有「单据 ↔ 应付」唯一约束，否则重复过账会挂两笔
-- ============================================================================
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_payables_active_purchase_return
  ON public.erp_payables_s_539dcf81_b (tenant_id, source_type, source_id)
  WHERE is_deleted = 'n' AND source_type = 'purchase_return' AND source_id IS NOT NULL;

-- ============================================================================
-- 5. 单据类型（generate_document_no 靠它取 naming_rule）
--    sys_document_types.document_type 是全表唯一（被外键引用），可写 ON CONFLICT
-- ============================================================================
INSERT INTO public.sys_document_types (
  document_type, document_name, primary_key_field, module_code, route_path,
  table_name, naming_rule, is_submittable, status, sort_order, is_deleted
)
VALUES (
  'purchase_return', '采购退货', 'id', 'inventory', '/inventory/purchase-returns',
  'erp_purchase_returns_s_539dcf81_b', 'PRN{YYYY}{####}', TRUE, '1', 39, 'n'
)
ON CONFLICT (document_type) DO UPDATE SET
  document_name = EXCLUDED.document_name,
  module_code   = EXCLUDED.module_code,
  route_path    = EXCLUDED.route_path,
  table_name    = EXCLUDED.table_name,
  naming_rule   = EXCLUDED.naming_rule,
  is_deleted    = 'n',
  updated_at    = NOW();

-- 业务类型映射：采购退货只有出库一个方向
INSERT INTO public.sys_document_transaction_types
  (document_type_id, transaction_type_code, direction, is_default, condition_note, sort_order)
SELECT d.id, x.code, x.direction, x.is_default, x.note, x.sort_order
FROM public.sys_document_types d
JOIN (VALUES
  ('purchase_return_out', 'out', TRUE, '采购退货出库', 10)
) AS x(code, direction, is_default, note, sort_order) ON TRUE
WHERE d.document_type = 'purchase_return' AND d.is_deleted = 'n'
ON CONFLICT (document_type_id, transaction_type_code) DO UPDATE SET
  direction = EXCLUDED.direction, is_default = EXCLUDED.is_default,
  condition_note = EXCLUDED.condition_note, sort_order = EXCLUDED.sort_order,
  is_deleted = 'n', updated_at = NOW();

-- ============================================================================
-- 6. 菜单（照 deploy_66 三步法：基线 → 基线角色授权 → 已物化租户补差）
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
  '采购退货', 'inventory_purchase-returns', 'C', 'RollbackOutlined',
  '/inventory/purchase-returns', './pages/inventory/PurchaseReturns', 14, '1', 'n', NULL
WHERE NOT EXISTS (
  SELECT 1 FROM public.sys_menus m
  WHERE m.tenant_id IS NULL AND m.menu_code = 'inventory_purchase-returns'
);

INSERT INTO public.sys_role_menus (role_id, menu_id, is_deleted, tenant_id)
SELECT r.id, m.id, 'n', NULL
FROM public.sys_roles r
CROSS JOIN public.sys_menus m
WHERE r.tenant_id IS NULL
  AND COALESCE(r.is_deleted, 'n') = 'n'
  AND r.role_code IN ('super_admin', 'tenant_admin', 'inventory_manager')
  AND m.tenant_id IS NULL
  AND m.menu_code = 'inventory_purchase-returns'
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
  IF to_regclass('public.erp_purchase_returns_s_539dcf81_b') IS NULL THEN
    v_missing := v_missing || 'erp_purchase_returns 表未建立;';
  END IF;
  IF to_regclass('public.erp_purchase_return_details_s_539dcf81_b') IS NULL THEN
    v_missing := v_missing || 'erp_purchase_return_details 表未建立;';
  END IF;

  SELECT count(*) INTO v_n FROM public.sys_document_types
   WHERE document_type = 'purchase_return' AND is_deleted = 'n';
  IF v_n <> 1 THEN v_missing := v_missing || 'DocType purchase_return 缺失;'; END IF;

  SELECT count(*) INTO v_n
    FROM public.sys_document_transaction_types m
    JOIN public.sys_document_types d ON d.id = m.document_type_id
   WHERE d.document_type = 'purchase_return'
     AND m.transaction_type_code = 'purchase_return_out'
     AND m.direction = 'out' AND m.is_default AND m.is_deleted = 'n';
  IF v_n <> 1 THEN v_missing := v_missing || 'purchase_return 的业务类型映射缺失;'; END IF;

  SELECT count(*) INTO v_n FROM public.sys_menus
   WHERE tenant_id IS NULL AND menu_code = 'inventory_purchase-returns'
     AND COALESCE(is_deleted, 'n') = 'n';
  IF v_n <> 1 THEN v_missing := v_missing || '采购退货基线菜单缺失;'; END IF;

  SELECT count(*) INTO v_n
    FROM public.sys_role_menus rm
    JOIN public.sys_roles r ON r.id = rm.role_id
    JOIN public.sys_menus m ON m.id = rm.menu_id
   WHERE r.tenant_id IS NULL AND rm.tenant_id IS NULL
     AND m.menu_code = 'inventory_purchase-returns'
     AND COALESCE(rm.is_deleted, 'n') = 'n'
     AND r.role_code IN ('super_admin', 'tenant_admin', 'inventory_manager');
  IF v_n < 3 THEN
    v_missing := v_missing || format('菜单基线授权不足（% < 3）;', v_n);
  END IF;

  FOR v_tenant IN
    SELECT t.id FROM public.sys_tenants t
    WHERE COALESCE(t.is_deleted, 'n') = 'n' AND COALESCE(t.metadata_materialized, FALSE)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.sys_menus m
      WHERE m.tenant_id = v_tenant.id AND m.menu_code = 'inventory_purchase-returns'
        AND COALESCE(m.is_deleted, 'n') = 'n'
    ) THEN
      v_missing := v_missing || format('租户%s缺采购退货菜单副本;', v_tenant.id);
    END IF;
  END LOOP;

  -- 唯一未写 RLS 的表会让 ai-server（service_role）之外的调用方越权读
  SELECT count(*) INTO v_n FROM pg_policies
   WHERE tablename IN ('erp_purchase_returns_s_539dcf81_b', 'erp_purchase_return_details_s_539dcf81_b');
  IF v_n < 8 THEN
    v_missing := v_missing || format('采购退货表 RLS 策略偏少（% < 8）;', v_n);
  END IF;

  IF v_missing <> '' THEN
    RAISE EXCEPTION 'deploy_89 自检失败：%', v_missing;
  END IF;

  RAISE NOTICE 'deploy_89 OK：采购退货单表 / DocType / 映射 / 菜单 / RLS 齐备';
END;
$$;
