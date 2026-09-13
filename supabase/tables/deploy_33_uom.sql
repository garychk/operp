-- Unit of Measure (UoM) management: groups, units, product-level multi-UoM.
--
-- Design summary:
--   erp_uom_groups    unit groups (weight / length / count ...); conversion
--                     only happens inside one group, anchored on the group base unit
--   erp_uoms          unit archive: code/name/symbol, factor relative to the
--                     group base unit, quantity precision, active flag
--   erp_product_uoms  per-product unit usage (purchase / sales / inventory /
--                     production / cost), optional conversion override and
--                     per-unit barcode
--   erp_products      new base_uom_id column replaces the legacy free-text
--                     unit column (kept for transition), backfilled from it
--
-- Conversion rule: qty_in_target = qty_in_source * from.factor / to.factor,
-- where the factor is uom.factor or, when present, product-level
-- erp_product_uoms.conversion_factor (material-level override).

-- ============================================
-- 1. Unit group table
-- ============================================
CREATE TABLE IF NOT EXISTS public.erp_uom_groups_s_539dcf81_b (
    id SERIAL PRIMARY KEY,
    corp_id VARCHAR(128),
    emp_id VARCHAR(128),
    is_deleted CHAR(1) NOT NULL DEFAULT 'n',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    code VARCHAR(50) NOT NULL UNIQUE,          -- group code: WEIGHT / LENGTH / COUNT
    name VARCHAR(100) NOT NULL,                -- group name: 重量 / 长度 / 数量
    sort_order INTEGER NOT NULL DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'active'
);
-- base_uom_id FK is added after erp_uoms exists (circular group <-> unit reference).

-- ============================================
-- 2. Unit archive table
-- ============================================
CREATE TABLE IF NOT EXISTS public.erp_uoms_s_539dcf81_b (
    id SERIAL PRIMARY KEY,
    corp_id VARCHAR(128),
    emp_id VARCHAR(128),
    is_deleted CHAR(1) NOT NULL DEFAULT 'n',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    group_id INTEGER NOT NULL REFERENCES public.erp_uom_groups_s_539dcf81_b(id),
    code VARCHAR(50) NOT NULL UNIQUE,          -- KG / T / BOX
    name VARCHAR(100) NOT NULL,                -- 千克 / 吨 / 箱
    symbol VARCHAR(20),                        -- kg / t / box
    factor NUMERIC(18, 9) NOT NULL DEFAULT 1,  -- rate relative to the group base unit
    rounding INTEGER NOT NULL DEFAULT 2,       -- quantity decimal places
    is_base BOOLEAN NOT NULL DEFAULT FALSE,    -- exactly one base unit per group
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    CONSTRAINT chk_uom_base_factor CHECK (NOT is_base OR factor = 1),
    CONSTRAINT chk_uom_rounding_range CHECK (rounding BETWEEN 0 AND 6),
    CONSTRAINT chk_uom_factor_positive CHECK (factor > 0)
);

CREATE INDEX IF NOT EXISTS idx_erp_uoms_group_id
  ON public.erp_uoms_s_539dcf81_b(group_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_uoms_one_base_per_group
  ON public.erp_uoms_s_539dcf81_b(group_id) WHERE is_base AND is_deleted = 'n';

-- Now that both tables exist, add the deferred group -> base unit FK.
DO $$
BEGIN
  ALTER TABLE public.erp_uom_groups_s_539dcf81_b
    ADD COLUMN IF NOT EXISTS base_uom_id INTEGER;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_uom_groups_base_uom'
      AND conrelid = 'public.erp_uom_groups_s_539dcf81_b'::regclass
  ) THEN
    ALTER TABLE public.erp_uom_groups_s_539dcf81_b
      ADD CONSTRAINT fk_uom_groups_base_uom
      FOREIGN KEY (base_uom_id) REFERENCES public.erp_uoms_s_539dcf81_b(id);
  END IF;
END $$;

-- Backfill the group base unit after both tables exist.
UPDATE public.erp_uom_groups_s_539dcf81_b g
SET base_uom_id = u.id
FROM public.erp_uoms_s_539dcf81_b u
WHERE u.group_id = g.id
  AND u.is_base
  AND u.is_deleted = 'n'
  AND g.base_uom_id IS NULL;

-- ============================================
-- 3. Product-level unit usage table
-- ============================================
CREATE TABLE IF NOT EXISTS public.erp_product_uoms_s_539dcf81_b (
    id SERIAL PRIMARY KEY,
    corp_id VARCHAR(128),
    emp_id VARCHAR(128),
    is_deleted CHAR(1) NOT NULL DEFAULT 'n',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    product_id INTEGER NOT NULL REFERENCES public.erp_products_s_539dcf81_b(id),
    uom_id INTEGER NOT NULL REFERENCES public.erp_uoms_s_539dcf81_b(id),
    usage_type VARCHAR(20) NOT NULL,           -- purchase / sales / inventory / production / cost
    conversion_factor NUMERIC(18, 9),          -- NULL = use the uom group default factor
    is_default BOOLEAN NOT NULL DEFAULT FALSE, -- default unit for this usage
    barcode VARCHAR(50),                       -- barcode for this unit (case code vs item code)
    remark VARCHAR(255),
    CONSTRAINT chk_product_uom_usage CHECK (
        usage_type IN ('purchase', 'sales', 'inventory', 'production', 'cost')
    ),
    CONSTRAINT chk_product_uom_factor CHECK (conversion_factor IS NULL OR conversion_factor > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_product_uoms_key
  ON public.erp_product_uoms_s_539dcf81_b(product_id, uom_id, usage_type)
  WHERE is_deleted = 'n';
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_product_uoms_one_default_per_usage
  ON public.erp_product_uoms_s_539dcf81_b(product_id, usage_type)
  WHERE is_default AND is_deleted = 'n';
CREATE INDEX IF NOT EXISTS idx_erp_product_uoms_product_id
  ON public.erp_product_uoms_s_539dcf81_b(product_id);
CREATE INDEX IF NOT EXISTS idx_erp_product_uoms_uom_id
  ON public.erp_product_uoms_s_539dcf81_b(uom_id);

-- ============================================
-- 4. Link products to their base unit
-- ============================================
ALTER TABLE public.erp_products_s_539dcf81_b
  ADD COLUMN IF NOT EXISTS base_uom_id INTEGER REFERENCES public.erp_uoms_s_539dcf81_b(id);

-- ============================================
-- 5. Seed data: common groups and units
-- ============================================
INSERT INTO public.erp_uom_groups_s_539dcf81_b (code, name, sort_order) VALUES
  ('COUNT', '数量', 1),
  ('WEIGHT', '重量', 2),
  ('LENGTH', '长度', 3),
  ('AREA',   '面积', 4),
  ('VOLUME', '体积', 5),
  ('TIME',   '时间', 6)
ON CONFLICT (code) DO NOTHING;

INSERT INTO public.erp_uoms_s_539dcf81_b (group_id, code, name, symbol, factor, rounding, is_base, is_active) VALUES
  ((SELECT id FROM public.erp_uom_groups_s_539dcf81_b WHERE code = 'COUNT'), 'PCS',   '个',   'pcs',   1,     0, TRUE,  TRUE),
  ((SELECT id FROM public.erp_uom_groups_s_539dcf81_b WHERE code = 'COUNT'), 'SET',   '套',   'set',   1,     0, FALSE, TRUE),
  ((SELECT id FROM public.erp_uom_groups_s_539dcf81_b WHERE code = 'COUNT'), 'PAIR',  '双',   'pair',  1,     0, FALSE, TRUE),
  ((SELECT id FROM public.erp_uom_groups_s_539dcf81_b WHERE code = 'COUNT'), 'BOX',   '箱',   'box',   1,     0, FALSE, TRUE),
  ((SELECT id FROM public.erp_uom_groups_s_539dcf81_b WHERE code = 'COUNT'), 'PKG',   '包',   'pkg',   1,     0, FALSE, TRUE),
  ((SELECT id FROM public.erp_uom_groups_s_539dcf81_b WHERE code = 'COUNT'), 'ROLL',  '卷',   'roll',  1,     0, FALSE, TRUE),
  ((SELECT id FROM public.erp_uom_groups_s_539dcf81_b WHERE code = 'COUNT'), 'PCS10', '十件', '10pcs', 10,    0, FALSE, TRUE),
  ((SELECT id FROM public.erp_uom_groups_s_539dcf81_b WHERE code = 'WEIGHT'), 'KG',   '千克', 'kg',    1,     3, TRUE,  TRUE),
  ((SELECT id FROM public.erp_uom_groups_s_539dcf81_b WHERE code = 'WEIGHT'), 'G',    '克',   'g',     0.001, 3, FALSE, TRUE),
  ((SELECT id FROM public.erp_uom_groups_s_539dcf81_b WHERE code = 'WEIGHT'), 'T',    '吨',   't',     1000,  3, FALSE, TRUE),
  ((SELECT id FROM public.erp_uom_groups_s_539dcf81_b WHERE code = 'LENGTH'), 'M',    '米',   'm',     1,     2, TRUE,  TRUE),
  ((SELECT id FROM public.erp_uom_groups_s_539dcf81_b WHERE code = 'LENGTH'), 'CM',   '厘米', 'cm',    0.01,  2, FALSE, TRUE),
  ((SELECT id FROM public.erp_uom_groups_s_539dcf81_b WHERE code = 'LENGTH'), 'MM',   '毫米', 'mm',    0.001, 2, FALSE, TRUE),
  ((SELECT id FROM public.erp_uom_groups_s_539dcf81_b WHERE code = 'LENGTH'), 'KM',   '千米', 'km',    1000,  2, FALSE, TRUE),
  ((SELECT id FROM public.erp_uom_groups_s_539dcf81_b WHERE code = 'AREA'),   'M2',   '平方米', 'm2',   1,     2, TRUE,  TRUE),
  ((SELECT id FROM public.erp_uom_groups_s_539dcf81_b WHERE code = 'VOLUME'), 'L',    '升',   'L',     1,     3, TRUE,  TRUE),
  ((SELECT id FROM public.erp_uom_groups_s_539dcf81_b WHERE code = 'VOLUME'), 'ML',   '毫升', 'ml',    0.001, 3, FALSE, TRUE),
  ((SELECT id FROM public.erp_uom_groups_s_539dcf81_b WHERE code = 'VOLUME'), 'M3',   '立方米', 'm3',   1000,  3, FALSE, TRUE),
  ((SELECT id FROM public.erp_uom_groups_s_539dcf81_b WHERE code = 'TIME'),   'HOUR', '小时', 'h',     1,     2, TRUE,  TRUE),
  ((SELECT id FROM public.erp_uom_groups_s_539dcf81_b WHERE code = 'TIME'),   'MIN',  '分钟', 'min',   1 / 60.0, 0, FALSE, TRUE)
ON CONFLICT (code) DO NOTHING;

UPDATE public.erp_uom_groups_s_539dcf81_b g
SET base_uom_id = u.id
FROM public.erp_uoms_s_539dcf81_b u
WHERE u.group_id = g.id
  AND u.is_base
  AND u.is_deleted = 'n'
  AND g.base_uom_id IS NULL;

-- ============================================
-- 6. Backfill product base units from legacy text column
-- ============================================
UPDATE public.erp_products_s_539dcf81_b p
SET base_uom_id = u.id
FROM public.erp_uoms_s_539dcf81_b u
WHERE p.base_uom_id IS NULL
  AND p.is_deleted = 'n'
  AND u.is_deleted = 'n'
  AND u.is_active
  AND (
    TRIM(p.unit) = u.code
    OR TRIM(p.unit) = u.name
    OR TRIM(p.unit) = u.symbol
  );

-- ============================================
-- 7. Conversion helper
-- ============================================
-- Converts a quantity between two units of one product.
-- Priority: product-level conversion_factor > uom group default factor.
-- SECURITY INVOKER: read-only helper, no elevated access needed.
CREATE OR REPLACE FUNCTION public.convert_uom_quantity(
  p_product_id INTEGER,
  p_quantity NUMERIC,
  p_from_uom_id INTEGER,
  p_to_uom_id INTEGER
)
RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_from_group_id INTEGER;
  v_to_group_id INTEGER;
  v_from_factor NUMERIC;
  v_to_factor NUMERIC;
BEGIN
  IF p_from_uom_id = p_to_uom_id THEN
    RETURN p_quantity;
  END IF;

  SELECT group_id INTO v_from_group_id
  FROM public.erp_uoms_s_539dcf81_b WHERE id = p_from_uom_id AND is_deleted = 'n';
  SELECT group_id INTO v_to_group_id
  FROM public.erp_uoms_s_539dcf81_b WHERE id = p_to_uom_id AND is_deleted = 'n';

  IF v_from_group_id IS NULL OR v_to_group_id IS NULL THEN
    RAISE EXCEPTION 'Unknown unit id: % -> %', p_from_uom_id, p_to_uom_id
      USING ERRCODE = 'P0002';
  END IF;
  IF v_from_group_id <> v_to_group_id THEN
    RAISE EXCEPTION 'Cannot convert between units of different groups: % -> %',
      p_from_uom_id, p_to_uom_id USING ERRCODE = '22023';
  END IF;

  -- From factor: product-level override wins over group default.
  SELECT COALESCE(pu.conversion_factor, u.factor) INTO v_from_factor
  FROM public.erp_uoms_s_539dcf81_b u
  LEFT JOIN public.erp_product_uoms_s_539dcf81_b pu
    ON pu.uom_id = u.id
   AND pu.product_id = p_product_id
   AND pu.is_deleted = 'n'
  WHERE u.id = p_from_uom_id;

  SELECT COALESCE(pu.conversion_factor, u.factor) INTO v_to_factor
  FROM public.erp_uoms_s_539dcf81_b u
  LEFT JOIN public.erp_product_uoms_s_539dcf81_b pu
    ON pu.uom_id = u.id
   AND pu.product_id = p_product_id
   AND pu.is_deleted = 'n'
  WHERE u.id = p_to_uom_id;

  RETURN p_quantity * v_from_factor / v_to_factor;
END;
$$;

REVOKE ALL ON FUNCTION public.convert_uom_quantity(INTEGER, NUMERIC, INTEGER, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.convert_uom_quantity(INTEGER, NUMERIC, INTEGER, INTEGER) TO authenticated;

-- ============================================
-- 8. Referential protection
-- ============================================
-- Block deleting a unit that is still referenced by products or product-uom rows.
CREATE OR REPLACE FUNCTION public.protect_uom_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.erp_products_s_539dcf81_b
    WHERE base_uom_id = OLD.id AND is_deleted = 'n'
  ) OR EXISTS (
    SELECT 1 FROM public.erp_product_uoms_s_539dcf81_b
    WHERE uom_id = OLD.id AND is_deleted = 'n'
  ) OR EXISTS (
    SELECT 1 FROM public.erp_uom_groups_s_539dcf81_b
    WHERE base_uom_id = OLD.id AND is_deleted = 'n'
  ) THEN
    RAISE EXCEPTION 'Unit % is still referenced and cannot be deleted, disable it instead (is_active = false)', OLD.code
      USING ERRCODE = '23503';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_uoms_protect_delete ON public.erp_uoms_s_539dcf81_b;
CREATE TRIGGER trg_uoms_protect_delete
  BEFORE DELETE ON public.erp_uoms_s_539dcf81_b
  FOR EACH ROW EXECUTE FUNCTION public.protect_uom_delete();

-- ============================================
-- 9. Grants and RLS (same pattern as deploy_25_bins_and_location)
-- ============================================
GRANT SELECT, INSERT, UPDATE, DELETE ON public.erp_uom_groups_s_539dcf81_b TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.erp_uom_groups_s_539dcf81_b_id_seq TO authenticated;
SELECT public.install_role_table_rls('erp_uom_groups_s_539dcf81_b');

GRANT SELECT, INSERT, UPDATE, DELETE ON public.erp_uoms_s_539dcf81_b TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.erp_uoms_s_539dcf81_b_id_seq TO authenticated;
SELECT public.install_role_table_rls('erp_uoms_s_539dcf81_b');

GRANT SELECT, INSERT, UPDATE, DELETE ON public.erp_product_uoms_s_539dcf81_b TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.erp_product_uoms_s_539dcf81_b_id_seq TO authenticated;
SELECT public.install_role_table_rls('erp_product_uoms_s_539dcf81_b');

GRANT SELECT, UPDATE ON public.erp_products_s_539dcf81_b TO authenticated;

-- Register the new tables in sys_tables for data-driven role permissions.
SELECT public.refresh_sys_tables();

-- ============================================
-- 10. Register the UoM page menu for role-based visibility (under system)
-- ============================================
-- 10.1 Migrate any earlier registration under /inventory/uoms to /system/uoms
UPDATE public.sys_menus
SET path = '/system/uoms',
    component = './pages/system/Uoms',
    parent_id = (SELECT m.id FROM public.sys_menus m WHERE m.menu_code = 'system' AND m.is_deleted = 'n' AND m.status = '1' LIMIT 1)
WHERE path = '/inventory/uoms' AND is_deleted = 'n';

-- 10.2 Insert the menu under 系统管理 if it does not exist yet
INSERT INTO public.sys_menus (parent_id, menu_name, menu_code, menu_type, icon, path, component, sort_order, status)
SELECT m.id, '计量单位', 'uoms', 'C', 'UnorderedListOutlined', '/system/uoms', './pages/system/Uoms', 65, '1'
FROM public.sys_menus m
WHERE m.menu_code = 'system' AND m.is_deleted = 'n' AND m.status = '1'
  AND NOT EXISTS (
    SELECT 1 FROM public.sys_menus x
    WHERE x.menu_code = 'uoms' AND x.is_deleted = 'n'
  )
LIMIT 1;
