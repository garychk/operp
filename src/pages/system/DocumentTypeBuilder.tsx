import { useEffect, useMemo, useState } from 'react';
import { Button, Card, Col, Drawer, Form, Input, InputNumber, Row, Select, Space, Splitter, Switch, Table, Tag, message } from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined, SaveOutlined, ArrowDownOutlined, ArrowUpOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { supabase } from '../../utils/supabase';
import { useTranslation } from 'react-i18next';

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
  const { t } = useTranslation();
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
    message.success(t('documentTypes.documentSaved'));
  };
  const syncDatabaseFields = async () => {
    if (!selected) return;
    const { data, error } = await supabase.rpc("sync_document_type_fields", { p_document_type_id: selected.id });
    if (error) { message.error(error.message); return; }
    await loadFields(selected.id);
    message.success(t('documentTypes.syncedDbFieldCount', { count: Number(data || 0) }));
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
    message.success(t('documentTypes.fieldSaved'));
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
    { title: t('documentTypes.order'), width: 70, render: (_: unknown, _field: DocumentField, index: number) => <Space><Button type="text" size="small" icon={<ArrowUpOutlined />} disabled={!index} onClick={() => void moveField(index, -1)} /><Button type="text" size="small" icon={<ArrowDownOutlined />} disabled={index === fields.length - 1} onClick={() => void moveField(index, 1)} /></Space> },
    { title: t('documentTypes.fieldName'), dataIndex: 'field_name', width: 150 },
    { title: t('documentTypes.label'), dataIndex: 'label', width: 140 },
    { title: t('common.type'), dataIndex: 'field_type', width: 110, render: (value: string) => <Tag>{value}</Tag> },
    { title: t('documentTypes.attributes'), render: (_: unknown, field: DocumentField) => <Space>{field.is_required && <Tag color="red">{t('documentTypes.required')}</Tag>}{field.is_read_only && <Tag>{t('documentTypes.readOnly')}</Tag>}{field.in_list_view && <Tag color="blue">{t('documentTypes.list')}</Tag>}</Space> },
    { title: t('common.actions'), width: 130, render: (_: unknown, field: DocumentField) => <Space><Button type="link" icon={<EditOutlined />} onClick={() => { setEditingField(field); fieldForm.setFieldsValue(field); setFieldOpen(true); }}>{t('common.edit')}</Button><Button type="link" danger icon={<DeleteOutlined />} onClick={() => void removeField(field)} /></Space> },
  ], [fields, fieldForm, t]);

  return (
    <Card className="mainContent" variant="borderless" title="DocType Builder" extra={<Button type="primary" icon={<PlusOutlined />} onClick={() => openDocument()}>{t('documentTypes.newDocType')}</Button>}>
      <Table rowKey="id" loading={loading} dataSource={documents} onRow={(record) => ({ onClick: () => openDocument(record) })} columns={[
        { title: t('documentTypes.documentType'), dataIndex: "document_type" },
        { title: t('common.name'), dataIndex: "document_name" },
        { title: t('documentTypes.module'), dataIndex: "module_code" },
        { title: t('documentTypes.businessTable'), dataIndex: "table_name" },
        { title: t('common.status'), dataIndex: "status", render: (value: string) => <Tag color={value === "1" ? "green" : "default"}>{value === "1" ? t('common.enabled') : t('documentTypes.inactive')}</Tag> },
      ] as ColumnsType<DocumentType>} />
      <Drawer title={selected ? t('documentTypes.editDocType', { name: selected.document_name }) : t('documentTypes.newDocType')} width="94%" open={drawerOpen} onClose={() => setDrawerOpen(false)} extra={<Button type="primary" icon={<SaveOutlined />} onClick={() => void saveDocument()}>{t('common.save')}</Button>}>
        <Splitter style={{ height: "calc(100vh - 150px)" }}>
          <Splitter.Panel defaultSize="34%" min="28%">
            <Card size="small" title={t('documentTypes.docTypeAttributes')}>
              <Form form={documentForm} layout="vertical">
                <Row gutter={12}><Col span={12}><Form.Item name="document_type" label={t('documentTypes.typeCode')} rules={[{ required: true }]}><Input disabled={!!selected} /></Form.Item></Col><Col span={12}><Form.Item name="document_name" label={t('common.name')} rules={[{ required: true }]}><Input /></Form.Item></Col></Row>
                <Row gutter={12}><Col span={12}><Form.Item name="module_code" label={t('documentTypes.module')}><Input /></Form.Item></Col><Col span={12}><Form.Item name="table_name" label={t('documentTypes.businessTable')}><Input /></Form.Item></Col></Row>
                <Form.Item name="route_path" label={t('documentTypes.route')}><Input /></Form.Item>
                <Form.Item name="primary_key_field" label={t('documentTypes.primaryKeyField')}><Input /></Form.Item>
                <Form.Item name="naming_rule" label={t('documentTypes.namingRule')}><Input placeholder="PO{YYYY}{####}" /></Form.Item>
                <Row gutter={12}><Col span={12}><Form.Item name="is_submittable" label={t('documentTypes.submittable')} valuePropName="checked"><Switch /></Form.Item></Col><Col span={12}><Form.Item name="quick_entry" label={t('documentTypes.quickEntry')} valuePropName="checked"><Switch /></Form.Item></Col></Row>
                <Row gutter={12}><Col span={12}><Form.Item name="track_changes" label={t('documentTypes.trackChanges')} valuePropName="checked"><Switch /></Form.Item></Col><Col span={12}><Form.Item name="status" label={t('common.status')}><Select options={[{ label: t('common.enabled'), value: "1" }, { label: t('documentTypes.inactive'), value: "0" }]} /></Form.Item></Col></Row>
              </Form>
            </Card>
          </Splitter.Panel>
          <Splitter.Panel>
            <Card size="small" title={t('documentTypes.fieldDefinitions')} extra={<Space><Button icon={<SaveOutlined />} disabled={!selected} onClick={() => void syncDatabaseFields()}>{t('documentTypes.syncDatabaseFields')}</Button><Button type="primary" icon={<PlusOutlined />} disabled={!selected} onClick={() => { setEditingField(null); fieldForm.resetFields(); fieldForm.setFieldsValue({ field_type: "Data", column_index: 1, sort_order: fields.length + 1 }); setFieldOpen(true); }}>{t('documentTypes.newField')}</Button></Space>}>
              <Table size="small" rowKey="id" dataSource={fields} columns={fieldColumns} pagination={false} />
            </Card>
          </Splitter.Panel>
        </Splitter>
        <Drawer title={editingField ? t('documentTypes.editField') : t('documentTypes.newField')} width={560} open={fieldOpen} onClose={() => setFieldOpen(false)} extra={<Button type="primary" onClick={() => void saveField()}>{t('documentTypes.saveField')}</Button>}>
          <Form form={fieldForm} layout="vertical">
            <Row gutter={12}><Col span={12}><Form.Item name="field_name" label={t('documentTypes.fieldName')} rules={[{ required: true }]}><Input /></Form.Item></Col><Col span={12}><Form.Item name="label" label={t('documentTypes.label')} rules={[{ required: true }]}><Input /></Form.Item></Col></Row>
            <Row gutter={12}><Col span={12}><Form.Item name="field_type" label={t('documentTypes.fieldType')} rules={[{ required: true }]}><Select options={FIELD_TYPES.map((value) => ({ label: value, value }))} /></Form.Item></Col><Col span={12}><Form.Item name="options" label={t('documentTypes.options')}><Input /></Form.Item></Col></Row>
            <Form.Item name="default_value" label={t('documentTypes.defaultValue')}><Input /></Form.Item>
            <Row gutter={12}><Col span={8}><Form.Item name="is_required" label={t('documentTypes.required')} valuePropName="checked"><Switch /></Form.Item></Col><Col span={8}><Form.Item name="is_read_only" label={t('documentTypes.readOnly')} valuePropName="checked"><Switch /></Form.Item></Col><Col span={8}><Form.Item name="is_hidden" label={t('documentTypes.hidden')} valuePropName="checked"><Switch /></Form.Item></Col></Row>
            <Row gutter={12}><Col span={8}><Form.Item name="in_list_view" label={t('documentTypes.listDisplay')} valuePropName="checked"><Switch /></Form.Item></Col><Col span={8}><Form.Item name="in_standard_filter" label={t('documentTypes.standardFilter')} valuePropName="checked"><Switch /></Form.Item></Col><Col span={8}><Form.Item name="in_global_search" label={t('documentTypes.globalSearch')} valuePropName="checked"><Switch /></Form.Item></Col></Row>
            <Row gutter={12}><Col span={8}><Form.Item name="length" label={t('documentTypes.length')}><InputNumber min={1} style={{ width: "100%" }} /></Form.Item></Col><Col span={8}><Form.Item name="precision" label={t('documentTypes.precision')}><InputNumber min={0} style={{ width: "100%" }} /></Form.Item></Col><Col span={8}><Form.Item name="scale" label={t('documentTypes.decimalPlaces')}><InputNumber min={0} style={{ width: "100%" }} /></Form.Item></Col></Row>
            <Form.Item name="description" label={t('documentTypes.description')}><Input.TextArea rows={3} /></Form.Item>
          </Form>
        </Drawer>
      </Drawer>
    </Card>
  );
}
export default DocumentTypeBuilder;
