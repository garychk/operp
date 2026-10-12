import { z } from "zod";
import { supabase } from "../config/supabase.js";

/**
 * AI provider 配置解析。
 *
 * 原实现内联在 api/ai.routes.ts 里。MCP 链路同样需要「租户私有优先、回退平台基线」
 * 的配置读取逻辑，因此抽到 services 层由 HTTP 与 MCP 共用，避免两处解析规则分叉。
 */

export const providerSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  endpoint: z.string().optional(),
  model: z.string().optional(),
  apiType: z.enum(["proxy", "ollama"]).optional(),
  apiKey: z.string().optional(),
  temperature: z.number().optional(),
});

export const aiSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  providers: z.array(providerSchema).default([]),
  activeProviderId: z.string().optional(),
  /**
   * 知识库向量化专用模型。为空 = 按模型特征自动识别。
   *
   * 必须显式声明在 zod schema 里：zod 默认 strip 未知键，
   * 漏掉这一行会让前端存的 embeddingProviderId 在 parse 后被静默丢弃。
   */
  embeddingProviderId: z.string().optional(),
  temperature: z.number().optional(),
  redactSensitiveData: z.boolean().optional(),
  maxContextMessages: z.number().optional(),
});

export type AiProviderConfig = z.infer<typeof providerSchema>;
export type AiSettings = z.infer<typeof aiSettingsSchema>;

/**
 * embedding 模型名特征。
 *
 * 覆盖常见开源 / 商用 embedding 模型命名：nomic-embed-text、bge-*、gte-*、e5-*、
 * mxbai-embed-*、text-embedding-*。故意**不**包含「apiType === 'ollama'」这类笼统
 * 判据 —— 那样会把纯对话的 ollama 模型（如 qwen2.5）误判成向量模型，选中后调用
 * `/api/embed` 才报 model not found，报错点被推到很远的地方。
 */
export const EMBEDDING_MODEL_PATTERN =
  /(embed|embedding|nomic-embed|bge-|mxbai-embed|text-embedding|gte-|e5-)/i;

/**
 * 判断一个 provider 是否可用于知识库向量化。
 *
 * **全项目唯一实现**：knowledgeBase 的索引链路与 aiProvider 的配置解析都走这里，
 * 避免「选 provider 用一套规则、校验 provider 用另一套规则」导致选中即失败。
 */
export const isEmbeddingCapableProvider = (
  provider?: AiProviderConfig | null,
): boolean => {
  if (!provider?.endpoint) return false;
  const endpoint = String(provider.endpoint).toLowerCase();
  const model = String(provider.model || "");
  return (
    endpoint.includes("/embeddings") ||
    endpoint.endsWith("/embed") ||
    endpoint.includes("/embed/") ||
    EMBEDDING_MODEL_PATTERN.test(model)
  );
};

/** 从 sys_config 读租户的 AI 配置（私有优先、回退基线） */
export async function loadAiSettings(tenantId?: number | null): Promise<AiSettings> {
  const { data, error } = await supabase.rpc("get_tenant_config", {
    p_category_code: "ai",
    p_tenant_id: tenantId ?? null,
  });

  if (error) throw error;

  return aiSettingsSchema.parse(data || {});
}

export async function resolveProviderConfig(
  provider?: { id?: string; name?: string },
  tenantId?: number | null,
): Promise<AiProviderConfig> {
  // sys_config 里同一 category_code 可能同时有平台基线行和租户私有行，
  // 直接查表会拿到多行。RPC 内部「私有优先、回退基线」并接受显式 tenant_id。
  const settings = await loadAiSettings(tenantId);

  const matched = settings.providers.find((item) => {
    if (!provider?.id) return false;
    if (item.id === provider.id) return true;
    if (provider.name && item.name === provider.name) return true;
    return false;
  });

  if (!matched) {
    throw new Error(`未找到对应的 AI provider：${provider?.id || provider?.name || "unknown"}`);
  }

  return matched;
}

/**
 * 取一个可直接使用的默认 provider。
 *
 * MCP 客户端没有 UI 上的「模型选择」上下文，不传 provider id，
 * 因此按 activeProviderId 优先、否则取第一个配置了 endpoint 的 provider。
 */
export async function resolveDefaultProvider(
  tenantId?: number | null,
): Promise<AiProviderConfig> {
  const settings = await loadAiSettings(tenantId);
  const usable = settings.providers.filter((item) => Boolean(item.endpoint));

  if (!usable.length) {
    throw new Error(
      "当前租户未配置可用的 AI provider（sys_config 的 ai.providers 为空或缺 endpoint），无法执行需要大模型的工具。",
    );
  }

  const preferred = settings.activeProviderId
    ? usable.find((item) => item.id === settings.activeProviderId)
    : undefined;

  return preferred || usable[0];
}

/**
 * 取用于知识库向量化的 embedding provider。
 *
 * 优先级（自上而下）：
 *  1. 调用方显式指定的 provider（MCP 客户端 / 工具入参）；
 *  2. AI 设置里的 `embeddingProviderId`（前端「向量模型」下拉，用户在界面上明确选的那个）；
 *  3. 按 `isEmbeddingCapableProvider` 从 providers 里自动挑第一个。
 *
 * 刻意**不再**按 `id === 'ollama'` 硬编码优先：默认配置里恰好有一条 id 为 `ollama`
 * 的纯对话模型（qwen2.5），强选它会让导入后的自动索引必然失败。
 */
export async function resolveEmbeddingProviderConfig(
  provider?: { id?: string; name?: string },
  tenantId?: number | null,
): Promise<AiProviderConfig> {
  const settings = await loadAiSettings(tenantId);
  const usable = settings.providers.filter((item) => Boolean(item.endpoint));

  if (!usable.length) {
    throw new Error(
      "当前租户未配置可用的 AI provider。请到「系统设置 → AI 设置」里至少添加一条带接口地址的模型。",
    );
  }

  // 1) 调用方显式指定
  if (provider?.id || provider?.name) {
    const matched = usable.find(
      (item) =>
        (provider.id && item.id === provider.id) ||
        (provider.name && item.name === provider.name),
    );
    if (matched) return matched;
  }

  // 2) 界面上明确选定的向量模型
  const explicitId = settings.embeddingProviderId?.trim();
  if (explicitId) {
    const explicit = usable.find((item) => item.id === explicitId);
    if (!explicit) {
      throw new Error(
        `AI 设置里选定的向量模型（id=${explicitId}）不存在或未填接口地址，请到「系统设置 → AI 设置 → 向量模型」重新选择。`,
      );
    }
    // 用户显式指定即视为权威：即使模型名不含 embed 特征也照用，只做一次提醒。
    return explicit;
  }

  // 3) 按特征自动识别
  const candidates = usable.filter(isEmbeddingCapableProvider);
  if (!candidates.length) {
    throw new Error(
      "未找到可用于知识库向量化的模型。请到「系统设置 → AI 设置 → 向量模型」选一个 768 维的 embedding 模型" +
        "（例如 Ollama 的 nomic-embed-text：接口类型选 Ollama，接口地址填 http://localhost:11434/api/chat，模型 ID 填 nomic-embed-text）。",
    );
  }

  return candidates[0];
}
