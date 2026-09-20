-- Inventory transaction business types, driven by DocType metadata.
--
-- Before this file the "流水类型" (erp_inventory_transactions.transaction_type)
-- was a free VARCHAR(50) column: the enum lived only in the frontend constant
-- src/constants/inventoryTransactionTypes.ts and every posting RPC hard-coded a
-- literal. Adding a new business type meant touching SQL + frontend + docs.
--
-- This file introduces two tables:
--   1. sys_inventory_transaction_types  - the business type dictionary (code,
--      name, direction). This is also the source for the UI label/dropdown.
--   2. sys_document_transaction_types   - DocType x business type mapping.
--      One DocType may map to several business types (transfer writes both an
--      out and an in row, stock count writes an increase or a decrease row
--      depending on the difference sign), so the mapping also carries a
--      direction and an is_default flag.
--
-- Posting RPCs call public.resolve_inventory_transaction_type(document_type,
-- direction) instead of writing literals. The resolver falls back to the legacy
-- hard-coded mapping when no row is configured, so posting never breaks because
-- of a missing configuration row.

-- ---------------------------------------------------------------------------
-- 1. Business type dictionary
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.sys_inventory_transaction_types (
  id SERIAL PRIMARY KEY,
  code VARCHAR(64) NOT NULL,
  name VARCHAR(150) NOT NULL,
  direction VARCHAR(10) NOT NULL DEFAULT 'in',
  affects_stock BOOLEAN NOT NULL DEFAULT TRUE,
  name_en VARCHAR(150),
  description VARCHAR(255),
  status CHAR(1) NOT NULL DEFAULT '1',
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_deleted CHAR(1) NOT NULL DEFAULT 'n',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_sys_inventory_transaction_types_code UNIQUE (code),
  CONSTRAINT chk_sys_inventory_transaction_types_direction
    CHECK (direction IN ('in', 'out', 'neutral')),
  CONSTRAINT chk_sys_inventory_transaction_types_status
    CHECK (status IN ('0', '1'))
);

CREATE INDEX IF NOT EXISTS idx_sys_inventory_transaction_types_active
  ON public.sys_inventory_transaction_types (sort_order, id)
  WHERE is_deleted = 'n';

GRANT SELECT, INSERT, UPDATE, DELETE ON public.sys_inventory_transaction_types TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.sys_inventory_transaction_types_id_seq TO authenticated;
ALTER TABLE public.sys_inventory_transaction_types ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated users can manage inventory transaction types"
  ON public.sys_inventory_transaction_types;
CREATE POLICY "Authenticated users can manage inventory transaction types"
  ON public.sys_inventory_transaction_types FOR ALL TO authenticated
  USING (true) WITH CHECK (true);
SELECT public.install_role_table_rls('sys_inventory_transaction_types');

-- ---------------------------------------------------------------------------
-- 2. DocType x business type mapping
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.sys_document_transaction_types (
  id SERIAL PRIMARY KEY,
  document_type_id INTEGER NOT NULL
    REFERENCES public.sys_document_types(id) ON DELETE CASCADE,
  transaction_type_code VARCHAR(64) NOT NULL
    REFERENCES public.sys_inventory_transaction_types(code)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  direction VARCHAR(10) NOT NULL DEFAULT 'in',
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  condition_note VARCHAR(255),
  status CHAR(1) NOT NULL DEFAULT '1',
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_deleted CHAR(1) NOT NULL DEFAULT 'n',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_sys_document_transaction_types_mapping
    UNIQUE (document_type_id, transaction_type_code),
  CONSTRAINT chk_sys_document_transaction_types_direction
    CHECK (direction IN ('in', 'out', 'neutral')),
  CONSTRAINT chk_sys_document_transaction_types_status
    CHECK (status IN ('0', '1'))
);

CREATE INDEX IF NOT EXISTS idx_sys_document_transaction_types_document
  ON public.sys_document_transaction_types (document_type_id, sort_order, id)
  WHERE is_deleted = 'n';

-- At most one default business type per DocType + direction. Without this the
-- resolver would break ties by sort_order/id and the winner would depend on
-- insert order.
CREATE UNIQUE INDEX IF NOT EXISTS uq_sys_document_transaction_types_default
  ON public.sys_document_transaction_types (document_type_id, direction)
  WHERE is_deleted = 'n' AND is_default;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.sys_document_transaction_types TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.sys_document_transaction_types_id_seq TO authenticated;
ALTER TABLE public.sys_document_transaction_types ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated users can manage document transaction types"
  ON public.sys_document_transaction_types;
CREATE POLICY "Authenticated users can manage document transaction types"
  ON public.sys_document_transaction_types FOR ALL TO authenticated
  USING (true) WITH CHECK (true);
SELECT public.install_role_table_rls('sys_document_transaction_types');

-- ---------------------------------------------------------------------------
-- 3. Seed the dictionary (the 20 standard business types)
-- ---------------------------------------------------------------------------
INSERT INTO public.sys_inventory_transaction_types
  (code, name, direction, affects_stock, name_en, sort_order)
VALUES
  ('purchase_receipt_in',      '采购入库',     'in',      TRUE,  'Purchase Receipt',      10),
  ('sales_delivery_out',       '销售出货',     'out',     TRUE,  'Sales Delivery',        20),
  ('purchase_return_out',      '采购退货',     'out',     TRUE,  'Purchase Return',       30),
  ('sales_return_in',          '销售退货',     'in',      TRUE,  'Sales Return',          40),
  ('inventory_transfer_out',   '库存调拨出库', 'out',     TRUE,  'Transfer Out',          50),
  ('inventory_transfer_in',    '库存调拨入库', 'in',      TRUE,  'Transfer In',           60),
  ('stock_count_increase',     '盘点盘盈',     'in',      TRUE,  'Stock Count Gain',      70),
  ('stock_count_decrease',     '盘点盘亏',     'out',     TRUE,  'Stock Count Loss',       80),
  ('stock_adjust_in',          '库存调整增加', 'in',      TRUE,  'Stock Adjustment In',    90),
  ('stock_adjust_out',         '库存调整减少', 'out',     TRUE,  'Stock Adjustment Out',  100),
  ('material_issue_out',       '生产领料',     'out',     TRUE,  'Material Issue',        110),
  ('material_return_in',       '生产退料',     'in',      TRUE,  'Material Return',       120),
  ('production_receipt_in',    '生产完工入库', 'in',      TRUE,  'Production Receipt',    130),
  ('scrap_out',                '报废出库',     'out',     TRUE,  'Scrap Issue',           140),
  ('opening_balance_in',       '期初入库',     'in',      TRUE,  'Opening Balance In',    150),
  ('opening_balance_out',      '期初冲销',     'out',     TRUE,  'Opening Balance Out',   160),
  ('quality_hold',             '质量冻结',     'neutral', FALSE, 'Quality Hold',          170),
  ('quality_release',          '质量解冻',     'neutral', FALSE, 'Quality Release',       180),
  ('inventory_freeze',         '库存冻结',     'neutral', FALSE, 'Inventory Freeze',      190),
  ('inventory_unfreeze',       '库存解冻',     'neutral', FALSE, 'Inventory Unfreeze',    200),
  ('cost_revaluation',         '成本重估',     'neutral', FALSE, 'Cost Revaluation',      210)
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  direction = EXCLUDED.direction,
  affects_stock = EXCLUDED.affects_stock,
  name_en = EXCLUDED.name_en,
  sort_order = EXCLUDED.sort_order,
  is_deleted = 'n',
  updated_at = NOW();

-- ---------------------------------------------------------------------------
-- 4. Seed the DocType mappings
--    Only DocTypes that actually post stock today are mapped. The dictionary
--    above already carries the production/quality/opening types so future
--    documents can be mapped from the UI without another migration.
-- ---------------------------------------------------------------------------
INSERT INTO public.sys_document_transaction_types
  (document_type_id, transaction_type_code, direction, is_default, condition_note, sort_order)
SELECT d.id, x.code, x.direction, x.is_default, x.condition_note, x.sort_order
FROM public.sys_document_types d
JOIN (VALUES
  ('purchase_receipt',   'purchase_receipt_in',    'in',  TRUE,  NULL,                              10),
  ('sales_delivery',     'sales_delivery_out',     'out', TRUE,  NULL,                              10),
  ('inventory_transfer', 'inventory_transfer_out', 'out', TRUE,  '调拨单出库方向（from warehouse）', 10),
  ('inventory_transfer', 'inventory_transfer_in',  'in',  FALSE, '调拨单入库方向（to warehouse）',   20),
  ('stock_count',        'stock_count_increase',   'in',  FALSE, '实盘 > 账面',                      10),
  ('stock_count',        'stock_count_decrease',   'out', FALSE, '实盘 < 账面',                      20),
  ('stock_adjustment',   'stock_adjust_in',        'in',  FALSE, '明细 direction = in',              10),
  ('stock_adjustment',   'stock_adjust_out',       'out', FALSE, '明细 direction = out',             20)
) AS x(document_type, code, direction, is_default, condition_note, sort_order)
  ON x.document_type = d.document_type
WHERE d.is_deleted = 'n'
ON CONFLICT (document_type_id, transaction_type_code) DO UPDATE SET
  direction = EXCLUDED.direction,
  is_default = EXCLUDED.is_default,
  condition_note = EXCLUDED.condition_note,
  sort_order = EXCLUDED.sort_order,
  is_deleted = 'n',
  updated_at = NOW();

-- ---------------------------------------------------------------------------
-- 5. Resolver used by the posting RPCs
--    SECURITY DEFINER on purpose: post_stock_document() runs as the caller
--    (SECURITY INVOKER), and the role based RLS policies installed above must
--    never stop a posting from resolving its business type.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resolve_inventory_transaction_type(
  p_document_type TEXT,
  p_direction TEXT DEFAULT NULL
) RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_code TEXT;
BEGIN
  SELECT m.transaction_type_code
  INTO v_code
  FROM public.sys_document_transaction_types m
  JOIN public.sys_document_types d ON d.id = m.document_type_id
  WHERE d.document_type = p_document_type
    AND d.is_deleted = 'n'
    AND m.is_deleted = 'n'
    AND m.status = '1'
    AND (m.direction = p_direction OR p_direction IS NULL OR m.direction = 'neutral')
  ORDER BY
    CASE WHEN m.direction = p_direction THEN 0 ELSE 1 END,
    m.is_default DESC,
    m.sort_order,
    m.id
  LIMIT 1;

  IF v_code IS NULL THEN
    -- Legacy hard-coded mapping, kept as a safety net so posting keeps working
    -- when nobody configured the document type yet.
    v_code := CASE
      WHEN p_document_type = 'purchase_receipt'   THEN 'purchase_receipt_in'
      WHEN p_document_type = 'sales_delivery'     THEN 'sales_delivery_out'
      WHEN p_document_type = 'inventory_transfer' THEN CASE
        WHEN p_direction = 'in' THEN 'inventory_transfer_in' ELSE 'inventory_transfer_out' END
      WHEN p_document_type = 'stock_count'        THEN CASE
        WHEN p_direction = 'in' THEN 'stock_count_increase' ELSE 'stock_count_decrease' END
      WHEN p_document_type = 'stock_adjustment'  THEN CASE
        WHEN p_direction = 'in' THEN 'stock_adjust_in' ELSE 'stock_adjust_out' END
      WHEN p_document_type = 'material_issue'    THEN 'material_issue_out'
      WHEN p_document_type = 'production_receipt' THEN 'production_receipt_in'
      ELSE p_document_type || COALESCE('_' || p_direction, '')
    END;
  END IF;

  RETURN v_code;
END;
$$;

GRANT EXECUTE ON FUNCTION public.resolve_inventory_transaction_type(TEXT, TEXT) TO authenticated;

-- ---------------------------------------------------------------------------
-- 6. Backfill already-posted rows onto the standard codes
--    deploy_24 wrote 'transfer_out' / 'transfer_in' (the frontend constant
--    expects 'inventory_transfer_out' / 'inventory_transfer_in'), and the very
--    first posting version wrote the generic 'inbound' / 'outbound'.
-- ---------------------------------------------------------------------------
UPDATE public.erp_inventory_transactions_s_539dcf81_b
SET transaction_type = 'inventory_transfer_out', updated_at = NOW()
WHERE transaction_type = 'transfer_out';

UPDATE public.erp_inventory_transactions_s_539dcf81_b
SET transaction_type = 'inventory_transfer_in', updated_at = NOW()
WHERE transaction_type = 'transfer_in';

UPDATE public.erp_inventory_transactions_s_539dcf81_b
SET transaction_type = 'purchase_receipt_in', updated_at = NOW()
WHERE transaction_type = 'inbound';

UPDATE public.erp_inventory_transactions_s_539dcf81_b
SET transaction_type = 'sales_delivery_out', updated_at = NOW()
WHERE transaction_type = 'outbound';

-- ---------------------------------------------------------------------------
-- 7. Configuration audit view
--    The mapping tables are metadata only: nothing guarantees that a code
--    written by a posting RPC actually exists in the dictionary, or that a
--    configured code is ever written. This view makes both directions visible
--    so a mismatch is noticed instead of silently showing raw English codes in
--    the transaction list.
--      unregistered_code - written by posting but missing from the dictionary
--      unmapped_code     - in the dictionary but no DocType maps to it
--      orphan_mapping    - mapping points at a DocType with no posting RPC
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_inventory_transaction_type_audit
WITH (security_invoker = true) AS
SELECT 'unregistered_code'::TEXT AS issue_type,
       t.transaction_type AS code,
       COUNT(*) AS occurrences,
       MIN(t.reference_type) AS sample_reference_type
FROM public.erp_inventory_transactions_s_539dcf81_b t
WHERE t.is_deleted = 'n'
  AND NOT EXISTS (
    SELECT 1 FROM public.sys_inventory_transaction_types d
    WHERE d.code = t.transaction_type AND d.is_deleted = 'n'
  )
GROUP BY t.transaction_type
UNION ALL
SELECT 'unmapped_code'::TEXT,
       d.code,
       0,
       NULL::TEXT
FROM public.sys_inventory_transaction_types d
WHERE d.is_deleted = 'n'
  AND NOT EXISTS (
    SELECT 1 FROM public.sys_document_transaction_types m
    WHERE m.transaction_type_code = d.code AND m.is_deleted = 'n'
  )
UNION ALL
SELECT 'orphan_mapping'::TEXT,
       d.document_type,
       COUNT(m.id),
       MIN(m.transaction_type_code)
FROM public.sys_document_types d
JOIN public.sys_document_transaction_types m ON m.document_type_id = d.id
WHERE d.is_deleted = 'n' AND m.is_deleted = 'n'
  AND d.document_type NOT IN (
    'purchase_receipt', 'sales_delivery',
    'inventory_transfer', 'stock_count', 'stock_adjustment'
  )
GROUP BY d.document_type;

GRANT SELECT ON public.v_inventory_transaction_type_audit TO authenticated;

COMMENT ON VIEW public.v_inventory_transaction_type_audit IS
  '业务流水类型配置体检：unregistered_code=流水里写了但字典没有，unmapped_code=字典里有但没挂任何 DocType，orphan_mapping=配了映射但该 DocType 没有过账 RPC。';
