import type { AiGraphState } from "../state.js";
import { callChatModel } from "../../config/llm.js";

const CREATE_WORDS = /(创建|新建|新增|生成|录入|保存|写入|建立)/i;
const UPDATE_WORDS = /(修改|更新|编辑|调整|补充|修订|改一下|改成|变更|替换|优化)/i;
const ENTITY_WORDS = /(物料|产品|客户|供应商|仓库|工作中心|bom|工艺路线|部门|工序|采购订单|销售订单|采购入库|销售出货|生产订单)/i;
const COUNT_WORDS = /(多少|几个|总数|数量|有几|有多少|一共|总共有|总计|合计)/i;
const BAQ_WORDS = /(baq|报表查询|查询)/i;
const KNOWLEDGE_WORDS = /(知识库|制度|流程|手册|说明|怎么做|怎么处理|为什么|规则|规范)/i;
const ANALYSIS_WORDS = /(分析|看一下|统计|汇总|报表|对比|趋势|预警|盘点|经营|财务|采购|销售|生产|应收|应付|凭证|利润)/i;
const MRP_WORDS = /(mrp|物料需求计划|产能|缺料|净需求)/i;

const detectAction = (text: string) => {
  if (UPDATE_WORDS.test(text)) return "update" as const;
  if (CREATE_WORDS.test(text)) return "create" as const;
  return "chat" as const;
};

type RoutedIntent = {
  intent?: "chat" | "knowledge" | "create" | "update" | "baq" | "analysis";
  domain?: string;
  action?: "create" | "update" | "chat";
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

const ruleFallback = (state: AiGraphState) => {
  const text = state.text.toLowerCase();
  let intent: RoutedIntent["intent"] = "chat";
  let domain = "general";
  let action: RoutedIntent["action"] = detectAction(text);

  if (state.skill === "baq") {
    intent = "baq";
    domain = "baq";
  } else if (state.skill === "analysis") {
    intent = "analysis";
    domain = "finance";
  } else if (state.skill === "create" || state.skill === "action") {
    intent = action === "update" ? "update" : "create";
    domain = "master_data";
  } else if (state.skill === "chat") {
    intent = "chat";
    domain = "general";
  } else if (BAQ_WORDS.test(text) && (CREATE_WORDS.test(text) || UPDATE_WORDS.test(text))) {
    intent = "baq";
    domain = "baq";
  } else if (ENTITY_WORDS.test(text) && COUNT_WORDS.test(text) && !CREATE_WORDS.test(text) && !UPDATE_WORDS.test(text)) {
    intent = "analysis";
    domain = "master_data";
  } else if (ENTITY_WORDS.test(text) && (CREATE_WORDS.test(text) || UPDATE_WORDS.test(text))) {
    intent = action === "update" ? "update" : "create";
    domain = "master_data";
  } else if (MRP_WORDS.test(text)) {
    intent = "analysis";
    domain = "production";
  } else if (KNOWLEDGE_WORDS.test(text)) {
    intent = "knowledge";
    domain = "knowledge";
  } else if (ANALYSIS_WORDS.test(text) && !CREATE_WORDS.test(text) && !UPDATE_WORDS.test(text)) {
    intent = "analysis";
    domain = /采购/.test(text)
      ? "procurement"
      : /销售/.test(text)
        ? "sales"
        : /生产|mrp/.test(text)
          ? "production"
          : "finance";
  }

  return { intent, domain, action };
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
    "你是 ERP 对话意图路由器，只能输出 JSON。",
    "请判断用户意图属于以下之一：chat, knowledge, create, update, baq, analysis。",
    "如果用户是要新增业务数据，用 create；如果是修改/更新现有记录，用 update。",
    "如果是 BAQ 查询设计，用 baq。",
    "如果是知识库/制度/流程/说明/怎么做，用 knowledge。",
    "如果是询问某类主数据的数量、总数、统计、多少个客户/物料/供应商，用 analysis，domain 取 master_data。",
    "如果是分析、统计、汇总、报表、财务、采购、销售、生产、MRP，用 analysis。",
    "如果只是闲聊、确认、泛问答，用 chat。",
    "同时给出 domain 和 action。",
    "输出格式：{\"intent\":\"create|update|baq|analysis|knowledge|chat\",\"domain\":\"xxx\",\"action\":\"create|update|chat\"}",
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
    if (!parsed?.intent) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function intentRouterNode(state: AiGraphState): Promise<AiGraphState> {
  let routed = await routeByModel(state);
  if (!routed?.intent) {
    routed = ruleFallback(state);
  }

  const fallback = ruleFallback(state);
  const intent = routed.intent || fallback.intent;
  const domain = routed.domain || fallback.domain;
  const action = routed.action || fallback.action;

  return { ...state, intent, domain, action };
}
