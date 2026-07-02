import { runBusinessAction } from './businessEngine';

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

const findAction = (text: string) => actionPatterns.find((item) => item.keywords.some((keyword) => text.includes(keyword)))?.action;
const findDocumentType = (text: string) => documentPatterns.find((item) => item.keywords.some((keyword) => text.includes(keyword)))?.documentType;

const findDocumentId = (text: string) => {
  const idMatch = text.match(/(?:id|ID|编号|单据ID|记录ID)\s*[:：#]?\s*(\d+)/);
  if (idMatch) return Number(idMatch[1]);

  const looseMatch = text.match(/(?:单|单据|凭证)\s*(\d+)/);
  if (looseMatch) return Number(looseMatch[1]);

  const numberMatch = text.match(/\b(\d+)\b/);
  return numberMatch ? Number(numberMatch[1]) : null;
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
      reply: '请说明要执行的动作和单据类型，例如：把采购入库单 ID 12 过账。',
    };
  }

  const documentId = findDocumentId(text);
  if (!documentId) {
    return {
      status: 'invalid',
      reply: `请提供${documentLabel[documentType]}的记录 ID，例如：${documentLabel[documentType]} ID 12 ${actionLabel[action]}。`,
    };
  }

  try {
    const result = await runBusinessAction({ action, documentType, documentId, user });
    return {
      status: 'executed',
      reply: `${documentLabel[documentType]} ID ${documentId} ${actionLabel[action]}成功。${result.message}`,
    };
  } catch (error: any) {
    return {
      status: 'error',
      reply: `${documentLabel[documentType]} ID ${documentId} ${actionLabel[action]}失败：${error?.message || String(error)}`,
    };
  }
}
