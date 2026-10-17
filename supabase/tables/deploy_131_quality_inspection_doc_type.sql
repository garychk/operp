-- 质检单编号走统一 generate_document_no('quality_inspection')
-- 背景：QualityInspections.tsx 之前用前端时间戳硬编码 inspection_no（IQC+YYYYMMDDHHmmss），
--       绕开了 sys_document_types 的编码规则与租户隔离计数器，且精确到秒可能撞号。
--       本补丁在 sys_document_types 登记 quality_inspection，使 nextDocumentNo("quality_inspection")
--       能命中命名规则（否则 generate_document_no 抛 P0002「No naming rule configured」）。

INSERT INTO public.sys_document_types (
  document_type, document_name, primary_key_field, module_code, route_path,
  table_name, naming_rule, is_submittable, status, sort_order, is_deleted
)
VALUES (
  'quality_inspection', '质检单', 'id', 'mrp', '/mrp/quality-inspections',
  'erp_quality_inspections_s_539dcf81_b', 'IQC{YYYY}{####}', TRUE, '1', 69, 'n'
)
ON CONFLICT (document_type) DO UPDATE SET
  document_name = EXCLUDED.document_name,
  module_code   = EXCLUDED.module_code,
  route_path    = EXCLUDED.route_path,
  table_name    = EXCLUDED.table_name,
  naming_rule   = EXCLUDED.naming_rule,
  is_deleted    = 'n',
  updated_at    = NOW();
