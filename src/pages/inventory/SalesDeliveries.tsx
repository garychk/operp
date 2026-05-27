import { useEffect, useState } from 'react';
import { Button, Input, Table, Tag, Modal, Form, Select, Space, Card, message, InputNumber, Row, Col, DatePicker, Divider } from 'antd';
import { PlusOutlined, SearchOutlined, DeleteOutlined, EditOutlined, EyeOutlined, TruckOutlined } from '@ant-design/icons';
import { supabase } from '../../utils/supabase';
import { logWithTiming } from '../../utils/logger';
import type { Tables } from '../../utils/supabase';
import dayjs from 'dayjs';

type SalesDelivery = Tables['erp_sales_deliveries_s_539dcf81_b']['Row'];
type SalesDeliveryDetail = Tables['erp_sales_delivery_details_s_539dcf81_b']['Row'];
type SalesOrder = Tables['erp_sales_orders_s_539dcf81_b']['Row'];
type SalesOrderDetail = Tables['erp_sales_order_details_s_539dcf81_b']['Row'];
type Customer = Tables['erp_customers_s_539dcf81_b']['Row'];
type Product = Tables['erp_products_s_539dcf81_b']['Row'];
type Warehouse = Tables['erp_warehouses_s_539dcf81_b']['Row'];

const { Option } = Select;
const { TextArea } = Input;

export function SalesDeliveries() {
  const [deliveries, setDeliveries] = useState<SalesDelivery[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [salesOrders, setSalesOrders] = useState<SalesOrder[]>([]);
  const [salesOrderDetails, setSalesOrderDetails] = useState<SalesOrderDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isDetailModalOpen, setIsDetailModalOpen] = useState(false);
  const [editingDelivery, setEditingDelivery] = useState<SalesDelivery | null>(null);
  const [selectedDelivery, setSelectedDelivery] = useState<SalesDelivery | null>(null);
  const [details, setDetails] = useState<SalesDeliveryDetail[]>([]);
  const [editingDetail, setEditingDetail] = useState<SalesDeliveryDetail | null>(null);
  const [detailForm] = Form.useForm();
  const [form] = Form.useForm();
  const [selectedOrderId, setSelectedOrderId] = useState<number | null>(null);

  useEffect(() => {
    fetchDeliveries();
    fetchCustomers();
    fetchProducts();
    fetchWarehouses();
    fetchSalesOrders();
  }, []);

  const fetchDeliveries = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from('erp_sales_deliveries_s_539dcf81_b')
        .select('*')
        .eq('is_deleted', 'n')
        .order('delivery_date', { ascending: false });

      if (error) throw error;
      setDeliveries(data || []);
    } catch (error) {
      console.error('Error fetching deliveries:', error);
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

  const fetchProducts = async () => {
    try {
      const { data, error } = await supabase
        .from('erp_products_s_539dcf81_b')
        .select('*')
        .eq('is_deleted', 'n')
        .eq('status', 'active');
      if (error) throw error;
      setProducts(data || []);
    } catch (error) {
      console.error('Error fetching products:', error);
    }
  };

  const fetchWarehouses = async () => {
    try {
      const { data, error } = await supabase
        .from('erp_warehouses_s_539dcf81_b')
        .select('*')
        .eq('is_deleted', 'n')
        .eq('status', 'active');
      if (error) throw error;
      setWarehouses(data || []);
    } catch (error) {
      console.error('Error fetching warehouses:', error);
    }
  };

  const fetchSalesOrders = async () => {
    try {
      const { data, error } = await supabase
        .from('erp_sales_orders_s_539dcf81_b')
        .select('*')
        .eq('is_deleted', 'n')
        .in('status', ['approved', 'partially_delivered']);
      if (error) throw error;
      setSalesOrders(data || []);
    } catch (error) {
      console.error('Error fetching sales orders:', error);
    }
  };

  const fetchSalesOrderDetails = async (orderId: number) => {
    try {
      const { data, error } = await supabase
        .from('erp_sales_order_details_s_539dcf81_b')
        .select('*')
        .eq('is_deleted', 'n')
        .eq('order_id', orderId);
      if (error) throw error;
      setSalesOrderDetails(data || []);
    } catch (error) {
      console.error('Error fetching sales order details:', error);
    }
  };

  const fetchDetails = async (deliveryId: number) => {
    try {
      const { data, error } = await supabase
        .from('erp_sales_delivery_details_s_539dcf81_b')
        .select('*')
        .eq('is_deleted', 'n')
        .eq('delivery_id', deliveryId)
        .order('line_no');
      if (error) throw error;
      setDetails(data || []);
    } catch (error) {
      console.error('Error fetching details:', error);
      message.error('获取明细失败');
    }
  };

  const handleSubmit = async (values: any) => {
    try {
      if (editingDelivery) {
        await logWithTiming('更新销售出货单', 'UPDATE', async () => {
          const { error } = await supabase
            .from('erp_sales_deliveries_s_539dcf81_b')
            .update(values)
            .eq('id', editingDelivery.id);
          if (error) throw error;
        });
        message.success('更新成功');
      } else {
        await logWithTiming('新增销售出货单', 'INSERT', async () => {
          const { error } = await supabase
            .from('erp_sales_deliveries_s_539dcf81_b')
            .insert([values]);
          if (error) throw error;
        });
        message.success('新增成功');
      }
      setIsModalOpen(false);
      form.resetFields();
      setEditingDelivery(null);
      setSelectedOrderId(null);
      fetchDeliveries();
    } catch (error) {
      console.error('Error saving delivery:', error);
      message.error('保存失败');
    }
  };

  const handleDetailSubmit = async (values: any) => {
    try {
      if (!selectedDelivery) return;
      
      values.amount = (values.quantity || 0) * (values.unit_price || 0);
      
      if (editingDetail) {
        await supabase
          .from('erp_sales_delivery_details_s_539dcf81_b')
          .update(values)
          .eq('id', editingDetail.id);
        message.success('更新成功');
      } else {
        const maxLineNo = details.length > 0 ? Math.max(...details.map(d => d.line_no)) : 0;
        values.line_no = maxLineNo + 1;
        values.delivery_id = selectedDelivery.id;
        values.is_deleted = 'n';
        
        console.log('SalesDeliveries: Inserting detail with values:', values);
        const { data, error } = await supabase
          .from('erp_sales_delivery_details_s_539dcf81_b')
          .insert([values]);
        console.log('SalesDeliveries: Insert result:', data, error);
        if (error) throw error;
        message.success('新增成功');
        
        if (values.order_detail_id) {
          await updateOrderDetailDeliveredQuantity(values.order_detail_id, values.quantity || 0);
        }
      }
      setIsDetailModalOpen(false);
      detailForm.resetFields();
      setEditingDetail(null);
      fetchDetails(selectedDelivery.id);
      updateDeliveryTotal(selectedDelivery.id);
    } catch (error) {
      console.error('Error saving detail:', error);
      message.error('保存失败');
    }
  };

  const updateOrderDetailDeliveredQuantity = async (orderDetailId: number, quantity: number) => {
    try {
      const { data, error } = await supabase
        .from('erp_sales_order_details_s_539dcf81_b')
        .select('delivered_quantity, quantity, order_id')
        .eq('id', orderDetailId)
        .single();
      if (error) throw error;
      
      const newDeliveredQty = (data.delivered_quantity || 0) + quantity;
      await supabase
        .from('erp_sales_order_details_s_539dcf81_b')
        .update({ delivered_quantity: newDeliveredQty as number })
        .eq('id', orderDetailId);
      
      if (data.order_id) {
        await updateSalesOrderStatus(data.order_id);
      }
    } catch (error) {
      console.error('Error updating order detail:', error);
    }
  };

  const updateSalesOrderStatus = async (orderId: number) => {
    try {
      const { data, error } = await supabase
        .from('erp_sales_order_details_s_539dcf81_b')
        .select('quantity, delivered_quantity')
        .eq('order_id', orderId)
        .eq('is_deleted', 'n');
      if (error) throw error;
      
      const allDelivered = data.every(d => (d.delivered_quantity || 0) >= (d.quantity || 0));
      const someDelivered = data.some(d => (d.delivered_quantity || 0) > 0);
      
      let status = 'approved';
      if (allDelivered) {
        status = 'delivered';
      } else if (someDelivered) {
        status = 'partially_delivered';
      }
      
      await supabase
        .from('erp_sales_orders_s_539dcf81_b')
        .update({ status })
        .eq('id', orderId);
    } catch (error) {
      console.error('Error updating order status:', error);
    }
  };

  const updateDeliveryTotal = async (deliveryId: number) => {
    try {
      const { data, error } = await supabase
        .from('erp_sales_delivery_details_s_539dcf81_b')
        .select('amount')
        .eq('is_deleted', 'n')
        .eq('delivery_id', deliveryId);
      if (error) throw error;
      
      const totalAmount = data?.reduce((sum, d) => sum + (d.amount || 0), 0) || 0;
      
      await supabase
        .from('erp_sales_deliveries_s_539dcf81_b')
        .update({ total_amount: totalAmount })
        .eq('id', deliveryId);
      
      fetchDeliveries();
    } catch (error) {
      console.error('Error updating delivery total:', error);
    }
  };

  const handleEdit = (record: SalesDelivery) => {
    setEditingDelivery(record);
    setSelectedOrderId(record.order_id || null);
    if (record.order_id) {
      fetchSalesOrderDetails(record.order_id);
    }
    const formValues = { ...record };
    form.setFieldsValue(formValues);
    setIsModalOpen(true);
  };

  const handleDelete = async (id: number) => {
    Modal.confirm({
      title: '确认删除',
      content: '确定要删除该出货单吗？',
      onOk: async () => {
        try {
          await logWithTiming('删除销售出货单', 'DELETE', async () => {
            const { error } = await supabase
              .from('erp_sales_deliveries_s_539dcf81_b')
              .update({ is_deleted: 'y' })
              .eq('id', id);
            if (error) throw error;
            await supabase
              .from('erp_sales_delivery_details_s_539dcf81_b')
              .update({ is_deleted: 'y' })
              .eq('delivery_id', id);
          });
          message.success('删除成功');
          fetchDeliveries();
        } catch (error) {
          console.error('Error deleting delivery:', error);
          message.error('删除失败');
        }
      },
    });
  };

  const handleAdd = () => {
    setEditingDelivery(null);
    setSelectedOrderId(null);
    setSalesOrderDetails([]);
    form.setFieldsValue({
      delivery_no: `SD${Date.now().toString().slice(-8)}`,
      delivery_date: dayjs(new Date()),
      order_id: undefined,
      customer_id: undefined,
      warehouse_id: undefined,
      total_amount: 0,
      remark: '',
      status: 'draft',
    });
    setIsModalOpen(true);
  };

  const handleViewDetails = (record: SalesDelivery) => {
    setSelectedDelivery(record);
    fetchDetails(record.id);
  };

  const handleAddDetail = () => {
    setEditingDetail(null);
    detailForm.setFieldsValue({
      order_detail_id: undefined,
      product_id: undefined,
      quantity: 1,
      unit_price: 0,
      amount: 0,
      batch_no: '',
      remark: '',
    });
    setIsDetailModalOpen(true);
  };

  const handleEditDetail = (record: SalesDeliveryDetail) => {
    setEditingDetail(record);
    detailForm.setFieldsValue(record);
    setIsDetailModalOpen(true);
  };

  const handleDeleteDetail = async (id: number) => {
    Modal.confirm({
      title: '确认删除',
      content: '确定要删除该明细吗？',
      onOk: async () => {
        try {
          await supabase
            .from('erp_sales_delivery_details_s_539dcf81_b')
            .update({ is_deleted: 'y' })
            .eq('id', id);
          message.success('删除成功');
          if (selectedDelivery) {
            fetchDetails(selectedDelivery.id);
            updateDeliveryTotal(selectedDelivery.id);
          }
        } catch (error) {
          console.error('Error deleting detail:', error);
          message.error('删除失败');
        }
      },
    });
  };

  const handleOrderChange = (value: number | null) => {
    setSelectedOrderId(value);
    if (value) {
      fetchSalesOrderDetails(value);
      const order = salesOrders.find(o => o.id === value);
      if (order) {
        form.setFieldsValue({ customer_id: order.customer_id });
      }
    } else {
      setSalesOrderDetails([]);
      form.setFieldsValue({ customer_id: undefined });
    }
  };

  const getCustomerName = (customerId: number | null) => {
    const customer = customers.find((c) => c.id === customerId);
    return customer?.name || '-';
  };

  const getProductName = (productId: number | null) => {
    const product = products.find((p) => p.id === productId);
    return product?.name || '-';
  };

  const getProductUnit = (productId: number | null) => {
    const product = products.find((p) => p.id === productId);
    return product?.unit || '-';
  };

  const getProductPrice = (productId: number | null) => {
    const product = products.find((p) => p.id === productId);
    return product?.sale_price || 0;
  };

  const getWarehouseName = (warehouseId: number | null) => {
    const warehouse = warehouses.find((w) => w.id === warehouseId);
    return warehouse?.name || '-';
  };

  const getOrderNo = (orderId: number | null) => {
    const order = salesOrders.find((o) => o.id === orderId);
    return order?.order_no || '-';
  };

  const getOrderDetailInfo = (orderDetailId: number | null) => {
    const detail = salesOrderDetails.find((d) => d.id === orderDetailId);
    if (!detail) return null;
    const product = products.find((p) => p.id === detail.product_id);
    return {
      productName: product?.name || '-',
      unit: product?.unit || '-',
      remainingQty: (detail.quantity || 0) - (detail.delivered_quantity || 0),
      unitPrice: detail.unit_price || 0,
    };
  };

  const handleOrderDetailChange = (value: number | null) => {
    const info = getOrderDetailInfo(value);
    if (info) {
      detailForm.setFieldsValue({
        product_id: null,
        quantity: info.remainingQty,
        unit_price: info.unitPrice,
        amount: info.remainingQty * info.unitPrice,
      });
    }
  };

  const filteredDeliveries = deliveries.filter(
    (d) =>
      d.delivery_no.toLowerCase().includes(searchTerm.toLowerCase()) ||
      getCustomerName(d.customer_id).toLowerCase().includes(searchTerm.toLowerCase()) ||
      getOrderNo(d.order_id).toLowerCase().includes(searchTerm.toLowerCase())
  );

  const statusLabels: Record<string, { text: string; color: string }> = {
    draft: { text: '草稿', color: 'default' },
    pending: { text: '待审核', color: 'warning' },
    approved: { text: '已审核', color: 'success' },
    cancelled: { text: '已取消', color: 'error' },
  };

  const columns = [
    {
      title: '出货单号',
      dataIndex: 'delivery_no',
      key: 'delivery_no',
    },
    {
      title: '销售订单',
      dataIndex: 'order_id',
      key: 'order_id',
      render: (orderId: number) => getOrderNo(orderId),
    },
    {
      title: '客户',
      dataIndex: 'customer_id',
      key: 'customer_id',
      render: (customerId: number) => getCustomerName(customerId),
    },
    {
      title: '仓库',
      dataIndex: 'warehouse_id',
      key: 'warehouse_id',
      render: (warehouseId: number) => getWarehouseName(warehouseId),
    },
    {
      title: '出货日期',
      dataIndex: 'delivery_date',
      key: 'delivery_date',
    },
    {
      title: '金额',
      dataIndex: 'total_amount',
      key: 'total_amount',
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
      render: (_: any, record: SalesDelivery) => (
        <Space size="middle">
          <Button type="text" icon={<EyeOutlined />} onClick={() => handleViewDetails(record)}>
            明细
          </Button>
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

  const detailColumns = [
    {
      title: '行号',
      dataIndex: 'line_no',
      key: 'line_no',
    },
    {
      title: '来源订单明细',
      dataIndex: 'order_detail_id',
      key: 'order_detail_id',
      render: (orderDetailId: number) => {
        const info = getOrderDetailInfo(orderDetailId);
        return info ? <span>{info.productName} (剩余{info.remainingQty}{info.unit})</span> : '-';
      },
    },
    {
      title: '产品',
      dataIndex: 'product_id',
      key: 'product_id',
      render: (productId: number) => getProductName(productId),
    },
    {
      title: '单位',
      dataIndex: 'product_id',
      key: 'unit',
      render: (productId: number) => getProductUnit(productId),
    },
    {
      title: '数量',
      dataIndex: 'quantity',
      key: 'quantity',
      render: (qty: number) => qty?.toLocaleString() || '0',
    },
    {
      title: '单价',
      dataIndex: 'unit_price',
      key: 'unit_price',
      render: (price: number) => `¥${(price ?? 0).toFixed(2)}`,
    },
    {
      title: '金额',
      dataIndex: 'amount',
      key: 'amount',
      render: (amount: number) => `¥${(amount ?? 0).toFixed(2)}`,
    },
    {
      title: '批次号',
      dataIndex: 'batch_no',
      key: 'batch_no',
      render: (text: string) => text || '-',
    },
    {
      title: '操作',
      key: 'action',
      render: (_: any, record: SalesDeliveryDetail) => (
        <Space size="middle">
          <Button type="text" icon={<EditOutlined />} onClick={() => handleEditDetail(record)}>
            编辑
          </Button>
          <Button type="text" danger icon={<DeleteOutlined />} onClick={() => handleDeleteDetail(record.id)}>
            删除
          </Button>
        </Space>
      ),
    },
  ];

  const detailTotal = details.reduce((acc, d) => ({
    amount: acc.amount + (d.amount || 0),
  }), { amount: 0 });

  return (
    <Card variant="borderless" title="销售出货单" extra={<Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>新增出货单</Button>}>

      <div style={{ marginBottom: 16 }}>
        <Input
          placeholder="搜索出货单号、客户或销售订单..."
          prefix={<SearchOutlined />}
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          style={{ width: 300 }}
        />
      </div>

      <Table
        columns={columns}
        dataSource={filteredDeliveries}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 10 }}
      />

      <Modal
        title={editingDelivery ? '编辑销售出货单' : '新增销售出货单'}
        open={isModalOpen}
        onCancel={() => {
          setIsModalOpen(false);
          form.resetFields();
          setEditingDelivery(null);
          setSelectedOrderId(null);
          setSalesOrderDetails([]);
        }}
        footer={<Space>
          <Button onClick={() => setIsModalOpen(false)}>取消</Button>
          <Button type="primary" onClick={() => form.submit()}>
            保存
          </Button>
        </Space>}
        width={600}
      >
        <Form form={form} layout="vertical" onFinish={handleSubmit} style={{ marginTop: 16 }}>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                label="出货单号"
                name="delivery_no"
                rules={[{ required: true, message: '请输入出货单号' }]}
              >
                <Input placeholder="请输入出货单号" disabled={!!editingDelivery} />
              </Form.Item>
              <Form.Item
                label="关联销售订单"
                name="order_id"
              >
                <Select 
                  placeholder="请选择销售订单" 
                  onChange={handleOrderChange}
                  allowClear
                >
                  {salesOrders.map((o) => (
                    <Option key={o.id} value={o.id}>{o.order_no}</Option>
                  ))}
                </Select>
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
                label="仓库"
                name="warehouse_id"
                rules={[{ required: true, message: '请选择仓库' }]}
              >
                <Select placeholder="请选择仓库">
                  {warehouses.map((w) => (
                    <Option key={w.id} value={w.id}>{w.name}</Option>
                  ))}
                </Select>
              </Form.Item>
              <Form.Item
                label="出货日期"
                name="delivery_date"
                rules={[{ required: true, message: '请选择出货日期' }]}
              >
                <DatePicker />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label="总金额" name="total_amount" initialValue={0}>
                <InputNumber disabled style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item label="备注" name="remark">
                <TextArea rows={4} placeholder="请输入备注" />
              </Form.Item>
              <Form.Item label="状态" name="status" initialValue="draft">
                <Select>
                  <Option value="draft">草稿</Option>
                  <Option value="pending">待审核</Option>
                  <Option value="approved">已审核</Option>
                  <Option value="cancelled">已取消</Option>
                </Select>
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>

      <Modal
        title={<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <TruckOutlined />
          {selectedDelivery?.delivery_no} - 销售出货单明细
        </div>}
        open={!!selectedDelivery}
        onCancel={() => {
          setSelectedDelivery(null);
          setDetails([]);
        }}
        footer={null}
        width={900}
      >
        {selectedDelivery && (
          <Card extra={
            <Space>
              <span>客户: {getCustomerName(selectedDelivery.customer_id)}</span>
              <span>仓库: {getWarehouseName(selectedDelivery.warehouse_id)}</span>
              <span>出货日期: {selectedDelivery.delivery_date}</span>
              <Button type="primary" icon={<PlusOutlined />} onClick={handleAddDetail}>新增明细</Button>
            </Space>
            }>
            <Table
              columns={detailColumns}
              dataSource={details}
              rowKey="id"
              pagination={false}
              summary={() => (
                <Table.Summary.Row>
                  <Table.Summary.Cell index={0} colSpan={6} align="right"><strong>合计</strong></Table.Summary.Cell>
                  <Table.Summary.Cell index={1} align="right"><strong>¥{detailTotal.amount.toFixed(2)}</strong></Table.Summary.Cell>
                  <Table.Summary.Cell index={2} colSpan={2}></Table.Summary.Cell>
                </Table.Summary.Row>
              )}
            />
          </Card>
        )}
      </Modal>

      <Modal
        title={editingDetail ? '编辑销售出货明细' : '新增销售出货明细'}
        open={isDetailModalOpen}
        onCancel={() => {
          setIsDetailModalOpen(false);
          detailForm.resetFields();
          setEditingDetail(null);
        }}
        footer={<Space>
          <Button onClick={() => setIsDetailModalOpen(false)}>取消</Button>
          <Button type="primary" onClick={() => detailForm.submit()}>
            保存
          </Button>
        </Space>}
        width={500}
      >
        <Form form={detailForm} layout="vertical" onFinish={handleDetailSubmit} style={{ marginTop: 16 }}>
          <Form.Item
            label="关联订单明细"
            name="order_detail_id"
          >
            <Select 
              placeholder="选择关联的销售订单明细"
              onChange={handleOrderDetailChange}
              allowClear
            >
              {salesOrderDetails.map((d) => {
                const remaining = (d.quantity || 0) - (d.delivered_quantity || 0);
                if (remaining <= 0) return null;
                const product = products.find((p) => p.id === d.product_id);
                return (
                  <Option key={d.id} value={d.id}>
                    {product?.code} - {product?.name} (剩余{remaining}{product?.unit})
                  </Option>
                );
              })}
            </Select>
          </Form.Item>
          <Form.Item
            label="产品"
            name="product_id"
            rules={[{ required: true, message: '请选择产品' }]}
          >
            <Select 
              placeholder="请选择产品" 
              onChange={(value) => {
                const price = getProductPrice(value as number);
                detailForm.setFieldsValue({ unit_price: price });
              }}
            >
              {products.map((p) => (
                <Option key={p.id} value={p.id}>{p.code} - {p.name}</Option>
              ))}
            </Select>
          </Form.Item>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                label="数量"
                name="quantity"
                rules={[{ required: true, message: '请输入数量' }]}
              >
                <InputNumber min={1} style={{ width: '100%' }} placeholder="请输入数量" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                label="单价"
                name="unit_price"
                rules={[{ required: true, message: '请输入单价' }]}
              >
                <InputNumber min={0} step={0.01} style={{ width: '100%' }} placeholder="请输入单价" />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item label="批次号" name="batch_no">
            <Input placeholder="请输入批次号" />
          </Form.Item>
          <Form.Item label="备注" name="remark">
            <Input placeholder="请输入备注" />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}