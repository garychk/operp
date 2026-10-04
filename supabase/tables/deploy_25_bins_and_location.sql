-- Bin/location support for warehouses, inventory, and inventory transactions.
--
-- 分工说明
-- --------
-- erp_bins 的建表（含索引 / 授权 / RLS）在 deploy_24_erp_bins.sql，排在
-- deploy_24_inventory_document_ops.sql 之前 —— 因为 deploy_24 建的单据表在 CREATE TABLE
-- 时就直接引用 erp_bins。本脚本只负责把 location 维度补到「先于本脚本存在」的表上。
--
-- 依赖：deploy_01（erp_inventory / erp_inventory_transactions）、
--       deploy_24_erp_bins（erp_bins）、deploy_24_inventory_document_ops（erp_stock_* 系列）。

ALTER TABLE public.erp_inventory_s_539dcf81_b
  ADD COLUMN IF NOT EXISTS location_id INTEGER REFERENCES public.erp_bins_s_539dcf81_b(id);

ALTER TABLE public.erp_inventory_transactions_s_539dcf81_b
  ADD COLUMN IF NOT EXISTS from_location_id INTEGER REFERENCES public.erp_bins_s_539dcf81_b(id),
  ADD COLUMN IF NOT EXISTS to_location_id INTEGER REFERENCES public.erp_bins_s_539dcf81_b(id),
  ADD COLUMN IF NOT EXISTS location_id INTEGER REFERENCES public.erp_bins_s_539dcf81_b(id);

-- 以下几张表由 deploy_24_inventory_document_ops.sql 创建，其建表语句里已经内联了
-- location_id 列与 erp_bins 外键；这里保留 IF NOT EXISTS 版本，用于兼容
-- 「已经跑过旧版 deploy_24（当时没有 location_id）」的存量库，属于幂等空操作。

ALTER TABLE public.erp_stock_counts_s_539dcf81_b
  ADD COLUMN IF NOT EXISTS location_id INTEGER REFERENCES public.erp_bins_s_539dcf81_b(id);

ALTER TABLE public.erp_stock_count_details_s_539dcf81_b
  ADD COLUMN IF NOT EXISTS location_id INTEGER REFERENCES public.erp_bins_s_539dcf81_b(id);

ALTER TABLE public.erp_stock_adjustments_s_539dcf81_b
  ADD COLUMN IF NOT EXISTS location_id INTEGER REFERENCES public.erp_bins_s_539dcf81_b(id);

ALTER TABLE public.erp_stock_adjustment_details_s_539dcf81_b
  ADD COLUMN IF NOT EXISTS location_id INTEGER REFERENCES public.erp_bins_s_539dcf81_b(id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_inventory_active_stock_key_v2
  ON public.erp_inventory_s_539dcf81_b (
    product_id, warehouse_id, COALESCE(location_id, 0),
    (COALESCE(NULLIF(BTRIM(batch_no), ''), ''))
  ) WHERE is_deleted = 'n';

GRANT SELECT, UPDATE ON public.erp_inventory_s_539dcf81_b TO authenticated;
GRANT SELECT, UPDATE ON public.erp_inventory_transactions_s_539dcf81_b TO authenticated;
