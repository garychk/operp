import { supabase } from "../config/supabase.js";
import { tenantScopeFilter } from "../config/tenantContext.js";
import { callChatModel } from "../config/llm.js";
import type { AiGraphState } from "../ai/state.js";

/**
 * 数据库驱动的实体注册表。
 *
 * 表目录来自 public.sys_tables（由 refresh_sys_tables() 自动同步物理表），
 * 列元数据来自 public.ai_entity_catalog()（deploy_39）；
 * 该 RPC 不存在时回退到 execute_ai_analysis() 读取 information_schema。
 *
 * 写保护策略集中在 evaluateWritePolicy()（2026-10-04 放宽口径）：
 *   默认全部表可写；只读白名单收窄为——
 *   sys_users / sys_tenants / sys_roles / sys_user_roles / sys_logs / sys_mcp_api_keys
 *   以及 sys_ai_* 前缀（AI 平台自身的会话 / 知识库数据）。
 *   任何表仍不提供删除能力（evaluateDeletePolicy）。
 */

export interface EntityColumn {
  name: string;
  dataType: string;
  isNullable: boolean;
  hasDefault: boolean;
  defaultValue: string | null;
  note: string;
  refTable?: string;
  refTableLabel?: string;
  refColumn?: string;
}

export interface EntityTable {
  table: string;
  label: string;
  module: string;
  columns: EntityColumn[];
}

export interface EntityField {
  key: string;
  label: string;
}

export interface EntityDef {
  key: string;
  label: string;
  tableName: string;
  module: string;
  codeField: string;
  nameField: string;
  columns: EntityColumn[];
  insertableFields: string[];
  requiredFields: EntityField[];
  optionalFields: EntityField[];
  keywords: string[];
  routeHints: string[];
  defaults: () => Record<string, unknown>;
  createTitle: string;
  writable: boolean;
  readOnlyReason?: string;
}

export interface ResolveResult {
  def?: EntityDef;
  error?: string;
}

interface CuratedEntity {
  label?: string;
  codeField?: string;
  nameField?: string;
  keywords?: string[];
  routeHints?: string[];
  requiredFields?: EntityField[];
  optionalFields?: EntityField[];
  defaults?: () => Record<string, unknown>;
  priority?: number;
}

const today = () => new Date().toISOString().slice(0, 10);
const serial = (prefix: string) => `${prefix}${Date.now().toString().slice(-8)}`;

/** 由系统自动维护、不允许 AI 直接写入的列 */
const NON_INSERTABLE_COLUMNS = new Set(["id", "created_at", "updated_at"]);

/** 去掉租户后缀：erp_uoms_s_539dcf81_b -> erp_uoms */
const baseTableName = (table: string) => table.replace(/_s_[0-9a-f]{6,}_[a-z]$/i, "");

/**
 * 用户可见文本里的物理表名统一剥租户后缀。
 *
 * 背景：物理表名带 `_s_<项目id>_<字母>` 后缀（多租户设计如此），但这个内部
 * 实现细节不应出现在给用户看的回复里。LLM 的 prompt 里会出现物理表名
 * （分析 SQL 生成必须要用），模型可能原样复述 → 在 responseComposer
 * 对最终回复统一清洗一遍，静态拼接的回复也在源头剥掉。
 *
 * 注意：只用于「展示文本」。真正要执行/落库的地方（supabase.from、SQL）
 * 必须继续使用物理表名。
 */
const TENANT_SUFFIX_IN_TEXT_RE = /\b([A-Za-z][A-Za-z0-9_]*?)_s_[0-9a-f]{6,}_[a-z]\b/g;
const stripTenantSuffixInText = (text: string): string =>
  text.replace(TENANT_SUFFIX_IN_TEXT_RE, (_match, base: string) => base);

/** 人工语义配置用的短键：erp_uoms -> uoms */
const shortKeyOf = (table: string) => baseTableName(table).replace(/^(erp|sys|wf|doc_flow)_/, "");

/** intentRouter 的 target 与物理表的映射（含历史 camelCase 目标） */
const TARGET_TO_TABLE: Record<string, string> = {
  customer: "erp_customers",
  supplier: "erp_suppliers",
  product: "erp_products",
  warehouse: "erp_warehouses",
  department: "erp_departments",
  workCenter: "erp_work_centers",
  operation: "erp_operations",
  bom: "erp_boms",
  routing: "erp_routing_operations",
  purchaseOrder: "erp_purchase_orders",
  salesOrder: "erp_sales_orders",
  purchaseReceipt: "erp_purchase_receipts",
  salesDelivery: "erp_sales_deliveries",
  productionOrder: "erp_production_orders",
  // 系统字典项：与业务表同名概念区分，用户说「字典」时命中
  dictItem: "sys_dict_items",
  dictType: "sys_dict_types",
  uom: "erp_uoms",
  uomGroup: "erp_uom_groups",
  bin: "erp_bins",
  company: "erp_companies",
  employee: "erp_employees",
  productCategory: "erp_product_categories",
  inventoryTransfer: "erp_inventory_transfers",
  stockAdjustment: "erp_stock_adjustments",
  stockCount: "erp_stock_counts",
  materialIssue: "erp_material_issues",
  productionReceipt: "erp_production_receipts",
  salesReturn: "erp_sales_returns",
  qualityInspection: "erp_quality_inspections",
  voucher: "erp_vouchers",
};

export { baseTableName, shortKeyOf, stripTenantSuffixInText };

/**
 * 人工语义层：只给需要特殊默认值 / 关键词 / 字段说明的表写配置，
 * 其余表完全由 sys_tables 的中文标签 + information_schema 自动推导。
 */
const CURATED: Record<string, CuratedEntity> = {
  customers: {
    label: "客户",
    keywords: ["客户", "客商"],
    routeHints: ["客户管理", "客户"],
    defaults: () => ({ type: "enterprise", level: "normal", credit_limit: 0, status: "active" }),
    requiredFields: [
      { key: "code", label: "客户编码" },
      { key: "name", label: "客户名称" },
    ],
  },
  suppliers: {
    label: "供应商",
    keywords: ["供应商"],
    routeHints: ["供应商管理", "供应商"],
    defaults: () => ({ type: "manufacturer", level: "normal", credit_limit: 0, status: "active" }),
    requiredFields: [
      { key: "code", label: "供应商编码" },
      { key: "name", label: "供应商名称" },
    ],
  },
  products: {
    label: "物料",
    keywords: ["物料", "产品", "商品"],
    routeHints: ["物料管理", "物料", "产品"],
    defaults: () => ({ unit: "件", purchase_price: 0, sale_price: 0, cost_price: 0, safety_stock: 0, max_stock: 0, min_stock: 0, is_purchased: true, is_sold: true, is_manufactured: false, status: "active" }),
    requiredFields: [
      { key: "code", label: "物料编码" },
      { key: "name", label: "物料名称" },
    ],
  },
  warehouses: {
    label: "仓库",
    keywords: ["仓库"],
    routeHints: ["仓库管理", "仓库"],
    defaults: () => ({ type: "raw_material", is_negative_stock_allowed: false, status: "active" }),
    requiredFields: [
      { key: "code", label: "仓库编码" },
      { key: "name", label: "仓库名称" },
    ],
  },
  departments: {
    label: "部门",
    keywords: ["部门"],
    routeHints: ["部门管理", "部门"],
    defaults: () => ({ status: "active" }),
    requiredFields: [
      { key: "code", label: "部门编码" },
      { key: "name", label: "部门名称" },
    ],
  },
  work_centers: {
    label: "工作中心",
    keywords: ["工作中心"],
    routeHints: ["工作中心", "工作中心管理"],
    defaults: () => ({ type: "machine", capacity_per_day: 8, labor_rate: 0, overhead_rate: 0, status: "active" }),
    requiredFields: [
      { key: "code", label: "工作中心编码" },
      { key: "name", label: "工作中心名称" },
    ],
  },
  operations: {
    label: "工序",
    keywords: ["工序"],
    routeHints: ["工序", "工序管理"],
    defaults: () => ({ standard_hours: 0, setup_hours: 0, labor_rate: 0, overhead_rate: 0, status: "active" }),
    requiredFields: [
      { key: "code", label: "工序编码" },
      { key: "name", label: "工序名称" },
    ],
  },
  boms: {
    label: "BOM",
    keywords: ["BOM", "物料清单"],
    routeHints: ["BOM", "BOM管理", "物料清单"],
    defaults: () => ({ bom_no: serial("BOM"), version: "1.0", quantity: 1, unit: "件", is_default: true, is_active: true, effective_date: today() }),
    requiredFields: [
      { key: "bom_no", label: "BOM编号" },
      { key: "product_id", label: "产品ID" },
    ],
  },
  routing_operations: {
    label: "工艺路线",
    keywords: ["工艺路线", "路线"],
    routeHints: ["工艺路线", "工艺路线管理"],
    defaults: () => ({ routing_no: serial("RT"), version: "1.0", is_default: true, is_active: true, effective_date: today(), total_standard_hours: 0 }),
    requiredFields: [
      { key: "routing_no", label: "工艺路线编号" },
      { key: "product_id", label: "产品ID" },
    ],
  },
  purchase_orders: {
    label: "采购订单",
    keywords: ["采购订单", "采购单"],
    routeHints: ["采购订单", "采购单"],
    defaults: () => ({ order_no: serial("PO"), order_date: today(), total_amount: 0, tax_amount: 0, payable_amount: 0, currency: "CNY", status: "draft" }),
    requiredFields: [
      { key: "order_no", label: "采购单号" },
      { key: "supplier_id", label: "供应商ID" },
      { key: "order_date", label: "订单日期" },
    ],
  },
  sales_orders: {
    label: "销售订单",
    keywords: ["销售订单", "销售单"],
    routeHints: ["销售订单", "销售单"],
    defaults: () => ({ order_no: serial("SO"), order_date: today(), total_amount: 0, tax_amount: 0, discount_amount: 0, receivable_amount: 0, currency: "CNY", status: "draft" }),
    requiredFields: [
      { key: "order_no", label: "销售单号" },
      { key: "customer_id", label: "客户ID" },
      { key: "order_date", label: "订单日期" },
    ],
  },
  purchase_receipts: {
    label: "采购入库单",
    keywords: ["采购入库单", "采购入库", "入库单"],
    routeHints: ["采购入库", "采购入库单"],
    defaults: () => ({ receipt_no: serial("PR"), receipt_date: today(), total_amount: 0, status: "draft", location_id: null }),
    requiredFields: [
      { key: "receipt_no", label: "入库单号" },
      { key: "receipt_date", label: "入库日期" },
      { key: "supplier_id", label: "供应商ID" },
      { key: "warehouse_id", label: "仓库ID" },
    ],
    optionalFields: [{ key: "location_id", label: "默认库位ID（库位表 erp_bins 的 id）" }],
  },
  sales_deliveries: {
    label: "销售出货单",
    keywords: ["销售出货单", "销售出货", "出货单"],
    routeHints: ["销售出货", "销售出货单"],
    defaults: () => ({ delivery_no: serial("SD"), delivery_date: today(), total_amount: 0, status: "draft", location_id: null }),
    requiredFields: [
      { key: "delivery_no", label: "出货单号" },
      { key: "delivery_date", label: "出货日期" },
      { key: "customer_id", label: "客户ID" },
      { key: "warehouse_id", label: "仓库ID" },
    ],
    optionalFields: [{ key: "location_id", label: "默认库位ID（库位表 erp_bins 的 id）" }],
  },
  production_orders: {
    label: "生产订单",
    keywords: ["生产订单", "生产单", "工单"],
    routeHints: ["生产订单", "工单"],
    defaults: () => ({ order_no: serial("MO"), order_date: today(), planned_quantity: 1, completed_quantity: 0, scrapped_quantity: 0, priority: 1, status: "draft" }),
    requiredFields: [
      { key: "order_no", label: "生产单号" },
      { key: "order_date", label: "订单日期" },
      { key: "product_id", label: "产品ID" },
      { key: "planned_quantity", label: "计划数量" },
    ],
  },
  /**
   * 系统字典项。与业务表（如 erp_uoms）区分开：
   * 用户说「在字典 XX 里加 / 加个字典项」时命中这里，而不是同名业务表。
   */
  dict_items: {
    label: "系统字典项",
    codeField: "code",
    nameField: "label",
    keywords: ["字典项", "字典数据", "字典值", "枚举项", "字典选项", "下拉选项"],
    routeHints: ["数据字典", "字典管理"],
    priority: 12,
    requiredFields: [
      { key: "type_id", label: "字典类型ID（也可填类型编码或名称，如 uom、计量单位、性别）" },
      { key: "code", label: "字典项编码" },
      { key: "label", label: "字典项名称" },
    ],
    optionalFields: [
      { key: "description", label: "描述" },
      { key: "sort_order", label: "排序号（数字，越大越靠后）" },
    ],
  },
  uoms: {
    label: "计量单位",
    keywords: ["计量单位", "单位", "uom"],
    routeHints: ["计量单位", "单位"],
    priority: 5,
    requiredFields: [
      { key: "code", label: "单位编码" },
      { key: "name", label: "单位名称" },
      { key: "group_id", label: "单位组ID（也可填单位组名称，如 体积、重量）" },
    ],
  },
  uom_groups: {
    label: "单位组",
    keywords: ["单位组", "计量单位组"],
    routeHints: ["单位组"],
    priority: 6,
    requiredFields: [
      { key: "code", label: "单位组编码" },
      { key: "name", label: "单位组名称" },
    ],
  },
  bins: {
    label: "库位",
    keywords: ["库位", "货位"],
    routeHints: ["库位管理", "库位"],
    priority: 4,
  },
  companies: {
    label: "公司",
    keywords: ["公司", "组织"],
    routeHints: ["公司", "组织"],
  },
  employees: {
    label: "员工",
    keywords: ["员工", "职员"],
    routeHints: ["员工管理", "员工"],
  },
  product_categories: {
    label: "物料类别",
    keywords: ["物料类别", "物料分类", "产品分类"],
    routeHints: ["物料类别", "物料分类"],
  },
  inventory_transfers: {
    label: "库存调拨单",
    keywords: ["调拨", "库存调拨"],
    routeHints: ["库存调拨"],
  },
  stock_adjustments: {
    label: "库存调整单",
    keywords: ["库存调整", "调整单"],
    routeHints: ["库存调整"],
  },
  stock_counts: {
    label: "库存盘点单",
    keywords: ["盘点", "库存盘点"],
    routeHints: ["库存盘点"],
  },
  material_issues: {
    label: "生产领料单",
    keywords: ["领料", "生产领料"],
    routeHints: ["生产领料"],
  },
  production_receipts: {
    label: "生产入库单",
    keywords: ["生产入库", "完工入库"],
    routeHints: ["生产入库"],
  },
  sales_returns: {
    label: "销售退货单",
    keywords: ["销售退货", "退货单"],
    routeHints: ["销售退货"],
  },
  quality_inspections: {
    label: "质量检验单",
    keywords: ["质检", "质量检验", "检验单"],
    routeHints: ["质量检验"],
  },
};

/* ------------------------------------------------------------------ *
 * 写保护策略
 * ------------------------------------------------------------------ */

export interface WritePolicy {
  writable: boolean;
  reason?: string;
}

/**
 * 权限 / 身份 / 审计类系统表：AI 只读。
 *
 * 这些表决定「谁能做什么」与「做过什么」，被篡改等于绕过整个权限体系：
 *   sys_users / sys_user_roles / sys_roles —— 账号、角色、授权关系；
 *   sys_tenants —— 租户本身；
 *   sys_mcp_api_keys —— MCP 凭据；
 *   sys_logs —— 审计日志（改日志 = 销毁痕迹）。
 */
const PROTECTED_TABLES = new Set([
  "sys_users",
  "sys_tenants",
  "sys_logs",
  "sys_roles",
  "sys_user_roles",
  "sys_mcp_api_keys",
]);

/** AI 平台自身的数据表（会话 / 记忆 / 知识库 / 待确认动作 / 审计）：只读 */
const PROTECTED_PREFIXES = ["sys_ai_"];

export function evaluateWritePolicy(table: string, _module?: string): WritePolicy {
  const base = baseTableName(table);
  if (PROTECTED_TABLES.has(base)) {
    return { writable: false, reason: "系统权限 / 身份 / 审计表，AI 禁止写入，只能查询" };
  }
  if (PROTECTED_PREFIXES.some((prefix) => base.startsWith(prefix))) {
    return { writable: false, reason: "AI 平台自身数据表，AI 禁止写入，只能查询" };
  }
  return { writable: true };
}

/** AI 助手不提供任何删除能力 */
export function evaluateDeletePolicy(): WritePolicy {
  return { writable: false, reason: "AI 助手不提供删除能力，请到对应页面操作" };
}

/* ------------------------------------------------------------------ *
 * 目录加载
 * ------------------------------------------------------------------ */

let catalogCache: { at: number; tables: EntityTable[] } | null = null;
const CATALOG_TTL_MS = 10 * 60 * 1000;

const FALLBACK_COLUMN_SQL = [
  "select c.table_name as tbl, c.column_name as col, c.data_type as dtype,",
  "c.is_nullable as nullable, c.column_default as dflt,",
  "col_description((c.table_schema || '.' || c.table_name)::regclass, c.ordinal_position) as col_note,",
  "fk.foreign_table_name as ref_tbl, fk.foreign_column_name as ref_col",
  "from information_schema.columns c",
  "join public.sys_tables st on st.table_name = c.table_name and st.is_deleted = 'n' and st.status = '1'",
  "left join (",
  "  select kcu.table_name, kcu.column_name, ccu.table_name as foreign_table_name, ccu.column_name as foreign_column_name",
  "  from information_schema.table_constraints tc",
  "  join information_schema.key_column_usage kcu on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema",
  "  join information_schema.constraint_column_usage ccu on ccu.constraint_name = tc.constraint_name and ccu.table_schema = tc.table_schema",
  "  where tc.constraint_type = 'FOREIGN KEY' and tc.table_schema = 'public'",
  ") fk on fk.table_name = c.table_name and fk.column_name = c.column_name",
  "where c.table_schema = 'public'",
  "order by c.table_name, c.ordinal_position",
].join("\n");

const FALLBACK_COLUMN_SQL_SIMPLE = [
  "select c.table_name as tbl, c.column_name as col, c.data_type as dtype,",
  "c.is_nullable as nullable, c.column_default as dflt",
  "from information_schema.columns c",
  "join public.sys_tables st on st.table_name = c.table_name and st.is_deleted = 'n' and st.status = '1'",
  "where c.table_schema = 'public'",
  "order by c.table_name, c.ordinal_position",
].join("\n");

const pickString = (row: Record<string, unknown>, ...keys: string[]) => {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== null && String(value) !== "") return String(value);
  }
  return "";
};

const toColumn = (row: Record<string, unknown>): EntityColumn => {
  const rawDefault = row.default_value ?? row.dflt ?? null;
  return {
    name: pickString(row, "name", "col"),
    dataType: pickString(row, "data_type", "dtype"),
    isNullable:
      row.is_nullable === undefined ? String(row.nullable) === "YES" : Boolean(row.is_nullable),
    hasDefault:
      row.has_default === undefined ? rawDefault !== null : Boolean(row.has_default),
    defaultValue: rawDefault === null ? null : String(rawDefault),
    note: pickString(row, "note", "col_note"),
    refTable: pickString(row, "ref_table", "ref_tbl") || undefined,
    refColumn: pickString(row, "ref_column", "ref_col") || undefined,
  };
};

async function loadCatalogFromRpc(): Promise<EntityTable[] | null> {
  const { data, error } = await supabase.rpc("ai_entity_catalog");
  if (error || !Array.isArray(data)) return null;
  const tables = (data as Array<Record<string, unknown>>)
    .map((row) => ({
      table: pickString(row, "table"),
      label: pickString(row, "label") || pickString(row, "table"),
      module: pickString(row, "module") || "business",
      columns: Array.isArray(row.columns)
        ? (row.columns as Array<Record<string, unknown>>).map(toColumn)
        : [],
    }))
    .filter((item) => !!item.table && item.columns.length > 0);
  return tables.length ? tables : null;
}

async function loadCatalogFromFallback(): Promise<EntityTable[]> {
  const { data: tableRows, error: tableError } = await supabase
    .from("sys_tables")
    .select("table_name, table_label, module_name")
    .eq("is_deleted", "n")
    .eq("status", "1")
    .order("table_name");
  if (tableError) throw tableError;

  let rows: Array<Record<string, unknown>> = [];
  const full = await supabase.rpc("execute_ai_analysis", { sql_text: FALLBACK_COLUMN_SQL });
  const fullRows = (full.data as { rows?: Array<Record<string, unknown>> } | null)?.rows;
  if (full.error || !Array.isArray(fullRows)) {
    const simple = await supabase.rpc("execute_ai_analysis", { sql_text: FALLBACK_COLUMN_SQL_SIMPLE });
    const simpleRows = (simple.data as { rows?: Array<Record<string, unknown>> } | null)?.rows;
    if (simple.error) throw simple.error;
    rows = simpleRows || [];
  } else {
    rows = fullRows;
  }

  const columnsByTable = new Map<string, EntityColumn[]>();
  for (const row of rows) {
    const table = pickString(row, "tbl");
    if (!table) continue;
    const list = columnsByTable.get(table) || [];
    list.push(toColumn(row));
    columnsByTable.set(table, list);
  }

  return ((tableRows || []) as Array<Record<string, unknown>>).map((row) => ({
    table: String(row.table_name),
    label: String(row.table_label || row.table_name),
    module: String(row.module_name || "business"),
    columns: columnsByTable.get(String(row.table_name)) || [],
  }));
}

export async function loadEntityCatalog(force = false): Promise<EntityTable[]> {
  if (!force && catalogCache && Date.now() - catalogCache.at < CATALOG_TTL_MS) {
    return catalogCache.tables;
  }
  const tables = (await loadCatalogFromRpc().catch(() => null)) || (await loadCatalogFromFallback());
  const labelByTable = new Map(tables.map((item) => [item.table, item.label]));
  for (const item of tables) {
    for (const column of item.columns) {
      if (column.refTable) column.refTableLabel = labelByTable.get(column.refTable) || column.refTable;
    }
  }
  catalogCache = { at: Date.now(), tables };
  return tables;
}

export function clearEntityCatalogCache() {
  catalogCache = null;
}

/* ------------------------------------------------------------------ *
 * 实体定义构建
 * ------------------------------------------------------------------ */

const parseDefaultValue = (raw: string | null): unknown => {
  if (!raw) return undefined;
  const value = raw.trim();
  if (!value) return undefined;
  if (/^nextval\(/i.test(value) || /^now\(\)/i.test(value) || /current_timestamp/i.test(value) || /^gen_random_uuid/i.test(value)) {
    return undefined;
  }
  const strMatch = value.match(/^'([\s\S]*)'(?:::[\w\s."[\]]+)?$/);
  if (strMatch) return strMatch[1];
  const numMatch = value.match(/^(-?\d+(?:\.\d+)?)(?:::[\w\s."[\]]+)?$/);
  if (numMatch) return Number(numMatch[1]);
  if (/^true$/i.test(value)) return true;
  if (/^false$/i.test(value)) return false;
  return undefined;
};

const fieldLabel = (column: EntityColumn) => {
  if (column.note) return column.note;
  if (column.refTableLabel && column.name.endsWith("_id")) {
    return `${column.name}（${column.refTableLabel}的 id，也可填编码或名称）`;
  }
  return column.name;
};

export function buildEntityDef(table: EntityTable): EntityDef {
  const base = baseTableName(table.table);
  const curated = CURATED[shortKeyOf(table.table)] || {};
  const columns = table.columns || [];
  const insertable = columns.filter((column) => !NON_INSERTABLE_COLUMNS.has(column.name));
  const insertableFields = insertable.map((column) => column.name);
  const insertableSet = new Set(insertableFields);

  const codeField =
    curated.codeField ||
    (insertableSet.has("code")
      ? "code"
      : insertable.find((column) => column.name.endsWith("_no"))?.name || "code");
  const nameField =
    curated.nameField ||
    (insertableSet.has("name") ? "name" : insertableSet.has("title") ? "title" : codeField);

  const requiredFromSchema = insertable
    .filter((column) => !column.isNullable && !column.hasDefault)
    .map((column) => ({ key: column.name, label: fieldLabel(column) }));

  const requiredFields = (curated.requiredFields || requiredFromSchema).filter(
    (field) => insertableSet.has(field.key) || !insertableFields.length,
  );
  const requiredKeys = new Set(requiredFields.map((field) => field.key));
  const optionalFields =
    curated.optionalFields ||
    insertable
      .filter((column) => !requiredKeys.has(column.name))
      .map((column) => ({ key: column.name, label: fieldLabel(column) }));

  const defaultsFromSchema: Record<string, unknown> = {};
  for (const column of insertable) {
    const parsed = parseDefaultValue(column.defaultValue);
    if (parsed !== undefined) defaultsFromSchema[column.name] = parsed;
  }

  const policy = evaluateWritePolicy(table.table, table.module);
  const label = curated.label || table.label || base;

  return {
    key: shortKeyOf(table.table),
    label,
    tableName: table.table,
    module: table.module,
    codeField,
    nameField,
    columns,
    insertableFields,
    requiredFields,
    optionalFields,
    keywords: curated.keywords || [label],
    routeHints: curated.routeHints || [label],
    defaults: () => ({ ...defaultsFromSchema, ...(curated.defaults?.() || {}) }),
    createTitle: `AI新增${label}`,
    writable: policy.writable,
    readOnlyReason: policy.reason,
  };
}

/* ------------------------------------------------------------------ *
 * 实体识别
 * ------------------------------------------------------------------ */

const normalize = (value: string) => String(value || "").toLowerCase().replace(/[\s_-]+/g, "");

const searchTerms = (table: EntityTable): string[] => {
  const terms = new Set<string>();
  const label = String(table.label || "").trim();
  const shortLabel = label.replace(/(表|档案|信息|记录)$/u, "");
  if (label) terms.add(label);
  if (shortLabel.length >= 2) terms.add(shortLabel);
  const curated = CURATED[shortKeyOf(table.table)];
  (curated?.keywords || []).forEach((word) => terms.add(word));
  for (const token of baseTableName(table.table).split("_")) {
    if (token.length >= 3 && !/^\d+$/.test(token)) terms.add(token);
    if (token.length >= 4 && token.endsWith("s")) terms.add(token.slice(0, -1));
  }
  return [...terms].filter(Boolean);
};

const scoreTable = (table: EntityTable, haystack: string) => {
  let score = 0;
  for (const term of searchTerms(table)) {
    const normalizedTerm = normalize(term);
    if (normalizedTerm.length < 2) continue;
    if (haystack.includes(normalizedTerm)) {
      score += normalizedTerm.length * 2 + (term === table.label ? 10 : 0);
    }
  }
  const curated = CURATED[shortKeyOf(table.table)];
  if (score > 0 && curated?.priority) score += curated.priority;
  return score;
};

const findTableByBase = (tables: EntityTable[], base: string) =>
  tables.find((item) => baseTableName(item.table) === base) || null;

const pickBest = (tables: EntityTable[], haystack: string): EntityTable | null => {
  let best: { table: EntityTable; score: number } | null = null;
  for (const table of tables) {
    const score = scoreTable(table, haystack);
    if (score > 0 && (!best || score > best.score)) best = { table, score };
  }
  return best?.table || null;
};

/**
 * 用户明确提到「字典 / 字典项 / 数据字典」时，走系统字典表，
 * 而不是同名业务表（如 erp_uoms）。这是两套不同的数据：
 *   系统字典 = sys_dict_items，挂在 sys_dict_types 某个类型下，系统级枚举值；
 *   业务表   = erp_uoms，物料级计量单位主数据。
 */
const DICT_REQUEST = /(数据字典|字典项|字典值|字典数据|字典选项|下拉选项|字典)/;
const DICT_TYPE_REQUEST = /(字典类型|字典分类|新增.{0,4}(字典)?类型)/;

const matchDictRequest = (tables: EntityTable[], text: string): EntityTable | null => {
  if (!DICT_REQUEST.test(text)) return null;
  // 「字典类型」指 sys_dict_types（结构性配置，现按用户口径放开写入，走确认回路）
  if (DICT_TYPE_REQUEST.test(text)) return findTableByBase(tables, "sys_dict_types");
  return findTableByBase(tables, "sys_dict_items");
};

const matchByTarget = (tables: EntityTable[], target: string): EntityTable | null => {
  const key = String(target || "").trim();
  if (!key) return null;
  const mapped = TARGET_TO_TABLE[key];
  if (mapped) {
    const found = findTableByBase(tables, mapped) || findTableByBase(tables, baseTableName(mapped));
    if (found) return found;
  }
  const byBase = findTableByBase(tables, key) || findTableByBase(tables, `erp_${key}`);
  if (byBase) return byBase;
  return pickBest(tables, normalize(key));
};

async function matchByModel(tables: EntityTable[], state: AiGraphState): Promise<EntityTable | null> {
  if (!state.provider?.endpoint || !state.provider?.model) return null;
  const list = tables
    .map((item) => {
      const policy = evaluateWritePolicy(item.table, item.module);
      return `${item.table}|${item.label}|${policy.writable ? "可写" : "只读"}`;
    })
    .join("\n");
  const prompt = [
    "你是 ERP 业务对象识别器。用户想新增或修改一条业务数据，请判断对应哪张表。",
    "只能从清单的 table 列中选择物理表名，不能臆造；没有合适的表就返回 {\"table\": null}。",
    "只返回 JSON：{\"table\":\"erp_xxx_s_539dcf81_b\"} 或 {\"table\":null}",
    `用户原话：${state.text}`,
    state.target ? `路由目标：${state.target}` : "",
    `清单：\n${list}`,
  ]
    .filter(Boolean)
    .join("\n");
  try {
    const { content } = await callChatModel(
      [
        { role: "system", content: "你只返回 JSON。" },
        { role: "user", content: prompt },
      ],
      state.provider,
    );
    const raw = String(content || "").trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, "$1");
    const parsed = JSON.parse(raw) as { table?: string | null };
    if (!parsed?.table) return null;
    const wanted = String(parsed.table);
    return (
      tables.find((item) => item.table === wanted) || findTableByBase(tables, baseTableName(wanted))
    );
  } catch {
    return null;
  }
}

export async function resolveEntityForState(state: AiGraphState): Promise<ResolveResult> {
  const tables = await loadEntityCatalog();
  if (!tables.length) {
    return { error: "未能加载业务表目录，请确认 sys_tables 已初始化（执行 refresh_sys_tables()）。" };
  }

  const focus = state.currentFocus && typeof state.currentFocus === "object"
    ? (state.currentFocus as Record<string, unknown>)
    : null;
  const focusTable = focus?.table ? String(focus.table) : "";
  const fromFocus = focusTable ? tables.find((item) => item.table === focusTable) || null : null;

  const matched =
    // 「字典 / 字典项」是强信号，优先于 target 与关键词匹配
    matchDictRequest(tables, state.text) ||
    (state.target ? matchByTarget(tables, String(state.target)) : null) ||
    pickBest(tables, normalize(state.text)) ||
    fromFocus ||
    (await matchByModel(tables, state));

  if (!matched) {
    return {
      error: "未识别出要处理的业务对象。请说明具体对象，例如：客户、物料、计量单位、采购订单、库存盘点单。",
    };
  }
  return { def: buildEntityDef(matched) };
}

/** 给意图路由用的可写对象清单（中文标签） */
export async function describeWritableObjects(): Promise<string> {
  const tables = await loadEntityCatalog();
  return tables
    .filter((item) => evaluateWritePolicy(item.table, item.module).writable)
    .map((item) => CURATED[shortKeyOf(item.table)]?.label || item.label)
    .join("、");
}

/** 外键解析：把用户给的编码 / 名称换成关联表 id */
export async function resolveForeignKeyValues(
  entity: EntityDef,
  payload: Record<string, unknown>,
): Promise<{ payload: Record<string, unknown>; resolved: string[] }> {
  const next: Record<string, unknown> = { ...payload };
  const resolved: string[] = [];
  for (const column of entity.columns) {
    if (!column.refTable || !column.name.endsWith("_id")) continue;
    const value = next[column.name];
    if (value === undefined || value === null || value === "") continue;
    if (typeof value === "number" || /^\d+$/.test(String(value))) continue;
    const keyword = String(value).trim();
    const { data } = await supabase
      .from(column.refTable)
      .select("id")
      .or(`code.ilike.%${keyword}%,name.ilike.%${keyword}%`)
      .limit(1)
      .maybeSingle();
    const id = (data as Record<string, unknown> | null)?.id;
    if (id !== undefined && id !== null) {
      next[column.name] = id;
      resolved.push(`${column.name}=${String(value)}->${String(id)}`);
    }
  }
  return { payload: next, resolved };
}

/**
 * 取系统字典类型清单（含每个类型下已有的几个字典项样例）。
 * 新增字典项时喂给 LLM，让它能准确给出 type_id，而不是猜数字。
 */
export async function loadDictTypeOptions(
  tenantId?: number | null,
): Promise<Array<Record<string, unknown>>> {
  // service_role 绕过 RLS，这里显式拼租户条件：基线字典 + 本租户的私有字典
  const scope = tenantScopeFilter(tenantId);
  try {
    const { data: types } = await supabase
      .from("sys_dict_types")
      .select("id,code,name")
      .eq("is_deleted", "n")
      .or(scope)
      .order("id");
    if (!Array.isArray(types) || !types.length) return [];
    const { data: items } = await supabase
      .from("sys_dict_items")
      .select("type_id,code,label")
      .eq("is_deleted", "n")
      .or(scope)
      .limit(300);
    const samples = new Map<number, string[]>();
    for (const row of (items || []) as Array<Record<string, unknown>>) {
      const typeId = Number(row.type_id);
      const list = samples.get(typeId) || [];
      if (list.length < 6) list.push(`${row.code}=${row.label}`);
      samples.set(typeId, list);
    }
    return (types as Array<Record<string, unknown>>).map((type) => ({
      id: type.id,
      code: type.code,
      name: type.name,
      existing: samples.get(Number(type.id)) || [],
    }));
  } catch {
    return [];
  }
}
