import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TenantContext } from "../config/tenantContext.js";
import { queryDocumentTool } from "../tools/documentTools.js";
import { baseTableName } from "../tools/entityRegistry.js";
import {
  DOCUMENT_TYPES,
  FLOW_RULES,
  actionLabel,
  documentTypeLabels,
  findDocumentByNo,
  locateDocumentById,
  prepareDocumentInput,
  resolveDocumentTypeRef,
  statusLabel,
  validateDocumentAction,
  type DocumentActionName,
  type LocatedDocument,
} from "../services/documentService.js";
import {
  PENDING_ACTION_TTL_MINUTES,
  PendingActionError,
  createPendingAction,
  executePendingAction,
} from "../services/pendingActions.js";
import { renderToolResult, buildState } from "./adapters.js";
import { McpAuthError } from "./auth.js";
import { DESTRUCTIVE_ANNOTATIONS, READ_ONLY_ANNOTATIONS, WRITE_DRAFT_ANNOTATIONS, runTool } from "./toolContract.js";

/**
 * MCP 单据工具（写入能力）。
 *
 * 与只读工具集的分工：这里只放「建单 / 单据动作 / 提交执行 / 单据查询」，
 * 业务实现全部复用 services/documentService + 库内 RPC（deploy_83）。
 * 不在 TS 里重写任何单据不变量（取号、台账、库存回写都在库里）。
 *
 * ── 为什么是「草稿 + 提交」两个工具，而不是一次调用直接写 ──────────────────
 *
 * MCP 是请求/响应模型，客户端里没有「用户回复确认」这一轮，
 * 而对话链路上的写库是在用户回「确认」之后才发生的（见 services/pendingActions）。
 * 所以那套两段式在这里必须显式拆成两次工具调用：
 *
 *   1. erp_create_document / erp_document_action → 只产草稿，返回 action_id
 *   2. erp_commit_document                       → 按 action_id 真正写库
 *
 * 收益不是「多一道手续」，而是三点确定的行为：
 *   - 默认安全：调用方必须显式再调一次提交工具，才可能落库；
 *   - 可审计：草稿与执行各自留痕（sys_ai_pending_actions + sys_ai_operation_logs）；
 *   - 可追溯：草稿 30 分钟有效、只能被同一用户/租户提交、执行一次后即失效
 *     （重复提交会被 already_handled 挡下，不会把单据过账两次）。
 */

/** 单据工具的兜底：报错文本本身已是给调用方的可执行说明，不再套一层前缀 */
const runDocTool = (label: string, fn: () => Promise<string>) =>
  runTool(label, fn, (message) => message);

const jsonBlock = (value: unknown): string => {
  try {
    return ["```json", JSON.stringify(value, null, 2), "```"].join("\n");
  } catch {
    return "";
  }
};

const renderLineRows = (lines: Array<Record<string, unknown>>): string => {
  const rows = lines.map((line, index) => {
    const product = Object.entries(line).find(([key]) => key.endsWith("_id") && key !== "tenant_id");
    const qty = line.quantity ?? line.planned_quantity ?? "-";
    const price = line.unit_price ?? line.unit_cost ?? "-";
    return `| ${index + 1} | ${product ? String(product[1]) : "-"} | ${String(qty)} | ${String(price)} |`;
  });
  return [
    "| 行 | 物料ID | 数量 | 单价/成本 |",
    "| --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
};

const commitHint = (actionId: number): string =>
  `草稿编号 \`action_id=${actionId}\`，${PENDING_ACTION_TTL_MINUTES} 分钟内有效。`
  + `确认无误后调用 \`erp_commit_document\`（action_id=${actionId}）才会真正写入。`;

/** PendingActionError 的可读化：把「为什么提交不了」和「接下来怎么办」讲清楚 */
const explainPendingError = (error: PendingActionError, actionId: number): string => {
  switch (error.code) {
    case "expired":
      return `草稿已过期（超过 ${PENDING_ACTION_TTL_MINUTES} 分钟），请重新调用建单/动作工具生成新草稿。（action_id=${actionId}）`;
    case "already_handled":
      return `草稿 ${actionId} 已经执行过，不能重复提交（这正是不会重复过账的保证）。请用 erp_query_documents 看最新状态。`;
    case "forbidden":
      return `草稿 ${actionId} 不属于当前身份，已拒绝执行。${error.message}`;
    default:
      return `${error.message}（action_id=${actionId}）`;
  }
};

const locatedOrThrow = (
  located: { document?: LocatedDocument; error?: string },
): LocatedDocument => {
  if (located.error || !located.document) {
    throw new Error(located.error || "没有定位到单据。");
  }
  return located.document;
};

export function registerDocumentTools(server: McpServer, identity: TenantContext): void {
  const userId = identity.userId;
  if (typeof userId !== "number") {
    // 身份解析不出 sys_users.id 时直接拒绝注册：单据写入必须能落到具体的人
    throw new McpAuthError("单据工具需要明确的用户身份（sys_users.id），当前上下文缺少 userId。");
  }
  const tenantId = identity.tenantId;
  /** 本 MCP 进程的会话标识：草稿按会话留痕，便于事后审计 */
  const sessionId = `mcp-${userId}-${Date.now()}`;

  /* ---------------------------------------------------------------- *
   * 1. 查询单据（只读）
   * ---------------------------------------------------------------- */

  server.registerTool(
    "erp_query_documents",
    {
      title: "查询单据",
      description:
        "查询单个单据的单头与明细（给出 document_no），或按类型列出最近单据（只给 document_type）。"
        + "只读，可用它拿到单号/状态，再交给 erp_document_action 做过账等动作。",
      inputSchema: {
        document_no: z
          .string()
          .optional()
          .describe("单据号（如 SO20260005、PR20260004）。填写后返回该单据的单头与明细"),
        document_type: z
          .string()
          .optional()
          .describe(
            `限定单据类型，可用类型键（sales_order）或中文名。可选类型：${documentTypeLabels()}`,
          ),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ document_no, document_type }) =>
      runDocTool("erp_query_documents", async () => {
        const meta = document_type ? resolveDocumentTypeRef(document_type) : null;
        if (document_type && !meta) {
          throw new Error(
            `未识别的单据类型「${document_type}」。可用类型：${documentTypeLabels()}。`,
          );
        }

        // 焦点（type + id）优先于文本单号：给出单号时先定位，定位不到就明确报错，
        // 而不是回退成「最近单据」列表让调用方误以为查到了。
        let focus: { type: string; id?: number } | undefined = meta ? { type: meta.type } : undefined;
        const no = document_no?.trim();
        if (no) {
          const found = await findDocumentByNo(no.toUpperCase(), tenantId);
          if (!found) {
            throw new Error(
              `没有找到单号「${no}」对应的单据（可能不属于当前租户、已删除，或单号有误）。`,
            );
          }
          if (meta && found.type !== meta.type) {
            throw new Error(`单号「${no}」实际是${found.label}，与指定的${meta.label}不一致。`);
          }
          focus = { type: found.type, id: found.id };
        }

        const state = buildState(identity, { text: no || "", currentFocus: focus, intent: "analysis" });
        const result = await queryDocumentTool(state);
        return renderToolResult(result);
      }),
  );

  /* ---------------------------------------------------------------- *
   * 2. 建单草稿
   * ---------------------------------------------------------------- */

  server.registerTool(
    "erp_create_document",
    {
      title: "新建单据（生成草稿）",
      description:
        "按结构化字段生成一张单据草稿，**不写业务表**，返回 action_id 与草稿预览。"
        + "确认无误后调用 erp_commit_document(action_id) 才真正建单（状态为草稿 draft）。"
        + `可建单的类型：${documentTypeLabels(true)}。客户/供应商/物料/仓库请填中文名称，服务端解析成 id。`,
      inputSchema: {
        document_type: z
          .string()
          .min(1)
          .describe("单据类型：类型键（sales_order / purchase_receipt …）或中文名（销售订单 / 采购入库单）"),
        party_name: z
          .string()
          .optional()
          .describe("往来单位名称：销售类填客户、采购类填供应商（这两类单据必填）"),
        date: z.string().optional().describe("单据日期，YYYY-MM-DD；不填由服务端补当天"),
        warehouse_name: z.string().optional().describe("仓库名称，服务端解析成 id"),
        remark: z.string().optional().describe("单头备注"),
        lines: z
          .array(
            z.object({
              product_name: z.string().min(1).describe("物料名称，服务端解析成物料 id"),
              quantity: z.number().describe("数量"),
              unit_price: z.number().optional().describe("单价"),
              unit_cost: z.number().optional().describe("单位成本（入库 / 领料类使用）"),
              tax_rate: z.number().optional().describe("税率，小数形式（0.13 表示 13%）"),
              batch_no: z.string().optional().describe("批号"),
              remark: z.string().optional().describe("行备注"),
            }),
          )
          .min(1)
          .describe("明细行，至少一行"),
      },
      annotations: WRITE_DRAFT_ANNOTATIONS,
    },
    async ({ document_type, party_name, date, warehouse_name, remark, lines }) =>
      runDocTool("erp_create_document", async () => {
        const meta = resolveDocumentTypeRef(document_type);
        if (!meta) {
          throw new Error(
            `未识别的单据类型「${document_type}」。可建单的类型：${documentTypeLabels(true)}。`,
          );
        }
        if (!meta.creatable) {
          throw new Error(
            `${meta.label}不支持直接建单（这类单据一般由转单生成或前端录入）。`
            + "可以改用 erp_document_action 对已有单据做过账等动作。",
          );
        }

        // 组装成与对话链路同一个中间形态，复用同一份「名称 → id + 校验」实现
        const raw = {
          party_name: party_name?.trim() || undefined,
          warehouse_name: warehouse_name?.trim() || undefined,
          header: {
            [meta.dateField]: date?.trim() || undefined,
            remark: remark?.trim() || undefined,
          },
          lines: lines.map((line) => ({
            product_name: line.product_name,
            quantity: line.quantity,
            unit_price: line.unit_price,
            unit_cost: line.unit_cost,
            tax_rate: line.tax_rate,
            batch_no: line.batch_no,
            remark: line.remark,
          })),
        };

        const state = buildState(identity, { text: document_type, intent: "create" });
        const resolved = await prepareDocumentInput(state, meta, raw);
        if (resolved.error || !resolved.prepared) {
          throw new Error(resolved.error || "单据信息不完整，无法生成草稿。");
        }
        const { header, lines: preparedLines, fieldLines } = resolved.prepared;

        const actionId = await createPendingAction({
          sessionId,
          userId,
          tenantId,
          actionType: "document.create",
          entityKey: meta.type,
          tableName: meta.headerTable,
          payload: { documentType: meta.type, header, lines: preparedLines },
          context: {
            action: "create",
            kind: "document",
            documentType: meta.type,
            label: meta.label,
            tableTag: baseTableName(meta.headerTable),
            display: `${meta.label}（${preparedLines.length} 行）`,
            fieldLines,
            route: meta.route,
            routeLabel: meta.routeLabel,
          },
        });

        return [
          `已生成**${meta.label}**草稿（尚未写入数据库）。`,
          "",
          ...fieldLines.map((note) => `- ${note}`),
          "",
          renderLineRows(preparedLines),
          "",
          commitHint(actionId),
          "",
          jsonBlock({
            action_id: actionId,
            draft: true,
            document_type: meta.type,
            label: meta.label,
            header,
            lines: preparedLines,
            expires_in_minutes: PENDING_ACTION_TTL_MINUTES,
          }),
        ]
          .filter((part) => part !== "")
          .join("\n");
      }),
  );

  /* ---------------------------------------------------------------- *
   * 3. 单据动作草稿（过账 / 反过账 / 审批 / 转单）
   * ---------------------------------------------------------------- */

  const DOCUMENT_ACTIONS = [
    "post",
    "reverse",
    "submit",
    "approve",
    "reject",
    "withdraw",
    "convert",
  ] as const;

  server.registerTool(
    "erp_document_action",
    {
      title: "单据动作（生成草稿）",
      description:
        "对已有单据发起动作：post 过账 / reverse 反过账 / submit 提交审批 / approve 审批通过 / "
        + "reject 驳回 / withdraw 撤回审批 / convert 转单。**不写业务表**，返回 action_id 与确认说明，"
        + "确认后调用 erp_commit_document(action_id) 才真正执行。"
        + "过账要求单据处于允许的状态（服务端会校验并给出可读原因），例如采购入库单需先 approved。",
      inputSchema: {
        action: z.enum(DOCUMENT_ACTIONS).describe("要执行的动作"),
        document_no: z
          .string()
          .optional()
          .describe("目标单据号（如 SO20260005）。与 document_id 二选一，优先用它定位"),
        document_id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("目标单据主键 id，使用时必须同时给出 document_type"),
        document_type: z
          .string()
          .optional()
          .describe(
            `单据类型（类型键或中文名）。用 document_id 定位时必填；用它可校验单号是否与类型一致。可选类型：${documentTypeLabels()}`,
          ),
        comment: z.string().optional().describe("动作说明/原因，写入审计（反过账时可作为反过账原因）"),
        rule_code: z
          .string()
          .optional()
          .describe("转单规则编号，仅 convert 使用；不填则按单据类型的默认流转规则"),
      },
      annotations: WRITE_DRAFT_ANNOTATIONS,
    },
    async ({ action, document_no, document_id, document_type, comment, rule_code }) =>
      runDocTool("erp_document_action", async () => {
        const meta = document_type ? resolveDocumentTypeRef(document_type) : null;
        if (document_type && !meta) {
          throw new Error(
            `未识别的单据类型「${document_type}」。可用类型：${documentTypeLabels()}。`,
          );
        }

        let located: { document?: LocatedDocument; error?: string };
        if (document_id) {
          if (!meta) {
            throw new Error("按 document_id 定位单据时必须同时给出 document_type。");
          }
          located = await locateDocumentById(meta, document_id, tenantId);
        } else if (document_no?.trim()) {
          const found = await findDocumentByNo(document_no.trim().toUpperCase(), tenantId);
          if (found && meta && found.type !== meta.type) {
            located = {
              error: `单号「${document_no}」实际是${found.label}，与指定的${meta.label}不一致。`,
            };
          } else {
            located = found
              ? { document: found }
              : {
                  error: `没有找到单号「${document_no}」对应的单据（可能不属于当前租户、已删除，或单号有误）。`,
                };
          }
        } else {
          throw new Error(
            "请用 document_no（单据号）或 document_id + document_type 指定要操作的单据。",
          );
        }

        const doc = locatedOrThrow(located);

        // 状态前置校验：与对话链路共用同一份规则（services/documentService）
        const invalid = validateDocumentAction(doc, action as DocumentActionName);
        if (invalid) throw new Error(invalid);

        const rule = action === "convert" ? FLOW_RULES[doc.meta.type] : undefined;
        const ruleCode = action === "convert" ? rule_code?.trim() || rule?.ruleCode : undefined;
        if (action === "convert" && !ruleCode) {
          throw new Error("缺少转单规则，无法生成转单草稿。");
        }

        const display = action === "convert" ? `${doc.no} → ${rule?.label ?? "下游单据"}` : doc.no;
        const actionId = await createPendingAction({
          sessionId,
          userId,
          tenantId,
          actionType: "document.action",
          entityKey: doc.meta.type,
          tableName: doc.meta.headerTable,
          payload: {
            documentType: doc.meta.type,
            documentId: doc.id,
            action,
            ruleCode,
            comment: comment?.trim() || undefined,
          },
          existingId: doc.id,
          context: {
            action,
            kind: "document",
            documentType: doc.meta.type,
            label: doc.meta.label,
            tableTag: baseTableName(doc.meta.headerTable),
            display,
            route: doc.meta.route,
            routeLabel: doc.meta.routeLabel,
          },
        });

        return [
          `将对${doc.meta.label} **${display}** 执行「${actionLabel(action)}」（尚未执行）。`,
          "",
          `- 当前状态：${statusLabel(doc.status)}`,
          ...(action === "convert" && rule ? [`- 转单规则：${rule.ruleCode}（生成${rule.label}）`] : []),
          ...(comment?.trim() ? [`- 说明：${comment.trim()}`] : []),
          "",
          commitHint(actionId),
          "",
          jsonBlock({
            action_id: actionId,
            draft: true,
            document_type: doc.meta.type,
            document_id: doc.id,
            document_no: doc.no,
            current_status: doc.status,
            action,
            rule_code: ruleCode ?? null,
            expires_in_minutes: PENDING_ACTION_TTL_MINUTES,
          }),
        ]
          .filter((part) => part !== "")
          .join("\n");
      }),
  );

  /* ---------------------------------------------------------------- *
   * 4. 提交草稿（真正写库）
   * ---------------------------------------------------------------- */

  server.registerTool(
    "erp_commit_document",
    {
      title: "提交单据草稿（写入数据库）",
      description:
        "按 action_id 执行 erp_create_document / erp_document_action 生成的草稿，**这一步才真正写库**"
        + "（建单、过账、反过账、审批、转单）。草稿 30 分钟内有效、只能执行一次；"
        + "重复提交会被拒绝而不是把单据处理两次。",
      inputSchema: {
        action_id: z
          .number()
          .int()
          .positive()
          .describe("建单 / 动作工具返回的草稿编号"),
      },
      annotations: DESTRUCTIVE_ANNOTATIONS,
    },
    async ({ action_id }) =>
      runDocTool("erp_commit_document", async () => {
        let outcome;
        try {
          outcome = await executePendingAction(action_id, { userId, tenantId });
        } catch (error) {
          if (error instanceof PendingActionError) {
            throw new Error(explainPendingError(error, action_id));
          }
          throw error;
        }

        return [
          outcome.reply,
          "",
          jsonBlock({
            action_id,
            executed: true,
            route: outcome.route ?? null,
            focus: outcome.focus ?? null,
            output: outcome.output ?? null,
          }),
        ].join("\n");
      }),
  );
}

/** 供 server.ts 打印启动日志用（避免两处各写一份工具名清单） */
export const DOCUMENT_TOOL_NAMES = [
  "erp_query_documents",
  "erp_create_document",
  "erp_document_action",
  "erp_commit_document",
] as const;
