-- Execute workflow routing from persisted graph edges and structured conditions.
-- workflow_execute_action also writes the document status back to the physical
-- document table (resolved via sys_document_types), keeping wf_process_instances
-- and the document's own status column in sync within one transaction.

CREATE OR REPLACE FUNCTION public.workflow_sync_document_status(
  p_document_type TEXT,
  p_document_id INTEGER,
  p_status TEXT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_table_name TEXT;
  v_primary_key TEXT;
  v_columns TEXT[];
BEGIN
  SELECT table_name, primary_key_field
  INTO v_table_name, v_primary_key
  FROM public.sys_document_types
  WHERE document_type = p_document_type
    AND status = '1'
    AND is_deleted = 'n';

  IF v_table_name IS NULL OR to_regclass(format('public.%I', v_table_name)) IS NULL THEN
    RAISE EXCEPTION 'Document type % has no valid physical table', p_document_type;
  END IF;

  SELECT array_agg(column_name) INTO v_columns
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = v_table_name;

  EXECUTE format(
    'UPDATE public.%I t SET status = $1%s%s WHERE t.%I = $2',
    v_table_name,
    CASE WHEN 'updated_at' = ANY(COALESCE(v_columns, ARRAY[]::TEXT[])) THEN ', updated_at = NOW()' ELSE '' END,
    CASE
      WHEN p_status = 'approved'
           AND 'approved_by' = ANY(COALESCE(v_columns, ARRAY[]::TEXT[]))
           AND 'approved_at' = ANY(COALESCE(v_columns, ARRAY[]::TEXT[]))
        THEN ', approved_by = public.current_sys_user_id(), approved_at = NOW()'
      WHEN p_status = 'draft'
           AND 'approved_by' = ANY(COALESCE(v_columns, ARRAY[]::TEXT[]))
           AND 'approved_at' = ANY(COALESCE(v_columns, ARRAY[]::TEXT[]))
        THEN ', approved_by = NULL, approved_at = NULL'
      ELSE ''
    END,
    COALESCE(NULLIF(v_primary_key, ''), 'id')
  ) USING p_status, p_document_id;
END;
$$;

REVOKE ALL ON FUNCTION public.workflow_sync_document_status(TEXT, INTEGER, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.workflow_sync_document_status(TEXT, INTEGER, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.workflow_get_document_json(
  p_document_type TEXT,
  p_document_id INTEGER
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_table_name TEXT;
  v_primary_key TEXT;
  v_document JSONB;
BEGIN
  SELECT table_name, primary_key_field
  INTO v_table_name, v_primary_key
  FROM public.sys_document_types
  WHERE document_type = p_document_type
    AND status = '1'
    AND is_deleted = 'n';

  IF v_table_name IS NULL OR to_regclass(format('public.%I', v_table_name)) IS NULL THEN
    RAISE EXCEPTION 'Document type % has no valid physical table', p_document_type;
  END IF;

  EXECUTE format(
    'SELECT to_jsonb(t) FROM public.%I t WHERE t.%I = $1 LIMIT 1',
    v_table_name,
    COALESCE(NULLIF(v_primary_key, ''), 'id')
  ) INTO v_document USING p_document_id;

  IF v_document IS NULL THEN
    RAISE EXCEPTION 'Document %/% was not found', p_document_type, p_document_id;
  END IF;
  RETURN v_document;
END;
$$;

CREATE OR REPLACE FUNCTION public.workflow_compare_value(
  p_actual JSONB,
  p_operator TEXT,
  p_expected JSONB
) RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_actual TEXT := CASE WHEN p_actual IS NULL OR p_actual = 'null'::jsonb THEN NULL ELSE p_actual #>> '{}' END;
  v_expected TEXT := CASE WHEN p_expected IS NULL OR p_expected = 'null'::jsonb THEN NULL ELSE p_expected #>> '{}' END;
  v_actual_number NUMERIC;
  v_expected_number NUMERIC;
BEGIN
  IF p_operator = 'is_null' THEN RETURN v_actual IS NULL OR v_actual = ''; END IF;
  IF p_operator = 'is_not_null' THEN RETURN v_actual IS NOT NULL AND v_actual <> ''; END IF;
  IF p_operator = 'contains' THEN RETURN POSITION(COALESCE(v_expected, '') IN COALESCE(v_actual, '')) > 0; END IF;
  IF p_operator = 'starts_with' THEN RETURN COALESCE(v_actual, '') LIKE COALESCE(v_expected, '') || '%'; END IF;
  IF p_operator = 'ends_with' THEN RETURN COALESCE(v_actual, '') LIKE '%' || COALESCE(v_expected, ''); END IF;

  IF COALESCE(v_actual, '') ~ '^-?[0-9]+([.][0-9]+)?$'
     AND COALESCE(v_expected, '') ~ '^-?[0-9]+([.][0-9]+)?$' THEN
    v_actual_number := v_actual::NUMERIC;
    v_expected_number := v_expected::NUMERIC;
    RETURN CASE p_operator
      WHEN '=' THEN v_actual_number = v_expected_number
      WHEN '!=' THEN v_actual_number <> v_expected_number
      WHEN '>' THEN v_actual_number > v_expected_number
      WHEN '>=' THEN v_actual_number >= v_expected_number
      WHEN '<' THEN v_actual_number < v_expected_number
      WHEN '<=' THEN v_actual_number <= v_expected_number
      ELSE FALSE
    END;
  END IF;

  RETURN CASE p_operator
    WHEN '=' THEN v_actual IS NOT DISTINCT FROM v_expected
    WHEN '!=' THEN v_actual IS DISTINCT FROM v_expected
    WHEN '>' THEN v_actual > v_expected
    WHEN '>=' THEN v_actual >= v_expected
    WHEN '<' THEN v_actual < v_expected
    WHEN '<=' THEN v_actual <= v_expected
    ELSE FALSE
  END;
END;
$$;

CREATE OR REPLACE FUNCTION public.workflow_evaluate_condition(
  p_rule JSONB,
  p_document JSONB
) RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_logic TEXT := LOWER(COALESCE(p_rule->>'logic', 'and'));
  v_item JSONB;
  v_result BOOLEAN;
  v_has_item BOOLEAN := FALSE;
BEGIN
  IF p_rule IS NULL OR jsonb_typeof(p_rule) <> 'object' THEN RETURN FALSE; END IF;
  v_result := v_logic <> 'or';

  FOR v_item IN
    SELECT value FROM jsonb_array_elements(COALESCE(p_rule->'conditions', '[]'::jsonb))
  LOOP
    v_has_item := TRUE;
    IF v_item ? 'conditions' OR v_item ? 'groups' THEN
      v_result := public.workflow_evaluate_condition(v_item, p_document);
    ELSE
      v_result := public.workflow_compare_value(
        p_document->(v_item->>'field'),
        COALESCE(v_item->>'operator', '='),
        v_item->'value'
      );
    END IF;
    IF v_logic = 'and' AND NOT v_result THEN RETURN FALSE; END IF;
    IF v_logic = 'or' AND v_result THEN RETURN TRUE; END IF;
  END LOOP;

  FOR v_item IN
    SELECT value FROM jsonb_array_elements(COALESCE(p_rule->'groups', '[]'::jsonb))
  LOOP
    v_has_item := TRUE;
    v_result := public.workflow_evaluate_condition(v_item, p_document);
    IF v_logic = 'and' AND NOT v_result THEN RETURN FALSE; END IF;
    IF v_logic = 'or' AND v_result THEN RETURN TRUE; END IF;
  END LOOP;

  IF NOT v_has_item THEN RETURN FALSE; END IF;
  RETURN v_logic = 'and';
END;
$$;

CREATE OR REPLACE FUNCTION public.workflow_find_next_node(
  p_process_id INTEGER,
  p_current_node_id INTEGER,
  p_document_type TEXT,
  p_document_id INTEGER
) RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_current_node RECORD;
  v_config JSONB;
  v_document JSONB;
  v_edge JSONB;
  v_condition JSONB;
  v_default_target TEXT;
  v_target TEXT;
  v_has_outgoing BOOLEAN := FALSE;
  v_next_id INTEGER;
BEGIN
  SELECT * INTO v_current_node
  FROM public.wf_process_nodes
  WHERE id = p_current_node_id AND process_id = p_process_id AND is_deleted = 'n';
  IF NOT FOUND THEN RAISE EXCEPTION 'Current workflow node does not exist'; END IF;

  SELECT COALESCE(config_json, '{}'::jsonb) INTO v_config
  FROM public.wf_process_definitions
  WHERE id = p_process_id AND is_deleted = 'n';

  IF jsonb_array_length(COALESCE(v_config->'workflowEdges', '[]'::jsonb)) > 0 THEN
    v_document := public.workflow_get_document_json(p_document_type, p_document_id);
    FOR v_edge IN SELECT value FROM jsonb_array_elements(v_config->'workflowEdges') LOOP
      IF v_edge->>'source' <> v_current_node.node_key THEN CONTINUE; END IF;
      v_has_outgoing := TRUE;
      IF COALESCE(v_edge->>'kind', 'default') IN ('default', 'false') THEN
        IF v_default_target IS NULL THEN v_default_target := v_edge->>'target'; END IF;
        CONTINUE;
      END IF;
      IF COALESCE(v_edge->>'kind', '') IN ('condition', 'true') THEN
        v_condition := v_edge->'condition';
        IF jsonb_typeof(v_condition) = 'string' THEN
          BEGIN v_condition := (v_edge->>'condition')::jsonb;
          EXCEPTION WHEN OTHERS THEN v_condition := NULL; END;
        END IF;
        IF v_condition IS NULL AND v_current_node.rule_json ? 'expr' THEN
          BEGIN v_condition := (v_current_node.rule_json->>'expr')::jsonb;
          EXCEPTION WHEN OTHERS THEN v_condition := NULL; END;
        END IF;
        IF public.workflow_evaluate_condition(v_condition, v_document) THEN
          v_target := v_edge->>'target';
          EXIT;
        END IF;
      END IF;
    END LOOP;

    IF NOT v_has_outgoing THEN
      RAISE EXCEPTION 'Workflow node % has no outgoing edge', v_current_node.node_key;
    END IF;
    v_target := COALESCE(v_target, v_default_target);
    IF v_target IS NULL AND v_has_outgoing THEN
      RAISE EXCEPTION 'No workflow branch matched node % and no default branch is configured', v_current_node.node_key;
    END IF;
    IF v_target IS NOT NULL THEN
      SELECT id INTO v_next_id FROM public.wf_process_nodes
      WHERE process_id = p_process_id AND node_key = v_target AND is_deleted = 'n';
      IF v_next_id IS NULL THEN RAISE EXCEPTION 'Workflow target node % does not exist', v_target; END IF;
      RETURN v_next_id;
    END IF;
  END IF;

  SELECT id INTO v_next_id
  FROM public.wf_process_nodes
  WHERE process_id = p_process_id
    AND is_deleted = 'n'
    AND sequence_no > v_current_node.sequence_no
  ORDER BY sequence_no, id
  LIMIT 1;
  RETURN v_next_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.workflow_resolve_actionable_node(
  p_process_id INTEGER,
  p_node_id INTEGER,
  p_document_type TEXT,
  p_document_id INTEGER
) RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_node RECORD;
  v_node_id INTEGER := p_node_id;
  v_depth INTEGER := 0;
BEGIN
  WHILE v_node_id IS NOT NULL LOOP
    v_depth := v_depth + 1;
    IF v_depth > 100 THEN RAISE EXCEPTION 'Workflow contains a routing cycle'; END IF;
    SELECT * INTO v_node FROM public.wf_process_nodes WHERE id = v_node_id AND is_deleted = 'n';
    IF NOT FOUND THEN RAISE EXCEPTION 'Workflow node % does not exist', v_node_id; END IF;
    IF v_node.is_end_node OR v_node.node_type = 'end' OR v_node.node_type = 'approval' THEN RETURN v_node_id; END IF;
    v_node_id := public.workflow_find_next_node(p_process_id, v_node_id, p_document_type, p_document_id);
  END LOOP;
  RETURN NULL;
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
  v_next_id INTEGER;
  v_user_id INTEGER;
  v_username TEXT;
  v_role_codes TEXT[];
BEGIN
  v_user_id := public.current_sys_user_id();
  SELECT username INTO v_username FROM public.sys_users WHERE id = v_user_id;
  SELECT * INTO v_instance FROM public.wf_process_instances
  WHERE document_type = p_document_type AND document_id = p_document_id AND is_deleted = 'n'
  FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM public.workflow_upsert_instance(p_document_type, p_document_id, NULL);
    SELECT * INTO v_instance FROM public.wf_process_instances
    WHERE document_type = p_document_type AND document_id = p_document_id AND is_deleted = 'n'
    FOR UPDATE;
  END IF;

  IF p_action = 'submit' THEN
    IF v_instance.status <> 'draft' THEN RAISE EXCEPTION 'Only draft workflow instances can be submitted'; END IF;
    SELECT id INTO v_next_id FROM public.wf_process_nodes
    WHERE process_id = v_instance.process_id AND is_deleted = 'n' AND is_start_node = TRUE
    ORDER BY sequence_no, id LIMIT 1;
    IF v_next_id IS NULL THEN RAISE EXCEPTION 'Workflow process has no start node'; END IF;
    v_next_id := public.workflow_resolve_actionable_node(v_instance.process_id, v_next_id, p_document_type, p_document_id);
    SELECT * INTO v_next_node FROM public.wf_process_nodes WHERE id = v_next_id;
    IF v_next_id IS NULL OR v_next_node.is_end_node OR v_next_node.node_type = 'end' THEN
      UPDATE public.wf_process_instances SET status = 'approved', current_node_id = NULL, current_node_key = NULL, current_node_name = NULL, finished_at = NOW(), finished_by = v_user_id, updated_at = NOW() WHERE id = v_instance.id;
      PERFORM public.workflow_sync_document_status(p_document_type, p_document_id, 'approved');
      INSERT INTO public.wf_process_actions(instance_id, node_id, action, action_label, actor_id, actor_username, comment, from_status, to_status, from_node_key, to_node_key)
      VALUES (v_instance.id, v_next_id, 'submit', '提交并完成', v_user_id, v_username, p_comment, 'draft', 'approved', NULL, NULL);
      RETURN jsonb_build_object('ok', TRUE, 'status', 'approved');
    END IF;
    UPDATE public.wf_process_instances SET status = 'pending', current_node_id = v_next_node.id, current_node_key = v_next_node.node_key, current_node_name = v_next_node.node_name, current_step_no = 1, started_by = v_user_id, started_at = COALESCE(started_at, NOW()), updated_at = NOW() WHERE id = v_instance.id;
    PERFORM public.workflow_sync_document_status(p_document_type, p_document_id, 'pending');
    INSERT INTO public.wf_process_actions(instance_id, node_id, action, action_label, actor_id, actor_username, comment, from_status, to_status, from_node_key, to_node_key)
    VALUES (v_instance.id, v_next_node.id, 'submit', '提交审批', v_user_id, v_username, p_comment, 'draft', 'pending', NULL, v_next_node.node_key);
    RETURN jsonb_build_object('ok', TRUE, 'status', 'pending', 'node_key', v_next_node.node_key, 'node_name', v_next_node.node_name);

  ELSIF p_action = 'approve' THEN
    IF v_instance.status <> 'pending' THEN RAISE EXCEPTION 'Only pending workflow instances can be approved'; END IF;
    SELECT * INTO v_node FROM public.wf_process_nodes WHERE id = v_instance.current_node_id AND is_deleted = 'n';
    IF NOT FOUND THEN RAISE EXCEPTION 'No active workflow node'; END IF;
    SELECT array_agg(role_code) INTO v_role_codes FROM public.current_user_role_codes();
    IF v_node.approver_mode = 'role' AND v_node.approver_role_code IS NOT NULL AND NOT (v_node.approver_role_code = ANY(COALESCE(v_role_codes, ARRAY[]::TEXT[]))) THEN
      RAISE EXCEPTION 'Current user does not have permission to approve this node';
    END IF;
    v_next_id := public.workflow_find_next_node(v_instance.process_id, v_node.id, p_document_type, p_document_id);
    v_next_id := public.workflow_resolve_actionable_node(v_instance.process_id, v_next_id, p_document_type, p_document_id);
    SELECT * INTO v_next_node FROM public.wf_process_nodes WHERE id = v_next_id;
    IF v_next_id IS NULL OR v_next_node.is_end_node OR v_next_node.node_type = 'end' THEN
      UPDATE public.wf_process_instances SET status = 'approved', current_node_id = NULL, current_node_key = NULL, current_node_name = NULL, finished_at = NOW(), finished_by = v_user_id, updated_at = NOW() WHERE id = v_instance.id;
      PERFORM public.workflow_sync_document_status(p_document_type, p_document_id, 'approved');
      INSERT INTO public.wf_process_actions(instance_id, node_id, action, action_label, actor_id, actor_username, comment, from_status, to_status, from_node_key, to_node_key)
      VALUES (v_instance.id, v_node.id, 'approve', '最终审核通过', v_user_id, v_username, p_comment, 'pending', 'approved', v_node.node_key, NULL);
      RETURN jsonb_build_object('ok', TRUE, 'status', 'approved');
    END IF;
    UPDATE public.wf_process_instances SET current_node_id = v_next_node.id, current_node_key = v_next_node.node_key, current_node_name = v_next_node.node_name, current_step_no = current_step_no + 1, updated_at = NOW() WHERE id = v_instance.id;
    PERFORM public.workflow_sync_document_status(p_document_type, p_document_id, 'pending');
    INSERT INTO public.wf_process_actions(instance_id, node_id, action, action_label, actor_id, actor_username, comment, from_status, to_status, from_node_key, to_node_key)
    VALUES (v_instance.id, v_node.id, 'approve', '审核通过', v_user_id, v_username, p_comment, 'pending', 'pending', v_node.node_key, v_next_node.node_key);
    RETURN jsonb_build_object('ok', TRUE, 'status', 'pending', 'node_key', v_next_node.node_key, 'node_name', v_next_node.node_name);

  ELSIF p_action = 'reject' THEN
    IF v_instance.status <> 'pending' THEN RAISE EXCEPTION 'Only pending workflow instances can be rejected'; END IF;
    SELECT * INTO v_node FROM public.wf_process_nodes WHERE id = v_instance.current_node_id AND is_deleted = 'n';
    IF NOT COALESCE(v_node.allow_reject, FALSE) THEN RAISE EXCEPTION 'Current workflow node does not allow rejection'; END IF;
    UPDATE public.wf_process_instances SET status = 'draft', current_node_id = NULL, current_node_key = NULL, current_node_name = NULL, updated_at = NOW() WHERE id = v_instance.id;
    PERFORM public.workflow_sync_document_status(p_document_type, p_document_id, 'draft');
    INSERT INTO public.wf_process_actions(instance_id, node_id, action, action_label, actor_id, actor_username, comment, from_status, to_status, from_node_key, to_node_key)
    VALUES (v_instance.id, v_node.id, 'reject', '驳回', v_user_id, v_username, p_comment, 'pending', 'draft', v_node.node_key, NULL);
    RETURN jsonb_build_object('ok', TRUE, 'status', 'draft');

  ELSIF p_action = 'withdraw' THEN
    IF v_instance.status <> 'pending' THEN RAISE EXCEPTION 'Only pending workflow instances can be withdrawn'; END IF;
    SELECT * INTO v_node FROM public.wf_process_nodes WHERE id = v_instance.current_node_id AND is_deleted = 'n';
    IF NOT COALESCE(v_node.allow_withdraw, FALSE) THEN RAISE EXCEPTION 'Current workflow node does not allow withdrawal'; END IF;
    UPDATE public.wf_process_instances SET status = 'draft', current_node_id = NULL, current_node_key = NULL, current_node_name = NULL, updated_at = NOW() WHERE id = v_instance.id;
    PERFORM public.workflow_sync_document_status(p_document_type, p_document_id, 'draft');
    INSERT INTO public.wf_process_actions(instance_id, node_id, action, action_label, actor_id, actor_username, comment, from_status, to_status, from_node_key, to_node_key)
    VALUES (v_instance.id, v_node.id, 'withdraw', '撤回', v_user_id, v_username, p_comment, 'pending', 'draft', v_node.node_key, NULL);
    RETURN jsonb_build_object('ok', TRUE, 'status', 'draft');
  END IF;
  RAISE EXCEPTION 'Unsupported workflow action %', p_action;
END;
$$;

GRANT EXECUTE ON FUNCTION public.workflow_get_document_json(TEXT, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.workflow_compare_value(JSONB, TEXT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.workflow_evaluate_condition(JSONB, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.workflow_find_next_node(INTEGER, INTEGER, TEXT, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.workflow_resolve_actionable_node(INTEGER, INTEGER, TEXT, INTEGER) TO authenticated;
