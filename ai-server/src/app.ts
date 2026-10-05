import express from "express";
import cors from "cors";
import { randomUUID } from "node:crypto";
import type { Request, RequestHandler } from "express";
import { env } from "./config/env.js";
import { logger } from "./services/logger.js";
import { healthRouter } from "./api/health.routes.js";
import { aiRouter } from "./api/ai.routes.js";
import { mrpRouter } from "./api/mrp.routes.js";
import { mpsRouter } from "./api/mps.routes.js";
import { financeRouter } from "./api/finance.routes.js";
import { subscriptionRouter, waffoWebhookHandler } from "./api/subscription.routes.js";

/** 请求 ID：每条 HTTP 请求一个，日志里全链路携带，便于聚合检索 */
const requestIdMiddleware: RequestHandler = (req, res, next) => {
  const id = randomUUID();
  (req as Request & { requestId?: string }).requestId = id;
  res.setHeader("X-Request-Id", id);
  next();
};

/** 访问日志：方法 / 路径 / 状态 / 耗时 / 用户 */
const accessLogMiddleware: RequestHandler = (req, res, next) => {
  const startedAt = Date.now();
  res.on("finish", () => {
    const identity = (req as Request & { identity?: { userId?: number; tenantId?: number } })
      .identity;
    const fields = {
      requestId: (req as Request & { requestId?: string }).requestId,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: Date.now() - startedAt,
      userId: identity?.userId ?? null,
      tenantId: identity?.tenantId ?? null,
    };
    if (res.statusCode >= 500) logger.error("http", "request failed", fields);
    else if (res.statusCode >= 400) logger.warn("http", "request rejected", fields);
    else logger.info("http", "request", fields);
  });
  next();
};

export function createApp() {
  const app = express();
  const allowedOrigins = env.ALLOWED_ORIGIN.split(",").map((item) => item.trim());

  app.use(
    cors({
      origin: allowedOrigins,
      credentials: true,
    }),
  );
  // ⚠️ Waffo webhook 必须在 express.json 之前挂载：验签需要原始报文，
  // JSON 解析后再序列化会破坏 RSA-SHA256 签名（见 subscription.routes.ts）。
  app.post(
    "/api/subscription/webhook",
    express.raw({ type: "application/json", limit: "256kb" }),
    waffoWebhookHandler,
  );

  app.use(express.json({ limit: "2mb" }));
  app.use(requestIdMiddleware);
  app.use(accessLogMiddleware);

  app.use("/api/health", healthRouter);
  app.use("/api/ai", aiRouter);
  app.use("/api/mrp", mrpRouter);
  app.use("/api/mps", mpsRouter);
  app.use("/api/finance", financeRouter);
  app.use("/api/subscription", subscriptionRouter);

  return app;
}
