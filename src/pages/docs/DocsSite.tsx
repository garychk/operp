import { useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import opelixLogo from "../../assets/opelix.svg";
import { docCategories } from "./docsData";
import "./docs.css";

/** 吸顶头部高度，锚点跳转与滚动高亮都按它做偏移 */
const HEADER_OFFSET = 76;

function htmlToText(html: string): string {
  const div = document.createElement("div");
  div.innerHTML = html;
  return div.textContent || "";
}

export function DocsSite() {
  /** 初始搜索词支持 ?q= URL 参数，便于分享带关键字的链接 */
  const [query, setQuery] = useState(() => {
    const q = new URLSearchParams(window.location.search).get("q");
    return q ? q.trim() : "";
  });
  const [activeId, setActiveId] = useState("");
  /** 滚动容器：第三方库把 #root 锁成 overflow:hidden，滚动发生在 .docs-page 内部 */
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const keyword = query.trim().toLowerCase();

  /** 把某个章节滚到容器可视区顶部（补偿吸顶头部高度） */
  const scrollToId = (id: string, smooth = false) => {
    const container = scrollRef.current;
    const el = document.getElementById(id);
    if (!container || !el) return;
    const top =
      el.getBoundingClientRect().top -
      container.getBoundingClientRect().top +
      container.scrollTop -
      HEADER_OFFSET;
    container.scrollTo({ top, behavior: smooth ? "smooth" : "auto" });
  };

  /** 搜索索引：标题 + 分类名 + 纯文本正文 */
  const searchText = useMemo(() => {
    const map = new Map<string, string>();
    for (const cat of docCategories) {
      for (const sec of cat.sections) {
        map.set(
          sec.id,
          `${sec.title} ${cat.title} ${htmlToText(sec.html)}`.toLowerCase(),
        );
      }
    }
    return map;
  }, []);

  const totalSections = useMemo(
    () => docCategories.reduce((n, c) => n + c.sections.length, 0),
    [],
  );

  const matchCount = useMemo(() => {
    if (!keyword) return totalSections;
    let n = 0;
    searchText.forEach((text) => {
      if (text.includes(keyword)) n += 1;
    });
    return n;
  }, [keyword, searchText, totalSections]);

  /** 关键词在正文中高亮：<mark> 包裹，查询变化时先拆掉旧标记再重打 */
  useEffect(() => {
    const container = contentRef.current;
    if (!container) return;

    container.querySelectorAll("mark.docs-hit").forEach((mark) => {
      const parent = mark.parentNode;
      if (!parent) return;
      parent.replaceChild(
        document.createTextNode(mark.textContent || ""),
        mark,
      );
      parent.normalize();
    });

    if (!keyword) return;

    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const tag = node.parentElement?.tagName;
        if (tag === "SCRIPT" || tag === "STYLE" || tag === "MARK") {
          return NodeFilter.FILTER_REJECT;
        }
        if (!node.nodeValue || !node.nodeValue.toLowerCase().includes(keyword)) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const targets: Text[] = [];
    let node = walker.nextNode();
    while (node) {
      targets.push(node as Text);
      node = walker.nextNode();
    }

    for (const textNode of targets) {
      const value = textNode.nodeValue || "";
      const lower = value.toLowerCase();
      const frag = document.createDocumentFragment();
      let cursor = 0;
      let idx = lower.indexOf(keyword);
      while (idx !== -1) {
        if (idx > cursor) {
          frag.appendChild(document.createTextNode(value.slice(cursor, idx)));
        }
        const mark = document.createElement("mark");
        mark.className = "docs-hit";
        mark.textContent = value.slice(idx, idx + keyword.length);
        frag.appendChild(mark);
        cursor = idx + keyword.length;
        idx = lower.indexOf(keyword, cursor);
      }
      if (cursor < value.length) {
        frag.appendChild(document.createTextNode(value.slice(cursor)));
      }
      textNode.parentNode?.replaceChild(frag, textNode);
    }
  }, [keyword]);

  /** 滚动高亮当前所在章节（scroll spy，监听内部滚动容器） */
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const onScroll = () => {
      const headings = Array.from(
        container.querySelectorAll<HTMLElement>(".docs-section"),
      );
      if (!headings.length) return;
      const base = container.getBoundingClientRect().top;
      let current = headings[0].id;
      for (const el of headings) {
        if (el.getBoundingClientRect().top - base <= HEADER_OFFSET + 8) {
          current = el.id;
        } else {
          break;
        }
      }
      if (
        container.scrollTop + container.clientHeight >=
        container.scrollHeight - 4
      ) {
        current = headings[headings.length - 1].id;
      }
      setActiveId(current);
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => container.removeEventListener("scroll", onScroll);
  }, []);

  /** 支持 #锚点 直达（/docs#batch）；SPA 渲染晚于浏览器原生锚点处理，需 JS 兜底滚动 */
  useEffect(() => {
    const scrollToHash = () => {
      const id = window.location.hash.replace("#", "");
      if (!id || !document.getElementById(id)) return;
      scrollToId(id);
      setActiveId(id);
    };
    scrollToHash();
    const timer = window.setTimeout(scrollToHash, 120);
    window.addEventListener("hashchange", scrollToHash);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("hashchange", scrollToHash);
    };
  }, []);

  const jumpTo =
    (id: string) => (event: ReactMouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      if (!document.getElementById(id)) return;
      window.history.replaceState(null, "", `#${id}`);
      scrollToId(id, true);
    };

  return (
    <div className="docs-page" ref={scrollRef}>
      <header className="docs-header">
        <div className="docs-brand">
          <span className="docs-logo">
            <img src={opelixLogo} alt="OPERP Logo" />
          </span>
          <span className="docs-brand-name">OPERP 使用手册</span>
          <span className="docs-version">V1.0.6</span>
        </div>
        <div className="docs-search">
          <svg
            className="docs-search-icon"
            viewBox="0 0 24 24"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <circle cx="11" cy="11" r="7" />
            <line x1="21" y1="21" x2="16.5" y2="16.5" />
          </svg>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索功能、菜单、操作说明…"
          />
          {query && (
            <button
              type="button"
              className="docs-search-clear"
              onClick={() => setQuery("")}
              aria-label="清除搜索"
            >
              ×
            </button>
          )}
        </div>
        <div className="docs-header-meta">
          {keyword ? `匹配 ${matchCount} / ${totalSections} 节` : `共 ${totalSections} 节`}
        </div>
      </header>

      <div className="docs-body">
        <aside className="docs-sidebar">
          {docCategories.map((cat) => {
            const visibleSections = keyword
              ? cat.sections.filter((sec) =>
                  (searchText.get(sec.id) || "").includes(keyword),
                )
              : cat.sections;
            if (keyword && visibleSections.length === 0) return null;
            return (
              <div className="docs-nav-group" key={cat.title}>
                <div className="docs-nav-title">{cat.title}</div>
                {visibleSections.map((sec) => (
                  <a
                    key={sec.id}
                    href={`#${sec.id}`}
                    className={`docs-nav-link${activeId === sec.id ? " is-active" : ""}`}
                    onClick={jumpTo(sec.id)}
                  >
                    {sec.title}
                  </a>
                ))}
              </div>
            );
          })}
          {keyword && matchCount === 0 && (
            <div className="docs-nav-empty">没有匹配的内容，换个关键词试试</div>
          )}
        </aside>

        <main className="docs-content" ref={contentRef}>
          <div className="docs-hero">
            <h1>OPERP 使用手册</h1>
            <p>
              面向业务操作人员与系统管理员：产品介绍、功能特点说明、按菜单拆解的操作指引、
              典型业务场景与常见问题。所有界面支持中英文切换，本手册以中文界面为准。
            </p>
            <div className="docs-hero-chips">
              <span>适用版本 V1.0.6</span>
              <span>更新日期 2026-10-12</span>
            </div>
          </div>

          {docCategories.map((cat) => (
            <section className="docs-category" key={cat.title}>
              <div className="docs-category-title">{cat.title}</div>
              {cat.sections.map((sec) => (
                <article key={sec.id} id={sec.id} className="docs-section">
                  <h2>{sec.title}</h2>
                  <div
                    className="docs-section-body"
                    dangerouslySetInnerHTML={{ __html: sec.html }}
                  />
                </article>
              ))}
            </section>
          ))}

          <footer className="docs-footer">
            © 2026 OPERP · AI 原生智能 ERP 平台 · 如手册与实际界面存在差异，以系统为准
          </footer>
        </main>
      </div>
    </div>
  );
}

export default DocsSite;
