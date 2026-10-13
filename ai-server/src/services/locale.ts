/**
 * 界面语言归一。
 *
 * 前端把 i18n 语言（zh-CN / en-US）随请求带上，服务端据此决定：
 *   - 查询结果列名的翻译方向（services/columnLabels.ts）；
 *   - 工具回复文案用哪种语言（services/toolText.ts）。
 *
 * 只关心中 / 英两种；其余一律按中文兜底（本项目默认用户是中文用户）。
 */
export type UiLocale = "zh" | "en";

export const normalizeUiLocale = (locale?: string): UiLocale =>
  String(locale || "").toLowerCase().startsWith("en") ? "en" : "zh";

export const isEnglishLocale = (locale?: string): boolean =>
  normalizeUiLocale(locale) === "en";
