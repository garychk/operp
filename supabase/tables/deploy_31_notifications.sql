-- ============================================================
-- 统一通知中心 (Unified Notification Center)
-- 覆盖：审批待办/审批结果、库存预警、订单延期预警、MRP 任务完成
-- 架构：所有来源统一走 notify_push() 写入 sys_notifications，
--       前端通过 Supabase Realtime 订阅 INSERT 实时展示铃铛未读数
-- 依赖：deploy_01 (sys_users/sys_roles)、deploy_02 (current_sys_user_id)、
--       deploy_14 (wf_* 工作流表)
-- ============================================================

CREATE TABLE IF NOT EXISTS public.sys_notifications (
  id SERIAL PRIMARY KEY,
  corp_id VARCHAR(128),
  emp_id VARCHAR(128),
  is_deleted CHAR(1) DEFAULT 'n',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  recipient_user_id INTEGER NOT NULL,
  recipient_role_code VARCHAR(100),
  notification_type VARCHAR(50) NOT NULL,
  severity VARCHAR(20) NOT NULL DEFAULT 'info',
  title VARCHAR(200) NOT NULL,
  content TEXT,
  source_type VARCHAR(50),
  source_id INTEGER,
  source_no VARCHAR(100),
  link_path VARCHAR(255),
  dedup_key VARCHAR(200),
  is_read BOOLEAN DEFAULT FALSE,
  read_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sys_notifications_recipient
  ON public.sys_notifications (recipient_user_id, is_read, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sys_notifications_dedup
  ON public.sys_notifications (dedup_key, created_at);

GRANT SELECT, UPDATE ON public.sys_notifications TO authenticated;

ALTER TABLE public.sys_notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Notifications select own" ON public.sys_notifications;
CREATE POLICY "Notifications select own"
ON public.sys_notifications
FOR SELECT
TO authenticated
USING (recipient_user_id = public.current_sys_user_id());

DROP POLICY IF EXISTS "Notifications update own" ON public.sys_notifications;
CREATE POLICY "Notifications update own"
ON public.sys_notifications
FOR UPDATE
TO authenticated
USING (recipient_user_id = public.current_sys_user_id())
WITH CHECK (recipient_user_id = public.current_sys_user_id());

-- ------------------------------------------------------------
-- source_type -> 前端路由
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.notify_link_path(p_source_type TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE p_source_type
    WHEN 'purchase_order'   THEN '/inventory/purchase'
    WHEN 'purchase_receipt' THEN '/inventory/purchase-receipts'
    WHEN 'sales_order'      THEN '/inventory/sales'
    WHEN 'sales_delivery'   THEN '/inventory/sales-deliveries'
    WHEN 'voucher'          THEN '/finance/vouchers'
    WHEN 'stock_adjustment' THEN '/inventory/stock-adjustments'
    WHEN 'stock_count'      THEN '/inventory/stock-counts'
    WHEN 'inventory_transfer' THEN '/inventory/transfers'
    WHEN 'product'          THEN '/inventory/products'
    WHEN 'production_order' THEN '/mrp/production'
    WHEN 'mrp_plan'         THEN '/mrp/plans'
    ELSE NULL
  END;
$$;

-- ------------------------------------------------------------
-- 统一推送入口
-- p_recipient_user_ids 与 p_recipient_role_code 可同时使用；
-- 角色名下无有效用户时自动降级为 super_admin，保证通知不丢失；
-- p_dedup_key 非空时，同一收件人在时间窗口内不重复接收同 key 通知
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.notify_push(
  p_notification_type TEXT,
  p_severity TEXT DEFAULT 'info',
  p_title TEXT DEFAULT NULL,
  p_content TEXT DEFAULT NULL,
  p_source_type TEXT DEFAULT NULL,
  p_source_id INTEGER DEFAULT NULL,
  p_source_no TEXT DEFAULT NULL,
  p_link_path TEXT DEFAULT NULL,
  p_dedup_key TEXT DEFAULT NULL,
  p_recipient_user_ids INTEGER[] DEFAULT NULL,
  p_recipient_role_code TEXT DEFAULT NULL,
  p_dedup_window_hours INTEGER DEFAULT 24
) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_ids INTEGER[];
  v_role_ids INTEGER[];
  v_uid INTEGER;
  v_dedup TEXT;
  v_link TEXT;
  v_inserted INTEGER := 0;
BEGIN
  v_user_ids := COALESCE(p_recipient_user_ids, ARRAY[]::INTEGER[]);

  IF p_recipient_role_code IS NOT NULL THEN
    SELECT ARRAY_AGG(DISTINCT ur.user_id) INTO v_role_ids
    FROM public.sys_user_roles ur
    JOIN public.sys_roles r ON r.id = ur.role_id
      AND r.is_deleted = 'n' AND r.status = '1' AND r.role_code = p_recipient_role_code
    JOIN public.sys_users u ON u.id = ur.user_id
      AND u.is_deleted = 'n' AND u.status = '1'
    WHERE ur.is_deleted = 'n';

    IF (v_role_ids IS NULL OR array_length(v_role_ids, 1) IS NULL)
       AND p_recipient_role_code <> 'super_admin' THEN
      SELECT ARRAY_AGG(DISTINCT ur.user_id) INTO v_role_ids
      FROM public.sys_user_roles ur
      JOIN public.sys_roles r ON r.id = ur.role_id
        AND r.is_deleted = 'n' AND r.status = '1' AND r.role_code = 'super_admin'
      JOIN public.sys_users u ON u.id = ur.user_id
        AND u.is_deleted = 'n' AND u.status = '1'
      WHERE ur.is_deleted = 'n';
    END IF;

    IF v_role_ids IS NOT NULL AND array_length(v_role_ids, 1) > 0 THEN
      SELECT ARRAY_AGG(DISTINCT x) INTO v_user_ids
      FROM unnest(v_user_ids || v_role_ids) AS x
      WHERE x IS NOT NULL;
    END IF;
  END IF;

  IF v_user_ids IS NULL OR array_length(v_user_ids, 1) IS NULL THEN
    RETURN 0;
  END IF;

  v_link := COALESCE(p_link_path, public.notify_link_path(p_source_type));

  FOREACH v_uid IN ARRAY v_user_ids LOOP
    IF v_uid IS NULL THEN
      CONTINUE;
    END IF;

    IF p_dedup_key IS NOT NULL THEN
      v_dedup := p_dedup_key || ':' || v_uid::TEXT;
      IF EXISTS (
        SELECT 1 FROM public.sys_notifications
        WHERE dedup_key = v_dedup
          AND is_deleted = 'n'
          AND created_at > NOW() - make_interval(hours => p_dedup_window_hours)
      ) THEN
        CONTINUE;
      END IF;
    END IF;

    INSERT INTO public.sys_notifications (
      recipient_user_id, recipient_role_code, notification_type, severity,
      title, content, source_type, source_id, source_no, link_path, dedup_key
    ) VALUES (
      v_uid, p_recipient_role_code, p_notification_type, p_severity,
      p_title, p_content, p_source_type, p_source_id, p_source_no, v_link, v_dedup
    );
    v_inserted := v_inserted + 1;
  END LOOP;

  RETURN v_inserted;
END;
$$;

GRANT EXECUTE ON FUNCTION public.notify_push(TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, INTEGER[], TEXT, INTEGER) TO authenticated;

-- ------------------------------------------------------------
-- 审批流通知：wf_process_instances 状态/节点变更
-- 1) 到达新节点 -> 通知该节点审批人（approval_pending）
-- 2) pending -> draft（驳回/撤回）-> 通知发起人（approval_result）
-- 3) pending -> approved -> 通知发起人（approval_result）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.wf_notify_on_instance_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_node RECORD;
  v_actor INTEGER;
  v_link TEXT;
  v_doc_no TEXT;
BEGIN
  IF NEW.is_deleted = 'y' THEN
    RETURN NEW;
  END IF;

  v_actor := public.current_sys_user_id();
  v_doc_no := COALESCE(NEW.document_no, NEW.document_type || '-' || NEW.document_id);
  v_link := public.notify_link_path(NEW.document_type);

  IF NEW.status = 'pending' AND NEW.current_node_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR OLD.current_node_id IS DISTINCT FROM NEW.current_node_id) THEN
    SELECT * INTO v_node
    FROM public.wf_process_nodes
    WHERE id = NEW.current_node_id AND is_deleted = 'n';

    IF FOUND THEN
      IF v_node.approver_mode = 'user' AND v_node.approver_user_id IS NOT NULL THEN
        PERFORM public.notify_push(
          'approval_pending', 'warning',
          '待审批：' || v_doc_no,
          '单据已进入节点「' || v_node.node_name || '」，等待您审批。',
          NEW.document_type, NEW.document_id, NEW.document_no, v_link,
          'wf:' || NEW.id || ':' || v_node.id,
          ARRAY[v_node.approver_user_id], NULL
        );
      ELSIF v_node.approver_mode = 'role' AND v_node.approver_role_code IS NOT NULL THEN
        PERFORM public.notify_push(
          'approval_pending', 'warning',
          '待审批：' || v_doc_no,
          '单据已进入节点「' || v_node.node_name || '」，等待角色「' || v_node.approver_role_code || '」审批。',
          NEW.document_type, NEW.document_id, NEW.document_no, v_link,
          'wf:' || NEW.id || ':' || v_node.id,
          NULL, v_node.approver_role_code
        );
      END IF;
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.status = 'pending' AND NEW.status = 'draft'
     AND NEW.started_by IS NOT NULL AND NEW.started_by <> COALESCE(v_actor, 0) THEN
    PERFORM public.notify_push(
      'approval_result', 'critical',
      '单据被退回：' || v_doc_no,
      '您的单据在节点「' || COALESCE(OLD.current_node_name, '') || '」被退回，请处理后重新提交。',
      NEW.document_type, NEW.document_id, NEW.document_no, v_link,
      'wf-result:' || NEW.id || ':' || NEW.current_step_no,
      ARRAY[NEW.started_by], NULL
    );
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.status = 'pending' AND NEW.status = 'approved'
     AND NEW.started_by IS NOT NULL AND NEW.started_by <> COALESCE(v_actor, 0) THEN
    PERFORM public.notify_push(
      'approval_result', 'info',
      '审批通过：' || v_doc_no,
      '您的单据已完成全部审批。',
      NEW.document_type, NEW.document_id, NEW.document_no, v_link,
      'wf-result:' || NEW.id || ':' || NEW.current_step_no,
      ARRAY[NEW.started_by], NULL
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_wf_notify ON public.wf_process_instances;
CREATE TRIGGER trg_wf_notify
AFTER INSERT OR UPDATE ON public.wf_process_instances
FOR EACH ROW EXECUTE FUNCTION public.wf_notify_on_instance_change();

-- ------------------------------------------------------------
-- MRP 任务完成通知：erp_mrp_plans 状态 -> completed
-- 派发给 mrp_manager 角色（无该角色用户时 notify_push 自动降级 super_admin）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mrp_notify_on_status_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.is_deleted = 'y' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status
     AND NEW.status = 'completed' THEN
    PERFORM public.notify_push(
      'task_completed', 'info',
      'MRP 运算完成：' || NEW.plan_no,
      '计划 ' || NEW.plan_no || ' 已运算完成，可查看运算结果。',
      'mrp_plan', NEW.id, NEW.plan_no, '/mrp/plans',
      'mrp-plan:' || NEW.id,
      NULL, 'mrp_manager'
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_mrp_notify ON public.erp_mrp_plans_s_539dcf81_b;
CREATE TRIGGER trg_mrp_notify
AFTER UPDATE ON public.erp_mrp_plans_s_539dcf81_b
FOR EACH ROW EXECUTE FUNCTION public.mrp_notify_on_status_change();

-- ------------------------------------------------------------
-- 库存预警扫描（pg_cron 定时调用）
-- 现存量合计 < min_stock -> critical；< safety_stock -> warning
-- 派发给 inventory_manager 角色，24h 去重
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.check_inventory_warnings()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pushed INTEGER := 0;
  v_count INTEGER;
  rec RECORD;
BEGIN
  FOR rec IN
    WITH stock AS (
      SELECT i.product_id, SUM(COALESCE(i.quantity, 0)) AS on_hand
      FROM public.erp_inventory_s_539dcf81_b i
      WHERE i.is_deleted = 'n' AND i.product_id IS NOT NULL
      GROUP BY i.product_id
    )
    SELECT p.id AS product_id, p.code, p.name, p.unit, s.on_hand,
           p.safety_stock, p.min_stock,
           CASE
             WHEN s.on_hand < COALESCE(p.min_stock, 0) THEN 'critical'
             ELSE 'warning'
           END AS sev
    FROM public.erp_products_s_539dcf81_b p
    JOIN stock s ON s.product_id = p.id
    WHERE p.is_deleted = 'n'
      AND (
        (p.min_stock IS NOT NULL AND s.on_hand < p.min_stock)
        OR (p.safety_stock IS NOT NULL AND s.on_hand < p.safety_stock)
      )
  LOOP
    SELECT public.notify_push(
      'inventory_warning', rec.sev,
      '库存预警：' || rec.code || ' ' || COALESCE(rec.name, ''),
      '现存量 ' || rec.on_hand || COALESCE(rec.unit, '') ||
        '，安全库存 ' || COALESCE(rec.safety_stock, 0) ||
        '，最低库存 ' || COALESCE(rec.min_stock, 0) || '。',
      'product', rec.product_id, rec.code, '/inventory/products',
      'inv-warn:' || rec.product_id || ':' || rec.sev,
      NULL, 'inventory_manager', 24
    ) INTO v_count;
    v_pushed := v_pushed + COALESCE(v_count, 0);
  END LOOP;

  RETURN v_pushed;
END;
$$;

-- ------------------------------------------------------------
-- 订单延期预警扫描（pg_cron 定时调用）
-- 采购订单：交期已过且收货数量 < 订购数量（超 7 天 critical，否则 warning）
-- 销售订单：交期已过且未完结（超 7 天 critical，否则 warning）
-- 派发给 inventory_manager 角色，24h 去重
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.check_order_delay_warnings()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pushed INTEGER := 0;
  v_count INTEGER;
  rec RECORD;
BEGIN
  FOR rec IN
    SELECT o.id, o.order_no, o.delivery_date,
           COALESCE(SUM(d.quantity), 0) AS ordered_qty,
           COALESCE(SUM(d.received_quantity), 0) AS received_qty,
           (CURRENT_DATE - o.delivery_date::date) AS overdue_days
    FROM public.erp_purchase_orders_s_539dcf81_b o
    LEFT JOIN public.erp_purchase_order_details_s_539dcf81_b d
      ON d.order_id = o.id AND d.is_deleted = 'n'
    WHERE o.is_deleted = 'n'
      AND o.delivery_date IS NOT NULL
      AND o.delivery_date::date < CURRENT_DATE
      AND COALESCE(o.status, '') NOT IN ('completed', 'cancelled', 'closed', 'rejected')
    GROUP BY o.id, o.order_no, o.delivery_date
    HAVING COALESCE(SUM(d.received_quantity), 0) < COALESCE(SUM(d.quantity), 0)
  LOOP
    SELECT public.notify_push(
      'order_delay',
      CASE WHEN rec.overdue_days > 7 THEN 'critical' ELSE 'warning' END,
      '采购订单延期：' || rec.order_no,
      '交期 ' || rec.delivery_date || ' 已超 ' || rec.overdue_days || ' 天，' ||
        '已收货 ' || rec.received_qty || ' / ' || rec.ordered_qty || '。',
      'purchase_order', rec.id, rec.order_no, '/inventory/purchase',
      'po-delay:' || rec.id,
      NULL, 'inventory_manager', 24
    ) INTO v_count;
    v_pushed := v_pushed + COALESCE(v_count, 0);
  END LOOP;

  FOR rec IN
    SELECT o.id, o.order_no, o.delivery_date,
           (CURRENT_DATE - o.delivery_date::date) AS overdue_days
    FROM public.erp_sales_orders_s_539dcf81_b o
    WHERE o.is_deleted = 'n'
      AND o.delivery_date IS NOT NULL
      AND o.delivery_date::date < CURRENT_DATE
      AND COALESCE(o.status, '') NOT IN ('completed', 'cancelled', 'closed', 'rejected')
  LOOP
    SELECT public.notify_push(
      'order_delay',
      CASE WHEN rec.overdue_days > 7 THEN 'critical' ELSE 'warning' END,
      '销售订单延期：' || rec.order_no,
      '交期 ' || rec.delivery_date || ' 已超 ' || rec.overdue_days || ' 天，请跟进出库。',
      'sales_order', rec.id, rec.order_no, '/inventory/sales',
      'so-delay:' || rec.id,
      NULL, 'inventory_manager', 24
    ) INTO v_count;
    v_pushed := v_pushed + COALESCE(v_count, 0);
  END LOOP;

  RETURN v_pushed;
END;
$$;

-- ------------------------------------------------------------
-- Realtime：把通知表加入 supabase_realtime publication（RLS 生效）
-- ------------------------------------------------------------
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.sys_notifications;
  RAISE NOTICE 'sys_notifications added to supabase_realtime publication';
EXCEPTION
  WHEN duplicate_object THEN
    RAISE NOTICE 'sys_notifications already in supabase_realtime publication';
  WHEN OTHERS THEN
    RAISE NOTICE 'Could not alter supabase_realtime publication: % - 请在 Supabase Dashboard 手动开启该表的 Realtime', SQLERRM;
END $$;

-- ------------------------------------------------------------
-- pg_cron：定时调度两个预警扫描
-- 库存预警：每天 08:15-18:15 每小时一次；订单延期：每天 08:30 一次
-- 若环境未启用 pg_cron 扩展则跳过（可在 Dashboard 手动启用后重跑本段）
-- ------------------------------------------------------------
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_cron;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron not available: %', SQLERRM;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule('erp-inventory-warning');
    PERFORM cron.unschedule('erp-order-delay');
    PERFORM cron.schedule('erp-inventory-warning', '15 8-18 * * *', 'SELECT public.check_inventory_warnings();');
    PERFORM cron.schedule('erp-order-delay', '30 8 * * *', 'SELECT public.check_order_delay_warnings();');
    RAISE NOTICE 'pg_cron jobs scheduled';
  ELSE
    RAISE NOTICE 'pg_cron extension not installed, scheduling skipped';
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron scheduling failed: %', SQLERRM;
END $$;
