-- ============================================================================
-- deploy_120 —— BAQ 图形化设计器：外键关系元数据 RPC
-- ============================================================================
--
-- 为什么需要：
--   BAQ 设计器要支持「ER 图式」编辑（每张表一个 Card，勾选字段即输出，
--   拖连线建立主子表关联）。做这件事的前提是知道**哪两张表能连、用哪两个字段连**。
--   现有 baq_catalog()（deploy_25 为最终真相源）只返回 表 + 字段，不含任何关系信息。
--   本脚本只补这一项元数据；execute_baq() / baq_catalog() 一行都不动。
--
-- 口径（必须与 baq_catalog() 严格对齐）：
--   · 只输出 public schema 内 **两侧都是 erp_* 表** 的外键 —— 与 baq_catalog()
--     的可选表范围（c.table_name LIKE 'erp\_%'）一致，避免前端拿到一张
--     根本加不进画布的关系。
--   · 两侧表都必须在 sys_tables 里 is_deleted='n' AND status='1'
--     —— 同上，baq_catalog() 只暴露这些表。
--   · tenant_id / corp_id 这类指向 sys_* 的外键天然被第一条排除（对端不是 erp_%），
--     不会被当成业务关联。
--   · 复合外键按 conkey/confkey 下标逐列展开，一列一行（本项目目前没有复合外键，
--     但生成列写法不依赖这个假设）。
--   · SECURITY DEFINER + REVOKE ALL FROM PUBLIC：与 deploy_25 同理 ——
--     只暴露表名/列名元数据，不授予任何数据访问，也不执行任意 SQL。
--
-- 幂等：CREATE OR REPLACE FUNCTION + 幂等的 GRANT；重复执行两遍都成功。
--
-- 前端配套：src/features/baq/api.ts 的 loadRelations()
--          → 图形设计器工具栏「自动发现关联」。
-- ============================================================================

CREATE OR REPLACE FUNCTION public.baq_relations()
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'table', src.relname,
        'column', sa.attname,
        'refTable', ref.relname,
        'refColumn', ra.attname
      )
      ORDER BY src.relname, sa.attname, ref.relname, ra.attname
    ),
    '[]'::jsonb
  )
  FROM pg_constraint con
  JOIN pg_class src      ON src.oid = con.conrelid
  JOIN pg_class ref      ON ref.oid = con.confrelid
  JOIN pg_namespace nsrc ON nsrc.oid = src.relnamespace
  JOIN pg_namespace nref ON nref.oid = ref.relnamespace
  JOIN generate_subscripts(con.conkey, 1) AS s(i) ON TRUE
  JOIN pg_attribute sa   ON sa.attrelid = con.conrelid  AND sa.attnum = con.conkey[s.i]
  JOIN pg_attribute ra   ON ra.attrelid = con.confrelid AND ra.attnum = con.confkey[s.i]
  WHERE con.contype = 'f'
    AND nsrc.nspname = 'public'
    AND nref.nspname = 'public'
    AND src.relkind = 'r'
    AND ref.relkind = 'r'
    AND src.relname LIKE 'erp\_%' ESCAPE '\'
    AND ref.relname LIKE 'erp\_%' ESCAPE '\'
    AND EXISTS (
      SELECT 1 FROM public.sys_tables t
      WHERE t.table_name = src.relname AND t.is_deleted = 'n' AND t.status = '1'
    )
    AND EXISTS (
      SELECT 1 FROM public.sys_tables t
      WHERE t.table_name = ref.relname AND t.is_deleted = 'n' AND t.status = '1'
    );
$$;

REVOKE ALL ON FUNCTION public.baq_relations() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.baq_relations() TO authenticated;
GRANT EXECUTE ON FUNCTION public.baq_relations() TO service_role;

-- ---------------------------------------------------------------------------
-- 自检（fail-loud）
--   本脚本不带 has_table_permission 过滤（与 baq_catalog 同口径），
--   所以自检在迁移器（postgres 直连、无 JWT）下也能给出真实结论。
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_actual   JSONB;
  v_count    INTEGER;
  v_expected INTEGER;
  v_bad      RECORD;
BEGIN
  -- 1) 函数存在且返回 JSON 数组
  SELECT public.baq_relations() INTO v_actual;
  IF v_actual IS NULL OR jsonb_typeof(v_actual) <> 'array' THEN
    RAISE EXCEPTION 'deploy_120 自检失败：baq_relations() 未返回 JSON 数组（实际 %）',
      COALESCE(jsonb_typeof(v_actual), 'NULL');
  END IF;

  v_count := jsonb_array_length(v_actual);

  -- 2) 每条记录四个键齐全且非空
  SELECT e INTO v_bad
  FROM jsonb_array_elements(v_actual) e
  WHERE NULLIF(BTRIM(COALESCE(e->>'table', '')), '') IS NULL
     OR NULLIF(BTRIM(COALESCE(e->>'column', '')), '') IS NULL
     OR NULLIF(BTRIM(COALESCE(e->>'refTable', '')), '') IS NULL
     OR NULLIF(BTRIM(COALESCE(e->>'refColumn', '')), '') IS NULL
  LIMIT 1;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'deploy_120 自检失败：关系记录字段缺失 %', v_bad::TEXT;
  END IF;

  -- 3) 存在的表必须真的在 baq_catalog() 可选范围里（两表都要）
  SELECT e INTO v_bad
  FROM jsonb_array_elements(v_actual) e
  WHERE NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(public.baq_catalog()) c
          WHERE c->>'table' = e->>'table'
        )
     OR NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(public.baq_catalog()) c
          WHERE c->>'table' = e->>'refTable'
        )
  LIMIT 1;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'deploy_120 自检失败：关系里的表不在 baq_catalog() 范围内 %', v_bad::TEXT;
  END IF;

  -- 4) 覆盖率：与函数体同谓词裸算一遍，条数必须完全相等
  --    （能抓住 generate_subscripts 下标错配导致的漏列/重复）
  SELECT COUNT(*) INTO v_expected
  FROM pg_constraint con
  JOIN pg_class src      ON src.oid = con.conrelid
  JOIN pg_class ref      ON ref.oid = con.confrelid
  JOIN pg_namespace nsrc ON nsrc.oid = src.relnamespace
  JOIN pg_namespace nref ON nref.oid = ref.relnamespace
  JOIN generate_subscripts(con.conkey, 1) AS s(i) ON TRUE
  WHERE con.contype = 'f'
    AND nsrc.nspname = 'public'
    AND nref.nspname = 'public'
    AND src.relkind = 'r'
    AND ref.relkind = 'r'
    AND src.relname LIKE 'erp\_%' ESCAPE '\'
    AND ref.relname LIKE 'erp\_%' ESCAPE '\'
    AND EXISTS (
      SELECT 1 FROM public.sys_tables t
      WHERE t.table_name = src.relname AND t.is_deleted = 'n' AND t.status = '1'
    )
    AND EXISTS (
      SELECT 1 FROM public.sys_tables t
      WHERE t.table_name = ref.relname AND t.is_deleted = 'n' AND t.status = '1'
    );

  IF v_count <> v_expected THEN
    RAISE EXCEPTION 'deploy_120 自检失败：baq_relations() 返回 % 条，库内应为 % 条',
      v_count, v_expected;
  END IF;

  -- 5) 有意义性：erp_* 之间确实存在外键时，不允许返回空数组
  IF v_expected > 0 AND v_count = 0 THEN
    RAISE EXCEPTION 'deploy_120 自检失败：库内存在 % 条 erp_* 外键，baq_relations() 却返回空数组', v_expected;
  END IF;

  RAISE NOTICE 'deploy_120 OK：baq_relations() 返回 % 条 erp_* 表间外键关系', v_count;
END;
$$;
