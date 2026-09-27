import { Router } from "express";
import { z } from "zod";
import { supabase } from "../config/supabase.js";
import { runChatGraph, runChatGraphStream } from "../ai/graph.js";
import { reindexKnowledgeDocuments } from "../services/knowledgeBase.js";
import { TenantScopeError, resolveTenantContext } from "../config/tenantContext.js";

export const aiRouter = Router();

const chatSchema = z.object({
  session_id: z.string().min(1),
  user_id: z.number().int().optional(),
  tenant_id: z.number().int().optional(),
  text: z.string().min(1),
  skill: z.enum(["auto", "analysis", "create", "action", "baq", "chat"]).optional(),
  provider: z
    .object({
      id: z.string().optional(),
      name: z.string().optional(),
    })
    .optional(),
  context: z
    .object({
      page: z.string().optional(),
      current_focus: z.any().optional(),
      recent_messages: z.array(z.any()).optional(),
    })
    .optional(),
});

const providerSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  endpoint: z.string().optional(),
  model: z.string().optional(),
  apiType: z.enum(["proxy", "ollama"]).optional(),
  apiKey: z.string().optional(),
  temperature: z.number().optional(),
});

const aiSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  providers: z.array(providerSchema).default([]),
  activeProviderId: z.string().optional(),
  temperature: z.number().optional(),
  redactSensitiveData: z.boolean().optional(),
  maxContextMessages: z.number().optional(),
});

const reindexSchema = z.object({
  doc_id: z.number().int().optional(),
  tenant_id: z.number().int().optional(),
  user_id: z.number().int().optional(),
});

async function resolveProviderConfig(
  provider?: { id?: string; name?: string },
  tenantId?: number | null,
) {
  // sys_config 里同一 category_code 可能同时有平台基线行和租户私有行，
  // 直接查表会拿到多行。RPC 内部「私有优先、回退基线」并接受显式 tenant_id。
  const { data, error } = await supabase.rpc("get_tenant_config", {
    p_category_code: "ai",
    p_tenant_id: tenantId ?? null,
  });

  if (error) throw error;

  const settings = aiSettingsSchema.parse(data || {});
  const matched = settings.providers.find((item) => {
    if (!provider?.id) return false;
    if (item.id === provider.id) return true;
    if (provider.name && item.name === provider.name) return true;
    return false;
  });

  if (!matched) {
    throw new Error(`未找到对应的 AI provider：${provider?.id || provider?.name || "unknown"}`);
  }

  // console.log("[ai-server] resolved provider:", {
  //   requestProvider: provider,
  //   matchedProvider: matched,
  // });

  return matched;
}

const wantsStream = (req: { body?: { stream?: unknown }; headers: Record<string, unknown> }) => {
  const accept = String(req.headers.accept || "");
  return req.body?.stream === true || accept.includes("text/event-stream");
};

const errorToMessage = (error: unknown) => {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
};

aiRouter.post("/chat", async (req, res) => {
  const parsed = chatSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      ok: false,
      error: "Invalid request",
      issues: parsed.error.issues,
    });
  }

  try {
    const resolvedProvider = parsed.data.provider
      ? await resolveProviderConfig(parsed.data.provider, parsed.data.tenant_id)
      : undefined;

    const requestBody = {
      ...parsed.data,
      provider: resolvedProvider
        ? {
            id: resolvedProvider.id,
            name: resolvedProvider.name,
            endpoint: resolvedProvider.endpoint,
            model: resolvedProvider.model,
            apiType: resolvedProvider.apiType,
            apiKey: resolvedProvider.apiKey,
            temperature: resolvedProvider.temperature,
          }
        : undefined,
    };

    if (wantsStream(req)) {
      res.status(200);
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders?.();

      const send = (event: string, data: unknown) => {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      await runChatGraphStream(requestBody, async (event) => {
        if (event.type === "step") {
          send("step", event);
          return;
        }
        send("final", event.result);
      });

      res.end();
      return;
    }

    const result = await runChatGraph(requestBody);
    res.json({ ok: true, ...result });
  } catch (error) {
    if (!res.headersSent) {
      // 租户解析失败属于「拒绝访问」，不是服务端故障，别让前端看到 500
      if (error instanceof TenantScopeError) {
        res.status(403).json({
          ok: false,
          error: errorToMessage(error),
        });
        return;
      }
      res.status(500).json({
        ok: false,
        error: errorToMessage(error),
      });
      return;
    }
    try {
      res.write(`event: error\n`);
      res.write(
        `data: ${JSON.stringify({
          ok: false,
          error: errorToMessage(error),
        })}\n\n`,
      );
    } finally {
      res.end();
    }
  }
});

aiRouter.post("/knowledge/reindex", async (req, res) => {
  const parsed = reindexSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({
      ok: false,
      error: "Invalid request",
      issues: parsed.error.issues,
    });
  }

  try {
    // service_role 绕过 RLS，租户必须显式传入或从 user_id 解析。
    // 两者都没有时不报错（保持 fail-closed），但会只扫 tenant_id IS NULL 的平台基线行，
    // 表现为 total=0 的静默空跑——打日志，免得下次又查半天。
    let tenantId = parsed.data.tenant_id ?? null;
    if (tenantId === null && parsed.data.user_id !== undefined) {
      tenantId = (await resolveTenantContext(parsed.data.user_id)).tenantId;
    }
    if (tenantId === null) {
      console.warn(
        "[ai-server] /knowledge/reindex 缺少租户上下文（既无 tenant_id 也无 user_id），只会索引平台基线文档",
      );
    }
    const resolvedProvider = await resolveProviderConfig({ id: "ollama" }, tenantId).catch(
      async () => {
        const { data, error } = await supabase.rpc("get_tenant_config", {
          p_category_code: "ai",
          p_tenant_id: tenantId,
        });
        if (error) throw error;
        const settings = aiSettingsSchema.parse(data || {});
        const candidates = settings.providers.filter(
          (item) =>
            item.apiType === "ollama" ||
            /embed/i.test(String(item.model || "")) ||
            /embeddings/i.test(String(item.endpoint || "")),
        );
        if (!candidates.length) {
          throw new Error("未找到可用于知识库向量化的 embedding provider");
        }
        return candidates[0];
      },
    );

    const result = await reindexKnowledgeDocuments(
      resolvedProvider,
      parsed.data.doc_id,
      tenantId,
    );
    res.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof TenantScopeError) {
      res.status(403).json({ ok: false, error: errorToMessage(error) });
      return;
    }
    res.status(500).json({
      ok: false,
      error: errorToMessage(error),
    });
  }
});
