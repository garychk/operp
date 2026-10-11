-- ============================================================================
-- P1-4 + P1-5：库存状态维度（available / inspection / hold / rejected）
--              与库存预留（locked_quantity 真正生效 + ATP 可用量）
-- ============================================================================
--
-- 背景
-- ----
-- 改造前 `erp_inventory` 每个 (物料, 仓库, 库位, 批次) 只有一行，没有状态维度：
--   · 无法区分 合格 / 待检 / 冻结 / 不合格 —— 不良品随时可以被发出（差距清单 C1）；
--   · `available_quantity` 在插入时恒等于 `quantity`，`locked_quantity` 永远写死 0，
--     全库没有任何 UPDATE —— 既没有预留、也没有 ATP（差距清单 C3）。
--
-- 本文件做两件事：
--   1. 给库存行加 `stock_status`，并**纳入唯一键** —— 同一个库位可以同时存在
--      「可用 100 / 待检 20 / 不合格 5」三行，这是标准 ERP 的建模方式。
--      同时给 `erp_inventory_transactions` 也加 `stock_status`，让流水能精确指回
--      它改的是哪一行（否则冲销时无法定位：同库位同批次会有多行）。
--   2. 建 `erp_inventory_reservations` + 预留 RPC，让 `locked_quantity` 真正被读写，
--      并给出 ATP 视图。
--
-- 关键口径（后续所有出入库 RPC 都必须遵守）
-- ------------------------------------------
--   · `available_quantity` 的语义固定为「**该状态行**可发量」：
--        stock_status = 'available'  →  quantity - locked_quantity
--        其余状态（inspection / hold / rejected） →  0（不可发）
--     这样下游（MRP 引擎、库存查询、ATP）只要继续读 available_quantity 就自动
--     把待检/冻结/不合格库存排除在外，不需要各自记住状态规则。
--   · 入库落到哪个状态由配置 `inventory.receiptStockStatus` 决定
--     （'available' 或 'inspection'，即「入库即待检」开关）。
--   · 出库只允许从 stock_status='available' 的行扣减。
--   · 盘点/调整单的状态取明细行自带的状态（默认 'available'）。
--
-- 本脚本由 000_run_all 用 psql --single-transaction 执行，**不要写 BEGIN/COMMIT**。
-- 依赖：deploy_85（唯一键修正）、deploy_51（分租户唯一键）、deploy_24（库存单据）。
-- ============================================================================

-- ============================================================================
-- 1. 列：库存行 / 流水 / 盘点明细 / 调整明细
-- ============================================================================
ALTER TABLE public.erp_inventory_s_539dcf81_b
  ADD COLUMN IF NOT EXISTS stock_status VARCHAR(20) NOT NULL DEFAULT 'available';

ALTER TABLE public.erp_inventory_transactions_s_539dcf81_b
  ADD COLUMN IF NOT EXISTS stock_status VARCHAR(20);

ALTER TABLE public.erp_stock_count_details_s_539dcf81_b
  ADD COLUMN IF NOT EXISTS stock_status VARCHAR(20) NOT NULL DEFAULT 'available';

ALTER TABLE public.erp_stock_adjustment_details_s_539dcf81_b
  ADD COLUMN IF NOT EXISTS stock_status VARCHAR(20) NOT NULL DEFAULT 'available';

-- 枚举约束（幂等：先删后建）
ALTER TABLE public.erp_inventory_s_539dcf81_b
  DROP CONSTRAINT IF EXISTS chk_erp_inventory_stock_status;
ALTER TABLE public.erp_inventory_s_539dcf81_b
  ADD CONSTRAINT chk_erp_inventory_stock_status
  CHECK (stock_status IN ('available', 'inspection', 'hold', 'rejected'));

ALTER TABLE public.erp_inventory_transactions_s_539dcf81_b
  DROP CONSTRAINT IF EXISTS chk_erp_inventory_txn_stock_status;
ALTER TABLE public.erp_inventory_transactions_s_539dcf81_b
  ADD CONSTRAINT chk_erp_inventory_txn_stock_status
  CHECK (stock_status IS NULL OR stock_status IN ('available', 'inspection', 'hold', 'rejected'));

ALTER TABLE public.erp_stock_count_details_s_539dcf81_b
  DROP CONSTRAINT IF EXISTS chk_erp_stock_count_details_stock_status;
ALTER TABLE public.erp_stock_count_details_s_539dcf81_b
  ADD CONSTRAINT chk_erp_stock_count_details_stock_status
  CHECK (stock_status IN ('available', 'inspection', 'hold', 'rejected'));

ALTER TABLE public.erp_stock_adjustment_details_s_539dcf81_b
  DROP CONSTRAINT IF EXISTS chk_erp_stock_adjustment_details_stock_status;
ALTER TABLE public.erp_stock_adjustment_details_s_539dcf81_b
  ADD CONSTRAINT chk_erp_stock_adjustment_details_stock_status
  CHECK (stock_status IN ('available', 'inspection', 'hold', 'rejected'));

COMMENT ON COLUMN public.erp_inventory_s_539dcf81_b.stock_status IS
  '库存状态：available 可用 / inspection 待检 / hold 冻结 / rejected 不合格。参与唯一键。';
COMMENT ON COLUMN public.erp_inventory_s_539dcf81_b.available_quantity IS
  '本状态行可发量。available 行 = quantity - locked_quantity；其余状态恒为 0（不可发）。';
COMMENT ON COLUMN public.erp_inventory_transactions_s_539dcf81_b.stock_status IS
  '本笔流水改动的库存行状态，用于冲销时精确定位（同库位同批次可能有多行不同状态）。';

-- ============================================================================
-- 2. 唯一键重建：纳入 stock_status
--    deploy_85 建的 uq_erp_inventory_active_stock_t 不含 stock_status，
--    留着会导致「可用 100 + 待检 20」两行插入时撞键。
-- ============================================================================
DO $$
DECLARE
  v_dup INTEGER;
  v_sample TEXT;
BEGIN
  SELECT count(*), string_agg(DISTINCT format('物料%s/仓库%s/库位%s/批次%s/%s',
           product_id, warehouse_id, COALESCE(location_id, 0),
           COALESCE(NULLIF(BTRIM(batch_no), ''), '<空>'), stock_status), '; ')
    INTO v_dup, v_sample
    FROM public.erp_inventory_s_539dcf81_b
   WHERE is_deleted = 'n'
   GROUP BY product_id, warehouse_id, COALESCE(location_id, 0),
            COALESCE(NULLIF(BTRIM(batch_no), ''), ''), stock_status, tenant_id
  HAVING count(*) > 1;

  IF COALESCE(v_dup, 0) > 0 THEN
    RAISE EXCEPTION '库存表存在重复活跃行（% 组），无法建唯一键。样例：%', v_dup, v_sample
      USING ERRCODE = '23505';
  END IF;
END;
$$;

DROP INDEX IF EXISTS public.uq_erp_inventory_active_stock_t;

CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_inventory_active_stock_s
  ON public.erp_inventory_s_539dcf81_b (
    product_id,
    warehouse_id,
    COALESCE(location_id, 0),
    (COALESCE(NULLIF(BTRIM(batch_no), ''), '')),
    stock_status,
    tenant_id
  ) WHERE is_deleted = 'n';

-- 出库热路径：按 物料+仓库+状态 找可发行
CREATE INDEX IF NOT EXISTS idx_erp_inventory_product_wh_status
  ON public.erp_inventory_s_539dcf81_b (tenant_id, product_id, warehouse_id, stock_status)
  WHERE is_deleted = 'n';

CREATE INDEX IF NOT EXISTS idx_erp_inventory_txn_stock_status
  ON public.erp_inventory_transactions_s_539dcf81_b (tenant_id, product_id, warehouse_id, stock_status)
  WHERE is_deleted = 'n';

-- ============================================================================
-- 3. 配置：入库落哪个状态（「入库即待检」开关）
--    sys_config 是「分类 + config_json」结构（不是键值表）。
--    deploy_07 已建 basic/finance/manufacturing/quality/ai 五类，这里补 inventory 类。
-- ============================================================================
INSERT INTO public.sys_config (
  category_code, category_name, config_json, description, status, sort_order, is_deleted, tenant_id
)
SELECT 'inventory', '库存设置',
       jsonb_build_object(
         'receiptStockStatus', 'available',
         'allowNegativeStockDefault', FALSE,
         'reserveOnOrderRelease', TRUE
       ),
       '入库默认库存状态（available 直接可用 / inspection 入库即待检）、负库存默认策略、单据下发票时是否自动预占库存。',
       '1', 6, 'n', NULL
WHERE NOT EXISTS (
  SELECT 1 FROM public.sys_config c
   WHERE c.tenant_id IS NULL AND c.category_code = 'inventory'
);

-- ============================================================================
-- 4. 读配置的 SECURITY DEFINER 助手
--    过账 RPC 是 SECURITY INVOKER，直接读 sys_config 会撞 RLS；与
--    deploy_40 的 resolve_inventory_transaction_type 同一思路。
-- ============================================================================
CREATE OR REPLACE FUNCTION public.inventory_receipt_stock_status(p_tenant_id BIGINT DEFAULT NULL)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_raw TEXT;
BEGIN
  SELECT c.config_json ->> 'receiptStockStatus'
    INTO v_raw
    FROM public.sys_config c
   WHERE c.is_deleted = 'n'
     AND c.category_code = 'inventory'
     AND (c.tenant_id = p_tenant_id OR c.tenant_id IS NULL)
   ORDER BY CASE WHEN c.tenant_id = p_tenant_id THEN 0 ELSE 1 END, c.id DESC
   LIMIT 1;

  v_raw := LOWER(COALESCE(NULLIF(BTRIM(v_raw), ''), 'available'));
  IF v_raw NOT IN ('available', 'inspection', 'hold', 'rejected') THEN
    -- 配置写错不让入库失败，退回安全值并告警（与 deploy_40 的兜底哲学一致）
    RAISE WARNING 'inventory.receiptStockStatus 取值非法（%），按 available 处理', v_raw;
    v_raw := 'available';
  END IF;
  RETURN v_raw;
END;
$$;

GRANT EXECUTE ON FUNCTION public.inventory_receipt_stock_status(BIGINT) TO authenticated;

-- ============================================================================
-- 5. 库存行增减的唯一入口
--    所有出入库 RPC 都改走这里，状态维度 / 可用量口径 / 负库存校验 / 并发锁
--    只在这一个地方实现，避免 6 个 RPC 各写一遍再各错一遍。
-- ============================================================================
CREATE OR REPLACE FUNCTION public.inventory_apply_move(
  p_tenant_id      BIGINT,
  p_corp_id        VARCHAR,
  p_actor_id       INTEGER,
  p_product_id     INTEGER,
  p_warehouse_id   INTEGER,
  p_location_id    INTEGER,
  p_batch_no       TEXT,
  p_stock_status   TEXT,
  p_qty_delta      NUMERIC,
  p_unit_cost      NUMERIC DEFAULT NULL,
  p_cost_delta     NUMERIC DEFAULT NULL,
  p_expiry_date    DATE    DEFAULT NULL,
  p_allow_negative BOOLEAN DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_status TEXT := LOWER(COALESCE(NULLIF(BTRIM(p_stock_status), ''), 'available'));
  v_batch  TEXT := NULLIF(BTRIM(p_batch_no), '');
  i RECORD;
  old_qty NUMERIC; old_available NUMERIC; old_cost NUMERIC; old_locked NUMERIC;
  new_qty NUMERIC; new_available NUMERIC; new_cost NUMERIC;
  v_unit_cost NUMERIC; v_cost_delta NUMERIC; v_allow BOOLEAN;
BEGIN
  IF p_tenant_id IS NULL OR p_product_id IS NULL OR p_warehouse_id IS NULL THEN
    RAISE EXCEPTION 'inventory_apply_move 需要 tenant/product/warehouse'
      USING ERRCODE = '23502';
  END IF;
  IF v_status NOT IN ('available', 'inspection', 'hold', 'rejected') THEN
    RAISE EXCEPTION '非法库存状态：%', p_stock_status USING ERRCODE = '23514';
  END IF;

  v_allow := p_allow_negative;
  IF v_allow IS NULL THEN
    SELECT COALESCE(w.is_negative_stock_allowed, FALSE) INTO v_allow
      FROM public.erp_warehouses_s_539dcf81_b w
     WHERE w.id = p_warehouse_id AND w.tenant_id = p_tenant_id AND w.is_deleted = 'n';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Warehouse does not exist or is deleted' USING ERRCODE = 'P0002';
    END IF;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    format('erp_inventory:%s:%s:%s:%s:%s', p_product_id, p_warehouse_id,
           COALESCE(p_location_id, 0), COALESCE(v_batch, ''), v_status), 0));

  SELECT x.* INTO i FROM public.erp_inventory_s_539dcf81_b x
   WHERE x.product_id = p_product_id
     AND x.warehouse_id = p_warehouse_id
     AND x.tenant_id = p_tenant_id
     AND COALESCE(x.location_id, 0) = COALESCE(p_location_id, 0)
     AND COALESCE(NULLIF(BTRIM(x.batch_no), ''), '') = COALESCE(v_batch, '')
     AND x.stock_status = v_status
     AND x.is_deleted = 'n'
   FOR UPDATE;

  IF FOUND THEN
    old_qty      := COALESCE(i.quantity, 0);
    old_available := COALESCE(i.available_quantity, 0);
    old_cost     := COALESCE(i.total_cost, 0);
    old_locked   := COALESCE(i.locked_quantity, 0);
  ELSE
    old_qty := 0; old_available := 0; old_cost := 0; old_locked := 0;
  END IF;

  -- 成本单价口径：入库优先用单据价，出库优先用库存移动加权
  IF COALESCE(p_qty_delta, 0) >= 0 THEN
    v_unit_cost := COALESCE(NULLIF(p_unit_cost, 0), NULLIF(i.unit_cost, 0), 0);
  ELSE
    v_unit_cost := COALESCE(NULLIF(i.unit_cost, 0), NULLIF(p_unit_cost, 0), 0);
  END IF;

  v_cost_delta := COALESCE(p_cost_delta, COALESCE(p_qty_delta, 0) * v_unit_cost);
  new_qty      := old_qty + COALESCE(p_qty_delta, 0);
  new_cost     := old_cost + v_cost_delta;
  new_available := CASE WHEN v_status = 'available' THEN new_qty - old_locked ELSE 0 END;

  IF NOT v_allow AND (new_qty < 0 OR new_available < 0) THEN
    RAISE EXCEPTION
      'Insufficient stock for product %, warehouse %, location %, status %: on hand %, available %, requested %',
      p_product_id, p_warehouse_id, COALESCE(p_location_id, 0), v_status,
      old_qty, old_available, ABS(COALESCE(p_qty_delta, 0))
      USING ERRCODE = '23514';
  END IF;
  IF i.id IS NULL AND COALESCE(p_qty_delta, 0) < 0 AND NOT v_allow THEN
    RAISE EXCEPTION
      '无法出库：物料 % 在仓库 % 库位 % 状态 % 下没有库存行',
      p_product_id, p_warehouse_id, COALESCE(p_location_id, 0), v_status
      USING ERRCODE = '23514';
  END IF;

  IF i.id IS NULL THEN
    INSERT INTO public.erp_inventory_s_539dcf81_b (
      corp_id, emp_id, is_deleted, product_id, warehouse_id, location_id,
      stock_status, quantity, available_quantity, locked_quantity,
      unit_cost, total_cost, batch_no, expiry_date, tenant_id
    ) VALUES (
      p_corp_id, p_actor_id::TEXT, 'n', p_product_id, p_warehouse_id, p_location_id,
      v_status, new_qty, new_available, 0,
      CASE WHEN new_qty = 0 THEN v_unit_cost ELSE ABS(new_cost / new_qty) END,
      new_cost, v_batch, p_expiry_date, p_tenant_id
    ) RETURNING * INTO i;
  ELSE
    UPDATE public.erp_inventory_s_539dcf81_b
       SET quantity           = new_qty,
           available_quantity = new_available,
           unit_cost          = CASE WHEN new_qty = 0 THEN v_unit_cost
                                     ELSE ABS(new_cost / new_qty) END,
           total_cost         = new_cost,
           expiry_date        = COALESCE(p_expiry_date, expiry_date),
           updated_at         = NOW()
     WHERE id = i.id;
  END IF;

  RETURN jsonb_build_object(
    'id', i.id,
    'stock_status', v_status,
    'unit_cost', v_unit_cost,
    'cost_delta', v_cost_delta,
    'old_qty', old_qty, 'old_available', old_available, 'old_cost', old_cost,
    'new_qty', new_qty, 'new_available', new_available, 'new_cost', new_cost);
END;
$$;

GRANT EXECUTE ON FUNCTION public.inventory_apply_move(
  BIGINT, VARCHAR, INTEGER, INTEGER, INTEGER, INTEGER, TEXT, TEXT, NUMERIC, NUMERIC, NUMERIC, DATE, BOOLEAN
) TO authenticated;

-- ============================================================================
-- 6. 预留表：让 locked_quantity 真正被读写
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.erp_inventory_reservations_s_539dcf81_b (
  id SERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL DEFAULT current_tenant_id(),
  corp_id VARCHAR(128),
  emp_id VARCHAR(128),
  is_deleted CHAR(1) NOT NULL DEFAULT 'n',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  product_id INTEGER NOT NULL,
  warehouse_id INTEGER NOT NULL,
  location_id INTEGER,
  batch_no VARCHAR(100),
  stock_status VARCHAR(20) NOT NULL DEFAULT 'available',
  quantity NUMERIC NOT NULL DEFAULT 0,            -- 预占数量
  consumed_quantity NUMERIC NOT NULL DEFAULT 0,   -- 已因过账消耗
  released_quantity NUMERIC NOT NULL DEFAULT 0,   -- 已人工释放
  source_type VARCHAR(50) NOT NULL,               -- sales_order / production_order / ...
  source_id INTEGER NOT NULL,
  source_detail_id INTEGER,
  source_no VARCHAR(50),
  status VARCHAR(20) NOT NULL DEFAULT 'open',     -- open / consumed / released / cancelled
  remark VARCHAR(255),
  CONSTRAINT chk_erp_inv_reservation_status
    CHECK (status IN ('open', 'consumed', 'released', 'cancelled')),
  CONSTRAINT chk_erp_inv_reservation_qty CHECK (quantity >= 0),
  CONSTRAINT chk_erp_inv_reservation_stock_status
    CHECK (stock_status IN ('available', 'inspection', 'hold', 'rejected'))
);

-- 同一来源单据同一条明细的同一个库存维度只允许一条活跃预占
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_inv_reservation_source
  ON public.erp_inventory_reservations_s_539dcf81_b (
    tenant_id, source_type, source_id,
    COALESCE(source_detail_id, 0), product_id, warehouse_id,
    COALESCE(location_id, 0), COALESCE(NULLIF(BTRIM(batch_no), ''), '')
  ) WHERE is_deleted = 'n';

CREATE INDEX IF NOT EXISTS idx_erp_inv_reservation_open
  ON public.erp_inventory_reservations_s_539dcf81_b (
    tenant_id, product_id, warehouse_id, COALESCE(location_id, 0), id)
  WHERE is_deleted = 'n' AND status = 'open';

CREATE INDEX IF NOT EXISTS idx_erp_inv_reservation_source_lookup
  ON public.erp_inventory_reservations_s_539dcf81_b (tenant_id, source_type, source_id)
  WHERE is_deleted = 'n';

GRANT SELECT, INSERT, UPDATE, DELETE ON public.erp_inventory_reservations_s_539dcf81_b TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.erp_inventory_reservations_s_539dcf81_b_id_seq TO authenticated;
SELECT public.install_role_table_rls('erp_inventory_reservations_s_539dcf81_b');
SELECT public.refresh_sys_tables();

-- ============================================================================
-- 7. 预占 / 释放 / 消耗 RPC
-- ============================================================================

-- 7.1 批量预占：p_lines 形如
--     [{"product_id":1,"location_id":3,"batch_no":"L1","quantity":10,
--       "source_detail_id":7,"stock_status":"available"}]
CREATE OR REPLACE FUNCTION public.reserve_inventory_stock(
  p_source_type     TEXT,
  p_source_id       INTEGER,
  p_source_no       TEXT,
  p_warehouse_id    INTEGER,
  p_lines           JSONB,
  p_idempotency_key UUID,
  p_tenant_id       BIGINT DEFAULT NULL,
  p_allow_shortage  BOOLEAN DEFAULT TRUE
) RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_tenant BIGINT := COALESCE(p_tenant_id, public.current_tenant_id());
  v_corp VARCHAR(128);
  actor_id INTEGER := public.current_sys_user_id();
  v_line RECORD;
  v_status TEXT;
  v_batch TEXT;
  v_reserved NUMERIC;
  v_on_hand NUMERIC;
  v_locked INTEGER := 0;
  v_total NUMERIC := 0;
  v_row RECORD;
BEGIN
  IF p_source_type IS NULL OR p_source_id IS NULL OR p_warehouse_id IS NULL
     OR p_idempotency_key IS NULL THEN
    RAISE EXCEPTION '预占需要 source_type / source_id / warehouse_id / idempotency_key'
      USING ERRCODE = '22023';
  END IF;

  SELECT h.corp_id INTO v_corp
    FROM public.erp_warehouses_s_539dcf81_b h
   WHERE h.id = p_warehouse_id AND h.tenant_id = v_tenant AND h.is_deleted = 'n'
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Warehouse does not exist or is deleted' USING ERRCODE = 'P0002';
  END IF;

  -- 幂等：同一来源已有活跃预占 → 直接返回
  IF EXISTS (
    SELECT 1 FROM public.erp_inventory_reservations_s_539dcf81_b r
     WHERE r.tenant_id = v_tenant AND r.source_type = p_source_type
       AND r.source_id = p_source_id AND r.is_deleted = 'n' AND r.status = 'open'
  ) THEN
    RETURN jsonb_build_object('ok', TRUE, 'idempotent', TRUE,
      'source_type', p_source_type, 'source_id', p_source_id);
  END IF;

  FOR v_line IN
    SELECT (e ->> 'product_id')::INTEGER          AS product_id,
           (e ->> 'location_id')::INTEGER         AS location_id,
           NULLIF(BTRIM(e ->> 'batch_no'), '')    AS batch_no,
           COALESCE((e ->> 'quantity')::NUMERIC, 0) AS quantity,
           (e ->> 'source_detail_id')::INTEGER    AS source_detail_id,
           COALESCE(NULLIF(BTRIM(e ->> 'stock_status'), ''), 'available') AS stock_status
      FROM jsonb_array_elements(COALESCE(p_lines, '[]'::JSONB)) e
  LOOP
    CONTINUE WHEN v_line.product_id IS NULL OR v_line.quantity <= 0;
    v_status := LOWER(v_line.stock_status);
    IF v_status NOT IN ('available', 'inspection', 'hold', 'rejected') THEN
      v_status := 'available';
    END IF;
    v_batch := v_line.batch_no;

    PERFORM pg_advisory_xact_lock(hashtextextended(
      format('erp_inventory:%s:%s:%s:%s:%s', v_line.product_id, p_warehouse_id,
             COALESCE(v_line.location_id, 0), COALESCE(v_batch, ''), v_status), 0));

    SELECT x.* INTO v_row FROM public.erp_inventory_s_539dcf81_b x
     WHERE x.product_id = v_line.product_id AND x.warehouse_id = p_warehouse_id
       AND x.tenant_id = v_tenant
       AND COALESCE(x.location_id, 0) = COALESCE(v_line.location_id, 0)
       AND COALESCE(NULLIF(BTRIM(x.batch_no), ''), '') = COALESCE(v_batch, '')
       AND x.stock_status = v_status
       AND x.is_deleted = 'n'
     FOR UPDATE;

    v_on_hand := COALESCE(v_row.quantity, 0);
    IF NOT p_allow_shortage
       AND v_on_hand - COALESCE(v_row.locked_quantity, 0) < v_line.quantity THEN
      RAISE EXCEPTION
        '预占失败：物料 % 仓库 % 库位 % 状态 % 可发量不足（现有 % / 已占 % / 需占 %）',
        v_line.product_id, p_warehouse_id, COALESCE(v_line.location_id, 0), v_status,
        v_on_hand, COALESCE(v_row.locked_quantity, 0), v_line.quantity
        USING ERRCODE = '23514';
    END IF;

    -- 库存行不存在也允许登记预占（备货型缺口），但此时无可锁定
    IF v_row.id IS NOT NULL THEN
      UPDATE public.erp_inventory_s_539dcf81_b
         SET locked_quantity = COALESCE(locked_quantity, 0) + v_line.quantity,
             available_quantity = CASE WHEN stock_status = 'available'
                                       THEN quantity - (COALESCE(locked_quantity, 0) + v_line.quantity)
                                       ELSE 0 END,
             updated_at = NOW()
       WHERE id = v_row.id;
    END IF;

    INSERT INTO public.erp_inventory_reservations_s_539dcf81_b (
      corp_id, emp_id, is_deleted, product_id, warehouse_id, location_id, batch_no,
      stock_status, quantity, source_type, source_id, source_detail_id, source_no,
      status, remark, tenant_id
    ) VALUES (
      v_corp, actor_id::TEXT, 'n', v_line.product_id, p_warehouse_id, v_line.location_id, v_batch,
      v_status, v_line.quantity, p_source_type, p_source_id, v_line.source_detail_id, p_source_no,
      'open', NULL, v_tenant
    );

    v_locked := v_locked + 1;
    v_total := v_total + v_line.quantity;
  END LOOP;

  RETURN jsonb_build_object('ok', TRUE, 'idempotent', FALSE,
    'source_type', p_source_type, 'source_id', p_source_id,
    'line_count', v_locked, 'reserved_quantity', v_total);
END;
$$;

GRANT EXECUTE ON FUNCTION public.reserve_inventory_stock(
  TEXT, INTEGER, TEXT, INTEGER, JSONB, UUID, BIGINT, BOOLEAN) TO authenticated;

-- 7.2 人工释放某来源的全部未消耗预占
CREATE OR REPLACE FUNCTION public.release_inventory_reservations(
  p_source_type     TEXT,
  p_source_id       INTEGER,
  p_idempotency_key UUID,
  p_tenant_id       BIGINT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_tenant BIGINT := COALESCE(p_tenant_id, public.current_tenant_id());
  r RECORD;
  v_remaining NUMERIC;
  v_count INTEGER := 0;
BEGIN
  IF p_source_type IS NULL OR p_source_id IS NULL OR p_idempotency_key IS NULL THEN
    RAISE EXCEPTION '释放预占需要 source_type / source_id / idempotency_key'
      USING ERRCODE = '22023';
  END IF;

  FOR r IN
    SELECT x.* FROM public.erp_inventory_reservations_s_539dcf81_b x
     WHERE x.tenant_id = v_tenant AND x.source_type = p_source_type
       AND x.source_id = p_source_id AND x.is_deleted = 'n' AND x.status = 'open'
     ORDER BY x.product_id, x.warehouse_id, COALESCE(x.location_id, 0), x.id
     FOR UPDATE
  LOOP
    v_remaining := GREATEST(COALESCE(r.quantity, 0) - COALESCE(r.consumed_quantity, 0)
                            - COALESCE(r.released_quantity, 0), 0);

    IF v_remaining > 0 THEN
      PERFORM public.inventory_release_locked(
        v_tenant, r.product_id, r.warehouse_id, r.location_id, r.batch_no,
        r.stock_status, v_remaining);
    END IF;

    UPDATE public.erp_inventory_reservations_s_539dcf81_b
       SET status = 'released',
           released_quantity = COALESCE(released_quantity, 0) + v_remaining,
           updated_at = NOW()
     WHERE id = r.id;
    v_count := v_count + 1;
  END LOOP;

  RETURN jsonb_build_object('ok', TRUE, 'source_type', p_source_type,
    'source_id', p_source_id, 'released_lines', v_count);
END;
$$;

GRANT EXECUTE ON FUNCTION public.release_inventory_reservations(TEXT, INTEGER, UUID, BIGINT) TO authenticated;

-- 7.3 锁定量的原子增减（供预占/释放/过账消耗共用）
CREATE OR REPLACE FUNCTION public.inventory_release_locked(
  p_tenant_id    BIGINT,
  p_product_id   INTEGER,
  p_warehouse_id INTEGER,
  p_location_id  INTEGER,
  p_batch_no     TEXT,
  p_stock_status TEXT,
  p_quantity     NUMERIC
) RETURNS NUMERIC
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_status TEXT := COALESCE(NULLIF(BTRIM(p_stock_status), ''), 'available');
  v_batch TEXT := NULLIF(BTRIM(p_batch_no), '');
  v_id INTEGER;
  v_locked NUMERIC;
BEGIN
  IF COALESCE(p_quantity, 0) <= 0 THEN RETURN 0; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    format('erp_inventory:%s:%s:%s:%s:%s', p_product_id, p_warehouse_id,
           COALESCE(p_location_id, 0), COALESCE(v_batch, ''), v_status), 0));

  SELECT x.id, COALESCE(x.locked_quantity, 0) INTO v_id, v_locked
    FROM public.erp_inventory_s_539dcf81_b x
   WHERE x.product_id = p_product_id AND x.warehouse_id = p_warehouse_id
     AND x.tenant_id = p_tenant_id
     AND COALESCE(x.location_id, 0) = COALESCE(p_location_id, 0)
     AND COALESCE(NULLIF(BTRIM(x.batch_no), ''), '') = COALESCE(v_batch, '')
     AND x.stock_status = v_status
     AND x.is_deleted = 'n'
   FOR UPDATE;

  IF v_id IS NULL THEN RETURN 0; END IF;

  v_locked := GREATEST(v_locked - p_quantity, 0);

  UPDATE public.erp_inventory_s_539dcf81_b
     SET locked_quantity = v_locked,
         available_quantity = CASE WHEN stock_status = 'available'
                                   THEN quantity - v_locked ELSE 0 END,
         updated_at = NOW()
   WHERE id = v_id;

  RETURN v_locked;
END;
$$;

GRANT EXECUTE ON FUNCTION public.inventory_release_locked(BIGINT, INTEGER, INTEGER, INTEGER, TEXT, TEXT, NUMERIC) TO authenticated;

-- 7.4 过账时消耗预占：按 id FIFO 扣减未消耗部分，并同步减 locked_quantity
CREATE OR REPLACE FUNCTION public.inventory_consume_reservations(
  p_tenant_id    BIGINT,
  p_product_id   INTEGER,
  p_warehouse_id INTEGER,
  p_location_id  INTEGER,
  p_batch_no     TEXT,
  p_stock_status TEXT,
  p_quantity     NUMERIC
) RETURNS NUMERIC
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_status TEXT := COALESCE(NULLIF(BTRIM(p_stock_status), ''), 'available');
  v_batch TEXT := NULLIF(BTRIM(p_batch_no), '');
  r RECORD;
  v_left NUMERIC := COALESCE(p_quantity, 0);
  v_take NUMERIC;
  v_total NUMERIC := 0;
BEGIN
  IF v_left <= 0 THEN RETURN 0; END IF;

  FOR r IN
    SELECT x.* FROM public.erp_inventory_reservations_s_539dcf81_b x
     WHERE x.tenant_id = p_tenant_id AND x.product_id = p_product_id
       AND x.warehouse_id = p_warehouse_id
       AND COALESCE(x.location_id, 0) = COALESCE(p_location_id, 0)
       AND COALESCE(NULLIF(BTRIM(x.batch_no), ''), '') = COALESCE(v_batch, '')
       AND x.stock_status = v_status
       AND x.is_deleted = 'n' AND x.status = 'open'
     ORDER BY x.id
     FOR UPDATE
  LOOP
    EXIT WHEN v_left <= 0;
    v_take := LEAST(v_left,
      GREATEST(COALESCE(r.quantity, 0) - COALESCE(r.consumed_quantity, 0)
               - COALESCE(r.released_quantity, 0), 0));
    CONTINUE WHEN v_take <= 0;

    UPDATE public.erp_inventory_reservations_s_539dcf81_b
       SET consumed_quantity = COALESCE(consumed_quantity, 0) + v_take,
           status = CASE
             WHEN COALESCE(consumed_quantity, 0) + v_take
                  >= COALESCE(quantity, 0) - COALESCE(released_quantity, 0)
             THEN 'consumed' ELSE 'open' END,
           updated_at = NOW()
     WHERE id = r.id;

    v_left := v_left - v_take;
    v_total := v_total + v_take;
  END LOOP;

  IF v_total > 0 THEN
    PERFORM public.inventory_release_locked(
      p_tenant_id, p_product_id, p_warehouse_id, p_location_id, p_batch_no, v_status, v_total);
  END IF;

  RETURN v_total;
END;
$$;

GRANT EXECUTE ON FUNCTION public.inventory_consume_reservations(
  BIGINT, INTEGER, INTEGER, INTEGER, TEXT, TEXT, NUMERIC) TO authenticated;

-- ============================================================================
-- 8. 质检 → 库存状态流转
--    「检验合格后转 available」「不合格转 rejected」「冻结转 hold」都走这一个 RPC。
--    实现上是「从源状态扣 / 向目标状态加」，两条腿都记账、都写流水，可追溯。
-- ============================================================================
CREATE OR REPLACE FUNCTION public.move_inventory_stock_status(
  p_product_id      INTEGER,
  p_warehouse_id    INTEGER,
  p_from_status     TEXT,
  p_to_status       TEXT,
  p_quantity        NUMERIC,
  p_location_id     INTEGER DEFAULT NULL,
  p_batch_no        TEXT    DEFAULT NULL,
  p_reference_type  TEXT    DEFAULT NULL,
  p_reference_id    INTEGER DEFAULT NULL,
  p_idempotency_key UUID    DEFAULT NULL,
  p_remark          TEXT    DEFAULT NULL,
  p_tenant_id       BIGINT  DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_tenant BIGINT := COALESCE(p_tenant_id, public.current_tenant_id());
  actor_id INTEGER := public.current_sys_user_id();
  v_from TEXT := LOWER(COALESCE(NULLIF(BTRIM(p_from_status), ''), 'available'));
  v_to   TEXT := LOWER(COALESCE(NULLIF(BTRIM(p_to_status), ''), 'available'));
  v_batch TEXT := NULLIF(BTRIM(p_batch_no), '');
  v_corp VARCHAR(128);
  v_key UUID := COALESCE(p_idempotency_key, gen_random_uuid());
  v_unit_cost NUMERIC := 0;
  v_out JSONB;
  v_in JSONB;
  v_ref_type TEXT;
BEGIN
  IF p_product_id IS NULL OR p_warehouse_id IS NULL THEN
    RAISE EXCEPTION '状态流转需要 product_id / warehouse_id' USING ERRCODE = '23502';
  END IF;
  IF COALESCE(p_quantity, 0) <= 0 THEN
    RAISE EXCEPTION '状态流转数量必须大于 0' USING ERRCODE = '23514';
  END IF;
  IF v_from = v_to THEN
    RAISE EXCEPTION '源状态与目标状态相同（%）', v_from USING ERRCODE = '23514';
  END IF;
  IF v_from NOT IN ('available','inspection','hold','rejected')
     OR v_to NOT IN ('available','inspection','hold','rejected') THEN
    RAISE EXCEPTION '非法库存状态：% → %', p_from_status, p_to_status USING ERRCODE = '23514';
  END IF;

  -- 幂等：同一 reference + 幂等键已流转过就短路
  IF p_reference_type IS NOT NULL AND p_reference_id IS NOT NULL AND p_idempotency_key IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM public.erp_inventory_transactions_s_539dcf81_b t
       WHERE t.tenant_id = v_tenant AND t.reference_type = p_reference_type
         AND t.reference_id = p_reference_id
         AND t.posting_idempotency_key = p_idempotency_key
         AND t.is_deleted = 'n'
    ) THEN
      RETURN jsonb_build_object('ok', TRUE, 'idempotent', TRUE,
        'product_id', p_product_id, 'from_status', v_from, 'to_status', v_to);
    END IF;
  END IF;

  SELECT w.corp_id INTO v_corp FROM public.erp_warehouses_s_539dcf81_b w
   WHERE w.id = p_warehouse_id AND w.tenant_id = v_tenant AND w.is_deleted = 'n' FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Warehouse does not exist or is deleted' USING ERRCODE = 'P0002';
  END IF;

  v_ref_type := COALESCE(p_reference_type, 'stock_status_move');

  -- 出：源状态扣减（负库存策略按仓库配置）
  v_out := public.inventory_apply_move(
    p_tenant_id      => v_tenant,
    p_corp_id        => v_corp,
    p_actor_id       => actor_id,
    p_product_id     => p_product_id,
    p_warehouse_id   => p_warehouse_id,
    p_location_id    => p_location_id,
    p_batch_no       => v_batch,
    p_stock_status   => v_from,
    p_qty_delta      => -p_quantity,
    p_unit_cost      => NULL,
    p_cost_delta     => NULL,
    p_expiry_date    => NULL);

  v_unit_cost := COALESCE((v_out ->> 'unit_cost')::NUMERIC, 0);

  INSERT INTO public.erp_inventory_transactions_s_539dcf81_b (
    corp_id, emp_id, is_deleted, transaction_no, transaction_type, transaction_date,
    product_id, warehouse_id, location_id, batch_no, stock_status, quantity,
    unit_cost, total_cost, reference_type, reference_id, posting_idempotency_key,
    remark, tenant_id
  ) VALUES (
    v_corp, actor_id::TEXT, 'n',
    LEFT('IT' || TO_CHAR(clock_timestamp(), 'YYYYMMDDHH24MISSMS')
         || LPAD(COALESCE(p_product_id, 0)::TEXT, 6, '0') || 'S', 50),
    public.resolve_inventory_transaction_type('stock_status_move', 'out'),
    CURRENT_DATE, p_product_id, p_warehouse_id, p_location_id, v_batch, v_from,
    -p_quantity, v_unit_cost, -(p_quantity * v_unit_cost),
    v_ref_type, p_reference_id, v_key,
    COALESCE(p_remark, format('库存状态流转：%s → %s', v_from, v_to)), v_tenant
  );

  -- 入：目标状态增加
  v_in := public.inventory_apply_move(
    p_tenant_id      => v_tenant,
    p_corp_id        => v_corp,
    p_actor_id       => actor_id,
    p_product_id     => p_product_id,
    p_warehouse_id   => p_warehouse_id,
    p_location_id    => p_location_id,
    p_batch_no       => v_batch,
    p_stock_status   => v_to,
    p_qty_delta      => p_quantity,
    p_unit_cost      => v_unit_cost,
    p_cost_delta     => p_quantity * v_unit_cost,
    p_expiry_date    => NULL);

  INSERT INTO public.erp_inventory_transactions_s_539dcf81_b (
    corp_id, emp_id, is_deleted, transaction_no, transaction_type, transaction_date,
    product_id, warehouse_id, location_id, batch_no, stock_status, quantity,
    unit_cost, total_cost, reference_type, reference_id, posting_idempotency_key,
    remark, tenant_id
  ) VALUES (
    v_corp, actor_id::TEXT, 'n',
    LEFT('IT' || TO_CHAR(clock_timestamp(), 'YYYYMMDDHH24MISSMS')
         || LPAD(COALESCE(p_product_id, 0)::TEXT, 6, '0') || 'T', 50),
    public.resolve_inventory_transaction_type('stock_status_move', 'in'),
    CURRENT_DATE, p_product_id, p_warehouse_id, p_location_id, v_batch, v_to,
    p_quantity, v_unit_cost, p_quantity * v_unit_cost,
    v_ref_type, p_reference_id, v_key,
    COALESCE(p_remark, format('库存状态流转：%s → %s', v_from, v_to)), v_tenant
  );

  RETURN jsonb_build_object('ok', TRUE, 'idempotent', FALSE,
    'product_id', p_product_id, 'warehouse_id', p_warehouse_id,
    'location_id', p_location_id, 'batch_no', v_batch,
    'from_status', v_from, 'to_status', v_to,
    'quantity', p_quantity, 'unit_cost', v_unit_cost);
END;
$$;

GRANT EXECUTE ON FUNCTION public.move_inventory_stock_status(
  INTEGER, INTEGER, TEXT, TEXT, NUMERIC, INTEGER, TEXT, TEXT, INTEGER, UUID, TEXT, BIGINT
) TO authenticated;

-- 交易类型字典补两条（状态流转的进出方向）
INSERT INTO public.sys_inventory_transaction_types
  (code, name, direction, affects_stock, name_en, sort_order)
VALUES
  ('stock_status_move_out', '状态流转出', 'out', FALSE, 'Status Move Out', 220),
  ('stock_status_move_in',  '状态流转入', 'in',  FALSE, 'Status Move In',  221)
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name, direction = EXCLUDED.direction,
  affects_stock = EXCLUDED.affects_stock, name_en = EXCLUDED.name_en,
  sort_order = EXCLUDED.sort_order, is_deleted = 'n', updated_at = NOW();

-- 状态流转不是一张「单据」，但 resolve_inventory_transaction_type 需要 DocType 才能
-- 查到映射。登记成 is_virtual = TRUE 的虚拟单据类型：不会出现在单据类型管理页的可建
-- 单据列表里，只用于解析流水业务类型。
-- 注：sys_document_types.document_type 是**全表唯一**（被外键引用，见 MEMORY），
-- 所以这里可以写 ON CONFLICT (document_type)。
INSERT INTO public.sys_document_types (
  document_type, document_name, primary_key_field, module_code, route_path,
  table_name, naming_rule, is_virtual, is_submittable, status, sort_order, is_deleted
)
VALUES (
  'stock_status_move', '库存状态流转', 'id', 'inventory', NULL,
  NULL, 'SSM{YYYY}{####}', TRUE, FALSE, '1', 38, 'n'
)
ON CONFLICT (document_type) DO UPDATE SET
  document_name = EXCLUDED.document_name,
  is_virtual = TRUE,
  is_deleted = 'n',
  updated_at = NOW();

-- 兜底解析：'stock_status_move' 按方向映射（resolve_inventory_transaction_type 的
-- 老兜底分支不认识这个单据类型，会拼成 'stock_status_move_out'，正好与上面对齐）
-- 这里显式登记映射，避免依赖字符串拼接。
INSERT INTO public.sys_document_transaction_types
  (document_type_id, transaction_type_code, direction, is_default, condition_note, sort_order)
SELECT d.id, x.code, x.direction, x.is_default, x.note, x.sort_order
FROM public.sys_document_types d
JOIN (VALUES
  ('stock_status_move', 'stock_status_move_out', 'out', TRUE,  '状态流转：源状态扣减', 10),
  ('stock_status_move', 'stock_status_move_in',  'in',  TRUE,  '状态流转：目标状态增加', 20)
) AS x(document_type, code, direction, is_default, note, sort_order)
  ON x.document_type = d.document_type
WHERE d.document_type = 'stock_status_move' AND d.is_deleted = 'n'
ON CONFLICT (document_type_id, transaction_type_code) DO UPDATE SET
  direction = EXCLUDED.direction, is_default = EXCLUDED.is_default,
  condition_note = EXCLUDED.condition_note, sort_order = EXCLUDED.sort_order,
  is_deleted = 'n', updated_at = NOW();

-- ============================================================================
-- 9. ATP 可用量视图
--    可承诺量 = 现存量 - 已预占 + 在途（在途暂不计，见下）
--    与库存查询页的区别：这里按 物料 + 仓库 汇总，并同时给出待检/冻结/不合格量，
--    让计划员一眼看出「账面有货但拿不到」的部分。
-- ============================================================================
CREATE OR REPLACE VIEW public.vw_erp_inventory_atp
WITH (security_invoker = true) AS
SELECT
  i.tenant_id,
  i.product_id,
  i.warehouse_id,
  SUM(i.quantity)                                                        AS on_hand_quantity,
  SUM(COALESCE(i.locked_quantity, 0))                                    AS reserved_quantity,
  SUM(COALESCE(i.available_quantity, 0))                                 AS available_quantity,
  SUM(CASE WHEN i.stock_status = 'inspection' THEN i.quantity ELSE 0 END) AS inspection_quantity,
  SUM(CASE WHEN i.stock_status = 'hold'       THEN i.quantity ELSE 0 END) AS hold_quantity,
  SUM(CASE WHEN i.stock_status = 'rejected'   THEN i.quantity ELSE 0 END) AS rejected_quantity,
  -- ATP 就是「可用状态行里未被预占的部分」，待检/冻结/不合格天然不计入
  SUM(COALESCE(i.available_quantity, 0))                                 AS atp_quantity,
  SUM(i.total_cost)                                                      AS total_cost
FROM public.erp_inventory_s_539dcf81_b i
WHERE i.is_deleted = 'n'
GROUP BY i.tenant_id, i.product_id, i.warehouse_id;

COMMENT ON VIEW public.vw_erp_inventory_atp IS
  'ATP 可用量：按 物料+仓库 汇总现存量 / 已预占 / 可发量 / 待检 / 冻结 / 不合格 / 货值。';

GRANT SELECT ON public.vw_erp_inventory_atp TO authenticated;

-- ============================================================================
-- 10. 自检（fail-loud）
-- ============================================================================
DO $$
DECLARE
  v_missing TEXT := '';
  v_idx INTEGER;
  v_cfg INTEGER;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'erp_inventory_s_539dcf81_b' AND column_name = 'stock_status'
       AND is_nullable = 'NO'
  ) THEN
    v_missing := v_missing || 'erp_inventory.stock_status 缺失或可空;';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'erp_inventory_transactions_s_539dcf81_b' AND column_name = 'stock_status'
  ) THEN
    v_missing := v_missing || 'erp_inventory_transactions.stock_status 缺失;';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'erp_stock_count_details_s_539dcf81_b' AND column_name = 'stock_status'
  ) THEN
    v_missing := v_missing || 'erp_stock_count_details.stock_status 缺失;';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'erp_stock_adjustment_details_s_539dcf81_b' AND column_name = 'stock_status'
  ) THEN
    v_missing := v_missing || 'erp_stock_adjustment_details.stock_status 缺失;';
  END IF;

  SELECT count(*) INTO v_idx FROM pg_indexes
   WHERE tablename = 'erp_inventory_s_539dcf81_b'
     AND indexname IN ('uq_erp_inventory_active_stock_s');
  IF v_idx <> 1 THEN
    v_missing := v_missing || '唯一键 uq_erp_inventory_active_stock_s 未建立;';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE tablename='erp_inventory_s_539dcf81_b'
              AND indexname = 'uq_erp_inventory_active_stock_t') THEN
    v_missing := v_missing || '旧唯一键 uq_erp_inventory_active_stock_t 仍存在（与状态维度冲突）;';
  END IF;

  -- 唯一键必须真的包含 stock_status
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE tablename = 'erp_inventory_s_539dcf81_b' AND indexname = 'uq_erp_inventory_active_stock_s'
       AND indexdef ILIKE '%stock_status%'
  ) THEN
    v_missing := v_missing || '唯一键未包含 stock_status;';
  END IF;

  IF to_regclass('public.erp_inventory_reservations_s_539dcf81_b') IS NULL THEN
    v_missing := v_missing || 'erp_inventory_reservations 表未建立;';
  END IF;

  SELECT count(*) INTO v_cfg FROM public.sys_config
   WHERE is_deleted = 'n' AND category_code = 'inventory';
  IF v_cfg = 0 THEN
    v_missing := v_missing || 'sys_config 未播种 inventory 分类;';
  END IF;

  IF v_missing <> '' THEN
    RAISE EXCEPTION 'deploy_88 自检失败：%', v_missing;
  END IF;

  RAISE NOTICE 'deploy_88 OK：库存状态维度、唯一键、预留表、ATP 视图、配置项齐备';
END;
$$;
