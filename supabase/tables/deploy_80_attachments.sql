-- Generic business attachments: PDF / Word / Excel / Txt / Markdown files
-- attached to any business record (sales order, purchase order, supplier,
-- sales delivery, purchase receipt, BOM, routing operation, ...).
--
-- Design summary:
--   erp_attachments    one row per uploaded file, generic (biz_type, biz_id)
--                      reference to the owning record; soft delete keeps
--                      history; files live in the "uploadfiles" bucket.
--
-- The bucket was created by deploy_79 with image-only mime types; extend it
-- here to also accept document formats (idempotent UPDATE).

-- ============================================
-- 1. Extend the uploadfiles bucket for document types
-- ============================================
UPDATE storage.buckets
SET file_size_limit = 20971520,  -- 20MB
    allowed_mime_types = ARRAY[
      'image/jpeg','image/png','image/gif','image/webp','image/bmp',
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/plain',
      'text/markdown',
      'text/x-markdown'
    ]
WHERE id = 'uploadfiles';

-- ============================================
-- 2. Attachment table (tenant-scoped, same pattern as deploy_79)
-- ============================================
CREATE TABLE IF NOT EXISTS public.erp_attachments_s_539dcf81_b (
    id SERIAL PRIMARY KEY,
    tenant_id BIGINT NOT NULL DEFAULT current_tenant_id(),
    corp_id VARCHAR(128),
    emp_id VARCHAR(128),
    is_deleted CHAR(1) NOT NULL DEFAULT 'n',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    biz_type VARCHAR(50) NOT NULL,             -- sales_order / purchase_order / supplier / ...
    biz_id INTEGER NOT NULL,                   -- owning record id (no FK: table varies)
    bucket VARCHAR(100) NOT NULL DEFAULT 'uploadfiles',
    storage_path VARCHAR(512) NOT NULL,        -- object path inside the bucket
    file_name VARCHAR(255),                    -- original file name
    file_size BIGINT,                          -- bytes
    mime_type VARCHAR(100),
    remark VARCHAR(255)
);

CREATE INDEX IF NOT EXISTS idx_erp_attachments_biz
  ON public.erp_attachments_s_539dcf81_b(biz_type, biz_id)
  WHERE is_deleted = 'n';

-- ============================================
-- 3. Grants and RLS (same pattern as deploy_79)
-- ============================================
GRANT SELECT, INSERT, UPDATE, DELETE ON public.erp_attachments_s_539dcf81_b TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.erp_attachments_s_539dcf81_b_id_seq TO authenticated;
SELECT public.install_role_table_rls('erp_attachments_s_539dcf81_b');

-- Register the new table in sys_tables for data-driven role permissions.
SELECT public.refresh_sys_tables();
