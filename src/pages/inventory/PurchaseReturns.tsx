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
 * 采购退货单（P1-1）。
 *
 * 过账走 post_stock_document（deploy_93），方向 **out**：
 *   · 库存按原入库成本出库（不足则按当前移动加权单价，见 RPC 注释）
 *   · 同时写一条**红字应付**（负数 erp_payables），不改原入库单
 * 溯源用 receipt_detail_id（来源入库行），账面「已退数量」由流转台账回写。
 */
type PurchaseReturn = Tables['erp_purchase_returns_s_539dcf81_b']['Row'];
type PurchaseReturnDetail = Tables['erp_purchase_return_details_s_539dcf81_b']['Row'];
type PurchaseReceipt = Tables['erp_purchase_receipts_s_539dcf81_b']['Row'];
type PurchaseReceiptDetail = Tables['erp_purchase_receipt_details_s_539dcf81_b']['Row'];
type Supplier = Tables['erp_suppliers_s_539dcf81_b']['Row'];
type Product = Tables['erp_products_s_539dcf81_b']['Row'];
type Warehouse = Tables['erp_warehouses_s_539dcf81_b']['Row'];

const { Option } = Select;
const { TextArea } = Input;

const returnTable = 'erp_purchase_returns_s_539dcf81_b';
const returnDetailTable = 'erp_purchase_return_details_s_539dcf81_b';
const receiptTable = 'erp_purchase_receipts_s_539dcf81_b';
const receiptDetailTable = 'erp_purchase_receipt_details_s_539dcf81_b';

const DOCUMENT_TYPE = 'purchase_return' as const;
// 可过账的来源状态（与 post_stock_document 内部校验一致：cancelled / posted 不可再动）
const POSTABLE_STATUSES = ['draft', 'approved'];
const POSTED_STATUS = 'posted';

const isPosted = (record: { status: string }) => record.status === POSTED_STATUS;

export function PurchaseReturns() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { baseCurrency } = useCurrencyRegistry();
  const baseCurrencyCode = (baseCurrency || 'CNY').toUpperCase();

  const [returns, setReturns] = useState<PurchaseReturn[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [receipts, setReceipts] = useState<PurchaseReceipt[]>([]);
  const [receiptDetails, setReceiptDetails] = useState<PurchaseReceiptDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedRowKeys, setSelectedRowKeys] = useState<Key[]>([]);
  const [posting, setPosting] = useState(false);
  const [reversing, setReversing] = useState(false);

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isDetailModalOpen, setIsDetailModalOpen] = useState(false);
  const [editingReturn, setEditingReturn] = useState<PurchaseReturn | null>(null);
  const [selectedReturn, setSelectedReturn] = useState<PurchaseReturn | null>(null);
  const [details, setDetails] = useState<PurchaseReturnDetail[]>([]);
  const [editingDetail, setEditingDetail] = useState<PurchaseReturnDetail | null>(null);
  const [headerWarehouseId, setHeaderWarehouseId] = useState<number | undefined>();

  const [form] = Form.useForm();
  const [detailForm] = Form.useForm();
  const watchedWarehouseId = Form.useWatch('warehouse_id', form);
  const watchedReceiptId = Form.useWatch('receipt_id', form);

  useEffect(() => {
    fetchReturns();
    fetchSuppliers();
    fetchProducts();
    fetchWarehouses();
    fetchReceipts();
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
      console.error('Error fetching purchase returns:', error);
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
        .eq('is_deleted', 'n');
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
        .eq('is_deleted', 'n');
      if (error) throw error;
      setWarehouses(data || []);
    } catch (error) {
      console.error('Error fetching warehouses:', error);
    }
  };

  const fetchReceipts = async () => {
    try {
      const { data, error } = await supabase
        .from(receiptTable)
        .select('*')
        .eq('is_deleted', 'n');
      if (error) throw error;
      setReceipts(data || []);
    } catch (error) {
      console.error('Error fetching purchase receipts:', error);
    }
  };

  const fetchReceiptDetails = async (receiptId: number) => {
    try {
      const { data, error } = await supabase
        .from(receiptDetailTable)
        .select('*')
        .eq('is_deleted', 'n')
        .eq('receipt_id', receiptId)
        .order('line_no');
      if (error) throw error;
      setReceiptDetails(data || []);
    } catch (error) {
      console.error('Error fetching receipt details:', error);
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
      console.error('Error fetching return details:', error);
      message.error(t('purchaseReturns.fetchDetailsFailed'));
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
      console.error('Error updating return total:', error);
    }
  };

  const handleSubmit = async (values: any) => {
    try {
      const payload = { ...values, total_amount: sumAmount(details) };
      if (editingReturn) {
        await logWithTiming('更新采购退货单', 'UPDATE', async () => {
          const { error } = await supabase.from(returnTable).update(payload).eq('id', editingReturn.id);
          if (error) throw error;
        }, { table: returnTable, recordId: editingReturn.id });
        message.success(t('common.updateSuccess'));
      } else {
        await logWithTiming('新增采购退货单', 'INSERT', async () => {
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
      console.error('Error saving purchase return:', error);
      message.error(t('common.saveFailed'));
    }
  };

  const handleDetailSubmit = async (values: any) => {
    try {
      if (!selectedReturn) {
        message.warning(t('purchaseReturns.saveHeaderFirst'));
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
      console.error('Error saving return detail:', error);
      message.error(t('common.saveFailed'));
    }
  };

  const handleEdit = async (record: PurchaseReturn) => {
    if (isPosted(record)) {
      message.warning(t('purchaseReturns.postedLocked'));
      return;
    }
    setEditingReturn(record);
    setSelectedReturn(record);
    setHeaderWarehouseId(record.warehouse_id ?? undefined);
    form.setFieldsValue({ ...record, return_date: dayjs(record.return_date) });
    await fetchDetails(record.id);
    if (record.receipt_id) await fetchReceiptDetails(record.receipt_id);
    setIsModalOpen(true);
  };

  const handleDelete = async (id: number) => {
    const target = returns.find((r) => r.id === id);
    if (target && isPosted(target)) {
      message.warning(t('purchaseReturns.postedLocked'));
      return;
    }
    Modal.confirm({
      title: t('common.confirmDelete'),
      content: t('purchaseReturns.deleteConfirm'),
      onOk: async () => {
        try {
          await logWithTiming('删除采购退货单', 'DELETE', async () => {
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
          console.error('Error deleting purchase return:', error);
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
    setReceiptDetails([]);
    setHeaderWarehouseId(undefined);
    form.setFieldsValue({
      return_no: returnNo,
      return_date: dayjs(new Date()),
      receipt_id: undefined,
      supplier_id: undefined,
      warehouse_id: undefined,
      location_id: undefined,
      currency: baseCurrencyCode,
      total_amount: 0,
      reason: '',
      remark: '',
      status: 'draft',
    });
    setIsModalOpen(true);
  };

  const handleAddDetail = () => {
    if (!selectedReturn) {
      message.warning(t('purchaseReturns.saveHeaderFirst'));
      return;
    }
    if (isPosted(selectedReturn)) {
      message.warning(t('purchaseReturns.postedLocked'));
      return;
    }
    setEditingDetail(null);
    detailForm.setFieldsValue({
      receipt_detail_id: undefined,
      product_id: undefined,
      quantity: 1,
      unit_price: 0,
      amount: 0,
      batch_no: '',
      location_id: undefined,
      expiry_date: undefined,
      reason: '',
      remark: '',
    });
    setIsDetailModalOpen(true);
  };

  const handleEditDetail = (record: PurchaseReturnDetail) => {
    if (selectedReturn && isPosted(selectedReturn)) {
      message.warning(t('purchaseReturns.postedLocked'));
      return;
    }
    setEditingDetail(record);
    detailForm.setFieldsValue({ ...record, expiry_date: record.expiry_date ? dayjs(record.expiry_date) : undefined });
    setIsDetailModalOpen(true);
  };

  const handleDeleteDetail = async (id: number) => {
    if (selectedReturn && isPosted(selectedReturn)) {
      message.warning(t('purchaseReturns.postedLocked'));
      return;
    }
    Modal.confirm({
      title: t('common.confirmDelete'),
      content: t('purchaseReturns.deleteDetailConfirm'),
      onOk: async () => {
        try {
          await supabase.from(returnDetailTable).update({ is_deleted: 'y' }).eq('id', id);
          message.success(t('common.deleteSuccess'));
          if (selectedReturn) {
            fetchDetails(selectedReturn.id);
            updateReturnTotal(selectedReturn.id);
          }
        } catch (error) {
          console.error('Error deleting return detail:', error);
          message.error(t('common.deleteFailed'));
        }
      },
    });
  };

  // 选来源入库单：把供应商 / 仓库 / 币别带过来。退货必须退到**原入库仓库**才说得通，
  // 但 RPC 不强制，所以这里只是默认值，之后仍可改。
  const handleReceiptChange = async (value: number | null, options?: any) => {
    if (!value) {
      setReceiptDetails([]);
      return;
    }
    const receipt = receipts.find((r) => r.id === value);
    if (receipt) {
      form.setFieldsValue({
        supplier_id: receipt.supplier_id,
        warehouse_id: receipt.warehouse_id,
        location_id: receipt.location_id ?? undefined,
        currency: receipt.currency || baseCurrencyCode,
      });
      setHeaderWarehouseId(receipt.warehouse_id ?? undefined);
    }
    // options 里带过来的 currency 仅供展示，落库仍以 receipt 为准
    void options;
    await fetchReceiptDetails(value);
  };

  const getReceiptDetailInfo = (receiptDetailId: number | null) => {
    const detail = receiptDetails.find((d) => d.id === receiptDetailId);
    if (!detail) return null;
    const product = products.find((p) => p.id === detail.product_id);
    return {
      productId: detail.product_id,
      productName: product ? `${product.code} - ${product.name}` : '-',
      unitPrice: detail.unit_price || 0,
      batchNo: detail.batch_no || '',
      locationId: detail.location_id ?? null,
      // 入库数量即退货上限（多退要被 RPC 拦，这里先给提示）
      maxQty: detail.quantity || 0,
    };
  };

  const handleReceiptDetailChange = (value: number | null) => {
    const info = getReceiptDetailInfo(value);
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

  const getSupplierName = (supplierId: number | null) =>
    suppliers.find((s) => s.id === supplierId)?.name || '-';
  const getWarehouseName = (warehouseId: number | null) =>
    warehouses.find((w) => w.id === warehouseId)?.name || '-';
  const getProductName = (productId: number | null) => {
    const product = products.find((p) => p.id === productId);
    return product ? `${product.code} - ${product.name}` : '-';
  };
  const getReceiptNo = (receiptId: number | null) =>
    receipts.find((r) => r.id === receiptId)?.receipt_no || '-';

  // 只有已过账（真正入库）的入库单才可退
  const returnableReceipts = useMemo(
    () => receipts.filter((r) => r.status === 'posted' || r.id === editingReturn?.receipt_id),
    [receipts, editingReturn],
  );

  const currentWarehouseId = watchedWarehouseId ?? headerWarehouseId ?? selectedReturn?.warehouse_id ?? null;

  const runSequential = async (
    targets: PurchaseReturn[],
    action: (record: PurchaseReturn) => Promise<string | null>,
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
        console.error('Error running purchase return batch action:', error);
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
    record: PurchaseReturn,
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
      message.warning(t('purchaseReturns.postNoTarget'));
      return;
    }
    Modal.confirm({
      title: t('purchaseReturns.post'),
      content: t('purchaseReturns.postConfirmContentMany', { count: targets.length }),
      okText: t('common.continue'),
      cancelText: t('common.cancel'),
      onOk: async () => {
        setPosting(true);
        try {
          const { success, failures, notices } = await runSequential(
            targets,
            (record) => runReturnAction('post', record),
            t('purchaseReturns.postFailed'),
          );
          if (failures.length === 0) {
            message.success(t('purchaseReturns.postSuccessMany', { count: success }));
          } else {
            message.error(t('purchaseReturns.postPartialFailed', { success, failed: failures.length, detail: failures.join('；') }));
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
      message.warning(t('purchaseReturns.reverseNoTarget'));
      return;
    }
    Modal.confirm({
      title: t('purchaseReturns.reverse'),
      content: t('purchaseReturns.reverseConfirmContentMany', { count: targets.length }),
      okText: t('common.continue'),
      cancelText: t('common.cancel'),
      okButtonProps: { danger: true },
      onOk: async () => {
        setReversing(true);
        try {
          const { success, failures, notices } = await runSequential(
            targets,
            (record) => runReturnAction('reverse_post', record),
            t('purchaseReturns.reverseFailed'),
          );
          if (failures.length === 0) {
            message.success(t('purchaseReturns.reverseSuccessMany', { count: success }));
          } else {
            message.error(t('purchaseReturns.reversePartialFailed', { success, failed: failures.length, detail: failures.join('；') }));
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
      getSupplierName(r.supplier_id).toLowerCase().includes(searchTerm.toLowerCase()) ||
      getReceiptNo(r.receipt_id).toLowerCase().includes(searchTerm.toLowerCase()),
  );

  const statusLabels: Record<string, { text: string; color: string }> = {
    draft: { text: t('purchaseReturns.statusDraft'), color: 'default' },
    pending: { text: t('purchaseReturns.statusPending'), color: 'warning' },
    approved: { text: t('purchaseReturns.statusApproved'), color: 'blue' },
    posted: { text: t('purchaseReturns.statusPosted'), color: 'success' },
    cancelled: { text: t('purchaseReturns.statusCancelled'), color: 'error' },
  };

  const columns = [
    { title: t('purchaseReturns.returnNo'), dataIndex: 'return_no', key: 'return_no', width: 130 },
    {
      title: t('purchaseReturns.receiptTitle'),
      dataIndex: 'receipt_id',
      key: 'receipt_id',
      width: 130,
      render: (id: number | null) => getReceiptNo(id),
    },
    {
      title: t('purchaseReturns.supplier'),
      dataIndex: 'supplier_id',
      key: 'supplier_id',
      render: (id: number | null) => getSupplierName(id),
    },
    {
      title: t('purchaseReturns.warehouse'),
      dataIndex: 'warehouse_id',
      key: 'warehouse_id',
      width: 120,
      render: (id: number | null) => getWarehouseName(id),
    },
    { title: t('purchaseReturns.returnDate'), dataIndex: 'return_date', key: 'return_date', width: 120 },
    {
      title: t('currency.field.currency'),
      dataIndex: 'currency',
      key: 'currency',
      width: 110,
      render: (code: string) => (code ? `${code} · ${currencyLabel(code)}` : '-'),
    },
    {
      title: t('purchaseReturns.amount'),
      dataIndex: 'total_amount',
      key: 'total_amount',
      width: 110,
      render: (amount: number, record: PurchaseReturn) => formatMoney(amount, record.currency),
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
      render: (_: any, record: PurchaseReturn) => (
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
    { title: t('purchaseReturns.lineNo'), dataIndex: 'line_no', key: 'line_no', width: 80 },
    {
      title: t('purchaseReturns.product'),
      dataIndex: 'product_id',
      key: 'product_id',
      render: (productId: number) => getProductName(productId),
    },
    {
      title: t('purchaseReturns.sourceReceiptDetail'),
      dataIndex: 'receipt_detail_id',
      key: 'receipt_detail_id',
      render: (id: number | null) =>
        id ? <Tag color="blue">{t('purchaseReturns.sourceReceipt')}</Tag> : <Tag>{t('purchaseReturns.sourceManual')}</Tag>,
    },
    {
      title: t('purchaseReturns.quantity'),
      dataIndex: 'quantity',
      key: 'quantity',
      render: (qty: number) => Number(qty || 0).toLocaleString(),
    },
    {
      title: t('purchaseReturns.unit'),
      dataIndex: 'product_id',
      key: 'unit',
      render: (productId: number) => <ProductUnit productId={productId} usageType="purchase" />,
    },
    {
      title: t('purchaseReturns.unitPrice'),
      dataIndex: 'unit_price',
      key: 'unit_price',
      render: (price: number) => formatMoney(price, selectedReturn?.currency ?? undefined),
    },
    {
      title: t('purchaseReturns.amount'),
      dataIndex: 'amount',
      key: 'amount',
      render: (amount: number) => formatMoney(amount, selectedReturn?.currency ?? undefined),
    },
    {
      title: t('purchaseReturns.batchNo'),
      dataIndex: 'batch_no',
      key: 'batch_no',
      render: (text: string) => text || '-',
    },
    {
      title: t('purchaseReturns.location'),
      dataIndex: 'location_id',
      key: 'location_id',
      render: (locationId: number | null) => <BinName binId={locationId} />,
    },
    { title: t('purchaseReturns.reason'), dataIndex: 'reason', key: 'reason', render: (text: string) => text || '-', ellipsis: true },
    {
      title: t('common.actions'),
      key: 'action',
      width: 140,
      render: (_: any, record: PurchaseReturnDetail) => (
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
        storageKey="purchase-returns"
        tableName={returnTable}
        headerTitle={t('purchaseReturns.title')}
        rowSelection={{ selectedRowKeys, onChange: setSelectedRowKeys }}
        queryBar={
          <Space wrap>
            <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
              {t('purchaseReturns.add')}
            </Button>
            <Button
              type="primary"
              icon={<ThunderboltOutlined />}
              loading={posting}
              disabled={selectedRowKeys.length === 0}
              onClick={handleBatchPost}
            >
              {t('purchaseReturns.post')}
              {selectedRowKeys.length > 0 ? ` (${selectedRowKeys.length})` : ''}
            </Button>
            <Button
              danger
              icon={<UndoOutlined />}
              loading={reversing}
              disabled={selectedRowKeys.length === 0}
              onClick={handleBatchReverse}
            >
              {t('purchaseReturns.reverse')}
              {selectedRowKeys.length > 0 ? ` (${selectedRowKeys.length})` : ''}
            </Button>
            <Input.Search
              allowClear
              placeholder={t('purchaseReturns.searchPlaceholder')}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              onSearch={fetchReturns}
              style={{ width: 260 }}
            />
          </Space>
        }
      />

      <SupaModal
        title={editingReturn ? t('purchaseReturns.editTitle') : t('purchaseReturns.addTitle')}
        open={isModalOpen}
        onCancel={() => {
          setIsModalOpen(false);
          form.resetFields();
          setEditingReturn(null);
          setSelectedReturn(null);
          setHeaderWarehouseId(undefined);
        }}
        headerPanelTitle={t('purchaseReturns.headerPanelTitle')}
        detailPanelTitle={t('purchaseReturns.detailPanelTitle')}
        historyTable={returnTable}
        historyRecordId={editingReturn?.id || selectedReturn?.id}
        navigation={buildModalNav(filteredReturns, editingReturn?.id || selectedReturn?.id, handleEdit)}
        detailItems={[
          {
            key: 'attachments',
            label: t('attachments.title'),
            disabled: !editingReturn?.id,
            children: <BizAttachments bizType="purchase_return" bizId={editingReturn?.id} />,
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
              {t('purchaseReturns.addDetail')}
            </Button>
          </Space>
        }
        formEle={
          <Form form={form} layout="vertical" onFinish={handleSubmit} style={{ marginRight: 16 }}>
            <Row gutter={16}>
              <Col span={12}>
                <Form.Item
                  label={t('purchaseReturns.returnNo')}
                  name="return_no"
                  rules={[{ required: true, message: t('purchaseReturns.returnNoPrompt') }]}
                >
                  <Input placeholder={t('purchaseReturns.returnNoPrompt')} disabled={!!editingReturn} />
                </Form.Item>
                <Form.Item
                  label={t('purchaseReturns.returnDate')}
                  name="return_date"
                  rules={[{ required: true, message: t('purchaseReturns.returnDatePrompt') }]}
                >
                  <DatePicker style={{ width: '100%' }} />
                </Form.Item>
                <Form.Item label={t('purchaseReturns.receiptLabel')} name="receipt_id">
                  <Select
                    allowClear
                    showSearch
                    optionFilterProp="children"
                    placeholder={t('purchaseReturns.receiptPlaceholder')}
                    onChange={handleReceiptChange}
                  >
                    {returnableReceipts.map((r) => (
                      <Option key={r.id} value={r.id}>
                        {r.receipt_no}
                      </Option>
                    ))}
                  </Select>
                </Form.Item>
                <Form.Item
                  label={t('purchaseReturns.warehouse')}
                  name="warehouse_id"
                  rules={[{ required: true, message: t('purchaseReturns.warehousePrompt') }]}
                >
                  <Select
                    placeholder={t('purchaseReturns.warehousePrompt')}
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
                  label={t('purchaseReturns.supplier')}
                  name="supplier_id"
                  rules={[{ required: true, message: t('purchaseReturns.supplierPrompt') }]}
                >
                  <Select placeholder={t('purchaseReturns.supplierPrompt')} showSearch optionFilterProp="children">
                    {suppliers.map((s) => (
                      <Option key={s.id} value={s.id}>
                        {s.name}
                      </Option>
                    ))}
                  </Select>
                </Form.Item>
                <Form.Item label={t('purchaseReturns.defaultLocation')} name="location_id">
                  <WarehouseBinSelect warehouseId={currentWarehouseId} />
                </Form.Item>
                <Form.Item label={t('purchaseReturns.currency')} name="currency" initialValue={baseCurrencyCode}>
                  <Select disabled>
                    <Option value={baseCurrencyCode}>{baseCurrencyCode}</Option>
                  </Select>
                </Form.Item>
                <Form.Item label={t('purchaseReturns.totalAmount')} name="total_amount" initialValue={0}>
                  <InputNumber disabled style={{ width: '100%' }} />
                </Form.Item>
                <Form.Item label={t('common.status')} name="status" initialValue="draft">
                  <Select>
                    <Option value="draft">{t('purchaseReturns.statusDraft')}</Option>
                    <Option value="cancelled">{t('purchaseReturns.statusCancelled')}</Option>
                  </Select>
                </Form.Item>
              </Col>
            </Row>
            <Form.Item label={t('purchaseReturns.reason')} name="reason">
              <TextArea rows={2} placeholder={t('purchaseReturns.reasonPrompt')} />
            </Form.Item>
            <Form.Item label={t('purchaseReturns.remark')} name="remark">
              <TextArea rows={2} placeholder={t('purchaseReturns.remarkPrompt')} />
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
                  <strong>{t('purchaseReturns.totalText')}</strong>
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
        title={editingDetail ? t('purchaseReturns.editDetailTitle') : t('purchaseReturns.addDetailTitle')}
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
          {!watchedReceiptId && (
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 12 }}
              message={t('purchaseReturns.noSourceHint')}
            />
          )}
          <Form.Item label={t('purchaseReturns.sourceReceiptDetail')} name="receipt_detail_id">
            <Select
              allowClear
              disabled={!watchedReceiptId}
              placeholder={t('purchaseReturns.sourceReceiptDetailPlaceholder')}
              onChange={handleReceiptDetailChange}
            >
              {receiptDetails.map((d) => {
                const product = products.find((p) => p.id === d.product_id);
                return (
                  <Option key={d.id} value={d.id}>
                    {product?.code} - {product?.name} {t('purchaseReturns.receiptQty', { qty: d.quantity || 0 })}
                  </Option>
                );
              })}
            </Select>
          </Form.Item>
          <Form.Item
            label={t('purchaseReturns.product')}
            name="product_id"
            rules={[{ required: true, message: t('purchaseReturns.productPrompt') }]}
          >
            <Select placeholder={t('purchaseReturns.productPrompt')} showSearch optionFilterProp="children">
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
                label={t('purchaseReturns.quantity')}
                name="quantity"
                rules={[{ required: true, message: t('purchaseReturns.quantityPrompt') }]}
              >
                <InputNumber min={0} step={0.0001} precision={4} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                label={t('purchaseReturns.unitPrice')}
                name="unit_price"
                rules={[{ required: true, message: t('purchaseReturns.unitPricePrompt') }]}
              >
                <InputNumber min={0} step={0.01} precision={4} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item label={t('purchaseReturns.batchNo')} name="batch_no">
                <Input placeholder={t('purchaseReturns.batchNoPrompt')} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label={t('purchaseReturns.location')} name="location_id">
                <WarehouseBinSelect warehouseId={currentWarehouseId} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item label={t('purchaseReturns.expiryDate')} name="expiry_date">
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label={t('purchaseReturns.reason')} name="reason">
                <Input placeholder={t('purchaseReturns.reasonPrompt')} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item label={t('purchaseReturns.remark')} name="remark">
            <Input placeholder={t('purchaseReturns.remarkPrompt')} />
          </Form.Item>
        </Form>
      </SimpleModal>
    </div>
  );
}

export default PurchaseReturns;
