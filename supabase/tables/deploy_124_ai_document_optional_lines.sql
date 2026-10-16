-- ============================================================================
-- deploy_124_ai_document_optional_lines.sql
--
-- 目标：AI 建单允许「只建单头、不带明细」。
--
-- 背景：
--   deploy_83 的 ai_create_document 强制「p_lines 至少一行」（第 244-246 行），
--   与新的产品要求冲突 —— 用户可能只说「帮我新建一张采购订单」（还没想好明细），
--   AI 应当照建单头草稿；等用户给了明细再补，而不是当场回问打断。
--   反之，用户给了明细（物料 + 数量）就必须一起写进去（这个能力 deploy_83 已具备）。
--
-- 改动（仅一处语义变化，其余逐字沿用 deploy_83 的实现）：
--   · p_lines 为 NULL / 'null' / '[]'  → 视为空明细，跳过明细循环，line_count = 0；
--   · p_lines 为其它类型（对象/标量）  → 仍然报错（fail-loud，防止上游传错结构）；
--   · 明细非空时的字段白名单校验、行金额、汇总回写逻辑完全不变。
--
-- 幂等：CREATE OR REPLACE，可重复执行。
-- ============================================================================

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
  v_lines       JSONB;
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

  -- 明细可选：NULL / JSON null / 空数组 都按「无明细」处理；
  -- 只有「非数组且非空」才是上游传错了结构。
  IF p_lines IS NULL OR jsonb_typeof(p_lines) = 'null' THEN
    v_lines := '[]'::jsonb;
  ELSIF jsonb_typeof(p_lines) = 'array' THEN
    v_lines := p_lines;
  ELSE
    RAISE EXCEPTION '单据明细必须是 JSON 数组（当前是 %）', jsonb_typeof(p_lines)
      USING ERRCODE = '22023';
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

  -- ⑥ 明细：逐行校验 + 补 line_no / 外键 / 租户 / 行金额（无明细时整个循环不执行）
  v_qty_field   := v_meta->'line_amount'->>'quantity';
  v_price_field := v_meta->'line_amount'->>'unit_price';
  v_amt_field   := v_meta->'line_amount'->>'amount';

  FOR v_line IN SELECT * FROM jsonb_array_elements(v_lines) LOOP
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

  -- ⑦ 汇总回写（规则来自 ai_document_meta.totals）；无明细时合计为 0
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
  'AI 建单内核：白名单校验 + 取号 + 单头 + 明细（明细可选） + 汇总回写，单事务。需先注入租户上下文。';

-- ---------------------------------------------------------------------------
-- 自检：函数存在、函数体里不再有「至少需要一行明细」的硬约束
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_src TEXT;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'ai_create_document';

  IF v_src IS NULL THEN
    RAISE EXCEPTION '[deploy_124] ai_create_document 未创建';
  END IF;
  IF v_src LIKE '%至少需要一行明细%' THEN
    RAISE EXCEPTION '[deploy_124] 函数体里仍有「至少需要一行明细」的硬约束';
  END IF;
  RAISE NOTICE '[deploy_124] ai_create_document 已替换：明细可选（空数组 → 只建单头）';
END $$;

NOTIFY pgrst, 'reload schema';
