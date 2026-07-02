import { supabase } from './supabase';
import { logWithTiming } from './logger';

type InventoryDirection = 'in' | 'out';
type StockDocumentType = 'purchase_receipt' | 'sales_delivery';
type BusinessAction = 'submit' | 'approve' | 'post' | 'reverse_post' | 'post_voucher' | 'reverse_voucher';
type BusinessDocumentType = StockDocumentType | 'purchase_order' | 'sales_order' | 'voucher';

interface BusinessUser {
  id?: number | null;
  username?: string | null;
}

interface StockPostingLine {
  product_id: number | null;
  warehouse_id: number | null;
  quantity: number | null;
  unit_cost: number | null;
  batch_no?: string | null;
  expiry_date?: string | null;
  remark?: string | null;
}

interface StockDocumentConfig {
  documentId: number;
  documentNo: string;
  documentDate: string;
  documentType: StockDocumentType;
  direction: InventoryDirection;
  headerTable: string;
  detailTable: string;
  detailForeignKey: string;
  warehouseId: number | null;
  user?: BusinessUser;
}

interface RunBusinessActionParams {
  action: BusinessAction;
  documentType: BusinessDocumentType;
  documentId: number;
  user?: BusinessUser;
}

const inventoryTable = 'erp_inventory_s_539dcf81_b';
const inventoryTransactionTable = 'erp_inventory_transactions_s_539dcf81_b';

const toNumber = (value: number | string | null | undefined) => Number(value || 0);
const nearlyEqual = (a: number, b: number) => Math.abs(a - b) < 0.005;

const normalizeDate = (value: string | { format?: (pattern: string) => string } | null | undefined) => {
  if (!value) return new Date().toISOString().slice(0, 10);
  if (typeof value === 'string') return value.slice(0, 10);
  if (typeof value.format === 'function') return value.format('YYYY-MM-DD');
  return new Date().toISOString().slice(0, 10);
};

const getReferenceLabel = (documentType: StockDocumentType) => {
  if (documentType === 'purchase_receipt') return '采购入库单';
  return '销售出货单';
};

const documentMeta = {
  purchase_order: {
    table: 'erp_purchase_orders_s_539dcf81_b',
    noField: 'order_no',
    dateField: 'order_date',
  },
  sales_order: {
    table: 'erp_sales_orders_s_539dcf81_b',
    noField: 'order_no',
    dateField: 'order_date',
  },
  purchase_receipt: {
    table: 'erp_purchase_receipts_s_539dcf81_b',
    detailTable: 'erp_purchase_receipt_details_s_539dcf81_b',
    detailForeignKey: 'receipt_id',
    noField: 'receipt_no',
    dateField: 'receipt_date',
    direction: 'in' as InventoryDirection,
  },
  sales_delivery: {
    table: 'erp_sales_deliveries_s_539dcf81_b',
    detailTable: 'erp_sales_delivery_details_s_539dcf81_b',
    detailForeignKey: 'delivery_id',
    noField: 'delivery_no',
    dateField: 'delivery_date',
    direction: 'out' as InventoryDirection,
  },
  voucher: {
    table: 'erp_vouchers_s_539dcf81_b',
    noField: 'voucher_no',
    dateField: 'voucher_date',
  },
};

export async function approveDocument(
  tableName: string,
  documentId: number,
  user?: BusinessUser,
  extraValues: Record<string, unknown> = {},
) {
  await logWithTiming('审核单据', 'APPROVE', async () => {
    const payload: Record<string, unknown> = {
      status: 'approved',
      ...extraValues,
    };

    if ('approved_by' in extraValues || tableName.includes('orders')) {
      payload.approved_by = user?.id ?? null;
      payload.approved_at = new Date().toISOString();
    }

    const { error } = await supabase.from(tableName).update(payload).eq('id', documentId);
    if (error) throw error;
  }, { table: tableName, recordId: documentId, user: user?.username });
}

export async function submitForApproval(tableName: string, documentId: number, user?: BusinessUser) {
  await logWithTiming('提交审批', 'SUBMIT', async () => {
    const { error } = await supabase.from(tableName).update({ status: 'pending' }).eq('id', documentId);
    if (error) throw error;
  }, { table: tableName, recordId: documentId, user: user?.username });
}

async function fetchStockLines(config: StockDocumentConfig): Promise<StockPostingLine[]> {
  const { data, error } = await supabase
    .from(config.detailTable)
    .select('*')
    .eq('is_deleted', 'n')
    .eq(config.detailForeignKey, config.documentId);

  if (error) throw error;

  return (data || []).map((detail: any) => ({
    product_id: detail.product_id,
    warehouse_id: config.warehouseId,
    quantity: detail.quantity,
    unit_cost: detail.unit_cost ?? detail.unit_price,
    batch_no: detail.batch_no ?? null,
    expiry_date: detail.expiry_date ?? null,
    remark: detail.remark ?? null,
  }));
}

async function getInventoryRow(line: StockPostingLine) {
  let query = supabase
    .from(inventoryTable)
    .select('*')
    .eq('is_deleted', 'n')
    .eq('product_id', line.product_id)
    .eq('warehouse_id', line.warehouse_id);

  if (line.batch_no) {
    query = query.eq('batch_no', line.batch_no);
  } else {
    query = query.is('batch_no', null);
  }

  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return data;
}

async function getProductCost(productId: number | null) {
  if (!productId) return 0;
  const { data, error } = await supabase
    .from('erp_products_s_539dcf81_b')
    .select('cost_price, purchase_price')
    .eq('id', productId)
    .maybeSingle();

  if (error) throw error;
  return toNumber(data?.cost_price || data?.purchase_price);
}

async function getWarehouseAllowsNegative(warehouseId: number | null) {
  if (!warehouseId) return false;
  const { data, error } = await supabase
    .from('erp_warehouses_s_539dcf81_b')
    .select('is_negative_stock_allowed')
    .eq('id', warehouseId)
    .maybeSingle();

  if (error) throw error;
  return Boolean(data?.is_negative_stock_allowed);
}

async function applyInventoryDelta(line: StockPostingLine, signedQuantity: number, allowNegative: boolean) {
  const existing = await getInventoryRow(line);
  const oldQuantity = toNumber(existing?.quantity);
  const oldAvailableQuantity = toNumber(existing?.available_quantity);
  const oldTotalCost = toNumber(existing?.total_cost);
  const unitCost = toNumber(line.unit_cost) || toNumber(existing?.unit_cost) || await getProductCost(line.product_id);
  const newQuantity = oldQuantity + signedQuantity;
  const newAvailableQuantity = oldAvailableQuantity + signedQuantity;

  if (!allowNegative && (newQuantity < 0 || newAvailableQuantity < 0)) {
    throw new Error(`库存不足，产品ID ${line.product_id} 当前可用 ${oldAvailableQuantity}，本次出库 ${Math.abs(signedQuantity)}`);
  }

  const newTotalCost = oldTotalCost + signedQuantity * unitCost;
  const payload = {
    product_id: line.product_id,
    warehouse_id: line.warehouse_id,
    quantity: newQuantity,
    available_quantity: newAvailableQuantity,
    locked_quantity: toNumber(existing?.locked_quantity),
    unit_cost: newQuantity === 0 ? unitCost : Math.abs(newTotalCost / newQuantity),
    total_cost: newTotalCost,
    batch_no: line.batch_no || null,
    expiry_date: line.expiry_date || null,
  };

  if (existing) {
    const { error } = await supabase.from(inventoryTable).update(payload).eq('id', existing.id);
    if (error) throw error;
    return;
  }

  const { error } = await supabase.from(inventoryTable).insert([{ ...payload, is_deleted: 'n' }]);
  if (error) throw error;
}

async function insertInventoryTransaction(config: StockDocumentConfig, line: StockPostingLine, signedQuantity: number) {
  const unitCost = toNumber(line.unit_cost) || await getProductCost(line.product_id);
  const { error } = await supabase.from(inventoryTransactionTable).insert([{
    transaction_no: `IT${Date.now()}${Math.floor(Math.random() * 1000)}`,
    transaction_type: config.direction === 'in' ? 'inbound' : 'outbound',
    transaction_date: normalizeDate(config.documentDate),
    product_id: line.product_id,
    warehouse_id: line.warehouse_id,
    batch_no: line.batch_no || null,
    quantity: signedQuantity,
    unit_cost: unitCost,
    total_cost: signedQuantity * unitCost,
    reference_type: config.documentType,
    reference_id: config.documentId,
    remark: `${getReferenceLabel(config.documentType)} ${config.documentNo} 过账`,
    is_deleted: 'n',
  }]);

  if (error) throw error;
}

export async function postStockDocument(config: StockDocumentConfig) {
  await logWithTiming(`${getReferenceLabel(config.documentType)}过账`, 'POST', async () => {
    const { data: existingTransactions, error: transactionError } = await supabase
      .from(inventoryTransactionTable)
      .select('id')
      .eq('is_deleted', 'n')
      .eq('reference_type', config.documentType)
      .eq('reference_id', config.documentId);

    if (transactionError) throw transactionError;
    if ((existingTransactions || []).length > 0) {
      throw new Error('该单据已经过账，不能重复过账');
    }

    const lines = await fetchStockLines(config);
    if (lines.length === 0) {
      throw new Error('单据没有明细，不能过账');
    }

    for (const line of lines) {
      if (!line.product_id || !line.warehouse_id || toNumber(line.quantity) <= 0) {
        throw new Error('单据明细缺少产品、仓库或有效数量');
      }

      const signedQuantity = config.direction === 'in' ? toNumber(line.quantity) : -toNumber(line.quantity);
      const allowNegative = await getWarehouseAllowsNegative(line.warehouse_id);
      await applyInventoryDelta(line, signedQuantity, allowNegative);
      await insertInventoryTransaction(config, line, signedQuantity);
    }

    const { error } = await supabase
      .from(config.headerTable)
      .update({ status: 'posted' })
      .eq('id', config.documentId);
    if (error) throw error;
  }, { table: config.headerTable, recordId: config.documentId, user: config.user?.username });
}

export async function reverseStockDocument(config: StockDocumentConfig) {
  await logWithTiming(`${getReferenceLabel(config.documentType)}反过账`, 'UNPOST', async () => {
    const { data: transactions, error } = await supabase
      .from(inventoryTransactionTable)
      .select('*')
      .eq('is_deleted', 'n')
      .eq('reference_type', config.documentType)
      .eq('reference_id', config.documentId);

    if (error) throw error;
    if (!transactions || transactions.length === 0) {
      throw new Error('没有找到该单据的库存流水，不能反过账');
    }

    for (const transaction of transactions) {
      const reversalLine: StockPostingLine = {
        product_id: transaction.product_id,
        warehouse_id: transaction.warehouse_id,
        quantity: Math.abs(toNumber(transaction.quantity)),
        unit_cost: transaction.unit_cost,
        batch_no: transaction.batch_no,
      };
      await applyInventoryDelta(reversalLine, -toNumber(transaction.quantity), true);
    }

    const { error: markError } = await supabase
      .from(inventoryTransactionTable)
      .update({ is_deleted: 'y' })
      .eq('reference_type', config.documentType)
      .eq('reference_id', config.documentId);
    if (markError) throw markError;

    const { error: statusError } = await supabase
      .from(config.headerTable)
      .update({ status: 'approved' })
      .eq('id', config.documentId);
    if (statusError) throw statusError;
  }, { table: config.headerTable, recordId: config.documentId, user: config.user?.username });
}

export async function validateVoucherBalance(voucherId: number) {
  const { data, error } = await supabase
    .from('erp_voucher_details_s_539dcf81_b')
    .select('debit_amount, credit_amount')
    .eq('is_deleted', 'n')
    .eq('voucher_id', voucherId);

  if (error) throw error;
  if (!data || data.length < 2) {
    throw new Error('凭证至少需要两条分录');
  }

  const debit = data.reduce((sum, item) => sum + toNumber(item.debit_amount), 0);
  const credit = data.reduce((sum, item) => sum + toNumber(item.credit_amount), 0);

  if (debit <= 0 || credit <= 0) {
    throw new Error('凭证借方和贷方金额都必须大于 0');
  }

  if (!nearlyEqual(debit, credit)) {
    throw new Error(`凭证借贷不平衡：借方 ${debit.toFixed(2)}，贷方 ${credit.toFixed(2)}`);
  }

  return { debit, credit, totalAmount: debit };
}

export async function postVoucher(voucherId: number, user?: BusinessUser) {
  await logWithTiming('凭证过账', 'POST', async () => {
    const totals = await validateVoucherBalance(voucherId);
    const { error } = await supabase
      .from('erp_vouchers_s_539dcf81_b')
      .update({
        status: 'posted',
        posted_at: new Date().toISOString(),
        posted_by: user?.id ?? null,
        total_amount: totals.totalAmount,
      })
      .eq('id', voucherId);
    if (error) throw error;
  }, { table: 'erp_vouchers_s_539dcf81_b', recordId: voucherId, user: user?.username });
}

export async function reverseVoucher(voucherId: number, user?: BusinessUser) {
  await logWithTiming('凭证反过账', 'UNPOST', async () => {
    const { error } = await supabase
      .from('erp_vouchers_s_539dcf81_b')
      .update({
        status: 'draft',
        posted_at: null,
        posted_by: null,
      })
      .eq('id', voucherId);
    if (error) throw error;
  }, { table: 'erp_vouchers_s_539dcf81_b', recordId: voucherId, user: user?.username });
}

async function fetchDocument(documentType: BusinessDocumentType, documentId: number) {
  const meta = documentMeta[documentType];
  const { data, error } = await supabase
    .from(meta.table)
    .select('*')
    .eq('id', documentId)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new Error('单据不存在');
  return data as any;
}

function buildStockConfig(
  documentType: StockDocumentType,
  document: any,
  documentId: number,
  user?: BusinessUser,
): StockDocumentConfig {
  const meta = documentMeta[documentType];
  return {
    documentId,
    documentNo: document[meta.noField],
    documentDate: normalizeDate(document[meta.dateField]),
    documentType,
    direction: meta.direction,
    headerTable: meta.table,
    detailTable: meta.detailTable,
    detailForeignKey: meta.detailForeignKey,
    warehouseId: document.warehouse_id,
    user,
  };
}

export async function runBusinessAction(params: RunBusinessActionParams) {
  const { action, documentType, documentId, user } = params;

  if (documentType === 'voucher') {
    if (action === 'post' || action === 'post_voucher') {
      await postVoucher(documentId, user);
      return { ok: true, message: '凭证已过账' };
    }
    if (action === 'reverse_post' || action === 'reverse_voucher') {
      await reverseVoucher(documentId, user);
      return { ok: true, message: '凭证已反过账' };
    }
  }

  if (action === 'submit') {
    await submitForApproval(documentMeta[documentType].table, documentId, user);
    return { ok: true, message: '单据已提交审批' };
  }

  if (action === 'approve') {
    await approveDocument(documentMeta[documentType].table, documentId, user);
    return { ok: true, message: '单据已审核' };
  }

  if (documentType === 'purchase_receipt' || documentType === 'sales_delivery') {
    const document = await fetchDocument(documentType, documentId);
    const config = buildStockConfig(documentType, document, documentId, user);

    if (action === 'post') {
      await postStockDocument(config);
      return { ok: true, message: '库存单据已过账' };
    }
    if (action === 'reverse_post') {
      await reverseStockDocument(config);
      return { ok: true, message: '库存单据已反过账' };
    }
  }

  throw new Error(`不支持的业务动作：${documentType}/${action}`);
}
