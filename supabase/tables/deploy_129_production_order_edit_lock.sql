-- ============================================================================
-- deploy_129_production_order_edit_lock.sql — 生产订单 released 后业务字段锁定
--
-- 背景：生产订单状态机 draft → planned → released → in_progress → completed
--       → closed（cancelled 任意阶段）。released 起已拍工序行（deploy_115/116）
--       并预占库存（deploy_57），in_progress 更有领料/报工/完工入库在发生。
--       此前前端 SupaModal 走 PostgREST 直连 UPDATE，任何状态都能改
--       product_id / bom_id / routing_id / planned_quantity 等业务字段，
--       会破坏工序行、预占、领料、成本的关联一致性。
--
-- 修复：BEFORE UPDATE 触发器，当「旧状态」已进入锁定态
--       （released / in_progress / completed / closed / cancelled）时，
--       禁止修改业务结构字段，仅放行：
--         · remark / priority        —— 用户可改的非业务字段
--         · status                   —— 状态流转（走 release/start/完工入库 RPC）
--         · completed_quantity       —— 系统回写（完工入库过账累计，见 deploy_93 补丁）
--         · reported_quantity / operation_progress_percent / actual_start_date /
--           actual_end_date          —— 系统回写（报工进度、首次开工补日期）
--         · is_deleted / updated_at / created_at / corp_id / emp_id —— 框架字段
--
-- 设计要点：
--   · 用 OLD 状态判断，不用 NEW：锁定的是「已经从 released 起步的订单」，
--     下达瞬间 draft/planned → released 的 UPDATE 不会被拦。
--   · 只拦「值真的变化」的列（IS DISTINCT FROM），幂等的同值更新不拦，
--     避免误伤系统回写里「顺带带上未变列」的 UPDATE。
--   · 冻结清单刻意排除 actual_* 日期：refresh_production_order_progress 在
--     报工时会在订单已 in_progress 的情况下自动补 actual_start_date，
--     若冻结会误伤系统路径。
--
-- 回滚：DROP TRIGGER trg_production_order_edit_lock ON erp_production_orders_s_539dcf81_b;
--       DROP FUNCTION public.trg_production_order_edit_lock();
--       （纯加锁约束，不影响任何数据）
--
-- 注：本脚本由 000_run_all 用 psql --single-transaction 执行，不要写 BEGIN/COMMIT。
-- ============================================================================

CREATE OR REPLACE FUNCTION public.trg_production_order_edit_lock()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_locked boolean;
  v_changed text;
BEGIN
  -- 软删除/框架字段变动直接放行（删除操作不属「编辑业务字段」）
  IF NEW.is_deleted IS DISTINCT FROM OLD.is_deleted
     AND NEW.is_deleted = 'y' THEN
    RETURN NEW;
  END IF;

  -- 仅当旧状态已进入锁定态时才拦截
  v_locked := COALESCE(OLD.status, '') IN
    ('released', 'in_progress', 'completed', 'closed', 'cancelled');
  IF NOT v_locked THEN
    RETURN NEW;
  END IF;

  -- 逐列判断「值变化」的冻结字段，命中即报错
  v_changed :=
    CASE WHEN NEW.product_id          IS DISTINCT FROM OLD.product_id          THEN 'product_id' ELSE NULL END;
  IF v_changed IS NULL THEN
    v_changed :=
      CASE WHEN NEW.bom_id            IS DISTINCT FROM OLD.bom_id            THEN 'bom_id' ELSE NULL END;
  END IF;
  IF v_changed IS NULL THEN
    v_changed :=
      CASE WHEN NEW.routing_id        IS DISTINCT FROM OLD.routing_id        THEN 'routing_id' ELSE NULL END;
  END IF;
  IF v_changed IS NULL THEN
    v_changed :=
      CASE WHEN NEW.warehouse_id      IS DISTINCT FROM OLD.warehouse_id      THEN 'warehouse_id' ELSE NULL END;
  END IF;
  IF v_changed IS NULL THEN
    v_changed :=
      CASE WHEN NEW.work_center_id    IS DISTINCT FROM OLD.work_center_id    THEN 'work_center_id' ELSE NULL END;
  END IF;
  IF v_changed IS NULL THEN
    v_changed :=
      CASE WHEN NEW.planned_quantity  IS DISTINCT FROM OLD.planned_quantity  THEN 'planned_quantity' ELSE NULL END;
  END IF;
  IF v_changed IS NULL THEN
    v_changed :=
      CASE WHEN NEW.scrapped_quantity IS DISTINCT FROM OLD.scrapped_quantity THEN 'scrapped_quantity' ELSE NULL END;
  END IF;
  IF v_changed IS NULL THEN
    v_changed :=
      CASE WHEN NEW.order_date        IS DISTINCT FROM OLD.order_date        THEN 'order_date' ELSE NULL END;
  END IF;
  IF v_changed IS NULL THEN
    v_changed :=
      CASE WHEN NEW.planned_start_date IS DISTINCT FROM OLD.planned_start_date THEN 'planned_start_date' ELSE NULL END;
  END IF;
  IF v_changed IS NULL THEN
    v_changed :=
      CASE WHEN NEW.planned_end_date  IS DISTINCT FROM OLD.planned_end_date  THEN 'planned_end_date' ELSE NULL END;
  END IF;
  IF v_changed IS NULL THEN
    v_changed :=
      CASE WHEN NEW.order_no          IS DISTINCT FROM OLD.order_no          THEN 'order_no' ELSE NULL END;
  END IF;

  IF v_changed IS NOT NULL THEN
    RAISE EXCEPTION '工单已下达（当前状态 %），业务字段已锁定，不能修改 %',
      COALESCE(OLD.status, 'NULL'), v_changed
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.trg_production_order_edit_lock() IS
  '生产订单 released 后锁定业务字段（产品/BOM/工艺路线/数量/仓库/计划日期/单号），仅放行 remark/priority/status 与系统回写字段。';

DROP TRIGGER IF EXISTS trg_production_order_edit_lock
  ON public.erp_production_orders_s_539dcf81_b;
CREATE TRIGGER trg_production_order_edit_lock
  BEFORE UPDATE ON public.erp_production_orders_s_539dcf81_b
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_production_order_edit_lock();

-- 自检：触发器缺一即报错，绝不静默半成品
DO $$
DECLARE
  v_missing text;
BEGIN
  SELECT string_agg(missing, ', ') INTO v_missing
  FROM (
    SELECT 'function trg_production_order_edit_lock' AS missing
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'trg_production_order_edit_lock'
    )
    UNION ALL
    SELECT 'trigger trg_production_order_edit_lock'
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_trigger t
      WHERE t.tgname = 'trg_production_order_edit_lock'
        AND NOT t.tgisinternal
    )
  ) s;

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'deploy_129 缺对象：%', v_missing;
  END IF;
END
$$;
