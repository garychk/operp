import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { Alert, Empty, Progress, Select, Table, Tag } from "antd";
import { ReloadOutlined, SoundOutlined } from "@ant-design/icons";
import { DualAxes, Scatter } from "@ant-design/charts";
import type { DualAxesConfig, ScatterConfig } from "@ant-design/charts";
import dayjs from "dayjs";
import { useErpDarkMode } from "../../hooks/useErpDarkMode";
import type { PageWidget } from "./types";
import {
  LEVEL_COLORS,
  asNumber,
  clamp,
  formatNumber,
  getChartHeight,
  hashToTagColor,
  parseStatusMap,
  pickGradient,
  resolveStatus,
  resolveStatusLevel,
  useElementWidth,
  withAlpha,
  type StatusLevel,
} from "./widgetUtils";

export interface WidgetProps {
  widget: PageWidget;
  data: Record<string, unknown>[];
  /** 远程数据源下由宿主组件触发的重新拉取 */
  onRefresh?: () => void;
}

/**
 * AntV 图表配置是 G2 巨型联合类型，逐字段标注冗长且随版本漂移。
 * 与 Dashboard 的做法一致：把类型风险收敛在这一个函数里。
 */
function chartProps<T>(config: Record<string, unknown>): T {
  return config as unknown as T;
}

function useLocale(): string {
  const { i18n } = useTranslation();
  return i18n.resolvedLanguage === "en-US" ? "en-US" : "zh-CN";
}

/** 表格 / 明细流里的单元格值统一转成可读文本 */
function formatCell(value: unknown, locale: string): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "number") return formatNumber(value, 0, locale);
  if (typeof value === "boolean") return String(value);
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

// ===========================================================================
// 进度环
// ===========================================================================

export function ProgressRingWidget({ widget, data }: WidgetProps) {
  const dark = useErpDarkMode();
  const locale = useLocale();
  const { ref, width } = useElementWidth<HTMLDivElement>();
  const height = getChartHeight(widget);

  const valueField = widget.yField || "value";
  const labelField = widget.xField || "label";
  const max = widget.maxValue && widget.maxValue > 0 ? widget.maxValue : 100;
  const precision = widget.precision ?? 0;

  const items = useMemo(
    () =>
      data.map((row, index) => {
        const value = asNumber(row[valueField]);
        return {
          key: `${index}`,
          label: String(row[labelField] ?? widget.title),
          value,
          percent: clamp((value / max) * 100, 0, 100),
          gradient: pickGradient(dark, index, widget.accentColor),
        };
      }),
    [data, valueField, labelField, max, dark, widget.accentColor, widget.title],
  );

  const single = items.length <= 1;
  const columns = single
    ? 1
    : clamp(Math.floor((width || 320) / 130), 1, 4);
  const rows = Math.ceil(items.length / columns);
  const ringSize = single
    ? clamp(Math.min((width || 260) - 24, height - 30), 96, 200)
    : clamp(
        Math.min((width || 320) / columns - 24, height / rows - 42),
        54,
        116,
      );

  return (
    <div
      ref={ref}
      className={`pb-ring${single ? " is-single" : ""}`}
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
    >
      {items.map((item) => (
        <div className="pb-ring-cell" key={item.key}>
          <Progress
            type={widget.ringShape === "dashboard" ? "dashboard" : "circle"}
            percent={Number(item.percent.toFixed(1))}
            size={Math.round(ringSize)}
            strokeWidth={single ? 9 : 7}
            strokeLinecap="round"
            strokeColor={{ "0%": item.gradient[0], "100%": item.gradient[1] }}
            railColor={dark ? "rgba(255, 255, 255, 0.10)" : "rgba(17, 24, 39, 0.07)"}
            format={() => (
              <span className="pb-ring-value">
                <span className="pb-ring-num">
                  {formatNumber(item.value, precision, locale)}
                </span>
                {widget.unit ? (
                  <span className="pb-ring-unit">{widget.unit}</span>
                ) : null}
              </span>
            )}
          />
          <span className="pb-ring-label" title={item.label}>
            {item.label}
          </span>
        </div>
      ))}
    </div>
  );
}

// ===========================================================================
// 仪表盘（自绘 SVG，避免 G2 gauge 的数据契约差异）
// ===========================================================================

const GAUGE_START_ANGLE = 135;
const GAUGE_SWEEP_ANGLE = 270;

function polarPoint(
  cx: number,
  cy: number,
  radius: number,
  degree: number,
): { x: number; y: number } {
  const radian = (degree * Math.PI) / 180;
  return { x: cx + radius * Math.cos(radian), y: cy + radius * Math.sin(radian) };
}

function arcPath(
  cx: number,
  cy: number,
  radius: number,
  startDegree: number,
  endDegree: number,
): string {
  const start = polarPoint(cx, cy, radius, startDegree);
  const end = polarPoint(cx, cy, radius, endDegree);
  const largeArc = endDegree - startDegree > 180 ? 1 : 0;
  return `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${radius} ${radius} 0 ${largeArc} 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
}

export function GaugeWidget({ widget, data }: WidgetProps) {
  const dark = useErpDarkMode();
  const locale = useLocale();
  const { ref, width } = useElementWidth<HTMLDivElement>();
  const rawId = useId();
  const gradientId = `pb-gauge-${rawId.replace(/[^a-zA-Z0-9]/g, "")}`;
  const height = getChartHeight(widget);

  const row = data[0] ?? {};
  const valueField = widget.yField || "value";
  const labelField = widget.xField || "label";
  const max = widget.maxValue && widget.maxValue > 0 ? widget.maxValue : 100;
  const precision = widget.precision ?? 0;
  const value = asNumber(row[valueField]);
  const ratio = clamp(value / max, 0, 1);
  const label = String(row[labelField] ?? widget.title);

  const size = Math.round(clamp(Math.min(width || 260, height || 220), 140, 320));
  const stroke = clamp(size * 0.075, 10, 22);
  const center = size / 2;
  const radius = center - stroke / 2 - 6;

  const [fromColor, toColor] = pickGradient(dark, 0, widget.accentColor);
  const trackColor = dark ? "rgba(255, 255, 255, 0.10)" : "rgba(17, 24, 39, 0.07)";
  const tickColor = dark ? "rgba(255, 255, 255, 0.26)" : "rgba(17, 24, 39, 0.22)";
  const textColor = dark ? "#e6e8eb" : "#1f2329";
  const mutedColor = dark ? "rgba(230, 232, 235, 0.62)" : "rgba(31, 35, 41, 0.62)";

  return (
    <div ref={ref} className="pb-gauge">
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={`${label} ${formatNumber(value, precision, locale)}`}
      >
        <defs>
          <linearGradient id={gradientId} x1="0%" y1="100%" x2="100%" y2="0%">
            <stop offset="0%" stopColor={fromColor} />
            <stop offset="100%" stopColor={toColor} />
          </linearGradient>
        </defs>

        <path
          d={arcPath(
            center,
            center,
            radius,
            GAUGE_START_ANGLE,
            GAUGE_START_ANGLE + GAUGE_SWEEP_ANGLE,
          )}
          fill="none"
          stroke={trackColor}
          strokeWidth={stroke}
          strokeLinecap="round"
        />

        {ratio > 0.004 && (
          <path
            d={arcPath(
              center,
              center,
              radius,
              GAUGE_START_ANGLE,
              GAUGE_START_ANGLE + GAUGE_SWEEP_ANGLE * ratio,
            )}
            fill="none"
            stroke={`url(#${gradientId})`}
            strokeWidth={stroke}
            strokeLinecap="round"
          />
        )}

        {[0, 0.25, 0.5, 0.75, 1].map((step) => {
          const degree = GAUGE_START_ANGLE + GAUGE_SWEEP_ANGLE * step;
          const outer = polarPoint(center, center, radius + stroke / 2 + 3, degree);
          const inner = polarPoint(center, center, radius + stroke / 2 - 3, degree);
          return (
            <line
              key={step}
              x1={inner.x.toFixed(2)}
              y1={inner.y.toFixed(2)}
              x2={outer.x.toFixed(2)}
              y2={outer.y.toFixed(2)}
              stroke={tickColor}
              strokeWidth={1.5}
              strokeLinecap="round"
            />
          );
        })}

        <text
          x={center}
          y={center - size * 0.02}
          textAnchor="middle"
          dominantBaseline="middle"
          fill={textColor}
          fontSize={size * 0.2}
          fontWeight={700}
        >
          {formatNumber(value, precision, locale)}
          {widget.unit ? (
            <tspan fontSize={size * 0.1} dx={2} fill={mutedColor}>
              {widget.unit}
            </tspan>
          ) : null}
        </text>
        <text
          x={center}
          y={center + size * 0.17}
          textAnchor="middle"
          dominantBaseline="middle"
          fill={mutedColor}
          fontSize={size * 0.072}
        >
          {label.length > 16 ? `${label.slice(0, 15)}…` : label}
        </text>
        <text
          x={center}
          y={center + size * 0.3}
          textAnchor="middle"
          dominantBaseline="middle"
          fill={mutedColor}
          fontSize={size * 0.062}
        >
          {`${formatNumber(ratio * 100, 1, locale)}%`}
        </text>
      </svg>
    </div>
  );
}

// ===========================================================================
// 散点图
// ===========================================================================

export function ScatterWidget({ widget, data }: WidgetProps) {
  const dark = useErpDarkMode();
  const { ref, width } = useElementWidth<HTMLDivElement>();
  const height = getChartHeight(widget);
  const xField = widget.xField || "x";
  const yField = widget.yField || "y";
  const colorField = widget.colorField || undefined;

  const config = useMemo(
    () =>
      chartProps<ScatterConfig>({
        data,
        xField,
        yField,
        colorField,
        height,
        width: Math.max(0, Math.floor(width)),
        autoFit: true,
        theme: dark ? "classicDark" : "classic",
        shapeField: "circle",
        style: { fillOpacity: 0.68 },
        axis: { x: { title: false }, y: { title: false } },
        legend: colorField
          ? {
              color: {
                position: "top",
                layout: { justifyContent: "flex-end" },
              },
            }
          : false,
      }),
    [data, xField, yField, colorField, height, width, dark],
  );

  return (
    <div ref={ref} className="chart-widget">
      <Scatter {...config} />
    </div>
  );
}

// ===========================================================================
// 图表联动（柱 + 折线双轴，点击 / 选择分类后联动折线）
// ===========================================================================

/** G2 原始事件里的图形节点结构（只取我们用到的字段） */
interface G2EventTarget {
  className?: string;
  parentNode?: G2EventTarget;
  __data__?: { index?: number };
}

export function LinkageWidget({ widget, data }: WidgetProps) {
  const dark = useErpDarkMode();
  const { t } = useTranslation();
  const { ref, width } = useElementWidth<HTMLDivElement>();
  const height = getChartHeight(widget);

  const xField = widget.xField || "name";
  const barField = widget.yField || "value";
  const lineField = widget.y2Field || "growth";

  const [focused, setFocused] = useState("");

  const categories = useMemo(
    () =>
      data
        .map((row) => String(row[xField] ?? ""))
        .filter((value) => value.length > 0),
    [data, xField],
  );

  useEffect(() => {
    if (focused && !categories.includes(focused)) setFocused("");
  }, [categories, focused]);

  const lineData = useMemo(
    () =>
      focused
        ? data.filter((row) => String(row[xField]) === focused)
        : data,
    [data, focused, xField],
  );

  const xFieldRef = useRef(xField);
  xFieldRef.current = xField;
  const dataRef = useRef(data);
  dataRef.current = data;

  /**
   * 图表点击联动：plots 的 onEvent 透传的是 G2 Runtime 的原始 click
   * 事件（复合视图下 mark 级事件不冒泡），因此从事件 target 向上找到
   * className 为 element 的图形根节点，读取其 __data__.index 回查数据；
   * 点中空白绘图区（plot）时重置联动。拿不到索引时静默降级为选择器联动。
   */
  const handleChartEvent = useCallback(
    (_chart: unknown, event: unknown) => {
      const raw = event as
        | { type?: string; target?: G2EventTarget }
        | undefined;
      if (!raw || raw.type !== "click") return;

      let node = raw.target;
      while (node) {
        if (node.className === "element") {
          const index = node.__data__?.index;
          const datum =
            typeof index === "number" ? dataRef.current[index] : undefined;
          const key = datum?.[xFieldRef.current];
          if (key !== undefined && key !== null) setFocused(String(key));
          return;
        }
        if (node.className === "plot") {
          setFocused("");
          return;
        }
        node = node.parentNode;
      }
    },
    [],
  );

  const baseFill = dark ? "#3b82f6" : "#1677ff";
  const dimFill = dark ? "rgba(59, 130, 246, 0.28)" : "rgba(22, 119, 255, 0.22)";
  const lineColor = dark ? "#fbbf24" : "#fa8c16";

  const config = useMemo(
    () =>
      chartProps<DualAxesConfig>({
        height,
        width: Math.max(0, Math.floor(width)),
        autoFit: true,
        theme: dark ? "classicDark" : "classic",
        scale: { y: { independent: true, nice: true } },
        axis: { x: { title: false } },
        legend: false,
        children: [
          {
            type: "interval",
            data,
            xField,
            yField: barField,
            axis: { y: { title: t("pageDesigner.valueField") } },
            style: {
              radiusTopLeft: 4,
              radiusTopRight: 4,
              fill: (datum: Record<string, unknown> | undefined) => {
                if (!focused) return baseFill;
                return String(datum?.[xField] ?? "") === focused
                  ? baseFill
                  : dimFill;
              },
            },
          },
          {
            type: "line",
            data: lineData,
            xField,
            yField: lineField,
            smooth: true,
            axis: { y: { position: "right", title: t("pageDesigner.secondValueField") } },
            style: { stroke: lineColor, lineWidth: 2.5 },
          },
        ],
      }),
    [
      height,
      width,
      dark,
      data,
      lineData,
      xField,
      barField,
      lineField,
      focused,
      baseFill,
      dimFill,
      lineColor,
      t,
    ],
  );

  return (
    <div className="pb-linkage">
      <div className="pb-linkage-bar">
        <Select
          size="small"
          value={focused || "__all__"}
          style={{ minWidth: 132 }}
          onChange={(value) => setFocused(value === "__all__" ? "" : value)}
          options={[
            { value: "__all__", label: t("pageRenderer.linkageAll") },
            ...categories.map((category) => ({
              value: category,
              label: category,
            })),
          ]}
        />
        <span className="pb-linkage-hint">
          {t("pageRenderer.linkageHint")}
        </span>
        {focused && (
          <button
            type="button"
            className="pb-linkage-reset"
            onClick={() => setFocused("")}
          >
            <ReloadOutlined /> {t("pageRenderer.linkageReset")}
          </button>
        )}
      </div>
      <div ref={ref} className="chart-widget">
        <DualAxes {...config} onEvent={handleChartEvent} />
      </div>
    </div>
  );
}

// ===========================================================================
// 排行榜
// ===========================================================================

export function RankingWidget({ widget, data }: WidgetProps) {
  const dark = useErpDarkMode();
  const locale = useLocale();

  const xField = widget.xField || "name";
  const yField = widget.yField || "value";
  const precision = widget.precision ?? 0;
  const limit = Math.max(1, widget.displayRows || 8);

  const items = useMemo(
    () =>
      data
        .map((row) => ({
          name: String(row[xField] ?? "—"),
          value: asNumber(row[yField]),
        }))
        .sort((left, right) => right.value - left.value)
        .slice(0, limit),
    [data, xField, yField, limit],
  );

  const topValue = Math.max(...items.map((item) => item.value), 1);

  return (
    <div className="pb-rank">
      {items.map((item, index) => {
        const [from, to] = pickGradient(dark, index, widget.accentColor);
        const percent = clamp((item.value / topValue) * 100, 3, 100);
        return (
          <div className="pb-rank-row" key={`${item.name}-${index}`}>
            <span
              className={`pb-rank-badge${index < 3 ? ` is-top${index + 1}` : ""}`}
            >
              {index + 1}
            </span>
            <div className="pb-rank-main">
              <div className="pb-rank-head">
                <span className="pb-rank-name" title={item.name}>
                  {item.name}
                </span>
                <span className="pb-rank-value">
                  {formatNumber(item.value, precision, locale)}
                  {widget.unit ? (
                    <span className="pb-rank-unit">{widget.unit}</span>
                  ) : null}
                </span>
              </div>
              <div className="pb-rank-track">
                <div
                  className="pb-rank-bar"
                  style={{
                    width: `${percent}%`,
                    background: `linear-gradient(90deg, ${from}, ${to})`,
                  }}
                />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ===========================================================================
// 轮播表
// ===========================================================================

export function CarouselTableWidget({ widget, data }: WidgetProps) {
  const { t } = useTranslation();
  const locale = useLocale();

  const pageSize = Math.max(1, widget.pageSize || 5);
  const autoPlay = widget.autoPlay !== false;
  const interval = Math.max(1, widget.interval || 5);
  const totalPages = Math.max(1, Math.ceil(data.length / pageSize));

  const [page, setPage] = useState(0);

  useEffect(() => {
    setPage(0);
  }, [data.length, pageSize]);

  useEffect(() => {
    if (!autoPlay || totalPages <= 1) return;
    const timer = window.setInterval(
      () => setPage((current) => (current + 1) % totalPages),
      interval * 1000,
    );
    return () => window.clearInterval(timer);
  }, [autoPlay, interval, totalPages]);

  const columns = useMemo(
    () =>
      Object.keys(data[0] ?? {})
        .slice(0, 6)
        .map((key) => ({
          title: key,
          dataIndex: key,
          key,
          ellipsis: true,
          render: (value: unknown) => (
            <span className="pb-cell">{formatCell(value, locale)}</span>
          ),
        })),
    [data, locale],
  );

  const rows = useMemo(
    () =>
      data.slice(page * pageSize, page * pageSize + pageSize).map((row, index) => ({
        ...row,
        __rowKey: `${page}-${index}`,
      })),
    [data, page, pageSize],
  );

  return (
    <div className="pb-carousel">
      <div className="pb-carousel-body" key={page}>
        <Table
          className="pb-carousel-table"
          size="small"
          rowKey="__rowKey"
          columns={columns}
          dataSource={rows}
          pagination={false}
          scroll={{ x: true }}
        />
      </div>
      <div className="pb-carousel-foot">
        <span className="pb-carousel-page">
          {t("pageRenderer.carouselPage", {
            current: Math.min(page + 1, totalPages),
            total: totalPages,
          })}
        </span>
        {totalPages > 1 && (
          <span className="pb-dots">
            {Array.from({ length: totalPages }).map((_, index) => (
              <button
                key={index}
                type="button"
                aria-label={`${index + 1}`}
                className={`pb-dot${index === page ? " is-active" : ""}`}
                onClick={() => setPage(index)}
              />
            ))}
          </span>
        )}
      </div>
    </div>
  );
}

// ===========================================================================
// 实时明细流
// ===========================================================================

interface StreamItem {
  id: string;
  text: string;
  level: StatusLevel;
  time: string;
}

export function LiveStreamWidget({ widget, data, onRefresh }: WidgetProps) {
  const { t } = useTranslation();
  const autoPlay = widget.autoPlay !== false;
  const interval = Math.max(2, widget.interval || 5);
  const keep = Math.max(1, widget.displayRows || 8);
  const textField = widget.xField || "event";
  const statusField = widget.statusField || "level";
  const isStatic = widget.dataSource.mode === "static";
  const statusMap = useMemo(
    () => parseStatusMap(widget.statusMap),
    [widget.statusMap],
  );

  const [feed, setFeed] = useState<StreamItem[]>([]);
  const cursor = useRef(0);

  // 数据到达时重建时间轴；已出现过的条目保留首次出现时间，避免刷新后整屏跳变
  useEffect(() => {
    setFeed((previous) => {
      const timestamps = new Map(previous.map((item) => [item.text, item.time]));
      return data.slice(0, keep).map((row, index) => {
        const text = String(row[textField] ?? "");
        return {
          id: `${index}-${text}`,
          text,
          level: resolveStatusLevel(row[statusField], statusMap),
          time: timestamps.get(text) ?? dayjs().format("HH:mm:ss"),
        };
      });
    });
  }, [data, textField, statusField, keep, statusMap]);

  // 静态数据源：本地循环推送，模拟实时流入
  useEffect(() => {
    if (!autoPlay || !isStatic || data.length === 0) return;
    const timer = window.setInterval(() => {
      setFeed((previous) => {
        const next = data[cursor.current % data.length];
        cursor.current += 1;
        const text = String(next[textField] ?? "");
        return [
          {
            id: `sim-${Date.now()}`,
            text,
            level: resolveStatusLevel(next[statusField], statusMap),
            time: dayjs().format("HH:mm:ss"),
          },
          ...previous,
        ].slice(0, keep);
      });
    }, interval * 1000);
    return () => window.clearInterval(timer);
  }, [
    autoPlay,
    isStatic,
    data,
    textField,
    statusField,
    statusMap,
    keep,
    interval,
  ]);

  // 远程数据源：按间隔重新拉取
  useEffect(() => {
    if (!autoPlay || isStatic || !onRefresh) return;
    const timer = window.setInterval(() => onRefresh(), interval * 1000);
    return () => window.clearInterval(timer);
  }, [autoPlay, isStatic, interval, onRefresh]);

  return (
    <div className="pb-stream">
      <div className="pb-stream-head">
        <span className="pb-live">
          <span className="pb-live-dot" />
          {t("pageRenderer.liveBadge")}
        </span>
        <span className="pb-stream-count">
          {t("pageRenderer.streamCount", { count: feed.length })}
        </span>
      </div>
      <div className="pb-stream-list">
        {feed.map((item, index) => (
          <div
            className={`pb-stream-item pb-level-${item.level}`}
            key={item.id}
            style={{ animationDelay: `${Math.min(index, 6) * 45}ms` }}
          >
            <span className="pb-stream-time">{item.time}</span>
            <span
              className="pb-stream-dot"
              style={{ background: LEVEL_COLORS[item.level] }}
            />
            <span className="pb-stream-text" title={item.text}>
              {item.text}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ===========================================================================
// 滚动播报
// ===========================================================================

export function MarqueeWidget({ widget, data }: WidgetProps) {
  const { t } = useTranslation();
  const textField = widget.xField || "text";
  const rows = clamp(widget.displayRows || 3, 1, 6);
  const duration = Math.max(4, widget.interval || 12);
  const autoPlay = widget.autoPlay !== false;
  const vertical = (widget.scrollDirection ?? "vertical") === "vertical";

  const texts = useMemo(
    () =>
      data
        .map((row) => String(row[textField] ?? ""))
        .filter((text) => text.length > 0),
    [data, textField],
  );

  if (!texts.length) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  }

  // 无缝滚动需要两份内容首尾相接；暂停时只渲染一份，避免出现重复文字
  const track = autoPlay ? [...texts, ...texts] : texts;

  return (
    <div className={`pb-marquee${vertical ? " is-vertical" : " is-horizontal"}`}>
      <span className="pb-marquee-badge" title={t("pageDesigner.widgetMarquee")}>
        <SoundOutlined />
      </span>
      <div
        className="pb-marquee-viewport"
        style={vertical ? { height: rows * 32 } : undefined}
      >
        <div
          className="pb-marquee-track"
          style={{
            animationDuration: `${duration}s`,
            animationPlayState: autoPlay ? "running" : "paused",
          }}
        >
          {track.map((text, index) => (
            <div className="pb-marquee-item" key={`${index}-${text}`}>
              <span className="pb-marquee-dot" />
              <span className="pb-marquee-text" title={text}>
                {text}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ===========================================================================
// 告警提示
// ===========================================================================

export function AlertBannerWidget({ widget, data }: WidgetProps) {
  const { t } = useTranslation();
  const messageField = widget.xField || "message";
  const levelField = widget.statusField || "level";
  const autoPlay = widget.autoPlay !== false;
  const interval = Math.max(2, widget.interval || 5);
  const statusMap = useMemo(
    () => parseStatusMap(widget.statusMap),
    [widget.statusMap],
  );

  const items = useMemo(
    () =>
      data
        .map((row) => ({
          text: String(row[messageField] ?? ""),
          level: resolveStatusLevel(row[levelField], statusMap),
        }))
        .filter((item) => item.text.length > 0),
    [data, messageField, levelField, statusMap],
  );

  const [index, setIndex] = useState(0);

  useEffect(() => {
    setIndex(0);
  }, [items.length]);

  useEffect(() => {
    if (!autoPlay || items.length <= 1) return;
    const timer = window.setInterval(
      () => setIndex((current) => (current + 1) % items.length),
      interval * 1000,
    );
    return () => window.clearInterval(timer);
  }, [autoPlay, interval, items.length]);

  if (!items.length) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  }

  const current = items[Math.min(index, items.length - 1)];

  return (
    <div className="pb-alert">
      <div className="pb-alert-body" key={index}>
        <Alert
          banner
          showIcon
          type={current.level}
          title={current.text}
        />
      </div>
      {items.length > 1 && (
        <div className="pb-alert-foot">
          <span className="pb-alert-count">
            {t("pageRenderer.alertCount", {
              current: index + 1,
              total: items.length,
            })}
          </span>
          <span className="pb-dots">
            {items.map((item, dotIndex) => (
              <button
                key={dotIndex}
                type="button"
                aria-label={`${dotIndex + 1}`}
                className={`pb-dot${dotIndex === index ? " is-active" : ""}`}
                style={{ background: LEVEL_COLORS[item.level] }}
                onClick={() => setIndex(dotIndex)}
              />
            ))}
          </span>
        </div>
      )}
    </div>
  );
}

// ===========================================================================
// 状态标签
// ===========================================================================

export function StatusTagWidget({ widget, data }: WidgetProps) {
  const nameField = widget.xField || "name";
  const statusField = widget.statusField || "status";
  const statusMap = useMemo(
    () => parseStatusMap(widget.statusMap),
    [widget.statusMap],
  );

  const items = useMemo(
    () =>
      data.map((row, index) => {
        const raw = row[statusField];
        const text = raw === null || raw === undefined ? "" : String(raw);
        const { level, matched } = resolveStatus(raw, statusMap);
        return {
          key: `${index}`,
          name: String(row[nameField] ?? ""),
          text,
          color: matched ? LEVEL_COLORS[level] : hashToTagColor(text),
        };
      }),
    [data, nameField, statusField, statusMap],
  );

  return (
    <div className="pb-statustag">
      {items.map((item) => (
        <div className="pb-statustag-item" key={item.key}>
          {item.name && (
            <span className="pb-statustag-name" title={item.name}>
              {item.name}
            </span>
          )}
          {item.text ? (
            <Tag
              className="pb-statustag-tag"
              style={{
                color: item.color,
                background: withAlpha(item.color, 0.12),
                borderColor: withAlpha(item.color, 0.32),
              }}
            >
              <span
                className="pb-statustag-dot"
                style={{ background: item.color }}
              />
              {item.text}
            </Tag>
          ) : (
            <Tag className="pb-statustag-tag is-empty">—</Tag>
          )}
        </div>
      ))}
    </div>
  );
}

// ===========================================================================
// 实时时钟
// ===========================================================================

export function ClockWidget({ widget }: WidgetProps) {
  const dark = useErpDarkMode();
  const [now, setNow] = useState(() => dayjs());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(dayjs()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const [from, to] = pickGradient(dark, 0, widget.accentColor);
  const horizontal = widget.orientation === "horizontal";

  return (
    <div className={`pb-clock${horizontal ? " is-horizontal" : ""}`}>
      <div
        className="pb-clock-time"
        style={{ backgroundImage: `linear-gradient(115deg, ${from}, ${to})` }}
      >
        {now.format(widget.timeFormat || "HH:mm:ss")}
      </div>
      <div className="pb-clock-date">
        <span className="pb-clock-beat" style={{ background: from }} />
        {now.format(widget.dateFormat || "YYYY-MM-DD dddd")}
      </div>
    </div>
  );
}
