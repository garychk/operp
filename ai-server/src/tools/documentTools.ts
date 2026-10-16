/**
 * 单据类 AI 工具（第三批能力）。
 *
 * 三个工具：
 *   - document.create  建单（单头 + 明细）      → 产出草稿，确认后调 service_ai_create_document
 *   - document.action  过账 / 反过账 / 审批 / 转单 → 产出草稿，确认后调对应 service_ai_* RPC
 *   - document.query   查询单据（只读）
 *
 * 设计原则：
 *   1. 写操作**一律**走 pendingActions 两段式（与 entity.create 同一套确认回路），
 *      工具本身不落库；
 *   2. 真正写入复用库内 RPC（deploy_83），不在 TS 里重新实现单据逻辑；
 *   3. 解析不出实体（客户/物料/单据）就回问用户，不猜。
 */
import type { AiGraphState } from "../ai/state.js";
import { supabase } from "../config/supabase.js";
import {
  DOCUMENT_TYPES,
  FLOW_RULES,
  actionLabel,
  describeDocument,
  detectDocumentAction,
  detectDocumentType,
  documentLabel,
  extractDocumentDraft,
  flowRuleLabel,
  locateDocumentById,
  prepareDocumentInput,
  resolveDocumentTarget,
  statusLabel,
  validateDocumentAction,
  type DocumentActionName,
  type DocumentTypeMeta,
  type LocatedDocument,
} from "../services/documentService.js";

import { createPendingAction } from "../services/pendingActions.js";
import { documentHeaderLabel, toolText, type ToolText } from "../services/toolText.js";
import { baseTableName } from "./entityRegistry.js";

/** 动作名类型定义在 documentService（与库内 RPC 对齐的唯一一处），这里转出去供上层沿用 */
export type { DocumentActionName };

export interface DocumentToolResult {
  status: "success" | "needs_more" | "error";
  reply: string;
  data?: unknown;
  focus?: unknown;
  route?: string;
  routeLabel?: string;
  needConfirmation?: boolean;
  nextQuestions?: string[];
}

const focusTypeOf = (state: AiGraphState): string | undefined => {
  const focus = state.currentFocus as Record<string, unknown> | undefined;
  return typeof focus?.type === "string" ? focus.type : undefined;
};

const buildFocus = (
  meta: DocumentTypeMeta,
  id: number | undefined,
  no: string | undefined,
  extra?: Record<string, unknown>,
) => ({
  type: meta.type,
  id,
  code: no,
  name: no,
  route: meta.route,
  routeLabel: meta.routeLabel,
  ...extra,
});

/** 单据草稿预览（人可读，确认前看清楚要写什么） */
const renderDocumentPreview = (
  meta: DocumentTypeMeta,
  lines: Array<Record<string, unknown>>,
  notes: string[],
  tt: ToolText,
): string => {
  const label = documentLabel(meta, tt.locale);
  const headerLines = notes.length
    ? notes.map((note) => `- ${note}`)
    : [`- ${tt("common.noExtraFields")}`];
  const lineRows = lines
    .map((line, index) => {
      // 物料取明确字段名（不再靠「第一个 _id」猜：明细行里可能有多个 id 列）
      const productId = line[meta.lineProductField];
      const qty = line.quantity ?? line.planned_quantity ?? "-";
      const price = line.unit_price ?? line.unit_cost ?? "-";
      return `| ${index + 1} | ${productId != null ? String(productId) : "-"} | ${String(qty)} | ${String(price)} |`;
    })
    .join("\n");
  return [
    tt("doc.preview.title", { label }),
    "",
    ...headerLines,
    "",
    tt("doc.preview.tableHeader"),
    "| --- | --- | --- | --- |",
    lines.length ? lineRows : tt("doc.preview.noLines"),
    "",
    tt("doc.preview.confirmHint", { label, routeLabel: meta.routeLabel }),
  ].join("\n");
};

/* ------------------------------------------------------------------ *
 * document.create
 * ------------------------------------------------------------------ */
export async function createDocumentTool(state: AiGraphState): Promise<DocumentToolResult> {
  const tt = toolText(state.locale);
  if (typeof state.userId !== "number" || typeof state.tenantId !== "number") {
    return { status: "error", reply: tt("doc.err.missingUserCreate") };
  }

  const documentType = detectDocumentType(state.text, focusTypeOf(state));
  if (!documentType) {
    const creatable = Object.values(DOCUMENT_TYPES).filter((meta) => meta.creatable);
    return {
      status: "needs_more",
      reply: tt("doc.err.askType", {
        types: creatable.map((meta) => documentLabel(meta, tt.locale)).join(tt.locale === "en" ? ", " : "、"),
      }),
      nextQuestions: creatable
        .slice(0, 4)
        .map((meta) => tt("doc.create.quickAsk", { label: documentLabel(meta, tt.locale) })),
    };
  }

  const meta = DOCUMENT_TYPES[documentType];
  if (!meta.creatable) {
    return {
      status: "error",
      reply: tt("doc.err.notCreatable", { label: documentLabel(meta, tt.locale) }),
    };
  }

  const raw = await extractDocumentDraft(state, meta, state.provider);
  const resolved = await prepareDocumentInput(state, meta, raw);
  if (resolved.error || !resolved.prepared) {
    return {
      status: "needs_more",
      reply: resolved.error || tt("doc.err.incompleteDraft"),
      nextQuestions: [],
    };
  }
  const { header, lines, fieldLines } = resolved.prepared;

  const pendingId = await createPendingAction({
    sessionId: state.sessionId,
    userId: state.userId,
    tenantId: state.tenantId,
    actionType: "document.create",
    entityKey: meta.type,
    tableName: meta.headerTable,
    payload: { documentType: meta.type, header, lines },
    context: {
      action: "create",
      kind: "document",
      documentType: meta.type,
      label: meta.label,
      tableTag: baseTableName(meta.headerTable),
      display: tt("doc.preview.draftDisplay", {
        label: documentLabel(meta, tt.locale),
        count: lines.length,
      }),
      fieldLines,
      route: meta.route,
      routeLabel: meta.routeLabel,
      // 草稿记住**下单时**的界面语言：稍后确认/续跑时回复文案仍按这个语言渲染
      locale: tt.locale,
      // 多步计划：本步确认执行后继续跑剩余步骤
      remainingPlan: state.planRemaining,
    },
  });

  return {
    status: "success",
    reply: renderDocumentPreview(meta, lines, fieldLines, tt),
    needConfirmation: true,
    route: meta.route,
    routeLabel: meta.routeLabel,
    focus: buildFocus(meta, undefined, undefined),
    data: { pendingActionId: pendingId, documentType: meta.type, header, lines },
  };
}

/* ------------------------------------------------------------------ *
 * document.action —— 过账 / 反过账 / 审批 / 转单
 * ------------------------------------------------------------------ */
export interface DocumentActionOptions {
  action?: DocumentActionName;
  documentType?: string;
  /** 多步计划里由上一步产出显式指定的目标单据 id */
  documentId?: number;
}

export async function documentActionTool(
  state: AiGraphState,
  options?: DocumentActionOptions,
): Promise<DocumentToolResult> {
  const tt = toolText(state.locale);
  if (typeof state.userId !== "number" || typeof state.tenantId !== "number") {
    return { status: "error", reply: tt("doc.err.missingUserAction") };
  }

  const action = options?.action || detectDocumentAction(state.text);
  if (!action) {
    return {
      status: "needs_more",
      reply: tt("doc.action.ask"),
      nextQuestions: [
        tt("doc.action.quickPost"),
        tt("doc.action.quickSubmit"),
        tt("doc.action.quickConvert"),
      ],
    };
  }

  // 目标单据：多步计划显式给的 id 优先，其次才是文本单号 / 页面焦点
  const explicitType = options?.documentType || detectDocumentType(state.text) || undefined;
  let located: { document?: LocatedDocument; error?: string };
  if (options?.documentId && explicitType && DOCUMENT_TYPES[explicitType]) {
    located = await locateDocumentById(
      DOCUMENT_TYPES[explicitType],
      options.documentId,
      state.tenantId,
      state.locale,
    );
  } else {
    located = await resolveDocumentTarget(state, explicitType);
  }
  if (located.error || !located.document) {
    return { status: "needs_more", reply: located.error || tt("doc.err.notLocated"), nextQuestions: [] };
  }
  const { document: doc } = located;
  const meta = doc.meta;

  // 状态前置校验（给可读提示；真正的约束仍在库内函数里）
  // 规则本体在 documentService.validateDocumentAction，与 MCP 工具共用同一份。
  const invalid = validateDocumentAction(doc, action, state.locale);
  if (invalid) return { status: "error", reply: invalid };

  if (action === "convert") {
    const rule = FLOW_RULES[meta.type];
    return stageAction(state, doc.id, meta, "convert", {
      ruleCode: rule.ruleCode,
      targetLabel: flowRuleLabel(rule, state.locale),
      display: `${doc.no} → ${flowRuleLabel(rule, state.locale)}`,
      remainingPlan: state.planRemaining,
    });
  }

  return stageAction(state, doc.id, meta, action, { display: doc.no, remainingPlan: state.planRemaining });
}

/** 生成动作草稿（统一入口，避免每个分支重复拼 context） */
async function stageAction(
  state: AiGraphState,
  documentId: number,
  meta: DocumentTypeMeta,
  action: "post" | "reverse" | "submit" | "approve" | "reject" | "withdraw" | "convert",
  extra: { ruleCode?: string; targetLabel?: string; display?: string; remainingPlan?: unknown[] },
): Promise<DocumentToolResult> {
  const tt = toolText(state.locale);
  const display = extra.display || `#${documentId}`;
  const pendingId = await createPendingAction({
    sessionId: state.sessionId,
    userId: state.userId as number,
    tenantId: state.tenantId as number,
    actionType: "document.action",
    entityKey: meta.type,
    tableName: meta.headerTable,
    payload: {
      documentType: meta.type,
      documentId,
      action,
      ruleCode: extra.ruleCode,
      comment: state.text.slice(0, 200),
    },
    existingId: documentId,
    context: {
      action,
      kind: "document",
      documentType: meta.type,
      label: meta.label,
      tableTag: baseTableName(meta.headerTable),
      display,
      route: meta.route,
      routeLabel: meta.routeLabel,
      locale: tt.locale,
      remainingPlan: extra.remainingPlan,
    },
  });

  const actionName = actionLabel(action, state.locale);
  const tail = extra.remainingPlan?.length
    ? `\n\n${tt("doc.action.confirmTail", { count: extra.remainingPlan.length })}`
    : "";
  return {
    status: "success",
    reply: tt("doc.action.preview", {
      label: documentLabel(meta, state.locale),
      display,
      action: actionName,
      target: extra.targetLabel ? tt("doc.action.previewTarget", { targetLabel: extra.targetLabel }) : "",
      tail,
    }),
    needConfirmation: true,
    route: meta.route,
    routeLabel: meta.routeLabel,
    focus: buildFocus(meta, documentId, undefined, { status: undefined }),
    data: { pendingActionId: pendingId, documentType: meta.type, documentId, action },
  };
}

/* ------------------------------------------------------------------ *
 * document.query —— 只读
 * ------------------------------------------------------------------ */
export async function queryDocumentTool(state: AiGraphState): Promise<DocumentToolResult> {
  const tt = toolText(state.locale);
  if (typeof state.tenantId !== "number") {
    return { status: "error", reply: tt("doc.err.missingTenantQuery") };
  }
  const tenantId = state.tenantId;

  // ① 有单号 / 焦点 → 详情
  const located = await resolveDocumentTarget(state, detectDocumentType(state.text) || undefined);
  if (located.document) {
    const doc = located.document;
    const detail = await describeDocument(doc.meta, doc.id, tenantId);
    if (detail) {
      // 单头字段名也走本地化词典（order_no → 单据编号 / Document number）
      const headerLines = Object.entries(detail.header)
        .filter(([key]) =>
          ["id", doc.meta.noField, doc.meta.dateField, "status", "total_amount", "tax_amount",
            "receivable_amount", "payable_amount", "customer_id", "supplier_id", "warehouse_id", "remark"].includes(key),
        )
        .map(([key, value]) =>
          `- ${documentHeaderLabel(key, state.locale)}: ${
            key === "status" ? statusLabel(String(value), state.locale) : String(value ?? "-")
          }`,
        );
      const lineRows = detail.lines
        .map((line) => `| ${line.line_no ?? "-"} | ${line[doc.meta.lineProductField] ?? "-"} | ${line.quantity ?? line.planned_quantity ?? "-"} | ${line.amount ?? "-"} |`)
        .join("\n");
      return {
        status: "success",
        reply: [
          `# ${documentLabel(doc.meta, state.locale)} ${doc.no}`,
          "",
          ...headerLines,
          "",
          tt("doc.query.tableHeader"),
          "| --- | --- | --- | --- |",
          lineRows || tt("doc.query.emptyRow"),
        ].join("\n"),
        route: doc.meta.route,
        routeLabel: doc.meta.routeLabel,
        focus: buildFocus(doc.meta, doc.id, doc.no),
        data: { documentType: doc.type, documentId: doc.id, documentNo: doc.no, status: doc.status },
      };
    }
  }

  // ② 没有指定单据 → 列出最近单据（若文本里指定了类型就只看该类）
  const type = detectDocumentType(state.text, focusTypeOf(state));
  const targets = type && DOCUMENT_TYPES[type] ? [DOCUMENT_TYPES[type]] : Object.values(DOCUMENT_TYPES);
  const rows: string[] = [];
  for (const meta of targets) {
    const { data } = await supabase
      .from(meta.headerTable)
      .select(`id, ${meta.noField}, status, ${meta.dateField}`)
      .eq("tenant_id", tenantId)
      .eq("is_deleted", "n")
      .order("id", { ascending: false })
      .limit(5);
    for (const row of (data || []) as unknown as Array<Record<string, unknown>>) {
      rows.push(
        `| ${documentLabel(meta, state.locale)} | ${row[meta.noField]} | ${statusLabel(String(row.status), state.locale)} | ${row[meta.dateField] ?? "-"} |`,
      );
    }
  }
  if (!rows.length) {
    return {
      status: "success",
      reply: located.error
        ? tt("doc.query.noneWithError", { error: located.error })
        : tt("doc.query.none"),
    };
  }
  return {
    status: "success",
    reply: [
      `# ${tt("doc.query.recentTitle")}`,
      "",
      tt("doc.query.recentTableHeader"),
      "| --- | --- | --- | --- |",
      ...rows,
      "",
      tt("doc.query.followUp"),
    ].join("\n"),
  };
}
