import type { Request, RequestHandler, Response, NextFunction } from "express";
import { logger } from "./logger.js";

/**
 * 内存滑动窗口限流（#8）。
 *
 * 单实例部署够用（当前拓扑就是一个 ai-server 进程）；将来多实例时
 * 把这里换成 Redis（INCR + EXPIRE 或滑动窗口 ZSET）即可，接口不变。
 *
 * 用法：
 *   router.use("/chat", rateLimit({ windowMs: 60_000, max: 30, name: "chat" }));
 *   —— key 默认取 req.identity.userId（requireAuth 之后），没有身份则退回 IP。
 */

interface Bucket {
  hits: number[];
}

const buckets = new Map<string, Bucket>();

// 防止长期运行后 Map 无限膨胀：定期清理已空窗口
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    bucket.hits = bucket.hits.filter((ts) => now - ts < 10 * 60_000);
    if (!bucket.hits.length) buckets.delete(key);
  }
}, 5 * 60_000).unref();

export interface RateLimitOptions {
  /** 窗口时长（毫秒） */
  windowMs: number;
  /** 窗口内最大请求数 */
  max: number;
  /** 日志 / 指标里的限流器名字 */
  name: string;
  /** 覆盖默认 key（默认 identity.userId ?? ip） */
  keyFn?: (req: Request) => string;
}

export const rateLimit =
  (options: RateLimitOptions): RequestHandler =>
  (req: Request, res: Response, next: NextFunction) => {
    const identity = (req as Request & { identity?: { userId?: number } }).identity;
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const key = options.keyFn
      ? options.keyFn(req)
      : `u${identity?.userId ?? "anon"}:${ip}`;

    const now = Date.now();
    const bucket = buckets.get(key) || { hits: [] };
    bucket.hits = bucket.hits.filter((ts) => now - ts < options.windowMs);

    if (bucket.hits.length >= options.max) {
      const oldest = bucket.hits[0];
      const retryAfterSec = Math.max(1, Math.ceil((oldest + options.windowMs - now) / 1000));
      logger.warn("ratelimit", "request rejected", {
        limiter: options.name,
        key,
        count: bucket.hits.length,
        retryAfterSec,
      });
      res.setHeader("Retry-After", String(retryAfterSec));
      res.status(429).json({
        ok: false,
        error: `请求过于频繁（${options.name} 限流：${options.windowMs / 1000}s 内最多 ${options.max} 次），请 ${retryAfterSec}s 后重试。`,
      });
      return;
    }

    bucket.hits.push(now);
    buckets.set(key, bucket);
    next();
  };

/** 常用限流档位（配置可被环境变量覆盖） */
const perMinute = (envKey: string, fallback: number) =>
  Math.max(1, Number(process.env[envKey] || fallback));

/** chat：LLM 成本最高的入口，默认 20 次/分钟/用户 */
export const chatRateLimit = rateLimit({
  windowMs: 60_000,
  max: perMinute("RATE_LIMIT_CHAT_PER_MIN", 20),
  name: "chat",
});

/** 知识库重建索引：批量 embedding，默认 5 次/分钟/用户 */
export const reindexRateLimit = rateLimit({
  windowMs: 60_000,
  max: perMinute("RATE_LIMIT_REINDEX_PER_MIN", 5),
  name: "reindex",
});

/**
 * 知识库文件解析：纯本地 CPU（mammoth / pdfjs），不打模型，成本远低于 reindex，
 * 但一次上传可能连着点好几次「解析」，故给 30 次/分钟。
 * ⚠️ 不能与 reindex 共用 5/min 档位 —— 那样上传 6 个文件分两批就会被拦死。
 */
export const knowledgeParseRateLimit = rateLimit({
  windowMs: 60_000,
  max: perMinute("RATE_LIMIT_KNOWLEDGE_PARSE_PER_MIN", 30),
  name: "knowledge-parse",
});

/** 确认执行 / 重操作（MRP 运算、成本卷算、MPS 下推），默认 10 次/分钟/用户 */
export const heavyActionRateLimit = rateLimit({
  windowMs: 60_000,
  max: perMinute("RATE_LIMIT_HEAVY_PER_MIN", 10),
  name: "heavy-action",
});
