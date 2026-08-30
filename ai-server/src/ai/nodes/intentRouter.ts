import type {
  AiAction,
  AiGraphState,
  AiIntent,
  AiQueryMode,
  AiResponseMode,
} from "../state.js";
import { callChatModel } from "../../config/llm.js";

const CREATE_WORDS = /(创建|新建|新增|生成|录入|保存|写入|建立)/i;
const UPDATE_WORDS = /(修改|更新|编辑|调整|补充|修订|改一下|改成|变更|替换|优化)/i;
const COUNT_WORDS = /(多少|几个|总数|数量|有几|有多少|一共|总共有|总计|合计)/i;
const LIST_WORDS = /(哪些|列表|清单|明细|列出|展示|给我看)/i;
const TREND_WORDS = /(趋势|变化|波动|近一周|近一月|近三月|同比|环比)/i;
const COMPARE_WORDS = /(对比|比较|差异)/i;
const EXCEPTION_WORDS = /(异常|预警|超期|缺料|呆滞|负库存|风险)/i;
const BAQ_WORDS = /(baq|报表查询|查询设计)/i;
const KNOWLEDGE_WORDS = /(知识库|制度|流程|手册|说明|怎么做|怎么处理|为什么|规则|规范)/i;
const ANALYSIS_WORDS = /(分析|统计|汇总|报表|经营|财务|采购|销售|生产|应收|应付|凭证|利润|库存)/i;
const MRP_WORDS = /(mrp|物料需求计划|产能|净需求)/i;

const TARGET_PATTERNS: Array<{ target: string; pattern: RegExp; domain: string }> = [
  { target: "customer", pattern: /(客户|客商)/i, domain: "master_data" },
  { target: "supplier", pattern: /(供应商)/i, domain: "master_data" },
  { target: "product", pattern: /(物料|产品|商品)/i, domain: "master_data" },
  { target: "warehouse", pattern: /(仓库|库位)/i, domain: "master_data" },
  { target: "department", pattern: /(部门)/i, domain: "master_data" },
  { target: "workCenter", pattern: /(工作中心)/i, domain: "master_data" },
  { target: "operation", pattern: /(工序)/i, domain: "master_data" },
  { target: "bom", pattern: /(bom|物料清单)/i, domain: "engineering" },
  { target: "routing", pattern: /(工艺路线|路线)/i, domain: "engineering" },
  { target: "purchaseOrder", pattern: /(采购订单|采购单)/i, domain: "procurement" },
  { target: "purchaseReceipt", pattern: /(采购入库|入库单)/i, domain: "procurement" },
  { target: "salesOrder", pattern: /(销售订单|销售单)/i, domain: "sales" },
  { target: "salesDelivery", pattern: /(销售出货|出货单)/i, domain: "sales" },
  { target: "productionOrder", pattern: /(生产订单|生产单|工单)/i, domain: "production" },
  { target: "finance", pattern: /(财务|应收|应付|凭证|利润|现金流|费用)/i, domain: "finance" },
  { target: "inventory", pattern: /(库存|存货|现存量)/i, domain: "inventory" },
  { target: "mrp", pattern: /(mrp|物料需求计划|净需求|缺料)/i, domain: "production" },
  { target: "baq", pattern: /(baq|报表查询|查询设计)/i, domain: "baq" },
];

type RoutedIntent = {
  intent?: AiIntent;
  domain?: string;
  action?: AiAction;
  target?: string;
  queryMode?: AiQueryMode;
  responseMode?: AiResponseMode;
  confidence?: number;
};

const parseJson = <T,>(value: string): T | null => {
  const trimmed = value.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const raw = fenced ? fenced[1] : trimmed;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

const detectAction = (text: string): AiAction => {
  if (UPDATE_WORDS.test(text)) return "update";
  if (CREATE_WORDS.test(text)) return "create";
  return "chat";
};

const detectTarget = (text: string, focus?: unknown) => {
  for (const item of TARGET_PATTERNS) {
    if (item.pattern.test(text)) {
      return { target: item.target, domain: item.domain };
    }
  }
  if (focus && typeof focus === "object") {
    const record = focus as Record<string, unknown>;
    if (typeof record.type === "string") {
      return { target: record.type, domain: "master_data" };
    }
  }
  return { target: "general", domain: "general" };
};

const detectQueryMode = (text: string): AiQueryMode => {
  if (COUNT_WORDS.test(text)) return "count";
  if (TREND_WORDS.test(text)) return "trend";
  if (COMPARE_WORDS.test(text)) return "compare";
  if (EXCEPTION_WORDS.test(text)) return "exception";
  if (LIST_WORDS.test(text)) return "list";
  if (BAQ_WORDS.test(text)) return "definition";
  if (ANALYSIS_WORDS.test(text) || MRP_WORDS.test(text)) return "summary";
  return "answer";
};

const detectResponseMode = (
  intent: AiIntent,
  target: string,
  queryMode: AiQueryMode,
): AiResponseMode => {
  if (intent === "create" || intent === "update") return "card";
  if (intent === "baq") return "card";
  if (queryMode === "count") return "text";
  if (queryMode === "list" || queryMode === "compare") return "table";
  if (queryMode === "trend" || queryMode === "summary" || queryMode === "exception") return "card";
  if (target !== "general" && intent === "knowledge") return "table";
  return "text";
};

const ruleFallback = (state: AiGraphState): RoutedIntent => {
  const text = state.text.toLowerCase();
  const action = detectAction(text);
  const targetInfo = detectTarget(text, state.currentFocus);
  let queryMode = detectQueryMode(text);
  let intent: AiIntent = "chat";
  let domain = targetInfo.domain;

  if (state.skill === "baq" || BAQ_WORDS.test(text)) {
    intent = "baq";
    domain = "baq";
  } else if (state.skill === "chat") {
    intent = "chat";
    domain = "general";
  } else if (state.skill === "create" || state.skill === "action") {
    intent = action === "update" ? "update" : "create";
    domain = targetInfo.domain === "general" ? "master_data" : targetInfo.domain;
  } else if (state.skill === "analysis") {
    intent = "analysis";
    domain = targetInfo.domain === "general" ? "finance" : targetInfo.domain;
  } else if (KNOWLEDGE_WORDS.test(text)) {
    intent = "knowledge";
    domain = targetInfo.domain === "general" ? "knowledge" : targetInfo.domain;
  } else if (action === "create") {
    intent = "create";
    domain = targetInfo.domain === "general" ? "master_data" : targetInfo.domain;
  } else if (action === "update") {
    intent = "update";
    domain = targetInfo.domain === "general" ? "master_data" : targetInfo.domain;
  } else if (MRP_WORDS.test(text) || ANALYSIS_WORDS.test(text) || queryMode !== "answer") {
    intent = "analysis";
    domain = targetInfo.domain === "general" ? "business" : targetInfo.domain;
  }

  if (intent === "analysis" && domain === "business" && queryMode === "answer") {
    queryMode = "summary";
  }

  return {
    intent,
    domain,
    action,
    target: targetInfo.target,
    queryMode,
    responseMode: detectResponseMode(intent, targetInfo.target, queryMode),
    confidence: 0.55,
  };
};

async function routeByModel(state: AiGraphState): Promise<RoutedIntent | null> {
  if (!state.provider?.endpoint || !state.provider?.model) {
    return null;
  }

  const recentMessages = state.recentMessages
    .slice(-6)
    .map((item) => {
      const record = item as { role?: string; content?: string };
      return `${record.role || "unknown"}: ${record.content || ""}`;
    })
    .join("\n");

  const prompt = [
    "你是 ERP 智能路由器，只能输出 JSON。",
    "你要判断：intent、target、queryMode、responseMode、action、domain、confidence。",
    "intent 只能是：chat, knowledge, create, update, baq, analysis。",
    "target 尽量从这些值中选择：customer, supplier, product, warehouse, department, workCenter, operation, bom, routing, purchaseOrder, purchaseReceipt, salesOrder, salesDelivery, productionOrder, finance, inventory, mrp, baq, general。",
    "queryMode 只能是：count, list, summary, detail, trend, compare, exception, definition, answer。",
    "responseMode 只能是：text, table, card, link, follow_up。",
    "如果用户要新增记录，用 create；如果要修改已有记录，用 update。",
    "如果用户在问某个业务对象有多少条、多少个，用 analysis + queryMode=count。",
    "如果用户要看列表、清单、明细，用 queryMode=list 或 detail。",
    "如果用户在问制度、说明、怎么做、规则，用 knowledge。",
    "如果用户要设计 BAQ，用 baq。",
    "如果用户问的是经营、库存、采购、销售、生产、财务分析，用 analysis，并根据对象选择 target 和 domain。",
    "confidence 输出 0 到 1 的小数。",
    '输出格式：{"intent":"analysis","target":"customer","queryMode":"count","responseMode":"text","action":"chat","domain":"master_data","confidence":0.92}',
    state.currentFocus ? `当前焦点：${JSON.stringify(state.currentFocus)}` : "当前焦点：无",
    recentMessages ? `最近对话：\n${recentMessages}` : "最近对话：无",
    `用户原话：${state.text}`,
  ].join("\n");

  try {
    const { content } = await callChatModel(
      [
        { role: "system", content: "你只输出 JSON，不要解释。" },
        { role: "user", content: prompt },
      ],
      state.provider,
    );
    const parsed = parseJson<RoutedIntent>(content);
    if (!parsed?.intent) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function intentRouterNode(state: AiGraphState): Promise<AiGraphState> {
  const fallback = ruleFallback(state);
  const routed = (await routeByModel(state)) || {};

  const intent = routed.intent || fallback.intent;
  const target = routed.target || fallback.target;
  const queryMode = routed.queryMode || fallback.queryMode;
  const action = routed.action || fallback.action;
  const domain = routed.domain || fallback.domain;
  const responseMode =
    routed.responseMode || detectResponseMode(intent!, target || "general", queryMode!);
  const confidence =
    typeof routed.confidence === "number" ? routed.confidence : fallback.confidence;

  return {
    ...state,
    intent,
    domain,
    action,
    target,
    queryMode,
    responseMode,
    confidence,
  };
}
