import { supabase } from "../config/supabase.js";
import { callChatModel } from "../config/llm.js";
import type { AiChatRequest, AiGraphState } from "../ai/state.js";

type ToolStatus = "success" | "needs_more" | "error";

interface ToolResult {
  status: ToolStatus;
  reply: string;
  data?: unknown;
  focus?: unknown;
  route?: string;
  routeLabel?: string;
  needConfirmation?: boolean;
  nextQuestions?: string[];
}

interface BaqTable {
  table: string;
  label: string;
  columns: Array<{ name: string; type: string }>;
}

interface AnalysisPlan {
  title?: string;
  sql?: string;
  explanation?: string;
  responseMode?: "text" | "table" | "card";
  target?: string;
  queryMode?: string;
}

type EntityKey =
  | "customer"
  | "supplier"
  | "product"
  | "warehouse"
  | "department"
  | "workCenter"
  | "operation"
  | "bom"
  | "routing"
  | "purchaseOrder"
  | "salesOrder"
  | "purchaseReceipt"
  | "salesDelivery"
  | "productionOrder";

interface EntityDef {
  key: EntityKey;
  label: string;
  tableName: string;
  codeField?: string;
  nameField?: string;
  keywords: string[];
  defaults: () => Record<string, unknown>;
  createTitle: string;
  requiredFields: Array<{ key: string; label: string }>;
}

const nowIso = () => new Date().toISOString();
const today = () => new Date().toISOString().slice(0, 10);

const entityRouteHints: Record<EntityKey, string[]> = {
  customer: ["客户管理", "客户"],
  supplier: ["供应商管理", "供应商"],
  product: ["物料管理", "物料", "产品"],
  warehouse: ["仓库管理", "仓库"],
  department: ["部门管理", "部门"],
  workCenter: ["工作中心", "工作中心管理"],
  operation: ["工序", "工序管理"],
  bom: ["BOM", "BOM管理", "物料清单"],
  routing: ["工艺路线", "工艺路线管理"],
  purchaseOrder: ["采购订单", "采购单"],
  salesOrder: ["销售订单", "销售单"],
  purchaseReceipt: ["采购入库", "采购入库单"],
  salesDelivery: ["销售出货", "销售出货单"],
  productionOrder: ["生产订单", "工单"],
};

async function findEntityRoute(entity: EntityDef) {
  const hints = entityRouteHints[entity.key] || [entity.label];
  for (const hint of hints) {
    const { data, error } = await supabase
      .from("sys_menus")
      .select("menu_name, menu_code, path")
      .eq("is_deleted", "n")
      .eq("status", "1")
      .or(`menu_name.ilike.%${hint}%,menu_code.ilike.%${hint.toLowerCase().replace(/\s+/g, "_")}%,path.ilike.%${hint}%`)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (data?.path) {
      return { route: String(data.path), routeLabel: String(data.menu_name || entity.label) };
    }
  }
  return null;
}

const entityDefs: Record<EntityKey, EntityDef> = {
  customer: {
    key: "customer",
    label: "客户",
    tableName: "erp_customers_s_539dcf81_b",
    codeField: "code",
    nameField: "name",
    keywords: ["客户", "客戶"],
    defaults: () => ({ type: "enterprise", level: "normal", credit_limit: 0, status: "active" }),
    createTitle: "AI新增客户",
    requiredFields: [
      { key: "code", label: "客户编码" },
      { key: "name", label: "客户名称" },
    ],
  },
  supplier: {
    key: "supplier",
    label: "供应商",
    tableName: "erp_suppliers_s_539dcf81_b",
    codeField: "code",
    nameField: "name",
    keywords: ["供应商", "供應商"],
    defaults: () => ({ type: "manufacturer", level: "normal", credit_limit: 0, status: "active" }),
    createTitle: "AI新增供应商",
    requiredFields: [
      { key: "code", label: "供应商编码" },
      { key: "name", label: "供应商名称" },
    ],
  },
  product: {
    key: "product",
    label: "物料",
    tableName: "erp_products_s_539dcf81_b",
    codeField: "code",
    nameField: "name",
    keywords: ["物料", "产品", "商品"],
    defaults: () => ({ unit: "件", purchase_price: 0, sale_price: 0, cost_price: 0, safety_stock: 0, max_stock: 0, min_stock: 0, is_purchased: true, is_sold: true, is_manufactured: false, status: "active" }),
    createTitle: "AI新增物料",
    requiredFields: [
      { key: "code", label: "物料编码" },
      { key: "name", label: "物料名称" },
    ],
  },
  warehouse: {
    key: "warehouse",
    label: "仓库",
    tableName: "erp_warehouses_s_539dcf81_b",
    codeField: "code",
    nameField: "name",
    keywords: ["仓库", "倉庫"],
    defaults: () => ({ type: "raw_material", is_negative_stock_allowed: false, status: "active" }),
    createTitle: "AI新增仓库",
    requiredFields: [
      { key: "code", label: "仓库编码" },
      { key: "name", label: "仓库名称" },
    ],
  },
  department: {
    key: "department",
    label: "部门",
    tableName: "erp_departments_s_539dcf81_b",
    codeField: "code",
    nameField: "name",
    keywords: ["部门"],
    defaults: () => ({ status: "active" }),
    createTitle: "AI新增部门",
    requiredFields: [
      { key: "code", label: "部门编码" },
      { key: "name", label: "部门名称" },
    ],
  },
  workCenter: {
    key: "workCenter",
    label: "工作中心",
    tableName: "erp_work_centers_s_539dcf81_b",
    codeField: "code",
    nameField: "name",
    keywords: ["工作中心"],
    defaults: () => ({ type: "machine", capacity_per_day: 8, labor_rate: 0, overhead_rate: 0, status: "active" }),
    createTitle: "AI新增工作中心",
    requiredFields: [
      { key: "code", label: "工作中心编码" },
      { key: "name", label: "工作中心名称" },
    ],
  },
  operation: {
    key: "operation",
    label: "工序",
    tableName: "erp_operations_s_539dcf81_b",
    codeField: "code",
    nameField: "name",
    keywords: ["工序"],
    defaults: () => ({ standard_hours: 0, setup_hours: 0, labor_rate: 0, overhead_rate: 0, status: "active" }),
    createTitle: "AI新增工序",
    requiredFields: [
      { key: "code", label: "工序编码" },
      { key: "name", label: "工序名称" },
    ],
  },
  bom: {
    key: "bom",
    label: "BOM",
    tableName: "erp_boms_s_539dcf81_b",
    codeField: "bom_no",
    nameField: "bom_no",
    keywords: ["BOM", "bom"],
    defaults: () => ({ bom_no: `BOM${Date.now().toString().slice(-8)}`, version: "1.0", quantity: 1, unit: "件", is_default: true, is_active: true, effective_date: today() }),
    createTitle: "AI新增BOM",
    requiredFields: [
      { key: "bom_no", label: "BOM编号" },
      { key: "product_id", label: "产品ID" },
    ],
  },
  routing: {
    key: "routing",
    label: "工艺路线",
    tableName: "erp_routing_operations_s_539dcf81_b",
    codeField: "routing_no",
    nameField: "routing_no",
    keywords: ["工艺路线", "路线"],
    defaults: () => ({ routing_no: `RT${Date.now().toString().slice(-8)}`, version: "1.0", is_default: true, is_active: true, effective_date: today(), total_standard_hours: 0 }),
    createTitle: "AI新增工艺路线",
    requiredFields: [
      { key: "routing_no", label: "工艺路线编号" },
      { key: "product_id", label: "产品ID" },
    ],
  },
  purchaseOrder: {
    key: "purchaseOrder",
    label: "采购订单",
    tableName: "erp_purchase_orders_s_539dcf81_b",
    codeField: "order_no",
    nameField: "order_no",
    keywords: ["采购订单", "采购单"],
    defaults: () => ({ order_no: `PO${Date.now().toString().slice(-8)}`, order_date: today(), total_amount: 0, tax_amount: 0, payable_amount: 0, currency: "CNY", status: "draft" }),
    createTitle: "AI新增采购订单",
    requiredFields: [
      { key: "order_no", label: "采购单号" },
      { key: "supplier_id", label: "供应商ID" },
      { key: "order_date", label: "订单日期" },
    ],
  },
  salesOrder: {
    key: "salesOrder",
    label: "销售订单",
    tableName: "erp_sales_orders_s_539dcf81_b",
    codeField: "order_no",
    nameField: "order_no",
    keywords: ["销售订单", "销售单"],
    defaults: () => ({ order_no: `SO${Date.now().toString().slice(-8)}`, order_date: today(), total_amount: 0, tax_amount: 0, discount_amount: 0, receivable_amount: 0, currency: "CNY", status: "draft" }),
    createTitle: "AI新增销售订单",
    requiredFields: [
      { key: "order_no", label: "销售单号" },
      { key: "customer_id", label: "客户ID" },
      { key: "order_date", label: "订单日期" },
    ],
  },
  purchaseReceipt: {
    key: "purchaseReceipt",
    label: "采购入库单",
    tableName: "erp_purchase_receipts_s_539dcf81_b",
    codeField: "receipt_no",
    nameField: "receipt_no",
    keywords: ["采购入库单", "采购入库", "入库单"],
    defaults: () => ({ receipt_no: `PR${Date.now().toString().slice(-8)}`, receipt_date: today(), total_amount: 0, status: "draft" }),
    createTitle: "AI新增采购入库单",
    requiredFields: [
      { key: "receipt_no", label: "入库单号" },
      { key: "receipt_date", label: "入库日期" },
      { key: "supplier_id", label: "供应商ID" },
      { key: "warehouse_id", label: "仓库ID" },
    ],
  },
  salesDelivery: {
    key: "salesDelivery",
    label: "销售出货单",
    tableName: "erp_sales_deliveries_s_539dcf81_b",
    codeField: "delivery_no",
    nameField: "delivery_no",
    keywords: ["销售出货单", "销售出货", "出货单"],
    defaults: () => ({ delivery_no: `SD${Date.now().toString().slice(-8)}`, delivery_date: today(), total_amount: 0, status: "draft" }),
    createTitle: "AI新增销售出货单",
    requiredFields: [
      { key: "delivery_no", label: "出货单号" },
      { key: "delivery_date", label: "出货日期" },
      { key: "customer_id", label: "客户ID" },
      { key: "warehouse_id", label: "仓库ID" },
    ],
  },
  productionOrder: {
    key: "productionOrder",
    label: "生产订单",
    tableName: "erp_production_orders_s_539dcf81_b",
    codeField: "order_no",
    nameField: "order_no",
    keywords: ["生产订单", "生产单", "工单"],
    defaults: () => ({ order_no: `MO${Date.now().toString().slice(-8)}`, order_date: today(), planned_quantity: 1, completed_quantity: 0, scrapped_quantity: 0, priority: 1, status: "draft" }),
    createTitle: "AI新增生产订单",
    requiredFields: [
      { key: "order_no", label: "生产单号" },
      { key: "order_date", label: "订单日期" },
      { key: "product_id", label: "产品ID" },
      { key: "planned_quantity", label: "计划数量" },
    ],
  },
};

const normalize = (value: string) => value.toLowerCase().replace(/\s+/g, "");
const containsAny = (text: string, words: string[]) => words.some((word) => text.includes(word.toLowerCase()));
const stripJsonFence = (text: string) => text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim() || text.trim();
const parseJson = <T>(text: string): T | null => {
  try {
    return JSON.parse(stripJsonFence(text)) as T;
  } catch {
    return null;
  }
};

const entityFromText = (text: string): EntityKey | null => {
  const normalized = normalize(text);
  return (Object.keys(entityDefs) as EntityKey[]).find((key) =>
    entityDefs[key].keywords.some((word) => normalized.includes(normalize(word))),
  ) || null;
};

const hasPronounReference = (text: string) => /(?:它|这个|那个|刚才|刚刚|上一个|上次|最近|继续|改一下|帮我改|修改一下)/.test(text);

const missingRequiredFields = (entity: EntityDef, record: Record<string, unknown>) =>
  entity.requiredFields.filter((field) => {
    const value = record[field.key];
    return value === undefined || value === null || value === "";
  });

const extractExplicitFields = (entity: EntityDef, text: string): Record<string, unknown> => {
  const fields: Record<string, unknown> = {};
  const codeField = entity.codeField || "code";
  const nameField = entity.nameField || "name";

  const codeMatch = text.match(
    /(?:物料|产品|客户|供应商|仓库|部门|工作中心|工序|采购订单|销售订单|采购入库单|销售出货单|生产订单)?\s*(?:编码|编号|单号)\s*[:：=]?\s*([A-Za-z0-9_-]+)/i,
  );
  const nameMatch = text.match(
    /(?:物料|产品|客户|供应商|仓库|部门|工作中心|工序)\s*名称\s*[:：=]?\s*([^，,。；;\n]+)/i,
  );

  if (codeMatch?.[1]) fields[codeField] = codeMatch[1].trim();
  if (nameMatch?.[1]) fields[nameField] = nameMatch[1].trim();

  return fields;
};

const normalizeEntityFields = (
  entity: EntityDef,
  fields: Record<string, unknown>,
): Record<string, unknown> => {
  const aliases: Record<string, string> = {
    物料编码: "code",
    物料名称: "name",
    产品编码: "code",
    产品名称: "name",
    客户编码: "code",
    客户名称: "name",
    供应商编码: "code",
    供应商名称: "name",
    仓库编码: "code",
    仓库名称: "name",
    部门编码: "code",
    部门名称: "name",
    工作中心编码: "code",
    工作中心名称: "name",
    工序编码: "code",
    工序名称: "name",
    编码: entity.codeField || "code",
    编号: entity.codeField || "code",
    名称: entity.nameField || "name",
  };
  const allowedFields = new Set([
    "code",
    "name",
    ...Object.keys(entity.defaults()),
    entity.codeField || "code",
    entity.nameField || "name",
  ]);
  const normalized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(fields)) {
    const targetKey = aliases[key] || key;
    if (allowedFields.has(targetKey)) {
      normalized[targetKey] = value;
    }
  }

  return normalized;
};

async function runEntitySearch(entity: EntityDef, text: string) {
  const codeField = entity.codeField || "code";
  const nameField = entity.nameField || "name";
  const query = supabase.from(entity.tableName).select("*").eq("is_deleted", "n");
  const keywords = [...new Set(text.split(/[\s,，。；;]+/).filter(Boolean))];
  const { data, error } = await query.or(
    [
      `${codeField}.ilike.%${keywords[0] || text}%`,
      `${nameField}.ilike.%${keywords[0] || text}%`,
    ].join(","),
  ).limit(1);
  if (error) throw error;
  return data?.[0] || null;
}

async function extractEntityPayload(
  entity: EntityDef,
  text: string,
  current?: Record<string, unknown> | null,
  provider?: AiChatRequest["provider"],
) {
  const prompt = [
    `你是ERP数据录入助手。请从用户描述中提取${entity.label}的字段值，只返回JSON，不要解释。`,
    `实体表：${entity.tableName}`,
    `允许字段：${Object.keys(entity.defaults()).join(", ")}`,
    `必填字段：${entity.requiredFields.map((field) => field.label).join(", ")}`,
    current ? `当前记录：${JSON.stringify(current)}` : "当前记录：无",
    `用户原话：${text}`,
    "返回格式：{\"fields\":{...},\"need_more\":[],\"summary\":\"\"}",
  ].join("\n");
  const { content } = await callChatModel([
    { role: "system", content: "你只返回JSON。" },
    { role: "user", content: prompt },
  ], provider);
  const parsed = parseJson<{ fields?: Record<string, unknown>; need_more?: string[]; summary?: string }>(content);
  return {
    fields: parsed?.fields || {},
    need_more: parsed?.need_more || [],
    summary: parsed?.summary || "",
  };
}

async function upsertEntity(
  entity: EntityDef,
  text: string,
  currentFocus?: unknown,
  provider?: AiChatRequest["provider"],
  action: "create" | "update" = "create",
) {
  const current = currentFocus && typeof currentFocus === "object" ? currentFocus as Record<string, unknown> : null;
  const existing =
    action === "update"
      ? current?.id
        ? current
        : hasPronounReference(text)
          ? current
          : await runEntitySearch(entity, text)
      : null;
  const extracted = await extractEntityPayload(entity, text, existing, provider);
  const mergedDraft = {
    ...entity.defaults(),
    ...(existing || {}),
    ...normalizeEntityFields(entity, extracted.fields),
    // Explicit values from the user's message must win over model extraction.
    ...extractExplicitFields(entity, text),
  };
  const missingRequired = missingRequiredFields(entity, mergedDraft);
  const missingLabels = [
    ...new Set([
      ...extracted.need_more,
      ...missingRequired.map((field) => field.label),
    ]),
  ];

  if (missingLabels.length > 0 && !existing) {
    return {
      status: "needs_more" as const,
      reply: `${action === "update" ? "修改" : "创建"}${entity.label}还缺少这些信息：${missingLabels.join("、")}`,
      nextQuestions: missingLabels,
    };
  }

  const payload = {
    ...mergedDraft,
    updated_at: nowIso(),
  };

  delete (payload as Record<string, unknown>).id;
  delete (payload as Record<string, unknown>).created_at;

  const isUpdate = !!existing?.id;
  if (action === "update" && !isUpdate) {
    return {
      status: "needs_more" as const,
      reply: `没有找到可修改的${entity.label}，请先明确要修改哪一条记录。`,
      nextQuestions: [`请提供要修改的${entity.label}名称或编码`],
    };
  }
  const response = isUpdate
    ? await supabase.from(entity.tableName).update(payload).eq("id", existing.id).select().single()
    : await supabase.from(entity.tableName).insert(payload).select().single();
  if (response.error) throw response.error;
  const row = response.data as Record<string, unknown>;
  const displayName = String(row[entity.nameField || entity.codeField || "id"] || row.id || "-");
  const routeInfo = await findEntityRoute(entity).catch(() => null);
  return {
    status: "success" as const,
    reply: `${isUpdate ? "已更新" : "已创建"}${entity.label}：${displayName}${extracted.summary ? `\n${extracted.summary}` : ""}`,
    data: row,
    route: routeInfo?.route,
    routeLabel: routeInfo?.routeLabel,
    focus: { type: entity.key, id: row.id, code: row[entity.codeField || "code"], name: row[entity.nameField || entity.codeField || "name"], route: routeInfo?.route },
  };
}

async function loadBaqCatalog(): Promise<BaqTable[]> {
  const { data: tableRows, error: tableError } = await supabase
    .from("sys_tables")
    .select("table_name, table_label, module_name")
    .eq("is_deleted", "n")
    .eq("status", "1")
    .order("module_name")
    .order("table_name");
  if (tableError) throw tableError;

  const { data: catalogData, error: catalogError } = await supabase.rpc("baq_catalog");
  if (catalogError) throw catalogError;
  const catalog = (catalogData || []) as BaqTable[];
  const columnsByTable = new Map(catalog.map((item) => [item.table, item.columns]));

  return ((tableRows || []) as Array<Record<string, unknown>>)
    .filter((row) => String(row.table_name || "").startsWith("erp_"))
    .map((row) => {
      const table = String(row.table_name);
      return {
        table,
        label: String(row.table_label || table),
        columns: columnsByTable.get(table) || [],
      };
    })
    .filter((item) => item.columns.length > 0);
}

const normalizeText = (value: string) => value.toLowerCase().replace(/\s+/g, "");

const ANALYSIS_TARGET_HINTS: Record<string, string[]> = {
  customer: ["客户", "客商", "customer"],
  supplier: ["供应商", "supplier"],
  product: ["物料", "产品", "商品", "material", "item", "product"],
  warehouse: ["仓库", "库位", "warehouse", "bin"],
  department: ["部门", "department"],
  workCenter: ["工作中心", "work center", "workcenter"],
  operation: ["工序", "operation"],
  bom: ["bom", "物料清单"],
  routing: ["工艺路线", "routing"],
  purchaseOrder: ["采购订单", "采购单", "purchase order", "po"],
  purchaseReceipt: ["采购入库", "入库单", "receipt"],
  salesOrder: ["销售订单", "销售单", "sales order", "so"],
  salesDelivery: ["销售出货", "出货单", "delivery"],
  productionOrder: ["生产订单", "工单", "production order", "mo"],
  inventory: ["库存", "现存量", "存货", "inventory"],
  finance: ["财务", "凭证", "应收", "应付", "profit", "voucher"],
  production: ["生产", "mrp", "产能", "缺料"],
  business: ["业务", "经营", "分析", "统计"],
};

const pickAnalysisCatalog = (catalog: BaqTable[], state: AiGraphState) => {
  const terms = new Set<string>();
  const target = String(state.target || "");
  const query = String(state.text || "");
  const domain = String(state.domain || "");
  const queryMode = String(state.queryMode || "");
  [target, domain, queryMode].forEach((value) => {
    if (value) terms.add(normalizeText(value));
  });
  Object.values(ANALYSIS_TARGET_HINTS).flat().forEach((hint) => {
    if (normalizeText(query).includes(normalizeText(hint))) {
      terms.add(normalizeText(hint));
    }
  });

  const scored = catalog.map((item) => {
    const haystack = normalizeText(
      `${item.table} ${item.label} ${item.columns.map((c) => c.name).join(" ")}`,
    );
    let score = 0;
    for (const hintGroup of Object.values(ANALYSIS_TARGET_HINTS)) {
      for (const hint of hintGroup) {
        if (haystack.includes(normalizeText(hint))) {
          score += 1;
        }
      }
    }
    if (terms.size) {
      for (const term of terms) {
        if (haystack.includes(term)) score += 3;
      }
    }
    return { item, score };
  });

  return scored
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 20)
    .map(({ item }) => item);
};

const stripMarkdownFence = (value: string) => {
  const trimmed = value.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return (fenced ? fenced[1] : trimmed).trim();
};

const normalizeAnalysisSql = (sql: string) => {
  const cleaned = stripMarkdownFence(sql);
  const lower = cleaned.toLowerCase();
  const selectIndex = lower.indexOf("select");
  const withIndex = lower.indexOf("with");
  const startIndex =
    selectIndex >= 0 && withIndex >= 0
      ? Math.min(selectIndex, withIndex)
      : Math.max(selectIndex, withIndex);
  const sliced = startIndex >= 0 ? cleaned.slice(startIndex) : cleaned;
  return sliced.replace(/;\s*$/, "").trim();
};

const parseAnalysisPlan = (value: string): AnalysisPlan | null => {
  try {
    return JSON.parse(stripMarkdownFence(value)) as AnalysisPlan;
  } catch {
    return null;
  }
};

const validateAnalysisSql = (sql: string, catalog: BaqTable[]) => {
  const text = normalizeAnalysisSql(sql);
  if (!text) throw new Error("分析 SQL 不能为空");
  if (!/^\s*(select|with)\b/i.test(text)) throw new Error("分析 SQL 只能是 SELECT/WITH");
  if (text.includes(";")) throw new Error("分析 SQL 不能包含分号");
  if (/\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|comment|commit|rollback)\b/i.test(text)) {
    throw new Error("分析 SQL 只能是只读查询");
  }

  const tableNames = catalog.map((item) => item.table);
  if (!tableNames.some((table) => new RegExp(`\\b${table.replace(/_/g, "_")}\\b`, "i").test(text))) {
    throw new Error("分析 SQL 必须引用 sys_tables/baq_catalog 中的真实业务表");
  }
};

const executeAiAnalysisSql = async (sql: string) => {
  console.log("[ai-server] execute AI analysis SQL:", sql);
  const { data, error } = await supabase.rpc("execute_ai_analysis", { sql_text: sql });
  if (error) throw error;
  return data as { rows?: Array<Record<string, unknown>>; rowCount?: number } | null;
};

async function findBaqTarget(text: string, focus?: unknown) {
  const { data, error } = await supabase.from("sys_baq_queries").select("*").eq("is_deleted", "n").order("updated_at", { ascending: false });
  if (error) throw error;
  const items = (data || []) as Array<Record<string, unknown>>;
  const normalized = normalize(text);
  const byFocus = focus && typeof focus === "object" ? (focus as Record<string, unknown>) : null;
  const focusCandidate = byFocus?.id ? items.find((item) => String(item.id) === String(byFocus.id)) || null : null;
  if (focusCandidate) return focusCandidate;
  const namedTarget = items.find((item) => normalized.includes(normalize(String(item.code || ""))) || normalized.includes(normalize(String(item.name || ""))));
  if (namedTarget) return namedTarget;
  if (/(修改|更新|编辑|调整|优化|补充|继续|刚才|刚刚|这个|它|上一个)/i.test(text)) {
    return items[0] || null;
  }
  return null;
}

const mergeBaqDefinition = (current: unknown, next: unknown) => {
  const currentDefinition = current && typeof current === "object" ? current as Record<string, unknown> : {};
  const nextDefinition = next && typeof next === "object" ? next as Record<string, unknown> : {};
  return {
    source: nextDefinition.source || currentDefinition.source,
    joins: Array.isArray(nextDefinition.joins) ? nextDefinition.joins : (Array.isArray(currentDefinition.joins) ? currentDefinition.joins : []),
    fields: Array.isArray(nextDefinition.fields) ? nextDefinition.fields : (Array.isArray(currentDefinition.fields) ? currentDefinition.fields : []),
    filters: Array.isArray(nextDefinition.filters) ? nextDefinition.filters : (Array.isArray(currentDefinition.filters) ? currentDefinition.filters : []),
    sorts: Array.isArray(nextDefinition.sorts) ? nextDefinition.sorts : (Array.isArray(currentDefinition.sorts) ? currentDefinition.sorts : []),
  };
};

const normalizeBaqDefinition = (definition: unknown) => {
  if (!definition || typeof definition !== "object") return null;
  const value = definition as Record<string, unknown>;
  const source = value.source as Record<string, unknown> | undefined;
  if (!source?.table) return null;

  return {
    source: { table: String(source.table), alias: String(source.alias || "t0") },
    joins: Array.isArray(value.joins) ? value.joins : [],
    fields: Array.isArray(value.fields) ? value.fields : [],
    filters: Array.isArray(value.filters) ? value.filters : [],
    sorts: Array.isArray(value.sorts) ? value.sorts : [],
  };
};

const validateBaqDefinition = (definition: Record<string, unknown>, catalog: BaqTable[]) => {
  const tables = new Map(catalog.map((item) => [item.table, item]));
  const source = definition.source as { table?: string; alias?: string };
  if (!source?.table || !tables.has(source.table)) {
    throw new Error(`BAQ主表不存在：${source?.table || "-"}`);
  }
  const aliases = new Map([[source.alias || "t0", source.table]]);
  for (const join of definition.joins as Array<Record<string, unknown>>) {
    const table = String(join.table || "");
    const alias = String(join.alias || "");
    const leftAlias = String(join.leftAlias || "");
    const leftField = String(join.leftField || "");
    const rightField = String(join.rightField || "");
    const leftTable = tables.get(aliases.get(leftAlias) || "");
    const rightTable = tables.get(table);
    if (!rightTable || !alias || aliases.has(alias) || !leftTable) {
      throw new Error(`BAQ关联配置无效：${table || alias}`);
    }
    if (!leftTable.columns.some((column) => column.name === leftField) ||
        !rightTable.columns.some((column) => column.name === rightField)) {
      throw new Error(`BAQ关联字段不存在：${leftAlias}.${leftField} = ${table}.${rightField}`);
    }
    aliases.set(alias, table);
  }
  const fields = definition.fields as Array<Record<string, unknown>>;
  if (!fields.length) throw new Error("BAQ至少需要一个输出字段");
  for (const field of fields) {
    const table = tables.get(aliases.get(String(field.tableAlias || "")) || "");
    if (!table?.columns.some((column) => column.name === field.field)) {
      throw new Error(`BAQ输出字段不存在：${field.tableAlias}.${field.field}`);
    }
    if (!field.alias) field.alias = field.field;
    if (!["none", "sum", "count", "avg", "min", "max"].includes(String(field.aggregate || "none"))) {
      throw new Error(`BAQ聚合方式无效：${field.aggregate}`);
    }
  }
  const fieldAliases = new Set(fields.map((field) => String(field.alias || field.field)));
  for (const sort of definition.sorts as Array<Record<string, unknown>>) {
    if (!fieldAliases.has(String(sort.fieldAlias || ""))) {
      throw new Error(`BAQ排序字段不存在：${sort.fieldAlias}`);
    }
  }
};

export async function createOrUpdateBaqTool(state: AiGraphState): Promise<ToolResult> {
  const catalog = await loadBaqCatalog();
  const target = await findBaqTarget(state.text, state.currentFocus);
  const current = target || null;
  const prompt = [
    "你是 OPERP BAQ 设计助手。请根据用户的完整需求设计真正可执行的 BAQ，不要只创建一条空记录。",
    "请分析应该使用哪张主表、关联哪些表、关联字段、输出字段、分组聚合、筛选条件和排序方式。",
    "只返回 JSON，不要 Markdown，不要解释。必须包含 name、code、description、definition。",
    "definition 必须完整包含 source、joins、fields、filters、sorts。",
    "source 格式为 {table, alias}，主表 alias 固定为 t0。",
    "join 格式为 {id,type,table,alias,leftAlias,leftField,rightField}，type 只能是 left 或 inner。",
    "field 格式为 {id,alias,field,groupBy,aggregate,tableAlias}，aggregate 只能是 none、sum、count、avg、min、max。",
    "filter 格式为 {id,tableAlias,field,operator,value}，operator 只能是 eq、neq、gt、gte、lt、lte、like、is_null、not_null。",
    "sort 格式为 {id,fieldAlias,direction}，direction 只能是 asc 或 desc。",
    "如果用户要求统计、数量、金额、合计或平均值，必须正确设置 aggregate 和 groupBy。",
    "只能从下面数据目录的 table 字段中选择真实表名，不能使用 PartBin、Part、Customer 等 ERP 逻辑表名，也不能使用中文字段名或臆造字段。",
    "如果需求无法匹配数据目录中的真实表和字段，必须返回 definition 为空，而不是猜测表名。",
    current ? `当前BAQ：${JSON.stringify(current)}` : "当前BAQ：无",
    `数据目录：${JSON.stringify(catalog)}`,
    `用户原话：${state.text}`,
    "如果用户是在修改已有BAQ，请尽量保留原有结构并仅按要求调整。",
  ].join("\n");
  const { content } = await callChatModel([{ role: "system", content: "只返回JSON。" }, { role: "user", content: prompt }], state.provider);
  const parsed = parseJson<{ name?: string; code?: string; description?: string; definition?: unknown }>(content);
  const isUpdate = Boolean(current?.id);
  const definition = normalizeBaqDefinition(
    isUpdate ? mergeBaqDefinition(current?.definition, parsed?.definition) : parsed?.definition,
  );
  if (!definition) {
    return {
      status: "error",
      reply: isUpdate
        ? "BAQ 修改失败：没有找到可修改的 BAQ 定义，请先明确 BAQ 名称或编码。"
        : "BAQ 创建失败：模型未生成有效的查询定义。",
    };
  }
  validateBaqDefinition(definition, catalog);
  const baq = {
    id: current?.id as number | undefined,
    code: String(parsed?.code || current?.code || `baq_${Date.now()}`),
    name: String(parsed?.name || current?.name || "未命名查询"),
    description: String(parsed?.description || current?.description || ""),
    status: "draft" as const,
    definition,
  };
  const payload = {
    code: baq.code,
    name: baq.name,
    description: baq.description || null,
    status: "draft",
    definition: baq.definition,
    updated_at: nowIso(),
  };
  const response = baq.id
    ? await supabase.from("sys_baq_queries").update(payload).eq("id", baq.id).select().single()
    : await supabase.from("sys_baq_queries").insert(payload).select().single();
  if (response.error) throw response.error;
  const saved = response.data as Record<string, unknown>;
  const definitionSummary = `数据源：${String((definition.source as Record<string, unknown>).table || "-")}\n关联表：${Array.isArray(definition.joins) ? definition.joins.length : 0} 张\n输出字段：${Array.isArray(definition.fields) ? definition.fields.length : 0} 个\n筛选条件：${Array.isArray(definition.filters) ? definition.filters.length : 0} 个\n排序条件：${Array.isArray(definition.sorts) ? definition.sorts.length : 0} 个`;
  return {
    status: "success",
    reply: `${baq.id ? "BAQ 已更新" : "BAQ 已创建"}：${String(saved.name || baq.name)}\n编码：${String(saved.code || baq.code)}\n\n${definitionSummary}`,
    data: saved,
    focus: { type: "baq", id: saved.id, code: saved.code, name: saved.name },
  };
}

export async function createOrUpdateEntityTool(
  state: AiGraphState,
  entityKey?: EntityKey,
  action: "create" | "update" = "create",
): Promise<ToolResult> {
  const detected = entityFromText(state.text);
  const entity = entityKey ? entityDefs[entityKey] : (detected ? entityDefs[detected] : null);
  if (!entity) return { status: "error", reply: "未识别出要处理的业务对象。" };
  return upsertEntity(entity, state.text, state.currentFocus, state.provider, action);
}

export async function businessAnalysisTool(state: AiGraphState): Promise<ToolResult> {
  const catalog = await loadBaqCatalog();
  const selectedCatalog = pickAnalysisCatalog(catalog, state);
  const prompt = [
    "你是 OPERP 业务分析 SQL 生成器。",
    "目标：根据用户问题，自动判断要分析什么业务，挑选合适的表和字段，生成只读 SQL，然后用于统计分析。",
    "你必须先理解用户要查的对象、指标、时间范围、分组维度、排序方式，再决定 SQL。",
    "如果用户问题不完整，请先给出一个最合理的默认决策，不要直接拒绝。",
    "只返回 JSON，不要 Markdown，不要解释。",
    "输出格式：{\"title\":\"...\",\"sql\":\"...\",\"explanation\":\"...\",\"responseMode\":\"text|table|card\",\"target\":\"...\",\"queryMode\":\"count|list|summary|detail|trend|compare|exception|answer\"}",
    "sql 必须是单条 SELECT 或 WITH 查询，只读，不允许 INSERT/UPDATE/DELETE。",
    "你可以使用下面的数据目录来选择真实业务表和字段。",
    `用户原话：${state.text}`,
    state.target ? `路由目标：${state.target}` : "路由目标：无",
    state.queryMode ? `路由模式：${state.queryMode}` : "路由模式：无",
    state.responseMode ? `路由展示：${state.responseMode}` : "路由展示：无",
    state.currentFocus ? `当前焦点：${JSON.stringify(state.currentFocus)}` : "当前焦点：无",
    `数据目录：${JSON.stringify(selectedCatalog.length ? selectedCatalog : catalog.slice(0, 20))}`,
    "优先生成能直接执行的 SQL；如果需要关联，请根据字段语义推断主外键关系，如 xxx_id -> id、code/name 等。",
    "如果问题是数量，优先用 COUNT(*) 或分组 count；如果问题是明细，用列表查询；如果问题是趋势/对比，用分组统计或时间序列。",
  ].join("\n");

  const { content } = await callChatModel(
    [
      { role: "system", content: "你只输出 JSON。" },
      { role: "user", content: prompt },
    ],
    state.provider,
  );

  const plan = parseAnalysisPlan(content);
  if (!plan?.sql) {
    return {
      status: "error",
      reply: "业务分析失败：模型未生成有效的 SQL。",
    };
  }

  console.log("[ai-server] analysis plan raw:", {
    title: plan.title,
    target: plan.target,
    queryMode: plan.queryMode,
    responseMode: plan.responseMode,
    sql: plan.sql,
  });
  plan.sql = normalizeAnalysisSql(plan.sql);
  console.log("[ai-server] analysis plan normalized SQL:", plan.sql);
  validateAnalysisSql(plan.sql, selectedCatalog.length ? selectedCatalog : catalog);
  const executed = await executeAiAnalysisSql(plan.sql);
  const rows = Array.isArray(executed?.rows) ? executed!.rows! : [];

  const previewRows = rows.slice(0, 20);
  const columns = previewRows.length
    ? Object.keys(previewRows[0])
    : [];
  const isSingleValue =
    previewRows.length === 1 && columns.length === 1 && typeof previewRows[0][columns[0]] !== "object";

  const renderTable = (dataRows: Array<Record<string, unknown>>) => {
    if (!dataRows.length) return "暂无数据。";
    const headers = Object.keys(dataRows[0]);
    const headerLine = `| ${headers.join(" | ")} |`;
    const separator = `| ${headers.map(() => "---").join(" | ")} |`;
    const body = dataRows
      .map((row) => `| ${headers.map((header) => String(row[header] ?? "")).join(" | ")} |`)
      .join("\n");
    return `${headerLine}\n${separator}\n${body}`;
  };

  const reply = isSingleValue
    ? `${plan.title || "分析结果"}：${String(previewRows[0][columns[0]])}`
    : [
        plan.title ? `# ${plan.title}` : "# 业务分析结果",
        plan.explanation ? `\n${plan.explanation}` : "",
        "\n" + renderTable(previewRows),
        rows.length > previewRows.length ? `\n\n已显示前 ${previewRows.length} 条，共 ${rows.length} 条。` : "",
      ].join("\n");

  return {
    status: "success",
    reply,
    data: {
      sql: plan.sql,
      target: plan.target || state.target,
      queryMode: plan.queryMode || state.queryMode,
      responseMode: plan.responseMode || state.responseMode,
      rowCount: rows.length,
      rows: previewRows,
      catalog: selectedCatalog.map((item) => ({ table: item.table, label: item.label })),
    },
    focus: {
      type: "business_analysis",
      target: plan.target || state.target,
      queryMode: plan.queryMode || state.queryMode,
      responseMode: plan.responseMode || state.responseMode,
      sql: plan.sql,
    },
  };
}

export async function countMasterDataTool(state: AiGraphState): Promise<ToolResult> {
  const text = state.text;
  const detected = entityFromText(text);
  const entity = detected ? entityDefs[detected] : null;
  if (!entity) {
    return {
      status: "needs_more",
      reply: "请明确要统计哪类主数据，比如客户、物料、供应商、仓库。",
      nextQuestions: ["客户", "物料", "供应商", "仓库"],
    };
  }

  const { count, error } = await supabase
    .from(entity.tableName)
    .select("*", { count: "exact", head: true })
    .eq("is_deleted", "n");

  if (error) throw error;

  return {
    status: "success",
    reply: `当前系统中${entity.label}共有 ${count || 0} 条。`,
    data: {
      entity: entity.key,
      label: entity.label,
      count: count || 0,
    },
    focus: {
      type: entity.key,
      count: count || 0,
    },
  };
}

export async function financeSummaryTool(state: AiGraphState): Promise<ToolResult> {
  const [receivablesRes, payablesRes, vouchersRes, assetsRes] = await Promise.all([
    supabase.from("erp_receivables_s_539dcf81_b").select("*").eq("is_deleted", "n"),
    supabase.from("erp_payables_s_539dcf81_b").select("*").eq("is_deleted", "n"),
    supabase.from("erp_vouchers_s_539dcf81_b").select("*").eq("is_deleted", "n"),
    supabase.from("erp_fixed_assets_s_539dcf81_b").select("*").eq("is_deleted", "n"),
  ]);
  if (receivablesRes.error) throw receivablesRes.error;
  if (payablesRes.error) throw payablesRes.error;
  if (vouchersRes.error) throw vouchersRes.error;
  if (assetsRes.error) throw assetsRes.error;

  const receivables = (receivablesRes.data || []) as Array<Record<string, unknown>>;
  const payables = (payablesRes.data || []) as Array<Record<string, unknown>>;
  const vouchers = (vouchersRes.data || []) as Array<Record<string, unknown>>;
  const assets = (assetsRes.data || []) as Array<Record<string, unknown>>;
  const sum = (rows: Array<Record<string, unknown>>, field: string) =>
    rows.reduce((acc, row) => acc + Number(row[field] || 0), 0);
  const currentDate = today();
  const overdueReceivables = receivables.filter((row) => String(row.due_date || "") < currentDate && Number(row.balance || 0) > 0);
  const overduePayables = payables.filter((row) => String(row.due_date || "") < currentDate && Number(row.balance || 0) > 0);
  const topReceivables = [...receivables].sort((a, b) => Number(b.balance || 0) - Number(a.balance || 0)).slice(0, 5);
  const topPayables = [...payables].sort((a, b) => Number(b.balance || 0) - Number(a.balance || 0)).slice(0, 5);

  const money = (value: unknown) => Number(value || 0).toFixed(2);
  const renderTopRows = (title: string, rows: Array<Record<string, unknown>>, nameField: string, amountField: string) =>
    rows.length
      ? `### ${title}\n| 名称 | 金额 |\n| --- | ---: |\n${rows.map((row) => `| ${String(row[nameField] || row.doc_no || row.id || "-")} | ${money(row[amountField])} |`).join("\n")}`
      : `### ${title}\n暂无`;

  const reply = [
    `# 财务分析报表`,
    ``,
    `## 关键指标`,
    `- 应收单据：${receivables.length} 条`,
    `- 应收余额：${sum(receivables, "balance").toFixed(2)}`,
    `- 逾期应收：${overdueReceivables.length} 条，逾期金额 ${sum(overdueReceivables, "balance").toFixed(2)}`,
    `- 应付单据：${payables.length} 条`,
    `- 应付余额：${sum(payables, "balance").toFixed(2)}`,
    `- 逾期应付：${overduePayables.length} 条，逾期金额 ${sum(overduePayables, "balance").toFixed(2)}`,
    `- 凭证数量：${vouchers.length} 张，金额合计 ${sum(vouchers, "total_amount").toFixed(2)}`,
    `- 固资数量：${assets.length} 项，净值合计 ${sum(assets, "net_value").toFixed(2)}`,
    ``,
    `## 风险提示`,
    overdueReceivables.length || overduePayables.length
      ? `- 存在逾期账款，建议优先跟进回款与付款。`
      : `- 当前未发现明显逾期账款。`,
    `- 财务数据以当前已启用单据为准。`,
    ``,
    renderTopRows("应收Top5", topReceivables, "customer_name", "balance"),
    ``,
    renderTopRows("应付Top5", topPayables, "supplier_name", "balance"),
  ].join("\n");

  return {
    status: "success",
    reply,
    data: {
      receivablesCount: receivables.length,
      payablesCount: payables.length,
      vouchersCount: vouchers.length,
      assetsCount: assets.length,
    },
  };
}
