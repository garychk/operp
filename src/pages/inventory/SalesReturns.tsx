import { useEffect, useMemo, useState } from 'react';
import type { Key } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Input, Table, Tag, Modal, Form, Select, Space, message, InputNumber, Row, Col, DatePicker, Alert } from 'antd';
import { PlusOutlined, DeleteOutlined, EditOutlined, ThunderboltOutlined, UndoOutlined, ImportOutlined } from '@ant-design/icons';
import { supabase } from '../../utils/supabase';
import { logWithTiming } from '../../utils/logger';
import { runBusinessAction } from '../../utils/businessEngine';
import { useAuth } from '../../contexts/AuthContext';
import type { Tables } from '../../utils/supabase';
import { nextDocumentNo } from '../../utils/documentNaming';
import { collectVoucherNotices, type InventoryVoucherResult } from '../../utils/inventoryVoucher';
import dayjs from 'dayjs';
import { SupaModal, buildModalNav } from '../../components/SupaModal';
import { BizAttachments } from '../../components/BizAttachments';
import { SuperTable } from '../../components/SuperTable';
import { formatMoney, useCurrencyRegistry, currencyLabel } from '../../utils/money';
import { ProductUnit } from '../../components/ProductUnit';
import SimpleModal from '../../components/SimpleModal';
import { WarehouseBinSelect } from '../../components/WarehouseBinSelect';
import { BinName } from '../../components/BinName';

/**
 * 销售退货单（P1-2）。
 *
 * 过账走 post_stock_document（deploy_93），方向 **in**：
 *   · 库存按**原出货成本**回库（不是销售价，避免虚增存货）—— RPC 会去
 *     erp_inventory_transactions 里找原销售的出库成本，找不到才退回当前移动加权
 *   · 同时写一条**红字应收**（负数 erp_receivables），不改原出货单
 * 明细的 unit_price 只用于红字应收金额（= 退货售价），与存货入账价值无关。
 */
type SalesReturn = Tables['erp_sales_returns_s_539dcf81_b']['Row'];
type SalesReturnDetail = Tables['erp_sales_return_details_s_539dcf81_b']['Row'];
type SalesDelivery = Tables['erp_sales_deliveries_s_539dcf81_b']['Row'];
type SalesDeliveryDetail = Tables['erp_sales_delivery_details_s_539dcf81_b']['Row'];
type Customer = Tables['erp_customers_s_539dcf81_b']['Row'];
type Product = Tables['erp_products_s_539dcf81_b']['Row'];
type Warehouse = Tables['erp_warehouses_s_539dcf81_b']['Row'];

const { Option } = Select;
const { TextArea } = Input;

const returnTable = 'erp_sales_returns_s_539dcf81_b';
const returnDetailTable = 'erp_sales_return_details_s_539dcf81_b';
const deliveryTable = 'erp_sales_deliveries_s_539dcf81_b';
const deliveryDetailTable = 'erp_sales_delivery_details_s_539dcf81_b';

const DOCUMENT_TYPE = 'sales_return' as const;
const POSTABLE_STATUSES = ['draft', 'approved'];
const POSTED_STATUS = 'posted';

const isPosted = (record: { status: string | null }) => record.status === POSTED_STATUS;

export function SalesReturns() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { baseCurrency } = useCurrencyRegistry();
  const baseCurrencyCode = (baseCurrency || 'CNY').toUpperCase();

  const [returns, setReturns] = useState<SalesReturn[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [deliveries, setDeliveries] = useState<SalesDelivery[]>([]);
  const [deliveryDetails, setDeliveryDetails] = useState<SalesDeliveryDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedRowKeys, setSelectedRowKeys] = useState<Key[]>([]);
  const [posting, setPosting] = useState(false);
  const [reversing, setReversing] = useState(false);

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isDetailModalOpen, setIsDetailModalOpen] = useState(false);
  const [editingReturn, setEditingReturn] = useState<SalesReturn | null>(null);
  const [selectedReturn, setSelectedReturn] = useState<SalesReturn | null>(null);
  const [details, setDetails] = useState<SalesReturnDetail[]>([]);
  const [editingDetail, setEditingDetail] = useState<SalesReturnDetail | null>(null);
  const [headerWarehouseId, setHeaderWarehouseId] = useState<number | undefined>();

  const [form] = Form.useForm();
  const [detailForm] = Form.useForm();
  const watchedWarehouseId = Form.useWatch('warehouse_id', form);
  const watchedDeliveryId = Form.useWatch('delivery_id', form);

  useEffect(() => {
    fetchReturns();
    fetchCustomers();
    fetchProducts();
    fetchWarehouses();
    fetchDeliveries();
  }, []);

  const fetchReturns = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from(returnTable)
        .select('*')
        .eq('is_deleted', 'n')
        .order('return_date', { ascending: false });
      if (error) throw error;
      setReturns(data || []);
    } catch (error) {
      console.error('Error fetching sales returns:', error);
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
      const { data, error } = await supabase.from('erp_products_s_539dcf81_b').select('*').eq('is_deleted', 'n');
      if (error) throw error;
      setProducts(data || []);
    } catch (error) {
      console.error('Error fetching products:', error);
    }
  };

  const fetchWarehouses = async () => {
    try {
      const { data, error } = await supabase.from('erp_warehouses_s_539dcf81_b').select('*').eq('is_deleted', 'n');
      if (error) throw error;
      setWarehouses(data || []);
    } catch (error) {
      console.error('Error fetching warehouses:', error);
    }
  };

  const fetchDeliveries = async () => {
    try {
      const { data, error } = await supabase.from(deliveryTable).select('*').eq('is_deleted', 'n');
      if (error) throw error;
      setDeliveries(data || []);
    } catch (error) {
      console.error('Error fetching sales deliveries:', error);
    }
  };

  const fetchDeliveryDetails = async (deliveryId: number) => {
    try {
      const { data, error } = await supabase
        .from(deliveryDetailTable)
        .select('*')
        .eq('is_deleted', 'n')
        .eq('delivery_id', deliveryId)
        .order('line_no');
      if (error) throw error;
      setDeliveryDetails(data || []);
    } catch (error) {
      console.error('Error fetching delivery details:', error);
    }
  };

  const fetchDetails = async (returnId: number) => {
    try {
      const { data, error } = await supabase
        .from(returnDetailTable)
        .select('*')
        .eq('is_deleted', 'n')
        .eq('return_id', returnId)
        .order('line_no');
      if (error) throw error;
      setDetails(data || []);
    } catch (error) {
      console.error('Error fetching sales return details:', error);
      message.error(t('salesReturns.fetchDetailsFailed'));
    }
  };

  const sumAmount = (rows: { amount: number | null }[]) => rows.reduce((sum, d) => sum + (d.amount || 0), 0);

  const updateReturnTotal = async (returnId: number) => {
    try {
      const { data, error } = await supabase
        .from(returnDetailTable)
        .select('amount')
        .eq('is_deleted', 'n')
        .eq('return_id', returnId);
      if (error) throw error;
      const total = sumAmount(data || []);
      await supabase.from(returnTable).update({ total_amount: total }).eq('id', returnId);
      form.setFieldValue('total_amount', total);
      fetchReturns();
    } catch (error) {
      console.error('Error updating sales return total:', error);
    }
  };

  const handleSubmit = async (values: any) => {
    try {
      const payload = { ...values, total_amount: sumAmount(details) };
      if (editingReturn) {
        await logWithTiming('更新销售退货单', 'UPDATE', async () => {
          const { error } = await supabase.from(returnTable).update(payload).eq('id', editingReturn.id);
          if (error) throw error;
        }, { table: returnTable, recordId: editingReturn.id });
        message.success(t('common.updateSuccess'));
      } else {
        await logWithTiming('新增销售退货单', 'INSERT', async () => {
          const { error } = await supabase.from(returnTable).insert([payload]);
          if (error) throw error;
        }, { table: returnTable });
        message.success(t('common.createSuccess'));
      }
      setIsModalOpen(false);
      form.resetFields();
      setEditingReturn(null);
      setHeaderWarehouseId(undefined);
      fetchReturns();
    } catch (error) {
      console.error('Error saving sales return:', error);
      message.error(t('common.saveFailed'));
    }
  };

  const handleDetailSubmit = async (values: any) => {
    try {
      if (!selectedReturn) {
        message.warning(t('salesReturns.saveHeaderFirst'));
        return;
      }
      values.amount = Number(values.quantity || 0) * Number(values.unit_price || 0);

      if (editingDetail) {
        await supabase.from(returnDetailTable).update(values).eq('id', editingDetail.id);
        message.success(t('common.updateSuccess'));
      } else {
        const maxLineNo = details.length > 0 ? Math.max(...details.map((d) => d.line_no || 0)) : 0;
        values.return_id = selectedReturn.id;
        values.line_no = maxLineNo + 1;
        values.is_deleted = 'n';
        const { error } = await supabase.from(returnDetailTable).insert([values]);
        if (error) throw error;
        message.success(t('common.createSuccess'));
      }
      setIsDetailModalOpen(false);
      detailForm.resetFields();
      setEditingDetail(null);
      fetchDetails(selectedReturn.id);
      updateReturnTotal(selectedReturn.id);
    } catch (error) {
      console.error('Error saving sales return detail:', error);
      message.error(t('common.saveFailed'));
    }
  };

  const handleEdit = async (record: SalesReturn) => {
    if (isPosted(record)) {
      message.warning(t('salesReturns.postedLocked'));
      return;
    }
    setEditingReturn(record);
    setSelectedReturn(record);
    setHeaderWarehouseId(record.warehouse_id ?? undefined);
    form.setFieldsValue({ ...record, return_date: dayjs(record.return_date) });
    await fetchDetails(record.id);
    if (record.delivery_id) await fetchDeliveryDetails(record.delivery_id);
    setIsModalOpen(true);
  };

  const handleDelete = async (id: number) => {
    const target = returns.find((r) => r.id === id);
    if (target && isPosted(target)) {
      message.warning(t('salesReturns.postedLocked'));
      return;
    }
    Modal.confirm({
      title: t('common.confirmDelete'),
      content: t('salesReturns.deleteConfirm'),
      onOk: async () => {
        try {
          await logWithTiming('删除销售退货单', 'DELETE', async () => {
            const { error } = await supabase.from(returnTable).update({ is_deleted: 'y' }).eq('id', id);
            if (error) throw error;
            const { error: detailError } = await supabase
              .from(returnDetailTable)
              .update({ is_deleted: 'y' })
              .eq('return_id', id);
            if (detailError) throw detailError;
          }, { table: returnTable, recordId: id });
          message.success(t('common.deleteSuccess'));
          fetchReturns();
        } catch (error) {
          console.error('Error deleting sales return:', error);
          message.error(t('common.deleteFailed'));
        }
      },
    });
  };

  const handleAdd = async () => {
    let returnNo: string;
    try {
      returnNo = await nextDocumentNo(DOCUMENT_TYPE);
    } catch (error) {
      message.error(`${t('common.documentNoFailed')}：${(error as Error).message}`);
      return;
    }
    setEditingReturn(null);
    setSelectedReturn(null);
    setDetails([]);
    setDeliveryDetails([]);
    setHeaderWarehouseId(undefined);
    form.setFieldsValue({
      return_no: returnNo,
      return_date: dayjs(new Date()),
      delivery_id: undefined,
      customer_id: undefined,
      warehouse_id: undefined,
      location_id: undefined,
      currency: baseCurrencyCode,
      total_amount: 0,
      reason: '',
      status: 'draft',
    });
    setIsModalOpen(true);
  };

  const handleAddDetail = () => {
    if (!selectedReturn) {
      message.warning(t('salesReturns.saveHeaderFirst'));
      return;
    }
    if (isPosted(selectedReturn)) {
      message.warning(t('salesReturns.postedLocked'));
      return;
    }
    setEditingDetail(null);
    detailForm.setFieldsValue({
      delivery_detail_id: undefined,
      product_id: undefined,
      quantity: 1,
      unit_price: 0,
      amount: 0,
      batch_no: '',
      location_id: undefined,
      expiry_date: undefined,
      reason: '',
    });
    setIsDetailModalOpen(true);
  };

  const handleEditDetail = (record: SalesReturnDetail) => {
    if (selectedReturn && isPosted(selectedReturn)) {
      message.warning(t('salesReturns.postedLocked'));
      return;
    }
    setEditingDetail(record);
    detailForm.setFieldsValue({ ...record, expiry_date: record.expiry_date ? dayjs(record.expiry_date) : undefined });
    setIsDetailModalOpen(true);
  };

  const handleDeleteDetail = async (id: number) => {
    if (selectedReturn && isPosted(selectedReturn)) {
      message.warning(t('salesReturns.postedLocked'));
      return;
    }
    Modal.confirm({
      title: t('common.confirmDelete'),
      content: t('salesReturns.deleteDetailConfirm'),
      onOk: async () => {
        try {
          await supabase.from(returnDetailTable).update({ is_deleted: 'y' }).eq('id', id);
          message.success(t('common.deleteSuccess'));
          if (selectedReturn) {
            fetchDetails(selectedReturn.id);
            updateReturnTotal(selectedReturn.id);
          }
        } catch (error) {
          console.error('Error deleting sales return detail:', error);
          message.error(t('common.deleteFailed'));
        }
      },
    });
  };

  const handleDeliveryChange = async (value: number | null) => {
    if (!value) {
      setDeliveryDetails([]);
      return;
    }
    const delivery = deliveries.find((d) => d.id === value);
    if (delivery) {
      form.setFieldsValue({
        customer_id: delivery.customer_id,
        warehouse_id: delivery.warehouse_id,
        location_id: delivery.location_id ?? undefined,
        currency: delivery.currency || baseCurrencyCode,
      });
      setHeaderWarehouseId(delivery.warehouse_id ?? undefined);
    }
    await fetchDeliveryDetails(value);
  };

  const getDeliveryDetailInfo = (deliveryDetailId: number | null) => {
    const detail = deliveryDetails.find((d) => d.id === deliveryDetailId);
    if (!detail) return null;
    const product = products.find((p) => p.id === detail.product_id);
    return {
      productId: detail.product_id,
      maxQty: detail.quantity || 0,
      unitPrice: detail.unit_price || 0,
      batchNo: detail.batch_no || '',
      locationId: detail.location_id ?? null,
      label: product ? `${product.code} - ${product.name}` : '-',
    };
  };

  const handleDeliveryDetailChange = (value: number | null) => {
    const info = getDeliveryDetailInfo(value);
    if (info) {
      detailForm.setFieldsValue({
        product_id: info.productId,
        quantity: info.maxQty,
        unit_price: info.unitPrice,
        amount: info.maxQty * info.unitPrice,
        batch_no: info.batchNo,
        location_id: info.locationId ?? undefined,
      });
    }
  };

  const getCustomerName = (customerId: number | null) =>
    customers.find((c) => c.id === customerId)?.name || '-';
  const getWarehouseName = (warehouseId: number | null) =>
    warehouses.find((w) => w.id === warehouseId)?.name || '-';
  const getProductName = (productId: number | null) => {
    const product = products.find((p) => p.id === productId);
    return product ? `${product.code} - ${product.name}` : '-';
  };
  const getDeliveryNo = (deliveryId: number | null) =>
    deliveries.find((d) => d.id === deliveryId)?.delivery_no || '-';

  const returnableDeliveries = useMemo(
    () => deliveries.filter((d) => d.status === 'posted' || d.id === editingReturn?.delivery_id),
    [deliveries, editingReturn],
  );

  const currentWarehouseId = watchedWarehouseId ?? headerWarehouseId ?? selectedReturn?.warehouse_id ?? null;

  const runSequential = async (
    targets: SalesReturn[],
    action: (record: SalesReturn) => Promise<string | null>,
    fallbackMessage: string,
  ) => {
    let success = 0;
    const failures: string[] = [];
    const notices: string[] = [];
    for (const record of targets) {
      try {
        const notice = await action(record);
        if (notice) notices.push(`${record.return_no}：${notice}`);
        success += 1;
      } catch (error: any) {
        console.error('Error running sales return batch action:', error);
        failures.push(`${record.return_no}：${error?.message || fallbackMessage}`);
      }
    }
    setSelectedRowKeys([]);
    await fetchReturns();
    return { success, failures, notices };
  };

  const businessUser = { id: user?.profile.id, username: user?.profile.username };

  const runReturnAction = async (
    action: 'post' | 'reverse_post',
    record: SalesReturn,
  ): Promise<string | null> => {
    const result = await runBusinessAction({ action, documentType: DOCUMENT_TYPE, documentId: record.id, user: businessUser });
    const [notice] = collectVoucherNotices(
      [{ label: record.return_no, result: result as { voucher?: InventoryVoucherResult } }],
      t,
    );
    return notice ?? null;
  };

  const handleBatchPost = () => {
    const selectedIds = new Set(selectedRowKeys.map((k) => Number(k)));
    const targets = returns.filter(
      (row) => selectedIds.has(row.id) && POSTABLE_STATUSES.includes((row.status || '').toLowerCase()),
    );
    if (targets.length === 0) {
      message.warning(t('salesReturns.postNoTarget'));
      return;
    }
    Modal.confirm({
      title: t('salesReturns.post'),
      content: t('salesReturns.postConfirmContentMany', { count: targets.length }),
      okText: t('common.continue'),
      cancelText: t('common.cancel'),
      onOk: async () => {
        setPosting(true);
        try {
          const { success, failures, notices } = await runSequential(
            targets,
            (record) => runReturnAction('post', record),
            t('salesReturns.postFailed'),
          );
          if (failures.length === 0) {
            message.success(t('salesReturns.postSuccessMany', { count: success }));
          } else {
            message.error(t('salesReturns.postPartialFailed', { success, failed: failures.length, detail: failures.join('；') }));
          }
          if (notices.length > 0) message.warning(notices.join('；'), 10);
        } finally {
          setPosting(false);
        }
      },
    });
  };

  const handleBatchReverse = () => {
    const selectedIds = new Set(selectedRowKeys.map((k) => Number(k)));
    const targets = returns.filter((row) => selectedIds.has(row.id) && isPosted(row));
    if (targets.length === 0) {
      message.warning(t('salesReturns.reverseNoTarget'));
      return;
    }
    Modal.confirm({
      title: t('salesReturns.reverse'),
      content: t('salesReturns.reverseConfirmContentMany', { count: targets.length }),
      okText: t('common.continue'),
      cancelText: t('common.cancel'),
      okButtonProps: { danger: true },
      onOk: async () => {
        setReversing(true);
        try {
          const { success, failures, notices } = await runSequential(
            targets,
            (record) => runReturnAction('reverse_post', record),
            t('salesReturns.reverseFailed'),
          );
          if (failures.length === 0) {
            message.success(t('salesReturns.reverseSuccessMany', { count: success }));
          } else {
            message.error(t('salesReturns.reversePartialFailed', { success, failed: failures.length, detail: failures.join('；') }));
          }
          if (notices.length > 0) message.warning(notices.join('；'), 10);
        } finally {
          setReversing(false);
        }
      },
    });
  };

  const filteredReturns = returns.filter(
    (r) =>
      r.return_no.toLowerCase().includes(searchTerm.toLowerCase()) ||
      getCustomerName(r.customer_id).toLowerCase().includes(searchTerm.toLowerCase()) ||
      getDeliveryNo(r.delivery_id).toLowerCase().includes(searchTerm.toLowerCase()),
  );

  const statusLabels: Record<string, { text: string; color: string }> = {
    draft: { text: t('salesReturns.statusDraft'), color: 'default' },
    pending: { text: t('salesReturns.statusPending'), color: 'warning' },
    approved: { text: t('salesReturns.statusApproved'), color: 'blue' },
    posted: { text: t('salesReturns.statusPosted'), color: 'success' },
    cancelled: { text: t('salesReturns.statusCancelled'), color: 'error' },
  };

  const columns = [
    { title: t('salesReturns.returnNo'), dataIndex: 'return_no', key: 'return_no', width: 130 },
    {
      title: t('salesReturns.deliveryTitle'),
      dataIndex: 'delivery_id',
      key: 'delivery_id',
      width: 130,
      render: (id: number | null) => getDeliveryNo(id),
    },
    {
      title: t('salesReturns.customer'),
      dataIndex: 'customer_id',
      key: 'customer_id',
      render: (id: number | null) => getCustomerName(id),
    },
    {
      title: t('salesReturns.warehouse'),
      dataIndex: 'warehouse_id',
      key: 'warehouse_id',
      width: 120,
      render: (id: number | null) => getWarehouseName(id),
    },
    { title: t('salesReturns.returnDate'), dataIndex: 'return_date', key: 'return_date', width: 120 },
    {
      title: t('currency.field.currency'),
      dataIndex: 'currency',
      key: 'currency',
      width: 110,
      render: (code: string) => (code ? `${code} · ${currencyLabel(code)}` : '-'),
    },
    {
      title: t('salesReturns.amount'),
      dataIndex: 'total_amount',
      key: 'total_amount',
      width: 110,
      render: (amount: number, record: SalesReturn) => formatMoney(amount, record.currency),
    },
    {
      title: t('currency.field.baseAmount'),
      dataIndex: 'base_total_amount',
      key: 'base_total_amount',
      width: 110,
      render: (amount: number) => formatMoney(amount, baseCurrencyCode),
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
      render: (_: any, record: SalesReturn) => (
        <Space size="small">
          <Button type="text" icon={<EditOutlined />} disabled={isPosted(record)} onClick={() => handleEdit(record)}>
            {t('common.edit')}
          </Button>
          <Button type="text" danger icon={<DeleteOutlined />} disabled={isPosted(record)} onClick={() => handleDelete(record.id)}>
            {t('common.delete')}
          </Button>
        </Space>
      ),
    },
  ];

  const detailColumns = [
    { title: t('salesReturns.lineNo'), dataIndex: 'line_no', key: 'line_no', width: 80 },
    {
      title: t('salesReturns.product'),
      dataIndex: 'product_id',
      key: 'product_id',
      render: (productId: number) => getProductName(productId),
    },
    {
      title: t('salesReturns.sourceDeliveryDetail'),
      dataIndex: 'delivery_detail_id',
      key: 'delivery_detail_id',
      render: (id: number | null) =>
        id ? <Tag color="blue">{t('salesReturns.sourceDelivery')}</Tag> : <Tag>{t('salesReturns.sourceManual')}</Tag>,
    },
    {
      title: t('salesReturns.quantity'),
      dataIndex: 'quantity',
      key: 'quantity',
      render: (qty: number) => Number(qty || 0).toLocaleString(),
    },
    {
      title: t('salesReturns.unit'),
      dataIndex: 'product_id',
      key: 'unit',
      render: (productId: number) => <ProductUnit productId={productId} usageType="sales" />,
    },
    {
      title: t('salesReturns.unitPrice'),
      dataIndex: 'unit_price',
      key: 'unit_price',
      render: (price: number) => formatMoney(price, selectedReturn?.currency ?? undefined),
    },
    {
      title: t('salesReturns.amount'),
      dataIndex: 'amount',
      key: 'amount',
      render: (amount: number) => formatMoney(amount, selectedReturn?.currency ?? undefined),
    },
    {
      title: t('salesReturns.batchNo'),
      dataIndex: 'batch_no',
      key: 'batch_no',
      render: (text: string) => text || '-',
    },
    {
      title: t('salesReturns.location'),
      dataIndex: 'location_id',
      key: 'location_id',
      render: (locationId: number | null) => <BinName binId={locationId} />,
    },
    { title: t('salesReturns.reason'), dataIndex: 'reason', key: 'reason', render: (text: string) => text || '-', ellipsis: true },
    {
      title: t('common.actions'),
      key: 'action',
      width: 140,
      render: (_: any, record: SalesReturnDetail) => (
        <Space size="small">
          <Button type="text" icon={<EditOutlined />} onClick={() => handleEditDetail(record)}>
            {t('common.edit')}
          </Button>
          <Button type="text" danger icon={<DeleteOutlined />} onClick={() => handleDeleteDetail(record.id)} />
        </Space>
      ),
    },
  ];

  const detailTotal = sumAmount(details);

  return (
    <div>
      <SuperTable
        columns={columns}
        dataSource={filteredReturns}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 10 }}
        storageKey="sales-returns"
        tableName={returnTable}
        headerTitle={t('salesReturns.title')}
        rowSelection={{ selectedRowKeys, onChange: setSelectedRowKeys }}
        queryBar={
          <Space wrap>
            <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
              {t('salesReturns.add')}
            </Button>
            <Button
              type="primary"
              icon={<ThunderboltOutlined />}
              loading={posting}
              disabled={selectedRowKeys.length === 0}
              onClick={handleBatchPost}
            >
              {t('salesReturns.post')}
              {selectedRowKeys.length > 0 ? ` (${selectedRowKeys.length})` : ''}
            </Button>
            <Button
              danger
              icon={<UndoOutlined />}
              loading={reversing}
              disabled={selectedRowKeys.length === 0}
              onClick={handleBatchReverse}
            >
              {t('salesReturns.reverse')}
              {selectedRowKeys.length > 0 ? ` (${selectedRowKeys.length})` : ''}
            </Button>
            <Input.Search
              allowClear
              placeholder={t('salesReturns.searchPlaceholder')}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              onSearch={fetchReturns}
              style={{ width: 260 }}
            />
          </Space>
        }
      />

      <SupaModal
        title={editingReturn ? t('salesReturns.editTitle') : t('salesReturns.addTitle')}
        open={isModalOpen}
        onCancel={() => {
          setIsModalOpen(false);
          form.resetFields();
          setEditingReturn(null);
          setSelectedReturn(null);
          setHeaderWarehouseId(undefined);
        }}
        headerPanelTitle={t('salesReturns.headerPanelTitle')}
        detailPanelTitle={t('salesReturns.detailPanelTitle')}
        historyTable={returnTable}
        historyRecordId={editingReturn?.id || selectedReturn?.id}
        navigation={buildModalNav(filteredReturns, editingReturn?.id || selectedReturn?.id, handleEdit)}
        detailItems={[
          {
            key: 'attachments',
            label: t('attachments.title'),
            disabled: !editingReturn?.id,
            children: <BizAttachments bizType="sales_return" bizId={editingReturn?.id} />,
          },
        ]}
        workflowDocumentType={DOCUMENT_TYPE}
        onDataChanged={fetchReturns}
        form={form}
        detailData={details}
        detailExtra={
          <Space size={4}>
            <Button
              type="link"
              size="small"
              disabled={!!selectedReturn && isPosted(selectedReturn)}
              onClick={handleAddDetail}
              icon={<ImportOutlined />}
            >
              {t('salesReturns.addDetail')}
            </Button>
          </Space>
        }
        formEle={
          <Form form={form} layout="vertical" onFinish={handleSubmit} style={{ marginRight: 16 }}>
            <Row gutter={16}>
              <Col span={12}>
                <Form.Item
                  label={t('salesReturns.returnNo')}
                  name="return_no"
                  rules={[{ required: true, message: t('salesReturns.returnNoPrompt') }]}
                >
                  <Input placeholder={t('salesReturns.returnNoPrompt')} disabled={!!editingReturn} />
                </Form.Item>
                <Form.Item
                  label={t('salesReturns.returnDate')}
                  name="return_date"
                  rules={[{ required: true, message: t('salesReturns.returnDatePrompt') }]}
                >
                  <DatePicker style={{ width: '100%' }} />
                </Form.Item>
                <Form.Item label={t('salesReturns.deliveryLabel')} name="delivery_id">
                  <Select
                    allowClear
                    showSearch
                    optionFilterProp="children"
                    placeholder={t('salesReturns.deliveryPlaceholder')}
                    onChange={handleDeliveryChange}
                  >
                    {returnableDeliveries.map((d) => (
                      <Option key={d.id} value={d.id}>
                        {d.delivery_no}
                      </Option>
                    ))}
                  </Select>
                </Form.Item>
                <Form.Item
                  label={t('salesReturns.warehouse')}
                  name="warehouse_id"
                  rules={[{ required: true, message: t('salesReturns.warehousePrompt') }]}
                >
                  <Select
                    placeholder={t('salesReturns.warehousePrompt')}
                    onChange={(value: number) => {
                      setHeaderWarehouseId(value);
                      form.setFieldsValue({ location_id: undefined });
                    }}
                  >
                    {warehouses.map((w) => (
                      <Option key={w.id} value={w.id}>
                        {w.name}
                      </Option>
                    ))}
                  </Select>
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  label={t('salesReturns.customer')}
                  name="customer_id"
                  rules={[{ required: true, message: t('salesReturns.customerPrompt') }]}
                >
                  <Select placeholder={t('salesReturns.customerPrompt')} showSearch optionFilterProp="children">
                    {customers.map((c) => (
                      <Option key={c.id} value={c.id}>
                        {c.name}
                      </Option>
                    ))}
                  </Select>
                </Form.Item>
                <Form.Item label={t('salesReturns.defaultLocation')} name="location_id">
                  <WarehouseBinSelect warehouseId={currentWarehouseId} />
                </Form.Item>
                <Form.Item label={t('salesReturns.currency')} name="currency" initialValue={baseCurrencyCode}>
                  <Select disabled>
                    <Option value={baseCurrencyCode}>{baseCurrencyCode}</Option>
                  </Select>
                </Form.Item>
                <Form.Item label={t('salesReturns.totalAmount')} name="total_amount" initialValue={0}>
                  <InputNumber disabled style={{ width: '100%' }} />
                </Form.Item>
                <Form.Item label={t('common.status')} name="status" initialValue="draft">
                  <Select>
                    <Option value="draft">{t('salesReturns.statusDraft')}</Option>
                    <Option value="cancelled">{t('salesReturns.statusCancelled')}</Option>
                  </Select>
                </Form.Item>
              </Col>
            </Row>
            <Form.Item label={t('salesReturns.reason')} name="reason">
              <TextArea rows={2} placeholder={t('salesReturns.reasonPrompt')} />
            </Form.Item>
          </Form>
        }
        tableEle={
          <Table
            columns={detailColumns}
            dataSource={details}
            rowKey="id"
            pagination={false}
            summary={() => (
              <Table.Summary.Row>
                <Table.Summary.Cell index={0} colSpan={6} align="right">
                  <strong>{t('salesReturns.totalText')}</strong>
                </Table.Summary.Cell>
                <Table.Summary.Cell index={1} align="right">
                  <strong>{formatMoney(detailTotal, selectedReturn?.currency ?? undefined)}</strong>
                </Table.Summary.Cell>
                <Table.Summary.Cell index={2} colSpan={4} />
              </Table.Summary.Row>
            )}
          />
        }
        footer={
          <Space>
            <Button onClick={() => setIsModalOpen(false)}>{t('common.cancel')}</Button>
            <Button type="primary" onClick={() => form.submit()}>
              {t('common.save')}
            </Button>
          </Space>
        }
        width={'75%'}
        height={620}
      />

      <SimpleModal
        title={editingDetail ? t('salesReturns.editDetailTitle') : t('salesReturns.addDetailTitle')}
        open={isDetailModalOpen}
        onCancel={() => {
          setIsDetailModalOpen(false);
          detailForm.resetFields();
          setEditingDetail(null);
        }}
        footer={
          <Space>
            <Button onClick={() => setIsDetailModalOpen(false)}>{t('common.cancel')}</Button>
            <Button type="primary" onClick={() => detailForm.submit()}>
              {t('common.save')}
            </Button>
          </Space>
        }
        width={620}
      >
        <Form form={detailForm} layout="vertical" onFinish={handleDetailSubmit} style={{ marginTop: 8 }}>
          {!watchedDeliveryId && (
            <Alert type="info" showIcon style={{ marginBottom: 12 }} message={t('salesReturns.noSourceHint')} />
          )}
          <Form.Item label={t('salesReturns.sourceDeliveryDetail')} name="delivery_detail_id">
            <Select
              allowClear
              disabled={!watchedDeliveryId}
              placeholder={t('salesReturns.sourceDeliveryDetailPlaceholder')}
              onChange={handleDeliveryDetailChange}
            >
              {deliveryDetails.map((d) => {
                const info = getDeliveryDetailInfo(d.id);
                return (
                  <Option key={d.id} value={d.id}>
                    {info?.label} {t('salesReturns.deliveryQty', { qty: d.quantity || 0 })}
                  </Option>
                );
              })}
            </Select>
          </Form.Item>
          <Form.Item
            label={t('salesReturns.product')}
            name="product_id"
            rules={[{ required: true, message: t('salesReturns.productPrompt') }]}
          >
            <Select placeholder={t('salesReturns.productPrompt')} showSearch optionFilterProp="children">
              {products.map((p) => (
                <Option key={p.id} value={p.id}>
                  {p.code} - {p.name}
                </Option>
              ))}
            </Select>
          </Form.Item>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                label={t('salesReturns.quantity')}
                name="quantity"
                rules={[{ required: true, message: t('salesReturns.quantityPrompt') }]}
              >
                <InputNumber min={0} step={0.0001} precision={4} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                label={t('salesReturns.unitPrice')}
                name="unit_price"
                rules={[{ required: true, message: t('salesReturns.unitPricePrompt') }]}
              >
                <InputNumber min={0} step={0.01} precision={4} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item label={t('salesReturns.batchNo')} name="batch_no">
                <Input placeholder={t('salesReturns.batchNoPrompt')} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label={t('salesReturns.location')} name="location_id">
                <WarehouseBinSelect warehouseId={currentWarehouseId} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item label={t('salesReturns.expiryDate')} name="expiry_date">
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label={t('salesReturns.reason')} name="reason">
                <Input placeholder={t('salesReturns.reasonPrompt')} />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </SimpleModal>
    </div>
  );
}

export default SalesReturns;
