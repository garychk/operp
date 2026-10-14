/**
 * BAQ 表名的「显示名」处理。
 *
 * 多租户物理表名带租户后缀，例如 erp_products_s_539dcf81_b。
 * 界面上（下拉项、ER 卡片标题、关联列表…）只显示去掉后缀的短名，
 * **任何写库 / 查询 / RPC 参数一律使用完整物理表名**（即 value）。
 */
const TENANT_TABLE_SUFFIX = /_s_[0-9a-f]{6,}_[a-z0-9]{1,4}$/i;

/** erp_products_s_539dcf81_b → erp_products；无后缀时原样返回 */
export function shortTableName(name: string | null | undefined): string {
  const value = (name ?? "").trim();
  if (!value) return "";
  return value.replace(TENANT_TABLE_SUFFIX, "") || value;
}

/** 显示名优先业务标签（sys_tables.table_label），否则回退短表名 */
export function tableDisplayName(
  table: string,
  label?: string | null,
): string {
  const cleanLabel = shortTableName(label);
  // 标签与表名等价（都是物理名）时直接用短表名，避免「A · A」这种重复
  if (!cleanLabel || cleanLabel === shortTableName(table)) {
    return shortTableName(table) || table;
  }
  return cleanLabel;
}
