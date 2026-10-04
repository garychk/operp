/**
 * ai-server 基址解析（共用）。
 *
 * 约定与 AIChatPanel 一致：VITE_AI_SERVER_URL 指的是「…/api/ai」这个具体端点，
 * 这里把尾部的 /api/ai 剥掉，只保留服务根，再拼各自的子路径。
 *
 * ⚠️ 三处共用（MRP 计划页 / 报工页 / 成本核算页），不要再在页面里各写一份：
 *    以前只有计划页时写在页面里还行，多一份就会开始漂移。
 */
import { supabase } from "./supabase";

export const resolveAiServerBaseUrl = (): string => {
  const explicitUrl = import.meta.env.VITE_AI_SERVER_URL;
  if (explicitUrl) {
    return explicitUrl.replace(/\/$/, '').replace(/\/api\/ai$/, '');
  }
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    return 'http://localhost:3001';
  }
  return '';
};

/** MRP 相关端点基址（运算 / 转单 / 成本卷算都在 /api/mrp 下） */
export const resolveMrpApiBaseUrl = (): string => `${resolveAiServerBaseUrl()}/api/mrp`;

/** MPS 相关端点基址（汇总 / RCCP / 确认 / 下推都在 /api/mps 下） */
export const resolveMpsApiBaseUrl = (): string => `${resolveAiServerBaseUrl()}/api/mps`;

/**
 * ai-server 全部端点已启用 JWT 鉴权（requireAuth）：身份以 Authorization 头为准，
 * 请求体里的 user_id 只做一致性校验。请求前统一在这里取 access_token。
 */
export const aiServerAuthHeaders = async (): Promise<Record<string, string>> => {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {};
};
