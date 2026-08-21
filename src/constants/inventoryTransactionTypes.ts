export const INVENTORY_TRANSACTION_TYPES = {
  PURCHASE_RECEIPT_IN: 'purchase_receipt_in',
  SALES_DELIVERY_OUT: 'sales_delivery_out',
  PURCHASE_RETURN_OUT: 'purchase_return_out',
  SALES_RETURN_IN: 'sales_return_in',
  INVENTORY_TRANSFER_OUT: 'inventory_transfer_out',
  INVENTORY_TRANSFER_IN: 'inventory_transfer_in',
  STOCK_COUNT_INCREASE: 'stock_count_increase',
  STOCK_COUNT_DECREASE: 'stock_count_decrease',
  STOCK_ADJUST_IN: 'stock_adjust_in',
  STOCK_ADJUST_OUT: 'stock_adjust_out',
  MATERIAL_ISSUE_OUT: 'material_issue_out',
  MATERIAL_RETURN_IN: 'material_return_in',
  PRODUCTION_RECEIPT_IN: 'production_receipt_in',
  SCRAP_OUT: 'scrap_out',
  OPENING_BALANCE_IN: 'opening_balance_in',
  OPENING_BALANCE_OUT: 'opening_balance_out',
  QUALITY_HOLD: 'quality_hold',
  QUALITY_RELEASE: 'quality_release',
  INVENTORY_FREEZE: 'inventory_freeze',
  INVENTORY_UNFREEZE: 'inventory_unfreeze',
  COST_REVALUATION: 'cost_revaluation',
} as const;

export type InventoryTransactionType =
  (typeof INVENTORY_TRANSACTION_TYPES)[keyof typeof INVENTORY_TRANSACTION_TYPES];

export const INVENTORY_TRANSACTION_TYPE_LABELS: Record<
  InventoryTransactionType,
  string
> = {
  [INVENTORY_TRANSACTION_TYPES.PURCHASE_RECEIPT_IN]: '采购入库',
  [INVENTORY_TRANSACTION_TYPES.SALES_DELIVERY_OUT]: '销售出货',
  [INVENTORY_TRANSACTION_TYPES.PURCHASE_RETURN_OUT]: '采购退货',
  [INVENTORY_TRANSACTION_TYPES.SALES_RETURN_IN]: '销售退货',
  [INVENTORY_TRANSACTION_TYPES.INVENTORY_TRANSFER_OUT]: '库存调拨出库',
  [INVENTORY_TRANSACTION_TYPES.INVENTORY_TRANSFER_IN]: '库存调拨入库',
  [INVENTORY_TRANSACTION_TYPES.STOCK_COUNT_INCREASE]: '盘点盘盈',
  [INVENTORY_TRANSACTION_TYPES.STOCK_COUNT_DECREASE]: '盘点盘亏',
  [INVENTORY_TRANSACTION_TYPES.STOCK_ADJUST_IN]: '库存调整增加',
  [INVENTORY_TRANSACTION_TYPES.STOCK_ADJUST_OUT]: '库存调整减少',
  [INVENTORY_TRANSACTION_TYPES.MATERIAL_ISSUE_OUT]: '生产领料',
  [INVENTORY_TRANSACTION_TYPES.MATERIAL_RETURN_IN]: '生产退料',
  [INVENTORY_TRANSACTION_TYPES.PRODUCTION_RECEIPT_IN]: '生产完工入库',
  [INVENTORY_TRANSACTION_TYPES.SCRAP_OUT]: '报废出库',
  [INVENTORY_TRANSACTION_TYPES.OPENING_BALANCE_IN]: '期初入库',
  [INVENTORY_TRANSACTION_TYPES.OPENING_BALANCE_OUT]: '期初冲销',
  [INVENTORY_TRANSACTION_TYPES.QUALITY_HOLD]: '质量冻结',
  [INVENTORY_TRANSACTION_TYPES.QUALITY_RELEASE]: '质量解冻',
  [INVENTORY_TRANSACTION_TYPES.INVENTORY_FREEZE]: '库存冻结',
  [INVENTORY_TRANSACTION_TYPES.INVENTORY_UNFREEZE]: '库存解冻',
  [INVENTORY_TRANSACTION_TYPES.COST_REVALUATION]: '成本重估',
};

export const INVENTORY_TRANSACTION_TYPE_OPTIONS = Object.entries(
  INVENTORY_TRANSACTION_TYPE_LABELS,
).map(([value, label]) => ({ value, label }));

export const INVENTORY_TRANSACTION_TYPE_ALIASES: Record<string, InventoryTransactionType> = {
  inbound: INVENTORY_TRANSACTION_TYPES.PURCHASE_RECEIPT_IN,
  outbound: INVENTORY_TRANSACTION_TYPES.SALES_DELIVERY_OUT,
};

export const normalizeInventoryTransactionType = (
  value: string | null | undefined,
): InventoryTransactionType | string => {
  if (!value) return value ?? '';
  return INVENTORY_TRANSACTION_TYPE_ALIASES[value] ?? value;
};
