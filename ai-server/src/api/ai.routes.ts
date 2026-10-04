import { Router } from "express";
import { z } from "zod";
import { runChatGraph, runChatGraphStream } from "../ai/graph.js";
import { reindexKnowledgeDocuments } from "../services/knowledgeBase.js";
import { executePendingAction, PendingActionError } from "../services/pendingActions.js";
import {
  resolveEmbeddingProviderConfig,
  resolveProviderConfig,
} from "../services/aiProvider.js";
import { TenantScopeError } from "../config/tenantContext.js";
import { getIdentity, requireAuth } from "../services/authGuard.js";
import { chatRateLimit, reindexRateLimit, heavyActionRateLimit } from "../services/rateLimit.js";

export const aiRouter = Router();

/**
 * ⚠️ 鉴权：/api/ai 下所有端点都必须过 requireAuth。
 * 此前 chat 完全不验 JWT、身份取自请求体 user_id，等于对内网裸奔；
 * 现在身份链路 = Supabase JWT → sys_users.auth_id → resolveTenantContext，
 * 请求体里的 user_id/tenant_id 只做一致性/越权校验，不再作为身份来源。
 *
 * ⚠️ 限流（#8）：chat 是 LLM 成本入口，reindex 是批量 embedding 入口，
 * confirm 是写库入口 —— 都按「用户」窗口限流，防止单租户刷爆模型配额。
 * ⚠️ 顺序：必须先 requireAuth 再限流 —— 限流 key 取 identity.userId，
 * 反过来的话匿名请求会污染 per-IP 桶，把真实用户一起限死（真实踩过）。
 */
aiRouter.use("/chat", requireAuth, chatRateLimit);
aiRouter.use("/knowledge", requireAuth, reindexRateLimit);
aiRouter.use("/confirm", requireAuth, heavyActionRateLimit);

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

const confirmSchema = z.object({
  pending_action_id: z.number().int().positive(),
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
    // 身份以 JWT 为准（requireAuth 已校验 user_id 一致性）。
    // tenant_id 允许超管显式切换租户（resolveRequestIdentity 里已做过越权校验）。
    const identity = getIdentity(req);
    const requestBody = {
      ...parsed.data,
      user_id: identity.userId,
      provider: parsed.data.provider
        ? await resolveProviderConfig(parsed.data.provider, identity.tenantId)
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
        if (event.type === "delta") {
          send("delta", event);
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
    const identity = getIdentity(req);
    // 租户以 JWT 身份为准；仅超管可通过 body.tenant_id 指定其他租户。
    const tenantId =
      parsed.data.tenant_id && identity.isSuperAdmin ? parsed.data.tenant_id : identity.tenantId;

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

/**
 * 确认回路执行端点：确认对话草稿（AI 创建/修改实体的第二段）。
 * 对话式确认（回复「确认」）走 chat 链路；UI 按钮式确认走这里。
 */
aiRouter.post("/confirm", async (req, res) => {
  const parsed = confirmSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({
      ok: false,
      error: "Invalid request",
      issues: parsed.error.issues,
    });
  }

  try {
    const identity = getIdentity(req);
    const result = await executePendingAction(parsed.data.pending_action_id, identity);
    res.json({ ok: true, status: "success", ...result });
  } catch (error) {
    if (error instanceof PendingActionError) {
      const statusByCode: Record<string, number> = {
        not_found: 404,
        expired: 410,
        forbidden: 403,
        already_handled: 409,
      };
      res.status(statusByCode[error.code] ?? 400).json({ ok: false, error: error.message });
      return;
    }
    if (error instanceof TenantScopeError) {
      res.status(403).json({ ok: false, error: errorToMessage(error) });
      return;
    }
    res.status(500).json({ ok: false, error: errorToMessage(error) });
  }
});
