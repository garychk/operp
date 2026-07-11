import { useEffect, useState } from 'react';
import { Button, Input, Table, Tag, Modal, Form, Select, Space, Card, message, InputNumber, Row, Col, DatePicker } from 'antd';
import { PlusOutlined, SearchOutlined, DeleteOutlined, EditOutlined, EyeOutlined } from '@ant-design/icons';
import { supabase } from '../../utils/supabase';
import { logWithTiming } from '../../utils/logger';
import { runBusinessAction } from '../../utils/businessEngine';
import { useAuth } from '../../contexts/AuthContext';
import type { Tables } from '../../utils/supabase';
import dayjs from 'dayjs';
import SupaModal from '../../components/SupaModal';

type PurchaseReceipt = Tables['erp_purchase_receipts_s_539dcf81_b']['Row'];
type PurchaseReceiptDetail = Tables['erp_purchase_receipt_details_s_539dcf81_b']['Row'];
type PurchaseOrder = Tables['erp_purchase_orders_s_539dcf81_b']['Row'];
type PurchaseOrderDetail = Tables['erp_purchase_order_details_s_539dcf81_b']['Row'];
type Supplier = Tables['erp_suppliers_s_539dcf81_b']['Row'];
type Product = Tables['erp_products_s_539dcf81_b']['Row'];
type Warehouse = Tables['erp_warehouses_s_539dcf81_b']['Row'];

const { Option } = Select;
const { TextArea } = Input;

export function PurchaseReceipts() {
  const [receipts, setReceipts] = useState<PurchaseReceipt[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [purchaseOrders, setPurchaseOrders] = useState<PurchaseOrder[]>([]);
  const [purchaseOrderDetails, setPurchaseOrderDetails] = useState<PurchaseOrderDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isDetailModalOpen, setIsDetailModalOpen] = useState(false);
  const [editingReceipt, setEditingReceipt] = useState<PurchaseReceipt | null>(null);
  const [selectedReceipt, setSelectedReceipt] = useState<PurchaseReceipt | null>(null);
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
        .from('erp_purchase_receipts_s_539dcf81_b')
        .select('*')
        .eq('is_deleted', 'n')
        .order('receipt_date', { ascending: false });

      if (error) throw error;
      setReceipts(data || []);
    } catch (error) {
      console.error('Error fetching receipts:', error);
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
        .from('erp_purchase_orders_s_539dcf81_b')
        .select('*')
        .eq('is_deleted', 'n')
        // .in('status', ['approved']);
        // .in('status', ['approved', 'partially_received']);
      if (error) throw error;
      setPurchaseOrders(data || []);
    } catch (error) {
      console.error('Error fetching purchase orders:', error);
    }
  };

  const fetchPurchaseOrderDetails = async (orderId: number) => {
    try {
      const { data, error } = await supabase
        .from('erp_purchase_order_details_s_539dcf81_b')
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
        .from('erp_purchase_receipt_details_s_539dcf81_b')
        .select('*')
        .eq('is_deleted', 'n')
        .eq('receipt_id', receiptId)
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
      if (editingReceipt) {
        await logWithTiming('更新采购入库单', 'UPDATE', async () => {
          const { error } = await supabase
            .from('erp_purchase_receipts_s_539dcf81_b')
            .update(values)
            .eq('id', editingReceipt.id);
          if (error) throw error;
        });
        message.success('更新成功');
      } else {
        await logWithTiming('新增采购入库单', 'INSERT', async () => {
          const { error } = await supabase
            .from('erp_purchase_receipts_s_539dcf81_b')
            .insert([values]);
          if (error) throw error;
        });
        message.success('新增成功');
      }
      setIsModalOpen(false);
      form.resetFields();
      setEditingReceipt(null);
      setSelectedOrderId(null);
      fetchReceipts();
    } catch (error) {
      console.error('Error saving receipt:', error);
      message.error('保存失败');
    }
  };

  const handleDetailSubmit = async (values: any) => {
    try {
      if (!selectedReceipt) return;
      
      values.amount = (values.quantity || 0) * (values.unit_price || 0);
      
      if (editingDetail) {
        await supabase
          .from('erp_purchase_receipt_details_s_539dcf81_b')
          .update(values)
          .eq('id', editingDetail.id);
        message.success('更新成功');
      } else {
        const maxLineNo = details.length > 0 ? Math.max(...details.map(d => d.line_no)) : 0;
        values.line_no = maxLineNo + 1;
        values.receipt_id = selectedReceipt.id;
        values.is_deleted = 'n';
        
        console.log('PurchaseReceipts: Inserting detail with values:', values);
        const { data, error } = await supabase
          .from('erp_purchase_receipt_details_s_539dcf81_b')
          .insert([values]);
        console.log('PurchaseReceipts: Insert result:', data, error);
        if (error) throw error;
        message.success('新增成功');
        
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
      message.error('保存失败');
    }
  };

  const updateOrderDetailReceivedQuantity = async (orderDetailId: number, quantity: number) => {
    try {
      const { data, error } = await supabase
        .from('erp_purchase_order_details_s_539dcf81_b')
        .select('received_quantity, quantity, order_id')
        .eq('id', orderDetailId)
        .single();
      if (error) throw error;
      
      const newReceivedQty = (data.received_quantity || 0) + quantity;
      await supabase
        .from('erp_purchase_order_details_s_539dcf81_b')
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
        .from('erp_purchase_order_details_s_539dcf81_b')
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
        .from('erp_purchase_orders_s_539dcf81_b')
        .update({ status })
        .eq('id', orderId);
    } catch (error) {
      console.error('Error updating order status:', error);
    }
  };

  const updateReceiptTotal = async (receiptId: number) => {
    try {
      const { data, error } = await supabase
        .from('erp_purchase_receipt_details_s_539dcf81_b')
        .select('amount')
        .eq('is_deleted', 'n')
        .eq('receipt_id', receiptId);
      if (error) throw error;
      
      const totalAmount = data?.reduce((sum, d) => sum + (d.amount || 0), 0) || 0;
      
      await supabase
        .from('erp_purchase_receipts_s_539dcf81_b')
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
      const successText = action === 'submit' ? '提交审批成功' : action === 'approve' ? '审核成功' : action === 'post' ? '过账成功' : '反过账成功';
      message.success(successText);
      fetchReceipts();
      if (selectedReceipt?.id === record.id) {
        fetchDetails(record.id);
      }
    } catch (error: any) {
      console.error('Error running receipt action:', error);
      message.error(error?.message || '操作失败');
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
      title: '确认删除',
      content: '确定要删除该入库单吗？',
      onOk: async () => {
        try {
          await logWithTiming('删除采购入库单', 'DELETE', async () => {
            const { error } = await supabase
              .from('erp_purchase_receipts_s_539dcf81_b')
              .update({ is_deleted: 'y' })
              .eq('id', id);
            if (error) throw error;
            await supabase
              .from('erp_purchase_receipt_details_s_539dcf81_b')
              .update({ is_deleted: 'y' })
              .eq('receipt_id', id);
          });
          message.success('删除成功');
          fetchReceipts();
        } catch (error) {
          console.error('Error deleting receipt:', error);
          message.error('删除失败');
        }
      },
    });
  };

  const handleAdd = () => {
    setEditingReceipt(null);
    setSelectedOrderId(null);
    setPurchaseOrderDetails([]);
    form.setFieldsValue({
      receipt_no: `PR${Date.now().toString().slice(-8)}`,
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

  const handleViewDetails = (record: PurchaseReceipt) => {
    setSelectedReceipt(record);
    fetchDetails(record.id);
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
      title: '确认删除',
      content: '确定要删除该明细吗？',
      onOk: async () => {
        try {
          await supabase
            .from('erp_purchase_receipt_details_s_539dcf81_b')
            .update({ is_deleted: 'y' })
            .eq('id', id);
          message.success('删除成功');
          if (selectedReceipt) {
            fetchDetails(selectedReceipt.id);
            updateReceiptTotal(selectedReceipt.id);
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

  const filteredReceipts = receipts.filter(
    (r) =>
      r.receipt_no.toLowerCase().includes(searchTerm.toLowerCase()) ||
      getSupplierName(r.supplier_id).toLowerCase().includes(searchTerm.toLowerCase()) ||
      getOrderNo(r.order_id).toLowerCase().includes(searchTerm.toLowerCase())
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
      title: '入库单号',
      dataIndex: 'receipt_no',
      key: 'receipt_no',
    },
    {
      title: '采购订单',
      dataIndex: 'order_id',
      key: 'order_id',
      render: (orderId: number) => getOrderNo(orderId),
    },
    {
      title: '供应商',
      dataIndex: 'supplier_id',
      key: 'supplier_id',
      render: (supplierId: number) => getSupplierName(supplierId),
    },
    {
      title: '仓库',
      dataIndex: 'warehouse_id',
      key: 'warehouse_id',
      render: (warehouseId: number) => getWarehouseName(warehouseId),
    },
    {
      title: '入库日期',
      dataIndex: 'receipt_date',
      key: 'receipt_date',
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
      render: (_: any, record: PurchaseReceipt) => (
        <Space>
          {record.status === 'draft' && (
            <Button type="text" onClick={() => runReceiptAction('submit', record)}>提交</Button>
          )}
          {record.status === 'pending' && (
            <Button type="text" onClick={() => runReceiptAction('approve', record)}>审核</Button>
          )}
          {record.status === 'approved' && (
            <Button type="text" onClick={() => runReceiptAction('post', record)}>过账</Button>
          )}
          {record.status === 'posted' && (
            <Button type="text" onClick={() => runReceiptAction('reverse_post', record)}>反过账</Button>
          )}
          <Button type="text" icon={<EyeOutlined />} onClick={() => handleViewDetails(record)}>明细</Button>
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
      render: (_: any, record: PurchaseReceiptDetail) => {
        const info = getOrderDetailInfo(record.order_detail_id);
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
      title: '有效期',
      dataIndex: 'expiry_date',
      key: 'expiry_date',
      render: (text: string) => text || '-',
    },
    {
      title: '操作',
      key: 'action',
      render: (_: any, record: PurchaseReceiptDetail) => (
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
    <Card variant="borderless" title="采购入库单" extra={
      <Space>
        <Input
          placeholder="搜索入库单号、供应商或采购订单..."
          prefix={<SearchOutlined />}
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
        />
        <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>新增入库单</Button>
      </Space>}>
      <Table
        columns={columns}
        dataSource={filteredReceipts}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 10 }}
      />

      <SupaModal
        title={editingReceipt ? '编辑采购入库单' : '新增采购入库单'}
        open={isModalOpen}
        onCancel={() => {
          setIsModalOpen(false);
          form.resetFields();
          setEditingReceipt(null);
          setSelectedOrderId(null);
          setPurchaseOrderDetails([]);
        }}
        footer={<Space>
          <Button onClick={() => setIsModalOpen(false)}>取消</Button>
          <Button type="primary" onClick={() => form.submit()}>
            保存
          </Button>
        </Space>}
        width={'70%'}
        height={600}
        historyTable={"erp_purchase_receipts_s_539dcf81_b"}
        historyRecordId={editingReceipt?.id}
        form={form}
        detailData={details}
        detailExtra={
         <Button type="link" size='small' icon={<PlusOutlined />} onClick={handleAddDetail}>新增明细</Button>
        }
        formEle={
          <Form form={form} layout="vertical" onFinish={handleSubmit} style={{ marginRight: 16 }}>
            <Row gutter={16}>
              <Col span={12}>
                <Form.Item
                  label="入库单号"
                  name="receipt_no"
                  rules={[{ required: true, message: '请输入入库单号' }]}
                >
                  <Input placeholder="请输入入库单号" disabled={!!editingReceipt} />
                </Form.Item>
                <Form.Item
                  label="关联采购订单"
                  name="order_id"
                >
                  <Select
                    placeholder="请选择采购订单"
                    onChange={handleOrderChange}
                    allowClear
                  >
                    {purchaseOrders.map((o) => (
                      <Option key={o.id} value={o.id}>{o.order_no}</Option>
                    ))}
                  </Select>
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
                  label="入库日期"
                  name="receipt_date"
                  rules={[{ required: true, message: '请选择入库日期' }]}
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
              <Table.Summary.Cell index={2} colSpan={3}></Table.Summary.Cell>
            </Table.Summary.Row>
          )}
        />}
      >
       
      </SupaModal>

      <Modal
        title={editingDetail ? '编辑采购入库明细' : '新增采购入库明细'}
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
              placeholder="选择关联的采购订单明细"
              onChange={handleOrderDetailChange}
              allowClear
            >
              {purchaseOrderDetails.map((d) => {
                const remaining = (d.quantity || 0) - (d.received_quantity || 0);
                // if (remaining <= 0) return null;
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
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item label="批次号" name="batch_no">
                <Input placeholder="请输入批次号" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label="有效期" name="expiry_date">
                <DatePicker />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item label="备注" name="remark">
            <Input placeholder="请输入备注" />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}

