-- ============================================================================
-- deploy_130_backfill_report_operation.sql — 回填报工单缺失的 operation_id
--
-- 现象：生产报工列表「工序」列显示 "-"，因为报工单 operation_id 为 NULL，
--       只有 order_operation_id（挂在工单工序行上）。
-- 根因：报工挂「工单工序」时，operation_id 应由工序行同步回填，但历史数据
--       （工单工序功能 deploy_115/P0-1 上线前后）漏了这一步 → 列表工序列
--       只读 operation_id，取不到值。
-- 修复：一次性把「operation_id 为空、order_operation_id 有值」的报工单，
--       从对应工单工序行的 operation_id 回填。幂等（已非空的不动）。
-- 回滚：无（回填的是派生冗余字段，来源是工序行；如需还原可
--       UPDATE ... SET operation_id=NULL WHERE order_operation_id IS NOT NULL，
--       但会再次导致列表工序列取不到，不建议）。
--
-- 注：本脚本由 000_run_all 用 psql --single-transaction 执行，不要写 BEGIN/COMMIT。
-- ============================================================================

UPDATE public.erp_production_reports_s_539dcf81_b r
SET operation_id = oo.operation_id,
    updated_at = NOW()
FROM public.erp_production_order_operations_s_539dcf81_b oo
WHERE r.order_operation_id = oo.id
  AND r.operation_id IS NULL
  AND oo.operation_id IS NOT NULL;

-- 自检：不应再有「挂了工序行却缺 operation_id」的报工单
DO $$
DECLARE
  v_bad integer;
BEGIN
  SELECT count(*) INTO v_bad
  FROM public.erp_production_reports_s_539dcf81_b r
  JOIN public.erp_production_order_operations_s_539dcf81_b oo
    ON oo.id = r.order_operation_id
  WHERE r.operation_id IS NULL
    AND oo.operation_id IS NOT NULL;

  IF v_bad > 0 THEN
    RAISE EXCEPTION 'deploy_130 自检失败：仍有 % 条报工单缺 operation_id', v_bad;
  END IF;
END
$$;
