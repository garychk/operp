-- 库位（货位）主表：erp_bins。
--
-- 为什么单独一个脚本、并且排在 deploy_24 之前
-- ------------------------------------------
-- deploy_24_inventory_document_ops.sql 建的四类单据表在 CREATE TABLE 时就直接带了
--   from_location_id / to_location_id / location_id INTEGER REFERENCES public.erp_bins_s_539dcf81_b(id)
-- 因此它必须先有 erp_bins。
-- 而 erp_bins 原本是在 deploy_25_bins_and_location.sql 里建的，deploy_25 又需要 ALTER
-- deploy_24 建的 erp_stock_counts 等表 —— 两者互为前置条件，按任何单一顺序执行都会报
--   ERROR: relation "public.erp_bins_s_539dcf81_b" does not exist
--   ERROR: relation "public.erp_stock_counts_s_539dcf81_b" does not exist
--
-- 现在把 erp_bins 的建表（连同索引、授权、RLS）独立到这里，排在 deploy_24 之前，
-- 环就解开了：本脚本 -> deploy_24（引用 erp_bins）-> deploy_25（补 location 列）。
--
-- 依赖：deploy_01（erp_warehouses 表）必须先执行。
--
-- 注意：glob 顺序下 deploy_24_erp_bins.sql 恰好排在 deploy_24_inventory_document_ops.sql 之前。

CREATE TABLE IF NOT EXISTS public.erp_bins_s_539dcf81_b (
  id SERIAL PRIMARY KEY,
  corp_id VARCHAR(128),
  emp_id VARCHAR(128),
  is_deleted CHAR(1) NOT NULL DEFAULT 'n',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  code VARCHAR(50) NOT NULL,
  name VARCHAR(100) NOT NULL,
  warehouse_id INTEGER NOT NULL REFERENCES public.erp_warehouses_s_539dcf81_b(id),
  location TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  UNIQUE (warehouse_id, code)
);

CREATE INDEX IF NOT EXISTS idx_erp_bins_warehouse_id
  ON public.erp_bins_s_539dcf81_b(warehouse_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.erp_bins_s_539dcf81_b TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.erp_bins_s_539dcf81_b_id_seq TO authenticated;
SELECT public.install_role_table_rls('erp_bins_s_539dcf81_b');
