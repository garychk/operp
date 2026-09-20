-- AI 实体目录（deploy_39）
-- 给 AI 服务提供「表级 + 列级」元数据，让 AI 助手不再依赖硬编码的实体清单。
-- 数据来源：public.sys_tables（表目录，由 refresh_sys_tables() 从 information_schema 同步）
--          + information_schema.columns（列类型 / 是否可空 / 默认值 / 列注释）
--          + 外键约束（用于把 xxx_id 解析成关联表的编码或名称）
--
-- 本脚本只暴露元数据，不授予任何数据写入权限。是否允许 AI 写入某张表由
-- ai-server/src/tools/entityRegistry.ts 中的写保护策略决定：
--   - sys_* / wf_* / doc_flow_* 系统表：只读
--   - 过账 / 核算 / MRP 运算生成的表（库存流水、总账流水、凭证明细等）：只读
--   - 其余 erp_* 业务表：可新增 / 修改，任何表都不允许删除

CREATE OR REPLACE FUNCTION public.ai_entity_catalog()
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH fk AS (
    SELECT
      kcu.table_name AS table_name,
      kcu.column_name AS column_name,
      ccu.table_name AS foreign_table_name,
      ccu.column_name AS foreign_column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON kcu.constraint_name = tc.constraint_name
     AND kcu.table_schema = tc.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_name = tc.constraint_name
     AND ccu.table_schema = tc.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = 'public'
  ),
  cols AS (
    SELECT
      c.table_name,
      jsonb_agg(
        jsonb_build_object(
          'name', c.column_name,
          'data_type', c.data_type,
          'is_nullable', c.is_nullable = 'YES',
          'has_default', c.column_default IS NOT NULL,
          'default_value', c.column_default,
          'note', col_description((c.table_schema || '.' || c.table_name)::regclass, c.ordinal_position),
          'ref_table', fk.foreign_table_name,
          'ref_column', fk.foreign_column_name
        )
        ORDER BY c.ordinal_position
      ) AS columns
    FROM information_schema.columns c
    LEFT JOIN fk
      ON fk.table_name = c.table_name
     AND fk.column_name = c.column_name
    WHERE c.table_schema = 'public'
    GROUP BY c.table_name
  )
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'table', t.table_name,
        'label', COALESCE(NULLIF(t.table_label, ''), t.table_name),
        'module', COALESCE(NULLIF(t.module_name, ''), 'business'),
        'columns', COALESCE(cols.columns, '[]'::jsonb)
      )
      ORDER BY t.table_name
    ),
    '[]'::jsonb
  )
  FROM public.sys_tables t
  LEFT JOIN cols ON cols.table_name = t.table_name
  WHERE t.is_deleted = 'n'
    AND t.status = '1';
$$;

REVOKE ALL ON FUNCTION public.ai_entity_catalog() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ai_entity_catalog() TO authenticated;
GRANT EXECUTE ON FUNCTION public.ai_entity_catalog() TO service_role;

-- 新表建好后刷新一次表目录，保证 AI 能立刻看到
SELECT public.refresh_sys_tables();
