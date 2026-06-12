import { useEffect, useState } from 'react';
import { Button, Input, Table, Tag, Modal, Form, Select, Space, Card, message, InputNumber, DatePicker, Row, Col } from 'antd';
import { PlusOutlined, SearchOutlined, DeleteOutlined, EditOutlined } from '@ant-design/icons';
import { supabase } from '../../utils/supabase';
import { logWithTiming } from '../../utils/logger';
import type { Tables } from '../../utils/supabase';
import dayjs from 'dayjs';
import SupaModal from '../../components/SupaModal';

type Receivable = Tables['erp_receivables_s_539dcf81_b']['Row'];
type Customer = Tables['erp_customers_s_539dcf81_b']['Row'];

const { Option } = Select;
const tableName = 'erp_receivables_s_539dcf81_b';

export function Receivables() {
  const [receivables, setReceivables] = useState<Receivable[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingReceivable, setEditingReceivable] = useState<Receivable | null>(null);
  const [form] = Form.useForm();

  useEffect(() => {
    fetchReceivables();
    fetchCustomers();
  }, []);

  const fetchReceivables = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from('erp_receivables_s_539dcf81_b')
        .select('*')
        .eq('is_deleted', 'n')
        .order('doc_date', { ascending: false });

      if (error) throw error;
      setReceivables(data || []);
    } catch (error) {
      console.error('Error fetching receivables:', error);
      message.error('获取数据失败');
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
        await logWithTiming('更新应收账款', 'UPDATE', async () => {
          const { error } = await supabase
            .from('erp_receivables_s_539dcf81_b')
            .update(values)
            .eq('id', editingReceivable.id);
          if (error) throw error;
        });
        message.success('更新成功');
      } else {
        await logWithTiming('新增应收账款', 'INSERT', async () => {
          const { error } = await supabase
            .from('erp_receivables_s_539dcf81_b')
            .insert([{
              ...values,
              balance: values.amount,
            }]);
          if (error) throw error;
        });
        message.success('新增成功');
      }
      setIsModalOpen(false);
      form.resetFields();
      setEditingReceivable(null);
      fetchReceivables();
    } catch (error) {
      console.error('Error saving receivable:', error);
      message.error('保存失败');
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

  const handleDelete = async (id: number) => {
    Modal.confirm({
      title: '确认删除',
      content: '确定要删除该记录吗？',
      onOk: async () => {
        try {
          await logWithTiming('删除应收账款', 'DELETE', async () => {
            const { error } = await supabase
              .from('erp_receivables_s_539dcf81_b')
              .update({ is_deleted: 'y' })
              .eq('id', id);
            if (error) throw error;
          });
          message.success('删除成功');
          fetchReceivables();
        } catch (error) {
          console.error('Error deleting receivable:', error);
          message.error('删除失败');
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

  const statusLabels: Record<string, { text: string; color: string }> = {
    open: { text: '未结清', color: 'warning' },
    partially_paid: { text: '部分收款', color: 'processing' },
    closed: { text: '已结清', color: 'success' },
    overdue: { text: '逾期', color: 'error' },
  };

  const columns = [
    {
      title: '单据号',
      dataIndex: 'doc_no',
      key: 'doc_no',
    },
    {
      title: '客户',
      dataIndex: 'customer_id',
      key: 'customer_id',
      render: (customerId: number) => getCustomerName(customerId),
    },
    {
      title: '单据日期',
      dataIndex: 'doc_date',
      key: 'doc_date',
    },
    {
      title: '到期日',
      dataIndex: 'due_date',
      key: 'due_date',
      render: (text: string) => text || '-',
    },
    {
      title: '金额',
      dataIndex: 'amount',
      key: 'amount',
      render: (amount: number) => `¥${(amount ?? 0).toLocaleString()}`,
    },
    {
      title: '余额',
      dataIndex: 'balance',
      key: 'balance',
      render: (balance: number) => `¥${(balance ?? 0).toLocaleString()}`,
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      render: (status: string) => {
        const config = statusLabels[status] || { text: status, color: 'default' };
        return <Tag color={config.color}>{config.text}</Tag>;
      },
    },
    {
      title: '操作',
      key: 'action',
      render: (_: any, record: Receivable) => (
        <Space size="middle">
          <Button type="text" icon={<EditOutlined />} onClick={() => handleEdit(record)}>
            编辑
          </Button>
          <Button type="text" danger icon={<DeleteOutlined />} onClick={() => handleDelete(record.id)}>
            删除
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <Card variant="borderless" title="应收账款管理" extra={
      <Space>
        <Input
          placeholder="搜索单据号或客户..."
          prefix={<SearchOutlined />}
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
        />
        <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>新增应收</Button>
      </Space>
    }>
      <Table
        columns={columns}
        dataSource={filteredReceivables}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 10 }}
      />

      <SupaModal
        title={editingReceivable ? '编辑应收账款' : '新增应收账款'}
        open={isModalOpen}
        width={600}
        height={440}
        onCancel={() => {
          setIsModalOpen(false);
          form.resetFields();
          setEditingReceivable(null);
        }}
        footer={<Space>
          <Button onClick={() => setIsModalOpen(false)}>取消</Button>
          <Button type="primary" onClick={() => form.submit()}>
            保存
          </Button>
        </Space>}
        historyTable={tableName}
      >
        <Card>
          <Form form={form} layout="vertical" onFinish={handleSubmit} style={{ marginRight: 16 }}>
            <Row gutter={16}>
              <Col span={12}>
                <Form.Item
                  label="客户"
                  name="customer_id"
                  rules={[{ required: true, message: '请选择客户' }]}
                >
                  <Select placeholder="请选择客户">
                    {customers.map((c) => (
                      <Option key={c.id} value={c.id}>{c.name}</Option>
                    ))}
                  </Select>
                </Form.Item>
                <Form.Item label="单据类型" name="doc_type" initialValue="invoice">
                  <Select>
                    <Option value="invoice">发票</Option>
                    <Option value="order">订单</Option>
                    <Option value="other">其他</Option>
                  </Select>
                </Form.Item>
                <Form.Item
                  label="单据号"
                  name="doc_no"
                  rules={[{ required: true, message: '请输入单据号' }]}
                >
                  <Input placeholder="请输入单据号" disabled={!!editingReceivable} />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  label="单据日期"
                  name="doc_date"
                  rules={[{ required: true, message: '请选择单据日期' }]}
                >
                  <DatePicker style={{ width: '100%' }} />
                </Form.Item>
                <Form.Item label="到期日" name="due_date">
                  <DatePicker style={{ width: '100%' }} />
                </Form.Item>
                <Form.Item
                  label="金额"
                  name="amount"
                  rules={[{ required: true, message: '请输入金额' }]}
                  initialValue={0}
                >
                  <InputNumber style={{ width: '100%' }} placeholder="请输入金额" />
                </Form.Item>
              </Col>
            </Row>
            <Form.Item label="备注" name="remark">
              <Input.TextArea rows={3} placeholder="请输入备注" />
            </Form.Item>
          </Form>
        </Card>
      </SupaModal>
    </Card>
  );
}
