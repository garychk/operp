import { useCallback, useEffect, useMemo, useState } from "react";
import { message } from "antd";
import { useTranslation } from "react-i18next";
import { supabase } from "../utils/supabase";

/**
 * 数据字典（sys_dict_types / sys_dict_items）读取的**唯一入口**。
 *
 * 为什么收口：
 *   · 字典表走「模板可见性」（deploy_52）—— 该查哪张表、怎么取启用项、怎么排序
 *     是固定的三段式，散落各处迟早写歪（历史上 `dictType="uom"` 就是这么来的：
 *     查了一个根本不存在于 dict 体系里的字典，下拉恒空）。
 *   · 列表页要显示「存的是 code、看的是 label」，需要同一份 items 做映射。
 *     只挂在 Select 组件内部的实现拿不到这个映射，就会退化成显示裸 code。
 *
 * 透传口径：
 *   · 只取 status='1'（启用）且 is_deleted='n' 的字典项，按 sort_order 升序。
 *   · 字典类型本身也必须 status='1' 且 is_deleted='n'，否则整本字典视为不存在。
 *   · 不做租户过滤 —— 由 RLS（template_scope_visible）决定可见行，前端越权过滤
 *     反而会把「基线 + 租户副本」的可见性规则写死。
 */
export interface DictItem {
  id: number;
  code: string;
  label: string;
  sort_order: number | null;
}

export interface DictOption {
  value: string;
  label: string;
}

export interface UseDictResult {
  /** 启用中的字典项（已排序） */
  items: DictItem[];
  /** 直接可交给 Select 的 options（value = code，label = 显示名） */
  options: DictOption[];
  loading: boolean;
  /**
   * code → 显示名。找不到时**原样返回 code**：
   * 字典项被删/被停用后，历史单据里存的旧 code 仍要看得见，不能变成空白。
   */
  labelOf: (code?: string | null) => string;
}

export function useDict(dictType: string): UseDictResult {
  const { t } = useTranslation();
  const [items, setItems] = useState<DictItem[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const fetchItems = async () => {
      if (!dictType) {
        setItems([]);
        return;
      }

      setLoading(true);
      try {
        const { data, error } = await supabase
          .from("sys_dict_types")
          .select("id, sys_dict_items(code, label, sort_order)")
          .eq("code", dictType)
          .eq("status", "1")
          .eq("is_deleted", "n")
          .eq("sys_dict_items.status", "1")
          .eq("sys_dict_items.is_deleted", "n")
          .maybeSingle();

        if (error) throw error;
        if (cancelled) return;

        const rows = ((data?.sys_dict_items ?? []) as DictItem[])
          .slice()
          .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
        setItems(rows);
      } catch (error) {
        if (!cancelled) {
          setItems([]);
          message.error(t("dictionaries.fetchFailed"));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void fetchItems();
    return () => {
      cancelled = true;
    };
  }, [dictType, t]);

  const options = useMemo<DictOption[]>(
    () => items.map((item) => ({ value: item.code, label: item.label })),
    [items],
  );

  const labelOf = useCallback(
    (code?: string | null) => {
      if (!code) return "";
      return items.find((item) => item.code === code)?.label ?? code;
    },
    [items],
  );

  return { items, options, loading, labelOf };
}

export default useDict;
