import type { AiGraphState } from "../state.js";

const CREATE_WORDS = /(创建|新建|新增|生成|录入|保存|写入|建立)/i;
const UPDATE_WORDS = /(修改|更新|编辑|调整|补充|修订|改一下|改成|变更|替换|优化)/i;
const ENTITY_WORDS = /(物料|产品|客户|供应商|仓库|工作中心|bom|工艺路线|部门|工序|采购订单|销售订单|采购入库|销售出货|生产订单)/i;
const BAQ_WORDS = /(baq|报表查询|查询)/i;
const KNOWLEDGE_WORDS = /(知识库|制度|流程|手册|说明|怎么做|怎么处理|为什么|规则|规范)/i;
const ANALYSIS_WORDS = /(分析|看一下|统计|汇总|报表|对比|趋势|预警|盘点|经营|财务|采购|销售|生产|应收|应付|凭证|利润)/i;
const MRP_WORDS = /(mrp|物料需求计划|产能|缺料|净需求)/i;

const detectAction = (text: string) => {
  if (UPDATE_WORDS.test(text)) return "update" as const;
  if (CREATE_WORDS.test(text)) return "create" as const;
  return "chat" as const;
};

export async function intentRouterNode(state: AiGraphState): Promise<AiGraphState> {
  const text = state.text.toLowerCase();
  let intent = "chat";
  let domain = "general";
  let action: "create" | "update" | "chat" = detectAction(text);

  // An explicitly selected skill is authoritative. This prevents the model
  // from falling back to a generic chat response for write operations.
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

  return { ...state, intent, domain, action };
}
