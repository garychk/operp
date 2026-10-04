import type { AiGraphState } from "../ai/state.js";
import type { TenantContext } from "../config/tenantContext.js";
import { resolveDefaultProvider, type AiProviderConfig } from "../services/aiProvider.js";
import {
  baseTableName,
  buildEntityDef,
  loadEntityCatalog,
  resolveEntityForState,
  type EntityDef,
} from "../tools/entityRegistry.js";

/**
 * MCP ↔ 现有工具层的适配。
 *
 * 现有工具（erpTools / entityRegistry）的入参是 AiGraphState —— 一个面向「多轮对话」的状态包，
 * 而不是面向调用的结构化参数。MCP 客户端给的是确定的字段，所以这一层的职责就是：
 * 把确定的结构化入参，组装成工具期望的 state，再把工具输出规整成 MCP content。
 *
 * 这一层不复制任何业务逻辑，只做形状转换，保证 MCP 与前端对话走的是同一套实现。
 */

/** 组装工具所需的对话状态。MCP 侧没有多轮记忆，recentMessages 恒为空。 */
export function buildState(
  identity: TenantContext,
  input: {
    text: string;
    sessionId?: string;
    target?: string;
    queryMode?: AiGraphState["queryMode"];
    responseMode?: AiGraphState["responseMode"];
    currentFocus?: unknown;
    provider?: AiProviderConfig;
    intent?: AiGraphState["intent"];
    skill?: AiGraphState["skill"];
  },
): AiGraphState {
  return {
    sessionId: input.sessionId || `mcp-${identity.userId ?? "anon"}-${Date.now()}`,
    userId: identity.userId,
    tenantId: identity.tenantId,
    text: input.text,
    skill: input.skill || "auto",
    intent: input.intent,
    provider: input.provider,
    currentFocus: input.currentFocus,
    recentMessages: [],
    target: input.target,
    queryMode: input.queryMode,
    responseMode: input.responseMode,
  };
}

const normalizeRef = (value: string) => value.trim().toLowerCase();

/**
 * 按「表名 / 中文名」定位业务对象。
 *
 * 与对话链路不同，MCP 调用方给的是确定的引用（例如 erp_customers 或「客户」），
 * 因此这里优先做精确匹配，只有在都落空时才退回关键词模糊匹配，避免误命中别的表。
 */
export async function resolveEntityByRef(ref: string): Promise<EntityDef | null> {
  const wanted = normalizeRef(ref);
  if (!wanted) return null;

  const tables = await loadEntityCatalog();
  if (!tables.length) return null;

  const byPhysicalTable =
    tables.find((item) => normalizeRef(item.table) === wanted) ||
    tables.find((item) => normalizeRef(baseTableName(item.table)) === wanted);
  if (byPhysicalTable) return buildEntityDef(byPhysicalTable);

  const byLabel =
    tables.find((item) => normalizeRef(item.label) === wanted) ||
    tables.find((item) => normalizeRef(baseTableName(item.table)) === `erp_${wanted}`);
  if (byLabel) return buildEntityDef(byLabel);

  // 包含匹配放在最后，且只取第一个：宁可让调用方补充更精确的引用，也不要猜错表
  const byContains = tables.find((item) => normalizeRef(item.label).includes(wanted));
  if (byContains) return buildEntityDef(byContains);

  // 兜底：复用 AI 链路已有的关键词匹配策略
  const resolution = await resolveEntityForState({
    sessionId: "mcp-entity-resolve",
    text: ref,
    skill: "auto",
    recentMessages: [],
  }).catch(() => ({ def: undefined }));

  return resolution.def ?? null;
}

const providerCache = new Map<number, { at: number; value: AiProviderConfig }>();
const PROVIDER_TTL_MS = 60 * 1000;

/** 取该租户可用的模型配置。带短缓存，避免每次调用都查 sys_config。 */
export async function resolveToolProvider(tenantId: number): Promise<AiProviderConfig> {
  const cached = providerCache.get(tenantId);
  if (cached && Date.now() - cached.at < PROVIDER_TTL_MS) return cached.value;

  const value = await resolveDefaultProvider(tenantId);
  providerCache.set(tenantId, { at: Date.now(), value });
  return value;
}

export function clearProviderCache() {
  providerCache.clear();
}

interface ToolLikeResult {
  status: string;
  reply: string;
  data?: unknown;
  nextQuestions?: string[];
}

/** 把工具结果渲染成一段给模型读的文本：先人话，再附结构化数据。 */
export function renderToolResult(result: ToolLikeResult): string {
  const parts = [result.reply];

  if (result.data !== undefined) {
    try {
      parts.push(`\n\`\`\`json\n${JSON.stringify(result.data, null, 2)}\n\`\`\``);
    } catch {
      // 忽略无法序列化的 data，正文仍然可用
    }
  }

  if (result.nextQuestions?.length) {
    parts.push(`\n可选的下一步：${result.nextQuestions.join("、")}`);
  }

  return parts.filter(Boolean).join("\n");
}
