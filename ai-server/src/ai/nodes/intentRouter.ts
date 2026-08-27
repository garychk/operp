import type { AiGraphState } from "../state.js";

export async function intentRouterNode(state: AiGraphState): Promise<AiGraphState> {
  const text = state.text.toLowerCase();
  let intent = "chat";
  let domain = "general";

  // An explicitly selected skill is authoritative. This prevents the model
  // from falling back to a generic chat response for write operations.
  if (state.skill === "baq") {
    intent = "baq";
    domain = "baq";
  } else if (state.skill === "analysis") {
    intent = "finance";
    domain = "finance";
  } else if (state.skill === "create" || state.skill === "action") {
    intent = "master_data";
    domain = "master_data";
  } else if (state.skill === "chat") {
    intent = "chat";
    domain = "general";
  } else if (/(baq|报表查询|查询)/i.test(text) && /(创建|新建|生成|修改|更新|编辑|调整|优化|补充|继续)/i.test(text)) {
    intent = "baq";
    domain = "baq";
  } else if (
    /(物料|产品|客户|供应商|仓库|工作中心|bom|工艺路线|部门|工序|采购订单|销售订单|采购入库|销售出货|生产订单)/i.test(text) &&
    /(创建|新建|新增|生成|修改|更新|编辑|调整|补充|录入|保存|写入|建立)/i.test(text)
  ) {
    intent = "master_data";
    domain = "master_data";
  } else if (/(采购|销售|生产|凭证|应收|应付|财务)/i.test(text) && !/(创建|新建|新增|生成|修改|更新|编辑|调整|补充|录入|保存|写入|建立)/i.test(text)) {
    intent = "finance";
    domain = /采购/.test(text)
      ? "procurement"
      : /销售/.test(text)
        ? "sales"
        : /生产|mrp/.test(text)
          ? "production"
          : "finance";
  } else if (/(mrp|物料需求计划|产能|缺料|净需求)/i.test(text)) {
    intent = "finance";
    domain = "production";
  } else if (/(知识库|制度|流程|手册|说明|怎么做)/i.test(text)) {
    intent = "knowledge";
    domain = "knowledge";
  }

  return { ...state, intent, domain };
}
