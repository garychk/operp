import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Key } from 'react';
import { Button, Input, Table, Tag, Modal, Form, Select, Space, message, InputNumber, Row, Col, DatePicker } from 'antd';
import { PlusOutlined, DeleteOutlined, EditOutlined } from '@ant-design/icons';
import { supabase } from '../../utils/supabase';
import { logWithTiming } from '../../utils/logger';
import { runBusinessAction } from '../../utils/businessEngine';
import { useAuth } from '../../contexts/AuthContext';
import type { Tables } from '../../utils/supabase';
import { nextDocumentNo } from '../../utils/documentNaming';
import dayjs from 'dayjs';
import { SupaModal } from '../../components/SupaModal';
import { SuperTable } from '../../components/SuperTable';
import SimpleModal from '../../components/SimpleModal';

type PurchaseReceipt = Tables['erp_purchase_receipts_s_539dcf81_b']['Row'];
type PurchaseReceiptDetail = Tables['erp_purchase_receipt_details_s_539dcf81_b']['Row'];
type PurchaseOrder = Tables['erp_purchase_orders_s_539dcf81_b']['Row'];
type PurchaseOrderDetail = Tables['erp_purchase_order_details_s_539dcf81_b']['Row'];
type Supplier = Tables['erp_suppliers_s_539dcf81_b']['Row'];
type Product = Tables['erp_products_s_539dcf81_b']['Row'];
type Warehouse = Tables['erp_warehouses_s_539dcf81_b']['Row'];

const { Option } = Select;
const { TextArea } = Input;
const purchaseReceiptTable = 'erp_purchase_receipts_s_539dcf81_b';
const purchaseReceiptDetailTable = 'erp_purchase_receipt_details_s_539dcf81_b';
const purchaseOrderTable = 'erp_purchase_orders_s_539dcf81_b';
const purchaseOrderDetailTable = 'erp_purchase_order_details_s_539dcf81_b';

export function PurchaseReceipts() {
  const { t } = useTranslation();
  const [receipts, setReceipts] = useState<PurchaseReceipt[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [purchaseOrders, setPurchaseOrders] = useState<PurchaseOrder[]>([]);
  const [purchaseOrderDetails, setPurchaseOrderDetails] = useState<PurchaseOrderDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedRowKeys, setSelectedRowKeys] = useState<Key[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isDetailModalOpen, setIsDetailModalOpen] = useState(false);
  const [editingReceipt, setEditingReceipt] = useState<PurchaseReceipt | null>(null);
  const [selectedReceipt] = useState<PurchaseReceipt | null>(null);
  const [details, setDetails] = useState<PurchaseReceiptDetail[]>([]);
  const [editingDetail, setEditingDetail] = useState<PurchaseReceiptDetail | null>(null);
  const [detailForm] = Form.useForm();
  const [form] = Form.useForm();
  const [, setSelectedOrderId] = useState<number | null>(null);
  const { user } = useAuth();

  useEffect(() => {
    fetchReceipts();
    fetchSuppliers();
    fetchProducts();
    fetchWarehouses();
    fetchPurchaseOrders();
  }, []);

  const fetchReceipts = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from(purchaseReceiptTable)
        .select('*')
        .eq('is_deleted', 'n')
        .order('receipt_date', { ascending: false });

      if (error) throw error;
      setReceipts(data || []);
    } catch (error) {
      console.error('Error fetching receipts:', error);
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

  const fetchPurchaseOrders = async () => {
    try {
      const { data, error } = await supabase
        .from(purchaseOrderTable)
        .select('*')
        .eq('is_deleted', 'n');
      if (error) throw error;
      setPurchaseOrders(data || []);
    } catch (error) {
      console.error('Error fetching purchase orders:', error);
    }
  };

  const fetchPurchaseOrderDetails = async (orderId: number) => {
    try {
      const { data, error } = await supabase
        .from(purchaseOrderDetailTable)
        .select('*')
        .eq('is_deleted', 'n')
        .eq('order_id', orderId);
      if (error) throw error;
      console.log('fetchPurchaseOrderDetails',data);
      setPurchaseOrderDetails(data || []);
    } catch (error) {
      console.error('Error fetching purchase order details:', error);
    }
  };

  const fetchDetails = async (receiptId: number) => {
    try {
      const { data, error } = await supabase
        .from(purchaseReceiptDetailTable)
        .select('*')
        .eq('is_deleted', 'n')
        .eq('receipt_id', receiptId)
        .order('line_no');
      if (error) throw error;
      setDetails(data || []);
    } catch (error) {
      console.error('Error fetching details:', error);
      message.error(t('purchaseReceipts.fetchDetailsFailed'));
    }
  };

  const handleSubmit = async (values: any) => {
    try {
      if (editingReceipt) {
        await logWithTiming('更新采购入库单', 'UPDATE', async () => {
          const { error } = await supabase
            .from(purchaseReceiptTable)
            .update(values)
            .eq('id', editingReceipt.id);
          if (error) throw error;
        });
        message.success(t('common.updateSuccess'));
      } else {
        await logWithTiming('新增采购入库单', 'INSERT', async () => {
          const { error } = await supabase
            .from(purchaseReceiptTable)
            .insert([values]);
          if (error) throw error;
        });
        message.success(t('common.createSuccess'));
      }
      setIsModalOpen(false);
      form.resetFields();
      setEditingReceipt(null);
      setSelectedOrderId(null);
      fetchReceipts();
    } catch (error) {
      console.error('Error saving receipt:', error);
      message.error(t('common.saveFailed'));
    }
  };

  const handleDetailSubmit = async (values: any) => {
    try {
      if (!selectedReceipt) return;
      
      values.amount = (values.quantity || 0) * (values.unit_price || 0);
      
      if (editingDetail) {
        await supabase
          .from(purchaseReceiptDetailTable)
          .update(values)
          .eq('id', editingDetail.id);
        message.success(t('common.updateSuccess'));
      } else {
        const maxLineNo = details.length > 0 ? Math.max(...details.map(d => d.line_no)) : 0;
        values.line_no = maxLineNo + 1;
        values.receipt_id = selectedReceipt.id;
        values.is_deleted = 'n';
        
        console.log('PurchaseReceipts: Inserting detail with values:', values);
        const { data, error } = await supabase
          .from(purchaseReceiptDetailTable)
          .insert([values]);
        console.log('PurchaseReceipts: Insert result:', data, error);
        if (error) throw error;
        message.success(t('common.createSuccess'));
        
        if (values.order_detail_id) {
          await updateOrderDetailReceivedQuantity(values.order_detail_id, values.quantity || 0);
        }
      }
      setIsDetailModalOpen(false);
      detailForm.resetFields();
      setEditingDetail(null);
      fetchDetails(selectedReceipt.id);
      updateReceiptTotal(selectedReceipt.id);
    } catch (error) {
      console.error('Error saving detail:', error);
      message.error(t('common.saveFailed'));
    }
  };

  const updateOrderDetailReceivedQuantity = async (orderDetailId: number, quantity: number) => {
    try {
      const { data, error } = await supabase
        .from(purchaseOrderDetailTable)
        .select('received_quantity, quantity, order_id')
        .eq('id', orderDetailId)
        .single();
      if (error) throw error;
      
      const newReceivedQty = (data.received_quantity || 0) + quantity;
      await supabase
        .from(purchaseOrderDetailTable)
        .update({ received_quantity: newReceivedQty as number })
        .eq('id', orderDetailId);
      
      if (data.order_id) {
        await updatePurchaseOrderStatus(data.order_id);
      }
    } catch (error) {
      console.error('Error updating order detail:', error);
    }
  };

  const updatePurchaseOrderStatus = async (orderId: number) => {
    try {
      const { data, error } = await supabase
        .from(purchaseOrderDetailTable)
        .select('quantity, received_quantity')
        .eq('order_id', orderId)
        .eq('is_deleted', 'n');
      if (error) throw error;
      
      const allReceived = data.every(d => (d.received_quantity || 0) >= (d.quantity || 0));
      const someReceived = data.some(d => (d.received_quantity || 0) > 0);
      
      let status = 'approved';
      if (allReceived) {
        status = 'received';
      } else if (someReceived) {
        status = 'partially_received';
      }
      
      await supabase
        .from(purchaseOrderTable)
        .update({ status })
        .eq('id', orderId);
    } catch (error) {
      console.error('Error updating order status:', error);
    }
  };

  const updateReceiptTotal = async (receiptId: number) => {
    try {
      const { data, error } = await supabase
        .from(purchaseReceiptDetailTable)
        .select('amount')
        .eq('is_deleted', 'n')
        .eq('receipt_id', receiptId);
      if (error) throw error;
      
      const totalAmount = data?.reduce((sum, d) => sum + (d.amount || 0), 0) || 0;
      
      await supabase
        .from(purchaseReceiptTable)
        .update({ total_amount: totalAmount })
        .eq('id', receiptId);
      
      fetchReceipts();
    } catch (error) {
      console.error('Error updating receipt total:', error);
    }
  };

  const businessUser = { id: user?.profile.id, username: user?.profile.username };

  const runReceiptAction = async (action: 'submit' | 'approve' | 'post' | 'reverse_post', record: PurchaseReceipt) => {
    try {
      await runBusinessAction({ action, documentType: 'purchase_receipt', documentId: record.id, user: businessUser });
      const successText = action === 'submit' ? t('purchaseReceipts.submitSuccess') : action === 'approve' ? t('purchaseReceipts.approveSuccess') : action === 'post' ? t('purchaseReceipts.postSuccess') : t('purchaseReceipts.reversePostSuccess');
      message.success(successText);
      fetchReceipts();
      if (selectedReceipt?.id === record.id) {
        fetchDetails(record.id);
      }
    } catch (error: any) {
      console.error('Error running receipt action:', error);
      message.error(error?.message || t('purchaseReceipts.actionFailed'));
    }
  };
  const handleEdit = (record: PurchaseReceipt) => {
    setEditingReceipt(record);
    setSelectedOrderId(record.order_id || null);
    if (record.order_id) {
      fetchPurchaseOrderDetails(record.order_id);
    }
    const formValues = { ...record, receipt_date: dayjs(record.receipt_date) };
    form.setFieldsValue(formValues);
    setIsModalOpen(true);
  };

  const handleDelete = async (id: number) => {
    Modal.confirm({
      title: t('common.confirmDelete'),
      content: t('purchaseReceipts.deleteReceiptConfirm'),
      onOk: async () => {
        try {
          await logWithTiming('删除采购入库单', 'DELETE', async () => {
            const { error } = await supabase
              .from(purchaseReceiptTable)
              .update({ is_deleted: 'y' })
              .eq('id', id);
            if (error) throw error;
            await supabase
              .from(purchaseReceiptDetailTable)
              .update({ is_deleted: 'y' })
              .eq('receipt_id', id);
          });
          message.success(t('common.deleteSuccess'));
          fetchReceipts();
        } catch (error) {
          console.error('Error deleting receipt:', error);
          message.error(t('common.deleteFailed'));
        }
      },
    });
  };

  const handleAdd = async () => {
    setEditingReceipt(null);
    setSelectedOrderId(null);
    setPurchaseOrderDetails([]);
    form.setFieldsValue({
      receipt_no: await nextDocumentNo('purchase_receipt'),
      receipt_date: dayjs(new Date()),
      order_id: undefined,
      supplier_id: undefined,
      warehouse_id: undefined,
      total_amount: 0,
      remark: '',
      status: 'draft',
    });
    setIsModalOpen(true);
  };

  const handleAddDetail = async () => {
    setEditingDetail(null);
    detailForm.setFieldsValue({
      order_detail_id: undefined,
      product_id: undefined,
      quantity: 1,
      unit_price: 0,
      amount: 0,
      batch_no: '',
      expiry_date: '',
      remark: '',
    });
    await fetchPurchaseOrderDetails(selectedReceipt?.order_id || 0);
    setIsDetailModalOpen(true);
  };

  const handleEditDetail = (record: PurchaseReceiptDetail) => {
    setEditingDetail(record);    
    detailForm.setFieldsValue({...record,expiry_date: dayjs(record.expiry_date)});
    
    setIsDetailModalOpen(true);
  };

  const handleDeleteDetail = async (id: number) => {
    Modal.confirm({
      title: t('common.confirmDelete'),
      content: t('purchaseReceipts.deleteDetailConfirm'),
      onOk: async () => {
        try {
          await supabase
            .from(purchaseReceiptDetailTable)
            .update({ is_deleted: 'y' })
            .eq('id', id);
          message.success(t('common.deleteSuccess'));
          if (selectedReceipt) {
            fetchDetails(selectedReceipt.id);
            updateReceiptTotal(selectedReceipt.id);
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
      fetchPurchaseOrderDetails(value);
      const order = purchaseOrders.find(o => o.id === value);
      if (order) {
        form.setFieldsValue({ supplier_id: order.supplier_id });
      }
    } else {
      setPurchaseOrderDetails([]);
      form.setFieldsValue({ supplier_id: undefined });
    }
  };

  const getSupplierName = (supplierId: number | null) => {
    const supplier = suppliers.find((s) => s.id === supplierId);
    return supplier?.name || '-';
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
    return product?.purchase_price || 0;
  };

  const getWarehouseName = (warehouseId: number | null) => {
    const warehouse = warehouses.find((w) => w.id === warehouseId);
    return warehouse?.name || '-';
  };

  const getOrderNo = (orderId: number | null) => {
    const order = purchaseOrders.find((o) => o.id === orderId);
    return order?.order_no || '-';
  };

  const getOrderDetailInfo = (orderDetailId: number | null) => {
    const detail = purchaseOrderDetails.find((d) => d.id === orderDetailId);
    if (!detail) return null;
    const product = products.find((p) => p.id === detail.product_id);
    return {
      productName: product?.name || '-',
      unit: product?.unit || '-',
      remainingQty: (detail.quantity || 0) - (detail.received_quantity || 0),
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

  const receivableOrders = purchaseOrders.filter(
    (o) =>
      ['approved', 'partially_received'].includes(o.status || '') ||
      o.id === editingReceipt?.order_id,
  );

  const filteredReceipts = receipts.filter(
    (r) =>
      r.receipt_no.toLowerCase().includes(searchTerm.toLowerCase()) ||
      getSupplierName(r.supplier_id).toLowerCase().includes(searchTerm.toLowerCase()) ||
      getOrderNo(r.order_id).toLowerCase().includes(searchTerm.toLowerCase())
  );

  const statusLabels: Record<string, { text: string; color: string }> = {
    draft: { text: t('purchaseReceipts.statusDraft'), color: 'default' },
    pending: { text: t('purchaseReceipts.statusPending'), color: 'warning' },
    approved: { text: t('purchaseReceipts.statusApproved'), color: 'success' },
    posted: { text: t('purchaseReceipts.statusPosted'), color: 'success' },
    cancelled: { text: t('purchaseReceipts.statusCancelled'), color: 'error' },
  };

  const columns = [
    {
      title: t('purchaseReceipts.receiptNo'),
      dataIndex: 'receipt_no',
      key: 'receipt_no',
      width: 120,
    },
    {
      title: t('purchaseReceipts.orderTitle'),
      dataIndex: 'order_id',
      key: 'order_id',
      width: 120,
      render: (orderId: number) => getOrderNo(orderId),
    },
    {
      title: t('purchaseReceipts.supplier'),
      dataIndex: 'supplier_id',
      key: 'supplier_id',
      render: (supplierId: number) => getSupplierName(supplierId),
    },
    {
      title: t('purchaseReceipts.warehouse'),
      dataIndex: 'warehouse_id',
      key: 'warehouse_id',
      width: 120,
      render: (warehouseId: number) => getWarehouseName(warehouseId),
    },
    {
      title: t('purchaseReceipts.receiptDate'),
      dataIndex: 'receipt_date',
      key: 'receipt_date',
      width: 180,
    },
    {
      title: t('purchaseReceipts.amount'),
      dataIndex: 'total_amount',
      key: 'total_amount',
      width: 100,
      render: (amount: number) => `¥${(amount ?? 0).toLocaleString()}`,
    },
    {
      title: t('common.status'),
      dataIndex: 'status',
      key: 'status',
      width: 100,
      render: (status: string) => {
        const config = statusLabels[status] || { text: status, color: 'default' };
        return <Tag color={config.color}>{config.text}</Tag>;
      },
    },
    {
      title: t('common.actions'),
      key: 'action',
      width: 140,
      render: (_: any, record: PurchaseReceipt) => (
        <Space>
          {record.status === 'draft' && (
            <Button type="text" onClick={() => runReceiptAction('submit', record)} disabled={record.status !== 'draft'}>{t('purchaseReceipts.submit')}</Button>
          )}
          {record.status === 'pending' && (
            <Button type="text" onClick={() => runReceiptAction('approve', record)}>{t('purchaseReceipts.approve')}</Button>
          )}
          {record.status === 'approved' && (
            <Button type="text" onClick={() => runReceiptAction('post', record)}>{t('purchaseReceipts.post')}</Button>
          )}
          {record.status === 'posted' && (
            <Button type="text" onClick={() => runReceiptAction('reverse_post', record)}>{t('purchaseReceipts.reversePost')}</Button>
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
      title: t('purchaseReceipts.lineNo'),
      dataIndex: 'line_no',
      key: 'line_no',
    },
    {
      title: t('purchaseReceipts.sourceOrderDetail'),
      dataIndex: 'order_detail_id',
      key: 'order_detail_id',
      render: (_: any, record: PurchaseReceiptDetail) => {
        const info = getOrderDetailInfo(record.order_detail_id);
        return info ? <span>{info.productName} {t('purchaseReceipts.remaining', { qty: info.remainingQty, unit: info.unit })}</span> : '-';
      },
    },
    {
      title: t('purchaseReceipts.product'),
      dataIndex: 'product_id',
      key: 'product_id',
      render: (productId: number) => getProductName(productId),
    },
    {
      title: t('purchaseReceipts.unit'),
      dataIndex: 'product_id',
      key: 'unit',
      render: (productId: number) => getProductUnit(productId),
    },
    {
      title: t('purchaseReceipts.quantity'),
      dataIndex: 'quantity',
      key: 'quantity',
      render: (qty: number) => qty?.toLocaleString() || '0',
    },
    {
      title: t('purchaseReceipts.unitPrice'),
      dataIndex: 'unit_price',
      key: 'unit_price',
      render: (price: number) => `¥${(price ?? 0).toFixed(2)}`,
    },
    {
      title: t('purchaseReceipts.amount'),
      dataIndex: 'amount',
      key: 'amount',
      render: (amount: number) => `¥${(amount ?? 0).toFixed(2)}`,
    },
    {
      title: t('purchaseReceipts.batchNo'),
      dataIndex: 'batch_no',
      key: 'batch_no',
      render: (text: string) => text || '-',
    },
    {
      title: t('purchaseReceipts.expiryDate'),
      dataIndex: 'expiry_date',
      key: 'expiry_date',
      render: (text: string) => text || '-',
    },
    {
      title: t('common.actions'),
      key: 'action',
      render: (_: any, record: PurchaseReceiptDetail) => (
        <Space size="middle">
          <Button type="text" icon={<EditOutlined />} onClick={() => handleEditDetail(record)}>
            {t('common.edit')}
          </Button>
          <Button type="text" danger icon={<DeleteOutlined />} onClick={() => handleDeleteDetail(record.id)}>
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
        dataSource={filteredReceipts}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 10 }}
        storageKey="purchase-receipts"
        tableName={purchaseReceiptTable}
        headerTitle={t('purchaseReceipts.title')}
        rowSelection={{
          selectedRowKeys,
          onChange: setSelectedRowKeys,
        }}
        queryBar={
          <Space wrap>
            <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
              {t('purchaseReceipts.addReceipt')}
            </Button>
            <Input.Search
              allowClear
              placeholder={t('purchaseReceipts.searchPlaceholder')}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              onSearch={fetchReceipts}
              style={{ width: 280 }}
            />
          </Space>
        }
      />

      <SupaModal
        title={editingReceipt ? t('purchaseReceipts.editReceiptTitle') : t('purchaseReceipts.addReceiptTitle')}
        open={isModalOpen}
        onCancel={() => {
          setIsModalOpen(false);
          form.resetFields();
          setEditingReceipt(null);
          setSelectedOrderId(null);
          setPurchaseOrderDetails([]);
        }}
        headerPanelTitle={t('purchaseReceipts.headerPanelTitle')}
        detailPanelTitle={t('purchaseReceipts.detailPanelTitle')}
        historyTable={purchaseReceiptTable}
        historyRecordId={editingReceipt?.id}
        workflowDocumentType="purchase_receipt"
        onDataChanged={fetchReceipts}
        form={form}
        detailData={details}
        detailExtra={
         <Button type="link" size='small' icon={<PlusOutlined />} onClick={handleAddDetail}>{t('purchaseReceipts.addDetail')}</Button>
        }
        formEle={
          <Form form={form} layout="vertical" onFinish={handleSubmit} style={{ marginRight: 16 }}>
            <Row gutter={16}>
              <Col span={12}>
                <Form.Item
                  label={t('purchaseReceipts.receiptNo')}
                  name="receipt_no"
                  rules={[{ required: true, message: t('purchaseReceipts.receiptNoPrompt') }]}
                >
                  <Input placeholder={t('purchaseReceipts.receiptNoPrompt')} disabled={!!editingReceipt} />
                </Form.Item>
                <Form.Item
                  label={t('purchaseReceipts.orderLabel')}
                  name="order_id"
                >
                  <Select
                    placeholder={t('purchaseReceipts.orderPlaceholder')}
                    onChange={handleOrderChange}
                    allowClear
                  >
                    {receivableOrders.map((o) => (
                      <Option key={o.id} value={o.id}>{o.order_no}</Option>
                    ))}
                  </Select>
                </Form.Item>
                <Form.Item
                  label={t('purchaseReceipts.supplier')}
                  name="supplier_id"
                  rules={[{ required: true, message: t('purchaseReceipts.supplierPrompt') }]}
                >
                  <Select placeholder={t('purchaseReceipts.supplierPrompt')}>
                    {suppliers.map((s) => (
                      <Option key={s.id} value={s.id}>{s.name}</Option>
                    ))}
                  </Select>
                </Form.Item>
                <Form.Item
                  label={t('purchaseReceipts.warehouse')}
                  name="warehouse_id"
                  rules={[{ required: true, message: t('purchaseReceipts.warehousePrompt') }]}
                >
                  <Select placeholder={t('purchaseReceipts.warehousePrompt')}>
                    {warehouses.map((w) => (
                      <Option key={w.id} value={w.id}>{w.name}</Option>
                    ))}
                  </Select>
                </Form.Item>
                <Form.Item
                  label={t('purchaseReceipts.receiptDate')}
                  name="receipt_date"
                  rules={[{ required: true, message: t('purchaseReceipts.receiptDatePrompt') }]}
                >
                  <DatePicker />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item label={t('purchaseReceipts.totalAmount')} name="total_amount" initialValue={0}>
                  <InputNumber disabled style={{ width: '100%' }} />
                </Form.Item>
                <Form.Item label={t('purchaseReceipts.remark')} name="remark">
                  <TextArea rows={4} placeholder={t('purchaseReceipts.remarkPrompt')} />
                </Form.Item>
                <Form.Item label={t('common.status')} name="status" initialValue="draft">
                  <Select>
                    <Option value="draft">{t('purchaseReceipts.statusDraft')}</Option>
                    <Option value="pending">{t('purchaseReceipts.statusPending')}</Option>
                    <Option value="approved">{t('purchaseReceipts.statusApproved')}</Option>
                    <Option value="cancelled">{t('purchaseReceipts.statusCancelled')}</Option>
                  </Select>
                </Form.Item>
              </Col>
            </Row>
          </Form>
        }
        tableEle={<Table
          columns={detailColumns}
          dataSource={details}
          rowKey="id"
          pagination={false}
          summary={() => (
            <Table.Summary.Row>
              <Table.Summary.Cell index={0} colSpan={6} align="right"><strong>{t('purchaseReceipts.totalText')}</strong></Table.Summary.Cell>
              <Table.Summary.Cell index={1} align="right"><strong>¥{detailTotal.amount.toFixed(2)}</strong></Table.Summary.Cell>
              <Table.Summary.Cell index={2} colSpan={3}></Table.Summary.Cell>
            </Table.Summary.Row>
          )}
        />}
        footer={
          <Space>
            <Button onClick={() => setIsModalOpen(false)}>{t('common.cancel')}</Button>
            <Button type="primary" onClick={() => form.submit()}>
              {t('common.save')}
            </Button>
          </Space>
        }
        width={'70%'}
        height={600}
      />

      <SimpleModal  
        title={editingDetail ? t('purchaseReceipts.editDetailTitle') : t('purchaseReceipts.addDetailTitle')}
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
            label={t('purchaseReceipts.orderDetail')}
            name="order_detail_id"
          >
            <Select 
              placeholder={t('purchaseReceipts.orderDetailPlaceholder')}
              onChange={handleOrderDetailChange}
              allowClear
            >
              {purchaseOrderDetails
                .filter(
                  (d) =>
                    (d.quantity || 0) - (d.received_quantity || 0) > 0 ||
                    d.id === editingDetail?.order_detail_id,
                )
                .map((d) => {
                  const remaining = (d.quantity || 0) - (d.received_quantity || 0);
                  const product = products.find((p) => p.id === d.product_id);
                  return (
                    <Option key={d.id} value={d.id}>
                      {product?.code} - {product?.name} {t('purchaseReceipts.remaining', { qty: remaining, unit: product?.unit })}
                    </Option>
                  );
                })}
            </Select>
          </Form.Item>
          <Form.Item
            label={t('purchaseReceipts.product')}
            name="product_id"
            rules={[{ required: true, message: t('purchaseReceipts.productPrompt') }]}
          >
            <Select 
              placeholder={t('purchaseReceipts.productPrompt')} 
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
                label={t('purchaseReceipts.quantity')}
                name="quantity"
                rules={[{ required: true, message: t('purchaseReceipts.quantityPrompt') }]}
              >
                <InputNumber min={1} style={{ width: '100%' }} placeholder={t('purchaseReceipts.quantityPrompt')} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                label={t('purchaseReceipts.unitPrice')}
                name="unit_price"
                rules={[{ required: true, message: t('purchaseReceipts.unitPricePrompt') }]}
              >
                <InputNumber min={0} step={0.01} style={{ width: '100%' }} placeholder={t('purchaseReceipts.unitPricePrompt')} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item label={t('purchaseReceipts.batchNo')} name="batch_no">
                <Input placeholder={t('purchaseReceipts.batchNoPrompt')} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label={t('purchaseReceipts.expiryDate')} name="expiry_date">
                <DatePicker />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item label={t('purchaseReceipts.remark')} name="remark">
            <Input placeholder={t('purchaseReceipts.remarkPrompt')} />
          </Form.Item>
        </Form>
      </SimpleModal>
    </div>
  );
}

