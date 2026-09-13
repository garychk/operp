import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Key } from 'react';
import { Button, Input, Table, Tag, Modal, Form, Select, Space, message, InputNumber, Row, Col, DatePicker } from 'antd';
import { PlusOutlined, DeleteOutlined, EditOutlined, EyeOutlined } from '@ant-design/icons';
import { supabase } from '../../utils/supabase';
import { logWithTiming } from '../../utils/logger';
import { runBusinessAction } from '../../utils/businessEngine';
import { useAuth } from '../../contexts/AuthContext';
import type { Tables } from '../../utils/supabase';
import { nextDocumentNo } from '../../utils/documentNaming';
import dayjs from 'dayjs';
import { SupaModal } from '../../components/SupaModal';
import { SuperTable } from '../../components/SuperTable';
import { ProductUnit } from '../../components/ProductUnit';
import SimpleModal from '../../components/SimpleModal';

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
  const { t } = useTranslation();
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
      message.error(t('salesDeliveries.fetchDetailFailed'));
    }
  };

  const handleSubmit = async (values: any) => {
    try {
      if (editingDelivery) {
        await logWithTiming(t('salesDeliveries.logUpdate'), 'UPDATE', async () => {
          const { error } = await supabase
            .from(salesDeliveryTable)
            .update(values)
            .eq('id', editingDelivery.id);
          if (error) throw error;
        }, { table: salesDeliveryTable, recordId: editingDelivery.id });
        message.success(t('common.updateSuccess'));
      } else {
        const logParams: { table: string; recordId?: number } = {
          table: salesDeliveryTable,
        };
        const data = await logWithTiming(t('salesDeliveries.logCreate'), 'INSERT', async () => {
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
        message.success(t('common.createSuccess'));
      }
      setIsModalOpen(false);
      form.resetFields();
      setEditingDelivery(null);
      setSelectedOrderId(null);
      fetchDeliveries();
    } catch (error) {
      console.error('Error saving delivery:', error);
      message.error(t('common.saveFailed'));
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
        message.success(t('common.updateSuccess'));
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
        message.success(t('common.createSuccess'));

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
      message.error(t('common.saveFailed'));
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
      const successText = action === 'submit' ? t('salesDeliveries.submitSuccess') : action === 'approve' ? t('salesDeliveries.approveSuccess') : action === 'post' ? t('salesDeliveries.postSuccess') : t('salesDeliveries.reversePostSuccess');
      message.success(successText);
      fetchDeliveries();
      if (selectedDelivery?.id === record.id) {
        fetchDetails(record.id);
      }
    } catch (error: any) {
      console.error('Error running delivery action:', error);
      message.error(error?.message || t('salesDeliveries.actionFailed'));
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
      title: t('common.confirmDelete'),
      content: t('salesDeliveries.deleteDeliveryConfirm'),
      onOk: async () => {
        try {
          await logWithTiming(t('salesDeliveries.logDelete'), 'DELETE', async () => {
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
          message.success(t('common.deleteSuccess'));
          fetchDeliveries();
        } catch (error) {
          console.error('Error deleting delivery:', error);
          message.error(t('common.deleteFailed'));
        }
      },
    });
  };

  const handleAdd = async () => {
    setEditingDelivery(null);
    setSelectedDelivery(null);
    setSelectedOrderId(null);
    setSalesOrderDetails([]);
    form.setFieldsValue({
      delivery_no: await nextDocumentNo('sales_delivery'),
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
      title: t('common.confirmDelete'),
      content: t('salesDeliveries.deleteDetailConfirm'),
      onOk: async () => {
        try {
          await supabase
            .from('erp_sales_delivery_details_s_539dcf81_b')
            .update({ is_deleted: 'y' })
            .eq('id', id);
          message.success(t('common.deleteSuccess'));
          if (selectedDelivery) {
            fetchDetails(selectedDelivery.id);
            updateDeliveryTotal(selectedDelivery.id);
          }
        } catch (error) {
          console.error('Error deleting detail:', error);
          message.error(t('common.deleteFailed'));
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
    draft: { text: t('salesDeliveries.statusDraft'), color: 'default' },
    pending: { text: t('salesDeliveries.statusPending'), color: 'warning' },
    approved: { text: t('salesDeliveries.statusApproved'), color: 'success' },
    posted: { text: t('salesDeliveries.statusPosted'), color: 'success' },
    cancelled: { text: t('salesDeliveries.statusCancelled'), color: 'error' },
  };

  const columns = [
    {
      title: t('salesDeliveries.deliveryNo'),
      dataIndex: 'delivery_no',
      key: 'delivery_no',
    },
    {
      title: t('salesDeliveries.salesOrder'),
      dataIndex: 'order_id',
      key: 'order_id',
      render: (orderId: number) => getOrderNo(orderId),
    },
    {
      title: t('salesDeliveries.customer'),
      dataIndex: 'customer_id',
      key: 'customer_id',
      render: (customerId: number) => getCustomerName(customerId),
    },
    {
      title: t('salesDeliveries.warehouse'),
      dataIndex: 'warehouse_id',
      key: 'warehouse_id',
      render: (warehouseId: number) => getWarehouseName(warehouseId),
    },
    {
      title: t('salesDeliveries.deliveryDate'),
      dataIndex: 'delivery_date',
      key: 'delivery_date',
    },
    {
      title: t('salesDeliveries.amount'),
      dataIndex: 'total_amount',
      key: 'total_amount',
      render: (amount: number) => `¥${(amount ?? 0).toLocaleString()}`,
    },
    {
      title: t('common.status'),
      dataIndex: 'status',
      key: 'status',
      render: (status: string) => {
        const config = statusLabels[status] || { text: status, color: 'default' };
        return <Tag color={config.color}>{config.text}</Tag>;
      },
    },
    {
      title: t('common.actions'),
      key: 'action',
      render: (_: any, record: SalesDelivery) => (
        <Space size="middle">
          <Button type="text" icon={<EyeOutlined />} onClick={() => handleViewDetails(record)}>
            {t('salesDeliveries.details')}
          </Button>
          {record.status === 'draft' && (
            <Button type="text" onClick={() => runDeliveryAction('submit', record)} disabled={record.status !== 'draft'}>{t('salesDeliveries.submit')}</Button>
          )}
          {record.status === 'pending' && (
            <Button type="text" onClick={() => runDeliveryAction('approve', record)}>{t('salesDeliveries.approve')}</Button>
          )}
          {record.status === 'approved' && (
            <Button type="text" onClick={() => runDeliveryAction('post', record)}>{t('salesDeliveries.post')}</Button>
          )}
          {record.status === 'posted' && (
            <Button type="text" onClick={() => runDeliveryAction('reverse_post', record)}>{t('salesDeliveries.reversePost')}</Button>
          )}
          <Button type="text" icon={<EditOutlined />} onClick={() => handleEdit(record)} disabled={record.status === 'posted'}>
            {t('common.edit')}
          </Button>
          <Button type="text" danger icon={<DeleteOutlined />} onClick={() => handleDelete(record.id)} disabled={record.status === 'posted'}>
            {t('common.delete')}
          </Button>
        </Space>
      ),
    },
  ];

  const detailColumns = [
    {
      title: t('salesDeliveries.lineNo'),
      dataIndex: 'line_no',
      key: 'line_no',
    },
    {
      title: t('salesDeliveries.sourceOrderDetail'),
      dataIndex: 'order_detail_id',
      key: 'order_detail_id',
      render: (orderDetailId: number) => {
        const info = getOrderDetailInfo(orderDetailId);
        return info ? <span>{info.productName} ({t('salesDeliveries.remainingQty', { qty: info.remainingQty, unit: info.unit })})</span> : '-';
      },
    },
    {
      title: t('salesDeliveries.product'),
      dataIndex: 'product_id',
      key: 'product_id',
      render: (productId: number) => getProductName(productId),
    },
    {
      title: t('salesDeliveries.unit'),
      dataIndex: 'product_id',
      key: 'unit',
      render: (productId: number) => <ProductUnit productId={productId} />,
    },
    {
      title: t('salesDeliveries.quantity'),
      dataIndex: 'quantity',
      key: 'quantity',
      render: (qty: number) => qty?.toLocaleString() || '0',
    },
    {
      title: t('salesDeliveries.unitPrice'),
      dataIndex: 'unit_price',
      key: 'unit_price',
      render: (price: number) => `¥${(price ?? 0).toFixed(2)}`,
    },
    {
      title: t('salesDeliveries.amount'),
      dataIndex: 'amount',
      key: 'amount',
      render: (amount: number) => `¥${(amount ?? 0).toFixed(2)}`,
    },
    {
      title: t('salesDeliveries.batchNo'),
      dataIndex: 'batch_no',
      key: 'batch_no',
      render: (text: string) => text || '-',
    },
    {
      title: t('common.actions'),
      key: 'action',
      render: (_: any, record: SalesDeliveryDetail) => (
        <Space size="middle">
          <Button type="text" icon={<EditOutlined />} onClick={() => handleEditDetail(record)} disabled={isDisabled}>
            {t('common.edit')}
          </Button>
          <Button type="text" danger icon={<DeleteOutlined />} onClick={() => handleDeleteDetail(record.id)} disabled={isDisabled}>
            {t('common.delete')}
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
        headerTitle={t('salesDeliveries.title')}
        rowSelection={{
          selectedRowKeys,
          onChange: setSelectedRowKeys,
        }}
        queryBar={
          <Space wrap>
            <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>{t('salesDeliveries.addDelivery')}</Button>
            <Input.Search
              allowClear
              placeholder={t('salesDeliveries.searchPlaceholder')}
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
            <span>{editingDelivery ? t('salesDeliveries.editTitle') : t('salesDeliveries.addTitle')}</span>
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
        headerPanelTitle={t('salesDeliveries.headerPanelTitle')}
        detailPanelTitle={t('salesDeliveries.detailPanelTitle')}
        historyTable={salesDeliveryTable}
        historyRecordId={editingDelivery?.id || selectedDelivery?.id}
        workflowDocumentType="sales_delivery"
        onDataChanged={fetchDeliveries}
        form={form}
        detailExtra={
          <Button
            type="link"
            size="small"
            icon={<PlusOutlined />}
            onClick={handleAddDetail}
            disabled={isDisabled}
          >
            {t('salesDeliveries.addDetail')}
          </Button>
        }
        formEle={
          <Form form={form} layout="vertical" onFinish={handleSubmit} style={{ padding: "0 16px 0 0" }}>
            <Row gutter={16}>
              <Col span={12}>
                <Form.Item
                  label={t('salesDeliveries.deliveryNo')}
                  name="delivery_no"
                  rules={[{ required: true, message: t('salesDeliveries.deliveryNoRequired') }]}
                >
                  <Input placeholder={t('salesDeliveries.deliveryNoPlaceholder')} disabled={!!editingDelivery} />
                </Form.Item>
                <Form.Item
                  label={t('salesDeliveries.relatedSalesOrder')}
                  name="order_id"
                >
                  <Select
                    placeholder={t('salesDeliveries.salesOrderPlaceholder')}
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
                  label={t('salesDeliveries.customer')}
                  name="customer_id"
                  rules={[{ required: true, message: t('salesDeliveries.customerRequired') }]}
                >
                  <Select placeholder={t('salesDeliveries.customerPlaceholder')} disabled={isDisabled}>
                    {customers.map((c) => (
                      <Option key={c.id} value={c.id}>{c.name}</Option>
                    ))}
                  </Select>
                </Form.Item>
                <Form.Item
                  label={t('salesDeliveries.warehouse')}
                  name="warehouse_id"
                  rules={[{ required: true, message: t('salesDeliveries.warehouseRequired') }]}
                >
                  <Select placeholder={t('salesDeliveries.warehousePlaceholder')} disabled={isDisabled}>
                    {warehouses.map((w) => (
                      <Option key={w.id} value={w.id}>{w.name}</Option>
                    ))}
                  </Select>
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  label={t('salesDeliveries.deliveryDate')}
                  name="delivery_date"
                  rules={[{ required: true, message: t('salesDeliveries.deliveryDateRequired') }]}
                >
                  <DatePicker disabled={isDisabled} />
                </Form.Item>
                <Form.Item label={t('salesDeliveries.totalAmount')} name="total_amount" initialValue={0}>
                  <InputNumber disabled style={{ width: '100%' }} />
                </Form.Item>
                <Form.Item label={t('common.status')} name="status" initialValue="draft">
                  <Select disabled={isDisabled}>
                    <Option value="draft">{t('salesDeliveries.statusDraft')}</Option>
                    <Option value="pending">{t('salesDeliveries.statusPending')}</Option>
                    <Option value="approved">{t('salesDeliveries.statusApproved')}</Option>
                    <Option value="cancelled">{t('salesDeliveries.statusCancelled')}</Option>
                  </Select>
                </Form.Item>
              </Col>
            </Row>
            <Form.Item label={t('salesDeliveries.remark')} name="remark">
              <TextArea rows={2} placeholder={t('salesDeliveries.remarkPlaceholder')} disabled={isDisabled} />
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
              <Table.Summary.Cell index={0} colSpan={6} align="right"><strong>{t('salesDeliveries.totalText')}</strong></Table.Summary.Cell>
              <Table.Summary.Cell index={1} align="right"><strong>¥{detailTotal.amount.toFixed(2)}</strong></Table.Summary.Cell>
              <Table.Summary.Cell index={2} colSpan={2}></Table.Summary.Cell>
            </Table.Summary.Row>
          )}
        />}
        footer={
          <Space>
            <Button onClick={() => setIsModalOpen(false)}>{t('common.cancel')}</Button>
            <Button type="primary" onClick={() => form.submit()} disabled={isDisabled}>
              {t('common.save')}
            </Button>
          </Space>
        }
        width={'60%'}
        height={680}
      />

      <SimpleModal  
        title={editingDetail ? t('salesDeliveries.editDetailTitle') : t('salesDeliveries.addDetailTitle')}
        open={isDetailModalOpen}
        onCancel={() => {
          setIsDetailModalOpen(false);
          detailForm.resetFields();
          setEditingDetail(null);
        }}
        footer={<Space>
          <Button onClick={() => setIsDetailModalOpen(false)}>{t('common.cancel')}</Button>
          <Button type="primary" onClick={() => detailForm.submit()}>
            {t('common.save')}
          </Button>
        </Space>}
        width={500}
      >
        <Form form={detailForm} layout="vertical" onFinish={handleDetailSubmit} style={{ marginTop: 16 }}>
          <Form.Item
            label={t('salesDeliveries.relatedOrderDetail')}
            name="order_detail_id"
          >
            <Select
              placeholder={t('salesDeliveries.orderDetailPlaceholder')}
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
                    {product?.code} - {product?.name} ({t('salesDeliveries.remainingQty', { qty: remaining, unit: product?.unit })})
                  </Option>
                );
              })}
            </Select>
          </Form.Item>
          <Form.Item
            label={t('salesDeliveries.product')}
            name="product_id"
            rules={[{ required: true, message: t('salesDeliveries.productRequired') }]}
          >
            <Select
              placeholder={t('salesDeliveries.productPlaceholder')}
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
                label={t('salesDeliveries.quantity')}
                name="quantity"
                rules={[{ required: true, message: t('salesDeliveries.quantityRequired') }]}
              >
                <InputNumber min={1} style={{ width: '100%' }} placeholder={t('salesDeliveries.quantityPlaceholder')} disabled={isDisabled} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                label={t('salesDeliveries.unitPrice')}
                name="unit_price"
                rules={[{ required: true, message: t('salesDeliveries.unitPriceRequired') }]}
              >
                <InputNumber min={0} step={0.01} style={{ width: '100%' }} placeholder={t('salesDeliveries.unitPricePlaceholder')} disabled={isDisabled} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item label={t('salesDeliveries.batchNo')} name="batch_no">
            <Input placeholder={t('salesDeliveries.batchNoPlaceholder')} disabled={isDisabled} />
          </Form.Item>
          <Form.Item label={t('salesDeliveries.remark')} name="remark">
            <Input placeholder={t('salesDeliveries.remarkPlaceholder')} disabled={isDisabled} />
          </Form.Item>
        </Form>
      </SimpleModal>
    </div>
  );
}
