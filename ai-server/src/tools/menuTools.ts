import type { AiGraphState } from "../ai/state.js";
import {
  buildMenuJumpSection,
  extractMenuKeyword,
  fetchMenuCatalog,
  matchMenus,
  type MenuCatalogEntry,
} from "../services/menuCatalog.js";

/**
 * 菜单定位工具（intent = navigation）。
 *
 * 用户问「采购订单菜单在哪里 / 菜单地址是什么 / XX 在哪个菜单下」时：
 * 去 `sys_menus` 里按菜单名匹配，回复**菜单名 + 完整路径 + 可点击跳转链接**。
 *
 * 刻意不设 `route` 字段：菜单命中可能有多条，单条 route 只能给一个按钮，
 * 而 markdown 链接（`[采购订单](/inventory/purchase)`）由前端渲染成站内跳转，
 * 既能列多条又贴着正文，更符合「在回复内容里就能点」的诉求。
 */
export interface MenuLocateResult {
  status: "success" | "needs_more";
  reply: string;
  data?: unknown;
  nextQuestions?: string[];
}

const rootMenus = (entries: MenuCatalogEntry[]): MenuCatalogEntry[] =>
  entries.filter((entry) => !entry.parentPath && entry.path !== "/");

export async function menuLocateTool(
  state: AiGraphState,
): Promise<MenuLocateResult> {
  let entries: MenuCatalogEntry[] = [];
  try {
    entries = await fetchMenuCatalog(state.tenantId);
  } catch {
    return {
      status: "success",
      reply: "暂时读不到菜单数据，请稍后重试。",
    };
  }

  if (!entries.length) {
    return {
      status: "success",
      reply: "当前租户下没有可用的菜单数据。",
    };
  }

  const keyword = extractMenuKeyword(state.text);

  // 泛问（「菜单地址是什么」）→ 列出各模块入口，让用户挑一个
  if (!keyword) {
    const roots = rootMenus(entries).slice(0, 12);
    return {
      status: "success",
      reply: [
        "你想找哪个菜单？下面是各模块入口，点名字可直接跳转：",
        "",
        buildMenuJumpSection(roots.map((entry) => ({ entry, score: 0 }))),
      ].join("\n"),
      data: { keyword: "", matches: roots.map((entry) => entry.name) },
      nextQuestions: roots.slice(0, 3).map((entry) => `${entry.name}菜单在哪里`),
    };
  }

  const matches = matchMenus(keyword, entries, 5);

  if (!matches.length) {
    const roots = rootMenus(entries).slice(0, 8);
    return {
      status: "needs_more",
      reply: [
        `没有找到与「${keyword}」匹配的菜单。`,
        "可以试试完整菜单名；也可以到「系统管理 → 菜单管理」查看全部菜单。",
        "",
        "常见模块入口：",
        buildMenuJumpSection(roots.map((entry) => ({ entry, score: 0 }))),
      ].join("\n"),
      data: { keyword, matches: [] },
      nextQuestions: roots.slice(0, 3).map((entry) => `${entry.name}菜单在哪里`),
    };
  }

  const top = matches[0].entry;
  const where = top.parentPath ? `在「${top.parentPath}」下，` : "";
  const lines = [
    `**${top.name}** ${where}路径 \`${top.path}\`。`,
    "",
    matches.length > 1 ? "可能相关的菜单（点击直接跳转）：" : "点击直接跳转：",
    buildMenuJumpSection(matches),
  ];

  return {
    status: "success",
    reply: lines.join("\n"),
    data: {
      keyword,
      matches: matches.map(({ entry, score }) => ({
        name: entry.name,
        path: entry.path,
        breadcrumb: entry.breadcrumb,
        score,
      })),
    },
  };
}
