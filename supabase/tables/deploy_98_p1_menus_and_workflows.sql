-- ============================================================================
-- deploy_98 —— P1 收尾：新增页面菜单 + 三种退货单的审批流定义
-- ============================================================================
--
-- 两件事：
--   ① **审批流定义**：`wf_process_definitions` 里原本只有 purchase_order /
--      sales_order / purchase_receipt / sales_delivery / voucher 五种。
--      deploy_89~91 新建的三张退货单**没有流程定义**，`workflow_execute_action`
--      找不到 active process → 前端「提交/审核」按钮必然报错。
--      这里照 purchase_receipt 的三节点形状（提交 → 部门审批 → 终审）补齐。
--   ② **菜单**：P1-6（库存报表）、P1-9b（存货对账）、P1-9c（库存科目映射）
--      三个新页面还没有菜单入口。照 deploy_66 三步法注册。
--      （采购退货/销售退货/生产退货的菜单已在 deploy_89/90/91 注册，本文件不重复。）
--
-- 本脚本由 000_run_all 用 psql --single-transaction 执行，**不要写 BEGIN/COMMIT**。
-- 依赖：deploy_89/90/91（三张退货单）、deploy_96/97（三个报表与对账视图）、
--       deploy_66（菜单三步法与 clone_platform_baseline_to_tenant）。
-- ============================================================================


-- ============================================================================
-- 1. 审批流定义（基线，tenant_id = NULL）
-- ============================================================================
DO $$
DECLARE
  v_def      RECORD;
  v_proc_id  INTEGER;
  v_node     RECORD;
BEGIN
  FOR v_def IN
    SELECT * FROM (VALUES
      ('purchase_return_default', '采购退货审批流', 'purchase_return', '采购退货审核与出库、冲减应付',
       'inventory_manager', 'inventory_manager'),
      ('sales_return_default',    '销售退货审批流', 'sales_return',    '销售退货审核与入库、冲减应收',
       'inventory_manager', 'finance_manager'),
      ('material_return_default', '生产退料审批流', 'material_return', '生产退料审核与入库',
       'mrp_manager',       'mrp_manager')
    ) AS x(process_code, process_name, document_type, description, role_first, role_second)
  LOOP
    -- 幂等：已存在就直接用
    SELECT id INTO v_proc_id
      FROM public.wf_process_definitions
     WHERE tenant_id IS NULL AND process_code = v_def.process_code
       AND COALESCE(is_deleted, 'n') = 'n'
     LIMIT 1;

    IF v_proc_id IS NULL THEN
      INSERT INTO public.wf_process_definitions (
        corp_id, emp_id, is_deleted, process_code, process_name, document_type,
        description, is_active, version, config_json, tenant_id
      ) VALUES (
        NULL, NULL, 'n', v_def.process_code, v_def.process_name, v_def.document_type,
        v_def.description, TRUE, 1, '{"sequential": true}'::JSONB, NULL
      ) RETURNING id INTO v_proc_id;
    END IF;

    -- 三节点：提交 → 部门审批 → 终审
    FOR v_node IN
      SELECT * FROM (VALUES
        (1, 'submit',  '提交审批', v_def.role_first,  TRUE,  FALSE, '{"next":"manager"}'::JSONB),
        (2, 'manager', '部门审批', v_def.role_second, FALSE, FALSE, '{"next":"final"}'::JSONB),
        (3, 'final',   '终审',     'super_admin',     FALSE, TRUE,  '{"final":true}'::JSONB)
      ) AS n(sequence_no, node_key, node_name, role_code, is_start, is_end, rule_json)
    LOOP
      IF NOT EXISTS (
        SELECT 1 FROM public.wf_process_nodes
         WHERE process_id = v_proc_id AND node_key = v_node.node_key
           AND COALESCE(is_deleted, 'n') = 'n'
      ) THEN
        INSERT INTO public.wf_process_nodes (
          corp_id, emp_id, is_deleted, process_id, node_key, node_name, node_type,
          sequence_no, approver_mode, approver_role_code, approver_user_id,
          allow_reject, allow_withdraw, is_start_node, is_end_node, rule_json, tenant_id
        ) VALUES (
          NULL, NULL, 'n', v_proc_id, v_node.node_key, v_node.node_name, 'approval',
          v_node.sequence_no, 'role', v_node.role_code, NULL,
          TRUE, FALSE, v_node.is_start, v_node.is_end, v_node.rule_json, NULL
        );
      END IF;
    END LOOP;
  END LOOP;
END;
$$;


-- ============================================================================
-- 1b. 把流程定义**绑到单据类型**上
-- ============================================================================
--
-- ⚠️ 关键：`workflow_get_active_process_for_document()` 的第一条查询路径是
--     sys_document_types.workflow_process_id → wf_process_definitions。
--     只建流程定义不绑 workflow_process_id，函数会走"兜底按 document_type 找"，
--     但 `workflow_execute_action` 里若先取 `sys_document_types` 就会拿到空 ——
--     实际上 purchase_receipt 就是靠 workflow_process_id=3 绑定的（对照可见）。
--     所以这一步**必须做**，否则前端「提交/审核」仍然报错。
DO $$
DECLARE
  v_def   RECORD;
  v_pid   INTEGER;
BEGIN
  FOR v_def IN
    SELECT * FROM (VALUES
      ('purchase_return', 'purchase_return_default'),
      ('sales_return',    'sales_return_default'),
      ('material_return', 'material_return_default')
    ) AS x(document_type, process_code)
  LOOP
    SELECT id INTO v_pid FROM public.wf_process_definitions
     WHERE tenant_id IS NULL AND process_code = v_def.process_code
       AND COALESCE(is_deleted, 'n') = 'n'
     LIMIT 1;

    IF v_pid IS NULL THEN
      RAISE EXCEPTION '流程定义 % 不存在，无法绑定', v_def.process_code;
    END IF;

    UPDATE public.sys_document_types
       SET workflow_process_id = v_pid, updated_at = NOW()
     WHERE document_type = v_def.document_type
       AND tenant_id IS NULL
       AND workflow_process_id IS DISTINCT FROM v_pid;
  END LOOP;
END;
$$;


-- ============================================================================
-- 2. 菜单（照 deploy_66 三步法：基线 → 基线角色授权 → 已物化租户补差）
-- ============================================================================
INSERT INTO public.sys_menus (
  corp_id, emp_id, parent_id, menu_name, menu_code, menu_type, icon,
  path, component, sort_order, status, is_deleted, tenant_id
)
SELECT NULL, NULL,
  COALESCE((
    SELECT p.id FROM public.sys_menus p
     WHERE p.tenant_id IS NULL AND p.menu_code = 'inventory'
       AND COALESCE(p.is_deleted, 'n') = 'n'
     LIMIT 1
  ), 0),
  '库存报表', 'inventory_reports', 'C', 'BarChartOutlined',
  '/inventory/reports', './pages/inventory/InventoryReports', 16, '1', 'n', NULL
WHERE NOT EXISTS (
  SELECT 1 FROM public.sys_menus m
   WHERE m.tenant_id IS NULL AND m.menu_code = 'inventory_reports'
);

INSERT INTO public.sys_menus (
  corp_id, emp_id, parent_id, menu_name, menu_code, menu_type, icon,
  path, component, sort_order, status, is_deleted, tenant_id
)
SELECT NULL, NULL,
  COALESCE((
    SELECT p.id FROM public.sys_menus p
     WHERE p.tenant_id IS NULL AND p.menu_code = 'inventory'
       AND COALESCE(p.is_deleted, 'n') = 'n'
     LIMIT 1
  ), 0),
  '存货对账', 'inventory_reconciliation', 'C', 'AuditOutlined',
  '/inventory/reconciliation', './pages/inventory/InventoryReconciliation', 17, '1', 'n', NULL
WHERE NOT EXISTS (
  SELECT 1 FROM public.sys_menus m
   WHERE m.tenant_id IS NULL AND m.menu_code = 'inventory_reconciliation'
);

INSERT INTO public.sys_menus (
  corp_id, emp_id, parent_id, menu_name, menu_code, menu_type, icon,
  path, component, sort_order, status, is_deleted, tenant_id
)
SELECT NULL, NULL,
  COALESCE((
    SELECT p.id FROM public.sys_menus p
     WHERE p.tenant_id IS NULL AND p.menu_code = 'inventory'
       AND COALESCE(p.is_deleted, 'n') = 'n'
     LIMIT 1
  ), 0),
  '存货科目映射', 'inventory_subject-map', 'C', 'SettingOutlined',
  '/inventory/subject-map', './pages/inventory/InventorySubjectMap', 18, '1', 'n', NULL
WHERE NOT EXISTS (
  SELECT 1 FROM public.sys_menus m
   WHERE m.tenant_id IS NULL AND m.menu_code = 'inventory_subject-map'
);

-- 基线角色授权：报表/对账给到存货与财务条线，科目映射只给管理员与存货经理
INSERT INTO public.sys_role_menus (role_id, menu_id, is_deleted, tenant_id)
SELECT r.id, m.id, 'n', NULL
  FROM public.sys_roles r
 CROSS JOIN public.sys_menus m
 WHERE r.tenant_id IS NULL
   AND COALESCE(r.is_deleted, 'n') = 'n'
   AND COALESCE(m.is_deleted, 'n') = 'n'
   AND m.tenant_id IS NULL
   AND (
     (m.menu_code IN ('inventory_reports', 'inventory_reconciliation')
      AND r.role_code IN ('super_admin', 'tenant_admin', 'inventory_manager', 'finance_manager'))
     OR
     (m.menu_code = 'inventory_subject-map'
      AND r.role_code IN ('super_admin', 'tenant_admin', 'inventory_manager'))
   )
   AND NOT EXISTS (
     SELECT 1 FROM public.sys_role_menus dup
      WHERE dup.role_id = r.id AND dup.menu_id = m.id
   );

-- 已物化租户补差
DO $$
DECLARE
  v_tenant RECORD;
  v_result JSONB;
  v_count  INTEGER := 0;
BEGIN
  FOR v_tenant IN
    SELECT t.id, t.code FROM public.sys_tenants t
     WHERE COALESCE(t.is_deleted, 'n') = 'n' AND COALESCE(t.metadata_materialized, FALSE)
     ORDER BY t.id
  LOOP
    v_result := public.clone_platform_baseline_to_tenant(v_tenant.id, FALSE, TRUE);
    RAISE NOTICE '租户 % (%) 元数据补差：%', v_tenant.id, v_tenant.code, v_result;
    v_count := v_count + 1;
  END LOOP;
  RAISE NOTICE '已给 % 个已物化租户补差', v_count;
END;
$$;


-- ============================================================================
-- 3. 自检（fail-loud）
-- ============================================================================
DO $$
DECLARE
  v_missing TEXT := '';
  v_n       INTEGER;
  v_dt      TEXT;
  v_proc    INTEGER;
  v_tenant  RECORD;
  v_code    TEXT;
BEGIN
  -- ① 三个退货单都必须有 active 流程定义 + 3 个节点
  FOREACH v_dt IN ARRAY ARRAY['purchase_return', 'sales_return', 'material_return'] LOOP
    SELECT id INTO v_proc FROM public.wf_process_definitions
     WHERE tenant_id IS NULL AND document_type = v_dt
       AND COALESCE(is_deleted, 'n') = 'n' AND is_active
     LIMIT 1;
    IF v_proc IS NULL THEN
      v_missing := v_missing || format('%s 缺 active 流程定义;', v_dt);
      CONTINUE;
    END IF;

    SELECT count(*) INTO v_n FROM public.wf_process_nodes
     WHERE process_id = v_proc AND COALESCE(is_deleted, 'n') = 'n';
    IF v_n <> 3 THEN
      v_missing := v_missing || format('%s 流程节点数 %s <> 3;', v_dt, v_n);
    END IF;

    SELECT count(*) INTO v_n FROM public.wf_process_nodes
     WHERE process_id = v_proc AND COALESCE(is_deleted, 'n') = 'n' AND is_start_node;
    IF v_n <> 1 THEN
      v_missing := v_missing || format('%s 起始节点不唯一（%s）;', v_dt, v_n);
    END IF;

    SELECT count(*) INTO v_n FROM public.wf_process_nodes
     WHERE process_id = v_proc AND COALESCE(is_deleted, 'n') = 'n' AND is_end_node;
    IF v_n <> 1 THEN
      v_missing := v_missing || format('%s 结束节点不唯一（%s）;', v_dt, v_n);
    END IF;

    -- 必须绑到单据类型上（否则 workflow_execute_action 取不到流程）
    SELECT count(*) INTO v_n FROM public.sys_document_types
     WHERE document_type = v_dt AND tenant_id IS NULL
       AND workflow_process_id = v_proc AND COALESCE(is_deleted, 'n') = 'n';
    IF v_n <> 1 THEN
      v_missing := v_missing || format('%s 未绑定 workflow_process_id;', v_dt);
    END IF;
  END LOOP;

  -- ② 三个新菜单的基线必须存在（sys_menus 没有 (tenant_id, menu_code) 唯一索引，
  --    所以这里要显式查重，防止重复插入）
  FOREACH v_code IN ARRAY ARRAY['inventory_reports', 'inventory_reconciliation', 'inventory_subject-map'] LOOP
    SELECT count(*) INTO v_n FROM public.sys_menus
     WHERE tenant_id IS NULL AND menu_code = v_code AND COALESCE(is_deleted, 'n') = 'n';
    IF v_n <> 1 THEN
      v_missing := v_missing || format('基线菜单 %s 数量 %s <> 1;', v_code, v_n);
    END IF;

    SELECT count(*) INTO v_n
      FROM public.sys_role_menus rm
      JOIN public.sys_roles r ON r.id = rm.role_id
      JOIN public.sys_menus m ON m.id = rm.menu_id
     WHERE r.tenant_id IS NULL AND rm.tenant_id IS NULL
       AND m.menu_code = v_code
       AND COALESCE(rm.is_deleted, 'n') = 'n'
       AND r.role_code IN ('super_admin', 'tenant_admin', 'inventory_manager');
    IF v_n < 3 THEN
      v_missing := v_missing || format('菜单 %s 基线授权不足（%s < 3）;', v_code, v_n);
    END IF;
  END LOOP;

  -- ③ 已物化租户必须有菜单副本
  FOR v_tenant IN
    SELECT t.id FROM public.sys_tenants t
     WHERE COALESCE(t.is_deleted, 'n') = 'n' AND COALESCE(t.metadata_materialized, FALSE)
  LOOP
    SELECT count(*) INTO v_n FROM public.sys_menus m
     WHERE m.tenant_id = v_tenant.id
       AND m.menu_code IN ('inventory_reports', 'inventory_reconciliation', 'inventory_subject-map')
       AND COALESCE(m.is_deleted, 'n') = 'n';
    IF v_n <> 3 THEN
      v_missing := v_missing || format('租户%s 新菜单副本不足（%s < 3）;', v_tenant.id, v_n);
    END IF;
  END LOOP;

  -- ④ 承载 super_admin 的租户绝不能被物化（元数据不能 fail-closed）
  SELECT count(*) INTO v_n FROM public.sys_tenants
   WHERE COALESCE(metadata_materialized, FALSE)
     AND id IN (SELECT DISTINCT tenant_id FROM public.sys_roles
                 WHERE role_code = 'super_admin' AND tenant_id IS NOT NULL);
  IF v_n > 0 THEN
    v_missing := v_missing || '存在承载 super_admin 却被物化的租户（元数据会被隔离掉）;';
  END IF;

  IF v_missing <> '' THEN
    RAISE EXCEPTION 'deploy_98 自检失败：%', v_missing;
  END IF;

  RAISE NOTICE 'deploy_98 OK：三张退货单审批流 + 库存报表/对账/科目映射菜单 已就绪';
END;
$$;
