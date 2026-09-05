import { useEffect, useState } from 'react';
import type { Key } from 'react';
import { Button, Input, Table, Tag, Modal, Form, Select, Space, message, InputNumber, Row, Col, DatePicker } from 'antd';
import { PlusOutlined, DeleteOutlined, EditOutlined, EyeOutlined } from '@ant-design/icons';
import { supabase } from '../../utils/supabase';
import { logWithTiming } from '../../utils/logger';
import { runBusinessAction } from '../../utils/businessEngine';
import { useAuth } from '../../contexts/AuthContext';
import type { Tables } from '../../utils/supabase';
import dayjs from 'dayjs';
import { SupaModal } from '../../components/SupaModal';
import { SuperTable } from '../../components/SuperTable';
import SimpleModal from '@/components/SimpleModal';

type SalesDelivery = Tables['erp_sales_deliveries_s_539dcf81_b']['Row'];
type SalesDeliveryDetail = Tables['erp_sales_delivery_details_s_539dcf81_b']['Row'];
type SalesOrder = Tables['erp_sales_orders_s_539dcf81_b']['Row'];
type SalesOrderDetail = Tables['erp_sales_order_details_s_539dcf81_b']['Row'];
type Customer = Tables['erp_customers_s_539dcf81_b']['Row'];
type Product = Tables['erp_products_s_539dcf81_b']['Row'];
type Warehouse = Tables['erp_warehouses_s_539dcf81_b']['Row'];

const { Option } = Select;
const { TextArea } = Input;
const salesDeliveryTable = 'erp_sales_deliveries_s_539dcf81_b';
const salesDeliveryDetailTable = 'erp_sales_delivery_details_s_539dcf81_b';

export function SalesDeliveries() {
  const [deliveries, setDeliveries] = useState<SalesDelivery[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [salesOrders, setSalesOrders] = useState<SalesOrder[]>([]);
  const [salesOrderDetails, setSalesOrderDetails] = useState<SalesOrderDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedRowKeys, setSelectedRowKeys] = useState<Key[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isDetailModalOpen, setIsDetailModalOpen] = useState(false);
  const [editingDelivery, setEditingDelivery] = useState<SalesDelivery | null>(null);
  const [selectedDelivery, setSelectedDelivery] = useState<SalesDelivery | null>(null);
  const [details, setDetails] = useState<SalesDeliveryDetail[]>([]);
  const [editingDetail, setEditingDetail] = useState<SalesDeliveryDetail | null>(null);
  const [detailForm] = Form.useForm();
  const [form] = Form.useForm();
  const [isDisabled, setIsDisabled] = useState(false);
  const [, setSelectedOrderId] = useState<number | null>(null);
  const { user } = useAuth();

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
            .from(salesDeliveryTable)
            .update(values)
            .eq('id', editingDelivery.id);
          if (error) throw error;
        }, { table: salesDeliveryTable, recordId: editingDelivery.id });
        message.success('更新成功');
      } else {
        const logParams: { table: string; recordId?: number } = {
          table: salesDeliveryTable,
        };
        const data = await logWithTiming('新增销售出货单', 'INSERT', async () => {
          const { data, error } = await supabase
            .from(salesDeliveryTable)
            .insert([values])
            .select()
            .single();
          if (error) throw error;
          logParams.recordId = data.id;
          return data;
        }, logParams);
        setSelectedDelivery(data);
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

  const businessUser = { id: user?.profile.id, username: user?.profile.username };

  const runDeliveryAction = async (action: 'submit' | 'approve' | 'post' | 'reverse_post', record: SalesDelivery) => {
    try {
      await runBusinessAction({ action, documentType: 'sales_delivery', documentId: record.id, user: businessUser });
      const successText = action === 'submit' ? '提交审批成功' : action === 'approve' ? '审核成功' : action === 'post' ? '过账成功' : '反过账成功';
      message.success(successText);
      fetchDeliveries();
      if (selectedDelivery?.id === record.id) {
        fetchDetails(record.id);
      }
    } catch (error: any) {
      console.error('Error running delivery action:', error);
      message.error(error?.message || '操作失败');
    }
  };
  const handleEdit = (record: SalesDelivery) => {
    setEditingDelivery(record);
    setSelectedDelivery(record);
    setIsDisabled(record.status === 'posted');
    setSelectedOrderId(record.order_id || null);
    if (record.order_id) {
      fetchSalesOrderDetails(record.order_id);
    }
    const formValues = { ...record, delivery_date: dayjs(record.delivery_date) };
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
              .from(salesDeliveryTable)
              .update({ is_deleted: 'y' })
              .eq('id', id);
            if (error) throw error;
            const { error: detailError } = await supabase
              .from(salesDeliveryDetailTable)
              .update({ is_deleted: 'y' })
              .eq('delivery_id', id);
            if (detailError) throw detailError;
          }, { table: salesDeliveryTable, recordId: id });
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
    setSelectedDelivery(null);
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

  const handleAddDetail = (e: React.MouseEvent) => {
    e.stopPropagation();
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
    posted: { text: '已过账', color: 'success' },
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
          {record.status === 'draft' && (
            <Button type="text" onClick={() => runDeliveryAction('submit', record)} disabled={record.status !== 'draft'}>提交</Button>
          )}
          {record.status === 'pending' && (
            <Button type="text" onClick={() => runDeliveryAction('approve', record)}>审核</Button>
          )}
          {record.status === 'approved' && (
            <Button type="text" onClick={() => runDeliveryAction('post', record)}>过账</Button>
          )}
          {record.status === 'posted' && (
            <Button type="text" onClick={() => runDeliveryAction('reverse_post', record)}>反过账</Button>
          )}
          <Button type="text" icon={<EditOutlined />} onClick={() => handleEdit(record)} disabled={record.status === 'posted'}>
            编辑
          </Button>
          <Button type="text" danger icon={<DeleteOutlined />} onClick={() => handleDelete(record.id)} disabled={record.status === 'posted'}>
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
          <Button type="text" icon={<EditOutlined />} onClick={() => handleEditDetail(record)} disabled={isDisabled}>
            编辑
          </Button>
          <Button type="text" danger icon={<DeleteOutlined />} onClick={() => handleDeleteDetail(record.id)} disabled={isDisabled}>
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
    <div className="mainContent">
      <SuperTable
        columns={columns}
        dataSource={filteredDeliveries}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 10 }}
        storageKey="sales-deliveries"
        headerTitle="销售出货单"
        rowSelection={{
          selectedRowKeys,
          onChange: setSelectedRowKeys,
        }}
        queryBar={
          <Space wrap>
            <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>新增出货单</Button>
            <Input.Search
              allowClear
              placeholder="搜索出货单号、客户或销售订单..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              onSearch={fetchDeliveries}
              style={{ width: 280 }}
            />
          </Space>
        }
      />

      <SupaModal
        title={
          <>
            <EyeOutlined />
            <span>{editingDelivery ? '编辑销售出货单' : '新增销售出货单'}</span>
          </>
        }
        open={isModalOpen}
        onCancel={() => {
          setIsModalOpen(false);
          form.resetFields();
          setEditingDelivery(null);
          setSelectedDelivery(null);
          setSelectedOrderId(null);
          setSalesOrderDetails([]);
        }}
        headerExtra={
          editingDelivery ? (
            <Tag color={editingDelivery.status === 'draft' ? 'blue' : editingDelivery.status === 'posted' ? 'success' : 'green'}>
              {statusLabels[editingDelivery.status ?? '']?.text || editingDelivery.status}
            </Tag>
          ) : null
        }
        headerPanelTitle="销售出货单头"
        detailPanelTitle="销售出货单明细"
        historyTable={salesDeliveryTable}
        historyRecordId={editingDelivery?.id || selectedDelivery?.id}
        workflowDocumentType="sales_delivery"
        form={form}
        detailExtra={
          <Button
            type="link"
            size="small"
            icon={<PlusOutlined />}
            onClick={handleAddDetail}
            disabled={isDisabled}
          >
            新增明细
          </Button>
        }
        formEle={
          <Form form={form} layout="vertical" onFinish={handleSubmit} style={{ padding: "0 16px 0 0" }}>
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
                    disabled={isDisabled}
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
                  <Select placeholder="请选择客户" disabled={isDisabled}>
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
                  <Select placeholder="请选择仓库" disabled={isDisabled}>
                    {warehouses.map((w) => (
                      <Option key={w.id} value={w.id}>{w.name}</Option>
                    ))}
                  </Select>
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  label="出货日期"
                  name="delivery_date"
                  rules={[{ required: true, message: '请选择出货日期' }]}
                >
                  <DatePicker disabled={isDisabled} />
                </Form.Item>
                <Form.Item label="总金额" name="total_amount" initialValue={0}>
                  <InputNumber disabled style={{ width: '100%' }} />
                </Form.Item>
                <Form.Item label="状态" name="status" initialValue="draft">
                  <Select disabled={isDisabled}>
                    <Option value="draft">草稿</Option>
                    <Option value="pending">待审核</Option>
                    <Option value="approved">已审核</Option>
                    <Option value="cancelled">已取消</Option>
                  </Select>
                </Form.Item>
              </Col>
            </Row>
            <Form.Item label="备注" name="remark">
              <TextArea rows={2} placeholder="请输入备注" disabled={isDisabled} />
            </Form.Item>
          </Form>
        }
        tableEle={<Table
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
        />}
        footer={
          <Space>
            <Button onClick={() => setIsModalOpen(false)}>取消</Button>
            <Button type="primary" onClick={() => form.submit()} disabled={isDisabled}>
              保存
            </Button>
          </Space>
        }
        width={'60%'}
        height={680}
      />

      <SimpleModal  
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
              disabled={isDisabled}
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
              disabled={isDisabled}
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
                <InputNumber min={1} style={{ width: '100%' }} placeholder="请输入数量" disabled={isDisabled} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                label="单价"
                name="unit_price"
                rules={[{ required: true, message: '请输入单价' }]}
              >
                <InputNumber min={0} step={0.01} style={{ width: '100%' }} placeholder="请输入单价" disabled={isDisabled} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item label="批次号" name="batch_no">
            <Input placeholder="请输入批次号" disabled={isDisabled} />
          </Form.Item>
          <Form.Item label="备注" name="remark">
            <Input placeholder="请输入备注" disabled={isDisabled} />
          </Form.Item>
        </Form>
      </SimpleModal>
    </div>
  );
}



