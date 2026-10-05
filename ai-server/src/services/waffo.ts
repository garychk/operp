/**
 * Waffo Pancake 客户端封装（订阅收款）。
 *
 * 只在服务端使用 —— 私钥绝不能出现在浏览器侧。客户端按需懒初始化：
 * 未配置 WAFFO_MERCHANT_ID / 私钥时 isWaffoConfigured() 返回 false，
 * 订阅端点统一返回 503，不影响 ai-server 其它功能。
 *
 * 环境变量（见 config/env.ts）：
 *   WAFFO_MERCHANT_ID           商户 ID（Dashboard → API & Development）
 *   WAFFO_PRIVATE_KEY           RSA 私钥（PEM / 纯 base64 / 字面量 \n 均可，SDK 自动规范化）
 *   WAFFO_PRIVATE_KEY_BASE64    整体 base64 的私钥（CI 推荐，二选一）
 *   WAFFO_STORE_ID              店铺 ID（STO_...）
 *   WAFFO_MONTHLY_PRODUCT_ID    按月订阅商品 ID（PROD_...）
 *   WAFFO_ENVIRONMENT           test | prod（默认 test）
 *   WAFFO_CHECKOUT_CURRENCY     收银台币种（默认 USD）
 */
import { WaffoPancake } from "@waffo/pancake-ts";
import { env } from "../config/env.js";
import { extractErrorMessage } from "./errors.js";

let cachedClient: WaffoPancake | null | undefined;

/** 解析私钥：base64 整体编码优先，其次原始 PEM（SDK 也接受字面量 \n） */
function resolvePrivateKey(): string | null {
  if (env.WAFFO_PRIVATE_KEY_BASE64) {
    return Buffer.from(env.WAFFO_PRIVATE_KEY_BASE64, "base64").toString("utf-8");
  }
  if (env.WAFFO_PRIVATE_KEY) return env.WAFFO_PRIVATE_KEY;
  return null;
}

/** Waffo 是否已配置齐（商户 + 私钥 + 商品；店铺 ID 仅建会话不强制） */
export function isWaffoConfigured(): boolean {
  return Boolean(env.WAFFO_MERCHANT_ID && resolvePrivateKey() && env.WAFFO_MONTHLY_PRODUCT_ID);
}

/** 懒初始化的 Waffo 客户端；未配置返回 null（密钥无效时 SDK 构造即抛错，这里降级为 null 并记日志） */
export function getWaffoClient(): WaffoPancake | null {
  if (cachedClient !== undefined) return cachedClient;
  if (!env.WAFFO_MERCHANT_ID || !resolvePrivateKey()) {
    cachedClient = null;
    return cachedClient;
  }
  try {
    cachedClient = new WaffoPancake({
      merchantId: env.WAFFO_MERCHANT_ID,
      privateKey: resolvePrivateKey()!,
    });
  } catch (err) {
    console.error("[ai-server] Waffo Pancake 客户端初始化失败（请检查私钥格式）:", extractErrorMessage(err));
    cachedClient = null;
  }
  return cachedClient;
}
