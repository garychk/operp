import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { Empty, Input, Popover, theme } from "antd";
import type { InputRef } from "antd";
import { SearchOutlined } from "@ant-design/icons";
import { useTranslation } from "react-i18next";

/**
 * 与 ProLayout 的 MenuRoute 结构兼容：这里只声明搜索用得到的字段，
 * 避免组件反向依赖 ProLayout（也就不需要 type-only 的循环 import）。
 */
export interface MenuSearchNode {
  path: string;
  name: string;
  icon?: ReactNode;
  routes?: MenuSearchNode[];
}

export interface MenuSearchProps {
  /** 已按权限过滤、已本地化的菜单树（直接传 ProLayout 的 visibleMenuData） */
  menus: MenuSearchNode[];
  /** 选中某条菜单后由外层负责“新开一个顶部标签页并跳转” */
  onSelect: (path: string) => void;
}

interface SearchEntry {
  path: string;
  name: string;
  icon?: ReactNode;
  /** 祖先菜单名，用于面包屑展示与父级关键字匹配 */
  parents: string[];
}

/** 打分越低越靠前；-1 表示不匹配 */
function matchScore(entry: SearchEntry, query: string): number {
  const name = entry.name.toLowerCase();
  const path = entry.path.toLowerCase();
  const crumbs = entry.parents.join("/").toLowerCase();
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (name.includes(query)) return 2;
  if (crumbs.includes(query)) return 3;
  if (path.includes(query)) return 4;
  return -1;
}

function flattenMenu(menus: MenuSearchNode[]): SearchEntry[] {
  const result: SearchEntry[] = [];
  const walk = (nodes: MenuSearchNode[], parents: string[]) => {
    nodes.forEach((node) => {
      // 有子菜单的节点是分组（如 /finance），本身不是可打开页面；
      // /menu-group/xxx 是数据库菜单里的纯分组占位路径，同样跳过。
      if (!node.routes?.length && !node.path.startsWith("/menu-group/")) {
        result.push({
          path: node.path,
          name: node.name,
          icon: node.icon,
          parents,
        });
      }
      if (node.routes?.length) walk(node.routes, [...parents, node.name]);
    });
  };
  walk(menus, []);
  return result;
}

/** 高亮首个命中的关键字（只做第一处，避免结果太多噪点） */
function highlight(text: string, query: string): ReactNode {
  if (!query) return text;
  const index = text.toLowerCase().indexOf(query.toLowerCase());
  if (index < 0) return text;
  return (
    <>
      {text.slice(0, index)}
      <span style={{ color: "var(--accent, #1677ff)", fontWeight: 600 }}>
        {text.slice(index, index + query.length)}
      </span>
      {text.slice(index + query.length)}
    </>
  );
}

export function MenuSearch({ menus, onSelect }: MenuSearchProps) {
  const { t } = useTranslation();
  const { token } = theme.useToken();

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<InputRef | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const entries = useMemo(() => flattenMenu(menus), [menus]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const indexed = entries.map((entry, index) => ({ entry, index }));
    const scored = q
      ? indexed
          .map(({ entry, index }) => ({ entry, index, score: matchScore(entry, q) }))
          .filter((item) => item.score >= 0)
      : indexed.map(({ entry, index }) => ({ entry, index, score: 0 }));
    scored.sort((a, b) =>
      a.score !== b.score ? a.score - b.score : a.index - b.index,
    );
    return scored.map((item) => item.entry);
  }, [entries, query]);

  // 每次打开都从干净状态开始，并把焦点交给输入框（等 Popover 内容挂载完再聚焦）
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  // 键盘上下移动时保证当前项始终在可视区域内
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-index="${activeIndex}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, results]);

  const commit = useCallback(
    (entry?: SearchEntry) => {
      if (!entry) return;
      setOpen(false);
      onSelect(entry.path);
    },
    [onSelect],
  );

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const count = results.length;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (count) setActiveIndex((prev) => (prev + 1) % count);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (count) setActiveIndex((prev) => (prev - 1 + count) % count);
    } else if (event.key === "Enter") {
      event.preventDefault();
      commit(results[activeIndex]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
    }
  };

  const content = (
    <div style={{ width: 340 }} onKeyDown={handleKeyDown}>
      <Input
        ref={inputRef}
        allowClear
        value={query}
        placeholder={t("menuSearch.placeholder")}
        prefix={<SearchOutlined style={{ color: token.colorTextQuaternary }} />}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div
        ref={listRef}
        style={{ maxHeight: 320, overflowY: "auto", marginTop: 8 }}
      >
        {results.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={t("menuSearch.empty")}
            style={{ padding: "20px 0" }}
          />
        ) : (
          results.map((entry, index) => {
            const active = index === activeIndex;
            return (
              <div
                key={entry.path}
                data-index={index}
                onMouseEnter={() => setActiveIndex(index)}
                // 阻止默认行为，避免鼠标按下时输入框失焦
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => commit(entry)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "6px 8px",
                  borderRadius: token.borderRadius,
                  cursor: "pointer",
                  background: active ? token.controlItemBgHover : undefined,
                }}
              >
                <span
                  style={{
                    display: "inline-flex",
                    width: 16,
                    justifyContent: "center",
                    color: token.colorTextSecondary,
                  }}
                >
                  {entry.icon}
                </span>
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {highlight(entry.name, query.trim())}
                </span>
                {entry.parents.length > 0 && (
                  <span
                    style={{
                      maxWidth: 130,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      color: token.colorTextTertiary,
                      fontSize: 12,
                    }}
                  >
                    {entry.parents.join(" / ")}
                  </span>
                )}
              </div>
            );
          })
        )}
      </div>
      <div
        style={{
          marginTop: 6,
          paddingTop: 6,
          borderTop: `1px solid ${token.colorSplit}`,
          color: token.colorTextTertiary,
          fontSize: 12,
          textAlign: "right",
        }}
      >
        {t("menuSearch.hint")}
      </div>
    </div>
  );

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger="click"
      placement="bottomRight"
      arrow={false}
      content={content}
    >
      {/* 用真实 DOM 节点做触发元素，Popover 定位不依赖 findDOMNode，行为更稳 */}
      <span
        role="button"
        tabIndex={0}
        title={t("menuSearch.entry")}
        aria-label={t("menuSearch.entry")}
        style={{
          display: "inline-flex",
          alignItems: "center",
          cursor: "pointer",
          fontSize: 16,
        }}
      >
        <SearchOutlined />
      </span>
    </Popover>
  );
}

export default MenuSearch;
