-- Lightweight but configurable workflow engine for ERP documents.
-- Supports multi-step sequential approvals, rejection, withdrawal, and history.

CREATE TABLE IF NOT EXISTS public.wf_process_definitions (
  id SERIAL PRIMARY KEY,
  corp_id VARCHAR(128),
  emp_id VARCHAR(128),
  is_deleted CHAR(1) DEFAULT 'n',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  process_code VARCHAR(100) NOT NULL UNIQUE,
  process_name VARCHAR(200) NOT NULL,
  document_type VARCHAR(100) NOT NULL,
  description TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  version INTEGER DEFAULT 1,
  config_json JSONB DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS public.wf_process_nodes (
  id SERIAL PRIMARY KEY,
  corp_id VARCHAR(128),
  emp_id VARCHAR(128),
  is_deleted CHAR(1) DEFAULT 'n',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  process_id INTEGER NOT NULL REFERENCES public.wf_process_definitions(id) ON DELETE CASCADE,
  node_key VARCHAR(100) NOT NULL,
  node_name VARCHAR(200) NOT NULL,
  node_type VARCHAR(30) NOT NULL DEFAULT 'approval',
  sequence_no INTEGER NOT NULL,
  approver_mode VARCHAR(30) DEFAULT 'role',
  approver_role_code VARCHAR(100),
  approver_user_id INTEGER,
  allow_reject BOOLEAN DEFAULT TRUE,
  allow_withdraw BOOLEAN DEFAULT FALSE,
  is_start_node BOOLEAN DEFAULT FALSE,
  is_end_node BOOLEAN DEFAULT FALSE,
  rule_json JSONB DEFAULT '{}'::jsonb,
  UNIQUE(process_id, node_key)
);

CREATE TABLE IF NOT EXISTS public.wf_process_instances (
  id SERIAL PRIMARY KEY,
  corp_id VARCHAR(128),
  emp_id VARCHAR(128),
  is_deleted CHAR(1) DEFAULT 'n',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  process_id INTEGER NOT NULL REFERENCES public.wf_process_definitions(id) ON DELETE CASCADE,
  document_type VARCHAR(100) NOT NULL,
  document_id INTEGER NOT NULL,
  document_no VARCHAR(100),
  current_node_id INTEGER REFERENCES public.wf_process_nodes(id),
  current_node_key VARCHAR(100),
  current_node_name VARCHAR(200),
  status VARCHAR(30) NOT NULL DEFAULT 'draft',
  started_by INTEGER,
  started_at TIMESTAMP,
  finished_at TIMESTAMP,
  finished_by INTEGER,
  current_step_no INTEGER DEFAULT 0,
  UNIQUE(document_type, document_id)
);

CREATE TABLE IF NOT EXISTS public.wf_process_actions (
  id SERIAL PRIMARY KEY,
  corp_id VARCHAR(128),
  emp_id VARCHAR(128),
  is_deleted CHAR(1) DEFAULT 'n',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  instance_id INTEGER NOT NULL REFERENCES public.wf_process_instances(id) ON DELETE CASCADE,
  node_id INTEGER REFERENCES public.wf_process_nodes(id),
  action VARCHAR(30) NOT NULL,
  action_label VARCHAR(100) NOT NULL,
  actor_id INTEGER,
  actor_username VARCHAR(100),
  comment TEXT,
  from_status VARCHAR(30),
  to_status VARCHAR(30),
  from_node_key VARCHAR(100),
  to_node_key VARCHAR(100),
  acted_at TIMESTAMPTZ DEFAULT NOW()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.wf_process_definitions TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.wf_process_definitions_id_seq TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.wf_process_nodes TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.wf_process_nodes_id_seq TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.wf_process_instances TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.wf_process_instances_id_seq TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.wf_process_actions TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.wf_process_actions_id_seq TO authenticated;

ALTER TABLE public.wf_process_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wf_process_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wf_process_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wf_process_actions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Workflow definitions select" ON public.wf_process_definitions;
CREATE POLICY "Workflow definitions select"
ON public.wf_process_definitions
FOR SELECT
TO authenticated
USING (public.has_table_permission('wf_process_definitions', 'select'));

DROP POLICY IF EXISTS "Workflow definitions insert" ON public.wf_process_definitions;
CREATE POLICY "Workflow definitions insert"
ON public.wf_process_definitions
FOR INSERT
TO authenticated
WITH CHECK (public.has_table_permission('wf_process_definitions', 'insert'));

DROP POLICY IF EXISTS "Workflow definitions update" ON public.wf_process_definitions;
CREATE POLICY "Workflow definitions update"
ON public.wf_process_definitions
FOR UPDATE
TO authenticated
USING (public.has_table_permission('wf_process_definitions', 'update'))
WITH CHECK (public.has_table_permission('wf_process_definitions', 'update'));

DROP POLICY IF EXISTS "Workflow definitions delete" ON public.wf_process_definitions;
CREATE POLICY "Workflow definitions delete"
ON public.wf_process_definitions
FOR DELETE
TO authenticated
USING (public.has_table_permission('wf_process_definitions', 'delete'));

DROP POLICY IF EXISTS "Workflow nodes select" ON public.wf_process_nodes;
CREATE POLICY "Workflow nodes select"
ON public.wf_process_nodes
FOR SELECT
TO authenticated
USING (public.has_table_permission('wf_process_nodes', 'select'));

DROP POLICY IF EXISTS "Workflow nodes insert" ON public.wf_process_nodes;
CREATE POLICY "Workflow nodes insert"
ON public.wf_process_nodes
FOR INSERT
TO authenticated
WITH CHECK (public.has_table_permission('wf_process_nodes', 'insert'));

DROP POLICY IF EXISTS "Workflow nodes update" ON public.wf_process_nodes;
CREATE POLICY "Workflow nodes update"
ON public.wf_process_nodes
FOR UPDATE
TO authenticated
USING (public.has_table_permission('wf_process_nodes', 'update'))
WITH CHECK (public.has_table_permission('wf_process_nodes', 'update'));

DROP POLICY IF EXISTS "Workflow nodes delete" ON public.wf_process_nodes;
CREATE POLICY "Workflow nodes delete"
ON public.wf_process_nodes
FOR DELETE
TO authenticated
USING (public.has_table_permission('wf_process_nodes', 'delete'));

DROP POLICY IF EXISTS "Workflow instances select" ON public.wf_process_instances;
CREATE POLICY "Workflow instances select"
ON public.wf_process_instances
FOR SELECT
TO authenticated
USING (public.has_table_permission('wf_process_instances', 'select'));

DROP POLICY IF EXISTS "Workflow instances insert" ON public.wf_process_instances;
CREATE POLICY "Workflow instances insert"
ON public.wf_process_instances
FOR INSERT
TO authenticated
WITH CHECK (public.has_table_permission('wf_process_instances', 'insert'));

DROP POLICY IF EXISTS "Workflow instances update" ON public.wf_process_instances;
CREATE POLICY "Workflow instances update"
ON public.wf_process_instances
FOR UPDATE
TO authenticated
USING (public.has_table_permission('wf_process_instances', 'update'))
WITH CHECK (public.has_table_permission('wf_process_instances', 'update'));

DROP POLICY IF EXISTS "Workflow instances delete" ON public.wf_process_instances;
CREATE POLICY "Workflow instances delete"
ON public.wf_process_instances
FOR DELETE
TO authenticated
USING (public.has_table_permission('wf_process_instances', 'delete'));

DROP POLICY IF EXISTS "Workflow actions select" ON public.wf_process_actions;
CREATE POLICY "Workflow actions select"
ON public.wf_process_actions
FOR SELECT
TO authenticated
USING (public.has_table_permission('wf_process_actions', 'select'));

DROP POLICY IF EXISTS "Workflow actions insert" ON public.wf_process_actions;
CREATE POLICY "Workflow actions insert"
ON public.wf_process_actions
FOR INSERT
TO authenticated
WITH CHECK (public.has_table_permission('wf_process_actions', 'insert'));

DROP POLICY IF EXISTS "Workflow actions update" ON public.wf_process_actions;
CREATE POLICY "Workflow actions update"
ON public.wf_process_actions
FOR UPDATE
TO authenticated
USING (public.has_table_permission('wf_process_actions', 'update'))
WITH CHECK (public.has_table_permission('wf_process_actions', 'update'));

DROP POLICY IF EXISTS "Workflow actions delete" ON public.wf_process_actions;
CREATE POLICY "Workflow actions delete"
ON public.wf_process_actions
FOR DELETE
TO authenticated
USING (public.has_table_permission('wf_process_actions', 'delete'));

CREATE INDEX IF NOT EXISTS idx_wf_process_instances_doc
  ON public.wf_process_instances(document_type, document_id);
CREATE INDEX IF NOT EXISTS idx_wf_process_actions_instance
  ON public.wf_process_actions(instance_id, acted_at DESC);

CREATE OR REPLACE FUNCTION public.current_user_role_codes()
RETURNS TABLE(role_code TEXT)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT r.role_code::TEXT
  FROM public.sys_users u
  JOIN public.sys_user_roles ur ON ur.user_id = u.id
  JOIN public.sys_roles r ON r.id = ur.role_id
  WHERE u.auth_id = auth.uid()
    AND u.is_deleted = 'n'
    AND u.status = '1'
    AND ur.is_deleted = 'n'
    AND r.is_deleted = 'n'
    AND r.status = '1';
$$;

CREATE OR REPLACE FUNCTION public.workflow_get_active_process(p_document_type TEXT)
RETURNS INTEGER
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id
  FROM public.wf_process_definitions
  WHERE document_type = p_document_type
    AND is_deleted = 'n'
    AND is_active = TRUE
  ORDER BY version DESC, id DESC
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.workflow_upsert_instance(
  p_document_type TEXT,
  p_document_id INTEGER,
  p_document_no TEXT DEFAULT NULL
) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_process_id INTEGER;
  v_instance_id INTEGER;
BEGIN
  v_process_id := public.workflow_get_active_process(p_document_type);
  IF v_process_id IS NULL THEN
    RAISE EXCEPTION 'No active workflow process for document type %', p_document_type;
  END IF;

  -- ⚠️ 冲突目标必须与 deploy_41 多租户化后的唯一约束一致：
  --    uq_wf_process_instances_t (tenant_id, document_type, document_id)。
  --    旧的 UNIQUE(document_type, document_id) 已被替换，写旧列组会报
  --    42P10 "no unique or exclusion constraint matching the ON CONFLICT specification"。
  --    tenant_id 省略时走 DEFAULT current_tenant_id()，与既有行同租户才冲突，语义正确。
  INSERT INTO public.wf_process_instances (
    process_id, document_type, document_id, document_no, status, started_by, started_at
  ) VALUES (
    v_process_id, p_document_type, p_document_id, p_document_no, 'draft',
    public.current_sys_user_id(), NOW()
  )
  ON CONFLICT (tenant_id, document_type, document_id)
  DO UPDATE SET updated_at = NOW()
  RETURNING id INTO v_instance_id;

  RETURN v_instance_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.workflow_execute_action(
  p_document_type TEXT,
  p_document_id INTEGER,
  p_action TEXT,
  p_comment TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_instance RECORD;
  v_node RECORD;
  v_next_node RECORD;
  v_user_id INTEGER;
  v_username TEXT;
  v_role_codes TEXT[];
  v_action_label TEXT;
BEGIN
  v_user_id := public.current_sys_user_id();
  SELECT u.username INTO v_username
  FROM public.sys_users u
  WHERE u.id = v_user_id;

  SELECT *
  INTO v_instance
  FROM public.wf_process_instances i
  WHERE i.document_type = p_document_type
    AND i.document_id = p_document_id
    AND i.is_deleted = 'n'
  FOR UPDATE;

  IF NOT FOUND THEN
    PERFORM public.workflow_upsert_instance(p_document_type, p_document_id, NULL);
    SELECT *
    INTO v_instance
    FROM public.wf_process_instances i
    WHERE i.document_type = p_document_type
      AND i.document_id = p_document_id
      AND i.is_deleted = 'n'
    FOR UPDATE;
  END IF;

  IF p_action = 'submit' THEN
    IF v_instance.status <> 'draft' THEN
      RAISE EXCEPTION 'Only draft workflow instances can be submitted';
    END IF;
    SELECT *
    INTO v_node
    FROM public.wf_process_nodes n
    WHERE n.process_id = v_instance.process_id
      AND n.is_deleted = 'n'
      AND n.is_start_node = TRUE
    ORDER BY n.sequence_no ASC, n.id ASC
    LIMIT 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Workflow process has no start node';
    END IF;
    UPDATE public.wf_process_instances
    SET status = 'pending',
        current_node_id = v_node.id,
        current_node_key = v_node.node_key,
        current_node_name = v_node.node_name,
        current_step_no = 1,
        updated_at = NOW()
    WHERE id = v_instance.id;
    INSERT INTO public.wf_process_actions(instance_id, node_id, action, action_label, actor_id, actor_username, comment, from_status, to_status, from_node_key, to_node_key)
    VALUES (v_instance.id, v_node.id, 'submit', '提交审批', v_user_id, v_username, p_comment, v_instance.status, 'pending', v_instance.current_node_key, v_node.node_key);
    RETURN jsonb_build_object('ok', TRUE, 'status', 'pending', 'node_key', v_node.node_key, 'node_name', v_node.node_name);
  ELSIF p_action = 'approve' THEN
    SELECT * INTO v_node FROM public.wf_process_nodes WHERE id = v_instance.current_node_id AND is_deleted = 'n';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'No active workflow node';
    END IF;
    IF v_instance.status <> 'pending' THEN
      RAISE EXCEPTION 'Only pending workflow instances can be approved';
    END IF;
    SELECT array_agg(role_code) INTO v_role_codes FROM public.current_user_role_codes();
    IF v_node.approver_mode = 'role' AND v_node.approver_role_code IS NOT NULL AND NOT (v_node.approver_role_code = ANY(COALESCE(v_role_codes, ARRAY[]::TEXT[]))) THEN
      RAISE EXCEPTION 'Current user does not have permission to approve this node';
    END IF;
    SELECT *
    INTO v_next_node
    FROM public.wf_process_nodes n
    WHERE n.process_id = v_instance.process_id
      AND n.is_deleted = 'n'
      AND n.sequence_no > v_node.sequence_no
    ORDER BY n.sequence_no ASC, n.id ASC
    LIMIT 1;
    IF FOUND THEN
      UPDATE public.wf_process_instances
      SET status = 'pending',
          current_node_id = v_next_node.id,
          current_node_key = v_next_node.node_key,
          current_node_name = v_next_node.node_name,
          current_step_no = current_step_no + 1,
          updated_at = NOW()
      WHERE id = v_instance.id;
      INSERT INTO public.wf_process_actions(instance_id, node_id, action, action_label, actor_id, actor_username, comment, from_status, to_status, from_node_key, to_node_key)
      VALUES (v_instance.id, v_node.id, 'approve', '审核通过', v_user_id, v_username, p_comment, v_instance.status, 'pending', v_node.node_key, v_next_node.node_key);
      RETURN jsonb_build_object('ok', TRUE, 'status', 'pending', 'node_key', v_next_node.node_key, 'node_name', v_next_node.node_name);
    ELSE
      UPDATE public.wf_process_instances
      SET status = 'approved',
          current_node_id = NULL,
          current_node_key = NULL,
          current_node_name = NULL,
          finished_at = NOW(),
          finished_by = v_user_id,
          updated_at = NOW()
      WHERE id = v_instance.id;
      INSERT INTO public.wf_process_actions(instance_id, node_id, action, action_label, actor_id, actor_username, comment, from_status, to_status, from_node_key, to_node_key)
      VALUES (v_instance.id, v_node.id, 'approve', '最终审核通过', v_user_id, v_username, p_comment, v_instance.status, 'approved', v_node.node_key, NULL);
      RETURN jsonb_build_object('ok', TRUE, 'status', 'approved');
    END IF;
  ELSIF p_action = 'reject' THEN
    IF v_instance.status <> 'pending' THEN
      RAISE EXCEPTION 'Only pending workflow instances can be rejected';
    END IF;
    UPDATE public.wf_process_instances
    SET status = 'draft',
        current_node_id = NULL,
        current_node_key = NULL,
        current_node_name = NULL,
        updated_at = NOW()
    WHERE id = v_instance.id;
    INSERT INTO public.wf_process_actions(instance_id, node_id, action, action_label, actor_id, actor_username, comment, from_status, to_status, from_node_key, to_node_key)
    VALUES (v_instance.id, v_instance.current_node_id, 'reject', '驳回', v_user_id, v_username, p_comment, v_instance.status, 'draft', v_instance.current_node_key, NULL);
    RETURN jsonb_build_object('ok', TRUE, 'status', 'draft');
  ELSIF p_action = 'withdraw' THEN
    IF v_instance.status <> 'pending' THEN
      RAISE EXCEPTION 'Only pending workflow instances can be withdrawn';
    END IF;
    UPDATE public.wf_process_instances
    SET status = 'draft',
        current_node_id = NULL,
        current_node_key = NULL,
        current_node_name = NULL,
        updated_at = NOW()
    WHERE id = v_instance.id;
    INSERT INTO public.wf_process_actions(instance_id, node_id, action, action_label, actor_id, actor_username, comment, from_status, to_status, from_node_key, to_node_key)
    VALUES (v_instance.id, v_instance.current_node_id, 'withdraw', '撤回', v_user_id, v_username, p_comment, v_instance.status, 'draft', v_instance.current_node_key, NULL);
    RETURN jsonb_build_object('ok', TRUE, 'status', 'draft');
  ELSE
    RAISE EXCEPTION 'Unsupported workflow action %', p_action;
  END IF;
END;
$$;

INSERT INTO public.wf_process_definitions (process_code, process_name, document_type, description, is_active, version, config_json)
VALUES
('purchase_order_default', '采购订单审批流', 'purchase_order', '采购订单多级审批', TRUE, 1, '{"sequential":true}'::jsonb),
('sales_order_default', '销售订单审批流', 'sales_order', '销售订单多级审批', TRUE, 1, '{"sequential":true}'::jsonb),
('purchase_receipt_default', '采购入库审批流', 'purchase_receipt', '采购入库审核和入账', TRUE, 1, '{"sequential":true}'::jsonb),
('sales_delivery_default', '销售出货审批流', 'sales_delivery', '销售出货审核和出库', TRUE, 1, '{"sequential":true}'::jsonb),
('voucher_default', '凭证审核流', 'voucher', '会计凭证审核和过账', TRUE, 1, '{"sequential":true}'::jsonb)
ON CONFLICT (process_code) DO NOTHING;

INSERT INTO public.wf_process_nodes (
  process_id, node_key, node_name, node_type, sequence_no,
  approver_mode, approver_role_code, allow_reject, allow_withdraw,
  is_start_node, is_end_node, rule_json
)
SELECT d.id, x.node_key, x.node_name, x.node_type, x.sequence_no,
       x.approver_mode, x.approver_role_code, x.allow_reject, x.allow_withdraw,
       x.is_start_node, x.is_end_node, x.rule_json
FROM public.wf_process_definitions d
CROSS JOIN (
  VALUES
    ('submit', '提交审批', 'approval', 1, 'role', 'inventory_manager', TRUE, FALSE, TRUE, FALSE, '{"next":"manager"}'::jsonb),
    ('manager', '部门审批', 'approval', 2, 'role', 'inventory_manager', TRUE, FALSE, FALSE, FALSE, '{"next":"final"}'::jsonb),
    ('final', '终审', 'approval', 3, 'role', 'super_admin', TRUE, FALSE, FALSE, TRUE, '{"final":true}'::jsonb)
) AS x(node_key, node_name, node_type, sequence_no, approver_mode, approver_role_code, allow_reject, allow_withdraw, is_start_node, is_end_node, rule_json)
WHERE d.is_deleted = 'n'
ON CONFLICT (process_id, node_key) DO NOTHING;

CREATE UNIQUE INDEX IF NOT EXISTS uq_wf_process_instances_document
  ON public.wf_process_instances(document_type, document_id);

