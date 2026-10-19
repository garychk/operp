-- ============================================================================
-- P1 核心：6 个库存过账 / 反过账 RPC 重写
-- ============================================================================
--
-- 本文件是这 6 个函数的**唯一最新定义**（覆盖 deploy_24 / 56 / 58 / 69 / 86 / 87）。
-- 改这 6 个函数请改本文件，别再回改那几份 —— 改了不会有任何效果。
--
--   覆盖关系：
--     post_stock_document         <- deploy_69 覆盖 deploy_13
--     reverse_stock_document      <- deploy_69
--     post_inventory_document     <- deploy_24
--     reverse_inventory_document  <- deploy_86 覆盖 deploy_24
--     post_production_document    <- deploy_58 覆盖 deploy_56
--     reverse_production_document <- deploy_56
--
-- 相对部署前版本，本文件改了 5 件事：
--
-- ① **新增三种单据**（P1-1/2/3）
--      post_stock_document       + purchase_return（out，冲减应付）、sales_return（in，冲减应收）
--      reverse_stock_document    + 同上
--      post_production_document  + material_return（in，回冲领料成本）
--      reverse_production_document + 同上
--    四张单据头字段名不同，用 IF/ELSIF 显式分派（plpgsql 分支惰性求值，不会去取
--    不存在的 record 字段）。方向/往来方用两个局部变量归一，避免 2^4 条分支。
--
-- ② **库存状态维度**（P1-4）
--    所有库存行增减改走 `inventory_apply_move()`，入库落到
--    `inventory_receipt_stock_status()` 指定的状态（默认 available，即「入库即待检」开关），
--    出库一律只扣 `stock_status='available'` 的行；盘点/调整单按明细行的状态。
--    流水行也写 stock_status，冲销时才能在同一库位同批次的多行里精确找回自己那一行。
--
-- ③ **预占消耗**（P1-5）
--    出库时调用 `inventory_consume_reservations()`，把已预占的部分从
--    locked_quantity 里放出来 —— 这正是「过账时释放」的落点。因为可用量口径是
--    quantity - locked，两笔同时减，可用量净不变，不会凭空多出可发量。
--
--    ⚠️ **必须"先释放预占、再扣库存"**（本文件 2026-10-06 的第二版修正，见 ⑥）：
--    `inventory_apply_move()` 每次都把 available 重算成 `quantity - locked`。
--    若先扣量（-N）再释放预占，中间态是 `(qty - N) - locked`；当 N 大于"未被预占的
--    那一部分"时该值为负，负库存守卫（仓库不允许负库存时）会抛 23514，
--    把「本次出库正是在消耗自己的预占」误判成超发 —— 这是验收脚本
--    `verify-93-stock-status-atp.cjs` C5 抓到的真实缺陷（预占 30/50 后领料 30 被拒）。
--    先释放后扣减：locked 先降 → available 抬起 → 再扣量，净可用量守恒。
--
-- ④ **修掉三个既有缺陷**（不修的话上面的改动等于白做）
--    a) `post_inventory_document` / `post_production_document` 写 erp_inventory 与
--       erp_inventory_transactions 时**没带 tenant_id**，靠 `current_tenant_id()` 默认值
--       兜底 —— ai-server 走 service_role 且未设置 GUC 时会写进错误的租户。现已显式传入。
--    b) `reverse_inventory_document` **没有调用 inventory_void_voucher**：盘点/调整单
--       反过账后凭证仍挂在总账上（deploy_87 本已补上，但后来有人重跑了 deploy_86，
--       把函数打回了旧版 —— 这正是「重跑旧迁移会静默回退新覆盖」的实例）。现已补回。
--    c) `post_inventory_document` 的 `allow_negative` 在 stock_adjustment 分支**从未赋值**，
--       导致调整单的负库存校验实际失效。现已统一取仓库配置。
--
-- ⑤ 冲销不再需要「盘点把 available 拉平」的特判：apply_move 在任何一次写入后都保持
--    `available = quantity - locked`（available 行）或 0（其它状态），盘点与调整同口径。
--
-- 本脚本由 000_run_all 用 psql --single-transaction 执行，**不要写 BEGIN/COMMIT**。
-- 依赖：deploy_88（状态维度 / apply_move / 预留）、deploy_89/90/91（三张退货单）、
--       deploy_92（凭证例外落库）。
-- ============================================================================


-- ============================================================================
-- 1/6  post_stock_document：采购入库 / 销售出货 / 采购退货 / 销售退货
-- ============================================================================
CREATE OR REPLACE FUNCTION public.post_stock_document(p_document_type text, p_document_id integer, p_idempotency_key uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  h RECORD; d RECORD;
  actor_id INTEGER; line_count INTEGER := 0;
  normalized_batch TEXT; v_location_id INTEGER; v_transaction_no TEXT;
  v_exchange_rate NUMERIC; v_base_total NUMERIC;
  v_is_out BOOLEAN; v_is_return BOOLEAN; v_party_kind TEXT;
  v_target_status TEXT; v_inv_unit_cost NUMERIC; v_unit_cost NUMERIC;
  v_move JSONB; v_consumed NUMERIC;
  v_party_amount NUMERIC; v_party_base NUMERIC;
  allow_negative BOOLEAN;
  v_voucher_result JSONB;
BEGIN
  IF p_document_type NOT IN ('purchase_receipt', 'sales_delivery',
                             'purchase_return', 'sales_return') THEN
    RAISE EXCEPTION 'Unsupported stock document type: %', p_document_type
      USING ERRCODE = '22023';
  END IF;
  IF p_document_id IS NULL OR p_document_id <= 0 OR p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'A positive document ID and idempotency key are required'
      USING ERRCODE = '22023';
  END IF;
  actor_id := public.current_sys_user_id();

  -- 方向与往来方归一：四种单据只需要记住这两件事
  v_is_out     := p_document_type IN ('sales_delivery', 'purchase_return');
  v_is_return  := p_document_type IN ('purchase_return', 'sales_return');
  v_party_kind := CASE WHEN p_document_type IN ('purchase_receipt', 'purchase_return')
                       THEN 'supplier' ELSE 'customer' END;

  IF p_document_type = 'purchase_receipt' THEN
    SELECT x.id, x.receipt_no AS document_no, x.receipt_date AS document_date,
      x.supplier_id, NULL::INTEGER AS customer_id, x.warehouse_id,
      x.location_id AS header_location_id,
      x.total_amount, x.status, x.corp_id, x.posting_idempotency_key,
      x.currency, x.exchange_rate, x.tenant_id
    INTO h FROM public.erp_purchase_receipts_s_539dcf81_b x
    WHERE x.id = p_document_id AND x.is_deleted = 'n' FOR UPDATE;
  ELSIF p_document_type = 'sales_delivery' THEN
    SELECT x.id, x.delivery_no AS document_no, x.delivery_date AS document_date,
      NULL::INTEGER AS supplier_id, x.customer_id, x.warehouse_id,
      x.location_id AS header_location_id,
      x.total_amount, x.status, x.corp_id, x.posting_idempotency_key,
      x.currency, x.exchange_rate, x.tenant_id
    INTO h FROM public.erp_sales_deliveries_s_539dcf81_b x
    WHERE x.id = p_document_id AND x.is_deleted = 'n' FOR UPDATE;
  ELSIF p_document_type = 'purchase_return' THEN
    SELECT x.id, x.return_no AS document_no, x.return_date AS document_date,
      x.supplier_id, NULL::INTEGER AS customer_id, x.warehouse_id,
      x.location_id AS header_location_id,
      x.total_amount, x.status, x.corp_id, x.posting_idempotency_key,
      x.currency, x.exchange_rate, x.tenant_id
    INTO h FROM public.erp_purchase_returns_s_539dcf81_b x
    WHERE x.id = p_document_id AND x.is_deleted = 'n' FOR UPDATE;
  ELSE
    SELECT x.id, x.return_no AS document_no, x.return_date AS document_date,
      NULL::INTEGER AS supplier_id, x.customer_id, x.warehouse_id,
      x.location_id AS header_location_id,
      x.total_amount, x.status, x.corp_id, x.posting_idempotency_key,
      x.currency, x.exchange_rate, x.tenant_id
    INTO h FROM public.erp_sales_returns_s_539dcf81_b x
    WHERE x.id = p_document_id AND x.is_deleted = 'n' FOR UPDATE;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Stock document does not exist or is deleted'
      USING ERRCODE = 'P0002';
  END IF;
  IF h.status = 'posted' AND h.posting_idempotency_key = p_idempotency_key THEN
    RETURN jsonb_build_object('ok', TRUE, 'idempotent', TRUE,
      'document_type', p_document_type, 'document_id', p_document_id,
      'status', 'posted');
  END IF;
  IF h.status <> 'approved' THEN
    RAISE EXCEPTION 'Only approved documents can be posted; current status: %',
      COALESCE(h.status, '<null>') USING ERRCODE = '55000';
  END IF;
  IF h.warehouse_id IS NULL THEN
    RAISE EXCEPTION 'Stock document has no warehouse' USING ERRCODE = '23502';
  END IF;

  -- 冻结汇率。NULL 或 0 一律按 1 处理 —— 否则折本位币会把金额乘成 0 而静默清零。
  v_exchange_rate := COALESCE(NULLIF(h.exchange_rate, 0), 1);
  v_base_total := ROUND(COALESCE(h.total_amount, 0) * v_exchange_rate, 2);

  IF EXISTS (
    SELECT 1 FROM public.erp_inventory_transactions_s_539dcf81_b t
    WHERE t.reference_type = p_document_type
      AND t.reference_id = p_document_id
      AND t.tenant_id = h.tenant_id
      AND t.is_deleted = 'n'
  ) THEN
    RAISE EXCEPTION 'Document already has active inventory transactions'
      USING ERRCODE = '23505';
  END IF;

  -- 锁明细行，避免并发过账读到改到一半的明细
  IF p_document_type = 'purchase_receipt' THEN
    PERFORM x.id FROM public.erp_purchase_receipt_details_s_539dcf81_b x
     WHERE x.receipt_id = p_document_id AND x.tenant_id = h.tenant_id
       AND x.is_deleted = 'n' ORDER BY x.id FOR UPDATE;
  ELSIF p_document_type = 'sales_delivery' THEN
    PERFORM x.id FROM public.erp_sales_delivery_details_s_539dcf81_b x
     WHERE x.delivery_id = p_document_id AND x.tenant_id = h.tenant_id
       AND x.is_deleted = 'n' ORDER BY x.id FOR UPDATE;
  ELSIF p_document_type = 'purchase_return' THEN
    PERFORM x.id FROM public.erp_purchase_return_details_s_539dcf81_b x
     WHERE x.return_id = p_document_id AND x.tenant_id = h.tenant_id
       AND x.is_deleted = 'n' ORDER BY x.id FOR UPDATE;
  ELSE
    PERFORM x.id FROM public.erp_sales_return_details_s_539dcf81_b x
     WHERE x.return_id = p_document_id AND x.tenant_id = h.tenant_id
       AND x.is_deleted = 'n' ORDER BY x.id FOR UPDATE;
  END IF;

  SELECT COALESCE(w.is_negative_stock_allowed, FALSE)
    INTO allow_negative FROM public.erp_warehouses_s_539dcf81_b w
   WHERE w.id = h.warehouse_id AND w.tenant_id = h.tenant_id
     AND w.is_deleted = 'n' FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Warehouse does not exist or is deleted'
      USING ERRCODE = 'P0002';
  END IF;

  -- 入库落哪个状态：采购入库与销售退货受「入库即待检」开关控制；
  -- 出库一律只扣 available 行。
  IF v_is_out THEN
    v_target_status := 'available';
  ELSE
    v_target_status := public.inventory_receipt_stock_status(h.tenant_id);
  END IF;

  -- 四种单据的明细归一成同一形状。doc_unit_price 是**原币单据价**，
  -- 销售类单据不回它（销价不是成本）。
  FOR d IN
    SELECT x.id AS detail_id, x.product_id, x.quantity,
      x.unit_price AS doc_unit_price,
      COALESCE(NULLIF(p.cost_price, 0), NULLIF(p.purchase_price, 0), 0) AS product_unit_cost,
      NULLIF(BTRIM(x.batch_no), '') AS batch_no, x.expiry_date,
      x.location_id AS detail_location_id
    FROM public.erp_purchase_receipt_details_s_539dcf81_b x
    LEFT JOIN public.erp_products_s_539dcf81_b p
      ON p.id = x.product_id AND p.tenant_id = x.tenant_id
    WHERE p_document_type = 'purchase_receipt'
      AND x.receipt_id = p_document_id AND x.tenant_id = h.tenant_id
      AND x.is_deleted = 'n'
    UNION ALL
    SELECT x.id, x.product_id, x.quantity, NULL::NUMERIC,
      COALESCE(NULLIF(p.cost_price, 0), NULLIF(p.purchase_price, 0), 0),
      NULLIF(BTRIM(x.batch_no), ''), NULL::DATE, x.location_id
    FROM public.erp_sales_delivery_details_s_539dcf81_b x
    LEFT JOIN public.erp_products_s_539dcf81_b p
      ON p.id = x.product_id AND p.tenant_id = x.tenant_id
    WHERE p_document_type = 'sales_delivery'
      AND x.delivery_id = p_document_id AND x.tenant_id = h.tenant_id
      AND x.is_deleted = 'n'
    UNION ALL
    SELECT x.id, x.product_id, x.quantity, NULL::NUMERIC,
      COALESCE(NULLIF(p.cost_price, 0), NULLIF(p.purchase_price, 0), 0),
      NULLIF(BTRIM(x.batch_no), ''), NULL::DATE, x.location_id
    FROM public.erp_purchase_return_details_s_539dcf81_b x
    LEFT JOIN public.erp_products_s_539dcf81_b p
      ON p.id = x.product_id AND p.tenant_id = x.tenant_id
    WHERE p_document_type = 'purchase_return'
      AND x.return_id = p_document_id AND x.tenant_id = h.tenant_id
      AND x.is_deleted = 'n'
    UNION ALL
    SELECT x.id, x.product_id, x.quantity, NULL::NUMERIC,
      COALESCE(NULLIF(p.cost_price, 0), NULLIF(p.purchase_price, 0), 0),
      NULLIF(BTRIM(x.batch_no), ''), x.expiry_date, x.location_id
    FROM public.erp_sales_return_details_s_539dcf81_b x
    LEFT JOIN public.erp_products_s_539dcf81_b p
      ON p.id = x.product_id AND p.tenant_id = x.tenant_id
    WHERE p_document_type = 'sales_return'
      AND x.return_id = p_document_id AND x.tenant_id = h.tenant_id
      AND x.is_deleted = 'n'
    ORDER BY product_id, batch_no NULLS FIRST, detail_id
  LOOP
    line_count := line_count + 1;
    IF d.product_id IS NULL OR d.quantity IS NULL OR d.quantity <= 0 THEN
      RAISE EXCEPTION 'Detail % has no product or non-positive quantity',
        d.detail_id USING ERRCODE = '23514';
    END IF;
    normalized_batch := NULLIF(BTRIM(d.batch_no), '');
    -- 明细库位优先，回退到主表默认库位
    v_location_id := COALESCE(d.detail_location_id, h.header_location_id);

    IF v_location_id IS NOT NULL THEN
      PERFORM 1 FROM public.erp_bins_s_539dcf81_b b
       WHERE b.id = v_location_id AND b.warehouse_id = h.warehouse_id
         AND b.tenant_id = h.tenant_id AND b.is_deleted = 'n';
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Location % is not valid for warehouse %',
          v_location_id, h.warehouse_id USING ERRCODE = '23503';
      END IF;
    END IF;

    -- 目标状态行的现有移动加权成本（成本兜底顺序要用到）
    v_inv_unit_cost := COALESCE((
      SELECT x.unit_cost FROM public.erp_inventory_s_539dcf81_b x
       WHERE x.product_id = d.product_id AND x.warehouse_id = h.warehouse_id
         AND x.tenant_id = h.tenant_id
         AND COALESCE(x.location_id, 0) = COALESCE(v_location_id, 0)
         AND COALESCE(NULLIF(BTRIM(x.batch_no), ''), '') = COALESCE(normalized_batch, '')
         AND x.stock_status = v_target_status
         AND x.is_deleted = 'n'), 0);

    IF p_document_type = 'purchase_receipt' THEN
      -- 入库成本：单据单价是原币 → 先折本位币；后两个兜底本身就是本位币口径，不再折汇
      v_unit_cost := COALESCE(NULLIF(d.doc_unit_price, 0) * v_exchange_rate,
                              NULLIF(d.product_unit_cost, 0),
                              NULLIF(v_inv_unit_cost, 0), 0);
    ELSIF p_document_type = 'sales_return' THEN
      -- 退货入库：按原出库成本（移动加权）回冲，不用销价
      v_unit_cost := COALESCE(NULLIF(v_inv_unit_cost, 0),
                              NULLIF(d.product_unit_cost, 0), 0);
    ELSE
      -- 出库成本：移动加权（已是本位币），与单据币种无关
      v_unit_cost := COALESCE(NULLIF(v_inv_unit_cost, 0),
                              NULLIF(d.product_unit_cost, 0), 0);
    END IF;

    -- 出库必须**先释放预占，再扣库存**（P1-5「过账时释放」）。
    -- 顺序是关键：库存增减漏斗每次都把 available 重算成 quantity - locked，
    -- 若先扣量再释放预占，`(qty - 出库量) - locked` 会变负，把
    -- 「本次出库正是在消耗自己的预占」误判成超发而抛 23514。
    -- 先释放后扣减：locked 先降，available 抬起来，再扣量，净可用量不变。
    IF v_is_out THEN
      v_consumed := public.inventory_consume_reservations(
        h.tenant_id, d.product_id, h.warehouse_id, v_location_id,
        normalized_batch, v_target_status, d.quantity);
    END IF;

    v_move := public.inventory_apply_move(
      p_tenant_id      => h.tenant_id,
      p_corp_id        => h.corp_id,
      p_actor_id       => actor_id,
      p_product_id     => d.product_id,
      p_warehouse_id   => h.warehouse_id,
      p_location_id    => v_location_id,
      p_batch_no       => normalized_batch,
      p_stock_status   => v_target_status,
      p_qty_delta      => CASE WHEN v_is_out THEN -d.quantity ELSE d.quantity END,
      p_unit_cost      => v_unit_cost,
      p_cost_delta     => NULL,
      p_expiry_date    => d.expiry_date,
      p_allow_negative => allow_negative);

    v_unit_cost := COALESCE((v_move ->> 'unit_cost')::NUMERIC, 0);

    v_transaction_no := 'IT' || TO_CHAR(clock_timestamp(), 'YYYYMMDDHH24MISSMS')
      || LPAD(d.detail_id::TEXT, 6, '0');
    INSERT INTO public.erp_inventory_transactions_s_539dcf81_b (
      corp_id, emp_id, is_deleted, transaction_no, transaction_type,
      transaction_date, product_id, warehouse_id, location_id, batch_no,
      stock_status, quantity, unit_cost, total_cost, reference_type, reference_id,
      reference_detail_id, posting_idempotency_key, remark, tenant_id
    ) VALUES (
      h.corp_id, actor_id::TEXT, 'n', LEFT(v_transaction_no, 50),
      public.resolve_inventory_transaction_type(
        p_document_type, CASE WHEN v_is_out THEN 'out' ELSE 'in' END),
      h.document_date, d.product_id, h.warehouse_id, v_location_id, normalized_batch,
      v_target_status,
      CASE WHEN v_is_out THEN -d.quantity ELSE d.quantity END,
      v_unit_cost,
      COALESCE((v_move ->> 'cost_delta')::NUMERIC, 0),
      p_document_type, p_document_id, d.detail_id, p_idempotency_key,
      format('%s %s 过账', p_document_type, h.document_no),
      h.tenant_id
    );
  END LOOP;
  IF line_count = 0 THEN
    RAISE EXCEPTION 'Stock document has no active details'
      USING ERRCODE = '23514';
  END IF;

  -- ---- 往来：入库挂应付/应收，退货挂金额为负的红字，冲减 balance -------------
  IF COALESCE(h.total_amount, 0) <= 0 THEN
    RAISE EXCEPTION '% requires a positive amount', p_document_type
      USING ERRCODE = '23514';
  END IF;
  v_party_amount := CASE WHEN v_is_return THEN -h.total_amount ELSE h.total_amount END;
  v_party_base   := CASE WHEN v_is_return THEN -v_base_total  ELSE v_base_total END;

  IF v_party_kind = 'supplier' THEN
    IF h.supplier_id IS NULL THEN
      RAISE EXCEPTION 'Document requires a supplier' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.erp_payables_s_539dcf81_b a
       WHERE a.tenant_id = h.tenant_id AND a.source_type = p_document_type
         AND a.source_id = p_document_id AND a.is_deleted = 'n'
    ) THEN
      RAISE EXCEPTION 'Document already has an active payable' USING ERRCODE = '23505';
    END IF;
    INSERT INTO public.erp_payables_s_539dcf81_b (
      corp_id, emp_id, is_deleted, supplier_id, doc_type, doc_no,
      source_type, source_id, source_no, doc_date, due_date, amount,
      paid_amount, balance, currency, exchange_rate, base_amount,
      base_paid_amount, base_balance, status, remark, tenant_id
    ) VALUES (
      h.corp_id, actor_id::TEXT, 'n', h.supplier_id, p_document_type, h.document_no,
      p_document_type, p_document_id, h.document_no, h.document_date, h.document_date,
      v_party_amount, 0, v_party_amount, h.currency, v_exchange_rate, v_party_base,
      0, v_party_base, 'open',
      CASE WHEN v_is_return
           THEN format('采购退货单 %s 过账自动生成（红字冲减应付）', h.document_no)
           ELSE format('采购入库单 %s 过账自动生成', h.document_no) END,
      h.tenant_id);
  ELSE
    IF h.customer_id IS NULL THEN
      RAISE EXCEPTION 'Document requires a customer' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.erp_receivables_s_539dcf81_b a
       WHERE a.tenant_id = h.tenant_id AND a.source_type = p_document_type
         AND a.source_id = p_document_id AND a.is_deleted = 'n'
    ) THEN
      RAISE EXCEPTION 'Document already has an active receivable' USING ERRCODE = '23505';
    END IF;
    INSERT INTO public.erp_receivables_s_539dcf81_b (
      corp_id, emp_id, is_deleted, customer_id, doc_type, doc_no,
      source_type, source_id, source_no, doc_date, due_date,
      amount, paid_amount, balance, currency, exchange_rate, base_amount,
      base_paid_amount, base_balance, status, remark, tenant_id
    ) VALUES (
      h.corp_id, actor_id::TEXT, 'n', h.customer_id, p_document_type, h.document_no,
      p_document_type, p_document_id, h.document_no, h.document_date, h.document_date,
      v_party_amount, 0, v_party_amount, h.currency, v_exchange_rate, v_party_base,
      0, v_party_base, 'open',
      CASE WHEN v_is_return
           THEN format('销售退货单 %s 过账自动生成（红字冲减应收）', h.document_no)
           ELSE format('销售出货单 %s 过账自动生成', h.document_no) END,
      h.tenant_id);
  END IF;

  -- ---- 单据状态 ---------------------------------------------------------
  IF p_document_type = 'purchase_receipt' THEN
    UPDATE public.erp_purchase_receipts_s_539dcf81_b
    SET status = 'posted', posting_idempotency_key = p_idempotency_key,
        reversal_idempotency_key = NULL, posted_at = NOW(),
        reversed_at = NULL, base_total_amount = v_base_total, updated_at = NOW()
    WHERE id = p_document_id;
  ELSIF p_document_type = 'sales_delivery' THEN
    UPDATE public.erp_sales_deliveries_s_539dcf81_b
    SET status = 'posted', posting_idempotency_key = p_idempotency_key,
        reversal_idempotency_key = NULL, posted_at = NOW(),
        reversed_at = NULL, base_total_amount = v_base_total, updated_at = NOW()
    WHERE id = p_document_id;
  ELSIF p_document_type = 'purchase_return' THEN
    UPDATE public.erp_purchase_returns_s_539dcf81_b
    SET status = 'posted', posting_idempotency_key = p_idempotency_key,
        reversal_idempotency_key = NULL, posted_at = NOW(),
        reversed_at = NULL, base_total_amount = v_base_total, updated_at = NOW()
    WHERE id = p_document_id;
  ELSE
    UPDATE public.erp_sales_returns_s_539dcf81_b
    SET status = 'posted', posting_idempotency_key = p_idempotency_key,
        reversal_idempotency_key = NULL, posted_at = NOW(),
        reversed_at = NULL, base_total_amount = v_base_total, updated_at = NOW()
    WHERE id = p_document_id;
  END IF;

  -- ---- 库存 -> 总账勾稽（deploy_87 / deploy_92）--------------------------
  v_voucher_result := public.inventory_sync_voucher(
    p_source_type   => p_document_type,
    p_source_id     => p_document_id,
    p_document_no   => h.document_no,
    p_document_date => h.document_date,
    p_tenant_id     => h.tenant_id,
    p_remark        => format('%s %s', p_document_type, h.document_no));

  RETURN jsonb_build_object('ok', TRUE, 'idempotent', FALSE,
    'document_type', p_document_type, 'document_id', p_document_id,
    'status', 'posted', 'line_count', line_count,
    'stock_status', v_target_status,
    'currency', h.currency, 'exchange_rate', v_exchange_rate,
    'base_total_amount', v_base_total,
    'voucher', v_voucher_result,
    'idempotency_key', p_idempotency_key);
END;
$function$;


-- ============================================================================
-- 2/6  reverse_stock_document：上四种单据的反过账
-- ============================================================================
CREATE OR REPLACE FUNCTION public.reverse_stock_document(p_document_type text, p_document_id integer, p_idempotency_key uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  h RECORD; t RECORD; ar_ap RECORD;
  v_is_return BOOLEAN; v_party_kind TEXT;
  v_expected NUMERIC; v_expected_base NUMERIC;
  v_target_status TEXT; v_move JSONB;
  line_count INTEGER := 0;
  v_voucher_result JSONB;
BEGIN
  IF p_document_type NOT IN ('purchase_receipt', 'sales_delivery',
                             'purchase_return', 'sales_return') THEN
    RAISE EXCEPTION 'Unsupported stock document type: %', p_document_type
      USING ERRCODE = '22023';
  END IF;
  IF p_document_id IS NULL OR p_document_id <= 0 OR p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'A positive document ID and idempotency key are required'
      USING ERRCODE = '22023';
  END IF;

  v_is_return  := p_document_type IN ('purchase_return', 'sales_return');
  v_party_kind := CASE WHEN p_document_type IN ('purchase_receipt', 'purchase_return')
                       THEN 'supplier' ELSE 'customer' END;

  IF p_document_type = 'purchase_receipt' THEN
    SELECT x.id, x.receipt_no AS document_no, x.total_amount, x.status,
      x.reversal_idempotency_key, x.tenant_id
    INTO h FROM public.erp_purchase_receipts_s_539dcf81_b x
    WHERE x.id = p_document_id AND x.is_deleted = 'n' FOR UPDATE;
  ELSIF p_document_type = 'sales_delivery' THEN
    SELECT x.id, x.delivery_no AS document_no, x.total_amount, x.status,
      x.reversal_idempotency_key, x.tenant_id
    INTO h FROM public.erp_sales_deliveries_s_539dcf81_b x
    WHERE x.id = p_document_id AND x.is_deleted = 'n' FOR UPDATE;
  ELSIF p_document_type = 'purchase_return' THEN
    SELECT x.id, x.return_no AS document_no, x.total_amount, x.status,
      x.reversal_idempotency_key, x.tenant_id
    INTO h FROM public.erp_purchase_returns_s_539dcf81_b x
    WHERE x.id = p_document_id AND x.is_deleted = 'n' FOR UPDATE;
  ELSE
    SELECT x.id, x.return_no AS document_no, x.total_amount, x.status,
      x.reversal_idempotency_key, x.tenant_id
    INTO h FROM public.erp_sales_returns_s_539dcf81_b x
    WHERE x.id = p_document_id AND x.is_deleted = 'n' FOR UPDATE;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Stock document does not exist or is deleted'
      USING ERRCODE = 'P0002';
  END IF;
  IF h.status = 'approved' AND h.reversal_idempotency_key = p_idempotency_key THEN
    RETURN jsonb_build_object('ok', TRUE, 'idempotent', TRUE,
      'document_type', p_document_type, 'document_id', p_document_id,
      'status', 'approved');
  END IF;
  IF h.status <> 'posted' THEN
    RAISE EXCEPTION 'Only posted documents can be reversed; current status: %',
      COALESCE(h.status, '<null>') USING ERRCODE = '55000';
  END IF;

  -- 红字往来行的期望余额：入库/出货为正，退货为负
  v_expected := CASE WHEN v_is_return
                     THEN -COALESCE(h.total_amount, 0)
                     ELSE  COALESCE(h.total_amount, 0) END;
  v_expected_base := v_expected;

  IF v_party_kind = 'supplier' THEN
    SELECT x.* INTO ar_ap FROM public.erp_payables_s_539dcf81_b x
     WHERE x.source_type = p_document_type AND x.source_id = p_document_id
       AND x.tenant_id = h.tenant_id AND x.is_deleted = 'n' FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Generated payable was not found' USING ERRCODE = 'P0002';
    END IF;
    IF COALESCE(ar_ap.paid_amount, 0) <> 0
       OR ABS(COALESCE(ar_ap.balance, 0) - v_expected) >= 0.005 THEN
      RAISE EXCEPTION 'Payable was paid or settled and cannot be reversed'
        USING ERRCODE = '55000';
    END IF;
  ELSE
    SELECT x.* INTO ar_ap FROM public.erp_receivables_s_539dcf81_b x
     WHERE x.source_type = p_document_type AND x.source_id = p_document_id
       AND x.tenant_id = h.tenant_id AND x.is_deleted = 'n' FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Generated receivable was not found' USING ERRCODE = 'P0002';
    END IF;
    IF COALESCE(ar_ap.paid_amount, 0) <> 0
       OR ABS(COALESCE(ar_ap.balance, 0) - v_expected) >= 0.005 THEN
      RAISE EXCEPTION 'Receivable was collected or settled and cannot be reversed'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  -- 按流水行逐条反算。stock_status 必须带上 —— 同库位同批次可能有多行不同状态。
  FOR t IN
    SELECT x.* FROM public.erp_inventory_transactions_s_539dcf81_b x
    WHERE x.reference_type = p_document_type
      AND x.reference_id = p_document_id
      AND x.tenant_id = h.tenant_id
      AND x.is_deleted = 'n'
    ORDER BY x.product_id, x.warehouse_id, COALESCE(x.location_id, 0),
             x.batch_no NULLS FIRST, COALESCE(x.stock_status, 'available'), x.id
    FOR UPDATE
  LOOP
    line_count := line_count + 1;
    v_target_status := COALESCE(NULLIF(BTRIM(t.stock_status), ''), 'available');

    v_move := public.inventory_apply_move(
      p_tenant_id      => t.tenant_id,
      p_corp_id        => t.corp_id,
      p_actor_id       => public.current_sys_user_id(),
      p_product_id     => t.product_id,
      p_warehouse_id   => t.warehouse_id,
      p_location_id    => t.location_id,
      p_batch_no       => t.batch_no,
      p_stock_status   => v_target_status,
      p_qty_delta      => -COALESCE(t.quantity, 0),
      p_unit_cost      => t.unit_cost,
      p_cost_delta     => -COALESCE(t.total_cost, 0),
      p_expiry_date    => NULL,
      p_allow_negative => NULL);

    -- 冲销「出库」会把库存加回来：如果这批货当初消耗过预占，此处不需要恢复预占
    -- （预占在过账时已经消耗掉，属于已履行完毕，恢复预占反而会凭空占住库存）。
  END LOOP;
  IF line_count = 0 THEN
    RAISE EXCEPTION 'No active inventory transactions found' USING ERRCODE = 'P0002';
  END IF;

  UPDATE public.erp_inventory_transactions_s_539dcf81_b
  SET is_deleted = 'y', reversal_idempotency_key = p_idempotency_key,
      reversed_at = NOW(), updated_at = NOW()
  WHERE reference_type = p_document_type
    AND reference_id = p_document_id
    AND tenant_id = h.tenant_id
    AND is_deleted = 'n';

  IF v_party_kind = 'supplier' THEN
    UPDATE public.erp_payables_s_539dcf81_b
    SET is_deleted = 'y', status = 'cancelled', updated_at = NOW()
    WHERE id = ar_ap.id;
  ELSE
    UPDATE public.erp_receivables_s_539dcf81_b
    SET is_deleted = 'y', status = 'cancelled', updated_at = NOW()
    WHERE id = ar_ap.id;
  END IF;

  IF p_document_type = 'purchase_receipt' THEN
    UPDATE public.erp_purchase_receipts_s_539dcf81_b
    SET status = 'approved', reversal_idempotency_key = p_idempotency_key,
        reversed_at = NOW(), updated_at = NOW()
    WHERE id = p_document_id;
  ELSIF p_document_type = 'sales_delivery' THEN
    UPDATE public.erp_sales_deliveries_s_539dcf81_b
    SET status = 'approved', reversal_idempotency_key = p_idempotency_key,
        reversed_at = NOW(), updated_at = NOW()
    WHERE id = p_document_id;
  ELSIF p_document_type = 'purchase_return' THEN
    UPDATE public.erp_purchase_returns_s_539dcf81_b
    SET status = 'approved', reversal_idempotency_key = p_idempotency_key,
        reversed_at = NOW(), updated_at = NOW()
    WHERE id = p_document_id;
  ELSE
    UPDATE public.erp_sales_returns_s_539dcf81_b
    SET status = 'approved', reversal_idempotency_key = p_idempotency_key,
        reversed_at = NOW(), updated_at = NOW()
    WHERE id = p_document_id;
  END IF;

  v_voucher_result := public.inventory_void_voucher(
    p_source_type     => p_document_type,
    p_source_id       => p_document_id,
    p_tenant_id       => h.tenant_id,
    p_idempotency_key => p_idempotency_key);

  RETURN jsonb_build_object('ok', TRUE, 'idempotent', FALSE,
    'document_type', p_document_type, 'document_id', p_document_id,
    'status', 'approved', 'line_count', line_count,
    'voucher', v_voucher_result,
    'idempotency_key', p_idempotency_key);
END;
$function$;


-- ============================================================================
-- 3/6  post_inventory_document：调拨 / 盘点 / 调整
-- ============================================================================
CREATE OR REPLACE FUNCTION public.post_inventory_document(p_document_type text, p_document_id integer, p_idempotency_key uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  h RECORD; d RECORD;
  actor_id INTEGER; line_count INTEGER := 0;
  normalized_batch TEXT; allow_negative BOOLEAN;
  v_out_status TEXT; v_in_status TEXT;
  v_unit_cost NUMERIC; v_move_out JSONB; v_move_in JSONB;
  v_old_qty NUMERIC; v_old_cost NUMERIC; v_inv_unit_cost NUMERIC;
  v_new_qty NUMERIC; v_from_location INTEGER; v_to_location INTEGER;
  v_voucher_result JSONB; v_document_no TEXT; v_document_date DATE;
BEGIN
  IF p_document_type NOT IN ('inventory_transfer', 'stock_count', 'stock_adjustment') THEN
    RAISE EXCEPTION 'Unsupported inventory document type: %', p_document_type
      USING ERRCODE = '22023';
  END IF;
  IF p_document_id IS NULL OR p_document_id <= 0 OR p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'A positive document ID and idempotency key are required'
      USING ERRCODE = '22023';
  END IF;
  actor_id := public.current_sys_user_id();

  IF p_document_type = 'inventory_transfer' THEN
    SELECT * INTO h FROM public.erp_inventory_transfers_s_539dcf81_b
     WHERE id = p_document_id AND is_deleted = 'n' FOR UPDATE;
  ELSIF p_document_type = 'stock_count' THEN
    SELECT * INTO h FROM public.erp_stock_counts_s_539dcf81_b
     WHERE id = p_document_id AND is_deleted = 'n' FOR UPDATE;
  ELSE
    SELECT * INTO h FROM public.erp_stock_adjustments_s_539dcf81_b
     WHERE id = p_document_id AND is_deleted = 'n' FOR UPDATE;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Inventory document does not exist or is deleted'
      USING ERRCODE = 'P0002';
  END IF;
  IF h.status = 'posted' AND h.posting_idempotency_key = p_idempotency_key THEN
    RETURN jsonb_build_object('ok', TRUE, 'idempotent', TRUE,
      'document_type', p_document_type, 'document_id', p_document_id,
      'status', 'posted');
  END IF;
  IF h.status <> 'approved' THEN
    RAISE EXCEPTION 'Only approved documents can be posted; current status: %',
      COALESCE(h.status, '<null>') USING ERRCODE = '55000';
  END IF;

  IF p_document_type = 'inventory_transfer' THEN
    IF h.from_warehouse_id IS NULL OR h.to_warehouse_id IS NULL THEN
      RAISE EXCEPTION 'Transfer requires both warehouses' USING ERRCODE = '23502';
    END IF;
    IF h.from_warehouse_id = h.to_warehouse_id THEN
      RAISE EXCEPTION 'Transfer warehouses must be different' USING ERRCODE = '23514';
    END IF;
  END IF;

  -- 三类单据都要仓库负库存配置；库存调整此前漏取，导致负库存校验形同虚设（已修）。
  IF p_document_type = 'inventory_transfer' THEN
    SELECT COALESCE(w.is_negative_stock_allowed, FALSE) INTO allow_negative
      FROM public.erp_warehouses_s_539dcf81_b w
     WHERE w.id = h.from_warehouse_id AND w.tenant_id = h.tenant_id
       AND w.is_deleted = 'n' FOR SHARE;
  ELSE
    SELECT COALESCE(w.is_negative_stock_allowed, FALSE) INTO allow_negative
      FROM public.erp_warehouses_s_539dcf81_b w
     WHERE w.id = h.warehouse_id AND w.tenant_id = h.tenant_id
       AND w.is_deleted = 'n' FOR SHARE;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Warehouse does not exist or is deleted' USING ERRCODE = 'P0002';
  END IF;

  IF p_document_type = 'inventory_transfer' THEN
    -- 调拨只搬运「可用」库存：待检/冻结/不合格的货不该被调走
    v_out_status := 'available';
    v_in_status  := 'available';

    FOR d IN
      SELECT * FROM public.erp_inventory_transfer_details_s_539dcf81_b
       WHERE transfer_id = p_document_id AND is_deleted = 'n' ORDER BY line_no
    LOOP
      line_count := line_count + 1;
      normalized_batch := NULLIF(BTRIM(d.batch_no), '');
      v_from_location := COALESCE(d.from_location_id, h.from_location_id);
      v_to_location   := COALESCE(d.to_location_id, h.to_location_id);

      v_inv_unit_cost := COALESCE((
        SELECT x.unit_cost FROM public.erp_inventory_s_539dcf81_b x
         WHERE x.product_id = d.product_id AND x.warehouse_id = h.from_warehouse_id
           AND x.tenant_id = h.tenant_id
           AND COALESCE(x.location_id, 0) = COALESCE(v_from_location, 0)
           AND COALESCE(NULLIF(BTRIM(x.batch_no), ''), '') = COALESCE(normalized_batch, '')
           AND x.stock_status = v_out_status AND x.is_deleted = 'n'), 0);
      v_unit_cost := COALESCE(NULLIF(v_inv_unit_cost, 0), NULLIF(d.unit_cost, 0), 0);

      -- 调拨出库同样释放预占 —— 必须在扣减库存**之前**（理由同 post_stock_document）
      PERFORM public.inventory_consume_reservations(
        h.tenant_id, d.product_id, h.from_warehouse_id, v_from_location,
        normalized_batch, v_out_status, d.quantity);

      -- 出库腿
      v_move_out := public.inventory_apply_move(
        p_tenant_id => h.tenant_id, p_corp_id => h.corp_id, p_actor_id => actor_id,
        p_product_id => d.product_id, p_warehouse_id => h.from_warehouse_id,
        p_location_id => v_from_location, p_batch_no => normalized_batch,
        p_stock_status => v_out_status, p_qty_delta => -d.quantity,
        p_unit_cost => v_unit_cost, p_cost_delta => NULL,
        p_expiry_date => NULL, p_allow_negative => allow_negative);
      v_unit_cost := COALESCE((v_move_out ->> 'unit_cost')::NUMERIC, v_unit_cost);

      INSERT INTO public.erp_inventory_transactions_s_539dcf81_b (
        corp_id, emp_id, is_deleted, transaction_no, transaction_type, transaction_date,
        product_id, warehouse_id, location_id, batch_no, stock_status, quantity,
        unit_cost, total_cost, reference_type, reference_id, reference_detail_id,
        posting_idempotency_key, remark, tenant_id
      ) VALUES (
        h.corp_id, actor_id::TEXT, 'n',
        LEFT('IT' || TO_CHAR(clock_timestamp(), 'YYYYMMDDHH24MISSMS')
             || LPAD(d.id::TEXT, 6, '0'), 50),
        public.resolve_inventory_transaction_type(p_document_type, 'out'),
        h.transfer_date, d.product_id, h.from_warehouse_id, v_from_location,
        normalized_batch, v_out_status, -d.quantity, v_unit_cost,
        COALESCE((v_move_out ->> 'cost_delta')::NUMERIC, 0),
        'inventory_transfer_out', p_document_id, d.id, p_idempotency_key,
        '库存调拨出库', h.tenant_id);

      -- 入库腿（成本随货走）
      v_move_in := public.inventory_apply_move(
        p_tenant_id => h.tenant_id, p_corp_id => h.corp_id, p_actor_id => actor_id,
        p_product_id => d.product_id, p_warehouse_id => h.to_warehouse_id,
        p_location_id => v_to_location, p_batch_no => normalized_batch,
        p_stock_status => v_in_status, p_qty_delta => d.quantity,
        p_unit_cost => v_unit_cost, p_cost_delta => NULL,
        p_expiry_date => NULL, p_allow_negative => allow_negative);

      INSERT INTO public.erp_inventory_transactions_s_539dcf81_b (
        corp_id, emp_id, is_deleted, transaction_no, transaction_type, transaction_date,
        product_id, warehouse_id, location_id, batch_no, stock_status, quantity,
        unit_cost, total_cost, reference_type, reference_id, reference_detail_id,
        posting_idempotency_key, remark, tenant_id
      ) VALUES (
        h.corp_id, actor_id::TEXT, 'n',
        LEFT('IT' || TO_CHAR(clock_timestamp(), 'YYYYMMDDHH24MISSMS')
             || LPAD(d.id::TEXT, 6, '0') || 'T', 50),
        public.resolve_inventory_transaction_type(p_document_type, 'in'),
        h.transfer_date, d.product_id, h.to_warehouse_id, v_to_location,
        normalized_batch, v_in_status, d.quantity, v_unit_cost,
        COALESCE((v_move_in ->> 'cost_delta')::NUMERIC, 0),
        'inventory_transfer_in', p_document_id, d.id, p_idempotency_key,
        '库存调拨入库', h.tenant_id);
    END LOOP;

    UPDATE public.erp_inventory_transfers_s_539dcf81_b
    SET status = 'posted', posted_at = NOW(),
        posting_idempotency_key = p_idempotency_key, updated_at = NOW()
    WHERE id = p_document_id;

  ELSIF p_document_type = 'stock_count' THEN
    FOR d IN
      SELECT * FROM public.erp_stock_count_details_s_539dcf81_b
       WHERE count_id = p_document_id AND is_deleted = 'n' ORDER BY line_no
    LOOP
      line_count := line_count + 1;
      normalized_batch := NULLIF(BTRIM(d.batch_no), '');
      v_out_status := COALESCE(NULLIF(BTRIM(d.stock_status), ''), 'available');

      -- 先读旧值算差量（apply_move 内部还会再锁一次，这里只为算差额）
      v_old_qty := 0; v_old_cost := 0; v_inv_unit_cost := 0;
      SELECT COALESCE(x.quantity, 0), COALESCE(x.total_cost, 0), COALESCE(x.unit_cost, 0)
        INTO v_old_qty, v_old_cost, v_inv_unit_cost
        FROM public.erp_inventory_s_539dcf81_b x
       WHERE x.product_id = d.product_id AND x.warehouse_id = h.warehouse_id
         AND x.tenant_id = h.tenant_id
         AND COALESCE(x.location_id, 0) = COALESCE(COALESCE(d.location_id, h.location_id), 0)
         AND COALESCE(NULLIF(BTRIM(x.batch_no), ''), '') = COALESCE(normalized_batch, '')
         AND x.stock_status = v_out_status AND x.is_deleted = 'n';
      IF NOT FOUND THEN v_old_qty := 0; v_old_cost := 0; v_inv_unit_cost := 0; END IF;

      v_unit_cost := COALESCE(NULLIF(v_inv_unit_cost, 0), NULLIF(d.unit_cost, 0), 0);
      v_new_qty := COALESCE(d.counted_quantity, 0);

      v_move_out := public.inventory_apply_move(
        p_tenant_id => h.tenant_id, p_corp_id => h.corp_id, p_actor_id => actor_id,
        p_product_id => d.product_id, p_warehouse_id => h.warehouse_id,
        p_location_id => COALESCE(d.location_id, h.location_id),
        p_batch_no => normalized_batch, p_stock_status => v_out_status,
        p_qty_delta => v_new_qty - v_old_qty,
        p_unit_cost => v_unit_cost,
        -- 盘点把数量**置为**实盘数：成本增量 = 新数量对应货值 - 旧货值
        p_cost_delta => (v_new_qty * v_unit_cost) - v_old_cost,
        p_expiry_date => NULL, p_allow_negative => allow_negative);

      INSERT INTO public.erp_inventory_transactions_s_539dcf81_b (
        corp_id, emp_id, is_deleted, transaction_no, transaction_type, transaction_date,
        product_id, warehouse_id, location_id, batch_no, stock_status, quantity,
        unit_cost, total_cost, reference_type, reference_id, reference_detail_id,
        posting_idempotency_key, remark, tenant_id
      ) VALUES (
        h.corp_id, actor_id::TEXT, 'n',
        LEFT('IT' || TO_CHAR(clock_timestamp(), 'YYYYMMDDHH24MISSMS')
             || LPAD(d.id::TEXT, 6, '0'), 50),
        public.resolve_inventory_transaction_type(
          p_document_type, CASE WHEN v_new_qty >= v_old_qty THEN 'in' ELSE 'out' END),
        h.count_date, d.product_id, h.warehouse_id,
        COALESCE(d.location_id, h.location_id), normalized_batch, v_out_status,
        v_new_qty - v_old_qty, v_unit_cost,
        COALESCE((v_move_out ->> 'cost_delta')::NUMERIC, 0),
        p_document_type, p_document_id, d.id, p_idempotency_key,
        '库存盘点差异', h.tenant_id);
    END LOOP;

    UPDATE public.erp_stock_counts_s_539dcf81_b
    SET status = 'posted', posted_at = NOW(),
        posting_idempotency_key = p_idempotency_key, updated_at = NOW()
    WHERE id = p_document_id;

  ELSE
    FOR d IN
      SELECT * FROM public.erp_stock_adjustment_details_s_539dcf81_b
       WHERE adjust_id = p_document_id AND is_deleted = 'n' ORDER BY line_no
    LOOP
      line_count := line_count + 1;
      normalized_batch := NULLIF(BTRIM(d.batch_no), '');
      v_out_status := COALESCE(NULLIF(BTRIM(d.stock_status), ''), 'available');

      v_inv_unit_cost := COALESCE((
        SELECT x.unit_cost FROM public.erp_inventory_s_539dcf81_b x
         WHERE x.product_id = d.product_id AND x.warehouse_id = h.warehouse_id
           AND x.tenant_id = h.tenant_id
           AND COALESCE(x.location_id, 0) = COALESCE(COALESCE(d.location_id, h.location_id), 0)
           AND COALESCE(NULLIF(BTRIM(x.batch_no), ''), '') = COALESCE(normalized_batch, '')
           AND x.stock_status = v_out_status AND x.is_deleted = 'n'), 0);
      v_unit_cost := COALESCE(NULLIF(v_inv_unit_cost, 0), NULLIF(d.unit_cost, 0), 0);

      IF d.direction = 'out' THEN
        PERFORM public.inventory_consume_reservations(
          h.tenant_id, d.product_id, h.warehouse_id,
          COALESCE(d.location_id, h.location_id), normalized_batch,
          v_out_status, d.quantity);
      END IF;

      v_move_out := public.inventory_apply_move(
        p_tenant_id => h.tenant_id, p_corp_id => h.corp_id, p_actor_id => actor_id,
        p_product_id => d.product_id, p_warehouse_id => h.warehouse_id,
        p_location_id => COALESCE(d.location_id, h.location_id),
        p_batch_no => normalized_batch, p_stock_status => v_out_status,
        p_qty_delta => CASE WHEN d.direction = 'out' THEN -d.quantity ELSE d.quantity END,
        p_unit_cost => v_unit_cost, p_cost_delta => NULL,
        p_expiry_date => NULL, p_allow_negative => allow_negative);
      v_unit_cost := COALESCE((v_move_out ->> 'unit_cost')::NUMERIC, v_unit_cost);

      INSERT INTO public.erp_inventory_transactions_s_539dcf81_b (
        corp_id, emp_id, is_deleted, transaction_no, transaction_type, transaction_date,
        product_id, warehouse_id, location_id, batch_no, stock_status, quantity,
        unit_cost, total_cost, reference_type, reference_id, reference_detail_id,
        posting_idempotency_key, remark, tenant_id
      ) VALUES (
        h.corp_id, actor_id::TEXT, 'n',
        LEFT('IT' || TO_CHAR(clock_timestamp(), 'YYYYMMDDHH24MISSMS')
             || LPAD(d.id::TEXT, 6, '0'), 50),
        public.resolve_inventory_transaction_type(
          p_document_type, CASE WHEN d.direction = 'out' THEN 'out' ELSE 'in' END),
        h.adjust_date, d.product_id, h.warehouse_id,
        COALESCE(d.location_id, h.location_id), normalized_batch, v_out_status,
        CASE WHEN d.direction = 'out' THEN -d.quantity ELSE d.quantity END,
        v_unit_cost,
        COALESCE((v_move_out ->> 'cost_delta')::NUMERIC, 0),
        p_document_type, p_document_id, d.id, p_idempotency_key,
        '库存调整', h.tenant_id);
    END LOOP;

    UPDATE public.erp_stock_adjustments_s_539dcf81_b
    SET status = 'posted', posted_at = NOW(),
        posting_idempotency_key = p_idempotency_key, updated_at = NOW()
    WHERE id = p_document_id;
  END IF;

  IF line_count = 0 THEN
    RAISE EXCEPTION 'No detail rows found for document' USING ERRCODE = 'P0002';
  END IF;

  -- ---- 库存 -> 总账勾稽（deploy_87）--------------------------------------
  -- h 是 SELECT *，三种单据的编号 / 日期列名各不相同，这里显式分派。
  IF p_document_type = 'inventory_transfer' THEN
    v_document_no := h.transfer_no;  v_document_date := h.transfer_date;
  ELSIF p_document_type = 'stock_count' THEN
    v_document_no := h.count_no;     v_document_date := h.count_date;
  ELSE
    v_document_no := h.adjust_no;    v_document_date := h.adjust_date;
  END IF;

  v_voucher_result := public.inventory_sync_voucher(
    p_source_type   => p_document_type,
    p_source_id     => p_document_id,
    p_document_no   => v_document_no,
    p_document_date => v_document_date,
    p_tenant_id     => h.tenant_id,
    p_remark        => format('%s %s', p_document_type, v_document_no));

  RETURN jsonb_build_object('ok', TRUE, 'document_type', p_document_type,
    'document_id', p_document_id, 'status', 'posted', 'line_count', line_count,
    'voucher', v_voucher_result);
END;
$function$;


-- ============================================================================
-- 4/6  reverse_inventory_document：调拨 / 盘点 / 调整的反过账
-- ============================================================================
CREATE OR REPLACE FUNCTION public.reverse_inventory_document(p_document_type text, p_document_id integer, p_idempotency_key uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  h RECORD; t RECORD;
  actor_id INTEGER;
  line_count INTEGER := 0;
  v_ref_types TEXT[];
  v_target_status TEXT;
  v_move JSONB;
  v_voucher_result JSONB;
BEGIN
  IF p_document_type NOT IN ('inventory_transfer', 'stock_count', 'stock_adjustment') THEN
    RAISE EXCEPTION 'Unsupported inventory document type: %', p_document_type
      USING ERRCODE = '22023';
  END IF;
  IF p_document_id IS NULL OR p_document_id <= 0 OR p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'A positive document ID and idempotency key are required'
      USING ERRCODE = '22023';
  END IF;
  actor_id := public.current_sys_user_id();

  -- ---- 锁单据头 ----------------------------------------------------------
  IF p_document_type = 'inventory_transfer' THEN
    SELECT * INTO h FROM public.erp_inventory_transfers_s_539dcf81_b
     WHERE id = p_document_id AND is_deleted = 'n' FOR UPDATE;
  ELSIF p_document_type = 'stock_count' THEN
    SELECT * INTO h FROM public.erp_stock_counts_s_539dcf81_b
     WHERE id = p_document_id AND is_deleted = 'n' FOR UPDATE;
  ELSE
    SELECT * INTO h FROM public.erp_stock_adjustments_s_539dcf81_b
     WHERE id = p_document_id AND is_deleted = 'n' FOR UPDATE;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Inventory document does not exist or is deleted'
      USING ERRCODE = 'P0002';
  END IF;

  -- ---- 幂等：同一冲销键重复调用 ------------------------------------------
  IF h.status = 'approved' AND h.reversal_idempotency_key = p_idempotency_key THEN
    RETURN jsonb_build_object('ok', TRUE, 'idempotent', TRUE,
      'document_type', p_document_type, 'document_id', p_document_id,
      'status', 'approved');
  END IF;
  IF h.status <> 'posted' THEN
    RAISE EXCEPTION 'Only posted documents can be reversed; current status: %',
      COALESCE(h.status, '<null>') USING ERRCODE = '55000';
  END IF;

  -- ---- 流水 reference_type 匹配集合 --------------------------------------
  -- 调拨单两条腿写的是 'inventory_transfer_out' / '_in' 字面量，单头类型却是
  -- 'inventory_transfer'；这个坑统一由 inventory_document_ref_types 收敛。
  v_ref_types := public.inventory_document_ref_types(p_document_type);

  IF NOT EXISTS (
    SELECT 1 FROM public.erp_inventory_transactions_s_539dcf81_b x
     WHERE x.reference_type = ANY (v_ref_types)
       AND x.reference_id = p_document_id AND x.is_deleted = 'n'
  ) THEN
    RAISE EXCEPTION 'No active inventory transactions found for % #% — 单据状态是 posted 但没有对应流水，请人工核对',
      p_document_type, p_document_id USING ERRCODE = 'P0002';
  END IF;

  -- ---- 逐条冲销 ----------------------------------------------------------
  FOR t IN
    SELECT x.* FROM public.erp_inventory_transactions_s_539dcf81_b x
     WHERE x.reference_type = ANY (v_ref_types)
       AND x.reference_id = p_document_id
       AND x.is_deleted = 'n'
     ORDER BY x.product_id, x.warehouse_id,
              x.location_id NULLS FIRST, x.batch_no NULLS FIRST,
              COALESCE(x.stock_status, 'available'), x.id
     FOR UPDATE
  LOOP
    line_count := line_count + 1;
    v_target_status := COALESCE(NULLIF(BTRIM(t.stock_status), ''), 'available');

    -- 「减去本笔流水」= 撤销它的影响，方向（入库腿变出库、出库腿变入库）自动正确。
    -- available 的还原也自动正确：apply_move 恒按 `available = quantity - locked`
    -- 收口，不再需要 deploy_86 那条「盘点把 available 拉平」的特判。
    v_move := public.inventory_apply_move(
      p_tenant_id      => t.tenant_id,
      p_corp_id        => t.corp_id,
      p_actor_id       => actor_id,
      p_product_id     => t.product_id,
      p_warehouse_id   => t.warehouse_id,
      p_location_id    => t.location_id,
      p_batch_no       => t.batch_no,
      p_stock_status   => v_target_status,
      p_qty_delta      => -COALESCE(t.quantity, 0),
      p_unit_cost      => t.unit_cost,
      p_cost_delta     => -COALESCE(t.total_cost, 0),
      p_expiry_date    => NULL,
      p_allow_negative => NULL);
  END LOOP;

  -- ---- 软删流水，保留审计痕迹 -------------------------------------------
  UPDATE public.erp_inventory_transactions_s_539dcf81_b
     SET is_deleted = 'y',
         reversal_idempotency_key = p_idempotency_key,
         reversed_at = NOW(),
         updated_at = NOW()
   WHERE reference_type = ANY (v_ref_types)
     AND reference_id = p_document_id
     AND is_deleted = 'n';

  -- ---- 单据状态退回「已审核」，可修改后重新过账 ---------------------------
  IF p_document_type = 'inventory_transfer' THEN
    UPDATE public.erp_inventory_transfers_s_539dcf81_b
       SET status = 'approved', reversal_idempotency_key = p_idempotency_key,
           reversed_at = NOW(), updated_at = NOW()
     WHERE id = p_document_id;
  ELSIF p_document_type = 'stock_count' THEN
    UPDATE public.erp_stock_counts_s_539dcf81_b
       SET status = 'approved', reversal_idempotency_key = p_idempotency_key,
           reversed_at = NOW(), updated_at = NOW()
     WHERE id = p_document_id;
  ELSE
    UPDATE public.erp_stock_adjustments_s_539dcf81_b
       SET status = 'approved', reversal_idempotency_key = p_idempotency_key,
           reversed_at = NOW(), updated_at = NOW()
     WHERE id = p_document_id;
  END IF;

  -- ---- 作废对应库存凭证 ---------------------------------------------------
  -- ⚠️ 这一段在 deploy_87 就写过，后来有人重跑了 deploy_86 把函数打回旧版，
  --    导致盘点/调整单反过账后凭证还挂在总账上。本文件是唯一最新定义，勿回改旧文件。
  v_voucher_result := public.inventory_void_voucher(
    p_source_type     => p_document_type,
    p_source_id       => p_document_id,
    p_tenant_id       => h.tenant_id,
    p_idempotency_key => p_idempotency_key);

  RETURN jsonb_build_object(
    'ok', TRUE, 'idempotent', FALSE,
    'document_type', p_document_type, 'document_id', p_document_id,
    'status', 'approved', 'line_count', line_count,
    'voucher', v_voucher_result,
    'idempotency_key', p_idempotency_key);
END;
$function$;


-- ============================================================================
-- 5/6  post_production_document：生产领料 / 完工入库 / 生产退料
-- ============================================================================
CREATE OR REPLACE FUNCTION public.post_production_document(p_document_type text, p_document_id integer, p_idempotency_key uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  h RECORD; d RECORD;
  actor_id INTEGER; line_count INTEGER := 0;
  normalized_batch TEXT; v_location_id INTEGER; v_transaction_no TEXT;
  allow_negative BOOLEAN;
  v_is_out BOOLEAN; v_direction TEXT; v_target_status TEXT;
  v_inv_unit_cost NUMERIC; v_unit_cost NUMERIC; v_move JSONB; v_consumed NUMERIC;
  v_voucher_result JSONB;
  -- 完工入库过账后回写生产订单完成数量（deploy_93 补丁，见 2026-10-19）
  v_order_completed NUMERIC; v_order_planned NUMERIC; v_order_status VARCHAR(20);
BEGIN
  IF p_document_type NOT IN ('material_issue', 'production_receipt', 'material_return') THEN
    RAISE EXCEPTION 'Unsupported production document type: %', p_document_type
      USING ERRCODE = '22023';
  END IF;
  IF p_document_id IS NULL OR p_document_id <= 0 OR p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'A positive document ID and idempotency key are required'
      USING ERRCODE = '22023';
  END IF;
  actor_id := public.current_sys_user_id();

  -- 主表加锁。三张主表都带 tenant_id（旧版没取，导致写入靠 GUC 兜底 —— 已修）。
  IF p_document_type = 'material_issue' THEN
    SELECT x.id, x.issue_no AS document_no, x.issue_date AS document_date,
      x.warehouse_id, NULL::INTEGER AS header_location_id,
      x.total_amount, x.status, x.corp_id, x.posting_idempotency_key, x.tenant_id
    INTO h FROM public.erp_material_issues_s_539dcf81_b x
    WHERE x.id = p_document_id AND x.is_deleted = 'n' FOR UPDATE;
  ELSIF p_document_type = 'production_receipt' THEN
    SELECT x.id, x.receipt_no AS document_no, x.receipt_date AS document_date,
      x.warehouse_id, x.location_id AS header_location_id,
      x.amount AS total_amount, x.status, x.corp_id, x.posting_idempotency_key, x.tenant_id,
      x.production_order_id, x.quantity
    INTO h FROM public.erp_production_receipts_s_539dcf81_b x
    WHERE x.id = p_document_id AND x.is_deleted = 'n' FOR UPDATE;
  ELSE
    SELECT x.id, x.return_no AS document_no, x.return_date AS document_date,
      x.warehouse_id, x.location_id AS header_location_id,
      x.total_amount, x.status, x.corp_id, x.posting_idempotency_key, x.tenant_id
    INTO h FROM public.erp_material_returns_s_539dcf81_b x
    WHERE x.id = p_document_id AND x.is_deleted = 'n' FOR UPDATE;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Production document does not exist or is deleted'
      USING ERRCODE = 'P0002';
  END IF;
  IF h.status = 'posted' AND h.posting_idempotency_key = p_idempotency_key THEN
    RETURN jsonb_build_object('ok', TRUE, 'idempotent', TRUE,
      'document_type', p_document_type, 'document_id', p_document_id,
      'status', 'posted');
  END IF;
  IF COALESCE(h.status, '') NOT IN ('draft', 'approved', 'issued') THEN
    RAISE EXCEPTION
      'Only draft, approved or issued documents can be posted; current status: %',
      COALESCE(h.status, '<null>') USING ERRCODE = '55000';
  END IF;
  IF h.warehouse_id IS NULL THEN
    RAISE EXCEPTION 'Production document has no warehouse' USING ERRCODE = '23502';
  END IF;
  -- 完工入库硬限制：累计完工入库不得超过生产订单计划数量（deploy_93 补丁，2026-10-19）。
  -- 口径：同订单其它「已过账」入库单数量之和 + 本单数量 <= planned_quantity；
  -- 反过账后（本单 draft）重过账时不含本单旧值，天然正确。
  IF p_document_type = 'production_receipt' AND h.production_order_id IS NOT NULL THEN
    SELECT o.planned_quantity INTO v_order_planned
      FROM public.erp_production_orders_s_539dcf81_b o
     WHERE o.id = h.production_order_id AND o.tenant_id = h.tenant_id AND o.is_deleted = 'n'
       FOR SHARE;
    IF FOUND AND COALESCE(v_order_planned, 0) > 0 THEN
      SELECT COALESCE(SUM(x.quantity), 0) INTO v_order_completed
        FROM public.erp_production_receipts_s_539dcf81_b x
       WHERE x.production_order_id = h.production_order_id
         AND x.status = 'posted' AND x.is_deleted = 'n'
         AND x.id <> p_document_id;
      IF COALESCE(v_order_completed, 0) + COALESCE(h.quantity, 0)
           > v_order_planned + 0.000001 THEN
        RAISE EXCEPTION
          '完工入库超额：订单已累计入库 %，本单 %，超过计划数量 %',
          v_order_completed, h.quantity, v_order_planned
          USING ERRCODE = '55000';
      END IF;
    END IF;
  END IF;
  -- 双保险：主表状态没置 posted 但流水已存在（例如手工改回 draft），一律拒绝。
  IF EXISTS (
    SELECT 1 FROM public.erp_inventory_transactions_s_539dcf81_b t
    WHERE t.reference_type = p_document_type
      AND t.reference_id = p_document_id AND t.is_deleted = 'n'
  ) THEN
    RAISE EXCEPTION 'Document already has active inventory transactions'
      USING ERRCODE = '23505';
  END IF;

  IF p_document_type = 'material_issue' THEN
    PERFORM x.id FROM public.erp_material_issue_details_s_539dcf81_b x
     WHERE x.issue_id = p_document_id AND x.is_deleted = 'n' ORDER BY x.id FOR UPDATE;
  ELSIF p_document_type = 'material_return' THEN
    PERFORM x.id FROM public.erp_material_return_details_s_539dcf81_b x
     WHERE x.return_id = p_document_id AND x.is_deleted = 'n' ORDER BY x.id FOR UPDATE;
  END IF;

  SELECT COALESCE(w.is_negative_stock_allowed, FALSE)
  INTO allow_negative FROM public.erp_warehouses_s_539dcf81_b w
  WHERE w.id = h.warehouse_id AND w.is_deleted = 'n' FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Warehouse does not exist or is deleted'
      USING ERRCODE = 'P0002';
  END IF;

  v_is_out := (p_document_type = 'material_issue');
  v_direction := CASE WHEN v_is_out THEN 'out' ELSE 'in' END;

  -- 领料出库只吃可用库存；完工入库按「入库即待检」开关；
  -- 生产退料是「车间把原先领走的料还回来」，回到可用状态（不进待检 —— 料本来就是合格的）。
  IF v_is_out THEN
    v_target_status := 'available';
  ELSIF p_document_type = 'material_return' THEN
    v_target_status := 'available';
  ELSE
    v_target_status := public.inventory_receipt_stock_status(h.tenant_id);
  END IF;

  -- 三张单据归一成同一形状的明细流：完工入库单没有明细表，主表即唯一明细行。
  FOR d IN
    SELECT x.id AS detail_id, x.material_id AS product_id, x.quantity,
      x.unit_cost AS document_unit_cost,
      COALESCE(NULLIF(p.cost_price, 0), NULLIF(p.purchase_price, 0), 0) AS product_unit_cost,
      NULLIF(BTRIM(x.batch_no), '') AS batch_no,
      NULL::DATE AS expiry_date, x.location_id AS detail_location_id
    FROM public.erp_material_issue_details_s_539dcf81_b x
    LEFT JOIN public.erp_products_s_539dcf81_b p ON p.id = x.material_id
    WHERE p_document_type = 'material_issue'
      AND x.issue_id = p_document_id AND x.is_deleted = 'n'
    UNION ALL
    SELECT x.id, x.product_id, x.quantity, x.unit_cost,
      COALESCE(NULLIF(p.cost_price, 0), NULLIF(p.purchase_price, 0), 0),
      NULLIF(BTRIM(x.batch_no), ''), NULL::DATE, x.location_id
    FROM public.erp_production_receipts_s_539dcf81_b x
    LEFT JOIN public.erp_products_s_539dcf81_b p ON p.id = x.product_id
    WHERE p_document_type = 'production_receipt' AND x.id = p_document_id
      AND x.is_deleted = 'n'
    UNION ALL
    SELECT x.id, x.material_id, x.quantity, x.unit_cost,
      COALESCE(NULLIF(p.cost_price, 0), NULLIF(p.purchase_price, 0), 0),
      NULLIF(BTRIM(x.batch_no), ''), NULL::DATE, x.location_id
    FROM public.erp_material_return_details_s_539dcf81_b x
    LEFT JOIN public.erp_products_s_539dcf81_b p ON p.id = x.material_id
    WHERE p_document_type = 'material_return'
      AND x.return_id = p_document_id AND x.is_deleted = 'n'
    ORDER BY product_id, batch_no NULLS FIRST, detail_id
  LOOP
    line_count := line_count + 1;
    IF d.product_id IS NULL OR d.quantity IS NULL OR d.quantity <= 0 THEN
      RAISE EXCEPTION 'Detail % has no product or non-positive quantity',
        d.detail_id USING ERRCODE = '23514';
    END IF;
    normalized_batch := NULLIF(BTRIM(d.batch_no), '');
    v_location_id := COALESCE(d.detail_location_id, h.header_location_id);

    IF v_location_id IS NOT NULL THEN
      PERFORM 1 FROM public.erp_bins_s_539dcf81_b b
      WHERE b.id = v_location_id AND b.warehouse_id = h.warehouse_id
        AND b.tenant_id = h.tenant_id AND b.is_deleted = 'n';
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Location % is not valid for warehouse %',
          v_location_id, h.warehouse_id USING ERRCODE = '23503';
      END IF;
    END IF;

    v_inv_unit_cost := COALESCE((
      SELECT x.unit_cost FROM public.erp_inventory_s_539dcf81_b x
       WHERE x.product_id = d.product_id AND x.warehouse_id = h.warehouse_id
         AND x.tenant_id = h.tenant_id
         AND COALESCE(x.location_id, 0) = COALESCE(v_location_id, 0)
         AND COALESCE(NULLIF(BTRIM(x.batch_no), ''), '') = COALESCE(normalized_batch, '')
         AND x.stock_status = v_target_status AND x.is_deleted = 'n'), 0);

    IF v_is_out THEN
      -- 出库：成本取库存移动加权单价（与调拨出库口径一致）
      v_unit_cost := COALESCE(NULLIF(v_inv_unit_cost, 0),
        NULLIF(d.document_unit_cost, 0), NULLIF(d.product_unit_cost, 0), 0);
    ELSE
      -- 入库：成本取单据单价（成本卷算写入），再退物料成本价、库存单价
      v_unit_cost := COALESCE(NULLIF(d.document_unit_cost, 0),
        NULLIF(d.product_unit_cost, 0), NULLIF(v_inv_unit_cost, 0), 0);
    END IF;

    -- 出库先释放预占，再扣库存（顺序理由同 post_stock_document）
    IF v_is_out THEN
      v_consumed := public.inventory_consume_reservations(
        h.tenant_id, d.product_id, h.warehouse_id, v_location_id,
        normalized_batch, v_target_status, d.quantity);
    END IF;

    v_move := public.inventory_apply_move(
      p_tenant_id      => h.tenant_id,
      p_corp_id        => h.corp_id,
      p_actor_id       => actor_id,
      p_product_id     => d.product_id,
      p_warehouse_id   => h.warehouse_id,
      p_location_id    => v_location_id,
      p_batch_no       => normalized_batch,
      p_stock_status   => v_target_status,
      p_qty_delta      => CASE WHEN v_is_out THEN -d.quantity ELSE d.quantity END,
      p_unit_cost      => v_unit_cost,
      p_cost_delta     => NULL,
      p_expiry_date    => d.expiry_date,
      p_allow_negative => allow_negative);
    v_unit_cost := COALESCE((v_move ->> 'unit_cost')::NUMERIC, v_unit_cost);

    v_transaction_no := 'IT' || TO_CHAR(clock_timestamp(), 'YYYYMMDDHH24MISSMS')
      || LPAD(d.detail_id::TEXT, 6, '0');
    INSERT INTO public.erp_inventory_transactions_s_539dcf81_b (
      corp_id, emp_id, is_deleted, transaction_no, transaction_type,
      transaction_date, product_id, warehouse_id, location_id, batch_no,
      stock_status, quantity, unit_cost, total_cost, reference_type, reference_id,
      reference_detail_id, posting_idempotency_key, remark, tenant_id
    ) VALUES (
      h.corp_id, actor_id::TEXT, 'n', LEFT(v_transaction_no, 50),
      public.resolve_inventory_transaction_type(p_document_type, v_direction),
      h.document_date, d.product_id, h.warehouse_id, v_location_id,
      normalized_batch, v_target_status,
      CASE WHEN v_is_out THEN -d.quantity ELSE d.quantity END,
      v_unit_cost,
      COALESCE((v_move ->> 'cost_delta')::NUMERIC, 0),
      p_document_type, p_document_id, d.detail_id, p_idempotency_key,
      format('%s %s 过账', p_document_type, h.document_no),
      h.tenant_id
    );
  END LOOP;

  IF line_count = 0 THEN
    RAISE EXCEPTION 'Production document has no active details'
      USING ERRCODE = '23514';
  END IF;

  IF p_document_type = 'material_issue' THEN
    UPDATE public.erp_material_issues_s_539dcf81_b
    SET status = 'posted', posting_idempotency_key = p_idempotency_key,
        reversal_idempotency_key = NULL, posted_at = NOW(), reversed_at = NULL,
        updated_at = NOW()
    WHERE id = p_document_id;
  ELSIF p_document_type = 'production_receipt' THEN
    UPDATE public.erp_production_receipts_s_539dcf81_b
    SET status = 'posted', posting_idempotency_key = p_idempotency_key,
        reversal_idempotency_key = NULL, posted_at = NOW(), reversed_at = NULL,
        updated_at = NOW()
    WHERE id = p_document_id;

    -- 回写生产订单完成数量：完工入库过账后，把本次入库数累计到订单 completed_quantity。
    -- 累计 >= 计划数时自动置 completed（此前该字段无任何写入来源，恒为 0 —— 历史 bug）。
    IF h.production_order_id IS NOT NULL THEN
      UPDATE public.erp_production_orders_s_539dcf81_b o
         SET completed_quantity = COALESCE(o.completed_quantity, 0) + COALESCE(h.quantity, 0),
             updated_at = NOW()
       WHERE o.id = h.production_order_id
         AND o.tenant_id = h.tenant_id
         AND o.is_deleted = 'n'
      RETURNING completed_quantity, planned_quantity, status
        INTO v_order_completed, v_order_planned, v_order_status;

      IF FOUND
         AND v_order_completed >= COALESCE(v_order_planned, 0)
         AND v_order_planned > 0
         AND COALESCE(v_order_status, '') NOT IN ('completed', 'closed', 'cancelled') THEN
        UPDATE public.erp_production_orders_s_539dcf81_b
           SET status = 'completed', updated_at = NOW()
         WHERE id = h.production_order_id AND is_deleted = 'n';
      END IF;
    END IF;
  ELSE
    UPDATE public.erp_material_returns_s_539dcf81_b
    SET status = 'posted', posting_idempotency_key = p_idempotency_key,
        reversal_idempotency_key = NULL, posted_at = NOW(), reversed_at = NULL,
        updated_at = NOW()
    WHERE id = p_document_id;
  END IF;

  -- ---- 库存 -> 总账勾稽（deploy_87 / deploy_92）--------------------------
  v_voucher_result := public.inventory_sync_voucher(
    p_source_type   => p_document_type,
    p_source_id     => p_document_id,
    p_document_no   => h.document_no,
    p_document_date => h.document_date,
    p_tenant_id     => h.tenant_id,
    p_remark        => format('%s %s', p_document_type, h.document_no));

  RETURN jsonb_build_object('ok', TRUE, 'idempotent', FALSE,
    'document_type', p_document_type, 'document_id', p_document_id,
    'status', 'posted', 'line_count', line_count,
    'stock_status', v_target_status,
    'voucher', v_voucher_result,
    'idempotency_key', p_idempotency_key);
END;
$function$;


-- ============================================================================
-- 6/6  reverse_production_document：领料 / 完工入库 / 退料的反过账
-- ============================================================================
CREATE OR REPLACE FUNCTION public.reverse_production_document(p_document_type text, p_document_id integer, p_idempotency_key uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  h RECORD; t RECORD;
  actor_id INTEGER;
  line_count INTEGER := 0;
  v_target_status TEXT;
  v_move JSONB;
  v_voucher_result JSONB;
  -- 完工入库反过账回写生产订单（deploy_93 补丁，见 2026-10-19）
  v_order_completed NUMERIC; v_order_planned NUMERIC; v_order_status VARCHAR(20);
BEGIN
  IF p_document_type NOT IN ('material_issue', 'production_receipt', 'material_return') THEN
    RAISE EXCEPTION 'Unsupported production document type: %', p_document_type
      USING ERRCODE = '22023';
  END IF;
  IF p_document_id IS NULL OR p_document_id <= 0 OR p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'A positive document ID and idempotency key are required'
      USING ERRCODE = '22023';
  END IF;
  actor_id := public.current_sys_user_id();

  IF p_document_type = 'material_issue' THEN
    SELECT x.id, x.issue_no AS document_no, x.status, x.reversal_idempotency_key, x.tenant_id
    INTO h FROM public.erp_material_issues_s_539dcf81_b x
    WHERE x.id = p_document_id AND x.is_deleted = 'n' FOR UPDATE;
  ELSIF p_document_type = 'production_receipt' THEN
    SELECT x.id, x.receipt_no AS document_no, x.status, x.reversal_idempotency_key, x.tenant_id,
      x.production_order_id, x.quantity
    INTO h FROM public.erp_production_receipts_s_539dcf81_b x
    WHERE x.id = p_document_id AND x.is_deleted = 'n' FOR UPDATE;
  ELSE
    SELECT x.id, x.return_no AS document_no, x.status, x.reversal_idempotency_key, x.tenant_id
    INTO h FROM public.erp_material_returns_s_539dcf81_b x
    WHERE x.id = p_document_id AND x.is_deleted = 'n' FOR UPDATE;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Production document does not exist or is deleted'
      USING ERRCODE = 'P0002';
  END IF;
  IF h.status = 'draft' AND h.reversal_idempotency_key = p_idempotency_key THEN
    RETURN jsonb_build_object('ok', TRUE, 'idempotent', TRUE,
      'document_type', p_document_type, 'document_id', p_document_id,
      'status', 'draft');
  END IF;
  IF h.status <> 'posted' THEN
    RAISE EXCEPTION 'Only posted documents can be reversed; current status: %',
      COALESCE(h.status, '<null>') USING ERRCODE = '55000';
  END IF;

  FOR t IN
    SELECT x.* FROM public.erp_inventory_transactions_s_539dcf81_b x
    WHERE x.reference_type = p_document_type
      AND x.reference_id = p_document_id AND x.is_deleted = 'n'
    ORDER BY x.product_id, x.warehouse_id, COALESCE(x.location_id, 0),
             x.batch_no NULLS FIRST, COALESCE(x.stock_status, 'available'), x.id
    FOR UPDATE
  LOOP
    line_count := line_count + 1;
    v_target_status := COALESCE(NULLIF(BTRIM(t.stock_status), ''), 'available');

    -- 流水里的 quantity / total_cost 带符号：出库为负，入库为正。
    -- 减去流水即「撤销该笔影响」，方向自动正确。
    v_move := public.inventory_apply_move(
      p_tenant_id      => t.tenant_id,
      p_corp_id        => t.corp_id,
      p_actor_id       => actor_id,
      p_product_id     => t.product_id,
      p_warehouse_id   => t.warehouse_id,
      p_location_id    => t.location_id,
      p_batch_no       => t.batch_no,
      p_stock_status   => v_target_status,
      p_qty_delta      => -COALESCE(t.quantity, 0),
      p_unit_cost      => t.unit_cost,
      p_cost_delta     => -COALESCE(t.total_cost, 0),
      p_expiry_date    => NULL,
      p_allow_negative => NULL);
  END LOOP;
  IF line_count = 0 THEN
    RAISE EXCEPTION 'No active inventory transactions found'
      USING ERRCODE = 'P0002';
  END IF;

  UPDATE public.erp_inventory_transactions_s_539dcf81_b
  SET is_deleted = 'y', reversal_idempotency_key = p_idempotency_key,
      reversed_at = NOW(), updated_at = NOW()
  WHERE reference_type = p_document_type
    AND reference_id = p_document_id AND is_deleted = 'n';

  IF p_document_type = 'material_issue' THEN
    UPDATE public.erp_material_issues_s_539dcf81_b
    SET status = 'draft', reversal_idempotency_key = p_idempotency_key,
        reversed_at = NOW(), updated_at = NOW()
    WHERE id = p_document_id;
  ELSIF p_document_type = 'production_receipt' THEN
    UPDATE public.erp_production_receipts_s_539dcf81_b
    SET status = 'draft', reversal_idempotency_key = p_idempotency_key,
        reversed_at = NOW(), updated_at = NOW()
    WHERE id = p_document_id;

    -- 对称回写：反过账把本次入库数从订单 completed_quantity 扣回；
    -- 若订单此前因达标被自动置 completed，反过账后数量跌破计划数 → 退回 in_progress。
    IF h.production_order_id IS NOT NULL THEN
      UPDATE public.erp_production_orders_s_539dcf81_b o
         SET completed_quantity = GREATEST(0, COALESCE(o.completed_quantity, 0) - COALESCE(h.quantity, 0)),
             updated_at = NOW()
       WHERE o.id = h.production_order_id
         AND o.tenant_id = h.tenant_id
         AND o.is_deleted = 'n'
      RETURNING completed_quantity, planned_quantity, status
        INTO v_order_completed, v_order_planned, v_order_status;

      IF FOUND
         AND COALESCE(v_order_status, '') = 'completed'
         AND v_order_completed < COALESCE(v_order_planned, 0) THEN
        UPDATE public.erp_production_orders_s_539dcf81_b
           SET status = 'in_progress', updated_at = NOW()
         WHERE id = h.production_order_id AND is_deleted = 'n';
      END IF;
    END IF;
  ELSE
    UPDATE public.erp_material_returns_s_539dcf81_b
    SET status = 'draft', reversal_idempotency_key = p_idempotency_key,
        reversed_at = NOW(), updated_at = NOW()
    WHERE id = p_document_id;
  END IF;

  v_voucher_result := public.inventory_void_voucher(
    p_source_type     => p_document_type,
    p_source_id       => p_document_id,
    p_tenant_id       => h.tenant_id,
    p_idempotency_key => p_idempotency_key);

  RETURN jsonb_build_object('ok', TRUE, 'idempotent', FALSE,
    'document_type', p_document_type, 'document_id', p_document_id,
    'status', 'draft', 'line_count', line_count,
    'voucher', v_voucher_result,
    'idempotency_key', p_idempotency_key);
END;
$function$;


-- ============================================================================
-- 7. 自检（fail-loud）：逐条断言「新分支真的在函数体里」
-- ============================================================================
DO $$
DECLARE
  v_missing TEXT := '';
  v_src     TEXT;
  v_name    TEXT;
BEGIN
  -- ① 三种新单据必须出现在对应函数里
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'post_stock_document'
    AND pronamespace = 'public'::regnamespace LIMIT 1;
  IF v_src NOT ILIKE '%purchase_return%' OR v_src NOT ILIKE '%sales_return%' THEN
    v_missing := v_missing || 'post_stock_document 未支持退货单;';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'reverse_stock_document'
    AND pronamespace = 'public'::regnamespace LIMIT 1;
  IF v_src NOT ILIKE '%purchase_return%' OR v_src NOT ILIKE '%sales_return%' THEN
    v_missing := v_missing || 'reverse_stock_document 未支持退货单;';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'post_production_document'
    AND pronamespace = 'public'::regnamespace LIMIT 1;
  IF v_src NOT ILIKE '%material_return%' THEN
    v_missing := v_missing || 'post_production_document 未支持生产退料;';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'reverse_production_document'
    AND pronamespace = 'public'::regnamespace LIMIT 1;
  IF v_src NOT ILIKE '%material_return%' THEN
    v_missing := v_missing || 'reverse_production_document 未支持生产退料;';
  END IF;

  -- ② 状态维度：所有 6 个函数都必须经过 apply_move
  FOR v_src IN
    SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('post_stock_document','reverse_stock_document',
                         'post_inventory_document','reverse_inventory_document',
                         'post_production_document','reverse_production_document')
       AND p.prosrc NOT ILIKE '%inventory_apply_move%'
  LOOP
    v_missing := v_missing || format('%s 未走 inventory_apply_move;', v_src);
  END LOOP;

  -- ③ 反过账必须带 stock_status 定位
  FOR v_src IN
    SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('reverse_stock_document','reverse_inventory_document',
                         'reverse_production_document')
       AND p.prosrc NOT ILIKE '%stock_status%'
  LOOP
    v_missing := v_missing || format('%s 未按 stock_status 定位库存行;', v_src);
  END LOOP;

  -- ④ 写入必须带 tenant_id（旧版靠 GUC 兜底的三个函数）
  FOR v_src IN
    SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('post_inventory_document','post_production_document')
       AND p.prosrc NOT ILIKE '%tenant_id%'
  LOOP
    v_missing := v_missing || format('%s 仍未显式传 tenant_id;', v_src);
  END LOOP;

  -- ⑤ 反过账必须作废凭证（deploy_87 的回归点）
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'reverse_inventory_document'
    AND pronamespace = 'public'::regnamespace LIMIT 1;
  IF v_src NOT ILIKE '%inventory_void_voucher%' THEN
    v_missing := v_missing || 'reverse_inventory_document 未作废凭证（deploy_87 回归）;';
  END IF;

  -- ⑥ 出库必须消耗预占
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'post_stock_document'
    AND pronamespace = 'public'::regnamespace LIMIT 1;
  IF v_src NOT ILIKE '%inventory_consume_reservations%' THEN
    v_missing := v_missing || 'post_stock_document 未消耗预占;';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'post_production_document'
    AND pronamespace = 'public'::regnamespace LIMIT 1;
  IF v_src NOT ILIKE '%inventory_consume_reservations%' THEN
    v_missing := v_missing || 'post_production_document 未消耗预占;';
  END IF;

  -- ⑥ 出库必须先释放预占、再扣库存（见文件头 ③ 的顺序说明）。
  --    只对确实调用预占释放的两个函数做位置断言。
  FOR v_name, v_src IN
    SELECT x.fn, x.src FROM (VALUES
      ('post_stock_document',      (SELECT prosrc FROM pg_proc
         WHERE proname = 'post_stock_document' AND pronamespace = 'public'::regnamespace)),
      ('post_production_document', (SELECT prosrc FROM pg_proc
         WHERE proname = 'post_production_document' AND pronamespace = 'public'::regnamespace))
    ) AS x(fn, src)
  LOOP
    IF position('inventory_consume_reservations' IN v_src)
       > position('inventory_apply_move' IN v_src) THEN
      v_missing := v_missing
        || format('%s 的预占释放排在扣库存之后（顺序错误，会误判超发）;', v_name);
    END IF;
  END LOOP;

  IF v_missing <> '' THEN
    RAISE EXCEPTION 'deploy_93 自检失败：%', v_missing;
  END IF;

  RAISE NOTICE 'deploy_93 OK：6 个过账 RPC 已支持退货单 / 库存状态 / 预占消耗 / 凭证作废';
END;
$$;
