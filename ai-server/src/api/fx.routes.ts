/**
 * 汇率数据源 HTTP 路由：把 CFETS 中间价喂给币别页的「抓取」按钮。
 *
 * 为什么必须放在服务端而不是浏览器直连：
 *   1. 中国货币网对缺少 Referer 的请求返回空 records，浏览器直连必带错 Referer；
 *   2. 浏览器直连要过 CORS，站点不给我们开；
 *   3. 将来要把抓取改成定时任务时，服务层函数可直接被 cron 复用，前端零改动。
 *
 * 鉴权（同 finance/mrp 口径）：requireAuth，身份由 Supabase JWT → sys_users → 租户解析。
 * 本路由只读**站外公共数据**、不触碰任何租户数据，所以不额外限制角色；
 * 一旦将来支持「直接写库」，必须补 requireFinanceActor 那一档角色校验。
 */
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../services/authGuard.js";
import { extractErrorMessage } from "../services/errors.js";
import { logger } from "../services/logger.js";
import { crossRateToBase, fetchCfetsQuotes } from "../services/fxSource.js";

export const fxRouter = Router();

fxRouter.use(requireAuth);

const SOURCE_LABEL = "中国货币网 · 人民币汇率中间价（CFETS）";

const quoteQuerySchema = z.object({
  /** 限定单个币种；不传则返回全部 25 个 */
  currency: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{3}$/, "currency 需要是 3 位币种代码")
    .optional(),
  /** 目标本位币，默认 CNY。非 CNY 时做交叉汇率换算 */
  base: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{3}$/, "base 需要是 3 位币种代码")
    .optional(),
  /**
   * 跳过 30 分钟缓存强制回源。
   * 用字面量联合而不是 z.coerce.boolean() —— 后者会把字符串 "false" 变成 true。
   */
  refresh: z
    .union([z.literal("1"), z.literal("true"), z.literal("0"), z.literal("false")])
    .optional()
    .transform((value) => value === "1" || value === "true"),
});

fxRouter.get("/cfets-quote", async (req, res) => {
  const parsed = quoteQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "Invalid request", issues: parsed.error.issues });
    return;
  }

  const { currency, refresh } = parsed.data;
  const base = (parsed.data.base ?? "CNY").toUpperCase();

  try {
    const snapshot = await fetchCfetsQuotes(refresh);

    const pool = currency
      ? snapshot.quotes.filter((item) => item.currency === currency.toUpperCase())
      : snapshot.quotes;

    const rows = pool
      .map((item) => ({
        currency: item.currency,
        pair: item.pair,
        rawPrice: item.rawPrice,
        inverted: item.inverted,
        /** 1 单位 currency = rate 单位 base，可直接写 erp_exchange_rates.rate */
        rate: crossRateToBase(snapshot, item.currency, base),
      }))
      .filter((item): item is typeof item & { rate: number } => item.rate !== null);

    res.json({
      ok: true,
      source: "CFETS",
      sourceLabel: SOURCE_LABEL,
      publishedAt: snapshot.publishedAt,
      publishedDate: snapshot.publishedDate,
      base,
      rows,
    });
  } catch (err) {
    // 上游不可用 / 解析失败都是 502：让调用方明确知道「是数据源的问题」，
    // 而不是我们自己 500 或被误判成参数错误。响应体必须带原文便于定位。
    const message = extractErrorMessage(err);
    logger.warn("fx", "cfets quote fetch failed", { message });
    res.status(502).json({ ok: false, source: "CFETS", error: message });
  }
});
