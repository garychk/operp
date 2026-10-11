-- ============================================================================
-- deploy_95 —— 库存预占唯一键修正（P1 修复）
-- ============================================================================
--
-- 背景（deploy_93 跑 P1-5 验收时暴露的真实缺陷）：
--   deploy_88 给 `erp_inventory_reservations` 建的 `uq_erp_inv_reservation_source`
--   是
--       UNIQUE (tenant_id, source_type, source_id, COALESCE(source_detail_id,0),
--               product_id, warehouse_id, COALESCE(location_id,0),
--               COALESCE(btrim(batch_no),''))
--       WHERE is_deleted = 'n'
--   两个问题：
--
--   ① **缺少 status 维度** —— 释放（release）只把行置为 `status='released'`，
--      行本身 is_deleted 仍为 'n'。于是「下单预占 → 释放（如订单取消）→ 再次预占」
--      必然撞 23505。这是可复现的业务路径（订单撤回后重新确认、改量后再发布）。
--   ② **缺少 stock_status 维度** —— 而 `inventory_consume_reservations` /
--      `release_inventory_reservations` / `inventory_release_locked` 都是按
--      (product, warehouse, location, batch, **stock_status**) 去认行的。
--      唯一键的实际身份与读取方的身份口径不一致，同一来源行在两个状态上预占会误撞。
--
-- 修正后的不变式：**同一个 (来源, 明细行, 物料, 仓库, 库位, 批次, 库存状态) 上，
--                  至多存在一条 `status='open'` 的活跃预占。**
--   已 released / consumed 的历史行不受约束，因此可以重新预占；
--   并发下「同一来源重复预占」仍由 `reserve_inventory_stock` 的前置 EXISTS 短路 +
--   该唯一键双重兜底。
--
-- 幂等：DROP INDEX IF EXISTS + CREATE UNIQUE INDEX IF NOT EXISTS + 末尾 fail-loud 自检。
-- ============================================================================

DROP INDEX IF EXISTS public.uq_erp_inv_reservation_source;

CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_inv_reservation_source
  ON public.erp_inventory_reservations_s_539dcf81_b (
    tenant_id,
    source_type,
    source_id,
    COALESCE(source_detail_id, 0),
    product_id,
    warehouse_id,
    COALESCE(location_id, 0),
    COALESCE(NULLIF(BTRIM(batch_no), ''), ''),
    stock_status
  )
  WHERE is_deleted = 'n' AND status = 'open';

-- ---- 自检（fail-loud）------------------------------------------------------
DO $$
DECLARE
  v_def TEXT;
BEGIN
  SELECT indexdef INTO v_def
    FROM pg_indexes
   WHERE schemaname = 'public'
     AND tablename  = 'erp_inventory_reservations_s_539dcf81_b'
     AND indexname  = 'uq_erp_inv_reservation_source';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'deploy_95 自检失败：唯一键 uq_erp_inv_reservation_source 不存在';
  END IF;
  IF v_def NOT ILIKE '%status%open%' THEN
    RAISE EXCEPTION 'deploy_95 自检失败：唯一键未限定 status=''open'' —— %', v_def;
  END IF;
  IF v_def NOT ILIKE '%stock_status%' THEN
    RAISE EXCEPTION 'deploy_95 自检失败：唯一键缺少 stock_status 维度 —— %', v_def;
  END IF;

  -- 反向确认：读取方确实按 stock_status 认行（否则加了维度反而造成漏认）
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE proname = 'inventory_consume_reservations'
       AND pronamespace = 'public'::regnamespace
       AND prosrc ILIKE '%x.stock_status = v_status%'
  ) THEN
    RAISE EXCEPTION 'deploy_95 自检失败：inventory_consume_reservations 未按 stock_status 认行';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE proname = 'release_inventory_reservations'
       AND pronamespace = 'public'::regnamespace
       AND prosrc ILIKE '%status = ''open''%'
  ) THEN
    RAISE EXCEPTION 'deploy_95 自检失败：release_inventory_reservations 未只释放 open 行';
  END IF;

  RAISE NOTICE 'deploy_95 OK：预占唯一键已按 (…, stock_status) + status=open 重建（P1 修复）';
END;
$$;
