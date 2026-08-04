import { supabase } from './supabase';
import { logWithTiming } from './logger';

type StockDocumentType = 'purchase_receipt' | 'sales_delivery';
type WorkflowAction = 'submit' | 'approve' | 'reject' | 'withdraw';
type BusinessAction =
  | WorkflowAction
  | 'post'
  | 'reverse_post'
  | 'post_voucher'
  | 'reverse_voucher';
type BusinessDocumentType =
  | StockDocumentType
  | 'purchase_order'
  | 'sales_order'
  | 'voucher';

interface BusinessUser {
  id?: number | null;
  username?: string | null;
}

interface RunBusinessActionParams {
  action: BusinessAction;
  documentType: BusinessDocumentType;
  documentId: number;
  user?: BusinessUser;
  comment?: string;
}

const nearlyEqual = (a: number, b: number) => Math.abs(a - b) < 0.005;
const toNumber = (value: number | string | null | undefined) => Number(value || 0);

const documentMeta = {
  purchase_order: { table: 'erp_purchase_orders_s_539dcf81_b' },
  sales_order: { table: 'erp_sales_orders_s_539dcf81_b' },
  purchase_receipt: { table: 'erp_purchase_receipts_s_539dcf81_b' },
  sales_delivery: { table: 'erp_sales_deliveries_s_539dcf81_b' },
  voucher: { table: 'erp_vouchers_s_539dcf81_b' },
} as const;

export async function approveDocument(
  tableName: string,
  documentId: number,
  user?: BusinessUser,
  extraValues: Record<string, unknown> = {},
) {
  await logWithTiming(
    '审核单据',
    'APPROVE',
    async () => {
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
    },
    { table: tableName, recordId: documentId, user: user?.username },
  );
}

export async function submitForApproval(
  tableName: string,
  documentId: number,
  user?: BusinessUser,
) {
  await logWithTiming(
    '提交审批',
    'SUBMIT',
    async () => {
      const { error } = await supabase.from(tableName).update({ status: 'pending' }).eq('id', documentId);
      if (error) throw error;
    },
    { table: tableName, recordId: documentId, user: user?.username },
  );
}

async function runStockPostingRpc(
  action: 'post' | 'reverse_post',
  documentType: StockDocumentType,
  documentId: number,
  user?: BusinessUser,
) {
  const rpcName = action === 'post' ? 'post_stock_document' : 'reverse_stock_document';
  const documentLabel = documentType === 'purchase_receipt' ? '采购入库单' : '销售出货单';
  const operationLabel = action === 'post' ? '过账' : '反过账';

  return logWithTiming(
    `${documentLabel}${operationLabel}`,
    action === 'post' ? 'POST' : 'UNPOST',
    async () => {
      const { data, error } = await supabase.rpc(rpcName, {
        p_document_type: documentType,
        p_document_id: documentId,
        p_idempotency_key: crypto.randomUUID(),
      });

      if (error) throw error;
      return data;
    },
    {
      table: documentMeta[documentType].table,
      recordId: documentId,
      user: user?.username,
    },
  );
}

async function runWorkflowRpc(
  action: WorkflowAction,
  documentType: BusinessDocumentType,
  documentId: number,
  user?: BusinessUser,
  comment?: string,
) {
  const actionLabelMap = {
    submit: '提交审批',
    approve: '审核',
    reject: '驳回',
    withdraw: '撤回',
  } as const;

  return logWithTiming(
    `${actionLabelMap[action]}-${documentType}`,
    action.toUpperCase(),
    async () => {
      const { data, error } = await supabase.rpc('workflow_execute_action', {
        p_document_type: documentType,
        p_document_id: documentId,
        p_action: action,
        p_comment: comment || null,
      });
      if (error) throw error;
      return data;
    },
    {
      table: documentMeta[documentType].table,
      recordId: documentId,
      user: user?.username,
    },
  );
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
  await logWithTiming(
    '凭证过账',
    'POST',
    async () => {
      const { data, error } = await supabase.rpc('post_voucher_document', {
        p_voucher_id: voucherId,
        p_idempotency_key: crypto.randomUUID(),
      });
      if (error) throw error;
      return data;
    },
    { table: 'erp_vouchers_s_539dcf81_b', recordId: voucherId, user: user?.username },
  );
}

export async function reverseVoucher(voucherId: number, user?: BusinessUser) {
  await logWithTiming(
    '凭证反过账',
    'UNPOST',
    async () => {
      const { data, error } = await supabase.rpc('reverse_voucher_document', {
        p_voucher_id: voucherId,
        p_idempotency_key: crypto.randomUUID(),
      });
      if (error) throw error;
      return data;
    },
    { table: 'erp_vouchers_s_539dcf81_b', recordId: voucherId, user: user?.username },
  );
}

export async function runBusinessAction(params: RunBusinessActionParams) {
  const { action, documentType, documentId, user, comment } = params;

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

  if (action === 'submit' || action === 'approve' || action === 'reject' || action === 'withdraw') {
    await runWorkflowRpc(action, documentType, documentId, user, comment);
    return {
      ok: true,
      message:
        action === 'submit'
          ? '单据已提交审批'
          : action === 'approve'
            ? '单据已审核'
            : action === 'reject'
              ? '单据已驳回'
              : '单据已撤回',
    };
  }

  if (documentType === 'purchase_receipt' || documentType === 'sales_delivery') {
    if (action === 'post' || action === 'reverse_post') {
      await runStockPostingRpc(action, documentType, documentId, user);
      return { ok: true, message: action === 'post' ? '库存单据已过账' : '库存单据已反过账' };
    }
  }

  throw new Error(`不支持的业务动作：${documentType}/${action}`);
}

