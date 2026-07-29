import { useEffect, useMemo, useState } from 'react';
import { Button, Card, Col, Drawer, Form, Input, InputNumber, Popconfirm, Row, Select, Space, Switch, Table, Tag, message } from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { Splitter } from 'antd';
import { supabase } from '../../utils/supabase';
import { logWithTiming } from '../../utils/logger';
import { useTranslation } from 'react-i18next';
import { WorkflowDiagram, WorkflowNodeItem } from '../../components/workflow/WorkflowDiagram';

 type WorkflowDefinition = {
  id: number;
  process_code: string;
  process_name: string;
  document_type: string;
  description: string | null;
  is_active: boolean | null;
  version: number | null;
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
  true_target_key: string | null;
  false_target_key: string | null;
  is_default_path: boolean;
};

const DOCUMENT_TYPE_OPTIONS = [
  { label: '采购订单', value: 'purchase_order' },
  { label: '销售订单', value: 'sales_order' },
  { label: '采购入库', value: 'purchase_receipt' },
  { label: '销售出货', value: 'sales_delivery' },
  { label: '凭证', value: 'voucher' },
];

const DEFAULT_NODES: WorkflowNode[] = [
  {
    node_key: 'start',
    node_name: '提交审批',
    node_type: 'start',
    sequence_no: 1,
    approver_mode: 'system',
    approver_role_code: null,
    allow_reject: false,
    allow_withdraw: false,
    is_start_node: true,
    is_end_node: false,
    rule_json: {},
  },
  {
    node_key: 'amount_condition',
    node_name: '金额判断',
    node_type: 'condition',
    sequence_no: 2,
    approver_mode: 'system',
    approver_role_code: null,
    allow_reject: false,
    allow_withdraw: false,
    is_start_node: false,
    is_end_node: false,
    rule_json: { expr: 'amount >= 50000', trueTargetKey: 'finance_manager', falseTargetKey: 'dept_manager' },
  },
  {
    node_key: 'dept_manager',
    node_name: '部门审批',
    node_type: 'approval',
    sequence_no: 3,
    approver_mode: 'role',
    approver_role_code: 'inventory_manager',
    allow_reject: true,
    allow_withdraw: false,
    is_start_node: false,
    is_end_node: false,
    rule_json: {},
  },
  {
    node_key: 'finance_manager',
    node_name: '财务复核',
    node_type: 'approval',
    sequence_no: 4,
    approver_mode: 'role',
    approver_role_code: 'finance_manager',
    allow_reject: true,
    allow_withdraw: false,
    is_start_node: false,
    is_end_node: false,
    rule_json: {},
  },
  {
    node_key: 'final',
    node_name: '终审完成',
    node_type: 'end',
    sequence_no: 5,
    approver_mode: 'system',
    approver_role_code: null,
    allow_reject: false,
    allow_withdraw: false,
    is_start_node: false,
    is_end_node: true,
    rule_json: {},
  },
];

export function WorkflowConfig() {
  const { t } = useTranslation();
  const [definitions, setDefinitions] = useState<WorkflowDefinition[]>([]);
  const [roles, setRoles] = useState<RoleOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<WorkflowDefinition | null>(null);
  const [nodes, setNodes] = useState<WorkflowNode[]>([]);
  const [selectedKey, setSelectedKey] = useState<string>('');
  const [canvasHeight, setCanvasHeight] = useState<number>(640);
  const [form] = Form.useForm();
  const [nodeForm] = Form.useForm<NodeFormValues>();

  const fetchDefinitions = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('wf_process_definitions')
        .select('id, process_code, process_name, document_type, description, is_active, version')
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
    const { data, error } = await supabase
      .from('sys_roles')
      .select('role_code, role_name')
      .eq('is_deleted', 'n')
      .eq('status', '1')
      .order('sort_order', { ascending: true });
    if (error) return;
    setRoles((data || []).map((role) => ({ label: `${role.role_name} (${role.role_code})`, value: role.role_code })));
  };

  useEffect(() => {
    void fetchDefinitions();
    void fetchRoles();
  }, []);

  const loadNodes = async (processId: number) => {
    const { data, error } = await supabase
      .from('wf_process_nodes')
      .select('node_key, node_name, node_type, sequence_no, approver_mode, approver_role_code, allow_reject, allow_withdraw, is_start_node, is_end_node, rule_json')
      .eq('is_deleted', 'n')
      .eq('process_id', processId)
      .order('sequence_no', { ascending: true });
    if (error) throw error;
    const loaded = ((data || []) as WorkflowNode[]).map((node) => ({
      ...node,
      rule_json: node.rule_json && typeof node.rule_json === 'object' ? node.rule_json : {},
    }));
    setCanvasHeight(computeCanvasHeight(loaded));
    const initialNodes = loaded.length ? loaded : DEFAULT_NODES;
    setNodes(initialNodes);
    setSelectedKey(initialNodes[0]?.node_key || '');
    setCanvasHeight(computeCanvasHeight(initialNodes));
    nodeForm.setFieldsValue(toNodeFormValues(loaded[0] || DEFAULT_NODES[0]));
  };

  const handleAdd = () => {
    setEditing(null);
    form.setFieldsValue({ process_code: '', process_name: '', document_type: 'purchase_order', description: '', is_active: true, version: 1 });
    setNodes(DEFAULT_NODES);
    setSelectedKey(DEFAULT_NODES[0].node_key);
    setCanvasHeight(computeCanvasHeight(DEFAULT_NODES));
    nodeForm.setFieldsValue(toNodeFormValues(DEFAULT_NODES[0]));
    setModalOpen(true);
  };

  const handleEdit = async (record: WorkflowDefinition) => {
    setEditing(record);
    form.setFieldsValue(record);
    await loadNodes(record.id);
    setModalOpen(true);
  };

  const selectedNode = useMemo(() => nodes.find((node) => node.node_key === selectedKey) || nodes[0] || null, [nodes, selectedKey]);

  useEffect(() => {
    if (!selectedNode) return;
    nodeForm.setFieldsValue(toNodeFormValues(selectedNode));
  }, [selectedNode, nodeForm]);

  const saveSelectedNode = async () => {
    const values = await nodeForm.validateFields();
    setNodes((prev) => {
      const next = prev.map((node) => node.node_key === selectedKey ? mergeNodeForm(node, values) : node);
      setCanvasHeight(computeCanvasHeight(next));
      return next;
    });
    message.success(t('workflow.nodeSaved'));
  };

  const handleSave = async () => {
    const values = await form.validateFields();
    if (!nodes.length) {
      message.error(t('workflow.atLeastOneNode'));
      return;
    }

    await logWithTiming(t('workflow.configTitle'), 'UPSERT', async () => {
      const processPayload = { process_code: values.process_code, process_name: values.process_name, document_type: values.document_type, description: values.description, is_active: values.is_active, version: values.version, is_deleted: 'n' };
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
        rule_json: node.rule_json || {},
        is_deleted: 'n',
      }));
      const { error } = await supabase.from('wf_process_nodes').insert(nodePayload);
      if (error) throw error;
    }, { process_code: values.process_code });

    message.success(t('workflow.saveSuccess'));
    setModalOpen(false);
    await fetchDefinitions();
  };

  const handleToggleActive = async (record: WorkflowDefinition) => {
    const nextActive = !record.is_active;
    try {
      const { error } = await supabase
        .from('wf_process_definitions')
        .update({ is_active: nextActive })
        .eq('id', record.id);
      if (error) throw error;
      message.success(nextActive ? t('workflow.enableSuccess') : t('workflow.disableSuccess'));
      await fetchDefinitions();
    } catch {
      message.error(t('workflow.saveFailed'));
    }
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

  const addNode = (nodeType: WorkflowNode['node_type'] = 'approval') => {
    const nextSeq = nodes.length ? Math.max(...nodes.map((n) => Number(n.sequence_no) || 0)) + 1 : 1;
    const node_key = `node_${Date.now()}`;
    const nextNode: WorkflowNode = {
      node_key,
      node_name: nodeType === 'condition' ? t('workflow.conditionNode') : t('workflow.nodesTitle'),
      node_type: nodeType,
      sequence_no: nextSeq,
      approver_mode: nodeType === 'condition' || nodeType === 'end' || nodeType === 'start' ? 'system' : 'role',
      approver_role_code: null,
      allow_reject: true,
      allow_withdraw: false,
      is_start_node: false,
      is_end_node: false,
      rule_json: nodeType === 'condition' ? { expr: '', trueTargetKey: '', falseTargetKey: '', isDefaultPath: false } : {},
    };
    setNodes((prev) => {
      const next = [...prev, nextNode];
      setCanvasHeight(computeCanvasHeight(next));
      return next;
    });
    setSelectedKey(node_key);
    nodeForm.setFieldsValue(toNodeFormValues(nextNode));
  };

  const updateNode = (index: number, patch: Partial<WorkflowNode>) => {
    setNodes((prev) => {
      const next = prev.map((node, i) => (i === index ? { ...node, ...patch } : node));
      setCanvasHeight(computeCanvasHeight(next));
      return next;
    });
  };

  
  const columns = [
    { title: t('workflow.processName'), dataIndex: 'process_name' },
    { title: t('workflow.documentType'), dataIndex: 'document_type', render: (value: string) => DOCUMENT_TYPE_OPTIONS.find((item) => item.value === value)?.label || value },
    { title: t('workflow.processCode'), dataIndex: 'process_code' },
    { title: t('workflow.version'), dataIndex: 'version', width: 80 },
    { title: t('workflow.status'), dataIndex: 'is_active', width: 100, render: (value: boolean) => <Tag color={value ? 'green' : 'default'}>{value ? t('workflow.active') : t('workflow.inactive')}</Tag> },
    { title: t('workflow.action'), key: 'action', render: (_: unknown, record: WorkflowDefinition) => (<Space><Button type="text" icon={<EditOutlined />} onClick={() => void handleEdit(record)}>{t('common.edit')}</Button><Button type="text" onClick={() => void handleToggleActive(record)}>{record.is_active ? t('workflow.disable') : t('workflow.enable')}</Button><Popconfirm title={t('workflow.deleteConfirm')} onConfirm={() => void handleDelete(record.id)}><Button type="text" danger icon={<DeleteOutlined />}>{t('common.delete')}</Button></Popconfirm></Space>) },
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
        size="90%"
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
                    onClick={() => addNode("approval")}
                  >
                    {t("workflow.addApprovalNode")}
                  </Button>
                  <Button
                    block
                    icon={<PlusOutlined />}
                    onClick={() => addNode("condition")}
                  >
                    {t("workflow.addConditionNode")}
                  </Button>
                  <Button
                    block
                    icon={<PlusOutlined />}
                    onClick={() => addNode("end")}
                  >
                    {t("workflow.addEndNode")}
                  </Button>
                </Space>
              </Card>
            </div>
          </Splitter.Panel>
          <Splitter.Panel defaultSize="68%" min="62%" max="82%">
            <WorkflowDiagram
              nodes={nodes}
              onSelectNode={(key) => setSelectedKey(key)}
              onNodeMove={(key, position) => {
                setNodes((prev) => {
                  const next = prev.map((node) => node.node_key === key
                    ? {
                        ...node,
                        rule_json: {
                          ...(node.rule_json || {}),
                          layout: position,
                        },
                      }
                    : node);
                  setCanvasHeight(computeCanvasHeight(next));
                  return next;
                });
              }}
              selectedKey={selectedKey}
              height={canvasHeight}
            />
            <Table
              style={{ display: "none" }}
              size="small"
              pagination={false}
              rowKey="node_key"
              dataSource={nodes}
              rowClassName={(record) =>
                record.node_key === selectedKey ? "ant-table-row-selected" : ""
              }
              onRow={(record) => ({
                onClick: () => setSelectedKey(record.node_key),
              })}
              columns={[
                { title: t("workflow.nodeName"), dataIndex: "node_name" },
                { title: t("workflow.nodeType"), dataIndex: "node_type" },
                {
                  title: t("workflow.sequenceNo"),
                  dataIndex: "sequence_no",
                  width: 90,
                },
                {
                  title: t("workflow.routeType"),
                  dataIndex: "rule_json",
                  render: (_, record) =>
                    record.node_type === "condition"
                      ? t("workflow.conditionNode")
                      : record.is_start_node
                        ? t("workflow.startNode")
                        : record.is_end_node
                          ? t("workflow.endNode")
                          : t("workflow.approvalNode"),
                },
                {
                  title: t("workflow.action"),
                  key: "action",
                  width: 120,
                  render: (_: unknown, __: WorkflowNode, index: number) => (
                    <Space>
                      <Button
                        type="text"
                        onClick={() => {
                          setSelectedKey(nodes[index].node_key);
                          const current = nodes[index];
                          nodeForm.setFieldsValue(toNodeFormValues(current));
                        }}
                      >
                        {t("common.edit")}
                      </Button>
                      <Button
                        type="text"
                        danger
                        icon={<DeleteOutlined />}
                        onClick={() =>
                          setNodes((prev) => prev.filter((_, i) => i !== index))
                        }
                      />
                    </Space>
                  ),
                },
              ]}
            />
          </Splitter.Panel>
          <Splitter.Panel defaultSize="20%" min="14%" max="24%">
            <div style={{ height: "100%", overflow: "auto", paddingLeft: 12 }}>
              <Card
                size="small"
                title={t("workflow.nodeProperties")}
                extra={
                  selectedNode ? (
                    <Space>
                      <Tag>{selectedNode.node_key}</Tag>
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
                        onClick={() => {
                          if (!selectedNode) return;
                          setNodes((prev) => prev.filter((n) => n.node_key !== selectedNode.node_key));
                          setSelectedKey('');
                        }}
                      />
                    </Space>
                  ) : null
                }
              >
                {selectedNode ? (
                  <Form form={nodeForm} layout="vertical">
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
                      name="true_target_key"
                      label={t("workflow.trueTargetKey")}
                    >
                      <Select
                        allowClear
                        options={nodes
                          .filter(
                            (node) => node.node_key !== selectedNode.node_key,
                          )
                          .map((node) => ({
                            label: `${node.node_name} (${node.node_key})`,
                            value: node.node_key,
                          }))}
                      />
                    </Form.Item>
                    <Form.Item
                      name="false_target_key"
                      label={t("workflow.falseTargetKey")}
                    >
                      <Select
                        allowClear
                        options={nodes
                          .filter(
                            (node) => node.node_key !== selectedNode.node_key,
                          )
                          .map((node) => ({
                            label: `${node.node_name} (${node.node_key})`,
                            value: node.node_key,
                          }))}
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
            </div>
          </Splitter.Panel>
        </Splitter>
      </Drawer>
    </Card>
  );
}

function toNodeFormValues(node: WorkflowNode): NodeFormValues {
  const rule = (node.rule_json || {}) as Record<string, unknown>;
  return {
    node_key: node.node_key,
    node_name: node.node_name,
    node_type: node.node_type,
    sequence_no: node.sequence_no,
    approver_mode: node.approver_mode,
    approver_role_code: node.approver_role_code,
    allow_reject: node.allow_reject,
    allow_withdraw: node.allow_withdraw,
    is_start_node: node.is_start_node,
    is_end_node: node.is_end_node,
    condition_expr: String(rule.expr || ''),
    condition_label: String(rule.conditionLabel || ''),
    true_target_key: (rule.trueTargetKey as string) || null,
    false_target_key: (rule.falseTargetKey as string) || null,
    is_default_path: Boolean(rule.isDefaultPath),
  };
}

function mergeNodeForm(node: WorkflowNode, values: NodeFormValues): WorkflowNode {
  const existingLayout = getNodeLayout(node.rule_json);
  const rule_json = node.node_type === 'condition'
    ? {
        ...node.rule_json,
        expr: values.condition_expr,
        conditionLabel: values.condition_label,
        trueTargetKey: values.true_target_key,
        falseTargetKey: values.false_target_key,
        isDefaultPath: values.is_default_path,
      }
    : {
        ...node.rule_json,
      };
  if (existingLayout) {
    (rule_json as Record<string, unknown>).layout = existingLayout;
  } else if (node.rule_json && typeof node.rule_json === 'object' && 'layout' in node.rule_json) {
    (rule_json as Record<string, unknown>).layout = (node.rule_json as Record<string, unknown>).layout;
  }
  return {
    ...node,
    node_name: values.node_name,
    node_type: values.node_type,
    sequence_no: values.sequence_no,
    approver_mode: values.approver_mode,
    approver_role_code: values.approver_role_code,
    allow_reject: values.allow_reject,
    allow_withdraw: values.allow_withdraw,
    is_start_node: values.is_start_node,
    is_end_node: values.is_end_node,
    rule_json,
  };
}

function computeCanvasHeight(nodes: WorkflowNode[]) {
  if (!nodes.length) return 640;
  const maxY = nodes.reduce((acc, node) => {
    const layout = getNodeLayout(node.rule_json);
    return Math.max(acc, layout?.y ?? 0);
  }, 0);
  return Math.max(640, maxY + 220);
}

function getNodeLayout(ruleJson: Record<string, unknown>) {
  const layout = ruleJson.layout;
  if (!layout || typeof layout !== 'object') return null;
  const x = Number((layout as Record<string, unknown>).x);
  const y = Number((layout as Record<string, unknown>).y);
  if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
  return null;
}
