/**
 * 租户订阅（Waffo Pancake）HTTP 路由。
 *
 * 端点：
 *   GET  /api/subscription/status   当前租户的使用期限 + 订阅流水（登录即可）
 *   POST /api/subscription/checkout 创建按月订阅收银台会话（tenant_admin / super_admin）
 *   POST /api/subscription/webhook  Waffo 回调（⚠️ 在 app.ts 里挂在 express.json **之前**，
 *                                   用 express.raw 保留原始报文做 RSA-SHA256 验签；
 *                                   服务器对服务器调用，不走 requireAuth）
 *
 * 续租内核在库内 RPC service_extend_tenant_subscription（deploy_84）：
 *   event_id 幂等 + sys_tenants.expires_at 从 max(now, expires_at) 顺延。
 *   ai-server 只做「验签 + 解析 + 转发」，不另写一套租户/期限逻辑。
 *
 * 鉴权：status/checkout 过 requireAuth（JWT → sys_users → 租户），
 * body 里的 tenant_id 只做一致性校验，实际租户一律取 identity.tenantId ——
 * metadata 里的 tenant_id 是我们自己在 checkout 时写进去的，webhook 侧信任它。
 */
import { Router, type Request, type RequestHandler, type Response } from "express";
import { WebhookEventType, verifyWebhook, type WebhookEvent } from "@waffo/pancake-ts";
import { z } from "zod";
import { supabase } from "../config/supabase.js";
import { env } from "../config/env.js";
import { userHasRole } from "../services/roleGuard.js";
import { extractErrorMessage } from "../services/errors.js";
import { getIdentity, requireAuth, type RequestIdentity } from "../services/authGuard.js";
import { getWaffoClient, isWaffoConfigured } from "../services/waffo.js";

export const subscriptionRouter = Router();

// status / checkout 全部要登录：租户上下文由中间件统一解析
// （webhook 是独立的原始体路由，在 app.ts 里单独挂载，不走这里）
subscriptionRouter.use(requireAuth);

const TENANT_SUBSCRIPTION_TABLE = "sys_tenant_subscriptions";

/** 订阅/续费的角色白名单：与租户管理口径一致 */
const SUBSCRIPTION_ROLES = new Set(["super_admin", "tenant_admin"]);

const baseSchema = z.object({
  user_id: z.coerce.number().int().positive().optional(),
  tenant_id: z.coerce.number().int().positive().optional(),
});

const checkoutSchema = baseSchema.extend({
  /** 支付完成后的回跳地址（必须 http/https，防 open redirect） */
  success_url: z.string().url().refine((v) => v.startsWith("http://") || v.startsWith("https://"), {
    message: "success_url 必须是 http/https 地址",
  }).optional(),
});

/** 校验角色（身份来自 JWT），不过时直接写响应并返回 -1 */
async function requireSubscriptionActor(
  res: Response,
  identity: RequestIdentity,
): Promise<number> {
  const allowed = await userHasRole(identity.userId, SUBSCRIPTION_ROLES);
  if (!allowed) {
    res.status(403).json({
      ok: false,
      error: "当前用户没有订阅管理权限（需要 super_admin / tenant_admin）。",
    });
    return -1;
  }
  return identity.tenantId;
}

function requireWaffo(res: Response): boolean {
  if (!isWaffoConfigured()) {
    res.status(503).json({
      ok: false,
      error: "订阅收款未启用：请先在服务端配置 WAFFO_MERCHANT_ID / WAFFO_PRIVATE_KEY(_BASE64) / WAFFO_MONTHLY_PRODUCT_ID。",
    });
    return false;
  }
  return true;
}

function handleError(res: Response, scope: string, err: unknown): void {
  const message = extractErrorMessage(err);
  // PostgREST 错误是普通对象，必须走 extractErrorMessage，否则 409/422 全退化成 500
  if (message.includes("does not exist or is deleted")) {
    res.status(404).json({ ok: false, error: message });
    return;
  }
  if (message.includes("is not allowed to act on tenant")) {
    res.status(403).json({ ok: false, error: message });
    return;
  }
  console.error(`[ai-server] ${scope} failed:`, err);
  res.status(500).json({ ok: false, error: message });
}

/* ------------------------------------------------------------------ *
 * 读：当前租户的订阅状态（登录即可查看）
 * ------------------------------------------------------------------ */
subscriptionRouter.get("/status", async (req, res) => {
  try {
    const identity = getIdentity(req);

    const [tenantRes, historyRes] = await Promise.all([
      supabase
        .from("sys_tenants")
        .select("id, code, name, expires_at")
        .eq("id", identity.tenantId)
        .maybeSingle(),
      supabase
        .from(TENANT_SUBSCRIPTION_TABLE)
        .select("*")
        .eq("tenant_id", identity.tenantId)
        .order("created_at", { ascending: false })
        .limit(50),
    ]);
    if (tenantRes.error) throw tenantRes.error;
    if (historyRes.error) throw historyRes.error;

    res.json({
      ok: true,
      configured: isWaffoConfigured(),
      environment: env.WAFFO_ENVIRONMENT,
      plan: {
        billingPeriod: "monthly",
        productId: env.WAFFO_MONTHLY_PRODUCT_ID ?? null,
        currency: env.WAFFO_CHECKOUT_CURRENCY,
      },
      tenant: tenantRes.data ?? null,
      history: historyRes.data ?? [],
    });
  } catch (err) {
    handleError(res, "subscription status", err);
  }
});

/* ------------------------------------------------------------------ *
 * 写：创建按月订阅收银台会话
 * ------------------------------------------------------------------ */
subscriptionRouter.post("/checkout", async (req, res) => {
  const parsed = checkoutSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "Invalid request", issues: parsed.error.issues });
    return;
  }
  try {
    if (!requireWaffo(res)) return;
    const identity = getIdentity(req);
    const tenantId = await requireSubscriptionActor(res, identity);
    if (tenantId < 0) return;

    const client = getWaffoClient();
    if (!client || !env.WAFFO_MONTHLY_PRODUCT_ID) {
      res.status(503).json({ ok: false, error: "订阅收款未启用。" });
      return;
    }

    // metadata 透传到 webhook 的 event.data —— 续租时靠它定位租户与月数
    const session = await client.checkout.createSession({
      productId: env.WAFFO_MONTHLY_PRODUCT_ID,
      currency: env.WAFFO_CHECKOUT_CURRENCY,
      successUrl: parsed.data.success_url ?? undefined,
      metadata: { tenant_id: String(tenantId), months: "1" },
    });

    // 收银台必须新标签页打开（前端 window.open），保留本页状态
    res.json({
      ok: true,
      checkout_url: session.checkoutUrl,
      session_id: session.sessionId,
      expires_at: session.expiresAt,
    });
  } catch (err) {
    handleError(res, "subscription checkout", err);
  }
});

/* ------------------------------------------------------------------ *
 * Webhook：Waffo 回调（验签 + 幂等续租）
 *
 * ⚠️ 必须拿原始文本验签：express.json() 解析后再序列化会破坏签名，
 *    所以这个 handler 在 app.ts 里挂在 express.json 之前、body 是 Buffer。
 * ⚠️ 验签通过后尽快返回 200；库存内 RPC 很快，失败时返回 5xx 让 Waffo 重投，
 *    重投会被 event_id 幂等挡住，不会重复续租。
 * ------------------------------------------------------------------ */
export const waffoWebhookHandler: RequestHandler = async (
  req: Request,
  res: Response,
) => {
  const rawBody = Buffer.isBuffer(req.body)
    ? req.body.toString("utf-8")
    : typeof req.body === "string"
      ? req.body
      : "";
  const signature = String(req.headers["x-waffo-signature"] || "");

  let event: WebhookEvent;
  try {
    // SDK 内置 test/prod 公钥；显式指定当前环境
    event = verifyWebhook(rawBody, signature, { environment: env.WAFFO_ENVIRONMENT }) as WebhookEvent;
  } catch {
    res.status(401).send("Invalid signature");
    return;
  }

  // 环境不符（如 prod 模式收到 test 事件）只记录不处理，避免测试数据污染生产期限
  if (event.mode && event.mode !== env.WAFFO_ENVIRONMENT) {
    console.warn(
      `[ai-server] waffo webhook 忽略环境不符事件: mode=${event.mode} env=${env.WAFFO_ENVIRONMENT} id=${event.id}`,
    );
    res.status(200).send("OK");
    return;
  }

  try {
    if (
      event.eventType === WebhookEventType.SubscriptionActivated ||
      event.eventType === WebhookEventType.SubscriptionPaymentSucceeded
    ) {
      // metadata 在 checkout.createSession 时写入；兼容两种回传位置
      const data = event.data as unknown as Record<string, unknown>;
      const meta = (data?.metadata as Record<string, unknown> | undefined) ?? data;
      const tenantId = Number(meta?.tenant_id);
      const months = Number(meta?.months) || 1;
      if (!Number.isInteger(tenantId) || tenantId <= 0) {
        console.error(`[ai-server] waffo webhook 缺少合法的 metadata.tenant_id: id=${event.id}`);
        res.status(200).send("OK"); // 无法定位租户，重投也无用，先 ACK 掉
        return;
      }

      const { data: result, error } = await supabase.rpc("service_extend_tenant_subscription", {
        p_tenant_id: tenantId,
        p_event_id: event.id,
        p_event_type: event.eventType,
        p_order_id: data?.orderId ?? null,
        p_session_id: null,
        p_product_id: null,
        p_product_name: data?.productName ?? null,
        p_buyer_email: data?.buyerEmail ?? null,
        p_currency: data?.currency ?? null,
        p_amount: data?.amount ?? null,
        p_mode: event.mode ?? null,
        p_months: months,
      });
      if (error) throw error;
      console.info(
        `[ai-server] waffo webhook 已处理租户 ${tenantId} 的订阅事件 ${event.eventType}: ${JSON.stringify(result)}`,
      );
    } else {
      // canceling / uncanceled / plan_changed / past_due / refund.* 等暂只记日志
      console.info(`[ai-server] waffo webhook 收到事件（未处理）: ${event.eventType} id=${event.id}`);
    }
    res.status(200).send("OK");
  } catch (err) {
    // 5xx 让 Waffo 重投；重投命中 event_id 幂等，不会重复续租
    console.error(`[ai-server] waffo webhook 处理失败（等待重投）:`, extractErrorMessage(err));
    res.status(500).send("Processing failed");
  }
};
