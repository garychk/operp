import type { AiGraphState } from "../state.js";
import { DOCUMENT_TYPES, FLOW_RULES, detectDocumentAction, detectDocumentType } from "../../services/documentService.js";

/** 计划步骤：tool 名 + input（input 值支持 "$prev.<field>" 引用上一步产出） */
export interface PlanStep {
  step: string;
  tool: string;
  input?: Record<string, unknown>;
}

/** 多动作连词：出现时说明用户想要的是一串操作，计划器才拆多步 */
const MULTI_STEP_CONNECTORS = /(然后|再|之后|接着|顺便|同时|并且|并|随后)/;
const CREATE_SIGNAL = /(创建|新建|新增|生成|录入|保存|写入|建立|建一张|建个|加一个|加个|添加|增加)/;
const POST_SIGNAL = /(过账|记账|入账)/;
const CONVERT_SIGNAL = /(转单|下推|转成|生成下游|流转)/;

/**
 * 计划器。
 *
 * 分两层：
 *   1. 单步（原有确定性映射，保持行为不变）；
 *   2. 多步（第三批新增）：文本里出现「然后 / 再 / 之后」这类连词且带多个动作信号时，
 *      拆成 [建单 → 过账] / [转单 → 过账] 这类有序计划。
 *
 * 多步只做**确定性**组合（不调 LLM 规划）：写操作涉及库内 RPC 与确认回路，
 * 让模型自由发挥计划风险高于收益；模型仍负责在每一步里解析业务字段。
 */
export function buildMultiStepPlan(state: AiGraphState): PlanStep[] | null {
  const text = state.text;
  if (!MULTI_STEP_CONNECTORS.test(text)) return null;

  const documentType = detectDocumentType(text);
  if (!documentType) return null;

  const wantsCreate = CREATE_SIGNAL.test(text);
  const wantsPost = POST_SIGNAL.test(text);
  const wantsConvert = CONVERT_SIGNAL.test(text);
  const action = detectDocumentAction(text);

  const meta = DOCUMENT_TYPES[documentType];
  const flowRule = FLOW_RULES[documentType];

  /**
   * 「订单类」单据不能直接过账：用户说「建采购订单然后过账」时，
   * 真实的下游动作是「转成采购入库单」。这里把这类第二步换成转单，
   * 否则第二步一定报「没有过账入口」（实测过），等于计划白拆。
   */
  const downstreamIsConvert = wantsPost && !meta.postable;

  // 建单 → 过账（或转单）
  if (wantsCreate && (wantsPost || wantsConvert)) {
    const secondStep: PlanStep = downstreamIsConvert
      ? { step: "convert_document", tool: "document.action", input: { action: "convert", documentType, documentId: "$prev.document_id" } }
      : {
          step: "post_document",
          tool: "document.action",
          input: { action: "post", documentType, documentId: "$prev.document_id" },
        };
    if (downstreamIsConvert && !flowRule) return null;
    return [{ step: "create_document", tool: "document.create", input: { documentType, action: "create" } }, secondStep];
  }

  // 转单 → 过账（采购订单转入库单后过账、销售订单转出货单后过账 …）
  if ((wantsConvert || downstreamIsConvert) && wantsPost && !wantsCreate) {
    if (!flowRule) return null;
    const target = DOCUMENT_TYPES[flowRule.targetType];
    if (!target?.postable) return null;
    return [
      { step: "convert_document", tool: "document.action", input: { action: "convert", documentType } },
      {
        step: "post_document",
        tool: "document.action",
        input: { action: "post", documentType: flowRule.targetType, documentId: "$prev.target_document_id" },
      },
    ];
  }
  // 单动作（含连词但只有一个动作）→ 交给单步逻辑
  if (action) return null;
  return null;
}

export async function plannerNode(state: AiGraphState): Promise<AiGraphState> {
  // ① 确认回路：执行草稿；若草稿上挂着多步剩余计划，一并接在后面继续跑
  if (state.intent === "confirm_execute") {
    const remaining = Array.isArray(state.pendingAction?.remainingPlan)
      ? (state.pendingAction?.remainingPlan as PlanStep[])
      : [];
    return {
      ...state,
      plan: [
        { step: "execute_pending_action", tool: "entity.execute_pending", input: { pendingActionId: state.pendingAction?.id } },
        ...remaining,
      ],
      planCursor: 0,
      planOutputs: [],
    };
  }

  if (state.intent === "cancel_action") {
    return {
      ...state,
      plan: [{ step: "cancel_pending_action", tool: "entity.cancel_pending", input: { pendingActionId: state.pendingAction?.id } }],
      planCursor: 0,
      planOutputs: [],
    };
  }

  // ② 多步计划（确定性组合，优先于单步）
  const multiStep = buildMultiStepPlan(state);
  if (multiStep) {
    return { ...state, plan: multiStep, planCursor: 0, planOutputs: [] };
  }

  // ③ 单步映射
  const plan: PlanStep[] =
    state.intent === "page_design"
      ? [{ step: "design_custom_page", tool: "page.design", input: { text: state.text } }]
      : state.intent === "document"
      ? documentPlan(state)
      : state.intent === "baq"
        ? [{ step: "create_or_update_baq", tool: "baq.upsert", input: { text: state.text, currentFocus: state.currentFocus } }]
        : state.intent === "create"
          ? [{ step: "create_entity", tool: "entity.create", input: { text: state.text } }]
          : state.intent === "update"
            ? [{ step: "update_entity", tool: "entity.update", input: { text: state.text, currentFocus: state.currentFocus } }]
            : state.intent === "analysis"
              ? state.domain === "master_data"
                ? [{ step: "master_data_count", tool: "master_data.count", input: { text: state.text, target: state.target, queryMode: state.queryMode } }]
                : [{ step: "business_analysis", tool: "business.analysis", input: { text: state.text, target: state.target, queryMode: state.queryMode, responseMode: state.responseMode } }]
              : state.intent === "knowledge"
                ? [{ step: "knowledge_lookup", tool: "knowledge.search", input: { text: state.text } }]
                : state.intent === "navigation"
                  ? [{ step: "locate_menu", tool: "menu.locate", input: { text: state.text } }]
                  : [{ step: "draft_reply", tool: "chat.respond", input: { text: state.text } }];

  return { ...state, plan, planCursor: 0, planOutputs: [] };
}

/** 单据意图 → 单步计划（建单 / 动作 / 查询） */
const documentPlan = (state: AiGraphState): PlanStep[] => {
  const action = detectDocumentAction(state.text);
  const documentType = detectDocumentType(state.text);
  if (action) {
    return [
      {
        step: `document_${action}`,
        tool: "document.action",
        input: { action, documentType: documentType || undefined, text: state.text },
      },
    ];
  }
  if (CREATE_SIGNAL.test(state.text)) {
    return [{ step: "create_document", tool: "document.create", input: { documentType: documentType || undefined, action: "create" } }];
  }
  return [{ step: "query_document", tool: "document.query", input: { text: state.text, documentType: documentType || undefined } }];
};
