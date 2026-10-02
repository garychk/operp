-- ============================================================================
-- deploy_57：阶段 2 —— BOM 展开与齐套分析
--
-- 背景
-- ----
-- 阶段 1（deploy_56）把生产单据的过账闭环堵上了：领料单/完工入库单现在会真的
-- 写 erp_inventory_transactions、真的动 erp_inventory。但上游仍是空的：
--   - erp_production_order_details 从来没人写过（生产订单选了 BOM 不会带出组件）
--   - erp_material_issues 只能手工录明细，跟生产订单对不上账
--   - 没有齐套分析，车间无法回答「这批料够不够开工」
--
-- 本脚本做什么
-- ------------
--   1. erp_production_orders 补 warehouse_id（领料仓库，BOM 展开与齐套的默认取数仓）
--   2. erp_material_issue_details 补 order_detail_id（接上流转台账的源行引用）
--   3. doc_flow_rules 补 production_order -> material_issue 规则与字段映射
--   4. erp_material_issue_details 挂「流转台账」触发器（手工录入的行与下推生成的行
--      走同一条记账路径，这是 deploy_36 的既有范式）
--   5. explode_production_order_bom()        —— 按 BOM 展开写入生产订单明细
--   6. production_kit_check()                —— 齐套分析（需求/已领/待领/可用/缺口）
--   7. generate_material_issue_from_order()  —— 由生产订单生成领料单（复用流转引擎）
--   8. pull_order_lines_into_issue()         —— 把订单未领的料带进已有领料单
--
-- 关键设计
-- --------
--   * BOM 用量 = 订单计划量 × (BOM 行用量 ÷ BOM 基础数量) × (1 + 损耗率)。
--     分母是 erp_boms.quantity（BOM 基础数量），不除掉它会把「每 100 件用料」
--     的 BOM 当成「每件用料」，这是 MRP 展开最常见的错。
--   * BOM 版本选择：订单显式指定优先；否则按 is_active + 有效期(order_date) +
--     is_default desc + version desc 取。选中后回写 order.bom_id，界面上看得见。
--   * 齐套分析按「物料」聚合，不按订单行。同一物料在 BOM 里出现多次（不同工序）
--     时，按行给可用量会把同一批库存重复算两遍，那是假齐套。
--   * 已领料（issued_quantity > 0）或台账里已挂源行时，拒绝重新展开 —— 源行被
--     换掉会让已发生的转换变成孤儿，账就对不上了。
--   * 领料单的成本口径在生成时补：出库仍以库存移动加权单价为准（deploy_56），
--     这里的 unit_cost 只是兜底与展示。
--
-- 刻意不做（本阶段）
-- ----------------
--   * 未加生产订单/领料单的审批流。wf_process_nodes.approver_role_code 是「谁能
--     操作」的硬门槛，节点角色持有人之外的人连提交都点不了。当前 admin 只有
--     super_admin / tenant_admin，mrp_manager 又缺生产类表的权限，配上去会得到
--     一条谁也走不完的流程。要加，先定「谁审批」+ 补 mrp_manager 的表权限。
--   * 库位化领料不在本阶段（见 deploy_56 的已知边界）。
--
-- 依赖：deploy_13/34（流转与过账范式）、deploy_35/36（流转引擎与台账触发器）、
--       deploy_41/48（tenant_id 与基线可见性）、deploy_56（过账）
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. 生产订单补领料仓库
--    标准 ERP 里生产订单必须声明从哪个仓发料：BOM 展开、齐套分析、生成领料单
--    都以它为默认值。行级 erp_production_order_details.warehouse_id 保留为覆盖位。
-- ----------------------------------------------------------------------------
ALTER TABLE public.erp_production_orders_s_539dcf81_b
  ADD COLUMN IF NOT EXISTS warehouse_id INTEGER
    REFERENCES public.erp_warehouses_s_539dcf81_b(id);

CREATE INDEX IF NOT EXISTS idx_erp_production_orders_warehouse_id
  ON public.erp_production_orders_s_539dcf81_b(warehouse_id);


-- ----------------------------------------------------------------------------
-- 2. 领料明细补来源生产订单行
--    doc_flow_rules.target_source_ref_field 指向它；有了它，流转台账才能知道
--    「这张领料单的这行扣的是哪一条物料需求」，从而回写 issued_quantity。
-- ----------------------------------------------------------------------------
ALTER TABLE public.erp_material_issue_details_s_539dcf81_b
  ADD COLUMN IF NOT EXISTS order_detail_id INTEGER
    REFERENCES public.erp_production_order_details_s_539dcf81_b(id);

CREATE INDEX IF NOT EXISTS idx_erp_material_issue_details_order_detail_id
  ON public.erp_material_issue_details_s_539dcf81_b(order_detail_id);


-- ----------------------------------------------------------------------------
-- 3. 流转规则：生产订单 -> 生产领料单
--    source_quantity_field 取明细表的 planned_quantity（已含损耗率的物料需求），
--    所以「已领多少」天然由台账推算，支持分次领料。
--
--    allowed_source_statuses 刻意宽松：只挡「已完成/已关闭/已取消/审批中」。
--    在推进「让流程跑起来」的阶段不宜顺手收紧成「必须 approved」——那会把
--    所有现存的 draft 生产订单变成不可领料。要加审批门槛，改这一行即可：
--      UPDATE doc_flow_rules SET allowed_source_statuses = ARRAY['approved']
--       WHERE rule_code = 'production_order_to_material_issue';
--
--    ⚠️ 冲突目标必须带 WHERE tenant_id IS NULL：
--    deploy_48/51 把 doc_flow_rules.rule_code 的普通 UNIQUE 约束换成了两个
--    部分唯一索引（uq_doc_flow_rules_rule_code_global / _tenant），
--    不写谓词的 ON CONFLICT (rule_code) 会报「no unique or exclusion constraint
--    matching the ON CONFLICT specification」。
--    （顺带一提：deploy_35/36 里那些老的 ON CONFLICT (rule_code) 现在也是这个
--      状态，全量重跑没问题——35 排在 48 之前——但单独重跑老脚本会失败。）
-- ----------------------------------------------------------------------------
INSERT INTO public.doc_flow_rules (
  rule_code, rule_name, source_document_type, target_document_type,
  source_quantity_field, target_quantity_field,
  source_detail_key_field, target_source_ref_field,
  source_detail_parent_field, target_no_field, target_detail_parent_field,
  target_unit_price_field, target_line_amount_field, target_total_amount_field,
  recalc_line_amount, sync_header_total, allowed_source_statuses,
  target_initial_status, allow_partial, require_source_approved, description
)
VALUES (
  'production_order_to_material_issue', '生产订单生成生产领料单',
  'production_order', 'material_issue',
  'planned_quantity', 'quantity',
  'id', 'order_detail_id',
  'order_id', 'issue_no', 'issue_id',
  'unit_cost', 'amount', 'total_amount',
  TRUE, TRUE, ARRAY['draft', 'approved', 'released', 'in_progress'],
  'draft', TRUE, TRUE,
  '按生产订单已展开的物料需求（含损耗率）生成领料单，支持分次领料'
)
ON CONFLICT (rule_code) WHERE tenant_id IS NULL DO UPDATE SET
  rule_name = EXCLUDED.rule_name,
  source_document_type = EXCLUDED.source_document_type,
  target_document_type = EXCLUDED.target_document_type,
  source_quantity_field = EXCLUDED.source_quantity_field,
  target_quantity_field = EXCLUDED.target_quantity_field,
  source_detail_key_field = EXCLUDED.source_detail_key_field,
  target_source_ref_field = EXCLUDED.target_source_ref_field,
  source_detail_parent_field = EXCLUDED.source_detail_parent_field,
  target_no_field = EXCLUDED.target_no_field,
  target_detail_parent_field = EXCLUDED.target_detail_parent_field,
  target_unit_price_field = EXCLUDED.target_unit_price_field,
  target_line_amount_field = EXCLUDED.target_line_amount_field,
  target_total_amount_field = EXCLUDED.target_total_amount_field,
  recalc_line_amount = EXCLUDED.recalc_line_amount,
  sync_header_total = EXCLUDED.sync_header_total,
  allowed_source_statuses = EXCLUDED.allowed_source_statuses,
  target_initial_status = EXCLUDED.target_initial_status,
  allow_partial = EXCLUDED.allow_partial,
  require_source_approved = EXCLUDED.require_source_approved,
  description = EXCLUDED.description,
  is_active = TRUE,
  is_deleted = 'n',
  updated_at = NOW();

INSERT INTO public.doc_flow_field_maps (
  rule_id, map_level, target_field, source_type, source_field,
  const_value, sequence_no
)
SELECT r.id, x.map_level, x.target_field, x.source_type, x.source_field,
       x.const_value, x.sequence_no
FROM public.doc_flow_rules r
CROSS JOIN (VALUES
  ('header', 'issue_date',          'sys',   'today',         NULL, 10),
  ('header', 'production_order_id', 'sys',   'source_id',     NULL, 20),
  ('header', 'warehouse_id',        'field', 'warehouse_id',  NULL, 30),
  ('header', 'remark',              'field', 'remark',        NULL, 40),
  ('line',   'order_detail_id',     'field', 'id',            NULL, 10),
  ('line',   'material_id',         'field', 'material_id',   NULL, 20),
  ('line',   'quantity',            'field', 'planned_quantity', NULL, 30),
  ('line',   'remark',              'field', 'remark',        NULL, 40)
) AS x(map_level, target_field, source_type, source_field, const_value, sequence_no)
WHERE r.rule_code = 'production_order_to_material_issue'
ON CONFLICT (rule_id, map_level, target_field) DO NOTHING;


-- ----------------------------------------------------------------------------
-- 4. 领料明细挂流转台账触发器
--    deploy_36 的 doc_flow_ledger_on_target_detail 是通用的，靠表名反查规则；
--    挂上去之后，手工录入的行（带 order_detail_id）与下推生成的行走同一条路径。
-- ----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_doc_flow_material_issue_detail_ledger
  ON public.erp_material_issue_details_s_539dcf81_b;
CREATE TRIGGER trg_doc_flow_material_issue_detail_ledger
AFTER INSERT OR UPDATE OR DELETE
ON public.erp_material_issue_details_s_539dcf81_b
FOR EACH ROW EXECUTE FUNCTION public.doc_flow_ledger_on_target_detail();


-- ----------------------------------------------------------------------------
-- 5. BOM 展开
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.explode_production_order_bom(
  p_order_id INTEGER,
  p_replace BOOLEAN DEFAULT TRUE
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_order RECORD;
  v_bom RECORD;
  v_bom_id INTEGER;
  v_issued NUMERIC;
  v_line_count INTEGER := 0;
BEGIN
  IF p_order_id IS NULL OR p_order_id <= 0 THEN
    RAISE EXCEPTION 'A positive production order id is required'
      USING ERRCODE = '22023';
  END IF;

  SELECT x.* INTO v_order
  FROM public.erp_production_orders_s_539dcf81_b x
  WHERE x.id = p_order_id AND x.is_deleted = 'n'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Production order does not exist or is deleted'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_order.product_id IS NULL THEN
    RAISE EXCEPTION 'Production order % has no finished product', p_order_id
      USING ERRCODE = '23502';
  END IF;

  IF COALESCE(v_order.status, '') IN ('completed', 'closed', 'cancelled') THEN
    RAISE EXCEPTION 'Cannot explode BOM for a production order in status %',
      v_order.status USING ERRCODE = '55000';
  END IF;

  -- 已经发生过领料就不能重新展开：明细行会被换掉，已挂台账的转换会变成孤儿
  SELECT COALESCE(SUM(COALESCE(d.issued_quantity, 0)), 0)
  INTO v_issued
  FROM public.erp_production_order_details_s_539dcf81_b d
  WHERE d.order_id = p_order_id AND d.is_deleted = 'n';
  IF v_issued > 0 THEN
    RAISE EXCEPTION
      'Production order already has issued materials (%); reverse the material issues first',
      v_issued USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.doc_flow_transfers t
    JOIN public.erp_production_order_details_s_539dcf81_b d
      ON d.id = t.source_detail_id
    WHERE d.order_id = p_order_id AND t.is_deleted = 'n'
  ) THEN
    RAISE EXCEPTION
      'Production order material lines are already linked to downstream documents'
      USING ERRCODE = '55000';
  END IF;

  -- BOM 版本解析：显式指定优先，否则按产品 + 有效期取默认版本
  v_bom_id := v_order.bom_id;
  IF v_bom_id IS NULL THEN
    SELECT b.id INTO v_bom_id
    FROM public.erp_boms_s_539dcf81_b b
    WHERE b.product_id = v_order.product_id
      AND b.is_deleted = 'n'
      AND COALESCE(b.is_active, TRUE)
      AND COALESCE(b.effective_date, DATE '1900-01-01') <= v_order.order_date
      AND (b.expiry_date IS NULL OR b.expiry_date >= v_order.order_date)
    ORDER BY COALESCE(b.is_default, FALSE) DESC, b.version DESC, b.id DESC
    LIMIT 1;
  END IF;
  IF v_bom_id IS NULL THEN
    RAISE EXCEPTION 'No active BOM found for product % on %',
      v_order.product_id, v_order.order_date USING ERRCODE = 'P0002';
  END IF;

  SELECT b.* INTO v_bom
  FROM public.erp_boms_s_539dcf81_b b
  WHERE b.id = v_bom_id AND b.is_deleted = 'n';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'BOM % does not exist or is deleted', v_bom_id
      USING ERRCODE = 'P0002';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.erp_bom_details_s_539dcf81_b d
    WHERE d.bom_id = v_bom_id AND d.is_deleted = 'n' AND d.material_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'BOM % has no usable component lines', v_bom_id
      USING ERRCODE = '23514';
  END IF;

  IF p_replace THEN
    UPDATE public.erp_production_order_details_s_539dcf81_b
    SET is_deleted = 'y', updated_at = NOW()
    WHERE order_id = p_order_id AND is_deleted = 'n';
  END IF;

  INSERT INTO public.erp_production_order_details_s_539dcf81_b (
    corp_id, emp_id, is_deleted, order_id, line_no, material_id,
    planned_quantity, issued_quantity, unit, warehouse_id, remark, tenant_id
  )
  SELECT
    v_order.corp_id,
    public.current_sys_user_id()::TEXT,
    'n',
    p_order_id,
    ROW_NUMBER() OVER (ORDER BY d.line_no, d.id),
    d.material_id,
    ROUND(
      COALESCE(v_order.planned_quantity, 0)
      * COALESCE(d.quantity, 0)
      / NULLIF(COALESCE(NULLIF(v_bom.quantity, 0), 1), 0)
      * (1 + COALESCE(d.loss_rate, 0)),
      4),
    0,
    COALESCE(d.unit, p.unit),
    v_order.warehouse_id,
    format('BOM %s v%s 行 %s', v_bom.bom_no, v_bom.version, d.line_no),
    -- ⚠️ 必须显式带 tenant_id：该列默认值是 current_tenant_id()，依赖 JWT 上下文，
    --    由 service_role（ai-server 转单）调用时会取到 NULL 而整批失败。
    v_order.tenant_id
  FROM public.erp_bom_details_s_539dcf81_b d
  LEFT JOIN public.erp_products_s_539dcf81_b p ON p.id = d.material_id
  WHERE d.bom_id = v_bom_id
    AND d.is_deleted = 'n'
    AND d.material_id IS NOT NULL;

  GET DIAGNOSTICS v_line_count = ROW_COUNT;

  -- 解析出来的 BOM 回写到订单，界面上能看到实际用了哪一版
  IF v_order.bom_id IS NULL THEN
    UPDATE public.erp_production_orders_s_539dcf81_b
    SET bom_id = v_bom_id, updated_at = NOW()
    WHERE id = p_order_id;
  END IF;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'order_id', p_order_id,
    'bom_id', v_bom_id,
    'bom_no', v_bom.bom_no,
    'bom_version', v_bom.version,
    'line_count', v_line_count);
END;
$$;


-- ----------------------------------------------------------------------------
-- 6. 齐套分析
--    返回粒度 = 物料（见文件头「关键设计」）。
--    kit_status：
--      done     —— 需求已全部领出
--      ready    —— 订单领料仓的可用量就够
--      transfer —— 本仓不够，但全仓合计够（需先调拨）
--      short    —— 全仓合计也不够（真缺口）
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.production_kit_check(p_order_id INTEGER)
RETURNS TABLE (
  product_id INTEGER,
  product_code TEXT,
  product_name TEXT,
  unit TEXT,
  order_detail_ids INTEGER[],
  required_quantity NUMERIC,
  issued_quantity NUMERIC,
  to_issue_quantity NUMERIC,
  warehouse_id INTEGER,
  warehouse_quantity NUMERIC,
  total_quantity NUMERIC,
  shortage_quantity NUMERIC,
  suggested_warehouse_id INTEGER,
  suggested_warehouse_name TEXT,
  kit_status TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_order RECORD;
BEGIN
  IF p_order_id IS NULL OR p_order_id <= 0 THEN
    RAISE EXCEPTION 'A positive production order id is required'
      USING ERRCODE = '22023';
  END IF;

  SELECT x.id, x.warehouse_id
  INTO v_order
  FROM public.erp_production_orders_s_539dcf81_b x
  WHERE x.id = p_order_id AND x.is_deleted = 'n';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Production order % does not exist', p_order_id
      USING ERRCODE = 'P0002';
  END IF;

  RETURN QUERY
  WITH order_line AS (
    SELECT
      d.material_id AS pid,
      d.id AS detail_id,
      COALESCE(d.planned_quantity, 0) AS planned_qty,
      COALESCE(d.issued_quantity, 0) AS issued_qty,
      COALESCE(d.warehouse_id, v_order.warehouse_id) AS wh_id
    FROM public.erp_production_order_details_s_539dcf81_b d
    WHERE d.order_id = p_order_id
      AND d.is_deleted = 'n'
      AND d.material_id IS NOT NULL
  ),
  per_material AS (
    SELECT
      l.pid,
      ARRAY_AGG(l.detail_id ORDER BY l.detail_id) AS detail_ids,
      SUM(l.planned_qty) AS required_qty,
      SUM(l.issued_qty) AS issued_qty,
      MIN(l.wh_id) AS wh_id
    FROM order_line l
    GROUP BY l.pid
  ),
  warehouse_stock AS (
    SELECT i.product_id AS pid,
           i.warehouse_id AS wh_id,
           SUM(COALESCE(i.quantity, 0)) AS qty
    FROM public.erp_inventory_s_539dcf81_b i
    WHERE i.is_deleted = 'n'
    GROUP BY i.product_id, i.warehouse_id
  ),
  material_stock AS (
    SELECT s.pid, SUM(s.qty) AS qty
    FROM warehouse_stock s
    GROUP BY s.pid
  ),
  richest_warehouse AS (
    SELECT DISTINCT ON (s.pid) s.pid, s.wh_id
    FROM warehouse_stock s
    WHERE s.qty > 0
    ORDER BY s.pid, s.qty DESC, s.wh_id
  ),
  enriched AS (
    SELECT
      m.pid,
      m.detail_ids,
      m.required_qty,
      m.issued_qty,
      GREATEST(m.required_qty - m.issued_qty, 0) AS to_issue_qty,
      m.wh_id,
      COALESCE(ws.qty, 0) AS wh_qty,
      COALESCE(ms.qty, 0) AS all_qty,
      COALESCE(rw.wh_id, m.wh_id) AS richest_wh
    FROM per_material m
    LEFT JOIN warehouse_stock ws
      ON ws.pid = m.pid AND ws.wh_id = m.wh_id
    LEFT JOIN material_stock ms
      ON ms.pid = m.pid
    LEFT JOIN richest_warehouse rw
      ON rw.pid = m.pid
  )
  SELECT
    e.pid,
    p.code::TEXT,
    p.name::TEXT,
    p.unit::TEXT,
    e.detail_ids,
    e.required_qty,
    e.issued_qty,
    e.to_issue_qty,
    e.wh_id,
    e.wh_qty,
    e.all_qty,
    GREATEST(e.to_issue_qty - e.wh_qty, 0),
    CASE
      WHEN e.to_issue_qty <= 0 THEN NULL
      WHEN e.wh_qty >= e.to_issue_qty THEN e.wh_id
      ELSE e.richest_wh
    END,
    (
      SELECT w.name::TEXT
      FROM public.erp_warehouses_s_539dcf81_b w
      WHERE w.id = CASE
        WHEN e.to_issue_qty <= 0 THEN e.wh_id
        WHEN e.wh_qty >= e.to_issue_qty THEN e.wh_id
        ELSE e.richest_wh
      END
      LIMIT 1
    ),
    CASE
      WHEN e.to_issue_qty <= 0 THEN 'done'
      WHEN e.wh_qty >= e.to_issue_qty THEN 'ready'
      WHEN e.all_qty >= e.to_issue_qty THEN 'transfer'
      ELSE 'short'
    END
  FROM enriched e
  LEFT JOIN public.erp_products_s_539dcf81_b p ON p.id = e.pid
  ORDER BY p.code NULLS LAST, e.pid;
END;
$$;


-- ----------------------------------------------------------------------------
-- 7. 由生产订单生成领料单
--    复用流转引擎（doc_flow_generate）而不是自己拼 INSERT：
--    台账、幂等、分批领料的余量校验全在引擎里，自己写一定会漏。
--    生成后补两件事：领料仓，以及成本口径。
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.generate_material_issue_from_order(
  p_order_id INTEGER,
  p_warehouse_id INTEGER DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_order RECORD;
  v_result JSONB;
  v_issue_id INTEGER;
  v_warehouse_id INTEGER;
BEGIN
  IF p_order_id IS NULL OR p_order_id <= 0 THEN
    RAISE EXCEPTION 'A positive production order id is required'
      USING ERRCODE = '22023';
  END IF;

  SELECT x.* INTO v_order
  FROM public.erp_production_orders_s_539dcf81_b x
  WHERE x.id = p_order_id AND x.is_deleted = 'n'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Production order does not exist or is deleted'
      USING ERRCODE = 'P0002';
  END IF;

  v_warehouse_id := COALESCE(p_warehouse_id, v_order.warehouse_id);
  IF v_warehouse_id IS NULL THEN
    RAISE EXCEPTION
      'Production order % has no material warehouse; set one on the order or pass p_warehouse_id',
      p_order_id USING ERRCODE = '23502';
  END IF;

  PERFORM 1 FROM public.erp_warehouses_s_539dcf81_b w
  WHERE w.id = v_warehouse_id AND w.is_deleted = 'n';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Warehouse % does not exist or is deleted', v_warehouse_id
      USING ERRCODE = 'P0002';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.erp_production_order_details_s_539dcf81_b d
    WHERE d.order_id = p_order_id AND d.is_deleted = 'n'
  ) THEN
    RAISE EXCEPTION
      'Production order % has no material lines; explode the BOM first', p_order_id
      USING ERRCODE = '23514';
  END IF;

  v_result := public.doc_flow_generate(
    'production_order_to_material_issue', p_order_id, 'remaining', NULL);
  v_issue_id := (v_result ->> 'target_document_id')::INTEGER;

  UPDATE public.erp_material_issues_s_539dcf81_b
  SET warehouse_id = v_warehouse_id, updated_at = NOW()
  WHERE id = v_issue_id;

  -- 成本兜底：出库时 deploy_56 仍以库存移动加权单价优先，这里填的是展示口径
  UPDATE public.erp_material_issue_details_s_539dcf81_b d
  SET unit_cost = COALESCE(NULLIF(p.cost_price, 0), NULLIF(p.purchase_price, 0), 0),
      amount = COALESCE(d.quantity, 0)
        * COALESCE(NULLIF(p.cost_price, 0), NULLIF(p.purchase_price, 0), 0),
      updated_at = NOW()
  FROM public.erp_products_s_539dcf81_b p
  WHERE d.issue_id = v_issue_id
    AND d.is_deleted = 'n'
    AND p.id = d.material_id;

  UPDATE public.erp_material_issues_s_539dcf81_b h
  SET total_amount = COALESCE((
        SELECT SUM(COALESCE(d.amount, 0))
        FROM public.erp_material_issue_details_s_539dcf81_b d
        WHERE d.issue_id = v_issue_id AND d.is_deleted = 'n'
      ), 0),
      updated_at = NOW()
  WHERE h.id = v_issue_id;

  RETURN v_result || jsonb_build_object('warehouse_id', v_warehouse_id);
END;
$$;


-- ----------------------------------------------------------------------------
-- 8. 把生产订单未领的料带进已有领料单
--    场景：用户先手工建了一张领料单，再选生产订单把 BOM 行拉进来。
--    只带「还没领完、且本单还没带过」的行；已带过的行跳过而不是报错，
--    这样重复点击是安全的（幂等）。
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pull_order_lines_into_issue(
  p_issue_id INTEGER,
  p_order_id INTEGER
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_issue RECORD;
  v_order RECORD;
  v_max_line INTEGER;
  v_inserted INTEGER := 0;
BEGIN
  IF p_issue_id IS NULL OR p_issue_id <= 0
     OR p_order_id IS NULL OR p_order_id <= 0 THEN
    RAISE EXCEPTION 'Positive issue id and production order id are required'
      USING ERRCODE = '22023';
  END IF;

  SELECT x.* INTO v_issue
  FROM public.erp_material_issues_s_539dcf81_b x
  WHERE x.id = p_issue_id AND x.is_deleted = 'n'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Material issue does not exist or is deleted'
      USING ERRCODE = 'P0002';
  END IF;
  IF COALESCE(v_issue.status, '') = 'posted' THEN
    RAISE EXCEPTION 'Posted material issues cannot be modified; reverse it first'
      USING ERRCODE = '55000';
  END IF;

  SELECT x.* INTO v_order
  FROM public.erp_production_orders_s_539dcf81_b x
  WHERE x.id = p_order_id AND x.is_deleted = 'n'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Production order does not exist or is deleted'
      USING ERRCODE = 'P0002';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.erp_production_order_details_s_539dcf81_b d
    WHERE d.order_id = p_order_id AND d.is_deleted = 'n'
  ) THEN
    RAISE EXCEPTION
      'Production order % has no material lines; explode the BOM first', p_order_id
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(MAX(d.line_no), 0) INTO v_max_line
  FROM public.erp_material_issue_details_s_539dcf81_b d
  WHERE d.issue_id = p_issue_id AND d.is_deleted = 'n';

  INSERT INTO public.erp_material_issue_details_s_539dcf81_b (
    corp_id, emp_id, is_deleted, issue_id, line_no, material_id,
    quantity, unit_cost, amount, batch_no, remark, order_detail_id
  )
  SELECT
    v_issue.corp_id,
    public.current_sys_user_id()::TEXT,
    'n',
    p_issue_id,
    v_max_line + ROW_NUMBER() OVER (ORDER BY d.line_no, d.id),
    d.material_id,
    GREATEST(
      COALESCE(d.planned_quantity, 0) - COALESCE(d.issued_quantity, 0), 0),
    COALESCE(NULLIF(p.cost_price, 0), NULLIF(p.purchase_price, 0), 0),
    GREATEST(
      COALESCE(d.planned_quantity, 0) - COALESCE(d.issued_quantity, 0), 0)
      * COALESCE(NULLIF(p.cost_price, 0), NULLIF(p.purchase_price, 0), 0),
    NULL,
    format('生产订单 %s 行 %s', COALESCE(v_order.order_no, ''), d.line_no),
    d.id
  FROM public.erp_production_order_details_s_539dcf81_b d
  LEFT JOIN public.erp_products_s_539dcf81_b p ON p.id = d.material_id
  WHERE d.order_id = p_order_id
    AND d.is_deleted = 'n'
    AND d.material_id IS NOT NULL
    AND GREATEST(
      COALESCE(d.planned_quantity, 0) - COALESCE(d.issued_quantity, 0), 0) > 0
    AND NOT EXISTS (
      SELECT 1 FROM public.erp_material_issue_details_s_539dcf81_b x
      WHERE x.issue_id = p_issue_id
        AND x.order_detail_id = d.id
        AND x.is_deleted = 'n');

  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  IF v_inserted = 0 THEN
    RAISE EXCEPTION
      'Nothing to pull from production order %: every line is already on this issue or fully issued',
      p_order_id USING ERRCODE = '23514';
  END IF;

  -- 补来源订单与领料仓（原本为空才补，不覆盖用户的选择）
  UPDATE public.erp_material_issues_s_539dcf81_b h
  SET production_order_id = COALESCE(h.production_order_id, p_order_id),
      warehouse_id = COALESCE(h.warehouse_id, v_order.warehouse_id),
      total_amount = COALESCE((
        SELECT SUM(COALESCE(d.amount, 0))
        FROM public.erp_material_issue_details_s_539dcf81_b d
        WHERE d.issue_id = p_issue_id AND d.is_deleted = 'n'
      ), 0),
      updated_at = NOW()
  WHERE h.id = p_issue_id;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'issue_id', p_issue_id,
    'order_id', p_order_id,
    'inserted_lines', v_inserted);
END;
$$;


REVOKE ALL ON FUNCTION public.explode_production_order_bom(INTEGER, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.production_kit_check(INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.generate_material_issue_from_order(INTEGER, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pull_order_lines_into_issue(INTEGER, INTEGER) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.explode_production_order_bom(INTEGER, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.production_kit_check(INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.generate_material_issue_from_order(INTEGER, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pull_order_lines_into_issue(INTEGER, INTEGER) TO authenticated;
