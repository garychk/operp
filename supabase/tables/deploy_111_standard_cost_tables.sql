-- ============================================================================
-- P0-3：标准成本（表结构与配置）
-- ============================================================================
--
-- 补的是差距评估文档 §K（成本核算）里最硬的一格：**全库没有「标准成本」概念**。
--   * `erp_cost_calculations` 只有**实际**成本（按月 × 产品，料/工/费 + 期末在制）
--   * `erp_products.cost_price` 是物料的一个**参考价**，不是「产品的标准制造成本」
--   * 结论：算不出「材料价差 / 量差 / 人工差 / 制费差」——这是客户验收
--     标准成本法时的第一句话，也是本项目此前唯一一块**完全空白**的核算能力。
--
-- ---------------------------------------------------------------------------
-- 设计要点
-- ---------------------------------------------------------------------------
-- 1. 标准成本是「产品 × 版本」，不是「产品」
--    标准成本一旦生效就是**绩效基准**：基准不能就地改，否则上个月的差异
--    今天会被改写成另一个数（审计不可复现）。所以：
--      * 同一产品可存多个版本（V1 / V2 / 2026Q2 ...），
--      * `(tenant_id, product_id) WHERE status='active'` 是**部分唯一索引**
--        —— 任一时刻每个产品**至多一个**生效版本；
--      * 卷算 RPC 拒绝覆盖 `active` 行，要求先建新版本（见 deploy_112）。
--
-- 2. 标准单价取自 `erp_products.cost_price`（物料标准价），不是移动加权
--    移动加权是**实际**价（而且每月都在变）；拿它当标准价，价差恒为 0，
--    这张表就没有意义。`cost_price` 是物料主数据上的「标准/计划价」字段，
--    由计划或成本会计维护 —— 口径写进注释，避免后人换成实际价。
--
-- 3. `standard_quantity` 存**已含损耗**的毛用量
--    卷算时写入 `BOM 用量 × (1 + 损耗率)`。理由：量差公式
--    `(实际用量 − 标准用量) × 标准单价` 只要一个用量口径；若这里存净用量、
--    金额再乘一次损耗，视图里就必须记得再乘一次 —— 漏一处就静默算错。
--    `loss_rate` 列只做**来源快照**（展示与追溯），**不参与金额计算**，
--    与 deploy_106 `shelf_life_days`「辅助字段，不做隐式推算」同一处理方式。
--
-- 4. `standard_total_cost` / `standard_amount` 用**生成列**（STORED）
--    合计恒等于三个要素之和是这张表的核心不变量；用生成列而不是触发器，
--    就不会出现「有人只更新了材料成本、忘了更新合计」的漂移。
--    前端与 RPC 一律**只写要素列**，合计自动跟随。
--
-- 5. 明细行与表头**同租户**由外键强制
--    `(standard_cost_id, tenant_id)` 复合外键指向表头的 `(id, tenant_id)`
--    唯一索引。单列外键挡不住「A 租户的表头 + B 租户的明细」这种跨租户串行
--    —— RLS 只校验本行 tenant_id，不校验被引用的那一行。
--
-- 6. 顺带补齐 `erp_batches` 的表权限（deploy_106 的遗漏）
--    deploy_106 建了批次表却没写 sys_role_table_permissions，于是
--    `has_table_permission` 恒为 FALSE：除超管外**任何人都读不到批次**
--    （租户管理员打开批次管理页是空的，批次建档 RPC 也会被 RLS 拒）。
--    这里一并补上，避免批次功能对非超管形同虚设。
--
-- 本脚本由 000_run_all 用 psql --single-transaction 执行，**不要写 BEGIN/COMMIT**。
-- 依赖：deploy_01（erp_products / erp_boms / erp_routing_operations）、
--       deploy_02（refresh_sys_tables）、deploy_32（单据编号）、
--       deploy_41（install_role_table_rls）、deploy_52（clone_platform_baseline_to_tenant）。
-- ============================================================================


-- ============================================================================
-- 1. 标准成本表头
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.erp_standard_costs_s_539dcf81_b (
  id SERIAL PRIMARY KEY,
  corp_id VARCHAR(128),
  emp_id VARCHAR(128),
  is_deleted CHAR(1) NOT NULL DEFAULT 'n',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- 编号：走 generate_document_no('standard_cost')，与其余主数据/单据一致
  standard_cost_no VARCHAR(50) NOT NULL,
  product_id INTEGER NOT NULL REFERENCES public.erp_products_s_539dcf81_b(id),
  -- 版本号：同一产品可并存多个版本，任一时刻只有一个 active
  version VARCHAR(30) NOT NULL DEFAULT 'V1'
    CHECK (BTRIM(version) <> ''),
  effective_date DATE NOT NULL DEFAULT CURRENT_DATE,
  -- draft     = 编制中（可被卷算覆盖）
  -- active    = 生效（差异分析的基准，卷算不得覆盖）
  -- inactive  = 已停用（历史版本，保留可查）
  status VARCHAR(20) NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'active', 'inactive')),
  -- 单位标准成本三要素（本位币）。写这三个，合计自动跟随。
  standard_material_cost NUMERIC(18, 6) NOT NULL DEFAULT 0
    CHECK (standard_material_cost >= 0),
  standard_labor_cost NUMERIC(18, 6) NOT NULL DEFAULT 0
    CHECK (standard_labor_cost >= 0),
  standard_overhead_cost NUMERIC(18, 6) NOT NULL DEFAULT 0
    CHECK (standard_overhead_cost >= 0),
  standard_total_cost NUMERIC(18, 6) NOT NULL
    GENERATED ALWAYS AS (
      standard_material_cost + standard_labor_cost + standard_overhead_cost
    ) STORED,
  -- 来源：手工录入 / 由 BOM+工艺路线卷算（deploy_112 的 rollup_standard_cost）
  source VARCHAR(20) NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual', 'bom_rollup')),
  bom_id INTEGER REFERENCES public.erp_boms_s_539dcf81_b(id),
  routing_id INTEGER REFERENCES public.erp_routing_operations_s_539dcf81_b(id),
  remark TEXT,
  created_by INTEGER,
  tenant_id BIGINT NOT NULL DEFAULT public.current_tenant_id()
);

-- 明细行的复合外键要指向它（见第 2 节）
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_standard_costs_id_tenant
  ON public.erp_standard_costs_s_539dcf81_b (id, tenant_id);

CREATE INDEX IF NOT EXISTS idx_erp_standard_costs_tenant
  ON public.erp_standard_costs_s_539dcf81_b (tenant_id);
CREATE INDEX IF NOT EXISTS idx_erp_standard_costs_product
  ON public.erp_standard_costs_s_539dcf81_b (tenant_id, product_id)
  WHERE is_deleted = 'n';

-- 同一产品同一版本只能有一行（软删后允许复用版本号）
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_standard_costs_product_version
  ON public.erp_standard_costs_s_539dcf81_b (tenant_id, product_id, version)
  WHERE is_deleted = 'n';

-- ⚠️ 每产品至多一个**生效**版本。差异分析靠它唯一确定基准，
--    没有这条约束就会出现「同一工单匹配到两个标准成本」的静默错算。
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_standard_costs_active
  ON public.erp_standard_costs_s_539dcf81_b (tenant_id, product_id)
  WHERE is_deleted = 'n' AND status = 'active';

COMMENT ON TABLE public.erp_standard_costs_s_539dcf81_b IS
  '标准成本（产品 × 版本）：成本差异分析的基准。合计为生成列，只维护材料/人工/制费三个要素。';
COMMENT ON COLUMN public.erp_standard_costs_s_539dcf81_b.version IS
  '版本号。标准成本一旦生效即为绩效基准，不得就地修改 —— 变更请新建版本并停用旧版本。';
COMMENT ON COLUMN public.erp_standard_costs_s_539dcf81_b.status IS
  'draft=编制中（可被卷算覆盖）；active=生效（每产品至多一个，见部分唯一索引）；inactive=已停用。';
COMMENT ON COLUMN public.erp_standard_costs_s_539dcf81_b.standard_material_cost IS
  '单位标准材料成本。标准单价口径 = erp_products.cost_price（物料标准价），不是移动加权实际价。';
COMMENT ON COLUMN public.erp_standard_costs_s_539dcf81_b.standard_total_cost IS
  '生成列：材料 + 人工 + 制费。请勿直接 UPDATE，只写三个要素列。';


-- ============================================================================
-- 2. 标准成本材料明细（差异分析里「量差」的依据）
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.erp_standard_cost_materials_s_539dcf81_b (
  id SERIAL PRIMARY KEY,
  corp_id VARCHAR(128),
  emp_id VARCHAR(128),
  is_deleted CHAR(1) NOT NULL DEFAULT 'n',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  standard_cost_id INTEGER NOT NULL,
  line_no INTEGER NOT NULL DEFAULT 1,
  material_id INTEGER NOT NULL REFERENCES public.erp_products_s_539dcf81_b(id),
  -- 单位成品的标准耗用量，**已含损耗**（卷算时 = BOM 用量 × (1+损耗率)）
  standard_quantity NUMERIC(18, 6) NOT NULL DEFAULT 0
    CHECK (standard_quantity >= 0),
  -- 来源 BOM 的损耗率快照：**仅记录，不参与金额计算**（用量已含损耗，再乘一次就是重复）
  loss_rate NUMERIC(5, 4) NOT NULL DEFAULT 0
    CHECK (loss_rate >= 0),
  -- 标准单价（本位币）：取自 erp_products.cost_price
  standard_price NUMERIC(18, 6) NOT NULL DEFAULT 0
    CHECK (standard_price >= 0),
  standard_amount NUMERIC(18, 6) NOT NULL
    GENERATED ALWAYS AS (ROUND(standard_quantity * standard_price, 6)) STORED,
  remark TEXT,
  tenant_id BIGINT NOT NULL DEFAULT public.current_tenant_id(),
  -- 明细必须与表头同租户（单列外键挡不住跨租户串行）
  CONSTRAINT fk_erp_standard_cost_materials_header
    FOREIGN KEY (standard_cost_id, tenant_id)
    REFERENCES public.erp_standard_costs_s_539dcf81_b (id, tenant_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_erp_standard_cost_materials_tenant
  ON public.erp_standard_cost_materials_s_539dcf81_b (tenant_id);
CREATE INDEX IF NOT EXISTS idx_erp_standard_cost_materials_header
  ON public.erp_standard_cost_materials_s_539dcf81_b (tenant_id, standard_cost_id)
  WHERE is_deleted = 'n';

CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_standard_cost_materials_line
  ON public.erp_standard_cost_materials_s_539dcf81_b (tenant_id, standard_cost_id, material_id)
  WHERE is_deleted = 'n';

COMMENT ON TABLE public.erp_standard_cost_materials_s_539dcf81_b IS
  '标准成本材料明细：差异分析的「量差」基准（标准用量 = 单位用量 × 完工数量）。';
COMMENT ON COLUMN public.erp_standard_cost_materials_s_539dcf81_b.standard_quantity IS
  '单位成品标准耗用量，已含损耗。卷算写入 BOM 用量 × (1+损耗率)；手册维护时直接填毛用量。';
COMMENT ON COLUMN public.erp_standard_cost_materials_s_539dcf81_b.loss_rate IS
  '来源 BOM 的损耗率快照，仅用于展示与追溯，不参与金额计算（用量已含损耗）。';


-- ============================================================================
-- 3. 权限与 RLS（fail-closed，与其余 erp_* 一致）
-- ============================================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON public.erp_standard_costs_s_539dcf81_b TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.erp_standard_costs_s_539dcf81_b_id_seq TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.erp_standard_cost_materials_s_539dcf81_b TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.erp_standard_cost_materials_s_539dcf81_b_id_seq TO authenticated;

SELECT public.install_role_table_rls('erp_standard_costs_s_539dcf81_b');
SELECT public.install_role_table_rls('erp_standard_cost_materials_s_539dcf81_b');

-- 注册到 sys_tables（第 4 节的授权要靠它）
SELECT public.refresh_sys_tables();


-- ============================================================================
-- 4. 基线角色授权（sys_role_table_permissions）
--    新表不会自动获得授权 —— 没有这张表里的行，has_table_permission 恒为 FALSE，
--    除超管外所有人都读不到、也写不进。漏掉是**静默失败**，故第 6 节自检。
-- ============================================================================
INSERT INTO public.sys_role_table_permissions
  (role_id, table_id, can_select, can_insert, can_update, can_delete, is_deleted, tenant_id)
SELECT r.id, t.id, TRUE, TRUE, TRUE, TRUE, 'n', NULL
FROM public.sys_roles r
CROSS JOIN public.sys_tables t
WHERE r.tenant_id IS NULL
  AND COALESCE(r.is_deleted, 'n') = 'n'
  AND r.role_code IN ('super_admin', 'tenant_admin', 'mrp_manager')
  AND t.table_name IN (
    'erp_standard_costs_s_539dcf81_b',
    'erp_standard_cost_materials_s_539dcf81_b',
    -- deploy_106 遗漏：批次表当时没授权，非超管直接看不到批次
    'erp_batches_s_539dcf81_b'
  )
  AND COALESCE(t.is_deleted, 'n') = 'n'
  AND NOT EXISTS (
    SELECT 1 FROM public.sys_role_table_permissions rp
    WHERE rp.role_id = r.id AND rp.table_id = t.id
      AND rp.tenant_id IS NULL AND COALESCE(rp.is_deleted, 'n') = 'n'
  );

-- 给已物化租户补差（基线授权对已物化租户不可见，不补差 → 租户管理员无权限）
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


-- ============================================================================
-- 5. 单据类型（标准成本编号规则）
--    标准成本不走审批、不产凭证，注册它的唯一目的是让编号走统一的
--    generate_document_no('standard_cost') —— 与 deploy_106 的 `batch` 同理。
-- ============================================================================
INSERT INTO public.sys_document_types (
  document_type, document_name, primary_key_field, module_code, route_path,
  table_name, naming_rule, is_submittable, status, sort_order, is_deleted
)
VALUES
  ('standard_cost', '标准成本', 'id', 'mrp', '/mrp/cost-calculations',
   'erp_standard_costs_s_539dcf81_b', 'STD{YYYY}{MM}{####}', FALSE, '1', 44, 'n')
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
-- 6. 自检（fail-loud）
-- ============================================================================
DO $$
DECLARE
  v_missing TEXT := '';
  v_n       INTEGER;
  v_tenant  RECORD;
  v_tables  CONSTANT TEXT[] := ARRAY[
    'erp_standard_costs_s_539dcf81_b',
    'erp_standard_cost_materials_s_539dcf81_b'
  ];
  v_tbl     TEXT;
BEGIN
  -- 6.1 两张表：存在 / RLS ≥4 / tenant_id NOT NULL
  FOREACH v_tbl IN ARRAY v_tables LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = v_tbl AND c.relkind = 'r'
    ) THEN
      v_missing := v_missing || format('缺表 %s;', v_tbl);
      CONTINUE;
    END IF;

    SELECT count(*) INTO v_n FROM pg_policies
     WHERE schemaname = 'public' AND tablename = v_tbl;
    IF COALESCE(v_n, 0) < 4 THEN
      v_missing := v_missing || format('%s 的 RLS 策略只有 %s 条（应 ≥4）;', v_tbl, v_n);
    END IF;

    SELECT count(*) INTO v_n
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = v_tbl
       AND column_name = 'tenant_id' AND is_nullable = 'NO';
    IF COALESCE(v_n, 0) <> 1 THEN
      v_missing := v_missing || format('%s 缺 tenant_id NOT NULL;', v_tbl);
    END IF;
  END LOOP;

  -- 6.2 生成列必须在（合计/金额不能被"顺手"改成普通列）
  SELECT count(*) INTO v_n
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'erp_standard_costs_s_539dcf81_b'
     AND column_name = 'standard_total_cost' AND is_generated = 'ALWAYS';
  IF COALESCE(v_n, 0) <> 1 THEN
    v_missing := v_missing || 'erp_standard_costs 缺 standard_total_cost 生成列;';
  END IF;

  SELECT count(*) INTO v_n
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'erp_standard_cost_materials_s_539dcf81_b'
     AND column_name = 'standard_amount' AND is_generated = 'ALWAYS';
  IF COALESCE(v_n, 0) <> 1 THEN
    v_missing := v_missing || 'erp_standard_cost_materials 缺 standard_amount 生成列;';
  END IF;

  -- 6.3 关键唯一索引
  SELECT count(*) INTO v_n FROM pg_indexes
   WHERE schemaname = 'public' AND tablename = 'erp_standard_costs_s_539dcf81_b'
     AND indexname = 'uq_erp_standard_costs_active'
     AND indexdef ILIKE '%status%active%';
  IF COALESCE(v_n, 0) <> 1 THEN
    v_missing := v_missing || '缺「每产品至多一个 active 版本」部分唯一索引;';
  END IF;

  SELECT count(*) INTO v_n FROM pg_indexes
   WHERE schemaname = 'public' AND tablename = 'erp_standard_costs_s_539dcf81_b'
     AND indexname = 'uq_erp_standard_costs_product_version';
  IF COALESCE(v_n, 0) <> 1 THEN
    v_missing := v_missing || '缺 (tenant_id, product_id, version) 唯一索引;';
  END IF;

  -- 6.4 明细→表头的复合外键（同租户强制）
  SELECT count(*) INTO v_n FROM pg_constraint
   WHERE conname = 'fk_erp_standard_cost_materials_header'
     AND conrelid = 'public.erp_standard_cost_materials_s_539dcf81_b'::regclass
     AND pg_get_constraintdef(oid) ILIKE '%standard_cost_id%'
     AND pg_get_constraintdef(oid) ILIKE '%tenant_id%';
  IF COALESCE(v_n, 0) <> 1 THEN
    v_missing := v_missing || '标准成本明细缺 (standard_cost_id, tenant_id) 复合外键;';
  END IF;

  -- 6.5 基线授权：3 个角色 × 3 张表 = 9 行
  SELECT count(*) INTO v_n
    FROM public.sys_role_table_permissions rp
    JOIN public.sys_roles r ON r.id = rp.role_id
    JOIN public.sys_tables t ON t.id = rp.table_id
   WHERE rp.tenant_id IS NULL AND COALESCE(rp.is_deleted, 'n') = 'n'
     AND r.tenant_id IS NULL AND COALESCE(r.is_deleted, 'n') = 'n'
     AND r.role_code IN ('super_admin', 'tenant_admin', 'mrp_manager')
     AND t.table_name = ANY (v_tables || ARRAY['erp_batches_s_539dcf81_b']);
  IF COALESCE(v_n, 0) < 9 THEN
    v_missing := v_missing || format('基线表权限只有 %s 行（期望 9 = 3 角色 × 3 表）;', v_n);
  END IF;

  -- 6.6 已物化租户必须有授权副本（否则该租户管理员看不到标准成本）
  FOR v_tenant IN
    SELECT id FROM public.sys_tenants
     WHERE COALESCE(is_deleted, 'n') = 'n' AND COALESCE(metadata_materialized, FALSE)
  LOOP
    SELECT count(*) INTO v_n
      FROM public.sys_role_table_permissions rp
      JOIN public.sys_tables t ON t.id = rp.table_id
     WHERE rp.tenant_id = v_tenant.id AND COALESCE(rp.is_deleted, 'n') = 'n'
       AND t.table_name = ANY (v_tables);
    IF COALESCE(v_n, 0) < 3 THEN
      v_missing := v_missing || format('已物化租户%s的授权副本只有 %s/3;', v_tenant.id, v_n);
    END IF;
  END LOOP;

  -- 6.7 单据类型
  SELECT count(*) INTO v_n FROM public.sys_document_types
   WHERE is_deleted = 'n' AND document_type = 'standard_cost'
     AND naming_rule = 'STD{YYYY}{MM}{####}';
  IF COALESCE(v_n, 0) <> 1 THEN
    v_missing := v_missing || '缺 standard_cost 单据类型（STD{YYYY}{MM}{####}）;';
  END IF;

  IF v_missing <> '' THEN
    RAISE EXCEPTION 'deploy_111 自检失败：%', v_missing;
  END IF;

  RAISE NOTICE 'deploy_111 OK：标准成本 2 表 / 生成列 / 复合外键 / 基线授权（含补齐 erp_batches）/ 1 DocType 齐备';
END;
$$;
