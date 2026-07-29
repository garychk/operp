import { useEffect, useMemo, useState } from 'react';
import { Button, Card, Col, Drawer, Form, Input, InputNumber, Row, Select, Space, Switch, Table, Tag, Tabs, message } from 'antd';
import { DeleteOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { Splitter } from 'antd';
import { supabase } from '../../utils/supabase';
import { logWithTiming } from '../../utils/logger';
import { useTranslation } from 'react-i18next';
import { WorkflowDiagram, WorkflowEdgeItem, WorkflowNodeItem } from '../../components/workflow/WorkflowDiagram';

type WorkflowDefinition = {
  id: number;
  process_code: string;
  process_name: string;
  document_type: string;
  description: string | null;
  is_active: boolean | null;
  version: number | null;
  config_json?: Record<string, unknown> | null;
};

type WorkflowNode = WorkflowNodeItem;
type RoleOption = { label: string; value: string };

type NodeFormValues = {
  node_key: string;
  node_name: string;
  node_type: WorkflowNode['node_type'];
  sequence_no: number;
  approver_mode: string;
  approver_role_code: string | null;
  allow_reject: boolean;
  allow_withdraw: boolean;
  is_start_node: boolean;
  is_end_node: boolean;
  condition_expr: string;
  condition_label: string;
  is_default_path: boolean;
};

type GraphState = {
  nodes: WorkflowNode[];
  edges: WorkflowEdgeItem[];
};

const DOCUMENT_TYPE_OPTIONS = [
  { label: '采购订单', value: 'purchase_order' },
  { label: '销售订单', value: 'sales_order' },
  { label: '采购入库', value: 'purchase_receipt' },
  { label: '销售出货', value: 'sales_delivery' },
  { label: '凭证', value: 'voucher' },
];

const DEFAULT_GRAPH: GraphState = {
  nodes: [
    { node_key: 'start', node_name: '提交审批', node_type: 'start', sequence_no: 1, approver_mode: 'system', approver_role_code: null, allow_reject: false, allow_withdraw: false, is_start_node: true, is_end_node: false, rule_json: { layout: { x: 40, y: 24 } } },
    { node_key: 'amount_condition', node_name: '金额判断', node_type: 'condition', sequence_no: 2, approver_mode: 'system', approver_role_code: null, allow_reject: false, allow_withdraw: false, is_start_node: false, is_end_node: false, rule_json: { expr: 'amount >= 50000', trueTargetKey: 'finance_manager', falseTargetKey: 'dept_manager', layout: { x: 260, y: 24 } } },
    { node_key: 'dept_manager', node_name: '部门审批', node_type: 'approval', sequence_no: 3, approver_mode: 'role', approver_role_code: 'inventory_manager', allow_reject: true, allow_withdraw: false, is_start_node: false, is_end_node: false, rule_json: { layout: { x: 40, y: 116 } } },
    { node_key: 'finance_manager', node_name: '财务复核', node_type: 'approval', sequence_no: 4, approver_mode: 'role', approver_role_code: 'finance_manager', allow_reject: true, allow_withdraw: false, is_start_node: false, is_end_node: false, rule_json: { layout: { x: 480, y: 116 } } },
    { node_key: 'final', node_name: '终审完成', node_type: 'end', sequence_no: 5, approver_mode: 'system', approver_role_code: null, allow_reject: false, allow_withdraw: false, is_start_node: false, is_end_node: true, rule_json: { layout: { x: 260, y: 208 } } },
  ],
  edges: [
    { id: 'start-to-condition', source: 'start', target: 'amount_condition', kind: 'default' },
    { id: 'condition-true', source: 'amount_condition', target: 'finance_manager', sourcePort: 'amount_condition-right', targetPort: 'finance_manager-left', kind: 'true', label: '是' },
    { id: 'condition-false', source: 'amount_condition', target: 'dept_manager', sourcePort: 'amount_condition-bottom', targetPort: 'dept_manager-left', kind: 'false', label: '否' },
    { id: 'dept-to-final', source: 'dept_manager', target: 'final', kind: 'default' },
    { id: 'finance-to-final', source: 'finance_manager', target: 'final', kind: 'default' },
  ],
};

export function WorkflowConfig() {
  const { t } = useTranslation();
  const [definitions, setDefinitions] = useState<WorkflowDefinition[]>([]);
  const [roles, setRoles] = useState<RoleOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<WorkflowDefinition | null>(null);
  const [nodes, setNodes] = useState<WorkflowNode[]>([]);
  const [edges, setEdges] = useState<WorkflowEdgeItem[]>([]);
  const [selectedKey, setSelectedKey] = useState<string>('');
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [propertyTab, setPropertyTab] = useState("node");
  const [canvasHeight, setCanvasHeight] = useState<number>(640);
  const [form] = Form.useForm();
  const [nodeForm] = Form.useForm<NodeFormValues>();
  const [edgeForm] = Form.useForm<WorkflowEdgeItem>();

  useEffect(() => {
    void fetchDefinitions();
    void fetchRoles();
  }, []);

  const fetchDefinitions = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('wf_process_definitions')
        .select('id, process_code, process_name, document_type, description, is_active, version, config_json')
        .eq('is_deleted', 'n')
        .order('document_type', { ascending: true })
        .order('version', { ascending: false });
      if (error) throw error;
      setDefinitions((data || []) as WorkflowDefinition[]);
    } catch {
      message.error(t('workflow.fetchFailed'));
    } finally {
      setLoading(false);
    }
  };

  const fetchRoles = async () => {
    const { data, error } = await supabase.from('sys_roles').select('role_code, role_name').eq('is_deleted', 'n').eq('status', '1').order('sort_order', { ascending: true });
    if (error) return;
    setRoles((data || []).map((role) => ({ label: `${role.role_name} (${role.role_code})`, value: role.role_code })));
  };

  const loadGraph = async (processId: number, configJson?: Record<string, unknown> | null) => {
    const { data, error } = await supabase
      .from('wf_process_nodes')
      .select('node_key, node_name, node_type, sequence_no, approver_mode, approver_role_code, allow_reject, allow_withdraw, is_start_node, is_end_node, rule_json')
      .eq('is_deleted', 'n')
      .eq('process_id', processId)
      .order('sequence_no', { ascending: true });
    if (error) throw error;

    const loadedNodes = ((data || []) as WorkflowNode[]).map((node) => ({ ...node, rule_json: normalizeRuleJson(node.rule_json) }));
    const initialNodes = loadedNodes.length ? loadedNodes : DEFAULT_GRAPH.nodes;
    const initialEdges = parseEdges(configJson, initialNodes);

    setNodes(initialNodes);
    setEdges(initialEdges);
    setSelectedKey(initialNodes[0]?.node_key || '');
    setSelectedEdgeId(initialEdges[0]?.id || null);
    setCanvasHeight(computeCanvasHeight(initialNodes));
    nodeForm.setFieldsValue(toNodeFormValues(initialNodes[0] || DEFAULT_GRAPH.nodes[0]));
  };

  const handleAdd = () => {
    setEditing(null);
    form.setFieldsValue({ process_code: '', process_name: '', document_type: 'purchase_order', description: '', is_active: true, version: 1 });
    setNodes(DEFAULT_GRAPH.nodes);
    setEdges(DEFAULT_GRAPH.edges);
    setSelectedKey(DEFAULT_GRAPH.nodes[0].node_key);
    setSelectedEdgeId(DEFAULT_GRAPH.edges[0]?.id || null);
    setCanvasHeight(computeCanvasHeight(DEFAULT_GRAPH.nodes));
    nodeForm.setFieldsValue(toNodeFormValues(DEFAULT_GRAPH.nodes[0]));
    setModalOpen(true);
  };

  const handleEdit = async (record: WorkflowDefinition) => {
    setEditing(record);
    form.setFieldsValue(record);
    await loadGraph(record.id, record.config_json);
    setModalOpen(true);
  };

  const selectedNode = useMemo(() => nodes.find((node) => node.node_key === selectedKey) || null, [nodes, selectedKey]);
  const selectedEdge = useMemo(() => edges.find((edge) => edge.id === selectedEdgeId) || null, [edges, selectedEdgeId]);

  useEffect(() => {
    if (!selectedNode) return;
    nodeForm.setFieldsValue(toNodeFormValues(selectedNode));
  }, [selectedNode, nodeForm]);

  useEffect(() => {
    if (selectedEdge) edgeForm.setFieldsValue(selectedEdge);
  }, [selectedEdge, edgeForm]);

  const saveSelectedEdge = async () => {
    if (!selectedEdge) return;
    const values = await edgeForm.validateFields();
    setEdges((prev) => prev.map((edge) => (edge.id === selectedEdge.id ? { ...edge, ...values } : edge)));
    message.success(t("workflow.edgeSaved"));
  };

  const saveSelectedNode = async () => {
    const values = await nodeForm.validateFields();
    setNodes((prev) => {
      const next = prev.map((node) => (node.node_key === selectedKey ? mergeNodeForm(node, values) : node));
      setCanvasHeight(computeCanvasHeight(next));
      return next;
    });
    message.success(t('workflow.nodeSaved'));
  };

  const updateNodePosition = (key: string, position: { x: number; y: number }) => {
    setNodes((prev) => prev.map((node) => (node.node_key === key ? { ...node, rule_json: { ...normalizeRuleJson(node.rule_json), layout: position } } : node)));
  };

  const updateEdges = (nextEdges: WorkflowEdgeItem[]) => {
    setEdges(nextEdges);
    setSelectedEdgeId(nextEdges[0]?.id || null);
  };

  const insertNodeAfterSelected = (nodeType: WorkflowNode['node_type'] = 'approval') => {
    const anchorIndex = Math.max(0, nodes.findIndex((node) => node.node_key === selectedKey));
    const node_key = `node_${Date.now()}`;
    const nextNode: WorkflowNode = {
      node_key,
      node_name: nodeType === 'condition' ? t('workflow.conditionNode') : t('workflow.nodesTitle'),
      node_type: nodeType,
      sequence_no: nodes.length + 1,
      approver_mode: nodeType === 'condition' || nodeType === 'end' || nodeType === 'start' ? 'system' : 'role',
      approver_role_code: null,
      allow_reject: true,
      allow_withdraw: false,
      is_start_node: false,
      is_end_node: false,
      rule_json: nodeType === 'condition'
        ? { expr: '', isDefaultPath: false, layout: { x: 260, y: 24 } }
        : { layout: { x: 40, y: 300 + anchorIndex * 92 } },
    };

    setNodes((prev) => renumberNodes([...prev.slice(0, anchorIndex + 1), nextNode, ...prev.slice(anchorIndex + 1)]));
    setSelectedKey(node_key);
    nodeForm.setFieldsValue(toNodeFormValues(nextNode));
  };

  const removeNode = (nodeKey: string) => {
    setNodes((prev) => renumberNodes(prev.filter((node) => node.node_key !== nodeKey)));
    setEdges((prev) => prev.filter((edge) => edge.source !== nodeKey && edge.target !== nodeKey));
    if (selectedKey === nodeKey) setSelectedKey('');
  };

  const removeSelectedEdge = () => {
    if (!selectedEdge) return;
    setEdges((prev) => prev.filter((edge) => edge.id !== selectedEdge.id));
    setSelectedEdgeId(null);
  };

  const handleDelete = async (id: number) => {
    await logWithTiming(t('workflow.configTitle'), 'DELETE', async () => {
      const { error } = await supabase.from('wf_process_definitions').update({ is_deleted: 'y', is_active: false }).eq('id', id);
      if (error) throw error;
      const { error: nodeError } = await supabase.from('wf_process_nodes').update({ is_deleted: 'y' }).eq('process_id', id);
      if (nodeError) throw nodeError;
    }, { process_id: id });
    message.success(t('workflow.deleteSuccess'));
    await fetchDefinitions();
  };

  const handleSave = async () => {
    const values = await form.validateFields();
    if (!nodes.length) {
      message.error(t('workflow.atLeastOneNode'));
      return;
    }

    await logWithTiming(t('workflow.configTitle'), 'UPSERT', async () => {
      const processPayload = {
        process_code: values.process_code,
        process_name: values.process_name,
        document_type: values.document_type,
        description: values.description,
        is_active: values.is_active,
        version: values.version,
        config_json: buildConfigJson(edges),
        is_deleted: 'n',
      };
      let processId = editing?.id;
      if (editing) {
        const { error } = await supabase.from('wf_process_definitions').update(processPayload).eq('id', editing.id);
        if (error) throw error;
      } else {
        const { data, error } = await supabase.from('wf_process_definitions').insert([processPayload]).select('id').single();
        if (error) throw error;
        processId = data.id;
      }
      if (!processId) throw new Error(t('workflow.noProcessId'));

      await supabase.from('wf_process_nodes').delete().eq('process_id', processId);
      const nodePayload = nodes.map((node) => ({
        process_id: processId,
        node_key: node.node_key,
        node_name: node.node_name,
        node_type: node.node_type,
        sequence_no: Number(node.sequence_no),
        approver_mode: node.approver_mode || 'role',
        approver_role_code: node.approver_role_code || null,
        allow_reject: node.allow_reject,
        allow_withdraw: node.allow_withdraw,
        is_start_node: node.is_start_node,
        is_end_node: node.is_end_node,
        rule_json: normalizeRuleJson(node.rule_json),
        is_deleted: 'n',
      }));
      const { error } = await supabase.from('wf_process_nodes').insert(nodePayload);
      if (error) throw error;
    }, { process_code: values.process_code });

    message.success(t('workflow.saveSuccess'));
    setModalOpen(false);
    await fetchDefinitions();
  };


  const columns = [
    { title: t('workflow.processName'), dataIndex: 'process_name' },
    { title: t('workflow.documentType'), dataIndex: 'document_type', render: (value: string) => DOCUMENT_TYPE_OPTIONS.find((item) => item.value === value)?.label || value },
    { title: t('workflow.processCode'), dataIndex: 'process_code' },
    { title: t('workflow.version'), dataIndex: 'version', width: 80 },
    { title: t('workflow.status'), dataIndex: 'is_active', width: 100, render: (value: boolean) => <Tag color={value ? 'green' : 'default'}>{value ? t('workflow.active') : t('workflow.inactive')}</Tag> },
    { title: t('workflow.action'), key: 'action', render: (_: unknown, record: WorkflowDefinition) => (<Space><Button type="text" onClick={() => void handleEdit(record)}>{t('common.edit')}</Button><Button type="text" danger onClick={() => void handleDelete(record.id)}>{t('common.delete')}</Button></Space>) },
  ];

  return (
    <Card
      className="mainContent"
      variant="borderless"
      title={t("workflow.configTitle")}
      extra={
        <Space>
          <Button
            icon={<ReloadOutlined />}
            onClick={() => void fetchDefinitions()}
          >
            {t("workflow.refresh")}
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
            {t("workflow.addProcess")}
          </Button>
        </Space>
      }
    >
      <Table
        columns={columns}
        dataSource={definitions}
        rowKey="id"
        loading={loading}
      />
      <Drawer
        title={
          editing ? t("workflow.editProcess") : t("workflow.createProcess")
        }
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        width="95%"
        destroyOnHidden
        extra={
          <Space>
            <Button onClick={() => setModalOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="primary" onClick={() => void handleSave()}>
              {t("common.save")}
            </Button>
          </Space>
        }
      >
        <Splitter style={{ height: "calc(100vh - 114px)" }}>
          <Splitter.Panel defaultSize="12%" min="10%" max="16%">
            <div style={{ paddingRight: 12, height: "100%", overflow: "auto" }}>
              <Card
                size="small"
                title={t("workflow.basicInfo")}
                style={{ marginBottom: 12 }}
              >
                <Form form={form} layout="vertical">
                  <Form.Item
                    name="process_code"
                    label={t("workflow.processCode")}
                    rules={[{ required: true }]}
                  >
                    <Input
                      placeholder="purchase_order_default"
                      disabled={!!editing}
                    />
                  </Form.Item>
                  <Form.Item
                    name="process_name"
                    label={t("workflow.processName")}
                    rules={[{ required: true }]}
                  >
                    <Input placeholder={t("workflow.processName")} />
                  </Form.Item>
                  <Form.Item
                    name="document_type"
                    label={t("workflow.documentType")}
                    rules={[{ required: true }]}
                  >
                    <Select options={DOCUMENT_TYPE_OPTIONS} />
                  </Form.Item>
                  <Form.Item
                    name="version"
                    label={t("workflow.version")}
                    rules={[{ required: true }]}
                  >
                    <InputNumber min={1} style={{ width: "100%" }} />
                  </Form.Item>
                  <Form.Item
                    name="is_active"
                    label={t("workflow.active")}
                    valuePropName="checked"
                  >
                    <Switch />
                  </Form.Item>
                  <Form.Item
                    name="description"
                    label={t("workflow.description")}
                  >
                    <Input.TextArea rows={2} />
                  </Form.Item>
                </Form>
              </Card>
              <Card size="small" title={t("workflow.quickAdd")}>
                <Space direction="vertical" style={{ width: "100%" }}>
                  <Button
                    block
                    icon={<PlusOutlined />}
                    onClick={() => insertNodeAfterSelected("approval")}
                  >
                    {t("workflow.addApprovalNode")}
                  </Button>
                  <Button
                    block
                    icon={<PlusOutlined />}
                    onClick={() => insertNodeAfterSelected("condition")}
                  >
                    {t("workflow.addConditionNode")}
                  </Button>
                  <Button
                    block
                    icon={<PlusOutlined />}
                    onClick={() => insertNodeAfterSelected("end")}
                  >
                    {t("workflow.addEndNode")}
                  </Button>
                </Space>
              </Card>
            </div>
          </Splitter.Panel>
          <Splitter.Panel defaultSize="70%" min="62%" max="82%">
            <WorkflowDiagram
              nodes={nodes}
              edges={edges}
              selectedKey={selectedKey}
              selectedEdgeId={selectedEdgeId || undefined}
              onSelectNode={(key) => { setSelectedKey(key); setPropertyTab("node"); }}
              onSelectEdge={(edgeId) => { setSelectedEdgeId(edgeId); if (edgeId) setPropertyTab("edge"); }}
              onNodeMove={updateNodePosition}
              onEdgeChange={updateEdges}
              height={canvasHeight}
            />
          </Splitter.Panel>
          <Splitter.Panel defaultSize="18%" min="14%" max="24%">
            <div style={{ height: "100%", overflow: "auto", paddingLeft: 12 }}>
              <Tabs activeKey={propertyTab} onChange={setPropertyTab}>
                <Tabs.TabPane key="node" tab={t("workflow.nodeProperties")}>
              <Card
                size="small"
                title={t("workflow.nodeProperties")}
                extra={
                  selectedNode ? (
                    <Space>
                      <Button
                        type="link"
                        size="small"
                        onClick={() => void saveSelectedNode()}
                      >
                        {t("workflow.applyNode")}
                      </Button>
                      <Button
                        icon={<DeleteOutlined />}
                        danger
                        type="link"
                        onClick={() => removeNode(selectedNode.node_key)}
                      />
                    </Space>
                  ) : null
                }
              >
                {selectedNode ? (
                  <Form form={nodeForm} layout="vertical">
                    <Form.Item
                      name="node_key"
                      label={t("workflow.nodeKey")}
                      rules={[{ required: true }]}
                    >
                      <Input />
                    </Form.Item>
                    <Form.Item
                      name="node_name"
                      label={t("workflow.nodeName")}
                      rules={[{ required: true }]}
                    >
                      <Input />
                    </Form.Item>
                    <Form.Item name="node_type" label={t("workflow.nodeType")}>
                      <Select
                        options={[
                          {
                            label: t("workflow.approvalNode"),
                            value: "approval",
                          },
                          {
                            label: t("workflow.conditionNode"),
                            value: "condition",
                          },
                          { label: t("workflow.startNode"), value: "start" },
                          { label: t("workflow.endNode"), value: "end" },
                        ]}
                      />
                    </Form.Item>
                    <Form.Item
                      name="sequence_no"
                      label={t("workflow.sequenceNo")}
                    >
                      <InputNumber min={1} style={{ width: "100%" }} />
                    </Form.Item>
                    <Form.Item
                      name="approver_mode"
                      label={t("workflow.approverMode")}
                    >
                      <Select
                        options={[
                          {
                            label: t("workflow.approverModeRole"),
                            value: "role",
                          },
                          {
                            label: t("workflow.approverModeSystem"),
                            value: "system",
                          },
                        ]}
                      />
                    </Form.Item>
                    <Form.Item
                      name="approver_role_code"
                      label={t("workflow.approverRole")}
                    >
                      <Select allowClear options={roles} />
                    </Form.Item>
                    <Row gutter={12}>
                      <Col span={12}>
                        <Form.Item
                          name="allow_reject"
                          label={t("workflow.allowReject")}
                          valuePropName="checked"
                        >
                          <Switch />
                        </Form.Item>
                      </Col>
                      <Col span={12}>
                        <Form.Item
                          name="allow_withdraw"
                          label={t("workflow.allowWithdraw")}
                          valuePropName="checked"
                        >
                          <Switch />
                        </Form.Item>
                      </Col>
                    </Row>
                    <Row gutter={12}>
                      <Col span={12}>
                        <Form.Item
                          name="is_start_node"
                          label={t("workflow.startNode")}
                          valuePropName="checked"
                        >
                          <Switch />
                        </Form.Item>
                      </Col>
                      <Col span={12}>
                        <Form.Item
                          name="is_end_node"
                          label={t("workflow.endNode")}
                          valuePropName="checked"
                        >
                          <Switch />
                        </Form.Item>
                      </Col>
                    </Row>
                    <Form.Item
                      name="condition_expr"
                      label={t("workflow.conditionExpr")}
                    >
                      <Input placeholder="amount >= 50000" />
                    </Form.Item>
                    <Form.Item
                      name="condition_label"
                      label={t("workflow.conditionLabel")}
                    >
                      <Input
                        placeholder={t("workflow.conditionLabelPlaceholder")}
                      />
                    </Form.Item>
                    <Form.Item
                      name="is_default_path"
                      label={t("workflow.defaultPath")}
                      valuePropName="checked"
                    >
                      <Switch />
                    </Form.Item>
                  </Form>
                ) : (
                  <div>{t("workflow.noNodeSelected")}</div>
                )}
              </Card>
                </Tabs.TabPane>
                <Tabs.TabPane key="edge" tab={t("workflow.edgeProperties")}>
              <Card
                size="small"
                title={t("workflow.edgeProperties")}
                style={{ marginTop: 12 }}
                extra={
                  selectedEdge ? (
                    <Space>
                      <Button
                        type="link"
                        size="small"
                        onClick={removeSelectedEdge}
                      >
                        {t("common.delete")}
                      </Button>
                    </Space>
                  ) : null
                }
              >
                {selectedEdge ? (
                  <Form form={edgeForm} layout="vertical">
                    <Form.Item name="label" label={t("workflow.edgeLabel")}><Input /></Form.Item>
                    <Form.Item name="lineStyle" label={t("workflow.edgeLineStyle")}><Select options={[{ label: t("workflow.edgeSolid"), value: "solid" }, { label: t("workflow.edgeDashed"), value: "dashed" }]} /></Form.Item>
                    <Form.Item name="color" label={t("workflow.edgeColor")}><Select options={[{ label: t("workflow.edgeColorBlue"), value: "#1677ff" }, { label: t("workflow.edgeColorOrange"), value: "#f59e0b" }, { label: t("workflow.edgeColorGray"), value: "#91a4b7" }]} /></Form.Item>
                    <Button type="primary" block onClick={() => void saveSelectedEdge()}>{t("workflow.applyEdge")}</Button>
                    <div style={{ marginTop: 12 }}>
                      <div>{t("common.id")}:<Tag>{selectedEdge.id}</Tag></div>
                      <div>{t("workflow.edgeSource")}:<Tag>{selectedEdge.source}</Tag></div>
                      <div>{t("workflow.edgeTarget")}:<Tag>{selectedEdge.target}</Tag></div>
                    </div>
                  </Form>
                ) : (
                  <div>{t("workflow.noEdgeSelected")}</div>
                )}
              </Card>
                </Tabs.TabPane>
              </Tabs>
            </div>
          </Splitter.Panel>
        </Splitter>
      </Drawer>
    </Card>
  );
}

function normalizeRuleJson(ruleJson: unknown) {
  return ruleJson && typeof ruleJson === 'object' ? (ruleJson as Record<string, unknown>) : {};
}

function toNodeFormValues(node: WorkflowNode): NodeFormValues {
  const rule = normalizeRuleJson(node.rule_json);
  return { node_key: node.node_key, node_name: node.node_name, node_type: node.node_type, sequence_no: node.sequence_no, approver_mode: node.approver_mode, approver_role_code: node.approver_role_code, allow_reject: node.allow_reject, allow_withdraw: node.allow_withdraw, is_start_node: node.is_start_node, is_end_node: node.is_end_node, condition_expr: String(rule.expr || ''), condition_label: String(rule.conditionLabel || ''), is_default_path: Boolean(rule.isDefaultPath) };
}

function mergeNodeForm(node: WorkflowNode, values: NodeFormValues): WorkflowNode {
  const rule = normalizeRuleJson(node.rule_json);
  const layout = (normalizeRuleJson(node.rule_json) as Record<string, unknown>).layout;
  const nextRule: Record<string, unknown> = node.node_type === 'condition' ? { ...rule, expr: values.condition_expr, conditionLabel: values.condition_label, isDefaultPath: values.is_default_path } : { ...rule };
  if (layout) nextRule.layout = layout;
  return { ...node, node_name: values.node_name, node_type: values.node_type, sequence_no: values.sequence_no, approver_mode: values.approver_mode, approver_role_code: values.approver_role_code, allow_reject: values.allow_reject, allow_withdraw: values.allow_withdraw, is_start_node: values.is_start_node, is_end_node: values.is_end_node, rule_json: nextRule };
}

function renumberNodes(nodes: WorkflowNode[]) {
  return nodes.map((node, index) => ({ ...node, sequence_no: index + 1 }));
}

function computeCanvasHeight(nodes: WorkflowNode[]) {
  if (!nodes.length) return 640;
  const maxY = nodes.reduce((acc, node) => {
    const layout = normalizeRuleJson(node.rule_json).layout as { y?: number } | undefined;
    return Math.max(acc, Number(layout?.y || 0));
  }, 0);
  return Math.max(640, maxY + 220);
}

function parseEdges(configJson: Record<string, unknown> | null | undefined, nodes: WorkflowNode[]) {
  const edges = (configJson?.workflowEdges as WorkflowEdgeItem[] | undefined) || [];
  if (edges.length) return edges;
  const nodeKeys = new Set(nodes.map((node) => node.node_key));
  return DEFAULT_GRAPH.edges.filter((edge) => nodeKeys.has(edge.source) && nodeKeys.has(edge.target));
}

function buildConfigJson(edges: WorkflowEdgeItem[]) {
  return { workflowEdges: edges };
}
