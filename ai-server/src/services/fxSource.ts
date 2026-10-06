/**
 * 汇率数据源：中国货币网（CFETS）人民币汇率中间价。
 *
 * ## 为什么是国内源
 * 境外免费汇率 API 在公网服务器上基本不可用：实测 open.er-api.com 直连 12s 超时；
 * frankfurter.app 要跟随 301 且只有 ECB 口径约 30 个币种、并非在岸中间价。
 * 中国货币网是外汇交易中心官方发布口径，国内财务与审计认它，实测 200 秒级返回。
 *
 * ## ⚠️ 三个必须处理的坑（否则会静默算错金额）
 * 同一份 records 里报价方向是**混着**的，还夹带百单位前缀：
 *
 *   USD/CNY      1 USD   = 6.7351 CNY     → 直接可用
 *   100JPY/CNY   100 JPY = 4.2727 CNY     → 必须除以 100，否则日元错 100 倍
 *   CNY/THB      1 CNY   = 5.0001 THB     → 必须取倒数，否则泰铢错 25 倍
 *
 * 统一口径：`rate = 人民币侧数量 / 外币侧数量`。
 * 存库口径见 erp_exchange_rates.rate 的列注释：
 * 「1 单位 currency_code = rate 单位本位币，反向折算用 1/rate，禁止倒序存储」。
 *
 * ## 发布节奏
 * CFETS 每工作日 9:15 发布一次，节假日不发布、接口返回上一次的 lastDate。
 * 因此这里**照实透传发布日期**，不做「今天是几号就写几号」的假设 ——
 * 长假期间硬写当日会把 9 月 30 日的价挂到 10 月 6 日头上。
 */
import { logger } from "./logger.js";

const CFETS_ENDPOINT =
  "https://www.chinamoney.com.cn/r/cms/www/chinamoney/data/fx/ccpr.json";
/** 该站点对缺少 Referer 的请求会返回空 records，必须带上 */
const CFETS_REFERER = "https://www.chinamoney.com.cn/chinese/bkccpr/";
const CFETS_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const REQUEST_TIMEOUT_MS = 10_000;
/** CFETS 每天只发布一次，30 分钟内重复抓没有意义 */
const CACHE_TTL_MS = 30 * 60 * 1000;

/** 一条已归一化的中间价：统一表达为「1 单位 currency = rateToCny 单位人民币」 */
export interface CfetsQuote {
  /** 外币代码（USD / JPY / THB …），取自接口的 foreignCName */
  currency: string;
  /** 接口原始报价对，如 "100JPY/CNY"，留作排查用 */
  pair: string;
  /** 接口原始报价数值（未做任何换算），留作排查用 */
  rawPrice: number;
  /** 1 单位 currency = rateToCny 单位人民币 */
  rateToCny: number;
  /** true 表示对原始报价取了倒数（CNY/XXX 那一组） */
  inverted: boolean;
}

export interface CfetsSnapshot {
  /** CFETS 公布时间原文，如 "2026-09-30 9:15" */
  publishedAt: string;
  /** 上面那串里的日期部分，即该批中间价的**生效日** */
  publishedDate: string;
  quotes: CfetsQuote[];
}

interface CfetsRecord {
  vrtEName?: string;
  vrtName?: string;
  price?: string;
  foreignCName?: string;
}

interface CfetsPayload {
  data?: { lastDate?: string };
  /** ⚠️ records 在**顶层**，不在 data 里 —— 这一处曾让探测白跑几轮 */
  records?: CfetsRecord[];
}

let cache: { at: number; snapshot: CfetsSnapshot } | null = null;

/** 报价精度对齐 erp_exchange_rates.rate 的 NUMERIC(18,8) */
function roundRate(value: number): number {
  return Number(value.toFixed(8));
}

interface ParsedPair {
  base: string;
  baseAmount: number;
  quote: string;
  quoteAmount: number;
}

/**
 * 解析形如 "USD/CNY" / "100JPY/CNY" / "CNY/THB" 的报价对。
 * 数字前缀表示左侧的数量（CFETS 对日元等小面额币种用 100 作单位）。
 */
function parsePair(pair: string): ParsedPair | null {
  const match = /^(\d*)([A-Z]{3})\/(\d*)([A-Z]{3})$/.exec(pair.trim().toUpperCase());
  if (!match) return null;
  return {
    baseAmount: match[1] ? Number(match[1]) : 1,
    base: match[2],
    quoteAmount: match[3] ? Number(match[3]) : 1,
    quote: match[4],
  };
}

/**
 * 把 CFETS 原始报价折算成「1 单位外币 = ? 人民币」。
 *
 * 报价含义：`baseAmount` 单位 base ⇄ `rawPrice × quoteAmount` 单位 quote。
 * 于是外币对人民币的汇率 = 人民币侧数量 ÷ 外币侧数量：
 *   quote 是人民币 → 人民币侧 = rawPrice × quoteAmount，外币侧 = baseAmount
 *   base  是人民币 → 人民币侧 = baseAmount，外币侧 = rawPrice × quoteAmount
 */
function toRateToCny(rawPrice: number, parsed: ParsedPair): { rate: number; inverted: boolean } | null {
  const { base, baseAmount, quote, quoteAmount } = parsed;
  const quoteSide = rawPrice * quoteAmount;

  if (quote === "CNY" && base !== "CNY") {
    if (!(baseAmount > 0)) return null;
    return { rate: quoteSide / baseAmount, inverted: false };
  }
  if (base === "CNY" && quote !== "CNY") {
    if (!(quoteSide > 0)) return null;
    return { rate: baseAmount / quoteSide, inverted: true };
  }
  return null;
}

function normalizeRecord(record: CfetsRecord): CfetsQuote | null {
  const pair = String(record.vrtEName ?? "").trim();
  const rawPrice = Number(record.price);
  if (!pair || !Number.isFinite(rawPrice) || rawPrice <= 0) return null;

  const parsed = parsePair(pair);
  if (!parsed) return null;

  const converted = toRateToCny(rawPrice, parsed);
  if (!converted || !(converted.rate > 0)) return null;

  // 接口自带 foreignCName 即外币代码，比从报价对推断更权威；缺失时回退
  const foreign = parsed.base === "CNY" ? parsed.quote : parsed.base;
  const currency = String(record.foreignCName ?? "").trim().toUpperCase() || foreign;
  if (!/^[A-Z]{3}$/.test(currency)) return null;

  return {
    currency,
    pair,
    rawPrice,
    rateToCny: roundRate(converted.rate),
    inverted: converted.inverted,
  };
}

/**
 * 抓取并归一化 CFETS 中间价。默认走 30 分钟缓存，`force` 可跳过。
 * 失败时抛错（fail-loud）—— 调用方必须把错误透出，不能拿旧价静默顶替。
 */
export async function fetchCfetsQuotes(force = false): Promise<CfetsSnapshot> {
  const now = Date.now();
  if (!force && cache && now - cache.at < CACHE_TTL_MS) {
    return cache.snapshot;
  }

  const response = await fetch(CFETS_ENDPOINT, {
    headers: {
      "User-Agent": CFETS_USER_AGENT,
      Referer: CFETS_REFERER,
      Accept: "application/json, text/plain, */*",
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`CFETS 中间价接口返回 HTTP ${response.status}`);
  }

  const payload = (await response.json()) as CfetsPayload;
  const rawRecords = Array.isArray(payload?.records) ? payload.records : [];
  if (rawRecords.length === 0) {
    // 缺 Referer 或站点改版时会走到这里，明确报错而不是返回空列表让人以为「今天没价」
    throw new Error("CFETS 中间价接口未返回 records（可能被拦截或接口已改版）");
  }

  const quotes = rawRecords
    .map(normalizeRecord)
    .filter((item): item is CfetsQuote => item !== null);

  if (quotes.length === 0) {
    throw new Error("CFETS 中间价解析结果为空（报价对格式可能已变更）");
  }

  const publishedAt = String(payload?.data?.lastDate ?? "").trim();
  const snapshot: CfetsSnapshot = {
    publishedAt,
    publishedDate: /^\d{4}-\d{2}-\d{2}/.test(publishedAt)
      ? publishedAt.slice(0, 10)
      : new Date().toISOString().slice(0, 10),
    quotes,
  };

  cache = { at: now, snapshot };
  logger.info("fx", "cfets quotes fetched", {
    publishedAt: snapshot.publishedAt,
    count: quotes.length,
  });
  return snapshot;
}

/**
 * 取 currency 对本位币 base 的汇率（1 外币 = N 本位币）。
 *
 * CFETS 只提供「对人民币」。本位币非 CNY 时用法则 `X/B = (X/CNY) ÷ (B/CNY)` 交叉换算。
 * 拿不到任一侧时返回 null —— 与 get_exchange_rate 的 fail-loud 语义一致，
 * 绝不退化成 1，把外币金额当本位币入账是比拿不到汇率严重得多的静默错误。
 */
export function crossRateToBase(
  snapshot: CfetsSnapshot,
  currency: string,
  base: string,
): number | null {
  const target = currency.trim().toUpperCase();
  const baseCode = base.trim().toUpperCase();
  if (!target) return null;
  if (target === baseCode) return 1;

  const targetQuote = snapshot.quotes.find((item) => item.currency === target);
  if (!targetQuote) return null;
  if (baseCode === "CNY") return targetQuote.rateToCny;

  const baseQuote = snapshot.quotes.find((item) => item.currency === baseCode);
  if (!baseQuote || !(baseQuote.rateToCny > 0)) return null;

  const rate = targetQuote.rateToCny / baseQuote.rateToCny;
  return rate > 0 ? roundRate(rate) : null;
}

/** 当前缓存的快照（没有则 null），仅用于诊断/自检 */
export function peekCfetsCache(): CfetsSnapshot | null {
  return cache?.snapshot ?? null;
}
