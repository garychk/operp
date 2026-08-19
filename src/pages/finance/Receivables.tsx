import { useEffect, useState } from 'react';
import type { Key } from 'react';
import { Button, Input, Tag, Modal, Form, Select, Space, message, InputNumber, DatePicker, Row, Col } from 'antd';
import { PlusOutlined, DeleteOutlined, EditOutlined } from '@ant-design/icons';
import { supabase } from '../../utils/supabase';
import { logWithTiming } from '../../utils/logger';
import { generateIdempotencyKey } from '../../utils/uuid';
import type { Tables } from '../../utils/supabase';
import { SuperTable } from '../../components/SuperTable';
import dayjs from 'dayjs';
import { SupaModal } from '../../components/SupaModal';
import { useTranslation } from 'react-i18next';

type Receivable = Tables['erp_receivables_s_539dcf81_b']['Row'];
type Customer = Tables['erp_customers_s_539dcf81_b']['Row'];

const { Option } = Select;
const tableName = 'erp_receivables_s_539dcf81_b';

export function Receivables() {
  const { t } = useTranslation();
  const [receivables, setReceivables] = useState<Receivable[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedRowKeys, setSelectedRowKeys] = useState<Key[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingReceivable, setEditingReceivable] = useState<Receivable | null>(null);
  const [form] = Form.useForm();
  const [openPeriodId, setOpenPeriodId] = useState<number>();

  const fetchOpenPeriod = async () => {
    const { data } = await supabase.from('erp_accounting_periods_s_539dcf81_b').select('id').eq('is_deleted', 'n').eq('is_enabled', true).eq('is_closed', false).eq('is_locked', false).order('year', { ascending: false }).order('month', { ascending: false }).limit(1).maybeSingle();
    setOpenPeriodId(data?.id);
  };

  useEffect(() => {
    fetchReceivables();
    fetchCustomers();
    fetchOpenPeriod();
  }, []);

  const fetchReceivables = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from(tableName)
        .select('*')
        .eq('is_deleted', 'n')
        .order('doc_date', { ascending: false });

      if (error) throw error;
      setReceivables(data || []);
    } catch (error) {
      console.error('Error fetching receivables:', error);
      message.error(t('common.fetchFailed'));
    } finally {
      setLoading(false);
    }
  };

  const fetchCustomers = async () => {
    try {
      const { data, error } = await supabase
        .from('erp_customers_s_539dcf81_b')
        .select('*')
        .eq('is_deleted', 'n')
        .eq('status', 'active');
      if (error) throw error;
      setCustomers(data || []);
    } catch (error) {
      console.error('Error fetching customers:', error);
    }
  };

  const handleSubmit = async (values: any) => {
    try {
      if (editingReceivable) {
        await logWithTiming(t('receivables.log.updateAction'), 'UPDATE', async () => {
          const { error } = await supabase
            .from(tableName)
            .update(values)
            .eq('id', editingReceivable.id);
          if (error) throw error;
        });
        message.success(t('common.updateSuccess'));
      } else {
        await logWithTiming(t('receivables.log.createAction'), 'INSERT', async () => {
          const { error } = await supabase
            .from(tableName)
            .insert([{
              ...values,
              balance: values.amount,
            }]);
          if (error) throw error;
        });
        message.success(t('common.createSuccess'));
      }
      setIsModalOpen(false);
      form.resetFields();
      setEditingReceivable(null);
      fetchReceivables();
    } catch (error) {
      console.error('Error saving receivable:', error);
      message.error(t('common.saveFailed'));
    }
  };

  const handleEdit = (record: Receivable) => {
    setEditingReceivable(record);
    form.setFieldsValue({
      ...record,
      doc_date: dayjs(record.doc_date),
      due_date: dayjs(record.due_date),
    });
    setIsModalOpen(true);
  };

  const handleSettle = (record: Receivable) => {
    let amount = Number(record.balance || 0);
    Modal.confirm({
      title: '应收核销',
      content: <InputNumber min={0.01} max={Number(record.balance || 0)} defaultValue={amount} onChange={(value) => { amount = Number(value || 0); }} style={{ width: '100%' }} />,
      okButtonProps: { disabled: !openPeriodId },
      onOk: async () => {
        if (!openPeriodId || amount <= 0) throw new Error('没有可用期间或核销金额无效');
        const { error } = await supabase.rpc('settle_ar_ap', { p_settlement_type: 'receivable', p_source_id: record.id, p_period_id: openPeriodId, p_amount: amount, p_settlement_date: new Date().toISOString().slice(0, 10), p_remark: null, p_idempotency_key: generateIdempotencyKey() });
        if (error) throw error;
        message.success('应收核销成功');
        fetchReceivables();
      },
    });
  };


  const handleSelectedSettle = () => {
    if (selectedRowKeys.length !== 1) {
      message.warning('请先选择一条应收账款进行核销');
      return;
    }
    const record = receivables.find((item) => item.id === Number(selectedRowKeys[0]));
    if (record) handleSettle(record);
  };

  const handleDelete = async (id: number) => {
    Modal.confirm({
      title: t('common.confirmDelete'),
      content: t('receivables.confirm.deleteContent'),
      onOk: async () => {
        try {
          await logWithTiming(t('receivables.log.deleteAction'), 'DELETE', async () => {
            const { error } = await supabase
              .from(tableName)
              .update({ is_deleted: 'y' })
              .eq('id', id);
            if (error) throw error;
          });
          message.success(t('common.deleteSuccess'));
          fetchReceivables();
        } catch (error) {
          console.error('Error deleting receivable:', error);
          message.error(t('common.deleteFailed'));
        }
      },
    });
  };

  const handleAdd = () => {
    setEditingReceivable(null);
    form.setFieldsValue({
      customer_id: undefined,
      doc_type: 'invoice',
      doc_no: '',
      doc_date: dayjs(new Date()),
      due_date: '',
      amount: 0,
      remark: '',
    });
    setIsModalOpen(true);
  };

  const getCustomerName = (customerId: number | null) => {
    const customer = customers.find((c) => c.id === customerId);
    return customer?.name || '-';
  };

  const filteredReceivables = receivables.filter(
    (r) =>
      r.doc_no.toLowerCase().includes(searchTerm.toLowerCase()) ||
      getCustomerName(r.customer_id).toLowerCase().includes(searchTerm.toLowerCase())
  );

  const statusLabels: Record<string, { textKey: string; color: string }> = {
    open: { textKey: 'receivables.statusOptions.open', color: 'warning' },
    partially_paid: { textKey: 'receivables.statusOptions.partially_paid', color: 'processing' },
    closed: { textKey: 'receivables.statusOptions.closed', color: 'success' },
    overdue: { textKey: 'receivables.statusOptions.overdue', color: 'error' },
  };

  const columns = [
    {
      title: t('receivables.docNo'),
      dataIndex: 'doc_no',
      key: 'doc_no',
    },
    {
      title: t('receivables.customer'),
      dataIndex: 'customer_id',
      key: 'customer_id',
      render: (customerId: number) => getCustomerName(customerId),
    },
    {
      title: t('receivables.docDate'),
      dataIndex: 'doc_date',
      key: 'doc_date',
    },
    {
      title: t('receivables.dueDate'),
      dataIndex: 'due_date',
      key: 'due_date',
      render: (text: string) => text || '-',
    },
    {
      title: t('receivables.amount'),
      dataIndex: 'amount',
      key: 'amount',
      render: (amount: number) => `¥${(amount ?? 0).toLocaleString()}`,
    },
    {
      title: t('receivables.balance'),
      dataIndex: 'balance',
      key: 'balance',
      render: (balance: number) => `¥${(balance ?? 0).toLocaleString()}`,
    },
    {
      title: t('common.status'),
      dataIndex: 'status',
      key: 'status',
      render: (status: string) => {
        const config = statusLabels[status] || { textKey: status, color: 'default' };
        return <Tag color={config.color}>{t(config.textKey)}</Tag>;
      },
    },
    {
      title: t('common.actions'),
      key: 'action',
      render: (_: any, record: Receivable) => (
        <Space size="middle">
          <Button type="text" icon={<EditOutlined />} onClick={() => handleEdit(record)}>
            {t('common.edit')}
          </Button>
          <Button type="text" danger icon={<DeleteOutlined />} onClick={() => handleDelete(record.id)}>
            {t('common.delete')}
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <div className="mainContent">
      <SuperTable
        columns={columns}
        dataSource={filteredReceivables}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 10 }}
        storageKey="receivables"
        headerTitle={t('receivables.title')}
        rowSelection={{
          selectedRowKeys,
          onChange: setSelectedRowKeys,
        }}
        queryBar={
          <Space wrap>
            <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>{t('receivables.addReceivable')}</Button>
            <Button onClick={handleSelectedSettle} disabled={!openPeriodId || selectedRowKeys.length !== 1}>核销</Button>
            <Input.Search
              allowClear
              placeholder={t('receivables.searchPlaceholder')}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              onSearch={fetchReceivables}
              style={{ width: 240 }}
            />
          </Space>
        }
      />
      <SupaModal
        title={editingReceivable ? t('receivables.editReceivable') : t('receivables.addReceivable')}
        open={isModalOpen}
        width={800}
        height={440}
        onCancel={() => {
          setIsModalOpen(false);
          form.resetFields();
          setEditingReceivable(null);
        }}
        footer={<Space>
          <Button onClick={() => setIsModalOpen(false)}>{t('common.cancel')}</Button>
          <Button type="primary" onClick={() => form.submit()}>
            {t('common.save')}
          </Button>
        </Space>}
        historyTable={tableName}
      >
        <Form form={form} layout="vertical" onFinish={handleSubmit} style={{ padding: '0 16px 0 0' }}>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                label={t('receivables.customer')}
                name="customer_id"
                rules={[{ required: true, message: t('receivables.customerRequired') }]}
              >
                <Select placeholder={t('receivables.customerPlaceholder')}>
                  {customers.map((c) => (
                    <Option key={c.id} value={c.id}>{c.name}</Option>
                  ))}
                </Select>
              </Form.Item>
              <Form.Item label={t('receivables.docType')} name="doc_type" initialValue="invoice">
                <Select>
                  <Option value="invoice">{t('receivables.typeOptions.invoice')}</Option>
                  <Option value="order">{t('receivables.typeOptions.order')}</Option>
                  <Option value="other">{t('receivables.typeOptions.other')}</Option>
                </Select>
              </Form.Item>
              <Form.Item
                label={t('receivables.docNo')}
                name="doc_no"
                rules={[{ required: true, message: t('receivables.docNoRequired') }]}
              >
                <Input placeholder={t('receivables.docNoPlaceholder')} disabled={!!editingReceivable} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                label={t('receivables.docDate')}
                name="doc_date"
                rules={[{ required: true, message: t('receivables.docDateRequired') }]}
              >
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item label={t('receivables.dueDate')} name="due_date">
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item
                label={t('receivables.amount')}
                name="amount"
                rules={[{ required: true, message: t('receivables.amountRequired') }]}
                initialValue={0}
              >
                <InputNumber style={{ width: '100%' }} placeholder={t('receivables.amountPlaceholder')} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item label={t('receivables.remark')} name="remark">
            <Input.TextArea rows={3} placeholder={t('receivables.remarkPlaceholder')} />
          </Form.Item>
        </Form>
      </SupaModal>
    </div>
  );
}
