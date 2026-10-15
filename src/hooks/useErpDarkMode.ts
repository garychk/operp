import { useEffect, useState } from "react";

/**
 * 深浅模式标记由 ProLayout 写在 <html data-erp-dark> 上。
 *
 * 自绘图形（SVG / Canvas / G2 图表）无法通过 CSS 变量跟随主题，
 * 必须拿到布尔值在 JS 侧切换配色，因此单独抽成 hook 复用。
 */
export function useErpDarkMode(): boolean {
  const [dark, setDark] = useState(
    () =>
      typeof document !== "undefined" &&
      document.documentElement.dataset.erpDark === "true",
  );

  useEffect(() => {
    const root = document.documentElement;
    setDark(root.dataset.erpDark === "true");
    if (typeof MutationObserver === "undefined") return;

    const observer = new MutationObserver(() => {
      setDark(root.dataset.erpDark === "true");
    });
    observer.observe(root, {
      attributes: true,
      attributeFilter: ["data-erp-dark"],
    });
    return () => observer.disconnect();
  }, []);

  return dark;
}
