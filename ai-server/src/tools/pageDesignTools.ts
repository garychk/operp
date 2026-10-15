/**
 * AI 页面设计工具（page.design）：一句话生成自定义页面。
 *
 * 链路：
 *   1. 组件目录 + 布局规则进 prompt，模型输出页面 JSON（名称/描述/组件数组）；
 *   2. 校验失败把错误回喂模型修复一轮，仍失败则报错；
 *   3. 需要业务数据的组件带 dataNeed（自然语言数据需求）——
 *      先按关键词匹配租户已有 BAQ，匹配不到就走 designAndPersistBaq 自动创建，
 *      创建的 BAQ 在 description 末尾追加来源备注（防误删）；
 *      多个数据需求按 dataNeed 去重后并发解析（上限 4），避免逐一串行等模型，
 *      BAQ 数据目录只加载一次、所有 BAQ 共享；
 *   4. BAQ 就绪后按它的输出字段别名确定性回写组件的 xField/yField 等映射
 *      （两次模型调用不可能对齐字段名，必须系统侧接线）；
 *   5. 组装 config 落 sys_custom_pages（草稿），回复预览 / 设计器链接。
 *
 * BAQ 创建失败的组件不阻塞整页：回退为静态演示数据并在回复里点名，
 * 用户可在设计器中重新配置。
 */
import { supabase } from "../config/supabase.js";
import { callChatModel } from "../config/llm.js";
import type { AiGraphState } from "../ai/state.js";
import { logAiOperation } from "../services/aiAudit.js";
import { toolText } from "../services/toolText.js";
import { designAndPersistBaq, loadBaqCatalog, requireTenantId } from "./erpTools.js";

type ToolStatus = "success" | "needs_more" | "error";
interface ToolResult {
  status: ToolStatus;
  reply: string;
  data?: unknown;
  focus?: unknown;
  route?: string;
  routeLabel?: string;
}

/** 与前端 PageDesigner 的 WidgetType 保持一致（src/features/page-builder/types.ts） */
const WIDGET_TYPES = new Set([
  "text", "statistic", "button", "table", "line", "column", "pie", "divider",
  "progressRing", "gauge", "scatter", "linkage", "ranking", "carouselTable",
  "liveStream", "marquee", "alertBanner", "statusTag", "clock",
]);
/** 不需要任何数据的组件 */
const NO_DATA_TYPES = new Set(["text", "button", "divider", "clock"]);

interface PageWidgetSpec {
  type?: string;
  title?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  config?: Record<string, unknown>;
  dataNeed?: string;
  staticData?: unknown[];
  refreshInterval?: number;
}

interface PageSpec {
  name?: string;
  description?: string;
  widgets?: PageWidgetSpec[];
}

const clampInt = (value: unknown, min: number, max: number, fallback: number) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.round(num)));
};

/**
 * 带并发上限的串行映射。
 * 页面设计的多个 BAQ 需求并行解析时会同时打本地 LLM（如 Ollama），
 * 一次性发起过多并行请求容易把本地模型压垮或触发排队，这里限制同时在飞的数量。
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/* ------------------------------------------------------------------ */
/* 模型 prompt                                                          */
/* ------------------------------------------------------------------ */

const WIDGET_CATALOG = `
可用组件（type｜用途｜数据与字段约定）：
- statistic 单指标卡：取第 1 行，xField=标签字段、yField=数值字段，可配 unit（单位后缀）
- progressRing 进度环：每行一个环，xField=名称、yField=数值（0~maxValue），maxValue 默认 100，unit 如 %
- gauge 仪表盘：取第 1 行，yField=数值，maxValue、unit
- line 折线图 / column 柱状图：xField=维度、yField=数值
- pie 饼图：colorField=分类、yField=数值
- scatter 散点图：xField/yField 各一个字段、colorField=分组（可选）
- linkage 柱线联动图：xField=维度、yField=柱（主轴）、y2Field=线（副轴）
- ranking 排行榜：xField=名称、yField=数值、unit
- table 明细表 / carouselTable 轮播表：列自动取数据前 8 列，pageSize 可选
- liveStream 实时明细流：xField=事件文本
- marquee 滚动播报：xField=播报文本（发布态自动无标题无边框）
- alertBanner 告警轮播：xField=告警文本，statusField=级别字段（success/warning/error/info，可选）
- statusTag 状态标签墙：xField=名称，statusField=状态文本（可选）
- clock 实时时钟、text 文本块（content=文字）、button 按钮（content=文字）、divider 分割线（dividerText=文字）：不需要数据
`;

const buildDesignPrompt = (text: string, english: boolean, retryError?: string) =>
  [
    english
      ? "You are the OPERP dashboard design assistant. Design a polished dashboard page for the PageDesigner based on the user's request."
      : "你是 OPERP 看板设计助手。根据用户需求，为页面设计器（PageDesigner）设计一个精美的看板页面。",
    WIDGET_CATALOG,
    english ? "Layout rules:" : "布局规则：",
    "- 画布 12 列网格（x 0-11，w 1-12，x+w≤12），y 从 0 起逐行向下排，不要重叠；h 建议：KPI/进度环/仪表盘 2-3，图表/表格 4-6，播报/告警/标签 1-2。",
    english
      ? "- Aesthetics: first row KPI cards (statistic/progressRing/gauge), middle trend/linkage charts, bottom detail tables/marquee/alerts; each row's widgets should fill all 12 columns."
      : "- 精美要求：第一排 KPI 类（statistic/progressRing/gauge），中间趋势/联动图表，底部明细/播报/告警；每行组件宽度尽量铺满 12 列。",
    "- 组件数量 4~10 个。",
    english ? "Data rules:" : "数据规则：",
    "- 需要业务数据的组件：必须给 dataNeed（用中文写清要查什么：主数据/单据、粒度、指标、排序，例如「按工作中心统计今日完工工单数，按数量降序」），不要给 staticData，不要编字段名——字段映射由系统按数据源自动接线。",
    "- clock/text/button/divider 不需要数据，不要给 dataNeed。",
    "- config 里只需给业务无关的展示项（unit、maxValue、pageSize、interval 等），xField/yField 等字段映射可以不写（系统接线）。",
    english
      ? 'Output JSON only (no markdown): {"name":"page name","description":"one line","widgets":[{"type":"statistic","title":"...","x":0,"y":0,"w":3,"h":2,"config":{...},"dataNeed":"..."}]}'
      : '只输出 JSON（不要 Markdown）：{"name":"页面名称","description":"一句话描述","widgets":[{"type":"statistic","title":"组件标题","x":0,"y":0,"w":3,"h":2,"config":{...},"dataNeed":"数据需求"}]}',
    english
      ? "All display text (name/description/title) must be in English."
      : "所有展示文案（name/description/title）用简体中文。",
    retryError ? (english ? `Your previous output was invalid: ${retryError}. Fix it and output JSON only.` : `上次输出有误：${retryError}。请修正后只输出 JSON。`) : "",
    english ? `User request: ${text}` : `用户需求：${text}`,
  ]
    .filter(Boolean)
    .join("\n");

/* ------------------------------------------------------------------ */
/* 页面 JSON 校验 / 归一                                                */
/* ------------------------------------------------------------------ */

const validatePageSpec = (spec: PageSpec): string | null => {
  if (!spec || typeof spec !== "object") return "输出不是 JSON 对象";
  if (!spec.name || typeof spec.name !== "string") return "缺少 name";
  if (!Array.isArray(spec.widgets) || !spec.widgets.length) return "widgets 必须是非空数组";
  for (const [index, widget] of spec.widgets.entries()) {
    if (!widget?.type || !WIDGET_TYPES.has(widget.type)) {
      return `第 ${index + 1} 个组件 type 无效：${String(widget?.type)}`;
    }
  }
  return null;
};

/** 归一网格与默认值（模型坐标只 clamp 不重排，重叠交给前端 RGL 压缩） */
const normalizeWidgets = (widgets: PageWidgetSpec[]): Required<PageWidgetSpec>[] =>
  widgets.slice(0, 12).map((widget, index) => {
    const x = clampInt(widget.x, 0, 11, (index * 4) % 12);
    return {
      type: String(widget.type),
      title: String(widget.title || "").slice(0, 60) || String(widget.type),
      x,
      y: clampInt(widget.y, 0, 200, index * 3),
      w: clampInt(widget.w, 2, 12 - x, 4),
      h: clampInt(widget.h, 1, 8, 4),
      config: widget.config && typeof widget.config === "object" ? widget.config : {},
      dataNeed: NO_DATA_TYPES.has(String(widget.type)) ? "" : String(widget.dataNeed || "").trim(),
      staticData: Array.isArray(widget.staticData) ? widget.staticData : [],
      refreshInterval: clampInt(widget.refreshInterval, 0, 3600, 0),
    };
  });

/* ------------------------------------------------------------------ */
/* BAQ 匹配与字段接线                                                   */
/* ------------------------------------------------------------------ */

interface BaqRow {
  id: number;
  code: string;
  name?: string;
  description?: string;
  definition?: Record<string, unknown>;
}

/**
 * dataNeed 与已有 BAQ 的相关度判定。
 * 教训：裸 2-gram 计数会被「统计 / 数量 / 合计」这类通用词刷分，
 * 「今日完工数量合计」都能误中「物料库存采购在制量统计」——
 * 必须先剔除通用词，再要求命中数与覆盖率双达标。
 */
const GENERIC_GRAMS = new Set([
  "统计", "数量", "查询", "合计", "明细", "列表", "排列", "降序", "升序",
  "百分", "占比", "显示", "查看", "进行", "今日", "每日", "累计", "平均",
  "状况", "情况", "数据", "实时",
]);

const meaningfulGrams = (text: string): string[] => {
  const grams: string[] = [];
  for (let i = 0; i < text.length - 1; i += 1) {
    const gram = text.slice(i, i + 2);
    if (/[\s，。、；：「」（）()！!？?]/.test(gram)) continue;
    if (GENERIC_GRAMS.has(gram)) continue;
    grams.push(gram);
  }
  return grams;
};

/** 复用门槛：有意义词命中 ≥4 且覆盖率 ≥50%（宁缺毋滥，配不上就新建） */
const REUSE_MIN_HITS = 4;
const REUSE_MIN_RATIO = 0.5;

const scoreBaqMatch = (need: string, baq: BaqRow) => {
  const haystack = `${baq.name || ""} ${baq.description || ""}`;
  const grams = meaningfulGrams(need);
  if (!grams.length) return { matched: 0, ratio: 0 };
  const matched = grams.filter((gram) => haystack.includes(gram)).length;
  return { matched, ratio: matched / grams.length };
};

const baqFieldAliases = (definition?: Record<string, unknown>) => {
  const fields = Array.isArray(definition?.fields)
    ? (definition!.fields as Array<Record<string, unknown>>)
    : [];
  const aliasOf = (field: Record<string, unknown>) => String(field.alias || field.field || "");
  const dimension =
    fields.find((field) => field.groupBy === true) ||
    fields.find((field) => String(field.aggregate || "none") === "none");
  const measures = fields.filter((field) => String(field.aggregate || "none") !== "none");
  return {
    dimension: aliasOf(dimension || fields[0] || {}) || "label",
    measure: aliasOf(measures[0] || fields[1] || fields[0] || {}) || "value",
    measure2: measures[1] ? aliasOf(measures[1]) : "",
  };
};

/** 按 BAQ 实际输出别名回写组件字段映射（模型两次调用不可能对齐字段名，必须系统接线） */
const wireWidgetFields = (
  widget: Required<PageWidgetSpec>,
  definition?: Record<string, unknown>,
) => {
  const { dimension, measure, measure2 } = baqFieldAliases(definition);
  const config = widget.config;
  const set = (key: string, value: string) => {
    if (value) config[key] = value;
  };
  switch (widget.type) {
    case "statistic":
    case "gauge":
    case "progressRing":
    case "ranking":
    case "line":
    case "column":
    case "scatter":
      set("xField", dimension);
      set("yField", measure);
      break;
    case "pie":
      set("colorField", dimension);
      set("yField", measure);
      break;
    case "linkage":
      set("xField", dimension);
      set("yField", measure);
      if (measure2) set("y2Field", measure2);
      break;
    case "marquee":
    case "liveStream":
    case "alertBanner":
    case "statusTag":
      set("xField", dimension);
      break;
    default:
      break; // table / carouselTable 列自动取
  }
};

/* ------------------------------------------------------------------ */
/* 主工具                                                               */
/* ------------------------------------------------------------------ */

export async function designCustomPageTool(state: AiGraphState): Promise<ToolResult> {
  const tt = toolText(state.locale);
  const english = tt.locale === "en";
  let tenantId: number;
  try {
    tenantId = requireTenantId(state);
  } catch {
    return { status: "error", reply: tt("page.err.noTenant") };
  }

  // ① 模型设计页面（失败回喂错误修复一轮）
  let spec: PageSpec | null = null;
  let retryError = "";
  for (let round = 0; round < 2 && !spec; round += 1) {
    try {
      const { content } = await callChatModel(
        [
          { role: "system", content: english ? "Output JSON only." : "只输出JSON。" },
          { role: "user", content: buildDesignPrompt(state.text, english, retryError || undefined) },
        ],
        state.provider,
      );
      const parsed = JSON.parse(
        content.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim() || content.trim(),
      ) as PageSpec;
      const validationError = validatePageSpec(parsed);
      if (validationError) {
        retryError = validationError;
      } else {
        spec = parsed;
      }
    } catch (error) {
      retryError = error instanceof Error ? error.message.slice(0, 200) : "JSON 解析失败";
    }
  }
  if (!spec) {
    return { status: "error", reply: tt("page.err.designFailed") };
  }

  const widgets = normalizeWidgets(spec.widgets || []);
  const pageName = String(spec.name || "AI 看板").slice(0, 60);
  const stamp = Date.now().toString(36);

  const sourceNote = tt("page.baq.sourceNote", {
    date: new Date().toISOString().slice(0, 10),
    page: pageName,
  });

  // ② 拉取租户已有 BAQ（只读匹配用）与数据目录（一次加载，多个 BAQ 共享，避免重复 RPC）
  const { data: existingRows, error: baqListError } = await supabase
    .from("sys_baq_queries")
    .select("id, code, name, description, definition")
    .eq("tenant_id", tenantId)
    .eq("is_deleted", "n");
  if (baqListError) throw baqListError;
  const existingBaqs = (existingRows || []) as BaqRow[];
  const catalog = await loadBaqCatalog();

  /** 在租户已有 BAQ 里找最相关的（只读，可安全并发） */
  const matchExistingBaq = (need: string): BaqRow | null => {
    let best: BaqRow | null = null;
    let bestScore = { matched: 0, ratio: 0 };
    for (const baq of existingBaqs) {
      const score = scoreBaqMatch(need, baq);
      if (
        score.matched > bestScore.matched ||
        (score.matched === bestScore.matched && score.ratio > bestScore.ratio)
      ) {
        best = baq;
        bestScore = score;
      }
    }
    if (best && bestScore.matched >= REUSE_MIN_HITS && bestScore.ratio >= REUSE_MIN_RATIO) return best;
    return null;
  };

  /** 为某个 dataNeed 解析 BAQ：命中已有就复用，否则自动创建（并行安全，不写 existingBaqs） */
  const resolveNeed = async (
    need: string,
    widgetTitle: string,
    codeSeed: string,
  ): Promise<{ baq: BaqRow | null; kind: "reused" | "created" | "failed" }> => {
    const existing = matchExistingBaq(need);
    if (existing) return { baq: existing, kind: "reused" };
    try {
      const { baq } = await designAndPersistBaq({
        text: `为看板组件「${widgetTitle}」提供数据：${need}。输出字段少而精（1 个维度字段 + 1~2 个数值字段），字段别名用英文小写。`,
        tenantId,
        provider: state.provider,
        userId: state.userId,
        sessionId: state.sessionId,
        descriptionSuffix: sourceNote,
        codePrefix: "baq_page_",
        catalog,
        codeSeed,
      });
      return {
        baq: {
          id: Number(baq.id),
          code: String(baq.code),
          name: String(baq.name || ""),
          definition: baq.definition as Record<string, unknown> | undefined,
        },
        kind: "created",
      };
    } catch {
      return { baq: null, kind: "failed" };
    }
  };

  // ③ 收集数据需求并按 dataNeed 去重（同一句话只建一个 BAQ），随后并发解析
  const dataWidgets = widgets.filter((widget) => widget.dataNeed);
  const needItems: Array<{ need: string; title: string }> = [];
  const seenNeeds = new Set<string>();
  for (const widget of dataWidgets) {
    if (!seenNeeds.has(widget.dataNeed)) {
      seenNeeds.add(widget.dataNeed);
      needItems.push({ need: widget.dataNeed, title: widget.title });
    }
  }

  // 并发上限 4：本地 Ollama 扛不住太多并行，远程模型也可借此削峰；
  // 耗时从「逐个串行 ≈ N × 单次调用」降到「≈ 最慢那一次调用」。
  const resolvedNeeds = await mapWithConcurrency(
    needItems,
    4,
    async (item, index) => ({
      need: item.need,
      ...(await resolveNeed(item.need, item.title, `${stamp}-${index}`)),
    }),
  );

  const baqByNeed = new Map<string, BaqRow>();
  const createdBaqs: string[] = [];
  const reusedBaqs: string[] = [];
  for (const result of resolvedNeeds) {
    if (result.baq && (result.kind === "reused" || result.kind === "created")) {
      baqByNeed.set(result.need, result.baq);
      (result.kind === "reused" ? reusedBaqs : createdBaqs).push(
        `${result.baq.name || result.baq.code}（${result.baq.code}）`,
      );
    }
  }

  // ④ 组装最终组件配置（BAQ 已就绪，按 need 查表接线）
  const finalWidgets = [] as Array<Record<string, unknown>>;
  const failedNeeds: string[] = [];
  for (const [index, widget] of widgets.entries()) {
    const base: Record<string, unknown> = {
      id: `w${index + 1}-${stamp}`,
      type: widget.type,
      title: widget.title,
      x: widget.x,
      y: widget.y,
      w: widget.w,
      h: widget.h,
      ...widget.config,
    };
    if (NO_DATA_TYPES.has(widget.type)) {
      base.dataSource = { mode: "static", staticData: widget.staticData };
    } else if (widget.dataNeed) {
      const baq = baqByNeed.get(widget.dataNeed);
      if (baq) {
        wireWidgetFields(widget, baq.definition);
        Object.assign(base, widget.config); // 接线后的字段映射盖回 base
        base.dataSource = { mode: "baq", baqCode: baq.code, limit: 100 };
        base.refreshInterval = widget.refreshInterval > 0 ? widget.refreshInterval : 30;
      } else {
        failedNeeds.push(widget.title);
        base.dataSource = {
          mode: "static",
          staticData: widget.staticData.length
            ? widget.staticData
            : [{ label: widget.title, value: 0 }],
        };
      }
    } else {
      base.dataSource = { mode: "static", staticData: widget.staticData };
    }
    finalWidgets.push(base);
  }

  // ⑤ 落库（草稿，设计器里确认后再发布）
  const slug = `ai-${stamp}`;
  const payload = {
    tenant_id: tenantId, // 显式带租户：ai-server 走 service_role，auth.uid() 为 null，
    // 表的 DEFAULT current_tenant_id() 会解析成 null，必须显式写入当前租户
    name: pageName,
    slug,
    description: String(spec.description || "").slice(0, 200) || null,
    status: "draft",
    config: { widgets: finalWidgets },
    updated_at: new Date().toISOString(),
  };
  const { data: saved, error: saveError } = await supabase
    .from("sys_custom_pages")
    .insert(payload)
    .select()
    .single();
  if (saveError) {
    return { status: "error", reply: tt("page.err.saveFailed", { reason: saveError.message }) };
  }
  await logAiOperation({
    operation: "ai.page.design",
    tenantId,
    userId: state.userId,
    sessionId: state.sessionId,
    targetTable: "sys_custom_pages",
    targetId: Number(saved.id),
    request: payload,
  });

  // ⑥ 回复（预览 + 设计器链接，站内 markdown 链接前端可点击跳转）
  const previewPath = `/custom/${slug}`;
  const lines = [
    tt("page.created.title", { name: pageName }),
    tt("page.created.widgets", { count: finalWidgets.length }),
  ];
  if (createdBaqs.length) lines.push(tt("page.baq.created", { list: createdBaqs.join("、") }));
  if (reusedBaqs.length) lines.push(tt("page.baq.reused", { list: [...new Set(reusedBaqs)].join("、") }));
  if (failedNeeds.length) lines.push(tt("page.baq.failed", { list: failedNeeds.join("、") }));
  lines.push("", tt("page.created.links", { preview: previewPath, designer: "/system/page-designer" }), "", tt("page.created.draftNote"));

  return {
    status: "success",
    reply: lines.join("\n"),
    data: {
      pageId: saved.id,
      slug,
      previewPath,
      widgetCount: finalWidgets.length,
      baqCreated: createdBaqs,
      baqReused: [...new Set(reusedBaqs)],
      baqFailed: failedNeeds,
    },
    focus: { type: "custom_page", id: saved.id, slug, name: pageName },
    route: previewPath,
    routeLabel: pageName,
  };
}
