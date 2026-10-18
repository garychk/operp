-- ============================================================================
-- P0-1：工单工序化（工序任务）—— 生成 / 下达 / 开工 RPC + 报工驱动进度
-- ============================================================================
--
-- 表结构在 deploy_115。本文件补的是「让工序动起来」的那一半：
--   C1 下达时按工艺路线**生成工序行**
--   C2 报工**回写**工序完工数与工单进度
--   C4 状态机**动作入口**（下达 / 开工）与守卫
--
-- ---------------------------------------------------------------------------
-- 设计要点
-- ---------------------------------------------------------------------------
-- 1. `generate_production_order_operations` 镜像 `explode_production_order_bom`
--    （deploy_57）的守卫风格：订单 FOR UPDATE → 终态拒绝 → 解析主数据 →
--    拒绝空明细 → 软删重建。两张表是同一件事（把主数据拍进单据），
--    实现口径不该有两套。差别只有一处：BOM 展开写「材料行」，本函数写「工序行」。
--
-- 2. **重新生成（p_replace=TRUE）前必须没有报工**
--    工序行被换掉后，挂在旧行上的报工 `order_operation_id` 会变成孤儿
--    （复合外键会直接拒绝，但那时错误信息对用户毫无帮助）。所以在入口就拦，
--    并告诉用户要先撤报工 —— 与 BOM 展开拦「已领料」同理。
--
-- 3. 进度回写走**触发器**而不是「前端算完写回」
--    项目对「表头合计」的既有约定是前端重算回写（见 MEMORY：total_amount
--    无 DB 触发器）。**这里刻意破例**，理由：报工可以从任意客户端写
--    （前端表单 / 将来的扫码 / ai-server 补录），而「工序完工数 → 工单进度」
--    是一条**汇总约束**，只要有一个客户端忘了算，看板与报表立刻互相矛盾。
--    这类「多入口写同一事实」的场景必须由数据库收口（与 doc_flow_ledger
--    触发器同一思路）。作为交换，本文件把口径写得非常窄：
--      · 只统计 `status='confirmed'` 且未软删的报工（与成本卷算同口径）；
--      · 只写 3 个派生列（工序数/日期/状态、工单进度/末序数），不碰别的字段。
--
-- 4. `cancelled` 工序不参与进度
--    取消的工序等于「这道不做了」：既不计入分母（计划工时），也不计分子。
--    否则一张 10 道工序取消了 6 道的单子，进度会被永久压在 40%。
--
-- 5. 进度分母 = 计划工时；**全为 0 时退化为按工序条数**
--    本项目工艺路线的 `standard_hours` 允许为 0（`erp_operations` 默认 0），
--    工时全 0 时工时加权会恒等于 0 —— 那是静默失效，不是「进度为 0」。
--    所以分母为 0 时退化为已完成工序数 / 总工序数。两种口径都在列注释里写明。
--
-- 6. 工单状态只做**一个**自动迁移：draft/planned/released → in_progress
--    首次有工序开工即置 in_progress。**不自动置 completed/closed** ——
--    「做完了」在业务上是完工入库说了算（库存流水是唯一事实源），
--    报工只能证明工序做完，不能证明货已入账。前端对「末序完工」只给**建议**。
--
-- 7. 报工与工序行的工单必须一致（BEFORE 守卫，fail-loud）
--    工序行已经隐含了工单，报工再填一个 production_order_id 就有写岔的机会。
--    与其静默接受不一致数据，不如直接拒绝 —— 与项目「宁可报错不猜」一致。
--
-- 8. 权限姿态：所有函数 `SECURITY INVOKER`（不提升权限）
--    触发器也以调用者身份运行，命中 operp 的 fail-closed RLS。代价：如果某个
--    角色只给了报工的写权限、没给工序行的写权限，确认报工会因 RLS 失败 ——
--    这是**有意**的（不给越权留后门）。本项目角色粒度较粗（tenant_admin 全权），
--    实际不会踩到。
--
-- 依赖：deploy_115（本域的工序表）、deploy_57（风格参照）。
-- ============================================================================


-- ============================================================================
-- 1. 生成工单工序（下达时调用）
-- ============================================================================
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

COMMENT ON FUNCTION public.generate_production_order_operations(INTEGER, BOOLEAN) IS
  '按工艺路线生成工单工序行。p_replace=TRUE 时软删重建（已有报工则拒绝）。返回实际使用的工艺路线与工序数。';


-- ============================================================================
-- 2. 工序进度回写（由触发器调用，也可手动强制刷新）
-- ============================================================================
CREATE OR REPLACE FUNCTION public.refresh_production_operation_progress(
  p_operation_id INTEGER
) RETURNS VOID
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_qty      NUMERIC;
  v_scrap    NUMERIC;
  v_first    DATE;
  v_last     DATE;
  v_planned  NUMERIC;
  v_cur      VARCHAR(20);
  v_status   VARCHAR(20);
BEGIN
  IF p_operation_id IS NULL THEN
    RETURN;
  END IF;

  -- 人工取消的工序不参与自动回写（取消 = 这道不做了，报工不该把它拽回来）
  SELECT status, planned_quantity INTO v_cur, v_planned
  FROM public.erp_production_order_operations_s_539dcf81_b
  WHERE id = p_operation_id;
  IF NOT FOUND OR v_cur = 'cancelled' THEN
    RETURN;
  END IF;

  -- 只认已确认报工（与成本卷算同一口径，见文件头「设计要点 3」）
  SELECT COALESCE(SUM(r.completed_quantity), 0),
         COALESCE(SUM(r.scrapped_quantity), 0),
         MIN(r.report_date),
         MAX(r.report_date)
    INTO v_qty, v_scrap, v_first, v_last
  FROM public.erp_production_reports_s_539dcf81_b r
  WHERE r.order_operation_id = p_operation_id
    AND COALESCE(r.is_deleted, 'n') = 'n'
    AND r.status = 'confirmed';

  v_qty   := COALESCE(v_qty, 0);
  v_scrap := COALESCE(v_scrap, 0);

  v_status := CASE
    -- 没产出也没报废 → 回到待开工（报工被撤销/删除时进度要能退回去）
    WHEN v_qty <= 0 AND v_scrap <= 0 THEN 'pending'
    -- 合格数够了 → 完工（计划数量为 0 时，只要有产出就算完工）
    WHEN v_planned > 0 AND v_qty >= v_planned THEN 'completed'
    WHEN v_planned <= 0 AND v_qty > 0 THEN 'completed'
    ELSE 'in_progress'
  END;

  UPDATE public.erp_production_order_operations_s_539dcf81_b
  SET completed_quantity = v_qty,
      scrapped_quantity = v_scrap,
      actual_start_date = v_first,
      -- 未完工不写完工日（避免留下「开工即完工」的假日期）
      actual_end_date   = CASE WHEN v_status = 'completed' THEN v_last ELSE NULL END,
      status            = v_status,
      updated_at        = NOW()
  WHERE id = p_operation_id;
END;
$$;

COMMENT ON FUNCTION public.refresh_production_operation_progress(INTEGER) IS
  '按 confirmed 报工重算单个工序的完工数/报废数/实际起止/状态。cancelled 工序不参与。';


-- ============================================================================
-- 3. 工单进度回写
-- ============================================================================
CREATE OR REPLACE FUNCTION public.refresh_production_order_progress(
  p_order_id INTEGER
) RETURNS VOID
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_total_hours NUMERIC := 0;
  v_earned      NUMERIC := 0;
  v_progress    NUMERIC := 0;
  v_reported    NUMERIC := 0;
  v_op_total    INTEGER := 0;
  v_op_done     INTEGER := 0;
  v_first_start DATE;
  v_started     BOOLEAN := FALSE;
  v_cur_status  VARCHAR(20);
  v_start_date  DATE;
BEGIN
  IF p_order_id IS NULL THEN
    RETURN;
  END IF;

  SELECT status, actual_start_date INTO v_cur_status, v_start_date
  FROM public.erp_production_orders_s_539dcf81_b
  WHERE id = p_order_id AND is_deleted = 'n';
  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- 3.1 按计划工时加权（分母排除取消的工序，见文件头「设计要点 4」）
  SELECT COALESCE(SUM(op.planned_hours), 0),
         COALESCE(SUM(
           CASE
             WHEN op.planned_hours <= 0 THEN 0
             WHEN op.planned_quantity > 0
               THEN op.planned_hours * LEAST(1, op.completed_quantity / op.planned_quantity)
             WHEN op.completed_quantity > 0 THEN op.planned_hours
             ELSE 0
           END), 0),
         count(*),
         count(*) FILTER (WHERE op.status = 'completed'),
         MIN(op.actual_start_date)
    INTO v_total_hours, v_earned, v_op_total, v_op_done, v_first_start
  FROM public.erp_production_order_operations_s_539dcf81_b op
  WHERE op.order_id = p_order_id
    AND op.is_deleted = 'n'
    AND op.status <> 'cancelled';

  IF COALESCE(v_total_hours, 0) > 0 THEN
    v_progress := ROUND(LEAST(1, v_earned / v_total_hours) * 100, 2);
  ELSIF COALESCE(v_op_total, 0) > 0 THEN
    -- 工时全为 0（工艺路线没维护标准工时）→ 退化为按工序条数，见「设计要点 5」
    v_progress := ROUND(v_op_done::NUMERIC / v_op_total * 100, 2);
  ELSE
    v_progress := 0;
  END IF;

  -- 3.2 末序完工数（sequence_no 最大、其次行号最大）
  SELECT COALESCE(op.completed_quantity, 0) INTO v_reported
  FROM public.erp_production_order_operations_s_539dcf81_b op
  WHERE op.order_id = p_order_id
    AND op.is_deleted = 'n'
    AND op.status <> 'cancelled'
  ORDER BY op.sequence_no DESC, op.line_no DESC
  LIMIT 1;
  v_reported := COALESCE(v_reported, 0);

  v_started := COALESCE(v_op_done, 0) > 0 OR v_first_start IS NOT NULL;

  UPDATE public.erp_production_orders_s_539dcf81_b
  SET reported_quantity          = v_reported,
      operation_progress_percent = v_progress,
      -- 只做「未进终态 → in_progress」这一个自动迁移，见「设计要点 6」
      -- 含 draft：报工是「已经开工了」的最强证据，让工单停在 draft 却挂着
      -- 14% 的进度是自相矛盾的状态，比「未下达就被报工」更难解释。
      status = CASE
        WHEN COALESCE(status, '') IN ('draft', 'planned', 'released') AND v_started
          THEN 'in_progress'
        ELSE status
      END,
      -- 首次开工补实际开工日（已有值不动）
      actual_start_date = CASE
        WHEN actual_start_date IS NULL AND v_first_start IS NOT NULL
          THEN v_first_start
        ELSE actual_start_date
      END,
      updated_at = NOW()
  WHERE id = p_order_id AND is_deleted = 'n';
END;
$$;

COMMENT ON FUNCTION public.refresh_production_order_progress(INTEGER) IS
  '重算工单的 reported_quantity（末序完工数）与 operation_progress_percent（按计划工时加权；工时全 0 时退化为工序条数）。仅自动迁移 draft/planned/released → in_progress，不自动置 completed。';


-- ============================================================================
-- 4. 状态机动作入口（C4）
-- ============================================================================
CREATE OR REPLACE FUNCTION public.release_production_order(
  p_order_id INTEGER
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_order RECORD;
  v_gen   JSONB;
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
    RAISE EXCEPTION '订单处于 % 状态，不能下达', v_order.status
      USING ERRCODE = '55000';
  END IF;

  IF COALESCE(v_order.status, '') NOT IN ('draft', 'planned', 'released') THEN
    RAISE EXCEPTION '订单处于 % 状态，不能下达', COALESCE(v_order.status, 'NULL')
      USING ERRCODE = '55000';
  END IF;

  IF v_order.status IS DISTINCT FROM 'released' THEN
    UPDATE public.erp_production_orders_s_539dcf81_b
    SET status = 'released', updated_at = NOW()
    WHERE id = p_order_id;
  END IF;

  -- 下达的核心动作 = 按工艺路线拍出工序行（幂等：已有则不重建）
  v_gen := public.generate_production_order_operations(p_order_id, FALSE);

  RETURN jsonb_build_object(
    'ok', TRUE,
    'order_id', p_order_id,
    'status', 'released',
    'already_released', v_order.status = 'released',
    'operation_count', v_gen -> 'operation_count',
    'routing_id', v_gen -> 'routing_id',
    'routing_no', v_gen -> 'routing_no',
    'total_planned_hours', v_gen -> 'total_planned_hours');
END;
$$;

COMMENT ON FUNCTION public.release_production_order(INTEGER) IS
  '工单下达：draft/planned → released，并按工艺路线生成工序行（幂等）。';


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

COMMENT ON FUNCTION public.start_production_order(INTEGER) IS
  '工单开工：planned/released → in_progress，补实际开工日。draft 必须先下达。';


GRANT EXECUTE ON FUNCTION public.generate_production_order_operations(INTEGER, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.release_production_order(INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.start_production_order(INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_production_operation_progress(INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_production_order_progress(INTEGER) TO authenticated;


-- ============================================================================
-- 5. 触发器：报工 → 工序 → 工单进度
-- ============================================================================

-- 5.1 BEFORE 守卫：报工的工单必须与工序行所属工单一致（见「设计要点 7」）
CREATE OR REPLACE FUNCTION public.trg_production_report_operation_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_order_id INTEGER;
BEGIN
  IF NEW.order_operation_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT op.order_id INTO v_order_id
  FROM public.erp_production_order_operations_s_539dcf81_b op
  WHERE op.id = NEW.order_operation_id
    AND COALESCE(op.is_deleted, 'n') = 'n';

  IF v_order_id IS NULL THEN
    RAISE EXCEPTION '工序行 % 不存在或已删除，不能挂报工', NEW.order_operation_id
      USING ERRCODE = 'P0002';
  END IF;

  IF NEW.production_order_id IS DISTINCT FROM v_order_id THEN
    RAISE EXCEPTION '报工的生产订单 id=% 与工序行所属工单 id=% 不一致，请通过工序行选择工单',
      COALESCE(NEW.production_order_id::TEXT, 'NULL'), v_order_id
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_erp_production_reports_operation_guard
  ON public.erp_production_reports_s_539dcf81_b;
CREATE TRIGGER trg_erp_production_reports_operation_guard
  BEFORE INSERT OR UPDATE ON public.erp_production_reports_s_539dcf81_b
  FOR EACH ROW EXECUTE FUNCTION public.trg_production_report_operation_guard();


-- 5.2 AFTER：报工落库 → 刷新它挂着的工序行
CREATE OR REPLACE FUNCTION public.trg_production_report_operation_progress()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM public.refresh_production_operation_progress(NEW.order_operation_id);
  ELSIF TG_OP = 'UPDATE' THEN
    PERFORM public.refresh_production_operation_progress(NEW.order_operation_id);
    -- 报工被改挂到别的工序（或摘掉）→ 原工序也要重算
    IF OLD.order_operation_id IS DISTINCT FROM NEW.order_operation_id THEN
      PERFORM public.refresh_production_operation_progress(OLD.order_operation_id);
    END IF;
  ELSE
    PERFORM public.refresh_production_operation_progress(OLD.order_operation_id);
  END IF;
  -- 工单进度由「工序行」上的触发器统一收口（见 5.3），这里不重复调用
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_erp_production_reports_operation_progress
  ON public.erp_production_reports_s_539dcf81_b;
CREATE TRIGGER trg_erp_production_reports_operation_progress
  AFTER INSERT OR UPDATE OR DELETE ON public.erp_production_reports_s_539dcf81_b
  FOR EACH ROW EXECUTE FUNCTION public.trg_production_report_operation_progress();


-- 5.3 AFTER：工序行变动 → 刷新所属工单进度
--     生成工序时会逐行触发（10 道工序 = 10 次聚合），可接受：
--     聚合只按 order_id 走一次索引，且这是导入态的一次性开销。
CREATE OR REPLACE FUNCTION public.trg_production_operation_order_progress()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.refresh_production_order_progress(OLD.order_id);
    RETURN NULL;
  END IF;

  PERFORM public.refresh_production_order_progress(NEW.order_id);
  -- 工序行被挪到别的工单（罕见，但让两边都自洽）
  IF TG_OP = 'UPDATE' AND OLD.order_id IS DISTINCT FROM NEW.order_id THEN
    PERFORM public.refresh_production_order_progress(OLD.order_id);
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_erp_production_order_operations_progress
  ON public.erp_production_order_operations_s_539dcf81_b;
CREATE TRIGGER trg_erp_production_order_operations_progress
  AFTER INSERT OR UPDATE OR DELETE ON public.erp_production_order_operations_s_539dcf81_b
  FOR EACH ROW EXECUTE FUNCTION public.trg_production_operation_order_progress();


-- 修正 deploy_115 写下的列注释：进度分母为 0 时会退化为按工序条数
COMMENT ON COLUMN public.erp_production_orders_s_539dcf81_b.operation_progress_percent IS
  '工序进度百分比（0..100）。按各工序计划工时加权；所有工序计划工时合计为 0 时退化为「已完成工序数 / 总工序数」。取消的工序不计入。';


-- ============================================================================
-- 6. 自检（fail-loud）
-- ============================================================================
DO $$
DECLARE
  v_missing TEXT := '';
  v_def     TEXT;
  v_cnt     INTEGER;
  v_name    TEXT;
  v_fns     CONSTANT TEXT[] := ARRAY[
    'generate_production_order_operations',
    'release_production_order',
    'start_production_order',
    'refresh_production_operation_progress',
    'refresh_production_order_progress'
  ];
BEGIN
  -- 6.1 五个函数都在，且都是 SECURITY INVOKER（不提升权限）
  FOREACH v_name IN ARRAY v_fns LOOP
    SELECT count(*) INTO v_cnt
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = v_name;
    IF COALESCE(v_cnt, 0) = 0 THEN
      v_missing := v_missing || format('函数 %s 未创建;', v_name);
      CONTINUE;
    END IF;

    IF EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = v_name AND p.prosecdef
    ) THEN
      v_missing := v_missing || format('函数 %s 不该是 SECURITY DEFINER（会绕过 RLS）;', v_name);
    END IF;
  END LOOP;

  -- 6.2 三个触发器都在
  SELECT count(*) INTO v_cnt FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
   WHERE NOT t.tgisinternal
     AND t.tgname IN (
       'trg_erp_production_reports_operation_guard',
       'trg_erp_production_reports_operation_progress',
       'trg_erp_production_order_operations_progress'
     );
  IF COALESCE(v_cnt, 0) <> 3 THEN
    v_missing := v_missing || format('触发器只装了 %s 个（应为 3）;', v_cnt);
  END IF;

  -- 6.3 口径 token 必须留在函数体里，防止后人「优化」掉
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'generate_production_order_operations';
  IF v_def NOT ILIKE '%ROW_NUMBER%' OR v_def NOT ILIKE '%planned_hours%' THEN
    v_missing := v_missing || 'generate_production_order_operations 丢了工序行号 / 计划工时口径;';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'refresh_production_operation_progress';
  IF v_def NOT ILIKE '%confirmed%' THEN
    v_missing := v_missing || '工序进度丢了「只认 confirmed 报工」口径（会与成本口径打架）;';
  END IF;
  IF v_def NOT ILIKE '%cancelled%' THEN
    v_missing := v_missing || '工序进度丢了 cancelled 工序不参与的口径;';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'refresh_production_order_progress';
  IF v_def NOT ILIKE '%operation_progress_percent%' OR v_def NOT ILIKE '%reported_quantity%' THEN
    v_missing := v_missing || '工单进度丢了 operation_progress_percent / reported_quantity;';
  END IF;
  IF v_def NOT ILIKE '%released%' THEN
    v_missing := v_missing || '工单进度丢了 released → in_progress 自动迁移;';
  END IF;

  -- 6.4 权限：authenticated 必须能调（触发器以调用者身份运行，需要 EXECUTE）
  IF NOT has_function_privilege(
       'authenticated',
       'public.generate_production_order_operations(integer,boolean)',
       'EXECUTE') THEN
    v_missing := v_missing || 'authenticated 没有 generate_production_order_operations 的 EXECUTE 权限;';
  END IF;
  IF NOT has_function_privilege(
       'authenticated',
       'public.refresh_production_order_progress(integer)',
       'EXECUTE') THEN
    v_missing := v_missing || 'authenticated 没有 refresh_production_order_progress 的 EXECUTE 权限;';
  END IF;

  IF v_missing <> '' THEN
    RAISE EXCEPTION 'deploy_116 自检失败：%', v_missing;
  END IF;

  RAISE NOTICE 'deploy_116 OK：工序生成 / 下达 / 开工 RPC + 报工驱动工序与工单进度触发器已就绪';
END;
$$;
