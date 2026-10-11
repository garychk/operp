-- ============================================================================
-- deploy_58: 平台菜单基线（根节点 + 业务菜单）
-- ============================================================================
--
-- 背景
-- ----
-- 「系统管理」根菜单与若干业务菜单由 deploy_01 起的各脚本写入，但
-- **财务 / 进销存 / 生产制造三棵业务菜单树的根节点及其大部分子菜单**
-- 此前只存在于仓库之外的「实施数据脚本」里
-- （见 README_DEPLOYMENT.md「部署后必须配置 → 补齐业务菜单」）。
--
-- 后果（在空库上做全量部署时暴露）：
--   1. 根菜单缺失 → deploy_109 / 114 / 117 / 119 的 fail-loud 自检直接失败
--      （"找不到 mrp 父菜单" / "未挂在 mrp 下（parent_id=0）"），
--      而 deploy_59 / 62 / 64 / 89 / 90 / 91 / 98 / 102 / 104 / 106 写的是
--      COALESCE(..., 0)，会**静默**把子菜单挂到 parent_id = 0；
--   2. deploy_117 还硬断言「部门管理」（mrp_departments）存在 → 必然失败；
--   3. 空库部署出来的菜单树只有 37 条，前端 36 个页面（财务/进销存/生产主数据/
--      系统配置）在菜单里没有入口 —— 这些页面代码都在仓库里，只是菜单数据不在。
--
-- 本脚本把根节点 + 这 36 条业务菜单收进仓库，让空库一键部署出**完整菜单树**。
-- 属性（父级 / 名称 / path / component / icon / sort_order）逐条取自线上在跑的
-- 菜单树实况，且 36 个 component 对应的前端文件已逐个核验存在。
--
-- ⚠️ 与仓库外「实施数据脚本」的关系
-- ---------------------------------
--   那份脚本没有防重守卫，历史上跑两遍就产生过整棵菜单树成对重复
--   （见 .workbuddy/memory 2026-10-05 记录）。本脚本全部使用 NOT EXISTS 守卫，
--   跑多少次都只会有一行。**启用本脚本后应停用那份外部脚本的菜单部分**，
--   否则它仍会再插一份重复菜单。
--
-- 三步（与 deploy_64 / deploy_109 完全同构）
-- ------------------------------------------
--   1. 插基线行（NOT EXISTS 守卫 —— sys_menus 没有 (tenant_id, menu_code)
--      唯一索引，不能写 ON CONFLICT）；
--   2. 补基线角色授权（super_admin + tenant_admin）；
--   3. 遍历已物化租户调 clone_platform_baseline_to_tenant(id, FALSE, TRUE) 补差。
--   漏第 3 步是静默的 → 第 4 步 fail-loud 自检。
--
-- 依赖与位置
-- ----------
--   · 需要 deploy_50 的 tenant_admin 基线角色、deploy_52 的克隆函数 → 编号 58 满足；
--   · **必须排在第一个查找父菜单的脚本（deploy_59）之前** → 编号 58 满足
--     （同号兄弟按文件名 glob 序：deploy_58_platform_menu_baseline 在
--      deploy_58_production_receipt_and_locations 之前）；
--   · ⚠️ 第 1 节的 VALUES **根节点必须排在前**，否则子菜单找不到父 id 会
--      落到 parent_id = 0（第 4 节自检会拦下，但仍应按序书写）；
--   · 本脚本由 000_run_all 用 psql --single-transaction 执行，**不要写 BEGIN/COMMIT**。
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. 基线菜单行（幂等）
--    (父级 code, 菜单名, 菜单 code, 类型, 图标, path, component, sort_order)
--    根节点 parent_code 为空串 → parent_id = 0
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_menu RECORD;
  v_parent_id INTEGER;
  v_inserted  INTEGER := 0;
  v_updated   INTEGER := 0;
BEGIN
  FOR v_menu IN
    SELECT * FROM (VALUES
      -- ===== 根节点（必须最先插，子菜单靠 menu_code 找父 id）=====
      ('',           '财务管理',       'finance',                 'M', 'MenuOutlined', '/finance',                   NULL, 2),
      ('',           '进销存管理',     'inventory',               'M', 'MenuOutlined', '/inventory',                 NULL, 3),
      ('',           '生产制造',       'mrp',                     'M', 'MenuOutlined', '/mrp',                       NULL, 4),

      -- ===== 财务管理 =====
      ('finance',    '会计科目',       'finance_subjects',        'C', 'MenuOutlined', '/finance/subjects',          './pages/finance/AccountSubjects',      1),
      ('finance',    '凭证管理',       'finance_vouchers',        'C', 'MenuOutlined', '/finance/vouchers',          './pages/finance/Vouchers',             2),
      ('finance',    '总账余额',       'finance_gl-balance',      'C', 'MenuOutlined', '/finance/gl-balance',        './pages/finance/GeneralLedgerBalance', 3),
      ('finance',    '试算平衡',       'finance_trial-balance',   'C', 'MenuOutlined', '/finance/trial-balance',     './pages/finance/TrialBalance',         4),
      ('finance',    '科目/明细账',    'finance_ledger',          'C', 'MenuOutlined', '/finance/ledger',            './pages/finance/SubjectLedger',        5),
      ('finance',    '会计期间',       'finance_periods',         'C', 'MenuOutlined', '/finance/periods',           './pages/finance/AccountingPeriods',    6),
      ('finance',    '应收账款',       'finance_receivables',     'C', 'MenuOutlined', '/finance/receivables',       './pages/finance/Receivables',          7),
      ('finance',    '应付账款',       'finance_payables',        'C', 'MenuOutlined', '/finance/payables',          './pages/finance/Payables',             8),
      ('finance',    '固定资产',       'finance_assets',          'C', 'MenuOutlined', '/finance/assets',            './pages/finance/FixedAssets',          9),
      ('finance',    '资产类别',       'finance_asset-categories','C', 'MenuOutlined', '/finance/asset-categories',  './pages/finance/AssetCategories',     10),

      -- ===== 进销存 =====
      ('inventory',  '客户管理',       'inventory_customers',          'C', 'MenuOutlined', '/inventory/customers',          './pages/inventory/Customers',          1),
      ('inventory',  '供应商管理',     'inventory_suppliers',          'C', 'MenuOutlined', '/inventory/suppliers',          './pages/inventory/Suppliers',          2),
      ('inventory',  '物料管理',       'inventory_products',           'C', 'MenuOutlined', '/inventory/products',           './pages/inventory/Products',           3),
      ('inventory',  '仓库管理',       'inventory_warehouses',         'C', 'MenuOutlined', '/inventory/warehouses',         './pages/inventory/Warehouses',         4),
      ('inventory',  '库存查询',       'inventory_stock',              'C', 'MenuOutlined', '/inventory/stock',              './pages/inventory/Inventory',          5),
      ('inventory',  '库存流水',       'inventory_transactions',       'C', 'MenuOutlined', '/inventory/transactions',       './pages/inventory/InventoryTransactions', 6),
      ('inventory',  '采购订单',       'inventory_purchase',           'C', 'MenuOutlined', '/inventory/purchase',           './pages/inventory/PurchaseOrders',     7),
      ('inventory',  '采购入库',       'inventory_purchase-receipts',  'C', 'MenuOutlined', '/inventory/purchase-receipts',  './pages/inventory/PurchaseReceipts',   8),
      ('inventory',  '销售订单',       'inventory_sales',              'C', 'MenuOutlined', '/inventory/sales',              './pages/inventory/SalesOrders',        9),
      ('inventory',  '销售出货',       'inventory_sales-deliveries',   'C', 'MenuOutlined', '/inventory/sales-deliveries',   './pages/inventory/SalesDeliveries',   10),
      ('inventory',  '库存调拨',       'inventory_transfers',          'C', 'MenuOutlined', '/inventory/transfers',          './pages/inventory/InventoryTransfers', 11),
      ('inventory',  '库存盘点',       'inventory_stock-counts',       'C', 'MenuOutlined', '/inventory/stock-counts',       './pages/inventory/StockCounts',       12),
      ('inventory',  '库存调整',       'inventory_stock-adjustments',  'C', 'MenuOutlined', '/inventory/stock-adjustments',  './pages/inventory/StockAdjustments',  13),

      -- ===== 生产制造（主数据区段 1~7，deploy_117 会给 2~7 腾位）=====
      ('mrp',        '部门管理',       'mrp_departments',   'C', 'MenuOutlined', '/mrp/departments',   './pages/mrp/Departments',         1),
      ('mrp',        'BOM管理',        'mrp_boms',          'C', 'MenuOutlined', '/mrp/boms',          './pages/mrp/Boms',                2),
      ('mrp',        '工艺路线',       'mrp_routings',      'C', 'MenuOutlined', '/mrp/routings',      './pages/mrp/RoutingOperations',   3),
      ('mrp',        '工作中心',       'mrp_workcenters',   'C', 'MenuOutlined', '/mrp/workcenters',   './pages/mrp/WorkCenters',         4),
      ('mrp',        '工序管理',       'mrp_operations',    'C', 'MenuOutlined', '/mrp/operations',    './pages/mrp/Operations',          5),
      ('mrp',        '生产订单',       'mrp_production',    'C', 'MenuOutlined', '/mrp/production',    './pages/mrp/ProductionOrders',    6),
      ('mrp',        '领料单',         'mrp_material-issues','C', 'MenuOutlined', '/mrp/material-issues','./pages/mrp/MaterialIssues',     7),
      ('mrp',        'MRP计划',        'mrp_plans',         'C', 'MenuOutlined', '/mrp/plans',         './pages/mrp/MrpPlans',           11),
      ('mrp',        '检验管理',       'mrp_quality',       'C', 'MenuOutlined', '/mrp/quality',       './pages/mrp/QualityInspections', 13),

      -- ===== 系统管理（system 根节点由 deploy_01 建）=====
      ('system',     '流程配置',       'system_workflow',        'C', 'MenuOutlined', '/system/workflow',        './pages/system/WorkflowConfig',      6),
      ('system',     '单据转换',       'system_doc-flow',        'C', 'MenuOutlined', '/system/doc-flow',        './pages/system/DocFlowConfig',       7),
      ('system',     'DocType构建',    'system_document-types',  'C', 'MenuOutlined', '/system/document-types',  './pages/system/DocumentTypeBuilder', 8),
      ('system',     '知识库管理',     'system_knowledge-base',  'C', 'MenuOutlined', '/system/knowledge-base',  './pages/system/KnowledgeBase',      15)
    ) AS t(parent_code, menu_name, menu_code, menu_type, icon, path, component, sort_order)
  LOOP
    IF EXISTS (
      SELECT 1 FROM public.sys_menus m
      WHERE m.tenant_id IS NULL AND m.menu_code = v_menu.menu_code
        AND COALESCE(m.is_deleted, 'n') = 'n'
    ) THEN
      CONTINUE;
    END IF;

    -- 解析父菜单 id（根节点 parent_code 为空串 → 0）
    IF v_menu.parent_code = '' THEN
      v_parent_id := 0;
    ELSE
      SELECT p.id INTO v_parent_id
      FROM public.sys_menus p
      WHERE p.tenant_id IS NULL AND p.menu_code = v_menu.parent_code
        AND COALESCE(p.is_deleted, 'n') = 'n'
      LIMIT 1;

      IF v_parent_id IS NULL THEN
        -- 父菜单应在本次 VALUES 里更靠前的位置，或由更早的脚本建立；
        -- 真缺失就 fail-loud，绝不静默落到 parent_id = 0。
        RAISE EXCEPTION 'deploy_58：菜单 % 的父菜单 % 不存在', v_menu.menu_code, v_menu.parent_code;
      END IF;
    END IF;

    INSERT INTO public.sys_menus (
      corp_id, emp_id, parent_id, menu_name, menu_code, menu_type, icon,
      path, component, sort_order, status, is_deleted, tenant_id
    ) VALUES (
      NULL, NULL, v_parent_id, v_menu.menu_name, v_menu.menu_code, v_menu.menu_type, v_menu.icon,
      v_menu.path, v_menu.component, v_menu.sort_order, '1', 'n', NULL
    );
    v_inserted := v_inserted + 1;
  END LOOP;

  RAISE NOTICE 'deploy_58：菜单基线本次新增 % 行（已存在的按原样保留）', v_inserted;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. 基线角色授权（super_admin + tenant_admin）
-- ---------------------------------------------------------------------------
INSERT INTO public.sys_role_menus (role_id, menu_id, is_deleted, tenant_id)
SELECT r.id, m.id, 'n', NULL
FROM public.sys_roles r
CROSS JOIN public.sys_menus m
WHERE r.tenant_id IS NULL
  AND COALESCE(r.is_deleted, 'n') = 'n'
  AND r.role_code IN ('super_admin', 'tenant_admin')
  AND m.tenant_id IS NULL
  AND COALESCE(m.is_deleted, 'n') = 'n'
  AND (m.menu_code IN ('finance', 'inventory', 'mrp')
       OR m.menu_code IN (
         'finance_subjects', 'finance_vouchers', 'finance_gl-balance', 'finance_trial-balance',
         'finance_ledger', 'finance_periods', 'finance_receivables', 'finance_payables',
         'finance_assets', 'finance_asset-categories',
         'inventory_customers', 'inventory_suppliers', 'inventory_products', 'inventory_warehouses',
         'inventory_stock', 'inventory_transactions', 'inventory_purchase', 'inventory_purchase-receipts',
         'inventory_sales', 'inventory_sales-deliveries', 'inventory_transfers', 'inventory_stock-counts',
         'inventory_stock-adjustments',
         'mrp_departments', 'mrp_boms', 'mrp_routings', 'mrp_workcenters', 'mrp_operations',
         'mrp_production', 'mrp_material-issues', 'mrp_plans', 'mrp_quality',
         'system_workflow', 'system_doc-flow', 'system_document-types', 'system_knowledge-base'
       ))
  AND NOT EXISTS (
    SELECT 1 FROM public.sys_role_menus dup
    WHERE dup.role_id = r.id AND dup.menu_id = m.id
  );

-- ---------------------------------------------------------------------------
-- 3. 给已物化租户补差
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_tenant RECORD;
  v_result JSONB;
  v_count  INTEGER := 0;
BEGIN
  FOR v_tenant IN
    SELECT t.id, t.code
    FROM public.sys_tenants t
    WHERE COALESCE(t.is_deleted, 'n') = 'n'
      AND COALESCE(t.metadata_materialized, FALSE)
    ORDER BY t.id
  LOOP
    v_result := public.clone_platform_baseline_to_tenant(v_tenant.id, FALSE, TRUE);
    RAISE NOTICE '租户 % (%) 元数据补差：%', v_tenant.id, v_tenant.code, v_result;
    v_count := v_count + 1;
  END LOOP;
  RAISE NOTICE '已给 % 个已物化租户补差', v_count;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. 自检（fail-loud）
--    校验每条菜单：存在 / 挂在预期父级下 / 有 super_admin + tenant_admin 授权；
--    以及每个已物化租户都有副本与 tenant_admin 授权。
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_menu   RECORD;
  v_id     INTEGER;
  v_parent INTEGER;
  v_expect INTEGER;
  v_grants INTEGER;
  v_tenant RECORD;
  v_bad    TEXT := '';
BEGIN
  FOR v_menu IN
    SELECT * FROM (VALUES
      ('',           'finance'),
      ('',           'inventory'),
      ('',           'mrp'),
      ('finance',    'finance_subjects'),
      ('finance',    'finance_vouchers'),
      ('finance',    'finance_gl-balance'),
      ('finance',    'finance_trial-balance'),
      ('finance',    'finance_ledger'),
      ('finance',    'finance_periods'),
      ('finance',    'finance_receivables'),
      ('finance',    'finance_payables'),
      ('finance',    'finance_assets'),
      ('finance',    'finance_asset-categories'),
      ('inventory',  'inventory_customers'),
      ('inventory',  'inventory_suppliers'),
      ('inventory',  'inventory_products'),
      ('inventory',  'inventory_warehouses'),
      ('inventory',  'inventory_stock'),
      ('inventory',  'inventory_transactions'),
      ('inventory',  'inventory_purchase'),
      ('inventory',  'inventory_purchase-receipts'),
      ('inventory',  'inventory_sales'),
      ('inventory',  'inventory_sales-deliveries'),
      ('inventory',  'inventory_transfers'),
      ('inventory',  'inventory_stock-counts'),
      ('inventory',  'inventory_stock-adjustments'),
      ('mrp',        'mrp_departments'),
      ('mrp',        'mrp_boms'),
      ('mrp',        'mrp_routings'),
      ('mrp',        'mrp_workcenters'),
      ('mrp',        'mrp_operations'),
      ('mrp',        'mrp_production'),
      ('mrp',        'mrp_material-issues'),
      ('mrp',        'mrp_plans'),
      ('mrp',        'mrp_quality'),
      ('system',     'system_workflow'),
      ('system',     'system_doc-flow'),
      ('system',     'system_document-types'),
      ('system',     'system_knowledge-base')
    ) AS t(parent_code, menu_code)
  LOOP
    SELECT m.id, COALESCE(m.parent_id, -1) INTO v_id, v_parent
    FROM public.sys_menus m
    WHERE m.tenant_id IS NULL AND m.menu_code = v_menu.menu_code
      AND COALESCE(m.is_deleted, 'n') = 'n';

    IF v_id IS NULL THEN
      v_bad := v_bad || format(' 缺菜单%s;', v_menu.menu_code);
      CONTINUE;
    END IF;

    IF v_menu.parent_code = '' THEN
      IF v_parent <> 0 THEN
        v_bad := v_bad || format(' %s应为根节点(parent_id=0)，实际%s;', v_menu.menu_code, v_parent);
      END IF;
    ELSE
      SELECT p.id INTO v_expect
      FROM public.sys_menus p
      WHERE p.tenant_id IS NULL AND p.menu_code = v_menu.parent_code
        AND COALESCE(p.is_deleted, 'n') = 'n';
      IF v_expect IS NULL OR v_parent <> v_expect THEN
        v_bad := v_bad || format(' %s未挂在%s下(parent_id=%s，期望%s);',
                                 v_menu.menu_code, v_menu.parent_code, v_parent, COALESCE(v_expect::TEXT, '不存在'));
      END IF;
    END IF;

    SELECT count(*) INTO v_grants
    FROM public.sys_role_menus rm
    JOIN public.sys_roles r ON r.id = rm.role_id
    WHERE rm.menu_id = v_id AND rm.tenant_id IS NULL
      AND COALESCE(rm.is_deleted, 'n') = 'n'
      AND r.role_code IN ('super_admin', 'tenant_admin');
    IF v_grants < 2 THEN
      v_bad := v_bad || format(' %s的基线角色授权不全(实际%s);', v_menu.menu_code, v_grants);
    END IF;
  END LOOP;

  FOR v_tenant IN
    SELECT t.id FROM public.sys_tenants t
    WHERE COALESCE(t.is_deleted, 'n') = 'n'
      AND COALESCE(t.metadata_materialized, FALSE)
    ORDER BY t.id
  LOOP
    FOR v_menu IN
      SELECT * FROM (VALUES
        ('finance'), ('inventory'), ('mrp'),
        ('finance_subjects'), ('finance_vouchers'),
        ('inventory_products'), ('inventory_stock'),
        ('mrp_departments'), ('mrp_boms'), ('mrp_production'),
        ('system_workflow')
      ) AS t(menu_code)
    LOOP
      IF NOT EXISTS (
        SELECT 1 FROM public.sys_menus m
        WHERE m.tenant_id = v_tenant.id AND m.menu_code = v_menu.menu_code
          AND COALESCE(m.is_deleted, 'n') = 'n'
      ) THEN
        v_bad := v_bad || format(' 租户%s缺菜单副本%s;', v_tenant.id, v_menu.menu_code);
      ELSIF NOT EXISTS (
        SELECT 1
        FROM public.sys_role_menus rm
        JOIN public.sys_roles r ON r.id = rm.role_id
        JOIN public.sys_menus m ON m.id = rm.menu_id
        WHERE r.tenant_id = v_tenant.id AND r.role_code = 'tenant_admin'
          AND m.tenant_id = v_tenant.id AND m.menu_code = v_menu.menu_code
          AND COALESCE(rm.is_deleted, 'n') = 'n'
      ) THEN
        v_bad := v_bad || format(' 租户%s的tenant_admin无菜单%s授权;', v_tenant.id, v_menu.menu_code);
      END IF;
    END LOOP;
  END LOOP;

  IF v_bad <> '' THEN
    RAISE EXCEPTION 'deploy_58 自检失败：%', v_bad;
  END IF;

  RAISE NOTICE 'deploy_58 OK：根节点 + 36 条业务菜单的基线与授权齐备';
END;
$$;
