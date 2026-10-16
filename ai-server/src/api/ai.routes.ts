import { Router } from "express";
import type { Request, RequestHandler } from "express";
import multer from "multer";
import { z } from "zod";
import { runChatGraph, runChatGraphStream } from "../ai/graph.js";
import { nextPendingActionId, runRemainingPlan } from "../ai/planRunner.js";
import type { AiGraphState } from "../ai/state.js";
import { reindexKnowledgeDocuments } from "../services/knowledgeBase.js";
import {
  decodeUploadFilename,
  parseKnowledgeFiles,
  SUPPORTED_UPLOAD_EXTS,
} from "../services/knowledgeImport.js";
import { executePendingAction, PendingActionError } from "../services/pendingActions.js";
import { tokenUsageContext } from "../services/tokenUsage.js";
import {
  resolveEmbeddingProviderConfig,
  resolveProviderConfig,
} from "../services/aiProvider.js";
import { TenantScopeError } from "../config/tenantContext.js";
import { getIdentity, requireAuth } from "../services/authGuard.js";
import {
  chatRateLimit,
  knowledgeParseRateLimit,
  reindexRateLimit,
  heavyActionRateLimit,
} from "../services/rateLimit.js";

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
// ⚠️ /knowledge 下两个端点成本差一个数量级：reindex 是批量 embedding（贵，5/min），
// parse 只是本地解析文件（便宜，30/min）。共用一个档位会让「上传 6 个文件」直接被拦。
// 所以这里只统一挂 requireAuth，限流下沉到各自路由上。
aiRouter.use("/knowledge", requireAuth);
aiRouter.use("/confirm", requireAuth, heavyActionRateLimit);

const chatSchema = z.object({
  session_id: z.string().min(1),
  user_id: z.number().int().optional(),
  tenant_id: z.number().int().optional(),
  text: z.string().min(1),
  skill: z.enum(["auto", "analysis", "create", "action", "baq", "chat"]).optional(),
  /** 界面语言（zh-CN / en-US）：查询结果列名按它本地化 */
  locale: z.string().max(20).optional(),
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
  /** 批量索引指定文档（导入文件后只索引新增的那几篇，避免整租户重算） */
  doc_ids: z.array(z.number().int()).max(200).optional(),
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

/** 一次最多 20 个文件、单个 20MB —— 与前端预校验、uploadfiles 桶配置保持一致 */
const MAX_UPLOAD_FILES = 20;
const MAX_UPLOAD_FILE_SIZE = 20 * 1024 * 1024;

const uploadKnowledgeFiles = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_FILE_SIZE, files: MAX_UPLOAD_FILES },
}).array("files", MAX_UPLOAD_FILES);

/**
 * multer 的错误（超大小 / 超数量 / 字段名不对）默认会交给 Express 兜底，
 * 返回 HTML 500，前端拿不到可读原因。这里收敛成 JSON 400。
 */
const handleKnowledgeUpload: RequestHandler = (req, res, next) => {
  uploadKnowledgeFiles(req, res, (error: unknown) => {
    if (!error) {
      next();
      return;
    }
    const code = (error as { code?: string }).code;
    const message =
      code === "LIMIT_FILE_SIZE"
        ? `单个文件不得超过 ${MAX_UPLOAD_FILE_SIZE / 1024 / 1024}MB。`
        : code === "LIMIT_FILE_COUNT" || code === "LIMIT_UNEXPECTED_FILE"
          ? `一次最多上传 ${MAX_UPLOAD_FILES} 个文件。`
          : error instanceof Error
            ? error.message
            : "文件上传失败。";
    res.status(400).json({ ok: false, error: message });
  });
};

/**
 * 知识库文件解析：把上传的 docx / pdf / txt / md 抽成纯文本回传，**不写库**。
 * 入库由前端带 JWT 直连 PostgREST（RLS 生效），见 pages/system/KnowledgeBase.tsx。
 */
aiRouter.post(
  "/knowledge/parse",
  knowledgeParseRateLimit,
  handleKnowledgeUpload,
  async (req, res) => {
    try {
      const files = (req as Request & { files?: Express.Multer.File[] }).files || [];
      if (!files.length) {
        return res.status(400).json({
          ok: false,
          error: "没有收到文件（multipart 字段名固定为 files）。",
        });
      }

      const parsed = await parseKnowledgeFiles(
        files.map((file) => ({
          // multer 的 originalname 是 latin1 解码的，中文文件名必须先还原
          name: decodeUploadFilename(file.originalname),
          buffer: file.buffer,
        })),
      );

      const succeeded = parsed.filter((item) => item.ok).length;
      res.json({
        ok: true,
        total: parsed.length,
        succeeded,
        failed: parsed.length - succeeded,
        supported_exts: SUPPORTED_UPLOAD_EXTS,
        files: parsed,
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: errorToMessage(error) });
    }
  },
);

aiRouter.post("/knowledge/reindex", reindexRateLimit, async (req, res) => {
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

    // 向量模型的选择规则全部收在 services/aiProvider.ts：AI 设置里「向量模型」显式
    // 指定的优先，未指定时按模型名 / 接口地址特征自动挑。
    // **不再**硬编码 `{ id: 'ollama' }` 优先 —— 默认配置里恰好有一条 id 为 ollama 的
    // 纯对话模型（qwen2.5），强选它会让导入后的自动索引必然失败。
    const resolvedProvider = await resolveEmbeddingProviderConfig(undefined, tenantId);

    // doc_ids（批量）优先；两者都不传 = 全量重索引。
    const target = parsed.data.doc_ids?.length ? parsed.data.doc_ids : parsed.data.doc_id;
    const result = await reindexKnowledgeDocuments(resolvedProvider, target, tenantId);
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

    // 多步计划（第三批）：草稿上挂着剩余步骤时，在同一请求里继续跑。
    // 续跑遇到下一个写操作会再产一份草稿 → 返回 need_confirmation + 新的 pending id。
    if (Array.isArray(result.remainingPlan) && result.remainingPlan.length) {
      const baseState: AiGraphState = {
        sessionId: String(req.body?.session_id || "confirm"),
        userId: identity.userId,
        tenantId: identity.tenantId,
        text: String(req.body?.text || ""),
        skill: "auto",
        // 续跑里可能有分析步骤 → 列名本地化语言要跟着带过来
        locale: typeof req.body?.locale === "string" ? req.body.locale : undefined,
        provider: req.body?.provider as AiGraphState["provider"],
        recentMessages: [],
        toolResults: [],
        planOutputs: [result.output || {}],
      };
      const remainingPlan = result.remainingPlan;
      const continued = await tokenUsageContext.run(
        { userId: identity.userId, tenantId: identity.tenantId, sessionId: String(req.body?.session_id || "confirm") },
        () => runRemainingPlan(remainingPlan as unknown[], baseState),
      );
      const nextId = nextPendingActionId(continued);
      res.json({
        ok: true,
        status: "success",
        reply: [result.reply, continued.reply].filter(Boolean).join("\n\n"),
        focus: continued.focus || result.focus,
        route: continued.route || result.route,
        routeLabel: continued.routeLabel || result.routeLabel,
        need_confirmation: Boolean(continued.needConfirmation),
        next_pending_action_id: nextId ?? null,
        tool_results: continued.toolResults,
      });
      return;
    }

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
