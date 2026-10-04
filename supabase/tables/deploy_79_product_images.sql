-- Product images: one or more images per material.
--
-- Design summary:
--   storage bucket "uploadfiles"   public bucket for material images
--   erp_product_images             one row per uploaded image, pointing at
--                                  its object path inside the bucket;
--                                  soft delete (is_deleted='y') keeps history.
--
-- Listing rule: the material list shows the FIRST image, defined as
--   ORDER BY sort_order ASC, id ASC (i.e. the earliest uploaded unless a
--   custom sort order is set).

-- ============================================
-- 1. Storage bucket: uploadfiles (public)
-- ============================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('uploadfiles', 'uploadfiles', TRUE, 10485760,
        ARRAY['image/jpeg','image/png','image/gif','image/webp','image/bmp'])
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- 2. Storage policies (mirror the avatars pattern + DELETE)
-- ============================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'Public read uploadfiles'
  ) THEN
    CREATE POLICY "Public read uploadfiles"
      ON storage.objects FOR SELECT TO public
      USING (bucket_id = 'uploadfiles');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'Authenticated users upload uploadfiles'
  ) THEN
    CREATE POLICY "Authenticated users upload uploadfiles"
      ON storage.objects FOR INSERT TO authenticated
      WITH CHECK (bucket_id = 'uploadfiles');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'Authenticated users update uploadfiles'
  ) THEN
    CREATE POLICY "Authenticated users update uploadfiles"
      ON storage.objects FOR UPDATE TO authenticated
      USING (bucket_id = 'uploadfiles')
      WITH CHECK (bucket_id = 'uploadfiles');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'Authenticated users delete uploadfiles'
  ) THEN
    CREATE POLICY "Authenticated users delete uploadfiles"
      ON storage.objects FOR DELETE TO authenticated
      USING (bucket_id = 'uploadfiles');
  END IF;
END $$;

-- ============================================
-- 3. Product image table (tenant-scoped, same pattern as deploy_65)
-- ============================================
CREATE TABLE IF NOT EXISTS public.erp_product_images_s_539dcf81_b (
    id SERIAL PRIMARY KEY,
    tenant_id BIGINT NOT NULL DEFAULT current_tenant_id(),
    corp_id VARCHAR(128),
    emp_id VARCHAR(128),
    is_deleted CHAR(1) NOT NULL DEFAULT 'n',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    product_id INTEGER NOT NULL REFERENCES public.erp_products_s_539dcf81_b(id),
    bucket VARCHAR(100) NOT NULL DEFAULT 'uploadfiles',
    storage_path VARCHAR(512) NOT NULL,        -- object path inside the bucket
    file_name VARCHAR(255),                    -- original file name
    file_size BIGINT,                          -- bytes
    mime_type VARCHAR(100),
    sort_order INTEGER NOT NULL DEFAULT 0,     -- first image = lowest sort_order
    remark VARCHAR(255)
);

CREATE INDEX IF NOT EXISTS idx_erp_product_images_product_id
  ON public.erp_product_images_s_539dcf81_b(product_id)
  WHERE is_deleted = 'n';
CREATE INDEX IF NOT EXISTS idx_erp_product_images_first
  ON public.erp_product_images_s_539dcf81_b(product_id, sort_order, id)
  WHERE is_deleted = 'n';

-- ============================================
-- 4. Grants and RLS (same pattern as deploy_33 / deploy_65)
-- ============================================
GRANT SELECT, INSERT, UPDATE, DELETE ON public.erp_product_images_s_539dcf81_b TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.erp_product_images_s_539dcf81_b_id_seq TO authenticated;
SELECT public.install_role_table_rls('erp_product_images_s_539dcf81_b');

-- Register the new table in sys_tables for data-driven role permissions.
SELECT public.refresh_sys_tables();
