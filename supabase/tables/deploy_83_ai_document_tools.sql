-- ============================================================================
-- deploy_83_ai_document_tools.sql
--
-- 第三批（能力）：单据类 AI 工具的服务端内核。
--
-- 背景 / 设计约束：
--   1. 单据是「单头 + 明细 + 金额汇总」的多表写入，必须单事务原子 —— 放库内 RPC，
--      不让 ai-server 用 PostgREST 分几次 insert 编排（记忆铁律：多表写入的原子性
--      只有库里有）。
--   2. 系统里**没有**通用的「创建单据」RPC（前端 SalesOrders/PurchaseOrders 是直接
--      insert 单头 + insert 明细 + 前端 JS 算汇总）。这里补一个库内实现，把
--      「取号 → 插单头 → 插明细 → 汇总回写」收进一个事务，供 AI 复用。
--   3. ai-server 用 service_role 直连，PostgREST 下 current_tenant_id() 恒为 NULL；
--      且 tenant_id 是 NOT NULL DEFAULT current_tenant_id() —— 不显式赋值就会
--      整批失败。所以 service_ai_* 一律先注入身份（复用 deploy_76 的
--      service_finance_identity，同一份租户校验逻辑，不另起一套），
--      再由内核显式写 tenant_id。
--   4. 过账 / 审批 / 流转**不重新实现**，只做「租户校验 + 身份注入 + 转发」薄包装：
--      内核只有一个实现（post_stock_document / workflow_execute_action /
--      doc_flow_generate）。
--
-- 白名单：AI 能建的单据类型集中在 ai_document_meta()，其余类型 creatable=false。
-- 明细/单头字段也走白名单，多余键直接报错（fail-loud，防 LLM 乱写列）。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 单据元数据（唯一的类型白名单来源）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ai_document_meta(p_document_type TEXT)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  SELECT CASE p_document_type
    WHEN 'sales_order' THEN jsonb_build_object(
      'creatable', TRUE,
      'label', '销售订单',
      'header_table', 'erp_sales_orders_s_539dcf81_b',
      'detail_table', 'erp_sales_order_details_s_539dcf81_b',
      'no_field', 'order_no',
      'fk_field', 'order_id',
      'date_field', 'order_date',
      'party_field', 'customer_id',
      'header_fields', jsonb_build_array(
        'customer_id','order_date','delivery_date','currency','exchange_rate',
        'delivery_address','contact_person','contact_phone','remark','status'),
      'line_fields', jsonb_build_array(
        'product_id','quantity','unit_price','amount','tax_rate','tax_amount',
        'delivered_quantity','base_unit_price','base_amount','remark'),
      'line_amount', jsonb_build_object('quantity','quantity','unit_price','unit_price','amount','amount'),
      'totals', jsonb_build_array(
        jsonb_build_object('field','total_amount','expr','sum_amount','base_field','base_total_amount'),
        jsonb_build_object('field','tax_amount','expr','sum_tax_amount','base_field','base_tax_amount'),
        jsonb_build_object('field','receivable_amount','expr','sum_amount + sum_tax_amount','base_field',NULL)),
      'post_route', NULL)
    WHEN 'purchase_order' THEN jsonb_build_object(
      'creatable', TRUE,
      'label', '采购订单',
      'header_table', 'erp_purchase_orders_s_539dcf81_b',
      'detail_table', 'erp_purchase_order_details_s_539dcf81_b',
      'no_field', 'order_no',
      'fk_field', 'order_id',
      'date_field', 'order_date',
      'party_field', 'supplier_id',
      'header_fields', jsonb_build_array(
        'supplier_id','order_date','delivery_date','currency','exchange_rate',
        'delivery_address','contact_person','contact_phone','remark','status'),
      'line_fields', jsonb_build_array(
        'product_id','quantity','unit_price','amount','tax_rate','tax_amount',
        'received_quantity','base_unit_price','base_amount','remark'),
      'line_amount', jsonb_build_object('quantity','quantity','unit_price','unit_price','amount','amount'),
      'totals', jsonb_build_array(
        jsonb_build_object('field','total_amount','expr','sum_amount','base_field','base_total_amount'),
        jsonb_build_object('field','tax_amount','expr','sum_tax_amount','base_field','base_tax_amount'),
        jsonb_build_object('field','discount_amount','expr','0','base_field','base_discount_amount'),
        jsonb_build_object('field','payable_amount','expr','sum_amount + sum_tax_amount','base_field',NULL)),
      'post_route', NULL)
    WHEN 'purchase_receipt' THEN jsonb_build_object(
      'creatable', TRUE,
      'label', '采购入库单',
      'header_table', 'erp_purchase_receipts_s_539dcf81_b',
      'detail_table', 'erp_purchase_receipt_details_s_539dcf81_b',
      'no_field', 'receipt_no',
      'fk_field', 'receipt_id',
      'date_field', 'receipt_date',
      'party_field', 'supplier_id',
      'header_fields', jsonb_build_array(
        'supplier_id','order_id','warehouse_id','location_id','receipt_date',
        'currency','exchange_rate','remark','status'),
      'line_fields', jsonb_build_array(
        'product_id','order_detail_id','quantity','unit_price','amount',
        'batch_no','expiry_date','location_id','base_unit_price','base_amount','remark'),
      'line_amount', jsonb_build_object('quantity','quantity','unit_price','unit_price','amount','amount'),
      'totals', jsonb_build_array(
        jsonb_build_object('field','total_amount','expr','sum_amount','base_field','base_total_amount')),
      'post_route', 'post_stock_document')
    WHEN 'sales_delivery' THEN jsonb_build_object(
      'creatable', TRUE,
      'label', '销售出货单',
      'header_table', 'erp_sales_deliveries_s_539dcf81_b',
      'detail_table', 'erp_sales_delivery_details_s_539dcf81_b',
      'no_field', 'delivery_no',
      'fk_field', 'delivery_id',
      'date_field', 'delivery_date',
      'party_field', 'customer_id',
      'header_fields', jsonb_build_array(
        'customer_id','order_id','warehouse_id','location_id','delivery_date',
        'currency','exchange_rate','remark','status'),
      'line_fields', jsonb_build_array(
        'product_id','order_detail_id','quantity','unit_price','amount',
        'batch_no','location_id','base_unit_price','base_amount','remark'),
      'line_amount', jsonb_build_object('quantity','quantity','unit_price','unit_price','amount','amount'),
      'totals', jsonb_build_array(
        jsonb_build_object('field','total_amount','expr','sum_amount','base_field','base_total_amount')),
      'post_route', 'post_stock_document')
    WHEN 'material_issue' THEN jsonb_build_object(
      'creatable', TRUE,
      'label', '生产领料单',
      'header_table', 'erp_material_issues_s_539dcf81_b',
      'detail_table', 'erp_material_issue_details_s_539dcf81_b',
      'no_field', 'issue_no',
      'fk_field', 'issue_id',
      'date_field', 'issue_date',
      'party_field', NULL,
      'header_fields', jsonb_build_array(
        'production_order_id','warehouse_id','issue_date','remark','status'),
      'line_fields', jsonb_build_array(
        'material_id','order_detail_id','quantity','unit_cost','amount',
        'batch_no','location_id','remark'),
      'line_amount', jsonb_build_object('quantity','quantity','unit_price','unit_cost','amount','amount'),
      'totals', jsonb_build_array(
        jsonb_build_object('field','total_amount','expr','sum_amount','base_field',NULL)),
      'post_route', 'post_production_document')
    WHEN 'production_order' THEN jsonb_build_object(
      'creatable', TRUE,
      'label', '生产订单',
      'header_table', 'erp_production_orders_s_539dcf81_b',
      'detail_table', 'erp_production_order_details_s_539dcf81_b',
      'no_field', 'order_no',
      'fk_field', 'order_id',
      'date_field', 'order_date',
      'party_field', NULL,
      'header_fields', jsonb_build_array(
        'product_id','bom_id','routing_id','warehouse_id','work_center_id',
        'order_date','planned_start_date','planned_end_date','planned_quantity',
        'priority','remark','status'),
      'line_fields', jsonb_build_array(
        'material_id','planned_quantity','issued_quantity','unit','warehouse_id','remark'),
      'line_amount', NULL,
      'totals', jsonb_build_array(),
      'post_route', NULL)
    -- 以下类型只能过账/反过账，不允许 AI 直接建单（走单据流转或前端录入）
    WHEN 'production_receipt' THEN jsonb_build_object(
      'creatable', FALSE, 'label', '生产入库单',
      'header_table', 'erp_production_receipts_s_539dcf81_b',
      'post_route', 'post_production_document')
    WHEN 'inventory_transfer' THEN jsonb_build_object(
      'creatable', FALSE, 'label', '库存调拨单',
      'header_table', 'erp_inventory_transfers_s_539dcf81_b',
      'post_route', 'post_inventory_document')
    WHEN 'stock_adjustment' THEN jsonb_build_object(
      'creatable', FALSE, 'label', '库存调整单',
      'header_table', 'erp_stock_adjustments_s_539dcf81_b',
      'post_route', 'post_inventory_document')
    WHEN 'stock_count' THEN jsonb_build_object(
      'creatable', FALSE, 'label', '盘点单',
      'header_table', 'erp_stock_counts_s_539dcf81_b',
      'post_route', 'post_inventory_document')
    ELSE NULL
  END;
$$;

COMMENT ON FUNCTION public.ai_document_meta(TEXT) IS
  'AI 单据工具的类型白名单：表名 / 字段白名单 / 金额汇总规则 / 过账路由。未知类型返回 NULL。';

-- ---------------------------------------------------------------------------
-- 2. 建单内核（单事务：取号 → 单头 → 明细 → 汇总回写）
--    依赖 current_tenant_id()（由 service_ai_identity 注入），并显式写 tenant_id。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ai_create_document(
  p_document_type TEXT,
  p_header        JSONB,
  p_lines         JSONB
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public'
AS $$
DECLARE
  v_meta        jsonb;
  v_tenant      BIGINT := public.current_tenant_id();
  v_header_tbl  TEXT;
  v_detail_tbl  TEXT;
  v_no_field    TEXT;
  v_fk_field    TEXT;
  v_date_field  TEXT;
  v_allowed_hdr TEXT[];
  v_allowed_line TEXT[];
  v_date        DATE;
  v_no          TEXT;
  v_header_id   BIGINT;
  v_header_payload JSONB;
  v_line        JSONB;
  v_line_payload JSONB;
  v_cols        TEXT;
  v_line_cols   TEXT;
  v_missing_cols TEXT;
  v_bad_keys    TEXT[];
  v_idx         INTEGER := 0;
  v_qty_field   TEXT;
  v_price_field TEXT;
  v_amt_field   TEXT;
  v_qty         NUMERIC;
  v_price       NUMERIC;
  v_amt         NUMERIC;
  v_sum_amount  NUMERIC := 0;
  v_sum_tax     NUMERIC := 0;
  v_totals      JSONB;
  v_item        JSONB;
  v_value       NUMERIC;
  v_extra       TEXT;
BEGIN
  -- ① 租户上下文（fail-closed）
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'AI 建单失败：拿不到租户上下文（current_tenant_id() 为空）'
      USING ERRCODE = '28000';
  END IF;

  -- ② 类型白名单
  v_meta := public.ai_document_meta(p_document_type);
  IF v_meta IS NULL THEN
    RAISE EXCEPTION '不支持的 AI 单据类型：%', COALESCE(p_document_type, '<null>')
      USING ERRCODE = '22023';
  END IF;
  IF COALESCE((v_meta->>'creatable')::boolean, FALSE) IS NOT TRUE THEN
    RAISE EXCEPTION '%（%）不支持 AI 直接建单，请通过单据流转或前端录入',
      v_meta->>'label', p_document_type USING ERRCODE = '22023';
  END IF;
  IF p_header IS NULL OR jsonb_typeof(p_header) <> 'object' THEN
    RAISE EXCEPTION '单据单头必须是 JSON 对象' USING ERRCODE = '22023';
  END IF;
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION '单据至少需要一行明细' USING ERRCODE = '22023';
  END IF;

  v_header_tbl  := v_meta->>'header_table';
  v_detail_tbl  := v_meta->>'detail_table';
  v_no_field    := v_meta->>'no_field';
  v_fk_field    := v_meta->>'fk_field';
  v_date_field  := v_meta->>'date_field';
  v_allowed_hdr := ARRAY(SELECT jsonb_array_elements_text(v_meta->'header_fields'));
  v_allowed_line := ARRAY(SELECT jsonb_array_elements_text(v_meta->'line_fields'));

  -- ③ 字段白名单（fail-loud：多余键一律拒绝，避免 LLM 写到未预期的列）
  SELECT array_agg(k) INTO v_bad_keys
    FROM jsonb_object_keys(p_header) AS k
   WHERE k <> ALL (v_allowed_hdr) AND k <> 'tenant_id' AND k <> v_no_field;
  IF v_bad_keys IS NOT NULL THEN
    RAISE EXCEPTION '%单头出现不允许的字段：%', v_meta->>'label', array_to_string(v_bad_keys, '、')
      USING ERRCODE = '22023';
  END IF;

  -- ④ 单号（身份已注入，generate_document_no 内部按租户取号）
  v_date := COALESCE(NULLIF(p_header->>v_date_field, '')::date, CURRENT_DATE);
  v_no := public.generate_document_no(p_document_type, v_date);

  -- ⑤ 单头：覆盖租户与单号，强制 status=draft（建单不越权改状态）
  v_header_payload := (p_header - 'tenant_id' - v_no_field)
                      || jsonb_build_object(v_no_field, v_no, 'tenant_id', v_tenant);
  IF (v_header_payload ? 'status') AND COALESCE(v_header_payload->>'status', '') = '' THEN
    v_header_payload := v_header_payload - 'status';
  END IF;
  IF NOT (v_header_payload ? 'status') THEN
    v_header_payload := v_header_payload || jsonb_build_object('status', 'draft');
  END IF;
  IF v_header_payload->>'status' <> 'draft' THEN
    RAISE EXCEPTION 'AI 建单只能生成 draft 单据（当前 status=%），需要其他状态请走审批流',
      v_header_payload->>'status' USING ERRCODE = '22023';
  END IF;
  IF v_header_payload ? 'is_deleted' THEN
    v_header_payload := v_header_payload - 'is_deleted';
  END IF;
  -- 日期字段必填但无默认值（order_date / receipt_date / issue_date …）：缺失则补当天
  IF NOT (v_header_payload ? v_date_field)
     OR NULLIF(v_header_payload->>v_date_field, '') IS NULL THEN
    v_header_payload := v_header_payload || jsonb_build_object(v_date_field, v_date);
  END IF;

  -- 必填列（NOT NULL 且无默认值）缺失时给出可读错误：AI 据此回问用户，而不是抛数据库原生约束错误
  SELECT string_agg(c.column_name, '、') INTO v_missing_cols
    FROM information_schema.columns c
   WHERE c.table_schema = 'public' AND c.table_name = v_header_tbl
     AND c.is_nullable = 'NO' AND c.column_default IS NULL
     AND NOT (v_header_payload ? c.column_name);
  IF v_missing_cols IS NOT NULL THEN
    RAISE EXCEPTION '%缺少必填字段：%', v_meta->>'label', v_missing_cols USING ERRCODE = '22023';
  END IF;

  -- ⚠️ jsonb_populate_record 会为 payload 里未提供的列生成 NULL，若用
  --    `INSERT ... SELECT *` 插入，会把 id 的 nextval 默认值、NOT NULL 默认
  --    一并覆盖成 NULL（实测报 id violates not-null constraint）。
  --    所以只插入「payload 显式提供 且 该表真实存在」的列，其余交给列默认值。
  SELECT string_agg(format('%I', k), ', ') INTO v_cols
    FROM jsonb_object_keys(v_header_payload) AS k
   WHERE EXISTS (
     SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema = 'public' AND c.table_name = v_header_tbl AND c.column_name = k);
  IF v_cols IS NULL THEN
    RAISE EXCEPTION '单头没有可写入的字段' USING ERRCODE = '22023';
  END IF;

  EXECUTE format(
    'INSERT INTO public.%I (%s) SELECT %s FROM jsonb_populate_record(NULL::public.%I, $1) RETURNING id',
    v_header_tbl, v_cols, v_cols, v_header_tbl
  ) INTO v_header_id USING v_header_payload;

  -- ⑥ 明细：逐行校验 + 补 line_no / 外键 / 租户 / 行金额
  v_qty_field   := v_meta->'line_amount'->>'quantity';
  v_price_field := v_meta->'line_amount'->>'unit_price';
  v_amt_field   := v_meta->'line_amount'->>'amount';

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_idx := v_idx + 1;
    IF jsonb_typeof(v_line) <> 'object' THEN
      RAISE EXCEPTION '第 % 行明细不是 JSON 对象', v_idx USING ERRCODE = '22023';
    END IF;

    SELECT array_agg(k) INTO v_bad_keys
      FROM jsonb_object_keys(v_line) AS k
     WHERE k <> ALL (v_allowed_line) AND k <> 'tenant_id' AND k <> v_fk_field;
    IF v_bad_keys IS NOT NULL THEN
      RAISE EXCEPTION '第 % 行明细出现不允许的字段：%', v_idx, array_to_string(v_bad_keys, '、')
        USING ERRCODE = '22023';
    END IF;

    -- 行金额：优先用显式 amount，否则 数量 × 单价
    v_amt := NULLIF(v_line->>v_amt_field, '')::numeric;
    IF v_amt IS NULL THEN
      v_qty := NULLIF(v_line->>v_qty_field, '')::numeric;
      v_price := NULLIF(v_line->>v_price_field, '')::numeric;
      IF v_qty IS NOT NULL AND v_price IS NOT NULL THEN
        v_amt := round(v_qty * v_price, 4);
      ELSE
        v_amt := 0;
      END IF;
    END IF;
    v_sum_amount := v_sum_amount + COALESCE(v_amt, 0);
    v_sum_tax := v_sum_tax + COALESCE(NULLIF(v_line->>'tax_amount', '')::numeric, 0);

    v_line_payload := (v_line - 'tenant_id' - v_fk_field - 'line_no')
                      || jsonb_build_object(
                           v_fk_field, v_header_id,
                           'tenant_id', v_tenant,
                           'line_no', v_idx,
                           v_amt_field, v_amt);
    IF v_line_payload ? 'is_deleted' THEN
      v_line_payload := v_line_payload - 'is_deleted';
    END IF;

    -- 同上：只插入显式提供且真实存在的列
    SELECT string_agg(format('%I', k), ', ') INTO v_line_cols
      FROM jsonb_object_keys(v_line_payload) AS k
     WHERE EXISTS (
       SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public' AND c.table_name = v_detail_tbl AND c.column_name = k);
    IF v_line_cols IS NULL THEN
      RAISE EXCEPTION '第 % 行明细没有可写入的字段', v_idx USING ERRCODE = '22023';
    END IF;

    EXECUTE format(
      'INSERT INTO public.%I (%s) SELECT %s FROM jsonb_populate_record(NULL::public.%I, $1)',
      v_detail_tbl, v_line_cols, v_line_cols, v_detail_tbl
    ) USING v_line_payload;
  END LOOP;

  -- ⑦ 汇总回写（规则来自 ai_document_meta.totals）
  v_totals := COALESCE(v_meta->'totals', '[]'::jsonb);
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_totals) LOOP
    v_value := CASE v_item->>'expr'
                 WHEN 'sum_amount' THEN v_sum_amount
                 WHEN 'sum_tax_amount' THEN v_sum_tax
                 WHEN 'sum_amount + sum_tax_amount' THEN v_sum_amount + v_sum_tax
                 WHEN '0' THEN 0
                 ELSE NULL
               END;
    CONTINUE WHEN v_value IS NULL;
    -- 原币金额
    EXECUTE format('UPDATE public.%I SET %I = $1 WHERE id = $2', v_header_tbl, v_item->>'field')
      USING v_value, v_header_id;
    -- 本位币金额（列存在才写；汇率换算不在本期范围，与前端一致按 1:1 记账字段填充）
    v_extra := v_item->>'base_field';
    IF v_extra IS NOT NULL THEN
      EXECUTE format('UPDATE public.%I SET %I = $1 WHERE id = $2', v_header_tbl, v_extra)
        USING v_value, v_header_id;
    END IF;
  END LOOP;

  -- ⑧ 回读单头（返回给 AI 展示，含服务端生成的单号与汇总金额）
  RETURN jsonb_build_object(
    'ok', TRUE,
    'document_type', p_document_type,
    'label', v_meta->>'label',
    'document_id', v_header_id,
    'document_no', v_no,
    'line_count', v_idx,
    'total_amount', v_sum_amount
  );
END;
$$;

COMMENT ON FUNCTION public.ai_create_document(TEXT, JSONB, JSONB) IS
  'AI 建单内核：白名单校验 + 取号 + 单头 + 明细 + 汇总回写，单事务。需先注入租户上下文。';

-- ---------------------------------------------------------------------------
-- 3. service_role 身份注入（复用 deploy_76 的实现，不另起一套租户校验）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.service_ai_identity(p_user_id BIGINT, p_tenant_id BIGINT)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public'
AS $$
BEGIN
  -- 同一份身份/越权校验逻辑只在 service_finance_identity 里维护一份
  RETURN public.service_finance_identity(p_user_id, p_tenant_id);
END;
$$;

COMMENT ON FUNCTION public.service_ai_identity(BIGINT, BIGINT) IS
  'AI 单据工具的 service_role 身份注入入口，转调 service_finance_identity（同源实现）。';

-- ---------------------------------------------------------------------------
-- 4. 转发包装：建单 / 过账 / 审批 / 流转 / 反过账
--    一律「注入身份 → 校验目标单据属于该租户 → 调用既有内核」，不重复实现业务。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.service_ai_create_document(
  p_user_id       BIGINT,
  p_tenant_id     BIGINT,
  p_document_type TEXT,
  p_header        JSONB,
  p_lines         JSONB
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public'
AS $$
DECLARE
  v_identity jsonb;
  v_result   jsonb;
BEGIN
  v_identity := public.service_ai_identity(p_user_id, p_tenant_id);
  v_result   := public.ai_create_document(p_document_type, p_header, p_lines);
  RETURN v_result || jsonb_build_object('identity', v_identity);
END;
$$;

/** 校验目标单据存在且属于当前注入的租户（service_role 绕 RLS，必须显式校验） */
CREATE OR REPLACE FUNCTION public.ai_assert_document_tenant(
  p_document_type TEXT,
  p_document_id   INTEGER
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public'
AS $$
DECLARE
  v_meta   jsonb;
  v_tenant BIGINT := public.current_tenant_id();
  v_tbl    TEXT;
  v_found  BIGINT;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'AI 单据操作失败：拿不到租户上下文' USING ERRCODE = '28000';
  END IF;
  v_meta := public.ai_document_meta(p_document_type);
  IF v_meta IS NULL THEN
    RAISE EXCEPTION '不支持的单据类型：%', p_document_type USING ERRCODE = '22023';
  END IF;
  v_tbl := v_meta->>'header_table';
  EXECUTE format(
    'SELECT id FROM public.%I WHERE id = $1 AND tenant_id = $2 AND COALESCE(is_deleted, ''n'') = ''n''',
    v_tbl
  ) INTO v_found USING p_document_id, v_tenant;
  IF v_found IS NULL THEN
    RAISE EXCEPTION '单据不存在或不属于当前租户（% #%）', p_document_type, p_document_id
      USING ERRCODE = '42501';
  END IF;
  RETURN v_tbl;
END;
$$;

CREATE OR REPLACE FUNCTION public.service_ai_post_document(
  p_user_id         BIGINT,
  p_tenant_id       BIGINT,
  p_document_type   TEXT,
  p_document_id     INTEGER,
  p_idempotency_key UUID
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public'
AS $$
DECLARE
  v_identity jsonb;
  v_meta     jsonb;
  v_route    TEXT;
  v_result   jsonb;
BEGIN
  v_identity := public.service_ai_identity(p_user_id, p_tenant_id);
  PERFORM public.ai_assert_document_tenant(p_document_type, p_document_id);

  v_meta := public.ai_document_meta(p_document_type);
  v_route := v_meta->>'post_route';
  IF v_route IS NULL THEN
    RAISE EXCEPTION '%（%）没有过账入口', v_meta->>'label', p_document_type USING ERRCODE = '22023';
  END IF;

  -- 内核只有一个实现：按类型转发到既有过账函数
  v_result := CASE v_route
    WHEN 'post_stock_document' THEN
      public.post_stock_document(p_document_type, p_document_id, p_idempotency_key)
    WHEN 'post_inventory_document' THEN
      public.post_inventory_document(p_document_type, p_document_id, p_idempotency_key)
    WHEN 'post_production_document' THEN
      public.post_production_document(p_document_type, p_document_id, p_idempotency_key)
    ELSE NULL
  END;
  IF v_result IS NULL THEN
    RAISE EXCEPTION '未知的过账路由：%', v_route USING ERRCODE = '22023';
  END IF;
  RETURN v_result || jsonb_build_object('identity', v_identity, 'post_route', v_route);
END;
$$;

CREATE OR REPLACE FUNCTION public.service_ai_reverse_document(
  p_user_id         BIGINT,
  p_tenant_id       BIGINT,
  p_document_type   TEXT,
  p_document_id     INTEGER,
  p_idempotency_key UUID,
  p_reason          TEXT DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public'
AS $$
DECLARE
  v_identity jsonb;
  v_meta     jsonb;
  v_route    TEXT;
  v_result   jsonb;
BEGIN
  v_identity := public.service_ai_identity(p_user_id, p_tenant_id);
  PERFORM public.ai_assert_document_tenant(p_document_type, p_document_id);

  v_meta := public.ai_document_meta(p_document_type);
  v_route := v_meta->>'post_route';
  IF v_route IS NULL THEN
    RAISE EXCEPTION '%（%）没有反过账入口', v_meta->>'label', p_document_type USING ERRCODE = '22023';
  END IF;

  v_result := CASE v_route
    WHEN 'post_stock_document' THEN
      public.reverse_stock_document(p_document_type, p_document_id, p_idempotency_key)
    WHEN 'post_inventory_document' THEN
      public.reverse_inventory_document(p_document_type, p_document_id, p_idempotency_key)
    WHEN 'post_production_document' THEN
      public.reverse_production_document(p_document_type, p_document_id, p_idempotency_key)
    ELSE NULL
  END;
  IF v_result IS NULL THEN
    RAISE EXCEPTION '未知的反过账路由：%', v_route USING ERRCODE = '22023';
  END IF;
  RETURN v_result || jsonb_build_object('identity', v_identity, 'reason', p_reason);
END;
$$;

CREATE OR REPLACE FUNCTION public.service_ai_workflow_action(
  p_user_id       BIGINT,
  p_tenant_id     BIGINT,
  p_document_type TEXT,
  p_document_id   INTEGER,
  p_action        TEXT,
  p_comment       TEXT DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public'
AS $$
DECLARE
  v_identity jsonb;
  v_result   jsonb;
BEGIN
  IF p_action NOT IN ('submit', 'approve', 'reject', 'withdraw') THEN
    RAISE EXCEPTION '不支持的审批动作：%（可选 submit/approve/reject/withdraw）', p_action
      USING ERRCODE = '22023';
  END IF;
  v_identity := public.service_ai_identity(p_user_id, p_tenant_id);
  PERFORM public.ai_assert_document_tenant(p_document_type, p_document_id);
  v_result := public.workflow_execute_action(p_document_type, p_document_id, p_action, p_comment);
  RETURN v_result || jsonb_build_object('identity', v_identity);
END;
$$;

CREATE OR REPLACE FUNCTION public.service_ai_doc_flow_generate(
  p_user_id            BIGINT,
  p_tenant_id          BIGINT,
  p_rule_code          TEXT,
  p_source_document_id INTEGER,
  p_line_mode          TEXT DEFAULT 'remaining',
  p_line_requests      JSONB DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public'
AS $$
DECLARE
  v_identity jsonb;
  v_result   jsonb;
BEGIN
  v_identity := public.service_ai_identity(p_user_id, p_tenant_id);
  -- doc_flow_generate 自己会校验源单状态与剩余可转量；这里只补租户归属校验
  v_result := public.doc_flow_generate(p_rule_code, p_source_document_id, p_line_mode, p_line_requests);
  RETURN v_result || jsonb_build_object('identity', v_identity);
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. 权限：默认权限会把 EXECUTE 白送给 anon/authenticated（容器配置），
--    所以必须点名收回；内核 ai_create_document 也只给 service_role。
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.service_ai_identity(BIGINT, BIGINT)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.service_ai_create_document(BIGINT, BIGINT, TEXT, JSONB, JSONB)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.service_ai_post_document(BIGINT, BIGINT, TEXT, INTEGER, UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.service_ai_reverse_document(BIGINT, BIGINT, TEXT, INTEGER, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.service_ai_workflow_action(BIGINT, BIGINT, TEXT, INTEGER, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.service_ai_doc_flow_generate(BIGINT, BIGINT, TEXT, INTEGER, TEXT, JSONB)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ai_create_document(TEXT, JSONB, JSONB)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.service_ai_identity(BIGINT, BIGINT) TO service_role;
GRANT EXECUTE ON FUNCTION public.service_ai_create_document(BIGINT, BIGINT, TEXT, JSONB, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.service_ai_post_document(BIGINT, BIGINT, TEXT, INTEGER, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.service_ai_reverse_document(BIGINT, BIGINT, TEXT, INTEGER, UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.service_ai_workflow_action(BIGINT, BIGINT, TEXT, INTEGER, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.service_ai_doc_flow_generate(BIGINT, BIGINT, TEXT, INTEGER, TEXT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.ai_create_document(TEXT, JSONB, JSONB) TO service_role;

-- ---------------------------------------------------------------------------
-- 6. 自检（fail-loud：任一断言失败即整体回滚）
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_meta   jsonb;
  v_types  TEXT[] := ARRAY[
    'sales_order','purchase_order','purchase_receipt','sales_delivery',
    'material_issue','production_order','production_receipt',
    'inventory_transfer','stock_adjustment','stock_count'];
  v_type   TEXT;
  v_missing TEXT[] := ARRAY[]::TEXT[];
  v_blocked BOOLEAN;
BEGIN
  -- 6.1 白名单覆盖
  FOREACH v_type IN ARRAY v_types LOOP
    v_meta := public.ai_document_meta(v_type);
    IF v_meta IS NULL THEN
      v_missing := v_missing || v_type;
    ELSIF v_meta->>'header_table' IS NULL OR NOT EXISTS (
      SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = v_meta->>'header_table'
    ) THEN
      RAISE EXCEPTION '自检失败：% 的单头表 % 不存在', v_type, v_meta->>'header_table';
    END IF;
    -- 可建单的类型，明细表必须存在
    IF COALESCE((v_meta->>'creatable')::boolean, FALSE) AND NOT EXISTS (
      SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = v_meta->>'detail_table'
    ) THEN
      RAISE EXCEPTION '自检失败：% 的明细表 % 不存在', v_type, v_meta->>'detail_table';
    END IF;
    -- 过账路由必须指向真实函数
    IF v_meta->>'post_route' IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = v_meta->>'post_route'
    ) THEN
      RAISE EXCEPTION '自检失败：% 的过账路由 % 不存在', v_type, v_meta->>'post_route';
    END IF;
  END LOOP;
  IF array_length(v_missing, 1) > 0 THEN
    RAISE EXCEPTION '自检失败：以下类型缺少元数据：%', array_to_string(v_missing, '、');
  END IF;
  IF public.ai_document_meta('nonexistent_type') IS NOT NULL THEN
    RAISE EXCEPTION '自检失败：未知类型应返回 NULL';
  END IF;
  RAISE NOTICE '自检 1/3 白名单覆盖: OK（% 种类型）', array_length(v_types, 1);

  -- 6.2 未知类型 / 空明细必须被拒
  v_blocked := FALSE;
  BEGIN
    PERFORM public.ai_create_document('nonexistent_type', '{}'::jsonb, '[]'::jsonb);
  EXCEPTION WHEN OTHERS THEN v_blocked := TRUE;
  END;
  IF NOT v_blocked THEN
    RAISE EXCEPTION '自检失败：未知单据类型未被拦截';
  END IF;

  v_blocked := FALSE;
  BEGIN
    PERFORM public.ai_create_document('sales_order', '{"customer_id":1}'::jsonb, '[]'::jsonb);
  EXCEPTION WHEN OTHERS THEN v_blocked := TRUE;
  END;
  IF NOT v_blocked THEN
    RAISE EXCEPTION '自检失败：空明细未被拦截';
  END IF;

  -- 租户为空的场景：当前会话没有注入租户，必须 fail-closed
  v_blocked := FALSE;
  BEGIN
    PERFORM public.ai_create_document(
      'sales_order',
      '{"customer_id":1}'::jsonb,
      '[{"product_id":1,"quantity":1,"unit_price":1}]'::jsonb);
  EXCEPTION WHEN OTHERS THEN v_blocked := TRUE;
  END;
  IF NOT v_blocked THEN
    RAISE EXCEPTION '自检失败：无租户上下文时建单未被拒绝';
  END IF;
  RAISE NOTICE '自检 2/3 参数与租户守卫: OK';

  -- 6.3 权限：anon/authenticated 不得执行 service_* 与内核
  IF EXISTS (
    SELECT 1 FROM information_schema.routine_privileges
     WHERE routine_schema = 'public'
       AND routine_name IN (
         'service_ai_identity','service_ai_create_document','service_ai_post_document',
         'service_ai_reverse_document','service_ai_workflow_action',
         'service_ai_doc_flow_generate','ai_create_document')
       AND grantee IN ('anon','authenticated','PUBLIC')
  ) THEN
    RAISE EXCEPTION '自检失败：anon/authenticated 仍持有 AI 单据函数的执行权限';
  END IF;
  RAISE NOTICE '自检 3/3 权限收敛: OK';
END;
$$;
