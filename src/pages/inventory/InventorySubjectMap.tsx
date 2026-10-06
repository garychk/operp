import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Card, Form, Input, Modal, Select, Space, Switch, Table, Tabs, Tag, message } from 'antd';
import { EditOutlined, ReloadOutlined, UndoOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { supabase } from '../../utils/supabase';
import type { Tables } from '../../utils/supabase';
import { SuperTable } from '../../components/SuperTable';
import SimpleModal from '../../components/SimpleModal';

/**
 * 库存科目映射配置（P1-9c）。
 *
 * 两个页签回答两个不同的问题：
 *   ① **生效口径**（`vw_erp_inventory_voucher_plan`，只读）— 当前租户每类库存业务
 *      过账时**实际**会走哪两个科目、要不要出凭证。它已经把「租户覆盖」与「内置默认」
 *      统一解析好，并用 `is_override` 标出这一行是覆盖还是默认。
 *   ② **覆盖配置**（`erp_inventory_subject_map_s_539dcf81_b`）— 租户自己写的那几行。
 *
 * 为什么两页都要有：只给配置表，用户看不到「没配的行会怎样」；只给生效口径，
 * 用户不知道哪几行是自己配的、删了会回落到什么。两者并排才解释得清。
 *
 * 写入注意（踩过的坑）：
 *   · 唯一索引 `uq_erp_inventory_subject_map_tenant_code` 是**部分索引**
 *     （`WHERE is_deleted='n'`），PostgREST 的 `upsert(on_conflict)` 认不出部分索引，
 *     所以这里走「先查后 update / insert」，不要图省事用 upsert。
 *   · 写库**显式带 tenant_id**（取自生效口径行的 tenant_id，即当前租户）。
 *   · 「恢复默认」= 软删覆盖行，而不是写一行空科目 —— 空科目会被当值用，直接害过账。
 */

type SubjectMapRow = Tables['erp_inventory_subject_map_s_539dcf81_b']['Row'];
type AccountSubject = Tables['erp_account_subjects_s_539dcf81_b']['Row'];

type PlanRow = {
  tenant_id: number;
  source_type: string;
  transaction_type_code: string;
  transaction_type_name: string | null;
  direction: string | null;
  stock_subject_code: string | null;
  counter_subject_code: string | null;
  generate_voucher: boolean;
  is_override: boolean;
};

const { Option } = Select;

/** 库存业务的来源单据类型（与 post_*_document 的 p_document_type 一致） */
const SOURCE_TYPES = [
  'purchase_receipt',
  'purchase_return',
  'sales_delivery',
  'sales_return',
  'material_issue',
  'material_return',
  'production_receipt',
  'stock_count',
  'stock_adjustment',
  'inventory_transfer',
] as const;

export function InventorySubjectMap() {
  const { t } = useTranslation();
  const [plan, setPlan] = useState<PlanRow[]>([]);
  const [overrides, setOverrides] = useState<SubjectMapRow[]>([]);
  const [subjects, setSubjects] = useState<AccountSubject[]>([]);
  const [loading, setLoading] = useState(true);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingPlan, setEditingPlan] = useState<PlanRow | null>(null);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [form] = Form.useForm();
  const [createForm] = Form.useForm();

  const fetchPlan = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('vw_erp_inventory_voucher_plan' as any)
        .select('*')
        .order('source_type', { ascending: true })
        .order('transaction_type_code', { ascending: true });
      if (error) throw error;
      setPlan((data || []) as PlanRow[]);
    } catch (error) {
      console.error('Error fetching inventory voucher plan:', error);
      message.error(t('common.fetchFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  const fetchOverrides = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('erp_inventory_subject_map_s_539dcf81_b')
        .select('*')
        .eq('is_deleted', 'n');
      if (error) throw error;
      setOverrides((data || []) as SubjectMapRow[]);
    } catch (error) {
      console.error('Error fetching subject map overrides:', error);
    }
  }, []);

  const fetchSubjects = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('erp_account_subjects_s_539dcf81_b')
        .select('*')
        .eq('is_deleted', 'n')
        .order('code');
      if (error) throw error;
      setSubjects((data || []) as AccountSubject[]);
    } catch (error) {
      console.error('Error fetching account subjects:', error);
    }
  }, []);

  useEffect(() => {
    fetchPlan();
    fetchOverrides();
    fetchSubjects();
  }, [fetchPlan, fetchOverrides, fetchSubjects]);

  const overrideByKey = useMemo(() => {
    const m = new Map<string, SubjectMapRow>();
    for (const o of overrides) m.set(`${o.source_type}::${o.transaction_type_code}`, o);
    return m;
  }, [overrides]);

  const subjectLabel = (code: string | null) => {
    if (!code) return '-';
    const s = subjects.find((x) => x.code === code);
    return s ? `${code} ${s.name}` : code;
  };

  // ------------------------------------------------------------ 覆盖：保存 / 恢复默认
  const handleEdit = (row: PlanRow) => {
    setEditingPlan(row);
    form.setFieldsValue({
      source_type: row.source_type,
      transaction_type_code: row.transaction_type_code,
      stock_subject_code: row.stock_subject_code ?? undefined,
      counter_subject_code: row.counter_subject_code ?? undefined,
      generate_voucher: row.generate_voucher,
      remark: overrideByKey.get(`${row.source_type}::${row.transaction_type_code}`)?.remark ?? '',
    });
    setIsModalOpen(true);
  };

  /** 先查后写：部分唯一索引让 upsert(on_conflict) 不可用，别改成 upsert。 */
  const saveOverride = async (values: any) => {
    if (!editingPlan) return;
    const key = `${editingPlan.source_type}::${editingPlan.transaction_type_code}`;
    const existing = overrideByKey.get(key);
    const payload = {
      tenant_id: editingPlan.tenant_id,
      source_type: editingPlan.source_type,
      transaction_type_code: editingPlan.transaction_type_code,
      stock_subject_code: values.stock_subject_code ?? null,
      counter_subject_code: values.counter_subject_code ?? null,
      generate_voucher: !!values.generate_voucher,
      remark: values.remark || null,
    };
    try {
      if (existing) {
        const { error } = await supabase
          .from('erp_inventory_subject_map_s_539dcf81_b')
          .update(payload)
          .eq('id', existing.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from('erp_inventory_subject_map_s_539dcf81_b').insert([payload]);
        if (error) throw error;
      }
      message.success(existing ? t('common.updateSuccess') : t('common.createSuccess'));
      setIsModalOpen(false);
      await Promise.all([fetchPlan(), fetchOverrides()]);
    } catch (error: any) {
      console.error('Error saving subject map override:', error);
      message.error(error?.message || t('common.saveFailed'));
    }
  };

  const restoreDefault = (row: PlanRow) => {
    const existing = overrideByKey.get(`${row.source_type}::${row.transaction_type_code}`);
    if (!existing) {
      message.info(t('inventorySubjectMap.alreadyDefault'));
      return;
    }
    Modal.confirm({
      title: t('inventorySubjectMap.restoreConfirmTitle'),
      content: t('inventorySubjectMap.restoreConfirmContent', {
        type: `${row.source_type} / ${row.transaction_type_code}`,
      }),
      okText: t('common.continue'),
      cancelText: t('common.cancel'),
      onOk: async () => {
        try {
          // 软删覆盖行 → 回落到内置默认；不要写空科目（空值会被当值用）
          const { error } = await supabase
            .from('erp_inventory_subject_map_s_539dcf81_b')
            .update({ is_deleted: 'y' })
            .eq('id', existing.id);
          if (error) throw error;
          message.success(t('inventorySubjectMap.restoreSuccess'));
          await Promise.all([fetchPlan(), fetchOverrides()]);
        } catch (error: any) {
          console.error('Error restoring default:', error);
          message.error(error?.message || t('common.saveFailed'));
        }
      },
    });
  };

  const handleCreate = async (values: any) => {
    try {
      const { error } = await supabase.from('erp_inventory_subject_map_s_539dcf81_b').insert([
        {
          source_type: values.source_type,
          transaction_type_code: values.transaction_type_code,
          stock_subject_code: values.stock_subject_code ?? null,
          counter_subject_code: values.counter_subject_code ?? null,
          generate_voucher: !!values.generate_voucher,
          remark: values.remark || null,
        },
      ]);
      if (error) throw error;
      message.success(t('common.createSuccess'));
      setIsCreateOpen(false);
      createForm.resetFields();
      await Promise.all([fetchPlan(), fetchOverrides()]);
    } catch (error: any) {
      console.error('Error creating subject map row:', error);
      message.error(error?.message || t('common.saveFailed'));
    }
  };

  const reconStatusTag = (isOverride: boolean) =>
    isOverride ? <Tag color="blue">{t('inventorySubjectMap.tagOverride')}</Tag> : <Tag>{t('inventorySubjectMap.tagDefault')}</Tag>;

  const planColumns = [
    { title: t('inventorySubjectMap.sourceType'), dataIndex: 'source_type', key: 'source_type', width: 170 },
    {
      title: t('inventorySubjectMap.transactionType'),
      dataIndex: 'transaction_type_code',
      key: 'transaction_type_code',
      width: 180,
      render: (code: string, row: PlanRow) => (row.transaction_type_name ? `${code} · ${row.transaction_type_name}` : code),
    },
    { title: t('inventorySubjectMap.origin'), key: 'origin', width: 110, render: (_: unknown, row: PlanRow) => reconStatusTag(row.is_override) },
    {
      title: t('inventorySubjectMap.direction'),
      dataIndex: 'direction',
      key: 'direction',
      width: 90,
      render: (v: string) => t(`inventorySubjectMap.direction.${v || 'neutral'}`),
    },
    {
      title: t('inventorySubjectMap.stockSubject'),
      dataIndex: 'stock_subject_code',
      key: 'stock_subject_code',
      render: (code: string | null) => subjectLabel(code),
    },
    {
      title: t('inventorySubjectMap.counterSubject'),
      dataIndex: 'counter_subject_code',
      key: 'counter_subject_code',
      render: (code: string | null) => subjectLabel(code),
    },
    {
      title: t('inventorySubjectMap.generateVoucher'),
      dataIndex: 'generate_voucher',
      key: 'generate_voucher',
      width: 120,
      render: (v: boolean) => (v ? <Tag color="green">{t('common.yes')}</Tag> : <Tag>{t('common.no')}</Tag>),
    },
    {
      title: t('common.actions'),
      key: 'action',
      width: 200,
      render: (_: unknown, row: PlanRow) => (
        <Space size="small">
          <Button type="text" icon={<EditOutlined />} onClick={() => handleEdit(row)}>
            {t('inventorySubjectMap.override')}
          </Button>
          {row.is_override && (
            <Button type="text" icon={<UndoOutlined />} onClick={() => restoreDefault(row)}>
              {t('inventorySubjectMap.restoreDefault')}
            </Button>
          )}
        </Space>
      ),
    },
  ];

  const overrideColumns = [
    { title: t('inventorySubjectMap.sourceType'), dataIndex: 'source_type', key: 'source_type', width: 170 },
    { title: t('inventorySubjectMap.transactionType'), dataIndex: 'transaction_type_code', key: 'transaction_type_code', width: 180 },
    {
      title: t('inventorySubjectMap.stockSubject'),
      dataIndex: 'stock_subject_code',
      key: 'stock_subject_code',
      render: (code: string | null) => subjectLabel(code),
    },
    {
      title: t('inventorySubjectMap.counterSubject'),
      dataIndex: 'counter_subject_code',
      key: 'counter_subject_code',
      render: (code: string | null) => subjectLabel(code),
    },
    {
      title: t('inventorySubjectMap.generateVoucher'),
      dataIndex: 'generate_voucher',
      key: 'generate_voucher',
      width: 120,
      render: (v: boolean) => (v ? <Tag color="green">{t('common.yes')}</Tag> : <Tag>{t('common.no')}</Tag>),
    },
    { title: t('inventorySubjectMap.remark'), dataIndex: 'remark', key: 'remark', render: (v: string) => v || '-' },
  ];

  const subjectOptions = subjects.map((s) => (
    <Option key={s.code} value={s.code}>
      {s.code} {s.name}
    </Option>
  ));

  const planTab = (
    <>
      <Card size="small" style={{ marginBottom: 12 }}>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={fetchPlan}>
            {t('common.refresh')}
          </Button>
        </Space>
      </Card>
      <SuperTable
        columns={planColumns}
        dataSource={plan}
        rowKey={(r) => `${r.source_type}::${r.transaction_type_code}`}
        loading={loading}
        pagination={{ pageSize: 20 }}
        storageKey="inventory-subject-map-plan"
        toolbarActions={['export']}
        headerTitle={t('inventorySubjectMap.planTitle')}
      />
    </>
  );

  const overrideTab = (
    <>
      <Card size="small" style={{ marginBottom: 12 }}>
        <Space>
          <Button type="primary" onClick={() => setIsCreateOpen(true)}>
            {t('inventorySubjectMap.addOverride')}
          </Button>
          <Button icon={<ReloadOutlined />} onClick={fetchOverrides}>
            {t('common.refresh')}
          </Button>
        </Space>
      </Card>
      <Table
        columns={overrideColumns}
        dataSource={overrides}
        rowKey="id"
        pagination={{ pageSize: 20 }}
        locale={{ emptyText: t('inventorySubjectMap.noOverride') }}
      />
    </>
  );

  return (
    <Card variant="borderless" title={t('inventorySubjectMap.title')}>
      <Tabs
        items={[
          { key: 'plan', label: t('inventorySubjectMap.tabPlan'), children: planTab },
          { key: 'override', label: t('inventorySubjectMap.tabOverride'), children: overrideTab },
        ]}
      />

      <SimpleModal
        title={t('inventorySubjectMap.overrideTitle')}
        open={isModalOpen}
        onCancel={() => {
          setIsModalOpen(false);
          form.resetFields();
          setEditingPlan(null);
        }}
        footer={
          <Space>
            <Button onClick={() => setIsModalOpen(false)}>{t('common.cancel')}</Button>
            <Button type="primary" onClick={() => form.submit()}>
              {t('common.save')}
            </Button>
          </Space>
        }
        width={560}
      >
        <Form form={form} layout="vertical" onFinish={saveOverride} style={{ marginTop: 8 }}>
          <Form.Item label={t('inventorySubjectMap.sourceType')} name="source_type">
            <Input disabled />
          </Form.Item>
          <Form.Item label={t('inventorySubjectMap.transactionType')} name="transaction_type_code">
            <Input disabled />
          </Form.Item>
          <Form.Item label={t('inventorySubjectMap.stockSubject')} name="stock_subject_code">
            <Select allowClear showSearch optionFilterProp="children" placeholder={t('inventorySubjectMap.subjectPlaceholder')}>
              {subjectOptions}
            </Select>
          </Form.Item>
          <Form.Item label={t('inventorySubjectMap.counterSubject')} name="counter_subject_code">
            <Select allowClear showSearch optionFilterProp="children" placeholder={t('inventorySubjectMap.subjectPlaceholder')}>
              {subjectOptions}
            </Select>
          </Form.Item>
          <Form.Item
            label={t('inventorySubjectMap.generateVoucher')}
            name="generate_voucher"
            valuePropName="checked"
            extra={t('inventorySubjectMap.generateVoucherHint')}
          >
            <Switch />
          </Form.Item>
          <Form.Item label={t('inventorySubjectMap.remark')} name="remark">
            <Input placeholder={t('inventorySubjectMap.remarkPrompt')} />
          </Form.Item>
        </Form>
      </SimpleModal>

      <SimpleModal
        title={t('inventorySubjectMap.addOverride')}
        open={isCreateOpen}
        onCancel={() => {
          setIsCreateOpen(false);
          createForm.resetFields();
        }}
        footer={
          <Space>
            <Button onClick={() => setIsCreateOpen(false)}>{t('common.cancel')}</Button>
            <Button type="primary" onClick={() => createForm.submit()}>
              {t('common.save')}
            </Button>
          </Space>
        }
        width={560}
      >
        <Form form={createForm} layout="vertical" onFinish={handleCreate} style={{ marginTop: 8 }}>
          <Form.Item
            label={t('inventorySubjectMap.sourceType')}
            name="source_type"
            rules={[{ required: true, message: t('inventorySubjectMap.sourceTypePrompt') }]}
          >
            <Select showSearch optionFilterProp="children" placeholder={t('inventorySubjectMap.sourceTypePrompt')}>
              {SOURCE_TYPES.map((s) => (
                <Option key={s} value={s}>
                  {s}
                </Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item
            label={t('inventorySubjectMap.transactionType')}
            name="transaction_type_code"
            rules={[{ required: true, message: t('inventorySubjectMap.transactionTypePrompt') }]}
          >
            <Input placeholder="purchase_receipt_in" />
          </Form.Item>
          <Form.Item label={t('inventorySubjectMap.stockSubject')} name="stock_subject_code">
            <Select allowClear showSearch optionFilterProp="children" placeholder={t('inventorySubjectMap.subjectPlaceholder')}>
              {subjectOptions}
            </Select>
          </Form.Item>
          <Form.Item label={t('inventorySubjectMap.counterSubject')} name="counter_subject_code">
            <Select allowClear showSearch optionFilterProp="children" placeholder={t('inventorySubjectMap.subjectPlaceholder')}>
              {subjectOptions}
            </Select>
          </Form.Item>
          <Form.Item label={t('inventorySubjectMap.generateVoucher')} name="generate_voucher" valuePropName="checked" initialValue={true}>
            <Switch />
          </Form.Item>
          <Form.Item label={t('inventorySubjectMap.remark')} name="remark">
            <Input placeholder={t('inventorySubjectMap.remarkPrompt')} />
          </Form.Item>
        </Form>
      </SimpleModal>
    </Card>
  );
}

export default InventorySubjectMap;
