-- Bin/location support for warehouses, inventory, and inventory transactions.

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

ALTER TABLE public.erp_inventory_s_539dcf81_b
  ADD COLUMN IF NOT EXISTS location_id INTEGER REFERENCES public.erp_bins_s_539dcf81_b(id);

ALTER TABLE public.erp_inventory_transactions_s_539dcf81_b
  ADD COLUMN IF NOT EXISTS from_location_id INTEGER REFERENCES public.erp_bins_s_539dcf81_b(id),
  ADD COLUMN IF NOT EXISTS to_location_id INTEGER REFERENCES public.erp_bins_s_539dcf81_b(id),
  ADD COLUMN IF NOT EXISTS location_id INTEGER REFERENCES public.erp_bins_s_539dcf81_b(id);

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

CREATE INDEX IF NOT EXISTS idx_erp_bins_warehouse_id
  ON public.erp_bins_s_539dcf81_b(warehouse_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.erp_bins_s_539dcf81_b TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.erp_bins_s_539dcf81_b_id_seq TO authenticated;
SELECT public.install_role_table_rls('erp_bins_s_539dcf81_b');

GRANT SELECT, UPDATE ON public.erp_inventory_s_539dcf81_b TO authenticated;
GRANT SELECT, UPDATE ON public.erp_inventory_transactions_s_539dcf81_b TO authenticated;
