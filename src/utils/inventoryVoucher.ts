/**
 * 库存过账 → 会计凭证（supabase/tables/deploy_87_inventory_gl_linkage.sql）
 *
 * 三个过账 RPC（post_stock_document / post_inventory_document /
 * post_production_document）的返回值里多了一个 `voucher` 字段：
 *
 *   { ok, generated, skipped_reason, voucher_id, voucher_no, error }
 *
 * 它回答一个问题：**这次库存过账在总账上留下痕迹了吗？**
 *
 * 设计约定（deploy_87 文件头「关键设计取舍 a」）：
 * 会计侧的任何问题都不阻断库存过账 —— 月结期间（会计期间已关闭）还能不能收发货，
 * 是比「存货与总账无勾稽」更严重的生产问题。代价是必须**响亮地**把原因说出来，
 * 否则就成了「库存动了、账没动」这类最难查的静默差异。这个模块负责后半件事。
 */

export type InventoryVoucherResult = {
  ok?: boolean;
  /** 生成侧：是否真的生成了凭证 */
  generated?: boolean;
  /** 作废侧：是否找到了对应凭证 / 是否真的作废掉 */
  found?: boolean;
  voided?: boolean;
  skipped_reason?: string;
  voucher_id?: number;
  voucher_no?: string;
  error?: string;
} | null | undefined;

/** 过账 RPC 的返回值形状（只取我们关心的字段） */
type PostingRpcResult = {
  voucher?: InventoryVoucherResult;
} | null | undefined;

/**
 * 需要在界面上提醒的原因码。其余（no_voucher_required / voucher_already_posted /
 * no_inventory_transactions / zero_amount / no_voucher）都是预期内的正常跳过，
 * 不必打扰操作人。
 */
const NOTIFY_REASONS: readonly string[] = [
  // 生成侧（inventory_sync_voucher）
  'no_accounting_period',
  'period_not_enabled',
  'period_closed',
  'period_locked',
  'subject_not_found',
  'voucher_post_failed',
  // 作废侧（inventory_void_voucher）：库存已经反过账，但凭证没能一起作废
  'voucher_reverse_failed',
];

/** 原因码 → i18n key 后缀（在 locales 的 inventoryVoucher.reason.* 下） */
const KNOWN_REASONS = new Set(NOTIFY_REASONS);

/**
 * 把一条过账 / 反过账返回翻成一句给操作人看的话。
 * 不需要提醒（正常生成 / 预期内跳过）时返回 null。
 */
export function voucherNotice(
  result: PostingRpcResult,
  t: (key: string, options?: Record<string, unknown>) => string,
): string | null {
  const v = result?.voucher;
  if (!v || v.generated) return null;

  const reason = v.skipped_reason;
  if (!reason || !NOTIFY_REASONS.includes(reason)) return null;

  const detail = KNOWN_REASONS.has(reason)
    ? t(`inventoryVoucher.reason.${reason}`)
    : reason;

  // 作废侧失败与生成侧失败要说清楚是哪个方向没同步，否则操作人不知道
  // 该去补凭证还是去删凭证。
  const template = reason === 'voucher_reverse_failed'
    ? 'inventoryVoucher.voidSkipped'
    : 'inventoryVoucher.skipped';

  return t(template, { reason: detail });
}

/**
 * 批量过账后收集需要提醒的条目（每条一句话，已去重）。
 * 用于工具栏批量过账：批量场景下把相同原因合并成一条提示，避免刷屏。
 */
export function collectVoucherNotices(
  results: Array<{ label?: string; result: PostingRpcResult }>,
  t: (key: string, options?: Record<string, unknown>) => string,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const { label, result } of results) {
    const notice = voucherNotice(result, t);
    if (!notice) continue;
    const line = label ? `${label}：${notice}` : notice;
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return out;
}
