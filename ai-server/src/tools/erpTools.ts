import { supabase } from "../config/supabase.js";
import { callChatModel } from "../config/llm.js";
import type { AiChatRequest, AiGraphState } from "../ai/state.js";

type ToolStatus = "success" | "needs_more" | "error";

interface ToolResult {
  status: ToolStatus;
  reply: string;
  data?: unknown;
  focus?: unknown;
  needConfirmation?: boolean;
  nextQuestions?: string[];
}

interface BaqTable {
  table: string;
  label: string;
  columns: Array<{ name: string; type: string }>;
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
}

const nowIso = () => new Date().toISOString();
const today = () => new Date().toISOString().slice(0, 10);

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

async function extractEntityPayload(entity: EntityDef, text: string, current?: Record<string, unknown> | null) {
  const prompt = [
    `你是ERP数据录入助手。请从用户描述中提取${entity.label}的字段值，只返回JSON，不要解释。`,
    `实体表：${entity.tableName}`,
    `允许字段：${Object.keys(entity.defaults()).join(", ")}`,
    current ? `当前记录：${JSON.stringify(current)}` : "当前记录：无",
    `用户原话：${text}`,
    "返回格式：{\"fields\":{...},\"need_more\":[],\"summary\":\"\"}",
  ].join("\n");
  const { content } = await callChatModel([
    { role: "system", content: "你只返回JSON。" },
    { role: "user", content: prompt },
  ]);
  const parsed = parseJson<{ fields?: Record<string, unknown>; need_more?: string[]; summary?: string }>(content);
  return {
    fields: parsed?.fields || {},
    need_more: parsed?.need_more || [],
    summary: parsed?.summary || "",
  };
}

async function upsertEntity(entity: EntityDef, text: string, currentFocus?: unknown, provider?: AiChatRequest["provider"]) {
  const current = currentFocus && typeof currentFocus === "object" ? currentFocus as Record<string, unknown> : null;
  const existing = current?.id ? current : await runEntitySearch(entity, text);
  const extracted = await extractEntityPayload(entity, text, existing);
  if (extracted.need_more.length > 0 && !existing) {
    return {
      status: "needs_more" as const,
      reply: `创建${entity.label}还缺少这些信息：${extracted.need_more.join("、")}`,
      nextQuestions: extracted.need_more,
    };
  }

  const payload = {
    ...entity.defaults(),
    ...(existing || {}),
    ...extracted.fields,
    updated_at: nowIso(),
  };

  delete (payload as Record<string, unknown>).id;
  delete (payload as Record<string, unknown>).created_at;

  const isUpdate = !!existing?.id;
  const response = isUpdate
    ? await supabase.from(entity.tableName).update(payload).eq("id", existing.id).select().single()
    : await supabase.from(entity.tableName).insert(payload).select().single();
  if (response.error) throw response.error;
  const row = response.data as Record<string, unknown>;
  return {
    status: "success" as const,
    reply: `${isUpdate ? "已更新" : "已创建"}${entity.label}：${String(row[entity.nameField || entity.codeField || "id"] || row.id || "-")}`,
    data: row,
    focus: { type: entity.key, id: row.id, code: row[entity.codeField || "code"], name: row[entity.nameField || entity.codeField || "name"] },
  };
}

async function loadBaqCatalog(): Promise<BaqTable[]> {
  const { data, error } = await supabase.rpc("baq_catalog");
  if (error) throw error;
  return (data || []) as BaqTable[];
}

async function findBaqTarget(text: string, focus?: unknown) {
  const { data, error } = await supabase.from("sys_baq_queries").select("*").eq("is_deleted", "n").order("updated_at", { ascending: false });
  if (error) throw error;
  const items = (data || []) as Array<Record<string, unknown>>;
  const normalized = normalize(text);
  const byFocus = focus && typeof focus === "object" ? (focus as Record<string, unknown>) : null;
  const focusCandidate = byFocus?.id ? items.find((item) => String(item.id) === String(byFocus.id)) || null : null;
  if (focusCandidate) return focusCandidate;
  return items.find((item) => normalized.includes(normalize(String(item.code || ""))) || normalized.includes(normalize(String(item.name || "")))) || null;
}

export async function createOrUpdateBaqTool(state: AiGraphState): Promise<ToolResult> {
  const catalog = await loadBaqCatalog();
  const target = await findBaqTarget(state.text, state.currentFocus);
  const current = target || null;
  const prompt = [
    "你是BAQ设计助手。请根据用户描述输出一个完整的BAQ JSON，只返回JSON。",
    "必须包含：name, code, description, definition。",
    "definition 包含：source, joins, fields, filters, sorts。",
    current ? `当前BAQ：${JSON.stringify(current)}` : "当前BAQ：无",
    `数据目录：${JSON.stringify(catalog)}`,
    `用户原话：${state.text}`,
    "如果用户是在修改已有BAQ，请尽量保留原有结构并仅按要求调整。",
  ].join("\n");
  const { content } = await callChatModel([{ role: "system", content: "只返回JSON。" }, { role: "user", content: prompt }], state.provider);
  const parsed = parseJson<{ name?: string; code?: string; description?: string; definition?: unknown }>(content);
  if (!parsed?.definition) {
    return { status: "error", reply: "BAQ 生成失败：模型未返回有效定义。" };
  }
  const baq = {
    id: current?.id as number | undefined,
    code: String(parsed.code || current?.code || `baq_${Date.now()}`),
    name: String(parsed.name || current?.name || "未命名查询"),
    description: String(parsed.description || current?.description || ""),
    status: "draft" as const,
    definition: parsed.definition,
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
  return {
    status: "success",
    reply: `${baq.id ? "BAQ 已更新" : "BAQ 已创建"}：${String(saved.name || baq.name)}\n编码：${String(saved.code || baq.code)}`,
    data: saved,
    focus: { type: "baq", id: saved.id, code: saved.code, name: saved.name },
  };
}

export async function createOrUpdateEntityTool(state: AiGraphState, entityKey?: EntityKey): Promise<ToolResult> {
  const entity = entityKey ? entityDefs[entityKey] : (entityFromText(state.text) ? entityDefs[entityFromText(state.text)!] : null);
  if (!entity) return { status: "error", reply: "未识别出要处理的业务对象。" };
  return upsertEntity(entity, state.text, state.currentFocus, state.provider);
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

  const reply = [
    `应收 ${receivables.length} 条，余额 ${sum(receivables, "balance").toFixed(2)}，逾期 ${overdueReceivables.length} 条，逾期金额 ${sum(overdueReceivables, "balance").toFixed(2)}。`,
    `应付 ${payables.length} 条，余额 ${sum(payables, "balance").toFixed(2)}，逾期 ${overduePayables.length} 条，逾期金额 ${sum(overduePayables, "balance").toFixed(2)}。`,
    `凭证 ${vouchers.length} 张，合计金额 ${sum(vouchers, "total_amount").toFixed(2)}。`,
    `固定资产 ${assets.length} 项，净值合计 ${sum(assets, "net_value").toFixed(2)}。`,
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
