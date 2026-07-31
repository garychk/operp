import { useEffect, useMemo, useState } from 'react';
import { Button, Card, Col, Drawer, Form, Input, InputNumber, Row, Select, Space, Splitter, Switch, Table, Tag, message } from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined, SaveOutlined, ArrowDownOutlined, ArrowUpOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { supabase } from '../../utils/supabase';

type DocumentType = {
  id: number;
  document_type: string;
  document_name: string;
  module_code: string | null;
  route_path: string | null;
  table_name: string | null;
  primary_key_field: string;
  workflow_process_id: number | null;
  naming_rule: string | null;
  is_submittable: boolean;
  is_single: boolean;
  is_child: boolean;
  is_tree: boolean;
  quick_entry: boolean;
  track_changes: boolean;
  status: string;
  sort_order: number;
};

type DocumentField = {
  id: number;
  document_type_id: number;
  field_name: string;
  label: string;
  field_type: string;
  data_type: string | null;
  options: string | null;
  default_value: string | null;
  description: string | null;
  length: number | null;
  precision: number | null;
  scale: number | null;
  width: number | null;
  is_required: boolean;
  is_unique: boolean;
  is_read_only: boolean;
  is_hidden: boolean;
  no_copy: boolean;
  allow_on_submit: boolean;
  in_list_view: boolean;
  in_standard_filter: boolean;
  in_global_search: boolean;
  section_code: string | null;
  column_index: number;
  sort_order: number;
};

const FIELD_TYPES = ['Data', 'Text', 'LongText', 'Int', 'Float', 'Currency', 'Date', 'DateTime', 'Check', 'Select', 'Link', 'DynamicLink', 'Table', 'Attach', 'Image', 'HTML', 'SectionBreak', 'ColumnBreak'];
const emptyDocument = (): Partial<DocumentType> => ({ document_type: '', document_name: '', module_code: '', route_path: '', table_name: '', primary_key_field: 'id', naming_rule: '', is_submittable: true, is_single: false, is_child: false, is_tree: false, quick_entry: false, track_changes: true, status: '1', sort_order: 0 });

export function DocumentTypeBuilder() {
  const [documents, setDocuments] = useState<DocumentType[]>([]);
  const [selected, setSelected] = useState<DocumentType | null>(null);
  const [fields, setFields] = useState<DocumentField[]>([]);
  const [loading, setLoading] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [fieldOpen, setFieldOpen] = useState(false);
  const [editingField, setEditingField] = useState<DocumentField | null>(null);
  const [documentForm] = Form.useForm();
  const [fieldForm] = Form.useForm();

  const loadDocuments = async () => {
    setLoading(true);
    const { data, error } = await supabase.from('sys_document_types').select('*').eq('is_deleted', 'n').order('sort_order').order('document_name');
    if (error) message.error(error.message); else setDocuments((data || []) as DocumentType[]);
    setLoading(false);
  };
  const loadFields = async (documentId: number) => {
    const { data, error } = await supabase.from('sys_document_type_fields').select('*').eq('document_type_id', documentId).eq('is_deleted', 'n').order('sort_order').order('id');
    if (error) message.error(error.message); else setFields((data || []) as DocumentField[]);
  };
  useEffect(() => { void loadDocuments(); }, []);

  const openDocument = (record?: DocumentType) => {
    setSelected(record || null);
    documentForm.setFieldsValue(record || emptyDocument());
    setFields([]);
    if (record) void loadFields(record.id);
    setDrawerOpen(true);
  };
  const saveDocument = async () => {
    const values = await documentForm.validateFields();
    const payload = { ...values, updated_at: new Date().toISOString() };
    const result = selected
      ? await supabase.from('sys_document_types').update(payload).eq('id', selected.id).select().single()
      : await supabase.from('sys_document_types').insert(payload).select().single();
    if (result.error) { message.error(result.error.message); return; }
    const saved = result.data as DocumentType;
    setSelected(saved);
    documentForm.setFieldsValue(saved);
    await loadDocuments();
    message.success('单据类型已保存');
  };
  const syncDatabaseFields = async () => {
    if (!selected) return;
    const { data, error } = await supabase.rpc("sync_document_type_fields", { p_document_type_id: selected.id });
    if (error) { message.error(error.message); return; }
    await loadFields(selected.id);
    message.success(`已同步 ${Number(data || 0)} 个数据库字段`);
  };

  const saveField = async () => {
    if (!selected) return;
    const values = await fieldForm.validateFields();
    const payload = { ...values, document_type_id: selected.id, updated_at: new Date().toISOString() };
    const result = editingField
      ? await supabase.from('sys_document_type_fields').update(payload).eq('id', editingField.id).select().single()
      : await supabase.from('sys_document_type_fields').insert(payload).select().single();
    if (result.error) { message.error(result.error.message); return; }
    setFieldOpen(false);
    setEditingField(null);
    await loadFields(selected.id);
    message.success('字段已保存');
  };
  const removeField = async (field: DocumentField) => {
    const { error } = await supabase.from('sys_document_type_fields').update({ is_deleted: 'y', updated_at: new Date().toISOString() }).eq('id', field.id);
    if (error) message.error(error.message); else void loadFields(selected!.id);
  };
  const moveField = async (index: number, offset: number) => {
    const target = index + offset;
    if (target < 0 || target >= fields.length) return;
    const next = [...fields];
    [next[index], next[target]] = [next[target], next[index]];
    setFields(next);
    await Promise.all(next.map((field, order) => supabase.from('sys_document_type_fields').update({ sort_order: order + 1 }).eq('id', field.id)));
  };
  const fieldColumns: ColumnsType<DocumentField> = useMemo(() => [
    { title: '顺序', width: 70, render: (_: unknown, _field: DocumentField, index: number) => <Space><Button type="text" size="small" icon={<ArrowUpOutlined />} disabled={!index} onClick={() => void moveField(index, -1)} /><Button type="text" size="small" icon={<ArrowDownOutlined />} disabled={index === fields.length - 1} onClick={() => void moveField(index, 1)} /></Space> },
    { title: '字段名', dataIndex: 'field_name', width: 150 },
    { title: '标签', dataIndex: 'label', width: 140 },
    { title: '类型', dataIndex: 'field_type', width: 110, render: (value: string) => <Tag>{value}</Tag> },
    { title: '属性', render: (_: unknown, field: DocumentField) => <Space>{field.is_required && <Tag color="red">必填</Tag>}{field.is_read_only && <Tag>只读</Tag>}{field.in_list_view && <Tag color="blue">列表</Tag>}</Space> },
    { title: '操作', width: 130, render: (_: unknown, field: DocumentField) => <Space><Button type="link" icon={<EditOutlined />} onClick={() => { setEditingField(field); fieldForm.setFieldsValue(field); setFieldOpen(true); }}>编辑</Button><Button type="link" danger icon={<DeleteOutlined />} onClick={() => void removeField(field)} /></Space> },
  ], [fields, fieldForm]);

  return (
    <Card className="mainContent" variant="borderless" title="DocType Builder" extra={<Button type="primary" icon={<PlusOutlined />} onClick={() => openDocument()}>新建 DocType</Button>}>
      <Table rowKey="id" loading={loading} dataSource={documents} onRow={(record) => ({ onClick: () => openDocument(record) })} columns={[
        { title: "单据类型", dataIndex: "document_type" },
        { title: "名称", dataIndex: "document_name" },
        { title: "模块", dataIndex: "module_code" },
        { title: "业务表", dataIndex: "table_name" },
        { title: "状态", dataIndex: "status", render: (value: string) => <Tag color={value === "1" ? "green" : "default"}>{value === "1" ? "启用" : "停用"}</Tag> },
      ] as ColumnsType<DocumentType>} />
      <Drawer title={selected ? `编辑 DocType：${selected.document_name}` : "新建 DocType"} width="94%" open={drawerOpen} onClose={() => setDrawerOpen(false)} extra={<Button type="primary" icon={<SaveOutlined />} onClick={() => void saveDocument()}>保存</Button>}>
        <Splitter style={{ height: "calc(100vh - 150px)" }}>
          <Splitter.Panel defaultSize="34%" min="28%">
            <Card size="small" title="DocType 属性">
              <Form form={documentForm} layout="vertical">
                <Row gutter={12}><Col span={12}><Form.Item name="document_type" label="类型编码" rules={[{ required: true }]}><Input disabled={!!selected} /></Form.Item></Col><Col span={12}><Form.Item name="document_name" label="名称" rules={[{ required: true }]}><Input /></Form.Item></Col></Row>
                <Row gutter={12}><Col span={12}><Form.Item name="module_code" label="模块"><Input /></Form.Item></Col><Col span={12}><Form.Item name="table_name" label="业务表"><Input /></Form.Item></Col></Row>
                <Form.Item name="route_path" label="路由"><Input /></Form.Item>
                <Form.Item name="primary_key_field" label="主键字段"><Input /></Form.Item>
                <Form.Item name="naming_rule" label="编号规则"><Input placeholder="PO{YYYY}{####}" /></Form.Item>
                <Row gutter={12}><Col span={12}><Form.Item name="is_submittable" label="可提交" valuePropName="checked"><Switch /></Form.Item></Col><Col span={12}><Form.Item name="quick_entry" label="快速录入" valuePropName="checked"><Switch /></Form.Item></Col></Row>
                <Row gutter={12}><Col span={12}><Form.Item name="track_changes" label="跟踪变更" valuePropName="checked"><Switch /></Form.Item></Col><Col span={12}><Form.Item name="status" label="状态"><Select options={[{ label: "启用", value: "1" }, { label: "停用", value: "0" }]} /></Form.Item></Col></Row>
              </Form>
            </Card>
          </Splitter.Panel>
          <Splitter.Panel>
            <Card size="small" title="字段定义" extra={<Space><Button icon={<SaveOutlined />} disabled={!selected} onClick={() => void syncDatabaseFields()}>同步数据库字段</Button><Button type="primary" icon={<PlusOutlined />} disabled={!selected} onClick={() => { setEditingField(null); fieldForm.resetFields(); fieldForm.setFieldsValue({ field_type: "Data", column_index: 1, sort_order: fields.length + 1 }); setFieldOpen(true); }}>新增字段</Button></Space>}>
              <Table size="small" rowKey="id" dataSource={fields} columns={fieldColumns} pagination={false} />
            </Card>
          </Splitter.Panel>
        </Splitter>
        <Drawer title={editingField ? "编辑字段" : "新增字段"} width={560} open={fieldOpen} onClose={() => setFieldOpen(false)} extra={<Button type="primary" onClick={() => void saveField()}>保存字段</Button>}>
          <Form form={fieldForm} layout="vertical">
            <Row gutter={12}><Col span={12}><Form.Item name="field_name" label="字段名" rules={[{ required: true }]}><Input /></Form.Item></Col><Col span={12}><Form.Item name="label" label="标签" rules={[{ required: true }]}><Input /></Form.Item></Col></Row>
            <Row gutter={12}><Col span={12}><Form.Item name="field_type" label="字段类型" rules={[{ required: true }]}><Select options={FIELD_TYPES.map((value) => ({ label: value, value }))} /></Form.Item></Col><Col span={12}><Form.Item name="options" label="选项"><Input /></Form.Item></Col></Row>
            <Form.Item name="default_value" label="默认值"><Input /></Form.Item>
            <Row gutter={12}><Col span={8}><Form.Item name="is_required" label="必填" valuePropName="checked"><Switch /></Form.Item></Col><Col span={8}><Form.Item name="is_read_only" label="只读" valuePropName="checked"><Switch /></Form.Item></Col><Col span={8}><Form.Item name="is_hidden" label="隐藏" valuePropName="checked"><Switch /></Form.Item></Col></Row>
            <Row gutter={12}><Col span={8}><Form.Item name="in_list_view" label="列表显示" valuePropName="checked"><Switch /></Form.Item></Col><Col span={8}><Form.Item name="in_standard_filter" label="标准筛选" valuePropName="checked"><Switch /></Form.Item></Col><Col span={8}><Form.Item name="in_global_search" label="全局搜索" valuePropName="checked"><Switch /></Form.Item></Col></Row>
            <Row gutter={12}><Col span={8}><Form.Item name="length" label="长度"><InputNumber min={1} style={{ width: "100%" }} /></Form.Item></Col><Col span={8}><Form.Item name="precision" label="精度"><InputNumber min={0} style={{ width: "100%" }} /></Form.Item></Col><Col span={8}><Form.Item name="scale" label="小数位"><InputNumber min={0} style={{ width: "100%" }} /></Form.Item></Col></Row>
            <Form.Item name="description" label="说明"><Input.TextArea rows={3} /></Form.Item>
          </Form>
        </Drawer>
      </Drawer>
    </Card>
  );
}
export default DocumentTypeBuilder;
