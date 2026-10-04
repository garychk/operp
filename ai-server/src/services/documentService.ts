/**
 * 单据业务服务层（第三批：单据类 AI 工具）。
 *
 * 职责划分（与记忆铁律一致：业务内核在库里，TS 只做解析/编排）：
 *   - 真实写入内核在库内 RPC（deploy_83）：ai_create_document / service_ai_post_document /
 *     service_ai_workflow_action / service_ai_doc_flow_generate；
 *   - 本文件只负责「自然语言 → 结构化单据输入」的解析（LLM 抽取 + 名称到 id 的解析），
 *     以及「单据定位 / 查询」这类读操作。
 *
 * ⚠️ 库内 ai_document_meta() 才是类型/字段白名单的唯一权威（写入时由它校验）。
 *    这里的 DOCUMENT_TYPES 是**展示与解析用的镜像**，只放前端路由、中文名、
 *    参与解析的字段名；不要在此处扩展写白名单。
 */
import { supabase } from "../config/supabase.js";
import { callChatModel } from "../config/llm.js";
import type { AiChatRequest, AiGraphState } from "../ai/state.js";

/**
 * 单据流转规则（deploy_35/36/57 注册的 rule_code）。
 * 计划器与工具都用它：订单类单据不能直接过账，下游动作其实是「转成入库/出货/领料单」。
 */
export const FLOW_RULES: Record<string, { ruleCode: string; targetType: string; label: string }> = {
  purchase_order: { ruleCode: "purchase_order_to_receipt", targetType: "purchase_receipt", label: "采购入库单" },
  sales_order: { ruleCode: "sales_order_to_delivery", targetType: "sales_delivery", label: "销售出货单" },
  production_order: { ruleCode: "production_order_to_material_issue", targetType: "material_issue", label: "生产领料单" },
};

export interface DocumentTypeMeta {
  type: string;
  label: string;
  /** 前端页面路由（用于 focus 跳转） */
  route: string;
  routeLabel: string;
  headerTable: string;
  detailTable: string;
  noField: string;
  fkField: string;
  dateField: string;
  /** 往来单位字段 + 主数据表（销售类=客户，采购类=供应商） */
  partyField?: "customer_id" | "supplier_id";
  partyTable?: string;
  partyLabel?: string;
  /** 是否允许 AI 直接建单（与库内 creatable 对齐） */
  creatable: boolean;
  /** 是否可过账（与库内 post_route 对齐） */
  postable: boolean;
  /** 明细里的物料字段名（多数是 product_id，领料单是 material_id） */
  lineProductField: string;
}

const TABLE_SUFFIX = "_s_539dcf81_b";

export const DOCUMENT_TYPES: Record<string, DocumentTypeMeta> = {
  sales_order: {
    type: "sales_order", label: "销售订单", route: "/inventory/sales", routeLabel: "销售订单",
    headerTable: `erp_sales_orders${TABLE_SUFFIX}`, detailTable: `erp_sales_order_details${TABLE_SUFFIX}`,
    noField: "order_no", fkField: "order_id", dateField: "order_date",
    partyField: "customer_id", partyTable: `erp_customers${TABLE_SUFFIX}`, partyLabel: "客户",
    creatable: true, postable: false, lineProductField: "product_id",
  },
  purchase_order: {
    type: "purchase_order", label: "采购订单", route: "/inventory/purchase", routeLabel: "采购订单",
    headerTable: `erp_purchase_orders${TABLE_SUFFIX}`, detailTable: `erp_purchase_order_details${TABLE_SUFFIX}`,
    noField: "order_no", fkField: "order_id", dateField: "order_date",
    partyField: "supplier_id", partyTable: `erp_suppliers${TABLE_SUFFIX}`, partyLabel: "供应商",
    creatable: true, postable: false, lineProductField: "product_id",
  },
  purchase_receipt: {
    type: "purchase_receipt", label: "采购入库单", route: "/inventory/purchase-receipts", routeLabel: "采购入库单",
    headerTable: `erp_purchase_receipts${TABLE_SUFFIX}`, detailTable: `erp_purchase_receipt_details${TABLE_SUFFIX}`,
    noField: "receipt_no", fkField: "receipt_id", dateField: "receipt_date",
    partyField: "supplier_id", partyTable: `erp_suppliers${TABLE_SUFFIX}`, partyLabel: "供应商",
    creatable: true, postable: true, lineProductField: "product_id",
  },
  sales_delivery: {
    type: "sales_delivery", label: "销售出货单", route: "/inventory/sales-deliveries", routeLabel: "销售出货单",
    headerTable: `erp_sales_deliveries${TABLE_SUFFIX}`, detailTable: `erp_sales_delivery_details${TABLE_SUFFIX}`,
    noField: "delivery_no", fkField: "delivery_id", dateField: "delivery_date",
    partyField: "customer_id", partyTable: `erp_customers${TABLE_SUFFIX}`, partyLabel: "客户",
    creatable: true, postable: true, lineProductField: "product_id",
  },
  material_issue: {
    type: "material_issue", label: "生产领料单", route: "/mrp/material-issues", routeLabel: "生产领料单",
    headerTable: `erp_material_issues${TABLE_SUFFIX}`, detailTable: `erp_material_issue_details${TABLE_SUFFIX}`,
    noField: "issue_no", fkField: "issue_id", dateField: "issue_date",
    creatable: true, postable: true, lineProductField: "material_id",
  },
  production_order: {
    type: "production_order", label: "生产订单", route: "/mrp/production", routeLabel: "生产订单",
    headerTable: `erp_production_orders${TABLE_SUFFIX}`, detailTable: `erp_production_order_details${TABLE_SUFFIX}`,
    noField: "order_no", fkField: "order_id", dateField: "order_date",
    creatable: true, postable: false, lineProductField: "material_id",
  },
  production_receipt: {
    type: "production_receipt", label: "生产入库单", route: "/mrp/production-receipts", routeLabel: "生产入库单",
    headerTable: `erp_production_receipts${TABLE_SUFFIX}`, detailTable: `erp_production_receipt_details${TABLE_SUFFIX}`,
    noField: "receipt_no", fkField: "receipt_id", dateField: "receipt_date",
    creatable: false, postable: true, lineProductField: "product_id",
  },
  inventory_transfer: {
    type: "inventory_transfer", label: "库存调拨单", route: "/inventory/transfers", routeLabel: "库存调拨单",
    headerTable: `erp_inventory_transfers${TABLE_SUFFIX}`, detailTable: `erp_inventory_transfer_details${TABLE_SUFFIX}`,
    noField: "transfer_no", fkField: "transfer_id", dateField: "transfer_date",
    creatable: false, postable: true, lineProductField: "product_id",
  },
  stock_adjustment: {
    type: "stock_adjustment", label: "库存调整单", route: "/inventory/stock-adjustments", routeLabel: "库存调整单",
    headerTable: `erp_stock_adjustments${TABLE_SUFFIX}`, detailTable: `erp_stock_adjustment_details${TABLE_SUFFIX}`,
    noField: "adjust_no", fkField: "adjustment_id", dateField: "adjust_date",
    creatable: false, postable: true, lineProductField: "product_id",
  },
};

/** 文档类型的中文别名（解析用；顺序敏感：更具体的关键词放前面，
 *  例如「生产入库单」必须排在「入库单」之前，否则会被采购入库抢走） */
const TYPE_ALIASES: Array<{ type: string; pattern: RegExp }> = [
  { type: "sales_order", pattern: /(销售订单|销售单)/i },
  { type: "purchase_order", pattern: /(采购订单|采购单)/i },
  { type: "sales_delivery", pattern: /(销售出货|出货单|发货单)/i },
  { type: "production_receipt", pattern: /(生产入库|完工入库)/i },
  { type: "purchase_receipt", pattern: /(采购入库|入库单)/i },
  { type: "production_order", pattern: /(生产订单|生产单|工单)/i },
  { type: "material_issue", pattern: /(领料单|领料)/i },
  { type: "inventory_transfer", pattern: /(调拨单|调拨)/i },
  { type: "stock_adjustment", pattern: /(库存调整|调整单)/i },
];

/** 供 LLM 抽取的字段中文说明（仅解析提示，不是白名单） */
const FIELD_HINTS: Record<string, string> = {
  customer_id: "客户", supplier_id: "供应商",
  order_date: "单据日期", delivery_date: "交货日期", receipt_date: "入库日期",
  delivery_date_alt: "出库日期", issue_date: "领料日期",
  warehouse_id: "仓库", location_id: "库位",
  product_id: "物料/产品", material_id: "物料",
  quantity: "数量", unit_price: "单价", unit_cost: "单位成本",
  tax_rate: "税率(小数)", tax_amount: "税额", amount: "金额",
  planned_quantity: "计划数量", unit: "单位",
  delivery_address: "交货地址", contact_person: "联系人", contact_phone: "联系电话",
  remark: "备注", batch_no: "批号", priority: "优先级",
};

export const detectDocumentType = (text: string, fallbackType?: string): string | null => {
  for (const item of TYPE_ALIASES) {
    if (item.pattern.test(text)) return item.type;
  }
  if (text.includes("调拨")) return "inventory_transfer";
  // 文本里没有明确类型时，允许沿用上下文给出的类型（含 focus 里的单据类型）
  return fallbackType && DOCUMENT_TYPES[fallbackType] ? fallbackType : null;
};

/** 过账/反过账/审批类意图里出现的动作词 */
export const detectDocumentAction = (
  text: string,
): "post" | "reverse" | "submit" | "approve" | "reject" | "withdraw" | "convert" | null => {
  if (/(反过账|取消过账|冲销|反冲|撤销过账|红冲)/i.test(text)) return "reverse";
  if (/(过账|记账|入账)/i.test(text)) return "post";
  if (/(转单|下推|生成.*单|转成|流转)/i.test(text)) return "convert";
  if (/(审批通过|审核通过|批准|通过审批|同意审批)/i.test(text)) return "approve";
  if (/(驳回|退回|拒绝审批|审批不通过)/i.test(text)) return "reject";
  if (/(撤回|撤销审批|收回)/i.test(text)) return "withdraw";
  if (/(提交审批|提交审核|送审)/i.test(text)) return "submit";
  return null;
};

export interface LocatedDocument {
  type: string;
  meta: DocumentTypeMeta;
  id: number;
  no: string;
  status: string;
  label: string;
}

/** 文本里可能的单据号（SO20260005 / PR20260004 …） */
const DOC_NO_PATTERN = /[A-Z]{2,4}\d{4,}/gi;

/**
 * 按单号定位单据：遍历所有单据类型的单号字段查（service_role 无 RLS，必须显式带 tenant_id）。
 * 同号在不同表里重复的可能性极低，取第一条命中。
 */
export async function findDocumentByNo(no: string, tenantId: number): Promise<LocatedDocument | null> {
  const candidates = Object.values(DOCUMENT_TYPES);
  const results = await Promise.all(
    candidates.map(async (meta) => {
      const { data, error } = await supabase
        .from(meta.headerTable)
        .select(`id, ${meta.noField}, status, tenant_id`)
        .eq(meta.noField, no)
        .eq("tenant_id", tenantId)
        .eq("is_deleted", "n")
        .limit(1)
        .maybeSingle();
      if (error) return null;
      return data ? { meta, row: data as unknown as Record<string, unknown> } : null;
    }),
  );
  const hit = results.find(Boolean) as { meta: DocumentTypeMeta; row: Record<string, unknown> } | undefined;
  if (!hit) return null;
  return {
    type: hit.meta.type,
    meta: hit.meta,
    id: Number(hit.row.id),
    no: String(hit.row[hit.meta.noField] ?? no),
    status: String(hit.row.status ?? "-"),
    label: hit.meta.label,
  };
}

/* ------------------------------------------------------------------ *
 * 单据动作：类型、前置校验、按 id 定位
 *
 * 这一组是「HTTP 对话链路」与「MCP 工具」共用的业务不变量。
 * 放在服务层而不是各自的入口层，是因为两边的调用形状不同
 * （一边是多轮 state，一边是结构化入参），但「什么状态能过账」
 * 这类规则只能有一份实现 —— 否则迟早会分叉。
 * ------------------------------------------------------------------ */

/** 单据动作名（与库内 service_ai_* 支持的集合对齐） */
export type DocumentActionName =
  | "post"
  | "reverse"
  | "submit"
  | "approve"
  | "reject"
  | "withdraw"
  | "convert";

/** 各单据类型「可过账」的起始状态（与库内过账函数的前置校验对齐） */
export const POSTABLE_STATUSES: Record<string, string[]> = {
  purchase_receipt: ["approved"],
  sales_delivery: ["approved"],
  material_issue: ["draft", "approved", "issued"],
  production_receipt: ["draft", "approved", "issued"],
  inventory_transfer: ["approved"],
  stock_adjustment: ["approved"],
  stock_count: ["approved"],
};

/**
 * 动作前置校验：返回可读的中文错误，null 表示放行。
 *
 * 真正的约束仍在库内函数里，这里只是把「为什么不行」提前讲清楚，
 * 避免调用方拿到一个语焉不详的数据库报错。
 */
export function validateDocumentAction(
  doc: LocatedDocument,
  action: DocumentActionName,
): string | null {
  const meta = doc.meta;

  if (action === "post") {
    if (!meta.postable) {
      return `${meta.label}没有过账入口，请通过单据流转（转单）生成下游单据后再过账。`;
    }
    const allowed = POSTABLE_STATUSES[meta.type] || ["approved"];
    if (!allowed.includes(doc.status)) {
      return `${meta.label} ${doc.no} 当前状态是「${statusLabel(doc.status)}」，不能过账（需要 ${allowed
        .map(statusLabel)
        .join(" 或 ")}）。可以先「提交审批」或「审批通过」。`;
    }
  }

  if (action === "reverse" && doc.status !== "posted") {
    return `${meta.label} ${doc.no} 当前状态是「${statusLabel(doc.status)}」，只有已过账的单据能反过账。`;
  }

  if (action === "convert") {
    const rule = FLOW_RULES[meta.type];
    if (!rule) {
      return `${meta.label}没有配置下游流转规则，不能转单。可流转的源单据：${Object.keys(FLOW_RULES)
        .map((type) => DOCUMENT_TYPES[type]?.label || type)
        .join("、")}。`;
    }
  }

  return null;
}

/**
 * 按 id 定位单据（多步计划续跑、MCP 显式指定 document_id 时用）。
 * service_role 绕过 RLS，所以这里必须显式带 tenant_id。
 */
export async function locateDocumentById(
  meta: DocumentTypeMeta,
  id: number,
  tenantId: number,
): Promise<{ document?: LocatedDocument; error?: string }> {
  const { data } = await supabase
    .from(meta.headerTable)
    .select(`id, ${meta.noField}, status`)
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .eq("is_deleted", "n")
    .maybeSingle();
  if (!data) {
    return { error: `没有找到${meta.label} #${id}（可能不属于当前租户或已删除）。` };
  }
  const row = data as unknown as Record<string, unknown>;
  return {
    document: {
      type: meta.type,
      meta,
      id: Number(row.id),
      no: String(row[meta.noField] ?? id),
      status: String(row.status ?? "-"),
      label: meta.label,
    },
  };
}

/**
 * 把调用方给的「单据类型引用」解析成类型定义。
 * 同时接受类型键（sales_order）与中文名/别名（销售订单、采购入库单）。
 */
export function resolveDocumentTypeRef(ref: string | undefined): DocumentTypeMeta | null {
  const value = (ref || "").trim();
  if (!value) return null;
  if (DOCUMENT_TYPES[value]) return DOCUMENT_TYPES[value];
  const byAlias = TYPE_ALIASES.find((item) => item.pattern.test(value));
  if (byAlias) return DOCUMENT_TYPES[byAlias.type];
  const byLabel = Object.values(DOCUMENT_TYPES).find((meta) => meta.label === value);
  return byLabel || null;
}

/**
 * 单据类型的中文名清单（供工具生成可读提示）。
 * @param onlyCreatable 为 true 时只列出允许 AI 直接建单的类型
 */
export const documentTypeLabels = (onlyCreatable = false): string =>
  Object.values(DOCUMENT_TYPES)
    .filter((meta) => !onlyCreatable || meta.creatable)
    .map((meta) => meta.label)
    .join("、");

/**
 * 定位「要操作的单据」：优先用文本里的单号，其次是当前焦点（页面上的单据）。
 * 定位不到时返回原因，供工具回问用户。
 */
export async function resolveDocumentTarget(
  state: AiGraphState,
  preferredType?: string,
): Promise<{ document?: LocatedDocument; error?: string }> {
  if (typeof state.tenantId !== "number") {
    return { error: "缺少租户上下文，无法定位单据。" };
  }
  const tenantId = state.tenantId;

  const tokens = state.text.match(DOC_NO_PATTERN) || [];
  for (const token of tokens) {
    const found = await findDocumentByNo(token.toUpperCase(), tenantId);
    if (found) return { document: found };
  }

  // 焦点：{ type: "sales_order", id: 12 } 或 { target: ... , id }
  const focus = state.currentFocus as Record<string, unknown> | undefined;
  const focusType = typeof focus?.type === "string" ? focus.type : preferredType;
  const focusId = Number(focus?.id);
  if (focusType && DOCUMENT_TYPES[focusType] && Number.isFinite(focusId) && focusId > 0) {
    const meta = DOCUMENT_TYPES[focusType];
    const { data } = await supabase
      .from(meta.headerTable)
      .select(`id, ${meta.noField}, status`)
      .eq("id", focusId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (data) {
      const row = data as unknown as Record<string, unknown>;
      return {
        document: {
          type: meta.type, meta, id: Number(row.id),
          no: String(row[meta.noField] ?? focusId), status: String(row.status ?? "-"), label: meta.label,
        },
      };
    }
  }

  return {
    error: tokens.length
      ? `没有找到单号 ${tokens.join("、")} 对应的单据（可能不属于当前租户或已删除）。`
      : "请告诉我要操作哪张单据，例如「把销售订单 SO20260005 过账」，或先在单据页面上打开它。",
  };
}

/** 名称 → 主数据 id：唯一命中才返回；多条命中返回候选（让用户确认） */
async function resolveByName(
  table: string,
  nameField: string,
  name: string,
  tenantId: number,
  label: string,
): Promise<{ id?: number; error?: string; note?: string }> {
  const clean = name.trim();
  if (!clean) return { error: `${label}名称不能为空。` };
  const { data, error } = await supabase
    .from(table)
    .select(`id, ${nameField}`)
    .eq("tenant_id", tenantId)
    .eq("is_deleted", "n")
    .ilike(nameField, `%${clean}%`)
    .limit(5);
  if (error) return { error: `查询${label}失败：${error.message}` };
  const rows = (data || []) as unknown as Array<Record<string, unknown>>;
  if (!rows.length) return { error: `没有找到${label}「${clean}」，请确认名称是否正确。` };
  const exact = rows.filter((row) => String(row[nameField]).toLowerCase() === clean.toLowerCase());
  if (exact.length === 1) return { id: Number(exact[0].id) };
  if (rows.length === 1) return { id: Number(rows[0].id) };
  const names = (exact.length ? exact : rows).map((row) => String(row[nameField])).join("、");
  return { error: `${label}「${clean}」有多个匹配：${names}。请说明具体是哪一个。` };
}

/**
 * 单据草稿的中间形态（名称尚未解析为 id）。
 * 两个来源共用：对话链路由 LLM 抽取，MCP 工具由结构化入参直接拼装。
 */
export interface RawDocumentDraft {
  party_name?: string;
  warehouse_name?: string;
  header?: Record<string, unknown>;
  lines?: Array<Record<string, unknown>>;
  summary?: string;
}

/** LLM 从自然语言里抽单据字段（只抽取，不做 id 解析，也不落库） */
export async function extractDocumentDraft(
  state: AiGraphState,
  meta: DocumentTypeMeta,
  provider?: AiChatRequest["provider"],
): Promise<RawDocumentDraft> {
  const headerFields = [
    meta.dateField, "delivery_date", "warehouse_id", "location_id",
    "delivery_address", "contact_person", "contact_phone", "remark",
  ].filter(Boolean);
  const lineFields = [
    `${meta.lineProductField}(物料名称)`, "quantity(数量)", "unit_price(单价)",
    "unit_cost(单位成本)", "tax_rate(税率小数)", "tax_amount(税额)", "batch_no(批号)", "remark(备注)",
  ];
  const hints = headerFields
    .concat([meta.lineProductField, "quantity", "unit_price", "unit_cost", "tax_rate", "tax_amount", "warehouse_id"])
    .map((field) => `${field}=${FIELD_HINTS[field] || field}`)
    .join("; ");

  const prompt = [
    `你是 ERP 单据录入助手。从用户描述里提取一张「${meta.label}」的字段，只返回 JSON，不要解释。`,
    `单头可填字段：${headerFields.join(", ")}`,
    `明细可填字段：${lineFields.join(", ")}`,
    `字段含义：${hints}`,
    "所有 id 类字段（客户/供应商/物料/仓库）请填写**中文名称原文**，服务端会解析成 id。",
    "日期请输出 YYYY-MM-DD；没有给日期时不要填，服务端会补当天。",
    "金额：用户给了单价就填 unit_price；只给总额时填 amount。不要自己计算税额。",
    `用户原话：${state.text}`,
    '返回格式：{"party_name":"","warehouse_name":"","header":{},"lines":[{"物料字段":"名称","quantity":0,"unit_price":0}],"summary":""}',
  ].join("\n");

  const { content } = await callChatModel(
    [
      { role: "system", content: "你只返回 JSON。" },
      { role: "user", content: prompt },
    ],
    provider ?? state.provider,
  );

  const fenced = content.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const raw = fenced ? fenced[1] : content.trim();
  try {
    return JSON.parse(raw) as RawDocumentDraft;
  } catch {
    return {};
  }
}

export interface PreparedDocument {
  documentType: string;
  meta: DocumentTypeMeta;
  header: Record<string, unknown>;
  lines: Array<Record<string, unknown>>;
  fieldLines: string[];
  notes: string[];
}

/**
 * 把 LLM 抽取结果解析成库内 RPC 可直接消费的 header / lines（名称 → id）。
 * 任何一处解析不出来都返回 error，让工具回问用户（不猜）。
 */
export async function prepareDocumentInput(
  state: AiGraphState,
  meta: DocumentTypeMeta,
  raw: RawDocumentDraft,
): Promise<{ prepared?: PreparedDocument; error?: string }> {
  if (typeof state.tenantId !== "number") return { error: "缺少租户上下文。" };
  const tenantId = state.tenantId;
  const notes: string[] = [];
  const header: Record<string, unknown> = {};
  const lines: Array<Record<string, unknown>> = [];

  // ① 往来单位
  if (meta.partyField && meta.partyTable) {
    const partyName =
      String(raw.party_name || raw.header?.[meta.partyField] || "").trim();
    if (!partyName) {
      return { error: `请告诉我这张${meta.label}的${meta.partyLabel || "往来单位"}是谁。` };
    }
    const resolved = await resolveByName(
      meta.partyTable, "name", partyName, tenantId, meta.partyLabel || "往来单位",
    );
    if (resolved.error) return { error: resolved.error };
    header[meta.partyField] = resolved.id;
    notes.push(`${meta.partyLabel}：${partyName}（id=${resolved.id}）`);
  }

  // ② 单头其他字段（去掉 id 类原始值，避免把名称写进 id 列）
  const rawHeader = raw.header || {};
  for (const [key, value] of Object.entries(rawHeader)) {
    if (key === meta.partyField || key === "status" || key === meta.noField) continue;
    if (value === null || value === undefined || value === "") continue;
    if (/_(id)$/.test(key) && typeof value === "string" && !/^\d+$/.test(value)) continue;
    header[key] = value;
  }
  if (rawHeader.status && String(rawHeader.status) !== "draft") {
    return {
      error: `AI 建单只能生成草稿（draft），不能直接设为 ${String(rawHeader.status)}；需要审批请在建单后跟我说「提交审批」或「审批通过」。`,
    };
  }

  // ③ 仓库（名称 → id）
  if (raw.warehouse_name) {
    const resolved = await resolveByName(
      `erp_warehouses${TABLE_SUFFIX}`, "name", String(raw.warehouse_name), tenantId, "仓库",
    );
    if (resolved.error) return { error: resolved.error };
    header.warehouse_id = resolved.id;
    notes.push(`仓库：${raw.warehouse_name}（id=${resolved.id}）`);
  }

  // ④ 明细
  const rawLines = Array.isArray(raw.lines) ? raw.lines : [];
  if (!rawLines.length) return { error: `这张${meta.label}至少要有一行明细（物料 + 数量）。` };
  for (const [index, rawLine] of rawLines.entries()) {
    const productName = String(
      rawLine[meta.lineProductField] || rawLine.product_name || rawLine.material_name || "",
    ).trim();
    if (!productName) {
      return { error: `第 ${index + 1} 行明细缺少物料名称。` };
    }
    const product = await resolveByName(
      `erp_products${TABLE_SUFFIX}`, "name", productName, tenantId, "物料",
    );
    if (product.error) return { error: `第 ${index + 1} 行：${product.error}` };

    const line: Record<string, unknown> = { [meta.lineProductField]: product.id };
    for (const [key, value] of Object.entries(rawLine)) {
      if (key === meta.lineProductField || key.endsWith("_name")) continue;
      if (value === null || value === undefined || value === "") continue;
      line[key] = value;
    }
    lines.push(line);
    notes.push(`第 ${index + 1} 行：${productName} × ${String(line.quantity ?? "-")}`);
  }

  return {
    prepared: { documentType: meta.type, meta, header, lines, fieldLines: notes, notes },
  };
}

/** 读单据详情（查询工具用）：单头 + 明细 */
export async function describeDocument(
  meta: DocumentTypeMeta,
  id: number,
  tenantId: number,
): Promise<{ header: Record<string, unknown>; lines: Array<Record<string, unknown>> } | null> {
  const { data: header } = await supabase
    .from(meta.headerTable)
    .select("*")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (!header) return null;
  const { data: lines } = await supabase
    .from(meta.detailTable)
    .select("*")
    .eq(meta.fkField, id)
    .eq("tenant_id", tenantId)
    .eq("is_deleted", "n")
    .order("line_no", { ascending: true });
  return {
    header: header as Record<string, unknown>,
    lines: (lines || []) as Array<Record<string, unknown>>,
  };
}

/** 单据状态的中文说明（展示用） */
export const statusLabel = (status: string): string =>
  ({
    draft: "草稿", pending: "待审批", approved: "已审批", rejected: "已驳回",
    partially_delivered: "部分出货", delivered: "已出货",
    partially_received: "部分入库", received: "已入库",
    issued: "已发料", posted: "已过账", closed: "已关闭", cancelled: "已取消",
  })[status] || status;

/** 过账 / 审批 / 流转动作的中文名 */
export const actionLabel = (action: string): string =>
  ({
    post: "过账", reverse: "反过账", submit: "提交审批", approve: "审批通过",
    reject: "驳回", withdraw: "撤回审批", convert: "转单",
  })[action] || action;
