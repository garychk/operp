import { useEffect, useMemo, useState } from 'react';
import { Button, Input, Modal, Select, Space, Tag } from 'antd';
import { DeleteOutlined, PlusOutlined, SettingOutlined } from '@ant-design/icons';
import { supabase } from '../../utils/supabase';

type DocumentField = { field_name: string; label: string; field_type: string; data_type: string | null };
type ConditionRow = { field: string; operator: string; value: string };
type ConditionValue = { logic: 'and' | 'or'; conditions: ConditionRow[] };

const OPERATORS: Record<string, Array<{ label: string; value: string }>> = {
  text: [{ label: '等于', value: '=' }, { label: '不等于', value: '!=' }, { label: '包含', value: 'contains' }, { label: '为空', value: 'is_null' }, { label: '不为空', value: 'is_not_null' }],
  number: [{ label: '等于', value: '=' }, { label: '不等于', value: '!=' }, { label: '大于', value: '>' }, { label: '大于等于', value: '>=' }, { label: '小于', value: '<' }, { label: '小于等于', value: '<=' }, { label: '为空', value: 'is_null' }],
  boolean: [{ label: '是', value: '=' }, { label: '否', value: '!=' }],
  date: [{ label: '等于', value: '=' }, { label: '早于', value: '<' }, { label: '晚于', value: '>' }, { label: '为空', value: 'is_null' }],
};

type Props = { documentType?: string; value?: string; onChange?: (value: string) => void };

function fieldKind(field?: DocumentField) {
  if (!field) return 'text';
  if (['Int', 'Float', 'Currency'].includes(field.field_type) || ['integer', 'bigint', 'numeric', 'decimal'].includes(field.data_type || '')) return 'number';
  if (['Check'].includes(field.field_type) || field.data_type === 'boolean') return 'boolean';
  if (['Date', 'DateTime'].includes(field.field_type) || field.data_type?.startsWith('timestamp') || field.data_type === 'date') return 'date';
  return 'text';
}

function parseValue(value?: string): ConditionValue {
  if (!value) return { logic: 'and', conditions: [{ field: '', operator: '=', value: '' }] };
  try {
    const parsed = JSON.parse(value) as ConditionValue;
    if (parsed && Array.isArray(parsed.conditions)) return { logic: parsed.logic === 'or' ? 'or' : 'and', conditions: parsed.conditions };
  } catch {
    return { logic: 'and', conditions: [{ field: '', operator: '=', value }] };
  }
  return { logic: 'and', conditions: [{ field: '', operator: '=', value: '' }] };
}

export function ConditionEditor({ documentType, value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [fields, setFields] = useState<DocumentField[]>([]);
  const [draft, setDraft] = useState<ConditionValue>(() => parseValue(value));

  useEffect(() => {
    setDraft(parseValue(value));
  }, [value]);

  useEffect(() => {
    if (!documentType) { setFields([]); return; }
    let cancelled = false;
    void supabase.from('sys_document_types').select('id').eq('document_type', documentType).eq('is_deleted', 'n').maybeSingle().then(async ({ data }) => {
      if (!data) return;
      const result = await supabase.from('sys_document_type_fields').select('field_name, label, field_type, data_type').eq('document_type_id', data.id).eq('is_deleted', 'n').eq('status', '1').order('sort_order').order('id');
      if (!cancelled && !result.error) setFields((result.data || []) as DocumentField[]);
    });
    return () => { cancelled = true; };
  }, [documentType]);

  const fieldOptions = fields.map((field) => ({ value: field.field_name, label: `${field.label} (${field.field_name})` }));
  const summary = useMemo(() => {
    const labels = new Map(fields.map((field) => [field.field_name, field.label]));
    return draft.conditions.filter((item) => item.field).map((item) => `${labels.get(item.field) || item.field} ${item.operator} ${item.value}`).join(draft.logic === 'and' ? ' AND ' : ' OR ') || '未配置条件';
  }, [draft, fields]);

  const updateRow = (index: number, patch: Partial<ConditionRow>) => setDraft((current) => ({ ...current, conditions: current.conditions.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row) }));
  const save = () => { onChange?.(JSON.stringify(draft)); setOpen(false); };

  return <>
    <Space direction="vertical" style={{ width: '100%' }}>
      <Input.TextArea value={summary} readOnly autoSize={{ minRows: 2, maxRows: 4 }} />
      <Button icon={<SettingOutlined />} onClick={() => setOpen(true)}>编辑条件</Button>
    </Space>
    <Modal title="条件编辑器" open={open} width={760} onCancel={() => setOpen(false)} onOk={save} okText="确定" cancelText="取消">
      <Space style={{ marginBottom: 16 }}><Tag>当前单据类型：{documentType || '未选择'}</Tag><Select value={draft.logic} options={[{ label: '满足全部条件（AND）', value: 'and' }, { label: '满足任一条件（OR）', value: 'or' }]} onChange={(logic) => setDraft((current) => ({ ...current, logic }))} /></Space>
      <Space direction="vertical" style={{ width: '100%' }}>
        {draft.conditions.map((row, index) => {
          const field = fields.find((item) => item.field_name === row.field);
          const kind = fieldKind(field);
          const operators = OPERATORS[kind];
          const valueDisabled = ['is_null', 'is_not_null'].includes(row.operator);
          return <Space key={`${index}-${row.field}`} style={{ display: 'flex' }} align="start">
            <Select showSearch optionFilterProp="label" placeholder="选择字段" style={{ width: 250 }} value={row.field || undefined} options={fieldOptions} onChange={(fieldName) => updateRow(index, { field: fieldName, operator: '=', value: '' })} />
            <Select placeholder="运算符" style={{ width: 150 }} value={row.operator} options={operators} onChange={(operator) => updateRow(index, { operator, value: ['is_null', 'is_not_null'].includes(operator) ? '' : row.value })} />
            <Input placeholder="值" disabled={valueDisabled} style={{ width: 190 }} value={row.value} onChange={(event) => updateRow(index, { value: event.target.value })} />
            <Button danger type="text" icon={<DeleteOutlined />} disabled={draft.conditions.length === 1} onClick={() => setDraft((current) => ({ ...current, conditions: current.conditions.filter((_, rowIndex) => rowIndex !== index) }))} />
          </Space>;
        })}
        <Button type="dashed" icon={<PlusOutlined />} onClick={() => setDraft((current) => ({ ...current, conditions: [...current.conditions, { field: '', operator: '=', value: '' }] }))}>添加条件</Button>
      </Space>
    </Modal>
  </>;
}

export default ConditionEditor;
