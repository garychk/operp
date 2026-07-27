import { useEffect, useState } from 'react';
import { Button, Input, Table, Tag, Modal, Form, Select, Space, Card, message, InputNumber, DatePicker, Row, Col } from 'antd';
import dayjs from 'dayjs';
import { PlusOutlined, SearchOutlined, DeleteOutlined, EditOutlined } from '@ant-design/icons';
import { supabase } from '../../utils/supabase';
import { logWithTiming } from '../../utils/logger';
import type { Tables } from '../../utils/supabase';
import SupaModal from '../../components/SupaModal';
import { useTranslation } from 'react-i18next';

type Payable = Tables['erp_payables_s_539dcf81_b']['Row'];
type Supplier = Tables['erp_suppliers_s_539dcf81_b']['Row'];

const { Option } = Select;

export function Payables() {
  const { t } = useTranslation();
  const [payables, setPayables] = useState<Payable[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingPayable, setEditingPayable] = useState<Payable | null>(null);
  const [form] = Form.useForm();

  useEffect(() => {
    fetchPayables();
    fetchSuppliers();
  }, []);

  const fetchPayables = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from('erp_payables_s_539dcf81_b')
        .select('*')
        .eq('is_deleted', 'n')
        .order('doc_date', { ascending: false });

      if (error) throw error;
      setPayables(data || []);
    } catch (error) {
      console.error('Error fetching payables:', error);
      message.error(t('common.fetchFailed'));
    } finally {
      setLoading(false);
    }
  };

  const fetchSuppliers = async () => {
    try {
      const { data, error } = await supabase
        .from('erp_suppliers_s_539dcf81_b')
        .select('*')
        .eq('is_deleted', 'n')
        .eq('status', 'active');
      if (error) throw error;
      setSuppliers(data || []);
    } catch (error) {
      console.error('Error fetching suppliers:', error);
    }
  };

  const handleSubmit = async (values: any) => {
    try {
      if (editingPayable) {
        await logWithTiming(t('payables.log.updateAction'), 'UPDATE', async () => {
          const { error } = await supabase
            .from('erp_payables_s_539dcf81_b')
            .update(values)
            .eq('id', editingPayable.id);
          if (error) throw error;
        });
        message.success(t('common.updateSuccess'));
      } else {
        await logWithTiming(t('payables.log.createAction'), 'INSERT', async () => {
          const { error } = await supabase
            .from('erp_payables_s_539dcf81_b')
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
      setEditingPayable(null);
      fetchPayables();
    } catch (error) {
      console.error('Error saving payable:', error);
      message.error(t('common.saveFailed'));
    }
  };

  const handleEdit = (record: Payable) => {
    setEditingPayable(record);
    const formValues = { ...record };
    if (formValues.doc_date) {
      formValues.doc_date = dayjs(formValues.doc_date);
    }
    if (formValues.due_date) {
      formValues.due_date = dayjs(formValues.due_date);
    }
    form.setFieldsValue(formValues);
    setIsModalOpen(true);
  };

  const handleDelete = async (id: number) => {
    Modal.confirm({
      title: t('common.confirmDelete'),
      content: t('payables.confirm.deleteContent'),
      onOk: async () => {
        try {
          await logWithTiming(t('payables.log.deleteAction'), 'DELETE', async () => {
            const { error } = await supabase
              .from('erp_payables_s_539dcf81_b')
              .update({ is_deleted: 'y' })
              .eq('id', id);
            if (error) throw error;
          });
          message.success(t('common.deleteSuccess'));
          fetchPayables();
        } catch (error) {
          console.error('Error deleting payable:', error);
          message.error(t('common.deleteFailed'));
        }
      },
    });
  };

  const handleAdd = () => {
    setEditingPayable(null);
    form.setFieldsValue({
      supplier_id: undefined,
      doc_type: 'invoice',
      doc_no: '',
      doc_date: dayjs(),
      due_date: '',
      amount: 0,
      remark: '',
    });
    setIsModalOpen(true);
  };

  const getSupplierName = (supplierId: number | null) => {
    const supplier = suppliers.find((s) => s.id === supplierId);
    return supplier?.name || '-';
  };

  const filteredPayables = payables.filter(
    (p) =>
      p.doc_no.toLowerCase().includes(searchTerm.toLowerCase()) ||
      getSupplierName(p.supplier_id).toLowerCase().includes(searchTerm.toLowerCase())
  );

  const statusLabels: Record<string, { textKey: string; color: string }> = {
    open: { textKey: 'payables.statusOptions.open', color: 'warning' },
    partially_paid: { textKey: 'payables.statusOptions.partially_paid', color: 'processing' },
    closed: { textKey: 'payables.statusOptions.closed', color: 'success' },
    overdue: { textKey: 'payables.statusOptions.overdue', color: 'error' },
  };

  const columns = [
    {
      title: t('payables.docNo'),
      dataIndex: 'doc_no',
      key: 'doc_no',
    },
    {
      title: t('payables.supplier'),
      dataIndex: 'supplier_id',
      key: 'supplier_id',
      render: (supplierId: number) => getSupplierName(supplierId),
    },
    {
      title: t('payables.docDate'),
      dataIndex: 'doc_date',
      key: 'doc_date',
    },
    {
      title: t('payables.dueDate'),
      dataIndex: 'due_date',
      key: 'due_date',
      render: (text: string) => text || '-',
    },
    {
      title: t('payables.amount'),
      dataIndex: 'amount',
      key: 'amount',
      render: (amount: number) => `¥${(amount ?? 0).toLocaleString()}`,
    },
    {
      title: t('payables.balance'),
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
      render: (_: any, record: Payable) => (
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
    <Card className='mainContent' variant="borderless" title={t('payables.title')} extra={
      <Space>
        <Input
          placeholder={t('payables.searchPlaceholder')}
          prefix={<SearchOutlined />}
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
        />
        <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>{t('payables.addPayable')}</Button>
      </Space>
    }>
      <Table
        columns={columns}
        dataSource={filteredPayables}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 10 }}
      />

      <SupaModal
        title={editingPayable ? t('payables.editPayable') : t('payables.addPayable')}
        open={isModalOpen}
        width={800}
        height={440}
        onCancel={() => {
          setIsModalOpen(false);
          form.resetFields();
          setEditingPayable(null);
        }}
        footer={<Space>
          <Button onClick={() => setIsModalOpen(false)}>{t('common.cancel')}</Button>
          <Button type="primary" onClick={() => form.submit()}>
            {t('common.save')}
          </Button>
        </Space>}
      >
        <Card>
          <Form form={form} layout="vertical" onFinish={handleSubmit} style={{ marginRight: 16 }}>
            <Row gutter={16}>
              <Col span={12}>
                <Form.Item
                  label={t('payables.supplier')}
                  name="supplier_id"
                  rules={[{ required: true, message: t('payables.supplierRequired') }]}
                >
                  <Select placeholder={t('payables.supplierPlaceholder')}>
                    {suppliers.map((s) => (
                      <Option key={s.id} value={s.id}>{s.name}</Option>
                    ))}
                  </Select>
                </Form.Item>
                <Form.Item label={t('payables.docType')} name="doc_type" initialValue="invoice">
                  <Select>
                    <Option value="invoice">{t('payables.typeOptions.invoice')}</Option>
                    <Option value="order">{t('payables.typeOptions.order')}</Option>
                    <Option value="other">{t('payables.typeOptions.other')}</Option>
                  </Select>
                </Form.Item>
                <Form.Item
                  label={t('payables.docNo')}
                  name="doc_no"
                  rules={[{ required: true, message: t('payables.docNoRequired') }]}
                >
                  <Input placeholder={t('payables.docNoPlaceholder')} disabled={!!editingPayable} />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  label={t('payables.docDate')}
                  name="doc_date"
                  rules={[{ required: true, message: t('payables.docDateRequired') }]}
                >
                  <DatePicker style={{ width: '100%' }} />
                </Form.Item>
                <Form.Item label={t('payables.dueDate')} name="due_date">
                  <DatePicker style={{ width: '100%' }} />
                </Form.Item>
                <Form.Item
                  label={t('payables.amount')}
                  name="amount"
                  rules={[{ required: true, message: t('payables.amountRequired') }]}
                  initialValue={0}
                >
                  <InputNumber style={{ width: '100%' }} placeholder={t('payables.amountPlaceholder')} />
                </Form.Item>
              </Col>
            </Row>
            <Form.Item label={t('payables.remark')} name="remark">
              <Input.TextArea rows={3} placeholder={t('payables.remarkPlaceholder')} />
            </Form.Item>
          </Form>
        </Card>
      </SupaModal>
    </Card>
  );
}
