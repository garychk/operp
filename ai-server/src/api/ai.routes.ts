import { Router } from "express";
import { z } from "zod";
import { runChatGraph, runChatGraphStream } from "../ai/graph.js";
import { reindexKnowledgeDocuments } from "../services/knowledgeBase.js";
import {
  resolveEmbeddingProviderConfig,
  resolveProviderConfig,
} from "../services/aiProvider.js";
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

const reindexSchema = z.object({
  doc_id: z.number().int().optional(),
  tenant_id: z.number().int().optional(),
  user_id: z.number().int().optional(),
});

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
    // 优先用 id=ollama 的 provider；没有则按 embedding 特征自动挑。
    // 规则收在 services/aiProvider.ts，与 MCP 链路共用同一份。
    const resolvedProvider = await resolveEmbeddingProviderConfig(
      { id: "ollama" },
      tenantId,
    ).catch(() => resolveEmbeddingProviderConfig(undefined, tenantId));

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
