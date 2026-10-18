-- ============================================================================
-- deploy_135 补丁 —— 只落新增的材料明细视图（不碰表/RLS，避开 owner 42501）
-- ============================================================================
-- 背景：deploy_135 整文件重跑时，install_role_table_rls 会对已存在的
--       factory_3d_device_layout 表执行 ALTER TABLE ... ENABLE ROW LEVEL SECURITY，
--       若该表 owner 不是当前角色（如由 supabase_admin 建表），报 42501 must be owner。
--       表和 RLS 早已就绪，本文件只补第 4 个视图，幂等可重复执行。
-- ============================================================================

CREATE OR REPLACE VIEW public.vw_factory_3d_order_materials
  WITH (security_invoker = true) AS
SELECT
  d.tenant_id,
  o.id                     AS order_id,
  o.order_no,
  d.id                     AS order_detail_id,
  d.line_no,
  d.material_id,
  p.code                   AS material_code,
  p.name                   AS material_name,
  p.specification          AS material_spec,
  d.planned_quantity,
  d.issued_quantity,
  COALESCE(d.unit, p.unit) AS unit
FROM public.erp_production_order_details_s_539dcf81_b d
JOIN public.erp_production_orders_s_539dcf81_b o
  ON o.id = d.order_id AND o.tenant_id = d.tenant_id
LEFT JOIN public.erp_products_s_539dcf81_b p
  ON p.id = d.material_id
WHERE COALESCE(d.is_deleted, 'n') = 'n'
  AND COALESCE(o.is_deleted, 'n') = 'n'
  AND o.status IN ('released', 'in_progress');

GRANT SELECT ON public.vw_factory_3d_order_materials TO authenticated;

-- fail-loud 自检：视图存在且 security_invoker 已启用
DO $$
DECLARE
  v_opts TEXT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_views
    WHERE schemaname = 'public' AND viewname = 'vw_factory_3d_order_materials'
  ) THEN
    RAISE EXCEPTION 'vw_factory_3d_order_materials 未创建';
  END IF;

  SELECT COALESCE(string_agg(c.reloptions::text, ' '), '')
    INTO v_opts
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'vw_factory_3d_order_materials';

  IF v_opts IS NULL OR (v_opts NOT ILIKE '%security_invoker=%true%'
                        AND v_opts NOT ILIKE '%security_invoker=true%') THEN
    RAISE EXCEPTION 'vw_factory_3d_order_materials 未启用 security_invoker（会绕过租户 RLS）';
  END IF;

  RAISE NOTICE 'OK：vw_factory_3d_order_materials 就绪（security_invoker 已启用）';
END;
$$;

-- 视图列变更后刷新 PostgREST schema 缓存（避免 PGRST204/新列不可见）
NOTIFY pgrst, 'reload schema';
