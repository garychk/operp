-- ============================================================================
-- deploy_128_doc_flow_mps_meta.sql — 单据关联图补登记 mps_plan 单号元数据
--
-- 现象：生产订单 Connections 图的上游「主生产计划」节点显示的是数据库 id
--       （如 "1"），而不是 MPS 单号。
-- 根因：doc_flow_connections() 的单号解析走 doc_flow_document_no()，
--       它按 doc_flow_doc_meta 注册表的 no_field 列取人类可读单号；
--       deploy_38 初版只登记了 6 种单据，deploy_63 新增的 mps_plan
--       没有补登记 → 函数回退返回 p_document_id::TEXT（即 id）。
-- 修复：补一行 mps_plan -> plan_no 注册（幂等 ON CONFLICT）。
-- 回滚：DELETE FROM doc_flow_doc_meta WHERE document_type='mps_plan';
--       （仅回退为显示 id，不影响任何台账数据）
--
-- 注：本脚本由 000_run_all 用 psql --single-transaction 执行，不要写 BEGIN/COMMIT。
-- ============================================================================

INSERT INTO public.doc_flow_doc_meta (document_type, no_field, remark)
VALUES ('mps_plan', 'plan_no', '主生产计划')
ON CONFLICT (document_type) DO UPDATE
  SET no_field = EXCLUDED.no_field,
      remark = EXCLUDED.remark;

-- 自检：注册缺失直接报错，绝不静默半成品
DO $$
DECLARE
  v_missing text;
BEGIN
  SELECT 'doc_flow_doc_meta.mps_plan' AS missing
  WHERE NOT EXISTS (
    SELECT 1 FROM public.doc_flow_doc_meta
    WHERE document_type = 'mps_plan' AND no_field = 'plan_no'
  )
  INTO v_missing;

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'deploy_128 缺注册：%', v_missing;
  END IF;
END
$$;

-- 自检：抽样验证单号解析不再回退为 id（仅在前端真实写过的台账行上验）
DO $$
DECLARE
  v_sample_id integer;
  v_no text;
BEGIN
  SELECT t.source_document_id INTO v_sample_id
  FROM public.doc_flow_transfers t
  WHERE t.is_deleted = 'n' AND t.source_document_type = 'mps_plan'
  LIMIT 1;

  IF v_sample_id IS NOT NULL THEN
    v_no := public.doc_flow_document_no('mps_plan', v_sample_id);
    IF v_no IS NULL OR v_no = v_sample_id::text THEN
      RAISE EXCEPTION 'deploy_128 自检失败：doc_flow_document_no(mps_plan, %) 仍回退为 id（得到 %）',
        v_sample_id, v_no;
    END IF;
  END IF;
  -- 没有台账行时跳过（全新环境正常）
END
$$;
