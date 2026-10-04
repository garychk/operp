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
  temperature: z.number().optional(),
  redactSensitiveData: z.boolean().optional(),
  maxContextMessages: z.number().optional(),
});

export type AiProviderConfig = z.infer<typeof providerSchema>;
export type AiSettings = z.infer<typeof aiSettingsSchema>;

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
 * 优先显式指定；否则在 providers 里挑 ollama、模型名含 embed、或地址含 embeddings 的那个。
 */
export async function resolveEmbeddingProviderConfig(
  provider?: { id?: string; name?: string },
  tenantId?: number | null,
): Promise<AiProviderConfig> {
  if (provider?.id || provider?.name) {
    return resolveProviderConfig(provider, tenantId);
  }

  const settings = await loadAiSettings(tenantId);
  const candidates = settings.providers.filter(
    (item) =>
      Boolean(item.endpoint) &&
      (item.apiType === "ollama" ||
        /embed/i.test(String(item.model || "")) ||
        /embeddings/i.test(String(item.endpoint || ""))),
  );

  if (!candidates.length) {
    throw new Error("未找到可用于知识库向量化的 embedding provider");
  }

  return candidates[0];
}
