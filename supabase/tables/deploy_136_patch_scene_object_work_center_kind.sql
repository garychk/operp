-- ============================================================================
-- deploy_136 补丁：场景对象 kind 约束新增 work_center
-- ============================================================================
-- factory-3d 组件新增了「work_center」场景对象类型，但 deploy_136 建表时
-- CHECK 约束只含 agv/warehouse/person/truck。PostgreSQL 不能 ALTER CHECK，
-- 只能 DROP + ADD。幂等可重复执行。
-- ============================================================================

ALTER TABLE public.factory_3d_scene_object_s_539dcf81_b
  DROP CONSTRAINT IF EXISTS ck_factory_3d_scene_object_kind;

ALTER TABLE public.factory_3d_scene_object_s_539dcf81_b
  ADD CONSTRAINT ck_factory_3d_scene_object_kind
  CHECK (kind IN ('work_center', 'agv', 'warehouse', 'person', 'truck'));

DO $$
DECLARE
  v_def TEXT;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def
  FROM pg_constraint
  WHERE conname = 'ck_factory_3d_scene_object_kind'
    AND conrelid = 'factory_3d_scene_object_s_539dcf81_b'::regclass;

  IF v_def IS NULL OR v_def NOT ILIKE '%work_center%' THEN
    RAISE EXCEPTION 'deploy_136 补丁失败：kind 约束未包含 work_center（def=%）', v_def;
  END IF;

  RAISE NOTICE 'OK：factory_3d_scene_object kind 约束已包含 work_center';
END;
$$;
