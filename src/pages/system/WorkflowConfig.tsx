import { useEffect, useState } from 'react';
import { Button, Card, Col, Drawer, Form, Input, InputNumber, Popconfirm, Row, Select, Space, Table, Tag, Switch, message } from 'antd';
import { PlusOutlined, EditOutlined, ReloadOutlined, DeleteOutlined } from '@ant-design/icons';
import { supabase } from '../../utils/supabase';
import { logWithTiming } from '../../utils/logger';
import { useTranslation } from 'react-i18next';

type WorkflowDefinition = {
  id: number;
  process_code: string;
  process_name: string;
  document_type: string;
  description: string | null;
  is_active: boolean | null;
  version: number | null;
};

type WorkflowNode = {
  node_key: string;
  node_name: string;
  sequence_no: number;
  approver_mode: string;
  approver_role_code: string | null;
  allow_reject: boolean;
  allow_withdraw: boolean;
  is_start_node: boolean;
  is_end_node: boolean;
};

type RoleOption = { label: string; value: string };

export function WorkflowConfig() {
  const { t } = useTranslation();
  const [definitions, setDefinitions] = useState<WorkflowDefinition[]>([]);
  const [roles, setRoles] = useState<RoleOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<WorkflowDefinition | null>(null);
  const [nodes, setNodes] = useState<WorkflowNode[]>([]);
  const [form] = Form.useForm();

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
      .select('node_key, node_name, sequence_no, approver_mode, approver_role_code, allow_reject, allow_withdraw, is_start_node, is_end_node')
      .eq('is_deleted', 'n')
      .eq('process_id', processId)
      .order('sequence_no', { ascending: true });
    if (error) throw error;
    setNodes((data || []) as WorkflowNode[]);
  };

  const handleAdd = () => {
    setEditing(null);
    form.setFieldsValue({ process_code: '', process_name: '', document_type: 'purchase_order', description: '', is_active: true, version: 1 });
    setNodes([
      { node_key: 'start', node_name: '提交审批', sequence_no: 1, approver_mode: 'role', approver_role_code: 'inventory_manager', allow_reject: true, allow_withdraw: false, is_start_node: true, is_end_node: false },
      { node_key: 'approve', node_name: '审核通过', sequence_no: 2, approver_mode: 'role', approver_role_code: 'inventory_manager', allow_reject: true, allow_withdraw: false, is_start_node: false, is_end_node: true },
    ]);
    setModalOpen(true);
  };

  const handleEdit = async (record: WorkflowDefinition) => {
    setEditing(record);
    form.setFieldsValue(record);
    await loadNodes(record.id);
    setModalOpen(true);
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
        node_type: 'approval',
        sequence_no: Number(node.sequence_no),
        approver_mode: node.approver_mode || 'role',
        approver_role_code: node.approver_role_code || null,
        allow_reject: node.allow_reject,
        allow_withdraw: node.allow_withdraw,
        is_start_node: node.is_start_node,
        is_end_node: node.is_end_node,
        rule_json: {},
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

  const updateNode = (index: number, patch: Partial<WorkflowNode>) => {
    setNodes((prev) => prev.map((node, i) => (i === index ? { ...node, ...patch } : node)));
  };

  const addNode = () => {
    const nextSeq = nodes.length ? Math.max(...nodes.map((n) => Number(n.sequence_no) || 0)) + 1 : 1;
    setNodes((prev) => [...prev, { node_key: `node_${Date.now()}`, node_name: t('workflow.nodesTitle'), sequence_no: nextSeq, approver_mode: 'role', approver_role_code: null, allow_reject: true, allow_withdraw: false, is_start_node: false, is_end_node: false }]);
  };

  const columns = [
    { title: t('workflow.processName'), dataIndex: 'process_name' },
    { title: t('workflow.documentType'), dataIndex: 'document_type', render: (value: string) => t(`workflow.documentTypes.${value === 'purchase_order' ? 'purchaseOrder' : value === 'sales_order' ? 'salesOrder' : value === 'purchase_receipt' ? 'purchaseReceipt' : value === 'sales_delivery' ? 'salesDelivery' : 'voucher'}`) },
    { title: t('workflow.processCode'), dataIndex: 'process_code' },
    { title: t('workflow.version'), dataIndex: 'version', width: 80 },
    { title: t('workflow.status'), dataIndex: 'is_active', width: 100, render: (value: boolean) => <Tag color={value ? 'green' : 'default'}>{value ? t('workflow.active') : t('workflow.inactive')}</Tag> },
    { title: t('workflow.action'), key: 'action', render: (_: unknown, record: WorkflowDefinition) => (<Space><Button type="text" icon={<EditOutlined />} onClick={() => void handleEdit(record)}>{t('common.edit')}</Button><Button type="text" onClick={() => void handleToggleActive(record)}>{record.is_active ? t('workflow.disable') : t('workflow.enable')}</Button><Popconfirm title={t('workflow.deleteConfirm')} onConfirm={() => void handleDelete(record.id)}><Button type="text" danger icon={<DeleteOutlined />}>{t('common.delete')}</Button></Popconfirm></Space>) },
  ];

  return (
    <Card className='mainContent' variant="borderless" title={t('workflow.configTitle')} extra={<Space><Button icon={<ReloadOutlined />} onClick={() => void fetchDefinitions()}>{t('workflow.refresh')}</Button><Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>{t('workflow.addProcess')}</Button></Space>}>
      <Table columns={columns} dataSource={definitions} rowKey="id" loading={loading} />

      <Drawer
        title={editing ? t('workflow.editProcess') : t('workflow.createProcess')}
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        width={1100}
        destroyOnHidden
        extra={
          <Space>
            <Button onClick={() => setModalOpen(false)}>{t('common.cancel')}</Button>
            <Button type="primary" onClick={() => void handleSave()}>{t('common.save')}</Button>
          </Space>
        }
      >
        <Form form={form} layout="vertical">
          <Row gutter={16}>
            <Col span={12}><Form.Item name="process_code" label={t('workflow.processCode')} rules={[{ required: true }]}><Input placeholder="purchase_order_default" disabled={!!editing} /></Form.Item></Col>
            <Col span={12}><Form.Item name="process_name" label={t('workflow.processName')} rules={[{ required: true }]}><Input placeholder={t('workflow.processName')} /></Form.Item></Col>
            <Col span={12}><Form.Item name="document_type" label={t('workflow.documentType')} rules={[{ required: true }]}><Select options={[{ label: t('workflow.documentTypes.purchaseOrder'), value: 'purchase_order' }, { label: t('workflow.documentTypes.salesOrder'), value: 'sales_order' }, { label: t('workflow.documentTypes.purchaseReceipt'), value: 'purchase_receipt' }, { label: t('workflow.documentTypes.salesDelivery'), value: 'sales_delivery' }, { label: t('workflow.documentTypes.voucher'), value: 'voucher' }]} /></Form.Item></Col>
            <Col span={12}><Form.Item name="version" label={t('workflow.version')} rules={[{ required: true }]}><InputNumber min={1} style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={12}><Form.Item name="is_active" label={t('workflow.active')} valuePropName="checked"><Switch /></Form.Item></Col>
            <Col span={24}><Form.Item name="description" label={t('workflow.description')}><Input.TextArea rows={2} /></Form.Item></Col>
          </Row>
        </Form>

        <Space style={{ marginBottom: 12 }}><Button icon={<PlusOutlined />} onClick={addNode}>{t('workflow.addNode')}</Button></Space>
        <Table
          rowKey={(record, index) => `${record.node_key}-${index}`}
          pagination={false}
          dataSource={nodes}
          columns={[
            { title: t('workflow.sequenceNo') || t('workflow.version'), dataIndex: 'sequence_no', width: 90, render: (value, _, index) => <InputNumber min={1} value={value} onChange={(next) => updateNode(index, { sequence_no: Number(next || 1) })} /> },
            { title: t('workflow.nodeKey'), dataIndex: 'node_key', width: 180, render: (value, _, index) => <Input value={value} onChange={(e) => updateNode(index, { node_key: e.target.value })} /> },
            { title: t('workflow.nodeName'), dataIndex: 'node_name', width: 180, render: (value, _, index) => <Input value={value} onChange={(e) => updateNode(index, { node_name: e.target.value })} /> },
            { title: t('workflow.approverRole'), dataIndex: 'approver_role_code', width: 240, render: (value, _, index) => <Select value={value || undefined} options={roles} onChange={(next) => updateNode(index, { approver_role_code: next || null })} style={{ width: '100%' }} /> },
            { title: t('workflow.allowReject'), dataIndex: 'allow_reject', width: 120, render: (value, _, index) => <Switch checked={value} onChange={(next) => updateNode(index, { allow_reject: next })} /> },
            { title: t('workflow.allowWithdraw'), dataIndex: 'allow_withdraw', width: 120, render: (value, _, index) => <Switch checked={value} onChange={(next) => updateNode(index, { allow_withdraw: next })} /> },
            { title: t('workflow.startNode'), dataIndex: 'is_start_node', width: 120, render: (value, _, index) => <Switch checked={value} onChange={(next) => updateNode(index, { is_start_node: next })} /> },
            { title: t('workflow.endNode'), dataIndex: 'is_end_node', width: 120, render: (value, _, index) => <Switch checked={value} onChange={(next) => updateNode(index, { is_end_node: next })} /> },
            { title: t('workflow.action'), key: 'action', width: 80, render: (_: unknown, __: WorkflowNode, index: number) => <Button danger type="text" icon={<DeleteOutlined />} onClick={() => setNodes((prev) => prev.filter((_, i) => i !== index))} /> },
          ]}
        />
      </Drawer>
    </Card>
  );
}

