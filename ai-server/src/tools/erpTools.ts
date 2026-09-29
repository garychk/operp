import { supabase } from "../config/supabase.js";
import { callChatModel } from "../config/llm.js";
import { TenantScopeError } from "../config/tenantContext.js";
import type { AiChatRequest, AiGraphState } from "../ai/state.js";
import {
  baseTableName,
  evaluateDeletePolicy,
  loadDictTypeOptions,
  resolveEntityForState,
  resolveForeignKeyValues,
  type EntityDef,
} from "./entityRegistry.js";

type ToolStatus = "success" | "needs_more" | "error";

interface ToolResult {
  status: ToolStatus;
  reply: string;
  data?: unknown;
  focus?: unknown;
  route?: string;
  routeLabel?: string;
  needConfirmation?: boolean;
  nextQuestions?: string[];
}

interface BaqTable {
  table: string;
  label: string;
  columns: Array<{ name: string; type: string }>;
}

interface AnalysisPlan {
  title?: string;
  sql?: string;
  explanation?: string;
  responseMode?: "text" | "table" | "card";
  target?: string;
  queryMode?: string;
}

const nowIso = () => new Date().toISOString();
const today = () => new Date().toISOString().slice(0, 10);

/**
 * 实体路由：从 sys_menus 找到该业务对象对应的页面，供前端跳转。
 */
async function findEntityRoute(entity: EntityDef) {
  const hints = entity.routeHints?.length ? entity.routeHints : [entity.label];
  for (const hint of hints) {
    const { data, error } = await supabase
      .from("sys_menus")
      .select("menu_name, menu_code, path")
      .eq("is_deleted", "n")
      .eq("status", "1")
      .or(`menu_name.ilike.%${hint}%,menu_code.ilike.%${hint.toLowerCase().replace(/\s+/g, "_")}%,path.ilike.%${hint}%`)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (data?.path) {
      return { route: String(data.path), routeLabel: String(data.menu_name || entity.label) };
    }
  }
  return null;
}

const normalize = (value: string) => value.toLowerCase().replace(/\s+/g, "");
const stripJsonFence = (text: string) => text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim() || text.trim();
const parseJson = <T>(text: string): T | null => {
  try {
    return JSON.parse(stripJsonFence(text)) as T;
  } catch {
    return null;
  }
};

const hasPronounReference = (text: string) => /(?:它|这个|那个|刚才|刚刚|上一个|上次|最近|继续|改一下|帮我改|修改一下)/.test(text);

const missingRequiredFields = (entity: EntityDef, record: Record<string, unknown>) =>
  entity.requiredFields.filter((field) => {
    const value = record[field.key];
    return value === undefined || value === null || value === "";
  });

const extractExplicitFields = (entity: EntityDef, text: string): Record<string, unknown> => {
  const fields: Record<string, unknown> = {};
  const codeField = entity.codeField || "code";
  const nameField = entity.nameField || "name";
  const label = entity.label;

  const codeMatch = text.match(
    new RegExp(`(?:${label})?\\s*(?:编码|编号|单号)\\s*[:：=]?\\s*([A-Za-z0-9_-]+)`, "i"),
  );
  const nameMatch = text.match(
    new RegExp(`(?:${label})?\\s*名称\\s*[:：=]?\\s*([^，,。；;\\n]+)`, "i"),
  );

  if (codeMatch?.[1]) fields[codeField] = codeMatch[1].trim();
  if (nameMatch?.[1]) fields[nameField] = nameMatch[1].trim();

  return fields;
};

const normalizeEntityFields = (
  entity: EntityDef,
  fields: Record<string, unknown>,
): Record<string, unknown> => {
  const codeField = entity.codeField || "code";
  const nameField = entity.nameField || "name";
  const aliases: Record<string, string> = {
    编码: codeField,
    编号: codeField,
    单号: codeField,
    名称: nameField,
    [`${entity.label}编码`]: codeField,
    [`${entity.label}编号`]: codeField,
    [`${entity.label}名称`]: nameField,
  };
  for (const field of [...entity.requiredFields, ...(entity.optionalFields || [])]) {
    // 带括号说明的标签不适合做别名，其余中文标签可直接映射到列名
    if (!field.label.includes("（") && !field.label.includes("(")) {
      aliases[field.label] = field.key;
    }
  }
  const allowedFields = new Set(
    entity.insertableFields.length
      ? entity.insertableFields
      : [codeField, nameField, ...Object.keys(entity.defaults())],
  );
  const normalized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(fields)) {
    const targetKey = aliases[key] || key;
    if (allowedFields.has(targetKey)) {
      normalized[targetKey] = value;
    }
  }

  return normalized;
};

export const hasColumn = (entity: EntityDef, name: string) =>
  entity.columns.some((column) => column.name === name);

/**
 * 该表是否需要租户过滤。
 *
 * 刻意按「表名前缀」判断，而不是查 entity.columns：
 * 列元数据来自 ai_entity_catalog()，一旦目录滞后于物理表，
 * 按列判断的结果就是「静默跳过过滤」，等于跨租户泄露。
 * 按前缀判断则相反 —— 表若真没有 tenant_id 列，.eq() 会直接报 HTTP 400，
 * 把问题显式暴露出来，而不是默默放行。宁可报错也不要漏。
 */
/**
 * 需要租户隔离的系统表。erp_* 由前缀判定，这里列的是 sys_ 里属于租户私有的表
 * （BAQ 查询定义、AI 会话记忆）。它们依赖 deploy_42 补出来的 tenant_id 列。
 */
const TENANT_SCOPED_SYSTEM_TABLES = new Set(["sys_baq_queries", "sys_ai_chat_memory"]);

export const isTenantScopedTable = (tableName: string) =>
  tableName.startsWith("erp_") || TENANT_SCOPED_SYSTEM_TABLES.has(tableName);

/**
 * 取本次请求的租户。拿不到就抛错（fail-closed）。
 * ai-server 用 service_role，RLS 对它无效，这里是唯一的隔离点。
 */
function requireTenantId(state: AiGraphState | { tenantId?: number }): number {
  const tenantId = state.tenantId;
  if (typeof tenantId !== "number" || !Number.isInteger(tenantId)) {
    throw new TenantScopeError("缺少租户上下文，已拒绝本次业务数据访问。");
  }
  return tenantId;
}

async function runEntitySearch(entity: EntityDef, text: string, tenantId: number) {
  const codeField = entity.codeField || "code";
  const nameField = entity.nameField || "name";
  let query = supabase.from(entity.tableName).select("*");
  if (hasColumn(entity, "is_deleted")) query = query.eq("is_deleted", "n");
  if (isTenantScopedTable(entity.tableName)) query = query.eq("tenant_id", tenantId);
  const keywords = [...new Set(text.split(/[\s,，。；;]+/).filter(Boolean))];
  const { data, error } = await query.or(
    [
      `${codeField}.ilike.%${keywords[0] || text}%`,
      `${nameField}.ilike.%${keywords[0] || text}%`,
    ].join(","),
  ).limit(1);
  if (error) throw error;
  return data?.[0] || null;
}

/** 精确查找编码或名称是否已存在，用于避免 create 时触发唯一约束错误。 */
async function findDuplicate(entity: EntityDef, draft: Record<string, unknown>, tenantId: number) {
  const codeField = entity.codeField || "code";
  const nameField = entity.nameField || "name";
  const code = draft[codeField];
  const name = draft[nameField];
  if ((code === undefined || code === null || code === "") && (name === undefined || name === null || name === "")) {
    return null;
  }
  let query = supabase.from(entity.tableName).select("*");
  if (hasColumn(entity, "is_deleted")) query = query.eq("is_deleted", "n");
  if (isTenantScopedTable(entity.tableName)) query = query.eq("tenant_id", tenantId);
  const conditions: string[] = [];
  if (code !== undefined && code !== null && code !== "") conditions.push(`${codeField}.eq.${code}`);
  if (name !== undefined && name !== null && name !== "") conditions.push(`${nameField}.eq.${name}`);
  const { data, error } = await query.or(conditions.join(",")).limit(1);
  if (error) throw error;
  return data?.[0] || null;
}

/**
 * 取该表最近的几条真实记录作为「取值风格样本」，喂给 LLM，让它能照着
 * 现有编码规则、枚举取值、常用默认值去推断，而不是凭空猜。
 */
interface EntityProfile {
  rows: Array<Record<string, unknown>>;
  /** 针对特定实体的额外上下文（如字典项要给出可用字典类型清单） */
  extra: string;
}

async function loadEntityProfile(entity: EntityDef, tenantId: number, limit = 8): Promise<EntityProfile> {
  try {
    const columns = entity.insertableFields.filter((name) => name !== "corp_id" && name !== "emp_id");
    const select = (columns.length ? columns : ["*"]).join(",");
    let query = supabase.from(entity.tableName).select(select).limit(limit);
    if (hasColumn(entity, "is_deleted")) query = query.eq("is_deleted", "n");
    // 样本只能取自当前租户，否则会把别人的编码规则喂给 LLM
    if (isTenantScopedTable(entity.tableName)) query = query.eq("tenant_id", tenantId);
    if (hasColumn(entity, "id")) query = query.order("id", { ascending: false });
    const { data, error } = await query;
    if (error) return { rows: [], extra: "" };
    const rows = (data || []) as unknown as Array<Record<string, unknown>>;
    // 新增字典项必须知道有哪些字典类型，否则 type_id 只能靠猜
    let extra = "";
    if (entity.key === "dict_items") {
      const types = await loadDictTypeOptions(tenantId);
      if (types.length) {
        extra = `可用字典类型（type_id 只能取这些 id，也可填 code 或 name，服务端会自动解析）：${JSON.stringify(types)}`;
      }
    }
    return { rows, extra };
  } catch {
    return { rows: [], extra: "" };
  }
}

const formatProfile = (profile: EntityProfile) => {
  const sample = profile.rows.length
    ? `已有记录示例（照着这个风格推断编码规则、枚举取值、常用默认值）：${JSON.stringify(profile.rows)}`
    : "已有记录示例：无（该表还没有数据，请按通用业务常识推断）";
  return profile.extra ? `${sample}\n${profile.extra}` : sample;
};

async function extractEntityPayload(
  entity: EntityDef,
  text: string,
  current: Record<string, unknown> | null | undefined,
  provider: AiChatRequest["provider"] | undefined,
  profile: EntityProfile,
) {
  const fieldHints = [...entity.requiredFields, ...(entity.optionalFields || [])]
    .map((field) => `${field.key}(${field.label})`)
    .join("; ");
  const prompt = [
    `你是ERP数据录入助手。请从用户描述中提取${entity.label}的字段值，只返回JSON，不要解释。`,
    `实体表：${entity.tableName}`,
    `允许字段：${entity.insertableFields.join(", ")}`,
    fieldHints ? `字段说明：${fieldHints}` : "",
    `必填字段：${entity.requiredFields.map((field) => `${field.key}(${field.label})`).join(", ")}`,
    "如果用户只给了一个名词（例如'帮我加一个单位毫升'），请把它当作'名称'字段。",
    "对于用户没有明确给出的必填字段，请根据字段含义、中文常识、业务常识以及已有记录示例直接给出最合理的值，填在 fields 里；只有完全无法推断时才放进 need_more。",
    "外键字段如果只知道名称或编码，也按用户原话填写，服务端会自动解析成 id。",
    formatProfile(profile),
    current ? `当前记录：${JSON.stringify(current)}` : "当前记录：无",
    `用户原话：${text}`,
    "返回格式：{\"fields\":{...},\"need_more\":[],\"summary\":\"\"}",
  ].join("\n");
  const { content } = await callChatModel([
    { role: "system", content: "你只返回JSON。" },
    { role: "user", content: prompt },
  ], provider);
  const parsed = parseJson<{ fields?: Record<string, unknown>; need_more?: string[]; summary?: string }>(content);
  return {
    fields: parsed?.fields || {},
    need_more: parsed?.need_more || [],
    summary: parsed?.summary || "",
  };
}

/**
 * 基于业务常识的启发式补全（不走 LLM，快且确定）。
 * 目前覆盖：计量单位 → 根据名称推断所属单位组。
 */
async function applyEntityHeuristics(
  entity: EntityDef,
  draft: Record<string, unknown>,
): Promise<{ draft: Record<string, unknown>; reasoning: string[] }> {
  const reasoning: string[] = [];
  const base = entity.tableName.replace(/_s_[0-9a-f]{6,}_[a-z]$/i, "");

  if (base === "erp_uoms") {
    const name = String(draft.name || "").trim();
    if (name) {
      if (draft.group_id === undefined) {
        const groupName = inferUomGroupByName(name);
        if (groupName) {
          draft = { ...draft, group_id: groupName };
          reasoning.push(`group_id：根据名称"${name}"推断属于"${groupName}"`);
        }
      }
      if (draft.code === undefined) {
        const code = inferUomCodeByName(name);
        if (code) {
          draft = { ...draft, code };
          reasoning.push(`code：根据名称"${name}"推断编码为"${code}"`);
        }
      }
    }
  }

  return { draft, reasoning };
}

const UOM_CODE_MAP: Record<string, string> = {
  毫升: "ML",
  升: "L",
  立方厘米: "CM3",
  立方分米: "DM3",
  立方米: "M3",
  加仑: "GAL",
  克: "G",
  千克: "KG",
  公斤: "KG",
  斤: "JIN",
  吨: "T",
  米: "M",
  厘米: "CM",
  毫米: "MM",
  千米: "KM",
  个: "PC",
  件: "PC",
  只: "PC",
  条: "PC",
  台: "SET",
  套: "SET",
  箱: "BOX",
  包: "PAC",
  瓶: "BOT",
  盒: "BOX",
  支: "PCS",
  张: "SHT",
  把: "PCS",
  双: "PR",
  对: "PR",
  卷: "ROL",
  桶: "BAR",
  袋: "BAG",
  小时: "H",
  分钟: "MIN",
  秒: "S",
  天: "D",
  周: "W",
  月: "MON",
  年: "Y",
};

function inferUomCodeByName(name: string): string | null {
  const n = name.trim();
  if (UOM_CODE_MAP[n]) return UOM_CODE_MAP[n];
  if (/^[A-Za-z0-9_-]+$/.test(n)) return n.toUpperCase();
  return null;
}

function inferUomGroupByName(name: string): string | null {
  const n = name.toLowerCase();
  if (/^(毫升|升|l|ml|立方米|立方厘米|cc|加仑|gal)/.test(n)) return "体积";
  if (/^(克|千克|kg|公斤|斤|吨|t|g)$/.test(n) || /^克|千克|公斤/.test(name)) return "重量";
  if (/^(米|厘米|cm|毫米|mm|千米|km|尺|寸)/.test(n)) return "长度";
  if (/^(小时|分钟|秒|天|周|月|年)/.test(name)) return "时间";
  if (/^(个|件|只|条|台|套|箱|包|瓶|盒|支|张|把|双|对|卷|桶|袋)/.test(name)) return "数量";
  return null;
}

/**
 * 通用补全：对仍缺失的必填字段，交给 LLM 结合「字段定义 + 已有真实记录样本」
 * 去推断。只有当 LLM 明确表示推不出或存在歧义时，才把该字段交给用户确认。
 */
async function inferMissingFields(
  entity: EntityDef,
  text: string,
  draft: Record<string, unknown>,
  action: "create" | "update",
  provider: AiChatRequest["provider"] | undefined,
  profile: EntityProfile,
): Promise<{ fields: Record<string, unknown>; reasoning: string[]; ambiguous: string[] }> {
  const missing = missingRequiredFields(entity, draft);
  if (missing.length === 0) return { fields: {}, reasoning: [], ambiguous: [] };

  const columnDefs = entity.columns
    .map((column) => {
      const flags = [
        column.isNullable ? "可空" : "非空",
        column.refTable ? `引用${column.refTable}` : "",
      ].filter(Boolean);
      return `${column.name}(${column.dataType}${flags.length ? `,${flags.join(",")}` : ""})`;
    })
    .join("; ");

  const prompt = [
    `你是ERP数据补全专家。用户想${action === "update" ? "修改" : "创建"}一个${entity.label}，但还缺少一些必填字段。`,
    `实体表：${entity.tableName}`,
    `字段定义：${columnDefs}`,
    `必填字段：${entity.requiredFields.map((field) => `${field.key}(${field.label})`).join(", ")}`,
    `当前已确定的字段：${JSON.stringify(draft)}`,
    formatProfile(profile),
    `用户原话：${text}`,
    `请为以下缺失字段给出最合理的值：${missing.map((field) => `${field.key}(${field.label})`).join(", ")}`,
    "推断规则：",
    "1. 优先照抄已有记录的取值风格（编码规则、枚举取值、状态、单位、默认值等）。",
    "2. 外键字段填编码或名称即可，服务端会自动解析成 id。",
    "3. 只有当某个字段确实没有任何线索、或多个取值明显都同样合理时，才把它放进 ambiguous，并说明理由，绝对不要瞎猜。",
    "只返回 JSON：{\"fields\":{...}, \"reasoning\":[\"字段名：推断理由\", ...], \"ambiguous\":[\"字段名\", ...]}",
  ].join("\n");

  const { content } = await callChatModel(
    [
      { role: "system", content: "你只返回JSON。" },
      { role: "user", content: prompt },
    ],
    provider,
  );
  const parsed = parseJson<{
    fields?: Record<string, unknown>;
    reasoning?: string[];
    ambiguous?: string[];
  }>(content);
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed?.fields || {})) {
    if (value !== null && value !== undefined) fields[key] = value;
  }
  return { fields, reasoning: parsed?.reasoning || [], ambiguous: parsed?.ambiguous || [] };
}

/** 把 LLM 返回的字段名/标签统一映射到列 key */
const toFieldKey = (entity: EntityDef, value: string) => {
  const v = String(value || "").trim();
  if (!v) return null;
  const byKey = entity.requiredFields.find((field) => field.key === v);
  if (byKey) return byKey.key;
  const byLabel = entity.requiredFields.find(
    (field) => field.label === v || field.label.startsWith(v) || v.startsWith(field.key),
  );
  return byLabel?.key || null;
};

async function upsertEntity(
  entity: EntityDef,
  tenantId: number,
  text: string,
  currentFocus?: unknown,
  provider?: AiChatRequest["provider"],
  action: "create" | "update" = "create",
) {
  const current = currentFocus && typeof currentFocus === "object" ? currentFocus as Record<string, unknown> : null;
  const existing =
    action === "update"
      ? current?.id
        ? current
        : hasPronounReference(text)
          ? current
          : await runEntitySearch(entity, text, tenantId)
      : null;
  // 取真实记录样本，让 LLM 能照着现有编码规则和枚举取值去推断
  const profile = await loadEntityProfile(entity, tenantId);
  const extracted = await extractEntityPayload(entity, text, existing, provider, profile);
  let mergedDraft = {
    ...entity.defaults(),
    ...(existing || {}),
    ...normalizeEntityFields(entity, extracted.fields),
    // Explicit values from the user's message must win over model extraction.
    ...extractExplicitFields(entity, text),
  };
  // 轻量启发式（仅作为提示，不影响 LLM 通用推断）
  const heuristic = await applyEntityHeuristics(entity, mergedDraft);
  mergedDraft = heuristic.draft;
  // 外键字段允许用户只给编码或名称，这里统一解析成 id
  let fkResult = await resolveForeignKeyValues(entity, mergedDraft).catch(() => ({
    payload: mergedDraft,
    resolved: [] as string[],
  }));
  let draft = fkResult.payload;
  // 通用补全：交给 LLM 推断剩余必填字段，推不出或有歧义的字段才回问用户
  const inferred = await inferMissingFields(entity, text, draft, action, provider, profile);
  if (Object.keys(inferred.fields).length > 0) {
    draft = { ...draft, ...normalizeEntityFields(entity, inferred.fields) };
    fkResult = await resolveForeignKeyValues(entity, draft).catch(() => ({ payload: draft, resolved: [] as string[] }));
    draft = fkResult.payload;
  }
  const missingRequired = missingRequiredFields(entity, draft);
  const ambiguousKeys = new Set(
    inferred.ambiguous.map((value) => toFieldKey(entity, String(value))).filter(Boolean) as string[],
  );
  const ambiguousLabels = missingRequired
    .filter((field) => ambiguousKeys.has(field.key))
    .map((field) => field.label);
  // 只按「LLM 补完之后仍然缺失」的字段追问，避免把已经推断出来的字段又问一遍
  const missingLabels = [...new Set(missingRequired.map((field) => field.label))];

  if (missingLabels.length > 0 && !existing) {
    return {
      status: "needs_more" as const,
      reply: ambiguousLabels.length
        ? `${action === "update" ? "修改" : "创建"}${entity.label}时，这些字段有多种可能的取值，需要你确认：${ambiguousLabels.join("、")}`
        : `${action === "update" ? "修改" : "创建"}${entity.label}还缺少这些信息：${missingLabels.join("、")}`,
      nextQuestions: ambiguousLabels.length ? ambiguousLabels : missingLabels,
    };
  }

  // 只写入允许插入的列，避免把 id / 审计字段带进 payload
  const insertable = new Set(
    entity.insertableFields.length ? entity.insertableFields : Object.keys(draft),
  );
  const payload: Record<string, unknown> = { updated_at: nowIso() };
  for (const [key, value] of Object.entries(draft)) {
    if (insertable.has(key)) payload[key] = value;
  }
  if (hasColumn(entity, "is_deleted") && payload.is_deleted === undefined) {
    payload.is_deleted = "n";
  }
  // 写入必须显式带 tenant_id。
  // 不能指望表上的 DEFAULT current_tenant_id()：那个函数靠 auth.uid() 解析，
  // ai-server 走 service_role 时 auth.uid() 恒为 NULL，默认值会解析成 NULL，
  // 撞上 NOT NULL 直接报错；就算不报错，service_role 也绕过了那条 RLS 校验。
  if (isTenantScopedTable(entity.tableName)) {
    payload.tenant_id = tenantId;
  }

  const isUpdate = !!existing?.id;
  if (action === "update" && !isUpdate) {
    return {
      status: "needs_more" as const,
      reply: `没有找到可修改的${entity.label}，请先明确要修改哪一条记录。`,
      nextQuestions: [`请提供要修改的${entity.label}名称或编码`],
    };
  }
  const tableTag = baseTableName(entity.tableName);
  if (!isUpdate) {
    const duplicate = await findDuplicate(entity, draft, tenantId);
    if (duplicate) {
      const dupName = String(
        duplicate[entity.nameField || entity.codeField || "id"] || duplicate.id || "-",
      );
      // 系统字典与业务表是两套数据，命中重复时提示用户可能选错了表
      const crossHint =
        tableTag === "sys_dict_items"
          ? "如果你要加的是物料级业务数据（如 erp_uoms），请去掉“字典”二字再说一次。"
          : "如果你说的是系统字典（sys_dict_items 下的数据），请明确说“在字典里加”。";
      return {
        status: "error" as const,
        reply: `${entity.label}「${dupName}」已存在于表 ${tableTag}，无法重复创建。${crossHint}如需修改，请说“修改${entity.label} ${dupName}”。`,
      };
    }
  }

  // UPDATE 同样要限定租户：只按 id 更新等于可以改到别的租户的行
  const response = isUpdate
    ? await (isTenantScopedTable(entity.tableName)
        ? supabase.from(entity.tableName).update(payload).eq("id", existing.id).eq("tenant_id", tenantId)
        : supabase.from(entity.tableName).update(payload).eq("id", existing.id)
      ).select().single()
    : await supabase.from(entity.tableName).insert(payload).select().single();
  if (response.error) throw response.error;
  const row = response.data as Record<string, unknown>;
  const displayName = String(row[entity.nameField || entity.codeField || "id"] || row.id || "-");
  const routeInfo = await findEntityRoute(entity).catch(() => null);
  const autoFillNotes = [...heuristic.reasoning, ...inferred.reasoning];
  return {
    status: "success" as const,
    reply: `${isUpdate ? "已更新" : "已创建"}${entity.label}：${displayName}（写入表 ${tableTag}）${extracted.summary ? `\n${extracted.summary}` : ""}${
      fkResult.resolved.length ? `\n已自动解析关联字段：${fkResult.resolved.join("、")}` : ""
    }${autoFillNotes.length ? `\n自动补全：${autoFillNotes.join("；")}` : ""}`,
    data: row,
    route: routeInfo?.route,
    routeLabel: routeInfo?.routeLabel,
    focus: { type: entity.key, id: row.id, code: row[entity.codeField || "code"], name: row[entity.nameField || entity.codeField || "name"], route: routeInfo?.route },
  };
}

async function loadBaqCatalog(): Promise<BaqTable[]> {
  const { data: tableRows, error: tableError } = await supabase
    .from("sys_tables")
    .select("table_name, table_label, module_name")
    .eq("is_deleted", "n")
    .eq("status", "1")
    .order("module_name")
    .order("table_name");
  if (tableError) throw tableError;

  const { data: catalogData, error: catalogError } = await supabase.rpc("baq_catalog");
  if (catalogError) throw catalogError;
  const catalog = (catalogData || []) as BaqTable[];
  const columnsByTable = new Map(catalog.map((item) => [item.table, item.columns]));

  return ((tableRows || []) as Array<Record<string, unknown>>)
    .filter((row) => String(row.table_name || "").startsWith("erp_"))
    .map((row) => {
      const table = String(row.table_name);
      return {
        table,
        label: String(row.table_label || table),
        columns: columnsByTable.get(table) || [],
      };
    })
    .filter((item) => item.columns.length > 0);
}

const normalizeText = (value: string) => value.toLowerCase().replace(/\s+/g, "");

const ANALYSIS_TARGET_HINTS: Record<string, string[]> = {
  customer: ["客户", "客商", "customer"],
  supplier: ["供应商", "supplier"],
  product: ["物料", "产品", "商品", "material", "item", "product"],
  warehouse: ["仓库", "库位", "warehouse", "bin"],
  department: ["部门", "department"],
  workCenter: ["工作中心", "work center", "workcenter"],
  operation: ["工序", "operation"],
  bom: ["bom", "物料清单"],
  routing: ["工艺路线", "routing"],
  purchaseOrder: ["采购订单", "采购单", "purchase order", "po"],
  purchaseReceipt: ["采购入库", "入库单", "receipt"],
  salesOrder: ["销售订单", "销售单", "sales order", "so"],
  salesDelivery: ["销售出货", "出货单", "delivery"],
  productionOrder: ["生产订单", "工单", "production order", "mo"],
  inventory: ["库存", "现存量", "存货", "inventory"],
  finance: ["财务", "凭证", "应收", "应付", "profit", "voucher"],
  production: ["生产", "mrp", "产能", "缺料"],
  business: ["业务", "经营", "分析", "统计"],
};

const pickAnalysisCatalog = (catalog: BaqTable[], state: AiGraphState) => {
  const terms = new Set<string>();
  const target = String(state.target || "");
  const query = String(state.text || "");
  const domain = String(state.domain || "");
  const queryMode = String(state.queryMode || "");
  [target, domain, queryMode].forEach((value) => {
    if (value) terms.add(normalizeText(value));
  });
  Object.values(ANALYSIS_TARGET_HINTS).flat().forEach((hint) => {
    if (normalizeText(query).includes(normalizeText(hint))) {
      terms.add(normalizeText(hint));
    }
  });

  const scored = catalog.map((item) => {
    const haystack = normalizeText(
      `${item.table} ${item.label} ${item.columns.map((c) => c.name).join(" ")}`,
    );
    let score = 0;
    for (const hintGroup of Object.values(ANALYSIS_TARGET_HINTS)) {
      for (const hint of hintGroup) {
        if (haystack.includes(normalizeText(hint))) {
          score += 1;
        }
      }
    }
    if (terms.size) {
      for (const term of terms) {
        if (haystack.includes(term)) score += 3;
      }
    }
    return { item, score };
  });

  return scored
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 20)
    .map(({ item }) => item);
};

const stripMarkdownFence = (value: string) => {
  const trimmed = value.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return (fenced ? fenced[1] : trimmed).trim();
};

const normalizeAnalysisSql = (sql: string) => {
  const cleaned = stripMarkdownFence(sql);
  const lower = cleaned.toLowerCase();
  const selectIndex = lower.indexOf("select");
  const withIndex = lower.indexOf("with");
  const startIndex =
    selectIndex >= 0 && withIndex >= 0
      ? Math.min(selectIndex, withIndex)
      : Math.max(selectIndex, withIndex);
  const sliced = startIndex >= 0 ? cleaned.slice(startIndex) : cleaned;
  return sliced.replace(/;\s*$/, "").trim();
};

const parseAnalysisPlan = (value: string): AnalysisPlan | null => {
  try {
    return JSON.parse(stripMarkdownFence(value)) as AnalysisPlan;
  } catch {
    return null;
  }
};

/** 找出 SQL 里实际引用的业务表（erp_*）。 */
const referencedErpTables = (sql: string, catalog: BaqTable[]) =>
  catalog
    .map((item) => item.table)
    .filter((table) => isTenantScopedTable(table))
    .filter((table) => new RegExp(`\\b${table}\\b`, "i").test(sql));

/**
 * 租户过滤的静态校验。
 *
 * execute_ai_analysis 是 SECURITY DEFINER，service_role 调用时 RLS 完全不生效，
 * 它执行的 SQL 必须自己带 tenant_id。这里做启发式校验：
 * 引用了 N 张业务表，就必须至少出现 N 处 tenant_id 条件。
 *
 * 这不是万能的（挡不住「条件写给了别的表」这类错误），但能挡住绝大多数漏写。
 * 真正的收敛方向是让分析走 BAQ 结构化查询——那种 SQL 由服务端拼装，可 100% 注入。
 */
const assertAnalysisSqlTenantScoped = (sql: string, catalog: BaqTable[], tenantId: number) => {
  const referenced = referencedErpTables(sql, catalog);
  if (referenced.length === 0) return;
  const hits = (sql.match(/tenant_id/gi) || []).length;
  if (hits < referenced.length) {
    throw new Error(
      `分析 SQL 缺少租户过滤：引用了 ${referenced.length} 张业务表（${referenced.join("、")}），` +
        `但只出现 ${hits} 处 tenant_id 条件。每张 erp_ 表都必须带 tenant_id = ${tenantId}。`,
    );
  }
};

const validateAnalysisSql = (sql: string, catalog: BaqTable[], tenantId: number) => {
  const text = normalizeAnalysisSql(sql);
  if (!text) throw new Error("分析 SQL 不能为空");
  if (!/^\s*(select|with)\b/i.test(text)) throw new Error("分析 SQL 只能是 SELECT/WITH");
  if (text.includes(";")) throw new Error("分析 SQL 不能包含分号");
  if (/\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|comment|commit|rollback)\b/i.test(text)) {
    throw new Error("分析 SQL 只能是只读查询");
  }

  const tableNames = catalog.map((item) => item.table);
  if (!tableNames.some((table) => new RegExp(`\\b${table.replace(/_/g, "_")}\\b`, "i").test(text))) {
    throw new Error("分析 SQL 必须引用 sys_tables/baq_catalog 中的真实业务表");
  }

  assertAnalysisSqlTenantScoped(text, catalog, tenantId);
};

/**
 * 执行分析 SQL。
 *
 * 优先调 execute_ai_analysis_for_tenant（deploy_42 提供，数据库侧再做一层兜底校验）。
 * 该函数是独立名字而非同名重载：PostgREST 的 schema cache 对同名重载只暴露一个
 * /rpc/<name> 端点，选错的表现是运行时报缺参数，排查成本高。
 * 若它尚未部署（PGRST202），退回原版本——此时仅靠本文件的静态校验保护。
 */
const executeAiAnalysisSql = async (sql: string, tenantId: number) => {
  console.log("[ai-server] execute AI analysis SQL:", sql);
  const scoped = await supabase.rpc("execute_ai_analysis_for_tenant", {
    sql_text: sql,
    p_tenant_id: tenantId,
  });
  if (!scoped.error) {
    return scoped.data as { rows?: Array<Record<string, unknown>>; rowCount?: number } | null;
  }

  const isMissingFunction = String((scoped.error as { code?: string }).code || "") === "PGRST202";
  if (!isMissingFunction) throw scoped.error;

  console.warn(
    "[ai-server] execute_ai_analysis_for_tenant 未部署，退回无租户校验的版本。" +
      "请执行 supabase/tables/deploy_42_ai_tenant.sql 以启用数据库侧租户校验。",
  );
  const fallback = await supabase.rpc("execute_ai_analysis", { sql_text: sql });
  if (fallback.error) throw fallback.error;
  return fallback.data as { rows?: Array<Record<string, unknown>>; rowCount?: number } | null;
};

async function findBaqTarget(text: string, tenantId: number, focus?: unknown) {
  const { data, error } = await supabase
    .from("sys_baq_queries")
    .select("*")
    .eq("is_deleted", "n")
    .eq("tenant_id", tenantId)
    .order("updated_at", { ascending: false });
  if (error) throw error;
  const items = (data || []) as Array<Record<string, unknown>>;
  const normalized = normalize(text);
  const byFocus = focus && typeof focus === "object" ? (focus as Record<string, unknown>) : null;
  const focusCandidate = byFocus?.id ? items.find((item) => String(item.id) === String(byFocus.id)) || null : null;
  if (focusCandidate) return focusCandidate;
  const namedTarget = items.find((item) => normalized.includes(normalize(String(item.code || ""))) || normalized.includes(normalize(String(item.name || ""))));
  if (namedTarget) return namedTarget;
  if (/(修改|更新|编辑|调整|优化|补充|继续|刚才|刚刚|这个|它|上一个)/i.test(text)) {
    return items[0] || null;
  }
  return null;
}

const mergeBaqDefinition = (current: unknown, next: unknown) => {
  const currentDefinition = current && typeof current === "object" ? current as Record<string, unknown> : {};
  const nextDefinition = next && typeof next === "object" ? next as Record<string, unknown> : {};
  return {
    source: nextDefinition.source || currentDefinition.source,
    joins: Array.isArray(nextDefinition.joins) ? nextDefinition.joins : (Array.isArray(currentDefinition.joins) ? currentDefinition.joins : []),
    fields: Array.isArray(nextDefinition.fields) ? nextDefinition.fields : (Array.isArray(currentDefinition.fields) ? currentDefinition.fields : []),
    filters: Array.isArray(nextDefinition.filters) ? nextDefinition.filters : (Array.isArray(currentDefinition.filters) ? currentDefinition.filters : []),
    sorts: Array.isArray(nextDefinition.sorts) ? nextDefinition.sorts : (Array.isArray(currentDefinition.sorts) ? currentDefinition.sorts : []),
  };
};

const normalizeBaqDefinition = (definition: unknown) => {
  if (!definition || typeof definition !== "object") return null;
  const value = definition as Record<string, unknown>;
  const source = value.source as Record<string, unknown> | undefined;
  if (!source?.table) return null;

  return {
    source: { table: String(source.table), alias: String(source.alias || "t0") },
    joins: Array.isArray(value.joins) ? value.joins : [],
    fields: Array.isArray(value.fields) ? value.fields : [],
    filters: Array.isArray(value.filters) ? value.filters : [],
    sorts: Array.isArray(value.sorts) ? value.sorts : [],
  };
};

const validateBaqDefinition = (definition: Record<string, unknown>, catalog: BaqTable[]) => {
  const tables = new Map(catalog.map((item) => [item.table, item]));
  const source = definition.source as { table?: string; alias?: string };
  if (!source?.table || !tables.has(source.table)) {
    throw new Error(`BAQ主表不存在：${source?.table || "-"}`);
  }
  const aliases = new Map([[source.alias || "t0", source.table]]);
  for (const join of definition.joins as Array<Record<string, unknown>>) {
    const table = String(join.table || "");
    const alias = String(join.alias || "");
    const leftAlias = String(join.leftAlias || "");
    const leftField = String(join.leftField || "");
    const rightField = String(join.rightField || "");
    const leftTable = tables.get(aliases.get(leftAlias) || "");
    const rightTable = tables.get(table);
    if (!rightTable || !alias || aliases.has(alias) || !leftTable) {
      throw new Error(`BAQ关联配置无效：${table || alias}`);
    }
    if (!leftTable.columns.some((column) => column.name === leftField) ||
        !rightTable.columns.some((column) => column.name === rightField)) {
      throw new Error(`BAQ关联字段不存在：${leftAlias}.${leftField} = ${table}.${rightField}`);
    }
    aliases.set(alias, table);
  }
  const fields = definition.fields as Array<Record<string, unknown>>;
  if (!fields.length) throw new Error("BAQ至少需要一个输出字段");
  for (const field of fields) {
    const table = tables.get(aliases.get(String(field.tableAlias || "")) || "");
    if (!table?.columns.some((column) => column.name === field.field)) {
      throw new Error(`BAQ输出字段不存在：${field.tableAlias}.${field.field}`);
    }
    if (!field.alias) field.alias = field.field;
    if (!["none", "sum", "count", "avg", "min", "max"].includes(String(field.aggregate || "none"))) {
      throw new Error(`BAQ聚合方式无效：${field.aggregate}`);
    }
  }
  const fieldAliases = new Set(fields.map((field) => String(field.alias || field.field)));
  for (const sort of definition.sorts as Array<Record<string, unknown>>) {
    if (!fieldAliases.has(String(sort.fieldAlias || ""))) {
      throw new Error(`BAQ排序字段不存在：${sort.fieldAlias}`);
    }
  }
};

export async function createOrUpdateBaqTool(state: AiGraphState): Promise<ToolResult> {
  const tenantId = requireTenantId(state);
  const catalog = await loadBaqCatalog();
  const target = await findBaqTarget(state.text, tenantId, state.currentFocus);
  const current = target || null;
  const prompt = [
    "你是 OPERP BAQ 设计助手。请根据用户的完整需求设计真正可执行的 BAQ，不要只创建一条空记录。",
    "请分析应该使用哪张主表、关联哪些表、关联字段、输出字段、分组聚合、筛选条件和排序方式。",
    "只返回 JSON，不要 Markdown，不要解释。必须包含 name、code、description、definition。",
    "definition 必须完整包含 source、joins、fields、filters、sorts。",
    "source 格式为 {table, alias}，主表 alias 固定为 t0。",
    "join 格式为 {id,type,table,alias,leftAlias,leftField,rightField}，type 只能是 left 或 inner。",
    "field 格式为 {id,alias,field,groupBy,aggregate,tableAlias}，aggregate 只能是 none、sum、count、avg、min、max。",
    "filter 格式为 {id,tableAlias,field,operator,value}，operator 只能是 eq、neq、gt、gte、lt、lte、like、is_null、not_null。",
    "sort 格式为 {id,fieldAlias,direction}，direction 只能是 asc 或 desc。",
    "如果用户要求统计、数量、金额、合计或平均值，必须正确设置 aggregate 和 groupBy。",
    "只能从下面数据目录的 table 字段中选择真实表名，不能使用 PartBin、Part、Customer 等 ERP 逻辑表名，也不能使用中文字段名或臆造字段。",
    "如果需求无法匹配数据目录中的真实表和字段，必须返回 definition 为空，而不是猜测表名。",
    current ? `当前BAQ：${JSON.stringify(current)}` : "当前BAQ：无",
    `数据目录：${JSON.stringify(catalog)}`,
    `用户原话：${state.text}`,
    "如果用户是在修改已有BAQ，请尽量保留原有结构并仅按要求调整。",
  ].join("\n");
  const { content } = await callChatModel([{ role: "system", content: "只返回JSON。" }, { role: "user", content: prompt }], state.provider);
  const parsed = parseJson<{ name?: string; code?: string; description?: string; definition?: unknown }>(content);
  const isUpdate = Boolean(current?.id);
  const definition = normalizeBaqDefinition(
    isUpdate ? mergeBaqDefinition(current?.definition, parsed?.definition) : parsed?.definition,
  );
  if (!definition) {
    return {
      status: "error",
      reply: isUpdate
        ? "BAQ 修改失败：没有找到可修改的 BAQ 定义，请先明确 BAQ 名称或编码。"
        : "BAQ 创建失败：模型未生成有效的查询定义。",
    };
  }
  validateBaqDefinition(definition, catalog);
  const baq = {
    id: current?.id as number | undefined,
    code: String(parsed?.code || current?.code || `baq_${Date.now()}`),
    name: String(parsed?.name || current?.name || "未命名查询"),
    description: String(parsed?.description || current?.description || ""),
    status: "draft" as const,
    definition,
  };
  const payload = {
    code: baq.code,
    name: baq.name,
    description: baq.description || null,
    status: "draft",
    definition: baq.definition,
    tenant_id: tenantId,
    updated_at: nowIso(),
  };
  const response = baq.id
    ? await supabase.from("sys_baq_queries").update(payload).eq("id", baq.id).eq("tenant_id", tenantId).select().single()
    : await supabase.from("sys_baq_queries").insert(payload).select().single();
  if (response.error) throw response.error;
  const saved = response.data as Record<string, unknown>;
  const definitionSummary = `数据源：${String((definition.source as Record<string, unknown>).table || "-")}\n关联表：${Array.isArray(definition.joins) ? definition.joins.length : 0} 张\n输出字段：${Array.isArray(definition.fields) ? definition.fields.length : 0} 个\n筛选条件：${Array.isArray(definition.filters) ? definition.filters.length : 0} 个\n排序条件：${Array.isArray(definition.sorts) ? definition.sorts.length : 0} 个`;
  return {
    status: "success",
    reply: `${baq.id ? "BAQ 已更新" : "BAQ 已创建"}：${String(saved.name || baq.name)}\n编码：${String(saved.code || baq.code)}\n\n${definitionSummary}`,
    data: saved,
    focus: { type: "baq", id: saved.id, code: saved.code, name: saved.name },
  };
}

export async function createOrUpdateEntityTool(
  state: AiGraphState,
  action: "create" | "update" = "create",
): Promise<ToolResult> {
  // 实体来自数据库目录（sys_tables），target 由意图路由给出，
  // 文本与焦点作为兜底，最后再让模型从真实表清单里挑一张。
  const resolution = await resolveEntityForState(state);
  if (resolution.error) {
    return { status: "error", reply: resolution.error };
  }
  const entity = resolution.def as EntityDef;
  if (!entity) {
    return { status: "error", reply: "未识别出要处理的业务对象。" };
  }
  if (!entity.writable) {
    return {
      status: "error",
      reply: `${entity.label}（${entity.tableName}）是只读对象：${entity.readOnlyReason}。我可以帮你查询、统计或分析，不能新增、修改、删除。`,
    };
  }
  if (/删除|删掉|移除|清空/.test(state.text)) {
    const policy = evaluateDeletePolicy();
    return { status: "error", reply: `${entity.label}不支持 AI 删除：${policy.reason}。` };
  }
  const tenantId = requireTenantId(state);
  return upsertEntity(entity, tenantId, state.text, state.currentFocus, state.provider, action);
}

export async function businessAnalysisTool(state: AiGraphState): Promise<ToolResult> {
  const tenantId = requireTenantId(state);
  const catalog = await loadBaqCatalog();
  const selectedCatalog = pickAnalysisCatalog(catalog, state);
  const prompt = [
    "你是 OPERP 业务分析 SQL 生成器。",
    "目标：根据用户问题，自动判断要分析什么业务，挑选合适的表和字段，生成只读 SQL，然后用于统计分析。",
    "你必须先理解用户要查的对象、指标、时间范围、分组维度、排序方式，再决定 SQL。",
    "如果用户问题不完整，请先给出一个最合理的默认决策，不要直接拒绝。",
    "只返回 JSON，不要 Markdown，不要解释。",
    "输出格式：{\"title\":\"...\",\"sql\":\"...\",\"explanation\":\"...\",\"responseMode\":\"text|table|card\",\"target\":\"...\",\"queryMode\":\"count|list|summary|detail|trend|compare|exception|answer\"}",
    "sql 必须是单条 SELECT 或 WITH 查询，只读，不允许 INSERT/UPDATE/DELETE。",
    `本次查询的租户 tenant_id = ${tenantId}。`,
    `【强制】SQL 中每引用一张 erp_ 业务表，都必须给该表加过滤条件 tenant_id = ${tenantId}；`,
    `多表 JOIN 时每张表都要各加一次，用表别名限定，例如 t0.tenant_id = ${tenantId} AND t1.tenant_id = ${tenantId}。`,
    "缺少该条件的 SQL 会被服务端直接拒绝执行，请务必不要遗漏。",
    "你可以使用下面的数据目录来选择真实业务表和字段。",
    `用户原话：${state.text}`,
    state.target ? `路由目标：${state.target}` : "路由目标：无",
    state.queryMode ? `路由模式：${state.queryMode}` : "路由模式：无",
    state.responseMode ? `路由展示：${state.responseMode}` : "路由展示：无",
    state.currentFocus ? `当前焦点：${JSON.stringify(state.currentFocus)}` : "当前焦点：无",
    `数据目录：${JSON.stringify(selectedCatalog.length ? selectedCatalog : catalog.slice(0, 20))}`,
    "优先生成能直接执行的 SQL；如果需要关联，请根据字段语义推断主外键关系，如 xxx_id -> id、code/name 等。",
    "如果问题是数量，优先用 COUNT(*) 或分组 count；如果问题是明细，用列表查询；如果问题是趋势/对比，用分组统计或时间序列。",
  ].join("\n");

  const { content } = await callChatModel(
    [
      { role: "system", content: "你只输出 JSON。" },
      { role: "user", content: prompt },
    ],
    state.provider,
  );

  const plan = parseAnalysisPlan(content);
  if (!plan?.sql) {
    return {
      status: "error",
      reply: "业务分析失败：模型未生成有效的 SQL。",
    };
  }

  console.log("[ai-server] analysis plan raw:", {
    title: plan.title,
    target: plan.target,
    queryMode: plan.queryMode,
    responseMode: plan.responseMode,
    sql: plan.sql,
  });
  plan.sql = normalizeAnalysisSql(plan.sql);
  console.log("[ai-server] analysis plan normalized SQL:", plan.sql);
  validateAnalysisSql(plan.sql, selectedCatalog.length ? selectedCatalog : catalog, tenantId);
  const executed = await executeAiAnalysisSql(plan.sql, tenantId);
  const rows = Array.isArray(executed?.rows) ? executed!.rows! : [];

  const previewRows = rows.slice(0, 20);
  const columns = previewRows.length
    ? Object.keys(previewRows[0])
    : [];
  const isSingleValue =
    previewRows.length === 1 && columns.length === 1 && typeof previewRows[0][columns[0]] !== "object";

  const renderTable = (dataRows: Array<Record<string, unknown>>) => {
    if (!dataRows.length) return "暂无数据。";
    const headers = Object.keys(dataRows[0]);
    const headerLine = `| ${headers.join(" | ")} |`;
    const separator = `| ${headers.map(() => "---").join(" | ")} |`;
    const body = dataRows
      .map((row) => `| ${headers.map((header) => String(row[header] ?? "")).join(" | ")} |`)
      .join("\n");
    return `${headerLine}\n${separator}\n${body}`;
  };

  const reply = isSingleValue
    ? `${plan.title || "分析结果"}：${String(previewRows[0][columns[0]])}`
    : [
        plan.title ? `# ${plan.title}` : "# 业务分析结果",
        plan.explanation ? `\n${plan.explanation}` : "",
        "\n" + renderTable(previewRows),
        rows.length > previewRows.length ? `\n\n已显示前 ${previewRows.length} 条，共 ${rows.length} 条。` : "",
      ].join("\n");

  return {
    status: "success",
    reply,
    data: {
      sql: plan.sql,
      target: plan.target || state.target,
      queryMode: plan.queryMode || state.queryMode,
      responseMode: plan.responseMode || state.responseMode,
      rowCount: rows.length,
      rows: previewRows,
      catalog: selectedCatalog.map((item) => ({ table: item.table, label: item.label })),
    },
    focus: {
      type: "business_analysis",
      target: plan.target || state.target,
      queryMode: plan.queryMode || state.queryMode,
      responseMode: plan.responseMode || state.responseMode,
      sql: plan.sql,
    },
  };
}

export async function countMasterDataTool(state: AiGraphState): Promise<ToolResult> {
  const resolution = await resolveEntityForState(state);
  if (resolution.error || !resolution.def) {
    return {
      status: "needs_more",
      reply: "请明确要统计哪类数据，比如客户、物料、计量单位、仓库、采购订单。",
      nextQuestions: ["客户", "物料", "计量单位", "供应商", "仓库"],
    };
  }
  const entity = resolution.def as EntityDef;
  const tenantId = requireTenantId(state);

  let query = supabase
    .from(entity.tableName)
    .select("*", { count: "exact", head: true });
  if (hasColumn(entity, "is_deleted")) query = query.eq("is_deleted", "n");
  if (isTenantScopedTable(entity.tableName)) query = query.eq("tenant_id", tenantId);
  const { count, error } = await query;

  if (error) throw error;

  return {
    status: "success",
    reply: `当前系统中${entity.label}共有 ${count || 0} 条。`,
    data: {
      entity: entity.key,
      label: entity.label,
      table: entity.tableName,
      count: count || 0,
    },
    focus: {
      type: entity.key,
      count: count || 0,
    },
  };
}

export async function financeSummaryTool(state: AiGraphState): Promise<ToolResult> {
  const tenantId = requireTenantId(state);
  const [receivablesRes, payablesRes, vouchersRes, assetsRes] = await Promise.all([
    supabase.from("erp_receivables_s_539dcf81_b").select("*").eq("is_deleted", "n").eq("tenant_id", tenantId),
    supabase.from("erp_payables_s_539dcf81_b").select("*").eq("is_deleted", "n").eq("tenant_id", tenantId),
    supabase.from("erp_vouchers_s_539dcf81_b").select("*").eq("is_deleted", "n").eq("tenant_id", tenantId),
    supabase.from("erp_fixed_assets_s_539dcf81_b").select("*").eq("is_deleted", "n").eq("tenant_id", tenantId),
  ]);
  if (receivablesRes.error) throw receivablesRes.error;
  if (payablesRes.error) throw payablesRes.error;
  if (vouchersRes.error) throw vouchersRes.error;
  if (assetsRes.error) throw assetsRes.error;

  const receivables = (receivablesRes.data || []) as Array<Record<string, unknown>>;
  const payables = (payablesRes.data || []) as Array<Record<string, unknown>>;
  const vouchers = (vouchersRes.data || []) as Array<Record<string, unknown>>;
  const assets = (assetsRes.data || []) as Array<Record<string, unknown>>;
  const sum = (rows: Array<Record<string, unknown>>, field: string) =>
    rows.reduce((acc, row) => acc + Number(row[field] || 0), 0);
  const currentDate = today();
  const overdueReceivables = receivables.filter((row) => String(row.due_date || "") < currentDate && Number(row.balance || 0) > 0);
  const overduePayables = payables.filter((row) => String(row.due_date || "") < currentDate && Number(row.balance || 0) > 0);
  const topReceivables = [...receivables].sort((a, b) => Number(b.balance || 0) - Number(a.balance || 0)).slice(0, 5);
  const topPayables = [...payables].sort((a, b) => Number(b.balance || 0) - Number(a.balance || 0)).slice(0, 5);

  const money = (value: unknown) => Number(value || 0).toFixed(2);
  const renderTopRows = (title: string, rows: Array<Record<string, unknown>>, nameField: string, amountField: string) =>
    rows.length
      ? `### ${title}\n| 名称 | 金额 |\n| --- | ---: |\n${rows.map((row) => `| ${String(row[nameField] || row.doc_no || row.id || "-")} | ${money(row[amountField])} |`).join("\n")}`
      : `### ${title}\n暂无`;

  const reply = [
    `# 财务分析报表`,
    ``,
    `## 关键指标`,
    `- 应收单据：${receivables.length} 条`,
    `- 应收余额：${sum(receivables, "balance").toFixed(2)}`,
    `- 逾期应收：${overdueReceivables.length} 条，逾期金额 ${sum(overdueReceivables, "balance").toFixed(2)}`,
    `- 应付单据：${payables.length} 条`,
    `- 应付余额：${sum(payables, "balance").toFixed(2)}`,
    `- 逾期应付：${overduePayables.length} 条，逾期金额 ${sum(overduePayables, "balance").toFixed(2)}`,
    `- 凭证数量：${vouchers.length} 张，金额合计 ${sum(vouchers, "total_amount").toFixed(2)}`,
    `- 固资数量：${assets.length} 项，净值合计 ${sum(assets, "net_value").toFixed(2)}`,
    ``,
    `## 风险提示`,
    overdueReceivables.length || overduePayables.length
      ? `- 存在逾期账款，建议优先跟进回款与付款。`
      : `- 当前未发现明显逾期账款。`,
    `- 财务数据以当前已启用单据为准。`,
    ``,
    renderTopRows("应收Top5", topReceivables, "customer_name", "balance"),
    ``,
    renderTopRows("应付Top5", topPayables, "supplier_name", "balance"),
  ].join("\n");

  return {
    status: "success",
    reply,
    data: {
      receivablesCount: receivables.length,
      payablesCount: payables.length,
      vouchersCount: vouchers.length,
      assetsCount: assets.length,
    },
  };
}
