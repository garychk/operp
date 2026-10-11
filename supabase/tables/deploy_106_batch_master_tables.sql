-- ============================================================================
-- P2-12：批次管理 + 批次主数据（表结构与配置）
-- ============================================================================
--
-- 补的是差距评估文档 §E 里的一整块空洞（E1 / E2，并为 E4 / E5 备好数据底座）：
--
--   E1 无批次管理开关
--      此前 `erp_products` 没有任何批次属性，于是「批次」在全系统里只是
--      库存行上的一个**自由文本**：同一物料可以一半库存带批次、一半不带，
--      而且带的那一半里 "LOT-A" / "lot-a" / " LOT-A " 会被当成三个批次
--      （库存表的判等口径是 `COALESCE(NULLIF(BTRIM(batch_no),''),'')`）。
--
--   E2 无批次主数据
--      18 张 erp_ 表都有 `batch_no` 列，但**没有任何一张表回答**
--      「LOT-A 是什么」：什么时候生产的、什么时候到期、供应商批号是什么、
--      质检过没过、还能不能用。
--
-- ---------------------------------------------------------------------------
-- 设计要点
-- ---------------------------------------------------------------------------
-- 1. 批次属性挂在**物料**上，不是挂在单据上
--    `erp_products.is_batch_managed` 决定该物料过账时**是否必须**填批次。
--    强制点放在唯一漏斗 `inventory_apply_move()`（见 deploy_107），
--    而不是放到 9 个过账 RPC 里逐个加 —— 一处收口，将来新增单据自动生效。
--    默认 FALSE：存量物料行为完全不变，**零回归**。
--
-- 2. `erp_products.shelf_life_days` 是**辅助字段，不做隐式推算**
--    页面上填了生产日期就能一键算出效期、并校验「效期不超过 生产日期+保质期」。
--    但过账路径**不会**拿它去猜效期：静默猜错的效期比没有效期更糟 ——
--    会让近效期预警误报或漏报，而且事后完全查不出是谁猜的。
--    这与项目一贯的「宁可拦住不猜」一致（参见 deploy_105 的 0 成本守卫）。
--
-- 3. 批次号存**规范化后的值**
--    `batch_no = BTRIM(batch_no)` 且非空（CHECK）。因为库存表的判等口径是
--    `COALESCE(NULLIF(BTRIM(batch_no),''),'')`，如果主数据表存 " LOT-A "，
--    它永远匹配不上任何库存行 —— 追溯会静默查不到东西。
--
-- 4. 唯一键是 `(tenant_id, product_id, batch_no)`
--    **批次号只在物料内唯一，不是全局唯一**：供应商 A 和供应商 B 都可能送
--    "20260101" 这个批号，它们是完全不同的两批货。
--    这与 I1（库存表唯一键）的口径一致。
--
-- 5. 存量回填
--    上线前已经存在、且带批次的库存行，一并建出批次档案（source_type='backfill'），
--    否则「物料开了批次管理，但老批次的档案是空的」，追溯页对老数据直接空转。
--
-- 本脚本由 000_run_all 用 psql --single-transaction 执行，**不要写 BEGIN/COMMIT**。
-- 依赖：deploy_01（erp_products）、deploy_02（refresh_sys_tables）、
--       deploy_03（菜单权限）、deploy_32（generate_document_no）、
--       deploy_66（菜单三步法）、根表 erp_inventory。
-- ============================================================================


-- ============================================================================
-- 1. 物料上的批次属性
-- ============================================================================
ALTER TABLE public.erp_products_s_539dcf81_b
  ADD COLUMN IF NOT EXISTS is_batch_managed BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS shelf_life_days  INTEGER;

COMMENT ON COLUMN public.erp_products_s_539dcf81_b.is_batch_managed IS
  '批次管理开关：TRUE 时该物料过账必须带批次号（由 inventory_apply_move 强制），默认 FALSE 保持存量行为不变';
COMMENT ON COLUMN public.erp_products_s_539dcf81_b.shelf_life_days IS
  '保质期天数（可为空）。仅用于页面辅助计算效期与校验，过账路径不会用它隐式推算效期';

-- 保质期天数为空或正数（0 与负数没有意义）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.erp_products_s_539dcf81_b'::regclass
       AND conname = 'ck_erp_products_shelf_life_days'
  ) THEN
    ALTER TABLE public.erp_products_s_539dcf81_b
      ADD CONSTRAINT ck_erp_products_shelf_life_days
      CHECK (shelf_life_days IS NULL OR shelf_life_days > 0);
  END IF;
END;
$$;


-- ============================================================================
-- 2. 批次主数据
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.erp_batches_s_539dcf81_b (
  id SERIAL PRIMARY KEY,
  corp_id VARCHAR(128),
  emp_id VARCHAR(128),
  is_deleted CHAR(1) NOT NULL DEFAULT 'n',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- 规范化后的批次号：与库存表的判等口径一致，否则永远匹配不上库存行
  batch_no VARCHAR(100) NOT NULL CHECK (batch_no = BTRIM(batch_no) AND batch_no <> ''),
  product_id INTEGER NOT NULL,
  -- 效期与生产日期：批次的核心属性，近效期预警（E4）靠它们分桶
  production_date DATE,
  expiry_date DATE,
  -- 建档时的保质期快照：产品上的 shelf_life_days 将来可能被改，
  -- 批次自己记住当时的口径才不会被追溯时「穿越」
  shelf_life_days INTEGER CHECK (shelf_life_days IS NULL OR shelf_life_days > 0),
  -- 供应商信息：采购批次必需；自制批次留空
  supplier_id INTEGER,
  supplier_batch_no VARCHAR(100),
  -- 建档来源：批次是随入库自动建的还是人工建的，追溯时要能区分
  --   auto     = 随入库由 inventory_apply_move 自动建档（最常见）
  --   manual   = 人工在「批次管理」页新建
  --   backfill = 部署时按已有库存行回填
  --   其余     = 建批时由页面标明业务来源，用于区分批次「出身」
  source_type VARCHAR(30) NOT NULL DEFAULT 'manual'
    CHECK (source_type IN ('purchase', 'production', 'subcontract', 'transfer',
                           'opening', 'other', 'manual', 'auto', 'backfill')),
  source_document_no VARCHAR(100),
  source_document_id INTEGER,
  -- 质检状态：与 erp_production_receipts.quality_status 口径保持一致
  qc_status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (qc_status IN ('pending', 'passed', 'failed', 'hold')),
  -- 批次自身状态：blocked = 冻结不可用（客户投诉/质检不通过时停用整批）
  status VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'blocked', 'expired', 'closed')),
  -- 建档时的参考成本快照（不参与核算，仅供追溯页展示当时入账价）
  unit_cost NUMERIC(18, 6) NOT NULL DEFAULT 0,
  remark TEXT,
  created_by INTEGER,
  tenant_id BIGINT NOT NULL DEFAULT current_tenant_id(),
  -- 效期不能早于生产日期（两个都填了才校验）
  CONSTRAINT ck_erp_batches_dates
    CHECK (expiry_date IS NULL OR production_date IS NULL OR expiry_date >= production_date)
);

CREATE INDEX IF NOT EXISTS idx_erp_batches_tenant
  ON public.erp_batches_s_539dcf81_b (tenant_id);
CREATE INDEX IF NOT EXISTS idx_erp_batches_product
  ON public.erp_batches_s_539dcf81_b (tenant_id, product_id)
  WHERE is_deleted = 'n';
CREATE INDEX IF NOT EXISTS idx_erp_batches_expiry
  ON public.erp_batches_s_539dcf81_b (tenant_id, expiry_date)
  WHERE is_deleted = 'n' AND expiry_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_erp_batches_status
  ON public.erp_batches_s_539dcf81_b (tenant_id, status, qc_status)
  WHERE is_deleted = 'n';
CREATE INDEX IF NOT EXISTS idx_erp_batches_source
  ON public.erp_batches_s_539dcf81_b (tenant_id, source_type, source_document_id)
  WHERE is_deleted = 'n';

-- ⚠️ 这条部分唯一索引就是 `inventory_apply_move` 里 ON CONFLICT 的推断目标
--    （见 deploy_107）：列顺序与谓词必须与 ON CONFLICT 子句完全对应，
--    改了这里就要同步改那里，否则 upsert 会报「no unique or exclusion constraint matching」。
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_batches_product_no
  ON public.erp_batches_s_539dcf81_b (tenant_id, product_id, batch_no)
  WHERE is_deleted = 'n';

COMMENT ON TABLE public.erp_batches_s_539dcf81_b IS
  '批次主数据：回答「这个批次是什么」。批次号只在物料内唯一，判等口径与 erp_inventory 一致（BTRIM 后非空）';


-- ============================================================================
-- 3. 存量回填：已有库存里的批次先建出档案
--    不这么做的话，「物料开了批次管理 → 老批次查不到档案 → 追溯页空转」。
-- ============================================================================
INSERT INTO public.erp_batches_s_539dcf81_b (
  batch_no, product_id, expiry_date, source_type, status, qc_status, remark, tenant_id
)
SELECT
  BTRIM(i.batch_no),
  i.product_id,
  -- 同一批次若有多行库存（不同库位/状态），取**最晚**效期：
  -- 取早会把本来没过期的批次标成过期（误报），取晚只影响预警提前量（可接受）
  MAX(i.expiry_date),
  'backfill',
  'active',
  'pending',
  format('部署时按已有库存行回填（%s 行库存）', COUNT(*)),
  i.tenant_id
FROM public.erp_inventory_s_539dcf81_b i
WHERE i.is_deleted = 'n'
  AND i.batch_no IS NOT NULL
  AND BTRIM(i.batch_no) <> ''
GROUP BY i.tenant_id, i.product_id, BTRIM(i.batch_no)
ON CONFLICT (tenant_id, product_id, batch_no) WHERE is_deleted = 'n' DO NOTHING;


-- ============================================================================
-- 4. 权限与 RLS（fail-closed，与其余 erp_* 一致）
-- ============================================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON public.erp_batches_s_539dcf81_b TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.erp_batches_s_539dcf81_b_id_seq TO authenticated;

SELECT public.install_role_table_rls('erp_batches_s_539dcf81_b');
SELECT public.refresh_sys_tables();


-- ============================================================================
-- 5. 单据类型
--    `batch` 不是单据（不走审批、不产凭证），注册它的唯一目的是让批次号
--    能走统一的 generate_document_no('batch') 取编号规则 —— 与既有的
--    `products`（物料）一样，sys_document_types 里本来就允许放主数据类目。
--    document_type 是全表唯一（被外键引用），可写 ON CONFLICT。
-- ============================================================================
INSERT INTO public.sys_document_types (
  document_type, document_name, primary_key_field, module_code, route_path,
  table_name, naming_rule, is_submittable, status, sort_order, is_deleted
)
VALUES
  ('batch', '批次', 'id', 'inventory', '/inventory/batches',
   'erp_batches_s_539dcf81_b', 'LOT{YYYY}{MM}{####}', FALSE, '1', 43, 'n')
ON CONFLICT (document_type) DO UPDATE SET
  document_name  = EXCLUDED.document_name,
  module_code    = EXCLUDED.module_code,
  route_path     = EXCLUDED.route_path,
  table_name     = EXCLUDED.table_name,
  naming_rule    = EXCLUDED.naming_rule,
  is_submittable = EXCLUDED.is_submittable,
  is_deleted     = 'n',
  updated_at     = NOW();


-- ============================================================================
-- 6. 菜单（照 deploy_66 三步法：基线 → 基线角色授权 → 已物化租户补差）
--    挂在「进销存管理(inventory)」下，接在「期初库存」(20) 之后。
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
  v.menu_name, v.menu_code, 'C', v.icon, v.path, v.component, v.sort_order, '1', 'n', NULL
FROM (VALUES
  ('批次管理', 'inventory_batches',     'ContainerOutlined', '/inventory/batches',     './pages/inventory/Batches',    21),
  ('批次追溯', 'inventory_batch-trace', 'BranchesOutlined',  '/inventory/batch-trace', './pages/inventory/BatchTrace', 22)
) AS v(menu_name, menu_code, icon, path, component, sort_order)
WHERE NOT EXISTS (
  SELECT 1 FROM public.sys_menus m
  WHERE m.tenant_id IS NULL AND m.menu_code = v.menu_code
);

INSERT INTO public.sys_role_menus (role_id, menu_id, is_deleted, tenant_id)
SELECT r.id, m.id, 'n', NULL
FROM public.sys_roles r
CROSS JOIN public.sys_menus m
WHERE r.tenant_id IS NULL
  AND COALESCE(r.is_deleted, 'n') = 'n'
  AND r.role_code IN ('super_admin', 'tenant_admin', 'inventory_manager')
  AND m.tenant_id IS NULL
  AND m.menu_code IN ('inventory_batches', 'inventory_batch-trace')
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
-- 7. 自检（fail-loud）
-- ============================================================================
DO $$
DECLARE
  v_missing TEXT := '';
  v_n       INTEGER;
  v_tenant  RECORD;
  v_menu    CONSTANT TEXT[] := ARRAY['inventory_batches', 'inventory_batch-trace'];
BEGIN
  -- 7.1 批次表：存在 / RLS ≥4 / tenant_id NOT NULL
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'erp_batches_s_539dcf81_b' AND c.relkind = 'r'
  ) THEN
    v_missing := v_missing || '缺表 erp_batches_s_539dcf81_b;';
  ELSE
    SELECT count(*) INTO v_n FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'erp_batches_s_539dcf81_b';
    IF COALESCE(v_n, 0) < 4 THEN
      v_missing := v_missing || format('erp_batches 的 RLS 策略只有 %s 条（应 ≥4）;', v_n);
    END IF;

    SELECT count(*) INTO v_n
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'erp_batches_s_539dcf81_b'
       AND column_name = 'tenant_id' AND is_nullable = 'NO';
    IF COALESCE(v_n, 0) <> 1 THEN
      v_missing := v_missing || 'erp_batches 缺 tenant_id NOT NULL;';
    END IF;

    -- 7.2 唯一键必须含 product_id（批次号只在物料内唯一）
    SELECT count(*) INTO v_n
      FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = 'erp_batches_s_539dcf81_b'
       AND indexname = 'uq_erp_batches_product_no'
       AND indexdef ILIKE '%tenant_id%' AND indexdef ILIKE '%product_id%'
       AND indexdef ILIKE '%batch_no%' AND indexdef ILIKE '%is_deleted%';
    IF COALESCE(v_n, 0) <> 1 THEN
      v_missing := v_missing || 'erp_batches 缺 (tenant_id, product_id, batch_no) 部分唯一索引（deploy_107 的 ON CONFLICT 依赖它）;';
    END IF;

    -- 7.3 批次号规范化 CHECK（否则永远匹配不上库存行）
    SELECT count(*) INTO v_n FROM pg_constraint
     WHERE conrelid = 'public.erp_batches_s_539dcf81_b'::regclass
       AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%BTRIM%';
    IF COALESCE(v_n, 0) = 0 THEN
      v_missing := v_missing || 'erp_batches 缺批次号 BTRIM 规范化 CHECK;';
    END IF;
  END IF;

  -- 7.4 物料上的批次开关
  SELECT count(*) INTO v_n
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'erp_products_s_539dcf81_b'
     AND column_name = 'is_batch_managed' AND is_nullable = 'NO'
     AND column_default ILIKE '%false%';
  IF COALESCE(v_n, 0) <> 1 THEN
    v_missing := v_missing || 'erp_products 缺 is_batch_managed BOOLEAN NOT NULL DEFAULT FALSE;';
  END IF;

  SELECT count(*) INTO v_n
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'erp_products_s_539dcf81_b'
     AND column_name = 'shelf_life_days';
  IF COALESCE(v_n, 0) <> 1 THEN
    v_missing := v_missing || 'erp_products 缺 shelf_life_days;';
  END IF;

  -- 7.5 单据类型
  SELECT count(*) INTO v_n FROM public.sys_document_types
   WHERE is_deleted = 'n' AND document_type = 'batch'
     AND naming_rule = 'LOT{YYYY}{MM}{####}';
  IF COALESCE(v_n, 0) <> 1 THEN
    v_missing := v_missing || '缺 batch 单据类型（LOT{YYYY}{MM}{####}）;';
  END IF;

  -- 7.6 基线菜单 + 角色授权
  SELECT count(*) INTO v_n FROM public.sys_menus
   WHERE tenant_id IS NULL AND is_deleted = 'n' AND menu_code = ANY (v_menu);
  IF COALESCE(v_n, 0) <> 2 THEN
    v_missing := v_missing || format('基线菜单只到 %s/2;', v_n);
  END IF;

  SELECT count(*) INTO v_n
    FROM public.sys_role_menus rm
    JOIN public.sys_menus m ON m.id = rm.menu_id
   WHERE rm.is_deleted = 'n' AND m.menu_code = ANY (v_menu);
  IF COALESCE(v_n, 0) < 6 THEN
    v_missing := v_missing || format('基线菜单角色授权只有 %s 条（应 ≥6）;', v_n);
  END IF;

  -- 7.7 已物化租户必须有菜单副本（否则该租户看不到入口）
  FOR v_tenant IN
    SELECT id FROM public.sys_tenants
     WHERE COALESCE(is_deleted, 'n') = 'n' AND COALESCE(metadata_materialized, FALSE)
  LOOP
    SELECT count(*) INTO v_n FROM public.sys_menus
     WHERE tenant_id = v_tenant.id AND is_deleted = 'n' AND menu_code = ANY (v_menu);
    IF COALESCE(v_n, 0) <> 2 THEN
      v_missing := v_missing || format('已物化租户%s的菜单副本只有 %s/2;', v_tenant.id, v_n);
    END IF;
  END LOOP;

  IF v_missing <> '' THEN
    RAISE EXCEPTION 'deploy_106 自检失败：%', v_missing;
  END IF;

  RAISE NOTICE 'deploy_106 OK：批次主数据 1 表 / 物料 2 属性 / 1 DocType / 2 菜单 齐备';
END;
$$;
