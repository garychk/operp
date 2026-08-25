import type { AiGraphState } from "../state.js";

export async function intentRouterNode(state: AiGraphState): Promise<AiGraphState> {
  const text = state.text.toLowerCase();
  let intent = "chat";
  let domain = "general";

  if (/(baq|报表查询|查询)/i.test(text) && /(创建|新建|生成|修改|更新|编辑|调整|优化|补充|继续)/i.test(text)) {
    intent = "baq";
    domain = "baq";
  } else if (/(物料|产品|客户|供应商|仓库|工作中心|bom|工艺路线)/i.test(text) && /(创建|新建|修改|更新|编辑)/i.test(text)) {
    intent = "create_or_update";
    domain = "master_data";
  } else if (/(采购|销售|生产|凭证|应收|应付|mrp|财务)/i.test(text)) {
    intent = "erp";
    domain = /采购/.test(text)
      ? "procurement"
      : /销售/.test(text)
        ? "sales"
        : /生产|mrp/.test(text)
          ? "production"
          : "finance";
  } else if (/(知识库|制度|流程|手册|说明|怎么做)/i.test(text)) {
    intent = "knowledge";
    domain = "knowledge";
  }

  return { ...state, intent, domain };
}
