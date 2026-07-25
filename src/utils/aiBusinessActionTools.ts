import { runBusinessAction } from './businessEngine';
import { supabase } from './supabase';

type AiActionStatus = 'ignored' | 'executed' | 'invalid' | 'error';
type AiDocumentType = 'purchase_order' | 'sales_order' | 'purchase_receipt' | 'sales_delivery' | 'voucher';
type AiBusinessAction = 'submit' | 'approve' | 'post' | 'reverse_post';

interface AiBusinessUser {
  id?: number | null;
  username?: string | null;
}

export interface AiBusinessActionResult {
  status: AiActionStatus;
  reply?: string;
}

interface DocumentRef {
  kind: 'id' | 'no';
  value: number | string;
}

interface DocumentConfig {
  table: string;
  noField: string;
}

const actionPatterns: Array<{ action: AiBusinessAction; keywords: string[] }> = [
  { action: 'reverse_post', keywords: ['反过账', '取消过账', '撤销过账'] },
  { action: 'post', keywords: ['过账', '记账'] },
  { action: 'approve', keywords: ['审核', '审批', '批准'] },
  { action: 'submit', keywords: ['提交', '提交审批', '送审'] },
];

const documentPatterns: Array<{ documentType: AiDocumentType; keywords: string[] }> = [
  { documentType: 'purchase_receipt', keywords: ['采购入库', '入库单', '采购收货'] },
  { documentType: 'sales_delivery', keywords: ['销售出货', '销售出库', '出货单', '发货单'] },
  { documentType: 'purchase_order', keywords: ['采购订单', '采购单'] },
  { documentType: 'sales_order', keywords: ['销售订单', '销售单'] },
  { documentType: 'voucher', keywords: ['凭证', '会计凭证'] },
];

const actionLabel: Record<AiBusinessAction, string> = {
  submit: '提交审批',
  approve: '审核',
  post: '过账',
  reverse_post: '反过账',
};

const documentLabel: Record<AiDocumentType, string> = {
  purchase_order: '采购订单',
  sales_order: '销售订单',
  purchase_receipt: '采购入库单',
  sales_delivery: '销售出货单',
  voucher: '凭证',
};

const documentConfig: Record<AiDocumentType, DocumentConfig> = {
  purchase_order: { table: 'erp_purchase_orders_s_539dcf81_b', noField: 'order_no' },
  sales_order: { table: 'erp_sales_orders_s_539dcf81_b', noField: 'order_no' },
  purchase_receipt: { table: 'erp_purchase_receipts_s_539dcf81_b', noField: 'receipt_no' },
  sales_delivery: { table: 'erp_sales_deliveries_s_539dcf81_b', noField: 'delivery_no' },
  voucher: { table: 'erp_vouchers_s_539dcf81_b', noField: 'voucher_no' },
};

const findAction = (text: string) =>
  actionPatterns.find((item) => item.keywords.some((keyword) => text.includes(keyword)))?.action;

const findDocumentType = (text: string) =>
  documentPatterns.find((item) => item.keywords.some((keyword) => text.includes(keyword)))?.documentType;

const normalizeToken = (value: string) => value.trim().replace(/[，,。；;]$/, '');

const parseDocumentRef = (text: string): DocumentRef | null => {
  const explicitMatch = text.match(/(?:id|ID|编号|单号|单据号|单据ID|记录ID)\s*[:：#]?\s*([A-Za-z0-9_-]+)/);
  if (explicitMatch) {
    const token = normalizeToken(explicitMatch[1]);
    return /^\d+$/.test(token) ? { kind: 'id', value: Number(token) } : { kind: 'no', value: token };
  }

  const businessNoMatch = text.match(/\b([A-Za-z]{1,10}[A-Za-z0-9_-]*\d[A-Za-z0-9_-]*)\b/);
  if (businessNoMatch) {
    return { kind: 'no', value: normalizeToken(businessNoMatch[1]) };
  }

  const looseMatch = text.match(/(?:单|单据|凭证)\s*(\d+)/);
  if (looseMatch) {
    return { kind: 'id', value: Number(looseMatch[1]) };
  }

  const numberMatch = text.match(/\b(\d+)\b/);
  return numberMatch ? { kind: 'id', value: Number(numberMatch[1]) } : null;
};

const resolveDocumentId = async (documentType: AiDocumentType, ref: DocumentRef) => {
  if (ref.kind === 'id') {
    return { documentId: Number(ref.value), documentNo: null as string | null };
  }

  const config = documentConfig[documentType];
  const { data, error } = await supabase
    .from(config.table)
    .select(`id, ${config.noField}`)
    .eq(config.noField, String(ref.value))
    .eq('is_deleted', 'n')
    .maybeSingle();

  if (error) {
    throw error;
  }

  const record = data as Record<string, unknown> | null;
  if (!record?.id) {
    return { documentId: null, documentNo: String(ref.value) };
  }

  return { documentId: Number(record.id), documentNo: String(record[config.noField] || ref.value) };
};

export async function handleBusinessActionSkill(text: string, user?: AiBusinessUser): Promise<AiBusinessActionResult> {
  const action = findAction(text);
  const documentType = findDocumentType(text);

  if (!action && !documentType) {
    return { status: 'ignored' };
  }

  if (!action || !documentType) {
    return {
      status: 'invalid',
      reply: '请说明要执行的动作和单据类型，例如：把采购入库单 PR22432654 过账，或把采购入库单 ID 12 过账。',
    };
  }

  const documentRef = parseDocumentRef(text);
  if (!documentRef) {
    return {
      status: 'invalid',
      reply: `请提供${documentLabel[documentType]}的记录 ID 或单据编号，例如：${documentLabel[documentType]} PR22432654 ${actionLabel[action]}，或 ${documentLabel[documentType]} ID 12 ${actionLabel[action]}。`,
    };
  }

  try {
    const { documentId, documentNo } = await resolveDocumentId(documentType, documentRef);
    if (!documentId) {
      return {
        status: 'invalid',
        reply: `没有找到${documentLabel[documentType]}编号 ${documentRef.value}，请确认单据编号是否正确。`,
      };
    }

    const result = await runBusinessAction({ action, documentType, documentId, user });
    const targetText = documentNo ? `编号 ${documentNo}` : `ID ${documentId}`;
    return {
      status: 'executed',
      reply: `${documentLabel[documentType]} ${targetText} ${actionLabel[action]}成功。${result.message}`,
    };
  } catch (error: any) {
    const targetText = documentRef.kind === 'no' ? `编号 ${documentRef.value}` : `ID ${documentRef.value}`;
    return {
      status: 'error',
      reply: `${documentLabel[documentType]} ${targetText} ${actionLabel[action]}失败：${error?.message || String(error)}`,
    };
  }
}
