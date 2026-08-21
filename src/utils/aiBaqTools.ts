import { loadCatalog, saveBaq } from "../features/baq/api";
import type {
  Aggregate,
  BaqDefinition,
  BaqField,
  BaqFilter,
  BaqJoin,
  BaqQuery,
  BaqSort,
  BaqTable,
  FilterOperator,
} from "../features/baq/types";
import type { AIProviderConfig } from "./aiConfig";

type BaqToolStatus = "ignored" | "created" | "invalid" | "error";

export interface BaqToolResult {
  status: BaqToolStatus;
  reply?: string;
}

const aggregateValues: Aggregate[] = ["none", "sum", "count", "avg", "min", "max"];
const filterOperators: FilterOperator[] = [
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "like",
  "is_null",
  "not_null",
];

const uid = () => `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

const isBaqRequest = (text: string) =>
  /(?:创建|新建|生成|建立|设计).*(?:BAQ|报表查询|查询)/i.test(text) ||
  /(?:BAQ|报表查询).*(?:创建|新建|生成|建立|设计)/i.test(text);

const extractJson = (text: string): Record<string, unknown> => {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced || text.match(/\{[\s\S]*\}/)?.[0];
  if (!candidate) throw new Error("模型没有返回有效的 BAQ JSON");
  return JSON.parse(candidate) as Record<string, unknown>;
};

const stringValue = (value: unknown, fallback = "") =>
  typeof value === "string" ? value.trim() : fallback;

const tableMap = (catalog: BaqTable[]) =>
  new Map(catalog.map((table) => [table.table, table]));

const columnExists = (
  catalog: BaqTable[],
  tableByAlias: Map<string, string>,
  alias: string,
  field: string,
) => {
  const tableName = tableByAlias.get(alias);
  return !!tableName && !!catalog.find((table) => table.table === tableName)?.columns.some((column) => column.name === field);
};

const validateDefinition = (definition: BaqDefinition, catalog: BaqTable[]) => {
  const tables = tableMap(catalog);
  if (!definition.source?.table || !tables.has(definition.source.table)) {
    throw new Error(`主表不存在或不在 BAQ 数据目录中：${definition.source?.table || "-"}`);
  }

  const sourceAlias = definition.source.alias || "t0";
  const tableByAlias = new Map([[sourceAlias, definition.source.table]]);
  for (const join of definition.joins || []) {
    if (!join.table || !tables.has(join.table)) throw new Error(`关联表不存在：${join.table || "-"}`);
    if (tableByAlias.has(join.alias)) throw new Error(`表别名重复：${join.alias}`);
    if (!tableByAlias.has(join.leftAlias)) throw new Error(`关联左表别名不存在：${join.leftAlias}`);
    if (!columnExists(catalog, tableByAlias, join.leftAlias, join.leftField)) {
      throw new Error(`关联左字段不存在：${join.leftAlias}.${join.leftField}`);
    }
    if (!tables.get(join.table)?.columns.some((column) => column.name === join.rightField)) {
      throw new Error(`关联右字段不存在：${join.table}.${join.rightField}`);
    }
    tableByAlias.set(join.alias, join.table);
  }

  if (!definition.fields?.length) throw new Error("至少需要配置一个输出字段");
  for (const field of definition.fields) {
    if (!tableByAlias.has(field.tableAlias) || !columnExists(catalog, tableByAlias, field.tableAlias, field.field)) {
      throw new Error(`输出字段不存在：${field.tableAlias}.${field.field}`);
    }
    if (!field.alias) throw new Error(`输出字段缺少别名：${field.tableAlias}.${field.field}`);
    if (!aggregateValues.includes(field.aggregate)) throw new Error(`不支持的聚合方式：${field.aggregate}`);
  }
  for (const filter of definition.filters || []) {
    if (!columnExists(catalog, tableByAlias, filter.tableAlias, filter.field)) {
      throw new Error(`筛选字段不存在：${filter.tableAlias}.${filter.field}`);
    }
    if (!filterOperators.includes(filter.operator)) throw new Error(`不支持的筛选运算符：${filter.operator}`);
  }
  for (const sort of definition.sorts || []) {
    if (!definition.fields.some((field) => (field.alias || field.field) === sort.fieldAlias)) {
      throw new Error(`排序字段不存在：${sort.fieldAlias}`);
    }
  }
};

const normalizeDefinition = (raw: unknown): BaqDefinition => {
  const value = (raw || {}) as Partial<BaqDefinition>;
  const source = value.source || { table: "", alias: "t0" };
  const joins = (value.joins || []).map((join) => ({
    id: stringValue(join.id, uid()),
    type: join.type === "inner" ? "inner" : "left",
    table: stringValue(join.table),
    alias: stringValue(join.alias),
    leftAlias: stringValue(join.leftAlias, "t0"),
    leftField: stringValue(join.leftField),
    rightField: stringValue(join.rightField),
  })) as BaqJoin[];
  const fields = (value.fields || []).map((field) => ({
    id: stringValue(field.id, uid()),
    alias: stringValue(field.alias, stringValue(field.field)),
    field: stringValue(field.field),
    groupBy: field.groupBy === true,
    aggregate: aggregateValues.includes(field.aggregate as Aggregate) ? field.aggregate : "none",
    tableAlias: stringValue(field.tableAlias, "t0"),
  })) as BaqField[];
  const filters = (value.filters || []).map((filter) => ({
    id: stringValue(filter.id, uid()),
    tableAlias: stringValue(filter.tableAlias, "t0"),
    field: stringValue(filter.field),
    operator: filterOperators.includes(filter.operator as FilterOperator) ? filter.operator : "eq",
    value: stringValue(filter.value),
  })) as BaqFilter[];
  const sorts = (value.sorts || []).map((sort) => ({
    id: stringValue(sort.id, uid()),
    fieldAlias: stringValue(sort.fieldAlias),
    direction: sort.direction === "desc" ? "desc" : "asc",
  })) as BaqSort[];
  return {
    source: { table: stringValue(source.table), alias: stringValue(source.alias, "t0") },
    joins,
    fields,
    filters,
    sorts,
  };
};

const requestStructuredBaq = async (prompt: string, provider: AIProviderConfig, catalog: BaqTable[]) => {
  if (!provider.endpoint) throw new Error("当前大模型没有配置接口地址");
  const catalogText = catalog
    .map((table) => `${table.label} | ${table.table} | ${table.columns.map((column) => column.name).join(", ")}`)
    .join("\n");
  const systemPrompt = [
    "你是 OPERP 的 BAQ 查询设计器。请根据用户描述设计一个可执行的 BAQ。",
    "只返回 JSON，不要 Markdown，不要解释。必须包含 name、code、description、definition。",
    "definition 必须包含 source、joins、fields、filters、sorts。",
    "source: {table, alias}，主表别名固定为 t0；join: {type, table, alias, leftAlias, leftField, rightField}。",
    "field: {alias, field, groupBy, aggregate, tableAlias}，aggregate 只能是 none/sum/count/avg/min/max。",
    "filter: {tableAlias, field, operator, value}，operator 只能是 eq/neq/gt/gte/lt/lte/like/is_null/not_null。",
    "sort: {fieldAlias, direction}，direction 只能是 asc/desc。只能使用数据目录中的真实表和字段。",
    "",
    "数据目录：",
    catalogText,
    "",
    `用户需求：${prompt}`,
  ].join("\n");
  const response = await fetch(provider.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: provider.model,
      messages: [{ role: "user", content: systemPrompt }],
      stream: false,
    }),
  });
  if (!response.ok) throw new Error(`AI 服务请求失败：${response.status}`);
  const data = (await response.json()) as Record<string, unknown>;
  const choice = Array.isArray(data.choices) ? (data.choices[0] as Record<string, unknown>) : undefined;
  const message = (choice?.message || choice?.text || data.content || data.response || data.reply) as unknown;
  const content = typeof message === "object" && message !== null
    ? String((message as Record<string, unknown>).content || "")
    : String(message || "");
  return extractJson(content);
};

export async function handleCreateBaqSkill(
  text: string,
  provider: AIProviderConfig,
): Promise<BaqToolResult> {
  if (!isBaqRequest(text)) return { status: "ignored" };
  try {
    const catalog = await loadCatalog();
    const raw = await requestStructuredBaq(text, provider, catalog);
    const definition = normalizeDefinition(raw.definition);
    validateDefinition(definition, catalog);
    const name = stringValue(raw.name, "AI 创建的 BAQ");
    const code = stringValue(raw.code, `baq_${Date.now()}`).replace(/[^A-Za-z0-9_-]/g, "_");
    const saved = await saveBaq({
      code,
      name,
      description: stringValue(raw.description, text),
      status: "draft",
      definition,
    } as BaqQuery);
    return {
      status: "created",
      reply: `BAQ“${saved.name}”已创建并保存为草稿。\n编码：${saved.code}\n提示：可在 BAQ 设计管理中预览、调整并发布。`,
    };
  } catch (error) {
    return {
      status: "error",
      reply: `创建 BAQ 失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
