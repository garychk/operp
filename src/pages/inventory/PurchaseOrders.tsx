import { useEffect, useState } from 'react';
import { Button, Input, Table, Tag, Modal, Form, Select, Space, Card, message, InputNumber } from 'antd';
import { PlusOutlined, SearchOutlined, DeleteOutlined, EditOutlined } from '@ant-design/icons';
import { supabase } from '../../utils/supabase';
import { logWithTiming } from '../../utils/logger';
import type { Tables } from '../../utils/supabase';

type PurchaseOrder = Tables['erp_purchase_orders_s_539dcf81_b']['Row'];
type Supplier = Tables['erp_suppliers_s_539dcf81_b']['Row'];

const { Option } = Select;
const { TextArea } = Input;

export function PurchaseOrders() {
  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingOrder, setEditingOrder] = useState<PurchaseOrder | null>(null);
  const [form] = Form.useForm();

  useEffect(() => {
    fetchOrders();
    fetchSuppliers();
  }, []);

  const fetchOrders = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from('erp_purchase_orders_s_539dcf81_b')
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
      if (editingOrder) {
        await logWithTiming('更新采购订单', 'UPDATE', async () => {
          const { error } = await supabase
            .from('erp_purchase_orders_s_539dcf81_b')
            .update(values)
            .eq('id', editingOrder.id);
          if (error) throw error;
        });
        message.success('更新成功');
      } else {
        await logWithTiming('新增采购订单', 'INSERT', async () => {
          const { error } = await supabase
            .from('erp_purchase_orders_s_539dcf81_b')
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

  const handleEdit = (record: PurchaseOrder) => {
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
          await logWithTiming('删除采购订单', 'DELETE', async () => {
            const { error } = await supabase
              .from('erp_purchase_orders_s_539dcf81_b')
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
      order_no: `PO${Date.now().toString().slice(-8)}`,
      order_date: new Date().toISOString().split('T')[0],
      supplier_id: undefined,
      delivery_date: '',
      total_amount: 0,
      tax_amount: 0,
      payable_amount: 0,
      currency: 'CNY',
      delivery_address: '',
      contact_person: '',
      contact_phone: '',
      remark: '',
      status: 'draft',
    });
    setIsModalOpen(true);
  };

  const getSupplierName = (supplierId: number | null) => {
    const supplier = suppliers.find((s) => s.id === supplierId);
    return supplier?.name || '-';
  };

  const filteredOrders = orders.filter(
    (o) =>
      o.order_no.toLowerCase().includes(searchTerm.toLowerCase()) ||
      getSupplierName(o.supplier_id).toLowerCase().includes(searchTerm.toLowerCase())
  );

  const statusLabels: Record<string, { text: string; color: string }> = {
    draft: { text: '草稿', color: 'default' },
    pending: { text: '待审批', color: 'warning' },
    approved: { text: '已审批', color: 'success' },
    partially_received: { text: '部分收货', color: 'processing' },
    received: { text: '已收货', color: 'success' },
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
      title: '供应商',
      dataIndex: 'supplier_id',
      key: 'supplier_id',
      render: (supplierId: number) => getSupplierName(supplierId),
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
      title: '应付金额',
      dataIndex: 'payable_amount',
      key: 'payable_amount',
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
      render: (_: any, record: PurchaseOrder) => (
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
    <Card variant="borderless" title="采购订单" extra={<Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>新增订单</Button>}>      
      
      <div style={{ marginBottom: 16 }}>
        <Input
          placeholder="搜索订单号或供应商..."
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
        title={editingOrder ? '编辑采购订单' : '新增采购订单'}
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
            label="供应商"
            name="supplier_id"
            rules={[{ required: true, message: '请选择供应商' }]}
          >
            <Select placeholder="请选择供应商">
              {suppliers.map((s) => (
                <Option key={s.id} value={s.id}>{s.name}</Option>
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
          <Form.Item label="应付金额" name="payable_amount" initialValue={0}>
            <InputNumber style={{ width: '100%' }} placeholder="请输入应付金额" />
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
              <Option value="partially_received">部分收货</Option>
              <Option value="received">已收货</Option>
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
