-- ============================================================================
-- deploy_101 —— 修正 reserve_inventory_stock：按库存行摊分预占 + 缺口不再污染 available
--
-- 背景（P1-5 真正落地的前提）：
--   deploy_88 的 reserve_inventory_stock 把每条预占明细当成「指向唯一一行库存」，
--   落库时按 (product, warehouse, COALESCE(location_id,0), batch, status) 精确匹配。
--   这在「明细自带库位/批次」的调拨类单据里没问题，但业务级调用（销售订单、生产订单）
--   根本拿不到库位/批次 —— 结果是：
--
--   缺陷 1（预占形同虚设）：明细 location_id=NULL 时只匹配 `location_id IS NULL` 那一行。
--     而入库过账通常会把库位写上（deploy_34 起 location_id 很常见），于是
--     **一条也匹配不到**：reserve 表里登记了预占，erp_inventory.locked_quantity 却纹丝不动，
--     available_quantity 不变 → 第二张销售订单照样能把同一批货许出去。
--     P1-5 说的「启用 locked_quantity」就等于没启用。
--
--   缺陷 2（更严重：会把后续入库卡死）：需求量超过现存量时，deploy_88 的写法是
--        UPDATE ... locked_quantity = locked + 需求, available_quantity = 现存 - 新 locked
--     于是 locked(20) > quantity(5)、available_quantity = -15。
--     而 inventory_apply_move 每次移动都重算 `new_available = new_qty - old_locked`，
--     并带 `new_available < 0 → RAISE` 的负库存守卫。也就是说：**只要给某个
--     product+warehouse 下过一次超量预占，之后任何入库过账都会被判负库存而失败** ——
--     缺口越大越收不进料，必须人工去清 locked_quantity。这是会被客户当成「系统坏了」的级别。
--
-- 本脚本把 reserve_inventory_stock 改成：
--   1. 明细的 location_id / batch_no 当作**过滤器**而不是等值条件：
--        location_id IS NULL → 匹配该物料该仓库该状态下的所有库位
--        batch_no   IS NULL → 匹配所有批次
--      两者都给了 → 只匹配那一行（与旧行为完全一致，向后兼容）。
--   2. 命中多行时按 **先到期先出（expiry_date NULLS LAST, 再按 id）** 逐行锁，
--      每锁一行就写一条预占记录（带**该行真实的 location_id / batch_no**），
--      这样后续 consume / release 按 (location, batch) 反查时能真的对得上。
--   3. **行锁上限 = 该行可锁余量**。装不下的部分不再去污染 available_quantity，
--      而是单独登记一条 location/batch 为空的「备货缺口」预占（quantity = 缺口）。
--      → available_quantity 永远 >= 0，缺陷 2 从根上消失；
--      → 缺口仍然「看得见」（预占表里有、ATP 视图算得出来），只是不再破坏库存行。
--   4. allow_shortage=FALSE 时，装不满就抛错（整个语句回滚，不留半截锁定）。
--
-- 并发：先取一把 物料+仓库+状态 的粗粒度 advisory lock 再逐行 FOR UPDATE，
--   保证同一维度的并发预占串行，且与 inventory_apply_move 的单行 advisory lock
--   不会形成环（apply_move 只持一把锁，不会「持 A 等 B」）。
--
-- 本脚本由 000_run_all 用 psql --single-transaction 执行，**不要写 BEGIN/COMMIT**。
-- 依赖：deploy_88（本函数的原始版本、erp_inventory_reservations 表）、
--       deploy_95（预占唯一键修正）。
-- ============================================================================

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
  v_row RECORD;
  v_status TEXT;
  v_batch TEXT;
  v_need NUMERIC;
  v_free NUMERIC;
  v_take NUMERIC;
  v_locked INTEGER := 0;
  v_total NUMERIC := 0;
  v_shortage NUMERIC := 0;
  v_rows INTEGER := 0;
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
    SELECT (e ->> 'product_id')::INTEGER            AS product_id,
           (e ->> 'location_id')::INTEGER           AS location_id,
           NULLIF(BTRIM(e ->> 'batch_no'), '')      AS batch_no,
           COALESCE((e ->> 'quantity')::NUMERIC, 0) AS quantity,
           (e ->> 'source_detail_id')::INTEGER      AS source_detail_id,
           COALESCE(NULLIF(BTRIM(e ->> 'stock_status'), ''), 'available') AS stock_status
      FROM jsonb_array_elements(COALESCE(p_lines, '[]'::JSONB)) e
  LOOP
    CONTINUE WHEN v_line.product_id IS NULL OR v_line.quantity <= 0;
    v_status := LOWER(v_line.stock_status);
    IF v_status NOT IN ('available', 'inspection', 'hold', 'rejected') THEN
      v_status := 'available';
    END IF;
    v_batch := v_line.batch_no;

    -- 粗粒度串行化：同一 物料+仓库+状态 的预占排队执行，避免并发预占互相抢行
    PERFORM pg_advisory_xact_lock(hashtextextended(
      format('erp_reserve:%s:%s:%s', v_line.product_id, p_warehouse_id, v_status), 0));

    v_need := v_line.quantity;

    -- 逐行摊分：先到期先出（无到期日的排最后），既能装多少装多少
    FOR v_row IN
      SELECT x.id, x.location_id, x.batch_no, x.quantity, x.locked_quantity
        FROM public.erp_inventory_s_539dcf81_b x
       WHERE x.product_id = v_line.product_id
         AND x.warehouse_id = p_warehouse_id
         AND x.tenant_id = v_tenant
         AND x.stock_status = v_status
         AND x.is_deleted = 'n'
         -- 过滤器语义：传了就等值匹配，没传就全量匹配
         AND (v_line.location_id IS NULL
              OR COALESCE(x.location_id, 0) = COALESCE(v_line.location_id, 0))
         AND (v_batch IS NULL
              OR COALESCE(NULLIF(BTRIM(x.batch_no), ''), '') = v_batch)
       ORDER BY x.expiry_date NULLS LAST, x.id
       FOR UPDATE
    LOOP
      EXIT WHEN v_need <= 0;

      v_free := GREATEST(COALESCE(v_row.quantity, 0) - COALESCE(v_row.locked_quantity, 0), 0);
      v_take := LEAST(v_free, v_need);
      CONTINUE WHEN v_take <= 0;

      UPDATE public.erp_inventory_s_539dcf81_b
         SET locked_quantity = COALESCE(locked_quantity, 0) + v_take,
             available_quantity = CASE WHEN stock_status = 'available'
                                       THEN quantity - (COALESCE(locked_quantity, 0) + v_take)
                                       ELSE 0 END,
             updated_at = NOW()
       WHERE id = v_row.id;

      INSERT INTO public.erp_inventory_reservations_s_539dcf81_b (
        corp_id, emp_id, is_deleted, product_id, warehouse_id, location_id, batch_no,
        stock_status, quantity, source_type, source_id, source_detail_id, source_no,
        status, remark, tenant_id
      ) VALUES (
        v_corp, actor_id::TEXT, 'n', v_line.product_id, p_warehouse_id,
        v_row.location_id, v_row.batch_no,
        v_status, v_take, p_source_type, p_source_id, v_line.source_detail_id, p_source_no,
        'open', NULL, v_tenant
      );

      v_locked := v_locked + 1;
      v_total := v_total + v_take;
      v_need := v_need - v_take;
      v_rows := v_rows + 1;
    END LOOP;

    -- 装不满：allow_shortage=FALSE 直接抛错（语句回滚，不留半截锁定）；
    -- 允许缺口时登记一条 location/batch 为空的备货预占 —— 只登记、**不动库存行**，
    -- 所以 available_quantity 不会被压成负数（deploy_88 的缺陷 2）。
    IF v_need > 0 THEN
      IF NOT p_allow_shortage THEN
        RAISE EXCEPTION
          '预占失败：物料 % 仓库 % 状态 % 可锁余量不足（还需 %）',
          v_line.product_id, p_warehouse_id, v_status, v_need
          USING ERRCODE = '23514';
      END IF;

      INSERT INTO public.erp_inventory_reservations_s_539dcf81_b (
        corp_id, emp_id, is_deleted, product_id, warehouse_id, location_id, batch_no,
        stock_status, quantity, source_type, source_id, source_detail_id, source_no,
        status, remark, tenant_id
      ) VALUES (
        v_corp, actor_id::TEXT, 'n', v_line.product_id, p_warehouse_id,
        NULL, NULL,
        v_status, v_need, p_source_type, p_source_id, v_line.source_detail_id, p_source_no,
        'open', '备货缺口：下达时库存不足，等入库后由 available 补齐', v_tenant
      );

      v_locked := v_locked + 1;
      v_total := v_total + v_need;
      v_shortage := v_shortage + v_need;
      v_need := 0;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('ok', TRUE, 'idempotent', FALSE,
    'source_type', p_source_type, 'source_id', p_source_id,
    'line_count', v_locked, 'rows_locked', v_rows,
    'reserved_quantity', v_total,
    'shortage_quantity', v_shortage);
END;
$$;

GRANT EXECUTE ON FUNCTION public.reserve_inventory_stock(
  TEXT, INTEGER, TEXT, INTEGER, JSONB, UUID, BIGINT, BOOLEAN) TO authenticated;

-- ============================================================================
-- 自检（硬失败，不是「打印清单」）
-- ============================================================================
DO $selfcheck$
DECLARE
  v_def TEXT;
BEGIN
  SELECT p.prosrc INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'reserve_inventory_stock';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'deploy_101 自检失败：reserve_inventory_stock 不存在';
  END IF;

  -- 过滤器语义
  IF POSITION('v_line.location_id IS NULL' IN v_def) = 0
     OR POSITION('v_batch IS NULL' IN v_def) = 0 THEN
    RAISE EXCEPTION 'deploy_101 自检失败：未实现 location/batch 的「过滤器」语义';
  END IF;

  -- 先到期先出
  IF POSITION('expiry_date NULLS LAST' IN v_def) = 0 THEN
    RAISE EXCEPTION 'deploy_101 自检失败：未实现 FIFO（expiry_date NULLS LAST）排序';
  END IF;

  -- 缺口不再压 available：必须用 v_free/v_take 摊分，且不能再出现「现存 - 需求」的写法
  IF POSITION('v_free' IN v_def) = 0 OR POSITION('v_take' IN v_def) = 0 THEN
    RAISE EXCEPTION 'deploy_101 自检失败：未按可锁余量摊分（缺 v_free / v_take）';
  END IF;
  IF POSITION('备货缺口' IN v_def) = 0 THEN
    RAISE EXCEPTION 'deploy_101 自检失败：缺口没有单独登记为备货预占';
  END IF;

  -- 粗粒度并发锁
  IF POSITION('erp_reserve:' IN v_def) = 0 THEN
    RAISE EXCEPTION 'deploy_101 自检失败：缺少 物料+仓库+状态 级 advisory lock';
  END IF;

  RAISE NOTICE 'deploy_101 OK：reserve_inventory_stock 已按库存行摊分预占，缺口不再污染 available_quantity';
END;
$selfcheck$;
