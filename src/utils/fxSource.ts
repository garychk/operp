/**
 * 汇率数据源（前端调用封装）。
 *
 * 数据由 ai-server 的 /api/fx/cfets-quote 提供：服务端去中国货币网取
 * 人民币汇率中间价并归一化成「1 外币 = N 本位币」，前端只负责展示与回填。
 *
 * ⚠️ 不要在浏览器里直连中国货币网：该站点对缺少 Referer 的请求返回空 records，
 * 且不给跨域。所有取价一律走这个封装。
 */
import { aiServerAuthHeaders, resolveAiServerBaseUrl } from "./aiServer";

export interface CfetsQuoteRow {
  currency: string;
  /** 接口原始报价对，如 "USD/CNY"、"100JPY/CNY"、"CNY/THB" */
  pair: string;
  /** 原始报价数值，未换算 */
  rawPrice: number;
  /** true 表示原始报价是「人民币/外币」方向、已取过倒数 */
  inverted: boolean;
  /** 1 单位 currency = rate 单位 base，可直接写入 erp_exchange_rates.rate */
  rate: number;
}

export interface CfetsQuoteResult {
  source: string;
  sourceLabel: string;
  /** CFETS 公布时间原文，如 "2026-09-30 9:15" */
  publishedAt: string;
  /** 上面那串里的日期，即该批中间价的生效日 */
  publishedDate: string;
  base: string;
  rows: CfetsQuoteRow[];
}

export interface FetchCfetsQuoteParams {
  /** 限定单个币种；不传返回全部 */
  currency?: string;
  /** 目标本位币，默认 CNY，非 CNY 时由服务端交叉换算 */
  base?: string;
  /** 跳过服务端 30 分钟缓存强制回源 */
  refresh?: boolean;
}

export async function fetchCfetsQuote(
  params: FetchCfetsQuoteParams = {},
): Promise<CfetsQuoteResult> {
  const search = new URLSearchParams();
  if (params.currency) search.set("currency", params.currency);
  if (params.base) search.set("base", params.base);
  if (params.refresh) search.set("refresh", "1");

  const headers = await aiServerAuthHeaders();
  const response = await fetch(
    `${resolveAiServerBaseUrl()}/api/fx/cfets-quote?${search.toString()}`,
    { headers },
  );

  const payload = (await response.json().catch(() => null)) as
    | (Partial<CfetsQuoteResult> & { ok?: boolean; error?: string })
    | null;

  // 错误必须把服务端原文带给调用方：502 是数据源问题、400 是参数问题，两者处置方式不同
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error ?? `抓取中间价失败（HTTP ${response.status}）`);
  }

  return payload as CfetsQuoteResult;
}
