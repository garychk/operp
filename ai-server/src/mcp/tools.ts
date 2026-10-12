import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { supabase } from "../config/supabase.js";
import type { TenantContext } from "../config/tenantContext.js";
import { searchKnowledgeRag } from "../services/knowledgeBase.js";
import { businessAnalysisTool, financeSummaryTool, hasColumn, isTenantScopedTable } from "../tools/erpTools.js";
import { buildEntityDef, evaluateWritePolicy, loadEntityCatalog } from "../tools/entityRegistry.js";
import { buildState, renderToolResult, resolveEntityByRef, resolveToolProvider } from "./adapters.js";
import {
  READ_ONLY_ANNOTATIONS,
  runTool as runMcpTool,
} from "./toolContract.js";

/**
 * MCP 只读工具集。
 *
 * 边界刻意收得很紧：
 *  - 只暴露查询 / 统计 / 分析 / 知识库检索，不暴露 entity.create / entity.update / baq.upsert。
 *  - 不提供任何删除能力（沿用 evaluateDeletePolicy 的结论：AI 侧一律不给删除）。
 *  - 每个工具都标 readOnlyHint，让客户端可以做二次确认提示。
 *
 * 写入能力不在这里 —— 单据的建单 / 过账等放在 documentTools.ts，
 * 且一律走「草稿 → 提交」两段式，不提供一次调用直接落库的入口。
 *
 * 业务实现全部复用 erpTools / entityRegistry，这里只负责把入参和结果在两种形状间转换。
 */

/**
 * 大模型相关的报错，光把原始信息抛回去基本没法排查。
 *
 * 最常见的两种是：租户 AI 配置里的 model 名在模型服务上不存在（本地换了 Ollama 模型后极易发生），
 * 以及知识库检索缺 embedding provider。这里补上可执行的排查路径。
 */
const MODEL_ERROR_HINTS: Array<{ pattern: RegExp; render: (message: string) => string }> = [
  {
    pattern: /LLM request failed|No model endpoint configured/i,
    render: (message) =>
      `大模型调用失败：${message}\n\n`
      + "请检查租户的 AI 配置（sys_config 中 category_code='ai' 那一行的 config_json.providers）：\n"
      + "- endpoint：模型服务地址是否可从本机访问\n"
      + "- model：是否是该服务上真实存在的模型名（例如 Ollama 用 ollama list 核对）\n"
      + "- activeProviderId：是否指向了可用的那个 provider\n\n"
      + "不依赖大模型的工具仍可正常使用：erp_list_entities、erp_describe_entity、"
      + "erp_count_records、erp_finance_summary。",
  },
  {
    pattern: /embedding|Embedding/i,
    render: (message) =>
      `向量化模型调用失败：${message}\n\n`
      + "知识库检索需要一个 embedding 模型，请在 AI 配置里补一个 apiType=ollama、"
      + "或模型名含 embed 的 provider。",
  },
];

const explainModelError = (message: string): string => {
  const matched = MODEL_ERROR_HINTS.find((item) => item.pattern.test(message));
  return matched ? matched.render(message) : `工具执行失败：${message}`;
};

/** 只读工具的兜底：额外把「大模型/向量模型配置」类报错渲染成可执行的排查路径 */
const runTool = (label: string, fn: () => Promise<string>) =>
  runMcpTool(label, fn, explainModelError);

export function registerReadOnlyTools(server: McpServer, identity: TenantContext): void {
  /* ---------------------------------------------------------------- *
   * 1. 对象目录
   * ---------------------------------------------------------------- */

  server.registerTool(
    "erp_list_entities",
    {
      title: "列出 ERP 业务对象",
      description:
        "列出当前租户可访问的业务对象，包含物理表名、中文名称、所属模块、字段数量以及是否允许写入。"
        + "在调用其它工具前用它确认对象的准确名称。",
      inputSchema: {
        keyword: z.string().optional().describe("按表名或中文名过滤，不区分大小写的部分匹配"),
        module: z.string().optional().describe("按模块过滤，ERP 业务表通常是 erp"),
        writable_only: z.boolean().optional().describe("为 true 时只返回允许写入的对象"),
        limit: z.number().int().positive().max(500).optional().describe("最多返回条数，默认 200"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ keyword, module, writable_only, limit }) =>
      runTool("erp_list_entities", async () => {
        const tables = await loadEntityCatalog();
        if (!tables.length) {
          throw new Error(
            "未能加载业务表目录，请确认 sys_tables 已初始化（执行 refresh_sys_tables()）。",
          );
        }

        // 名称与权限统一走 buildEntityDef：中文名只在 CURATED 里，且 sys_tables.table_label
        // 常为空。直接用目录里的 label，列表会退化成一堆带 _s_539dcf81_b 后缀的物理表名。
        const enriched = tables.map((table) => {
          const def = buildEntityDef(table);
          return {
            table: table.table,
            label: def.label,
            module: table.module,
            writable: def.writable,
            columnCount: table.columns.length,
          };
        });

        const wanted = keyword?.trim().toLowerCase();
        const filtered = enriched.filter((item) => {
          if (module && item.module !== module) return false;
          if (writable_only && !item.writable) return false;
          if (!wanted) return true;
          return (
            item.table.toLowerCase().includes(wanted) ||
            item.label.toLowerCase().includes(wanted)
          );
        });

        const max = limit ?? 200;
        const shown = filtered.slice(0, max);

        const rows = shown.map(
          (item) =>
            `| ${item.table} | ${item.label} | ${item.module} | ${
              item.writable ? "可写" : "只读"
            } | ${item.columnCount} |`,
        );

        return [
          `共 ${filtered.length} 个业务对象${
            filtered.length > shown.length ? `，已显示前 ${shown.length} 个` : ""
          }。`,
          "",
          "| 表名 | 名称 | 模块 | 权限 | 字段数 |",
          "| --- | --- | --- | --- | ---: |",
          ...rows,
        ].join("\n");
      }),
  );

  /* ---------------------------------------------------------------- *
   * 2. 对象结构
   * ---------------------------------------------------------------- */

  server.registerTool(
    "erp_describe_entity",
    {
      title: "查询业务对象字段结构",
      description:
        "查看某个业务对象的字段清单：字段名、数据类型、是否可空、是否有默认值、外键关联与中文注释，"
        + "并给出新增该对象时的必填字段。适合在写查询或分析前了解表结构。",
      inputSchema: {
        entity: z
          .string()
          .min(1)
          .describe("对象引用，可用物理表名（erp_customers）或中文名（客户）"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ entity }) =>
      runTool("erp_describe_entity", async () => {
        const def = await resolveEntityByRef(entity);
        if (!def) {
          return `未找到业务对象「${entity}」。请先用 erp_list_entities 查看可用对象，再传入准确的表名或中文名。`;
        }

        const policy = evaluateWritePolicy(def.tableName, def.module);
        const columns = def.columns.map(
          (column) =>
            `| ${column.name} | ${column.dataType} | ${column.isNullable ? "是" : "否"} | ${
              column.hasDefault ? "是" : "否"
            } | ${
              column.refTable ? `${column.refTable}.${column.refColumn || "id"}` : ""
            } | ${column.note || ""} |`,
        );

        const requiredList = def.requiredFields.length
          ? def.requiredFields.map((field) => `- ${field.key}：${field.label}`).join("\n")
          : "（无显式必填字段）";

        return [
          `# ${def.label}（${def.tableName}）`,
          "",
          `- 模块：${def.module}`,
          `- 权限：${policy.writable ? "可写" : `只读（${policy.reason || "策略限制"}）`}`,
          `- 编码字段：${def.codeField}　名称字段：${def.nameField}`,
          `- 字段总数：${def.columns.length}`,
          "",
          "## 字段清单",
          "",
          "| 字段 | 类型 | 可空 | 有默认值 | 外键 | 注释 |",
          "| --- | --- | --- | --- | --- | --- |",
          ...columns,
          "",
          "## 必填字段",
          "",
          requiredList,
        ].join("\n");
      }),
  );

  /* ---------------------------------------------------------------- *
   * 3. 记录数统计
   * ---------------------------------------------------------------- */

  server.registerTool(
    "erp_count_records",
    {
      title: "统计业务对象记录数",
      description: "统计某个业务对象在当前租户下的记录条数，自动排除已软删除的数据。",
      inputSchema: {
        entity: z
          .string()
          .min(1)
          .describe("对象引用，可用物理表名（erp_customers）或中文名（客户）"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ entity }) =>
      runTool("erp_count_records", async () => {
        const def = await resolveEntityByRef(entity);
        if (!def) {
          return `未找到业务对象「${entity}」。请先用 erp_list_entities 查看可用对象。`;
        }

        let query = supabase
          .from(def.tableName)
          .select("*", { count: "exact", head: true });

        if (hasColumn(def, "is_deleted")) query = query.eq("is_deleted", "n");
        // 凡是 erp_ 前缀的表都必须带租户过滤：service_role 绕过 RLS，这里是唯一隔离点
        if (isTenantScopedTable(def.tableName)) {
          query = query.eq("tenant_id", identity.tenantId);
        }

        const { count, error } = await query;
        if (error) throw error;

        return [
          `${def.label}（${def.tableName}）当前共有 ${count ?? 0} 条记录。`,
          "",
          "```json",
          JSON.stringify(
            { entity: def.key, label: def.label, table: def.tableName, count: count ?? 0 },
            null,
            2,
          ),
          "```",
        ].join("\n");
      }),
  );

  /* ---------------------------------------------------------------- *
   * 4. 财务摘要
   * ---------------------------------------------------------------- */

  server.registerTool(
    "erp_finance_summary",
    {
      title: "财务总览",
      description:
        "汇总当前租户的财务情况：应收 / 应付单据数量与余额、逾期账款金额、凭证数量与金额、固定资产净值，"
        + "并给出应收应付 Top5。用于回答「财务情况如何」「有没有逾期风险」这类问题。",
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () =>
      runTool("erp_finance_summary", async () => {
        const result = await financeSummaryTool(
          buildState(identity, { text: "财务分析", intent: "analysis" }),
        );
        return renderToolResult(result);
      }),
  );

  /* ---------------------------------------------------------------- *
   * 5. 业务分析
   * ---------------------------------------------------------------- */

  const QUERY_MODES = [
    "count",
    "list",
    "summary",
    "detail",
    "trend",
    "compare",
    "exception",
    "answer",
  ] as const;

  server.registerTool(
    "erp_business_analysis",
    {
      title: "自然语言业务分析",
      description:
        "用一句中文描述分析需求，服务端会结合业务数据目录生成一条只读 SQL 并执行，返回结果表格。"
        + "适合「上个月采购金额最高的 5 个供应商是谁」这类需要聚合或关联的查询。"
        + "服务端会强制校验 SQL 为只读、且每张业务表都带租户过滤，不可用于写操作。",
      inputSchema: {
        question: z.string().min(1).describe("中文分析需求，一句话描述要查什么"),
        target: z.string().optional().describe("可选：限定分析对象，例如 erp_purchase_orders"),
        query_mode: z
          .enum(QUERY_MODES)
          .optional()
          .describe("可选：结果形态，count 计数 / list 明细 / trend 趋势 / compare 对比 / exception 异常"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ question, target, query_mode }) =>
      runTool("erp_business_analysis", async () => {
        const provider = await resolveToolProvider(identity.tenantId);

        const result = await businessAnalysisTool(
          buildState(identity, {
            text: question,
            target,
            queryMode: query_mode,
            provider,
            intent: "analysis",
          }),
        );

        return renderToolResult(result);
      }),
  );

  /* ---------------------------------------------------------------- *
   * 6. 知识库检索
   * ---------------------------------------------------------------- */

  server.registerTool(
    "erp_search_knowledge",
    {
      title: "检索 ERP 知识库",
      description:
        "在 ERP 知识库中做语义检索，返回相关制度、流程或操作说明片段。"
        + "用于回答「这个流程怎么走」「某功能怎么用」这类靠文档而非业务数据回答的问题。",
      inputSchema: {
        query: z.string().min(1).describe("检索问题或关键词"),
        limit: z.number().int().min(1).max(20).optional().describe("返回条数，默认 8"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ query, limit }) =>
      runTool("erp_search_knowledge", async () => {
        const docs = await searchKnowledgeRag(
          query,
          undefined,
          limit ?? 8,
          identity.tenantId,
        ).catch(() => []);

        if (!docs.length) {
          return `知识库中未检索到与「${query}」相关的内容。可以换更具体的关键词，或改用 erp_business_analysis 直接查业务数据。`;
        }

        const body = docs
          .map((doc, index) => {
            const similarity =
              typeof doc.similarity === "number" ? doc.similarity.toFixed(3) : "n/a";
            return [
              `## ${index + 1}. ${doc.title}`,
              `相似度：${similarity}${doc.category ? `　分类：${doc.category}` : ""}`,
              "",
              String(doc.content).slice(0, 800),
            ].join("\n");
          })
          .join("\n\n");

        return [`共检索到 ${docs.length} 条相关内容。`, "", body].join("\n");
      }),
  );
}
