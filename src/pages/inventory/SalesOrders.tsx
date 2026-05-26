import { useEffect, useState } from 'react';
import { Button, Input, Table, Tag, Modal, Form, Select, Space, Card, message, InputNumber } from 'antd';
import { PlusOutlined, SearchOutlined, DeleteOutlined, EditOutlined } from '@ant-design/icons';
import { supabase } from '../../utils/supabase';
import { logWithTiming } from '../../utils/logger';
import type { Tables } from '../../utils/supabase';

type SalesOrder = Tables['erp_sales_orders_s_539dcf81_b']['Row'];
type Customer = Tables['erp_customers_s_539dcf81_b']['Row'];

const { Option } = Select;
const { TextArea } = Input;

export function SalesOrders() {
  const [orders, setOrders] = useState<SalesOrder[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingOrder, setEditingOrder] = useState<SalesOrder | null>(null);
  const [form] = Form.useForm();

  useEffect(() => {
    fetchOrders();
    fetchCustomers();
  }, []);

  const fetchOrders = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from('erp_sales_orders_s_539dcf81_b')
        .select('*')
        .eq('is_deleted', 'n')
        .order('order_date', { ascending: false });

      if (error) throw error;
      setOrders(data || []);
    } catch (error) {
      console.error('Error fetching orders:', error);
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
      if (editingOrder) {
        await logWithTiming('更新销售订单', 'UPDATE', async () => {
          const { error } = await supabase
            .from('erp_sales_orders_s_539dcf81_b')
            .update(values)
            .eq('id', editingOrder.id);
          if (error) throw error;
        });
        message.success('更新成功');
      } else {
        await logWithTiming('新增销售订单', 'INSERT', async () => {
          const { error } = await supabase
            .from('erp_sales_orders_s_539dcf81_b')
            .insert([values]);
          if (error) throw error;
        });
        message.success('新增成功');
      }
      setIsModalOpen(false);
      form.resetFields();
      setEditingOrder(null);
      fetchOrders();
    } catch (error) {
      console.error('Error saving order:', error);
      message.error('保存失败');
    }
  };

  const handleEdit = (record: SalesOrder) => {
    setEditingOrder(record);
    form.setFieldsValue(record);
    setIsModalOpen(true);
  };

  const handleDelete = async (id: number) => {
    Modal.confirm({
      title: '确认删除',
      content: '确定要删除该订单吗？',
      onOk: async () => {
        try {
          await logWithTiming('删除销售订单', 'DELETE', async () => {
            const { error } = await supabase
              .from('erp_sales_orders_s_539dcf81_b')
              .update({ is_deleted: 'y' })
              .eq('id', id);
            if (error) throw error;
          });
          message.success('删除成功');
          fetchOrders();
        } catch (error) {
          console.error('Error deleting order:', error);
          message.error('删除失败');
        }
      },
    });
  };

  const handleAdd = () => {
    setEditingOrder(null);
    form.setFieldsValue({
      order_no: `SO${Date.now().toString().slice(-8)}`,
      order_date: new Date().toISOString().split('T')[0],
      customer_id: undefined,
      delivery_date: '',
      total_amount: 0,
      tax_amount: 0,
      discount_amount: 0,
      receivable_amount: 0,
      currency: 'CNY',
      delivery_address: '',
      contact_person: '',
      contact_phone: '',
      remark: '',
      status: 'draft',
    });
    setIsModalOpen(true);
  };

  const getCustomerName = (customerId: number | null) => {
    const customer = customers.find((c) => c.id === customerId);
    return customer?.name || '-';
  };

  const filteredOrders = orders.filter(
    (o) =>
      o.order_no.toLowerCase().includes(searchTerm.toLowerCase()) ||
      getCustomerName(o.customer_id).toLowerCase().includes(searchTerm.toLowerCase())
  );

  const statusLabels: Record<string, { text: string; color: string }> = {
    draft: { text: '草稿', color: 'default' },
    pending: { text: '待审批', color: 'warning' },
    approved: { text: '已审批', color: 'success' },
    partially_delivered: { text: '部分发货', color: 'processing' },
    delivered: { text: '已发货', color: 'success' },
    closed: { text: '已关闭', color: 'default' },
    cancelled: { text: '已取消', color: 'error' },
  };

  const columns = [
    {
      title: '订单号',
      dataIndex: 'order_no',
      key: 'order_no',
    },
    {
      title: '客户',
      dataIndex: 'customer_id',
      key: 'customer_id',
      render: (customerId: number) => getCustomerName(customerId),
    },
    {
      title: '订单日期',
      dataIndex: 'order_date',
      key: 'order_date',
    },
    {
      title: '交货日期',
      dataIndex: 'delivery_date',
      key: 'delivery_date',
      render: (text: string) => text || '-',
    },
    {
      title: '金额',
      dataIndex: 'total_amount',
      key: 'total_amount',
      render: (amount: number) => `¥${(amount ?? 0).toLocaleString()}`,
    },
    {
      title: '应收金额',
      dataIndex: 'receivable_amount',
      key: 'receivable_amount',
      render: (amount: number) => `¥${(amount ?? 0).toLocaleString()}`,
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
      render: (_: any, record: SalesOrder) => (
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
    <Card variant="borderless" title="销售订单" extra={<Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>新增订单</Button>}>      
      
      <div style={{ marginBottom: 16 }}>
        <Input
          placeholder="搜索订单号或客户..."
          prefix={<SearchOutlined />}
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          style={{ width: 300 }}
        />
      </div>

      <Table
        columns={columns}
        dataSource={filteredOrders}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 10 }}
      />

      <Modal
        title={editingOrder ? '编辑销售订单' : '新增销售订单'}
        open={isModalOpen}
        onCancel={() => {
          setIsModalOpen(false);
          form.resetFields();
          setEditingOrder(null);
        }}
        footer={null}
        width={600}
      >
        <Form form={form} layout="vertical" onFinish={handleSubmit} style={{ marginTop: 16 }}>
          <Form.Item
            label="订单号"
            name="order_no"
            rules={[{ required: true, message: '请输入订单号' }]}
          >
            <Input placeholder="请输入订单号" disabled={!!editingOrder} />
          </Form.Item>
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
          <Form.Item
            label="订单日期"
            name="order_date"
            rules={[{ required: true, message: '请选择订单日期' }]}
          >
            <Input type="date" />
          </Form.Item>
          <Form.Item label="交货日期" name="delivery_date">
            <Input type="date" />
          </Form.Item>
          <Form.Item label="总金额" name="total_amount" initialValue={0}>
            <InputNumber style={{ width: '100%' }} placeholder="请输入总金额" />
          </Form.Item>
          <Form.Item label="税额" name="tax_amount" initialValue={0}>
            <InputNumber style={{ width: '100%' }} placeholder="请输入税额" />
          </Form.Item>
          <Form.Item label="折扣金额" name="discount_amount" initialValue={0}>
            <InputNumber style={{ width: '100%' }} placeholder="请输入折扣金额" />
          </Form.Item>
          <Form.Item label="应收金额" name="receivable_amount" initialValue={0}>
            <InputNumber style={{ width: '100%' }} placeholder="请输入应收金额" />
          </Form.Item>
          <Form.Item label="币种" name="currency" initialValue="CNY">
            <Select>
              <Option value="CNY">人民币</Option>
              <Option value="USD">美元</Option>
              <Option value="EUR">欧元</Option>
            </Select>
          </Form.Item>
          <Form.Item label="交货地址" name="delivery_address">
            <Input placeholder="请输入交货地址" />
          </Form.Item>
          <Form.Item label="联系人" name="contact_person">
            <Input placeholder="请输入联系人" />
          </Form.Item>
          <Form.Item label="联系电话" name="contact_phone">
            <Input placeholder="请输入联系电话" />
          </Form.Item>
          <Form.Item label="备注" name="remark">
            <TextArea rows={3} placeholder="请输入备注" />
          </Form.Item>
          <Form.Item label="状态" name="status" initialValue="draft">
            <Select>
              <Option value="draft">草稿</Option>
              <Option value="pending">待审批</Option>
              <Option value="approved">已审批</Option>
              <Option value="partially_delivered">部分发货</Option>
              <Option value="delivered">已发货</Option>
              <Option value="closed">已关闭</Option>
              <Option value="cancelled">已取消</Option>
            </Select>
          </Form.Item>
          <Form.Item style={{ textAlign: 'right' }}>
            <Space>
              <Button onClick={() => setIsModalOpen(false)}>取消</Button>
              <Button type="primary" htmlType="submit">
                保存
              </Button>
            </Space>
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
