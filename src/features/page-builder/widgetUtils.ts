import { useEffect, useRef, useState } from "react";
import type { PageWidget } from "./types";

/** 组件在画布上的行高与间距，必须与 PageCanvas 里的 GridLayout 保持一致 */
export const GRID_ROW_HEIGHT = 48;
export const GRID_MARGIN = 12;
export const CARD_BODY_MIN_HEIGHT = 48;

/** 卡片标题栏 + 内边距吃掉的高度，图表按剩余空间自适应 */
export function getChartHeight(widget: PageWidget) {
  const totalHeight =
    widget.h * GRID_ROW_HEIGHT + Math.max(0, widget.h - 1) * GRID_MARGIN;
  return Math.max(180, totalHeight - 44 - CARD_BODY_MIN_HEIGHT);
}

/** 容器宽度监听，交给 G2 / SVG 自绘组件做自适应 */
export function useElementWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const update = () => setWidth(element.getBoundingClientRect().width);
    update();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", update);
      return () => window.removeEventListener("resize", update);
    }

    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return { ref, width };
}

/** 把任意单元格值安全地转成数字 */
export function asNumber(value: unknown): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

/** 千分位 + 固定小数位，语言跟随界面语言 */
export function formatNumber(
  value: number,
  precision = 0,
  locale?: string,
): string {
  try {
    return value.toLocaleString(locale, {
      minimumFractionDigits: precision,
      maximumFractionDigits: precision,
    });
  } catch {
    return value.toFixed(precision);
  }
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

// ---------------------------------------------------------------------------
// 状态语义
// ---------------------------------------------------------------------------

export type StatusLevel = "success" | "info" | "warning" | "error";

const LEVEL_KEYWORDS: Record<StatusLevel, string[]> = {
  success: [
    "success",
    "ok",
    "done",
    "finished",
    "approved",
    "active",
    "enabled",
    "passed",
    "已完成",
    "完成",
    "正常",
    "通过",
    "已通过",
    "启用",
    "已发货",
    "成功",
  ],
  warning: [
    "warning",
    "warn",
    "pending",
    "processing",
    "doing",
    "partial",
    "overdue",
    "进行中",
    "处理中",
    "待",
    "预警",
    "部分",
    "超期",
    "逾期",
  ],
  error: [
    "error",
    "fail",
    "failed",
    "blocked",
    "rejected",
    "disabled",
    "danger",
    "异常",
    "失败",
    "拒绝",
    "已拒绝",
    "阻塞",
    "停用",
    "禁用",
    "报废",
  ],
  info: ["info", "new", "draft", "信息", "新建", "草稿", "提示"],
};

/** 解析用户自定义的状态映射 JSON，容错到「解析失败就当没配」 */
export function parseStatusMap(raw?: string): Record<string, StatusLevel> {
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: Record<string, StatusLevel> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (
        value === "success" ||
        value === "info" ||
        value === "warning" ||
        value === "error"
      ) {
        result[key] = value;
      }
    }
    return result;
  } catch {
    return {};
  }
}

/**
 * 推断状态语义级别：
 * 1. 用户显式配置的映射优先（精确匹配）
 * 2. 否则按中英文关键词模糊匹配
 * 3. 都不命中则回落 info
 *
 * `matched` 表示前两步是否命中——状态标签据此决定「按语义着色」还是
 * 「按文本哈希取品牌色」，避免所有未识别状态都是一片蓝。
 */
export function resolveStatus(
  raw: unknown,
  statusMap?: Record<string, StatusLevel>,
): { level: StatusLevel; matched: boolean } {
  const text = raw === null || raw === undefined ? "" : String(raw).trim();
  if (!text) return { level: "info", matched: false };

  const mapped = statusMap?.[text];
  if (mapped) return { level: mapped, matched: true };

  const lower = text.toLowerCase();
  for (const level of ["error", "warning", "success", "info"] as StatusLevel[]) {
    if (LEVEL_KEYWORDS[level].some((keyword) => lower.includes(keyword))) {
      return { level, matched: true };
    }
  }
  return { level: "info", matched: false };
}

export function resolveStatusLevel(
  raw: unknown,
  statusMap?: Record<string, StatusLevel>,
): StatusLevel {
  return resolveStatus(raw, statusMap).level;
}

/** 状态标签在级别未知时使用的品牌色板 */
const TAG_PALETTE = [
  "#1677ff",
  "#13c2c2",
  "#722ed1",
  "#fa8c16",
  "#eb2f96",
  "#2f54eb",
  "#a0d911",
];

/** 语义级别对应色（状态标签 / 实时流圆点 / 告警圆点共用） */
export const LEVEL_COLORS: Record<StatusLevel, string> = {
  success: "#52c41a",
  info: "#1677ff",
  warning: "#faad14",
  error: "#ff4d4f",
};

/** 把十六进制色转成带透明度的 rgba，用于柔和底色 */
export function withAlpha(color: string, alpha: number): string {
  const hex = color.replace("#", "");
  if (hex.length !== 6) return color;
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function hashToTagColor(text: string): string {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) % 100000;
  }
  return TAG_PALETTE[hash % TAG_PALETTE.length];
}

// ---------------------------------------------------------------------------
// 进度 / 仪表盘配色
// ---------------------------------------------------------------------------

export const RING_GRADIENTS: Array<[string, string]> = [
  ["#69b1ff", "#1677ff"],
  ["#5cdbd3", "#13c2c2"],
  ["#b37feb", "#722ed1"],
  ["#95de64", "#52c41a"],
  ["#ffc069", "#fa8c16"],
];

export const RING_GRADIENTS_DARK: Array<[string, string]> = [
  ["#85a5ff", "#2f54eb"],
  ["#5cdbd3", "#08979c"],
  ["#b37feb", "#531dab"],
  ["#95de64", "#389e0d"],
  ["#ffc069", "#d46b08"],
];

export function pickGradient(
  dark: boolean,
  index: number,
  accent?: string,
): [string, string] {
  if (accent) return [accent, accent];
  const palette = dark ? RING_GRADIENTS_DARK : RING_GRADIENTS;
  return palette[index % palette.length];
}

/** 主题强调色（用于自绘 SVG，CSS 变量在 SVG 属性上不生效） */
export function accentColor(dark: boolean, override?: string): string {
  if (override) return override;
  return dark ? "#4096ff" : "#1677ff";
}
