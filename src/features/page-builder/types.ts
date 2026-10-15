import dayjs from "dayjs";
import type { TFunction } from "i18next";

export type WidgetType =
  | "text"
  | "statistic"
  | "button"
  | "table"
  | "line"
  | "column"
  | "pie"
  | "divider"
  // ---- 增强组件（2026-10-15 新增） ----
  | "progressRing"
  | "gauge"
  | "scatter"
  | "linkage"
  | "ranking"
  | "carouselTable"
  | "liveStream"
  | "marquee"
  | "alertBanner"
  | "statusTag"
  | "clock";

export interface DataSourceConfig {
  mode: "static" | "supabase" | "baq";
  table?: string;
  select?: string;
  baqCode?: string;
  limit?: number;
  staticData?: unknown[];
}

export interface PageWidget {
  id: string;
  type: WidgetType;
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
  content?: string;
  dividerText?: string;
  dashed?: boolean;
  titlePlacement?: "center" | "start" | "end";
  orientation?: "horizontal" | "vertical";
  variant?: "dashed" | "dotted" | "solid";
  xField?: string;
  yField?: string;
  colorField?: string;
  pageSize?: number;
  dataSource: DataSourceConfig;

  // ------------------------------------------------------------------
  // 以下为增强组件通用配置，全部可选，缺省时按组件各自的内置默认值渲染
  // ------------------------------------------------------------------
  /** 第二数值字段：图表联动里柱状（主轴）与折线（副轴）各取一个字段 */
  y2Field?: string;
  /** 数值单位后缀，如 % / 万元 / 单 */
  unit?: string;
  /** 满值（进度环 / 仪表盘），默认 100 */
  maxValue?: number;
  /** 小数位，默认 0 */
  precision?: number;
  /** 自动播放 / 刷新间隔（秒），默认 5 */
  interval?: number;
  /** 是否自动播放（轮播表 / 滚动播报 / 告警轮播 / 实时流追加） */
  autoPlay?: boolean;
  /** 进度环形态 */
  ringShape?: "circle" | "dashboard";
  /** 滚动方向或布局方向 */
  scrollDirection?: "vertical" | "horizontal";
  /** 时钟时间格式（dayjs 格式串） */
  timeFormat?: string;
  /** 时钟日期格式（dayjs 格式串） */
  dateFormat?: string;
  /** 状态列字段（告警提示 / 状态标签） */
  statusField?: string;
  /** 状态 → 严重级别映射 JSON，如 {"已完成":"success"} */
  statusMap?: string;
  /** 展示条数（排行榜取前 N / 实时流保留 N / 播报取 N 条） */
  displayRows?: number;
  /** 强调色，留空跟随主题与内置调色板 */
  accentColor?: string;
}

export interface CustomPage {
  id?: number;
  name: string;
  slug: string;
  description?: string | null;
  status: "draft" | "published";
  menu_id?: number | null;
  config: { widgets: PageWidget[] };
  created_at?: string;
  updated_at?: string;
}

export type WidgetPreset = Omit<PageWidget, "id" | "type" | "x" | "y">;

/** 散点图演示数据：语言无关，用字母分组 */
function scatterDemo() {
  return Array.from({ length: 54 }, (_, index) => ({
    segment: ["A", "B", "C"][index % 3],
    cost: 18 + (index % 13) * 4,
    output: Math.round(60 + Math.sin(index / 2.6) * 26 + (index % 7) * 4),
  }));
}

/**
 * 图表联动演示数据：近 6 个月，柱=销售额、线=增长率。
 *
 * 字段名刻意用语言中立的 `value` / `growth`，坐标轴标题在渲染时再按
 * 当前语言给出，避免「创建时是中文，切到英文后字段名对不上」。
 */
function linkageDemo() {
  const values = [68, 82, 76, 95, 88, 108];
  return values.map((value, index) => ({
    month: dayjs()
      .subtract(values.length - 1 - index, "month")
      .format("MMM"),
    value,
    growth: Number((value * 0.6 - 28).toFixed(1)),
  }));
}

/**
 * 按当前语言生成组件默认配置。
 *
 * 原先的 `widgetDefaults` 是写死中文的常量，新组件一律走 i18n，
 * 因此改成工厂函数，由调用方注入 `t`。
 */
export function createWidgetDefaults(
  t: TFunction,
): Record<WidgetType, WidgetPreset> {
  return {
    text: {
      title: t("pageDesigner.widgetText"),
      content: t("pageDesigner.textPlaceholder"),
      w: 4,
      h: 2,
      dataSource: { mode: "static", staticData: [] },
    },
    statistic: {
      title: t("pageDesigner.widgetStatistic"),
      xField: "label",
      yField: "value",
      w: 3,
      h: 3,
      dataSource: {
        mode: "static",
        staticData: [
          { label: t("pageDesigner.demoMonthlySales"), value: 128600 },
        ],
      },
    },
    button: {
      title: t("pageDesigner.widgetButton"),
      content: t("pageDesigner.buttonPlaceholder"),
      w: 2,
      h: 2,
      dataSource: { mode: "static", staticData: [] },
    },
    table: {
      title: t("pageDesigner.widgetTable"),
      w: 6,
      h: 4,
      pageSize: 10,
      dataSource: {
        mode: "static",
        limit: 100,
        staticData: [
          { name: t("pageDesigner.demoEast"), value: 1280 },
          { name: t("pageDesigner.demoSouth"), value: 960 },
        ],
      },
    },
    line: {
      title: t("pageDesigner.widgetLine"),
      xField: "name",
      yField: "value",
      w: 6,
      h: 4,
      dataSource: {
        mode: "static",
        staticData: [
          { name: t("pageDesigner.demoJan"), value: 30 },
          { name: t("pageDesigner.demoFeb"), value: 52 },
          { name: t("pageDesigner.demoMar"), value: 45 },
          { name: t("pageDesigner.demoApr"), value: 68 },
        ],
      },
    },
    column: {
      title: t("pageDesigner.widgetColumn"),
      xField: "name",
      yField: "value",
      w: 6,
      h: 4,
      dataSource: {
        mode: "static",
        staticData: [
          { name: t("pageDesigner.demoEast"), value: 68 },
          { name: t("pageDesigner.demoSouth"), value: 46 },
          { name: t("pageDesigner.demoNorth"), value: 55 },
          { name: t("pageDesigner.demoWest"), value: 39 },
        ],
      },
    },
    pie: {
      title: t("pageDesigner.widgetPie"),
      colorField: "name",
      yField: "value",
      w: 5,
      h: 4,
      dataSource: {
        mode: "static",
        staticData: [
          { name: t("pageDesigner.demoStatusDone"), value: 72 },
          { name: t("pageDesigner.demoStatusDoing"), value: 20 },
          { name: t("pageDesigner.demoStatusPending"), value: 8 },
        ],
      },
    },
    divider: {
      title: t("pageDesigner.widgetDivider"),
      dividerText: t("pageDesigner.dividerPlaceholder"),
      dashed: false,
      titlePlacement: "center",
      orientation: "horizontal",
      variant: "solid",
      w: 6,
      h: 1,
      dataSource: { mode: "static", staticData: [] },
    },

    // ============================ 增强组件 ============================
    progressRing: {
      title: t("pageDesigner.widgetProgressRing"),
      xField: "label",
      yField: "value",
      maxValue: 100,
      precision: 0,
      unit: "%",
      ringShape: "circle",
      w: 4,
      h: 4,
      dataSource: {
        mode: "static",
        staticData: [
          { label: t("pageDesigner.demoAchievement"), value: 78 },
          { label: t("pageDesigner.demoOnTime"), value: 92 },
          { label: t("pageDesigner.demoTurnover"), value: 64 },
          { label: t("pageDesigner.demoCapacity"), value: 55 },
        ],
      },
    },
    gauge: {
      title: t("pageDesigner.widgetGauge"),
      xField: "label",
      yField: "value",
      maxValue: 100,
      precision: 0,
      unit: "%",
      w: 4,
      h: 4,
      dataSource: {
        mode: "static",
        staticData: [{ label: t("pageDesigner.demoOee"), value: 82 }],
      },
    },
    scatter: {
      title: t("pageDesigner.widgetScatter"),
      xField: "cost",
      yField: "output",
      colorField: "segment",
      w: 6,
      h: 4,
      dataSource: { mode: "static", staticData: scatterDemo() },
    },
    linkage: {
      title: t("pageDesigner.widgetLinkage"),
      xField: "month",
      yField: "value",
      y2Field: "growth",
      colorField: "month",
      w: 8,
      h: 5,
      dataSource: { mode: "static", staticData: linkageDemo() },
    },
    ranking: {
      title: t("pageDesigner.widgetRanking"),
      xField: "name",
      yField: "value",
      displayRows: 6,
      precision: 0,
      unit: t("pageDesigner.unitOrder"),
      w: 4,
      h: 5,
      dataSource: {
        mode: "static",
        staticData: [
          { name: t("pageDesigner.demoEast"), value: 1280 },
          { name: t("pageDesigner.demoSouth"), value: 964 },
          { name: t("pageDesigner.demoNorth"), value: 872 },
          { name: t("pageDesigner.demoCenter"), value: 736 },
          { name: t("pageDesigner.demoWest"), value: 548 },
          { name: t("pageDesigner.demoOversea"), value: 322 },
        ],
      },
    },
    carouselTable: {
      title: t("pageDesigner.widgetCarouselTable"),
      pageSize: 4,
      interval: 4,
      autoPlay: true,
      w: 8,
      h: 5,
      dataSource: {
        mode: "static",
        limit: 100,
        staticData: [
          {
            [t("pageDesigner.demoDocNo")]: "SO-2026-1001",
            [t("pageDesigner.demoCustomer")]: t("pageDesigner.demoEast"),
            [t("pageDesigner.demoAmount")]: 128000,
            [t("pageDesigner.demoStatus")]: t("pageDesigner.demoStatusDone"),
          },
          {
            [t("pageDesigner.demoDocNo")]: "SO-2026-1002",
            [t("pageDesigner.demoCustomer")]: t("pageDesigner.demoSouth"),
            [t("pageDesigner.demoAmount")]: 96000,
            [t("pageDesigner.demoStatus")]: t("pageDesigner.demoStatusDoing"),
          },
          {
            [t("pageDesigner.demoDocNo")]: "SO-2026-1003",
            [t("pageDesigner.demoCustomer")]: t("pageDesigner.demoNorth"),
            [t("pageDesigner.demoAmount")]: 87200,
            [t("pageDesigner.demoStatus")]: t("pageDesigner.demoStatusDone"),
          },
          {
            [t("pageDesigner.demoDocNo")]: "SO-2026-1004",
            [t("pageDesigner.demoCustomer")]: t("pageDesigner.demoCenter"),
            [t("pageDesigner.demoAmount")]: 73600,
            [t("pageDesigner.demoStatus")]: t("pageDesigner.demoStatusPending"),
          },
          {
            [t("pageDesigner.demoDocNo")]: "SO-2026-1005",
            [t("pageDesigner.demoCustomer")]: t("pageDesigner.demoWest"),
            [t("pageDesigner.demoAmount")]: 54800,
            [t("pageDesigner.demoStatus")]: t("pageDesigner.demoStatusDoing"),
          },
          {
            [t("pageDesigner.demoDocNo")]: "SO-2026-1006",
            [t("pageDesigner.demoCustomer")]: t("pageDesigner.demoOversea"),
            [t("pageDesigner.demoAmount")]: 32200,
            [t("pageDesigner.demoStatus")]: t("pageDesigner.demoStatusBlocked"),
          },
        ],
      },
    },
    liveStream: {
      title: t("pageDesigner.widgetLiveStream"),
      xField: "event",
      statusField: "level",
      interval: 5,
      autoPlay: true,
      displayRows: 8,
      w: 6,
      h: 5,
      dataSource: {
        mode: "static",
        staticData: [
          { event: t("pageDesigner.demoOrderCreated"), level: "info" },
          { event: t("pageDesigner.demoPurchaseIn"), level: "success" },
          { event: t("pageDesigner.demoOrderShipped"), level: "success" },
          { event: t("pageDesigner.demoInventoryWarn"), level: "warning" },
          { event: t("pageDesigner.demoProdReport"), level: "info" },
          { event: t("pageDesigner.demoQualityPass"), level: "success" },
          { event: t("pageDesigner.demoApprovalPending"), level: "warning" },
        ],
      },
    },
    marquee: {
      title: t("pageDesigner.widgetMarquee"),
      xField: "text",
      displayRows: 3,
      interval: 12,
      autoPlay: true,
      scrollDirection: "vertical",
      w: 12,
      h: 3,
      dataSource: {
        mode: "static",
        staticData: [
          { text: t("pageDesigner.demoAlertStock") },
          { text: t("pageDesigner.demoAlertOverdue") },
          { text: t("pageDesigner.demoAlertApproval") },
          { text: t("pageDesigner.demoAlertMaintenance") },
        ],
      },
    },
    alertBanner: {
      title: t("pageDesigner.widgetAlertBanner"),
      xField: "message",
      statusField: "level",
      interval: 5,
      autoPlay: true,
      w: 12,
      h: 3,
      dataSource: {
        mode: "static",
        staticData: [
          { message: t("pageDesigner.demoAlertOverdue"), level: "error" },
          { message: t("pageDesigner.demoAlertStock"), level: "warning" },
          { message: t("pageDesigner.demoAlertApproval"), level: "info" },
          { message: t("pageDesigner.demoAlertMaintenance"), level: "warning" },
        ],
      },
    },
    statusTag: {
      title: t("pageDesigner.widgetStatusTag"),
      xField: "name",
      statusField: "status",
      w: 6,
      h: 4,
      dataSource: {
        mode: "static",
        staticData: [
          {
            name: t("pageDesigner.demoLineA"),
            status: t("pageDesigner.demoStatusDoing"),
          },
          {
            name: t("pageDesigner.demoLineB"),
            status: t("pageDesigner.demoStatusDone"),
          },
          {
            name: t("pageDesigner.demoLineC"),
            status: t("pageDesigner.demoStatusPending"),
          },
          {
            name: t("pageDesigner.demoLineD"),
            status: t("pageDesigner.demoStatusBlocked"),
          },
          {
            name: t("pageDesigner.demoLineE"),
            status: t("pageDesigner.demoStatusDone"),
          },
          {
            name: t("pageDesigner.demoLineF"),
            status: t("pageDesigner.demoStatusDoing"),
          },
        ],
      },
    },
    clock: {
      title: t("pageDesigner.widgetClock"),
      timeFormat: "HH:mm:ss",
      dateFormat: "YYYY-MM-DD dddd",
      w: 4,
      h: 3,
      dataSource: { mode: "static", staticData: [] },
    },
  };
}
