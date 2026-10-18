-- deploy_116 补丁：工作中心必填校验（下达/开工）
-- 幂等：CREATE OR REPLACE FUNCTION

CREATE OR REPLACE FUNCTION public.generate_production_order_operations(
  p_order_id INTEGER,
  p_replace  BOOLEAN DEFAULT FALSE
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_order       RECORD;
  v_routing_id  INTEGER;
  v_routing     RECORD;
  v_detail_cnt  INTEGER;
  v_existing    INTEGER;
  v_reported    INTEGER;
  v_op_cnt      INTEGER := 0;
  v_total_hours NUMERIC := 0;
BEGIN
  IF p_order_id IS NULL OR p_order_id <= 0 THEN
    RAISE EXCEPTION 'A positive production order id is required'
      USING ERRCODE = '22023';
  END IF;

  SELECT x.* INTO v_order
  FROM public.erp_production_orders_s_539dcf81_b x
  WHERE x.id = p_order_id AND x.is_deleted = 'n'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Production order does not exist or is deleted'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_order.product_id IS NULL THEN
    RAISE EXCEPTION 'Production order % has no finished product', p_order_id
      USING ERRCODE = '23502';
  END IF;

  -- 工单必须指定工作中心，否则工序行会落到「无工作中心」的真空地带，
  -- 3D 驾驶舱 / 派工 / 报工都找不到归属，下游一律断链
  IF v_order.work_center_id IS NULL THEN
    RAISE EXCEPTION '生产订单 % 未指定工作中心，不能下达', v_order.order_no
      USING ERRCODE = '23502';
  END IF;

  IF COALESCE(v_order.status, '') IN ('completed', 'closed', 'cancelled') THEN
    RAISE EXCEPTION 'Cannot generate operations for a production order in status %',
      v_order.status USING ERRCODE = '55000';
  END IF;

  -- 工艺路线版本解析：显式指定优先，否则按产品 + 有效期 + 默认版本取
  v_routing_id := v_order.routing_id;
  IF v_routing_id IS NULL THEN
    SELECT r.id INTO v_routing_id
    FROM public.erp_routing_operations_s_539dcf81_b r
    WHERE r.product_id = v_order.product_id
      AND r.is_deleted = 'n'
      AND COALESCE(r.is_active, TRUE)
      AND COALESCE(r.effective_date, DATE '1900-01-01') <= v_order.order_date
      AND (r.expiry_date IS NULL OR r.expiry_date >= v_order.order_date)
    ORDER BY COALESCE(r.is_default, FALSE) DESC, r.version DESC NULLS LAST, r.id DESC
    LIMIT 1;
  END IF;
  IF v_routing_id IS NULL THEN
    RAISE EXCEPTION 'No active routing found for product % on %',
      v_order.product_id, v_order.order_date USING ERRCODE = 'P0002';
  END IF;

  SELECT r.* INTO v_routing
  FROM public.erp_routing_operations_s_539dcf81_b r
  WHERE r.id = v_routing_id AND r.is_deleted = 'n';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Routing % does not exist or is deleted', v_routing_id
      USING ERRCODE = 'P0002';
  END IF;

  SELECT count(*) INTO v_detail_cnt
  FROM public.erp_routing_operation_details_s_539dcf81_b d
  WHERE d.routing_id = v_routing_id AND d.is_deleted = 'n';
  IF COALESCE(v_detail_cnt, 0) = 0 THEN
    RAISE EXCEPTION '工艺路线 % 没有工序明细，无法生成工单工序', v_routing.routing_no
      USING ERRCODE = '23514';
  END IF;

  SELECT count(*) INTO v_existing
  FROM public.erp_production_order_operations_s_539dcf81_b
  WHERE order_id = p_order_id AND is_deleted = 'n';

  IF v_existing > 0 AND NOT p_replace THEN
    -- 幂等：已有工序行且不要求重建 → 原样返回现状，不报错（按钮可重复点）
    SELECT count(*), COALESCE(SUM(planned_hours), 0)
      INTO v_op_cnt, v_total_hours
    FROM public.erp_production_order_operations_s_539dcf81_b
    WHERE order_id = p_order_id AND is_deleted = 'n';

    RETURN jsonb_build_object(
      'ok', TRUE,
      'order_id', p_order_id,
      'routing_id', v_routing_id,
      'routing_no', v_routing.routing_no,
      'operation_count', v_op_cnt,
      'total_planned_hours', ROUND(v_total_hours, 6),
      'regenerated', FALSE);
  END IF;

  IF v_existing > 0 AND p_replace THEN
    -- 已经报过工就不能重建（见文件头「设计要点 2」）
    SELECT count(*) INTO v_reported
    FROM public.erp_production_reports_s_539dcf81_b r
    JOIN public.erp_production_order_operations_s_539dcf81_b op
      ON op.id = r.order_operation_id
    WHERE op.order_id = p_order_id
      AND op.is_deleted = 'n'
      AND COALESCE(r.is_deleted, 'n') = 'n';
    IF COALESCE(v_reported, 0) > 0 THEN
      RAISE EXCEPTION
        '工单已有 % 条报工挂在工序上，不能重新生成工序；请先撤销或删除这些报工',
        v_reported USING ERRCODE = '55000';
    END IF;

    UPDATE public.erp_production_order_operations_s_539dcf81_b
    SET is_deleted = 'y', updated_at = NOW()
    WHERE order_id = p_order_id AND is_deleted = 'n';
  END IF;

  INSERT INTO public.erp_production_order_operations_s_539dcf81_b (
    corp_id, emp_id, is_deleted, order_id, line_no, sequence_no,
    operation_id, work_center_id,
    planned_quantity, completed_quantity, scrapped_quantity,
    standard_hours_per_unit, setup_hours, planned_hours,
    status, is_inspection_required, source_routing_detail_id, remark,
    created_by, tenant_id
  )
  SELECT
    v_order.corp_id,
    public.current_sys_user_id()::TEXT,
    'n',
    p_order_id,
    s.rn,
    -- 工艺路线没写 sequence_no 时按行号 ×10 生成（10,20,30…），留出插序空间
    COALESCE(s.src_sequence_no, s.rn * 10),
    s.operation_id,
    -- 工作中心优先取工序主数据上的，缺省落到工单上的工作中心
    COALESCE(s.op_work_center_id, v_order.work_center_id),
    COALESCE(v_order.planned_quantity, 0),
    0,
    0,
    COALESCE(s.standard_hours, 0),
    COALESCE(s.setup_hours, 0),
    -- 计划总工时 = 准备工时（一次性）+ 单位工时 × 计划数量
    ROUND(COALESCE(s.setup_hours, 0)
          + COALESCE(s.standard_hours, 0) * COALESCE(v_order.planned_quantity, 0), 6),
    'pending',
    COALESCE(s.is_inspection_required, FALSE),
    s.detail_id,
    format('工艺路线 %s%s 序 %s',
           v_routing.routing_no,
           CASE WHEN v_routing.version IS NULL THEN '' ELSE ' v' || v_routing.version END,
           COALESCE(s.src_sequence_no, s.rn * 10)),
    public.current_sys_user_id(),
    -- ⚠️ 必须显式带 tenant_id：该列默认值是 current_tenant_id()，依赖 JWT 上下文，
    --    由 service_role 调用时会取到 NULL（与 deploy_57 同一坑）。
    v_order.tenant_id
  FROM (
    SELECT
      d.id                                AS detail_id,
      d.operation_id,
      op.work_center_id                   AS op_work_center_id,
      d.standard_hours,
      d.setup_hours,
      d.is_inspection_required,
      d.sequence_no                       AS src_sequence_no,
      ROW_NUMBER() OVER (
        ORDER BY COALESCE(d.sequence_no, 2147483647), d.id
      )::INTEGER                          AS rn
    FROM public.erp_routing_operation_details_s_539dcf81_b d
    LEFT JOIN public.erp_operations_s_539dcf81_b op
      ON op.id = d.operation_id AND COALESCE(op.is_deleted, 'n') = 'n'
    WHERE d.routing_id = v_routing_id AND d.is_deleted = 'n'
  ) s;

  GET DIAGNOSTICS v_op_cnt = ROW_COUNT;

  -- 第二道守卫：即使工单指定了工作中心，若工艺路线里某道工序的主数据本身没配
  -- 工作中心（此时会回落工单工作中心，见 INSERT 的 COALESCE），理论上不会出现 NULL；
  -- 这里兜底再查一遍，防止任何一道工序落空
  IF EXISTS (
    SELECT 1 FROM public.erp_production_order_operations_s_539dcf81_b
    WHERE order_id = p_order_id
      AND is_deleted = 'n'
      AND work_center_id IS NULL
  ) THEN
    RAISE EXCEPTION '生产订单 % 生成的工序存在未指定工作中心的行，请补齐工序主数据或工单的工作中心后重试',
      v_order.order_no USING ERRCODE = '23502';
  END IF;

  -- 解析出来的工艺路线回写到订单，界面上能看到实际用了哪一版
  IF v_order.routing_id IS NULL THEN
    UPDATE public.erp_production_orders_s_539dcf81_b
    SET routing_id = v_routing_id, updated_at = NOW()
    WHERE id = p_order_id;
  END IF;

  SELECT COALESCE(SUM(planned_hours), 0) INTO v_total_hours
  FROM public.erp_production_order_operations_s_539dcf81_b
  WHERE order_id = p_order_id AND is_deleted = 'n';

  RETURN jsonb_build_object(
    'ok', TRUE,
    'order_id', p_order_id,
    'routing_id', v_routing_id,
    'routing_no', v_routing.routing_no,
    'operation_count', v_op_cnt,
    'total_planned_hours', ROUND(v_total_hours, 6),
    'regenerated', v_existing > 0);
END;
$$;

CREATE OR REPLACE FUNCTION public.start_production_order(
  p_order_id INTEGER
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_order RECORD;
BEGIN
  IF p_order_id IS NULL OR p_order_id <= 0 THEN
    RAISE EXCEPTION 'A positive production order id is required'
      USING ERRCODE = '22023';
  END IF;

  SELECT x.* INTO v_order
  FROM public.erp_production_orders_s_539dcf81_b x
  WHERE x.id = p_order_id AND x.is_deleted = 'n'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Production order does not exist or is deleted'
      USING ERRCODE = 'P0002';
  END IF;

  IF COALESCE(v_order.status, '') IN ('completed', 'closed', 'cancelled') THEN
    RAISE EXCEPTION '订单处于 % 状态，不能开工', v_order.status
      USING ERRCODE = '55000';
  END IF;

  -- 必须先下达：工序还没拍出来就开工，等于没有执行计划
  IF COALESCE(v_order.status, '') NOT IN ('planned', 'released', 'in_progress') THEN
    RAISE EXCEPTION '订单尚未下达（当前 %），请先下达再开工', COALESCE(v_order.status, 'NULL')
      USING ERRCODE = '55000';
  END IF;

  -- 防御历史数据：工单必须指定工作中心（下达时已拦，此处兜底，防止老数据绕过）
  IF v_order.work_center_id IS NULL THEN
    RAISE EXCEPTION '生产订单 % 未指定工作中心，不能开工', v_order.order_no
      USING ERRCODE = '23502';
  END IF;

  IF v_order.status IS DISTINCT FROM 'in_progress' THEN
    UPDATE public.erp_production_orders_s_539dcf81_b
    SET status = 'in_progress',
        actual_start_date = COALESCE(actual_start_date, CURRENT_DATE),
        updated_at = NOW()
    WHERE id = p_order_id;
  END IF;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'order_id', p_order_id,
    'status', 'in_progress',
    'already_started', v_order.status = 'in_progress');
END;
$$;

GRANT EXECUTE ON FUNCTION public.generate_production_order_operations(INTEGER, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.start_production_order(INTEGER) TO authenticated;
