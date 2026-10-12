import { supabase } from "../config/supabase.js";
import { tenantScopeFilter } from "../config/tenantContext.js";
import { entityRouteAliasGroups } from "../tools/entityRegistry.js";

/**
 * 菜单目录（导航用）。
 *
 * 背景：用户会问「采购订单菜单在哪里 / 菜单地址是什么」，希望答案里直接给出
 * **可点击跳转**的菜单链接；知识库问答答完也希望顺带给出「相关菜单」入口。
 *
 * 数据源＝`sys_menus`（与前端 ProLayout 用的是同一张表，所以路径一定对得上）。
 *
 * ⚠️ ai-server 走 service_role，**RLS 对它无效**，租户隔离必须自己拼：
 * 用 `tenantScopeFilter()` 取「平台基线(tenant_id IS NULL) + 本人租户」两套。
 * 已物化租户同时存在基线行与租户副本行（同 menu_code 两行）→ 按 menu_code 去重，
 * **本人租户自建行优先**（租户可能改过名字），与项目里其他去重视图的排序口径一致。
 */

export interface MenuCatalogEntry {
  id: number;
  name: string;
  code: string;
  path: string;
  /** 上级链路，如「进销存管理 → 采购订单」；根节点就是自身名字 */
  breadcrumb: string;
  /** 上级链路（不含自身），如「进销存管理」 */
  parentPath: string;
  tenantId: number | null;
  /** 同义别名（实体 key / 中文标签 / routeHints），让「purchaseOrder 菜单在哪」也能命中 */
  aliases: string[];
}

interface MenuRow {
  id: number;
  tenant_id: number | null;
  parent_id: number | null;
  menu_name: string | null;
  menu_code: string | null;
  path: string | null;
  sort_order: number | null;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { entries: MenuCatalogEntry[]; expiresAt: number }>();

/** 菜单维护后（增删改菜单）可调用它立即失效缓存 */
export function invalidateMenuCatalogCache(tenantId?: number): void {
  if (tenantId === undefined) {
    cache.clear();
    return;
  }
  cache.delete(`tenant:${tenantId}`);
}

const norm = (value: string) => value.toLowerCase().replace(/[\s_\-/·.（）()]/g, "");

/** 中文字符二元组（bigram）：用于「采购单」≈「采购订单」这类口语化匹配 */
const bigrams = (value: string): string[] => {
  if (value.length <= 1) return value ? [value] : [];
  const grams: string[] = [];
  for (let i = 0; i < value.length - 1; i += 1) grams.push(value.slice(i, i + 2));
  return grams;
};

const bigramOverlap = (a: string, b: string): number => {
  const left = bigrams(a);
  const right = new Set(bigrams(b));
  if (!left.length || !right.size) return 0;
  let hit = 0;
  for (const gram of left) if (right.has(gram)) hit += 1;
  return hit / left.length;
};

/**
 * 取菜单目录（按租户缓存 5 分钟）。
 * 只有带 `path` 的节点能跳转，所以没有 path 的按钮/权限型菜单直接剔除。
 */
export async function fetchMenuCatalog(
  tenantId?: number | null,
): Promise<MenuCatalogEntry[]> {
  const cacheKey = `tenant:${tenantId ?? "null"}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.entries;

  const { data, error } = await supabase
    .from("sys_menus")
    .select("id, tenant_id, parent_id, menu_name, menu_code, path, sort_order")
    .eq("is_deleted", "n")
    .eq("status", "1")
    .or(tenantScopeFilter(tenantId))
    .order("sort_order", { ascending: true });

  if (error) throw error;

  const rows = ((data || []) as MenuRow[]).filter(
    (row) => row.menu_name && row.path && row.path.startsWith("/"),
  );

  const byId = new Map<number, MenuRow>();
  for (const row of rows) byId.set(Number(row.id), row);

  // 同 menu_code 两行（基线 + 租户副本）→ 保留本人租户自建的那行
  const picked = new Map<string, MenuRow>();
  for (const row of rows) {
    const key = row.menu_code ? `code:${row.menu_code}` : `path:${row.path}`;
    const prev = picked.get(key);
    if (!prev || (prev.tenant_id === null && row.tenant_id !== null)) {
      picked.set(key, row);
    }
  }

  const breadcrumbOf = (row: MenuRow): string[] => {
    const names: string[] = [];
    const seen = new Set<number>();
    let cursor: MenuRow | undefined = row;
    let depth = 0;
    while (cursor && depth < 6) {
      const id = Number(cursor.id);
      if (seen.has(id)) break;
      seen.add(id);
      names.unshift(String(cursor.menu_name || ""));
      const parentId = cursor.parent_id === null ? 0 : Number(cursor.parent_id);
      if (!parentId) break;
      cursor = byId.get(parentId);
      depth += 1;
    }
    return names.filter(Boolean);
  };

  const aliasGroups = entityRouteAliasGroups();

  const entries: MenuCatalogEntry[] = [...picked.values()].map((row) => {
    const name = String(row.menu_name || "");
    const chain = breadcrumbOf(row);
    const aliases: string[] = [];
    for (const group of aliasGroups) {
      const hit = group.hints.some(
        (hint) => name.includes(hint) || hint.includes(name),
      );
      if (hit) aliases.push(...group.aliases);
    }
    const nameNorm = norm(name);
    return {
      id: Number(row.id),
      name,
      code: String(row.menu_code || ""),
      path: String(row.path || ""),
      breadcrumb: chain.join(" → ") || name,
      parentPath:
        chain.length > 1
          ? chain.slice(0, -1).join(" → ")
          : "",
      tenantId: row.tenant_id === null ? null : Number(row.tenant_id),
      aliases: [...new Set(aliases)].filter(
        (alias) => norm(alias) && norm(alias) !== nameNorm,
      ),
    };
  });

  cache.set(cacheKey, {
    entries,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
  return entries;
}

/**
 * 问句里的导航噪音。
 *
 * 分四类依次剥（顺序重要，见 extractMenuKeyword）：
 *  1. 问路词：在哪 / 地址 / 路径 / 怎么打开 …（绝不会出现在菜单名里，随便删）
 *  2. 句尾语气词与方位词
 *  3. 头尾的菜单名词（**只切头尾、不切中间** —— 「菜单管理」是个真菜单，
 *     整句删「菜单」会把它切成「管理」）
 *  4. 客套前缀
 */
const NAV_QUESTION_PHRASES =
  /(在什么地方|在哪儿|在哪个|在哪里|怎么进入|怎么进|如何进入|怎么打开|如何打开|怎么去|怎么找|怎么走|跳转|转到|地址|路径|位置|入口|链接|网址|url|去哪儿|哪儿|哪里|哪一个|导航|在哪)/gi;
/** 头部的裸名词：后面紧跟被删掉的问路词（留了空格）才算，否则可能是「菜单管理」的一部分 */
const NAV_LEADING_NOUN = /^(菜单栏|菜单|页面|导航|界面|功能入口)(?=\s)/;
/** 尾部的菜单名词：没有哪个菜单名以「菜单/页面」结尾 */
const NAV_TRAILING_NOUN = /(菜单栏|菜单|页面|导航|界面|功能入口)\s*$/;
const NAV_EDGE = /^(请问|请|帮我|我想|我要|想知道|麻烦|我)/;
/** 句尾的语气词 / 方位词：「采购单在哪个菜单下」→「采购单」 */
const NAV_TAIL =
  /(呢|吗|啊|呀|哦|是什么|怎么走|怎么找|怎么样|在什么地方|[下里中上]|了|的)[？?。.!！]*$/;

const tidy = (value: string) => value.replace(/\s+/g, " ").trim();

/**
 * 从问句里抽出「要找的菜单名」。
 * 例：「采购订单菜单在哪里？」→「采购订单」；「菜单地址是什么？」→「」（泛问，列模块）。
 */
export const extractMenuKeyword = (text: string): string => {
  let keyword = text
    .replace(/[？?。！!，,、；;：:（）()【】\[\]"'“”]/g, " ")
    .trim();

  // ① 问路词 → 空格（保留分隔信号，供 ② 判断头部名词是不是独立的）
  keyword = keyword.replace(NAV_QUESTION_PHRASES, " ");
  keyword = keyword.replace(NAV_LEADING_NOUN, " ");
  keyword = tidy(keyword);

  // ② 客套前缀 + 句尾语气/方位词（连剥两次：「菜单的地址呢」这类叠加）
  keyword = tidy(keyword.replace(NAV_EDGE, " "));
  for (let i = 0; i < 2; i += 1) {
    keyword = tidy(keyword.replace(NAV_TAIL, " "));
  }
  keyword = keyword.replace(/的/g, " ");

  // ③ 尾部菜单名词：「采购订单菜单」→「采购订单」
  keyword = tidy(keyword.replace(NAV_TRAILING_NOUN, " "));

  return tidy(keyword);
};

export interface MenuMatch {
  entry: MenuCatalogEntry;
  score: number;
}

/** 菜单匹配打分：精确名 > 别名 > 包含 > 路径/编码 > 二元组相似度 */
export function matchMenus(
  keyword: string,
  entries: MenuCatalogEntry[],
  limit = 5,
): MenuMatch[] {
  const kw = norm(keyword);
  if (!kw) return [];

  const scored: MenuMatch[] = [];
  for (const entry of entries) {
    const name = norm(entry.name);
    const code = norm(entry.code);
    const path = norm(entry.path);
    const aliases = entry.aliases.map(norm).filter(Boolean);
    let score = 0;

    if (name === kw) score = 100;
    else if (aliases.includes(kw)) score = 96;
    else if (name.includes(kw)) score = 88 + Math.min(8, kw.length);
    else if (aliases.some((alias) => alias.includes(kw)))
      score = 80 + Math.min(8, kw.length);
    else if (name.length >= 2 && kw.includes(name))
      score = 76 + Math.min(8, name.length);
    else if (code.includes(kw) || path.includes(kw))
      score = 60 + Math.min(8, kw.length);
    else {
      const overlap = Math.max(
        bigramOverlap(kw, name),
        ...aliases.map((alias) => bigramOverlap(kw, alias)),
        0,
      );
      if (overlap >= 0.34) score = 40 + Math.round(overlap * 30);
    }

    if (score > 0) scored.push({ entry, score });
  }

  return scored
    .sort(
      (a, b) =>
        b.score - a.score || a.entry.name.length - b.entry.name.length,
    )
    .slice(0, limit);
}

/** 把匹配结果渲染成 markdown 跳转列表（前端会把 /xxx 的链接变成站内跳转） */
export const buildMenuJumpSection = (matches: MenuMatch[]): string =>
  matches
    .map(({ entry }) => {
      const where = entry.parentPath ? `（${entry.parentPath}）` : "";
      return `- [${entry.name}](${entry.path})${where}`;
    })
    .join("\n");

const MENU_LINK_MIN_SCORE = 45;

/**
 * 用**用户问句**去猜相关菜单（知识库没检索到东西时的兜底引导）。
 * 阈值刻意比普通匹配高：宁可少给，也不要给出八竿子打不着的菜单。
 */
export async function suggestMenusForQuestion(
  question: string,
  tenantId?: number | null,
  limit = 3,
): Promise<MenuMatch[]> {
  const keyword = extractMenuKeyword(question);
  if (!keyword) return [];
  const entries = await fetchMenuCatalog(tenantId);
  return matchMenus(keyword, entries, limit).filter(
    (match) => match.score >= MENU_LINK_MIN_SCORE,
  );
}

const MARKDOWN_LINK_RE = /\]\(([^)]+)\)/g;

/**
 * 给回复追加「相关菜单（点击可直接跳转）」区块。
 *
 * 用在知识库问答 / 闲聊兜底：模型答完流程后往往会提到菜单名（如「采购订单」），
 * 这里按菜单名做**确定性**命中，把对应页面拼成跳转链接 —— 不让模型自己编路径。
 */
export async function appendMenuJumps(
  reply: string,
  tenantId?: number | null,
  max = 4,
): Promise<string> {
  const text = reply?.trim();
  if (!text || max <= 0) return reply;

  let entries: MenuCatalogEntry[] = [];
  try {
    entries = await fetchMenuCatalog(tenantId);
  } catch {
    return reply;
  }
  if (!entries.length) return reply;

  const already = new Set<string>();
  let match: RegExpExecArray | null;
  MARKDOWN_LINK_RE.lastIndex = 0;
  while ((match = MARKDOWN_LINK_RE.exec(text))) {
    already.add(match[1].trim());
  }

  const hits: MenuMatch[] = [];
  // 名字长的优先：更具体（「采购入库」比「采购」更贴近用户所指）
  const sorted = [...entries].sort((a, b) => b.name.length - a.name.length);
  for (const entry of sorted) {
    if (hits.length >= max) break;
    if (entry.name.length < 2) continue;
    if (already.has(entry.path)) continue;
    if (!text.includes(entry.name)) continue;
    hits.push({ entry, score: 0 });
  }
  if (!hits.length) return reply;

  return `${text}\n\n**相关菜单（点击可直接跳转）**\n${buildMenuJumpSection(hits)}`;
}
