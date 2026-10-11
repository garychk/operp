import { useEffect, useMemo, useState } from 'react';
import type { SelectProps } from 'antd';
import { supabase } from '../utils/supabase';
import type { Tables } from '../utils/supabase';

export type Uom = Tables['erp_uoms_s_539dcf81_b']['Row'];
export type UomGroup = Tables['erp_uom_groups_s_539dcf81_b']['Row'];

/** 单位下拉取值的口径 */
export type UomOptionValueMode = 'id' | 'symbol';

const UOM_TABLE = 'erp_uoms_s_539dcf81_b';
const UOM_GROUP_TABLE = 'erp_uom_groups_s_539dcf81_b';

/** 单位显示名：`名称 (符号)`。全站唯一实现，避免各页面各写一套。 */
export function uomLabel(uom: Pick<Uom, 'name' | 'symbol'>): string {
  return `${uom.name}${uom.symbol ? ` (${uom.symbol})` : ''}`;
}

/**
 * 单位在**文本字段**里的落库口径 —— 与 `erp_products.unit` 完全一致
 * （物料管理保存时写的就是 `uom.symbol || uom.name`）。
 *
 * BOM 主档 `erp_boms.unit`、BOM 明细 `erp_bom_details.unit` 都是文本列，
 * 必须用本函数取规范值，才能与物料管理的口径对得上。
 */
export function uomTextValue(uom: Pick<Uom, 'name' | 'symbol'>): string {
  return uom.symbol || uom.name || '';
}

/**
 * 生成单位下拉选项。两种模式 **label 完全相同**，所以下拉观感处处一致：
 * - `valueMode = 'id'`     → value 是 `erp_uoms.id`（外键列用，如 `erp_products.base_uom_id`）
 * - `valueMode = 'symbol'` → value 是单位符号文本（文本列用，如 `erp_boms.unit`）
 */
export function buildUomOptions(
  uoms: Uom[],
  groupNameMap: Map<number, string>,
  valueMode: UomOptionValueMode = 'id',
): NonNullable<SelectProps['options']> {
  return uoms.map((u) => {
    const groupName = groupNameMap.get(u.group_id);
    return {
      value: valueMode === 'id' ? u.id : uomTextValue(u),
      label: groupName ? `${uomLabel(u)} · ${groupName}` : uomLabel(u),
    };
  });
}

/**
 * 取产品/物料的单位文本：优先**基本单位**（`base_uom_id` → 单位主数据），
 * 回退到 `unit` 冗余列。与物料管理列表的单位显示口径一致。
 */
export function productUnitText(
  product: { base_uom_id?: number | null; unit?: string | null } | null | undefined,
  uomMap: Map<number, Uom>,
): string {
  if (!product) return '';
  const uom = product.base_uom_id != null ? uomMap.get(product.base_uom_id) : undefined;
  return uom ? uomTextValue(uom) : product.unit || '';
}

/**
 * 把单位文本归一到单位主数据的规范写法（忽略大小写与首尾空格）。
 * 例：库里历史脏值 `"PCS"` → 规范值 `"pcs"`。
 *
 * 用途：BOM 等单位列是**文本**列，历史上被手填成了与 `erp_products.unit`
 * 不同的大小写。显示与编辑时经本函数归一，界面口径立刻与物料管理一致；
 * 用户下次保存时值自然收敛，**不需要改历史数据**。
 * 匹配不到任何单位时原样返回（不猜测）。
 */
export function normalizeUnitText(
  text: string | null | undefined,
  uomMap: Map<number, Uom>,
): string {
  if (!text) return '';
  const raw = String(text).trim();
  if (!raw) return '';
  const key = raw.toLowerCase();
  for (const u of uomMap.values()) {
    if (uomTextValue(u).toLowerCase() === key) return uomTextValue(u);
    if ((u.name || '').toLowerCase() === key) return uomTextValue(u);
  }
  return raw;
}

/**
 * 单位主数据（`erp_uoms` + `erp_uom_groups`）的**唯一加载入口**。
 *
 * 修复背景：BOM 相关页面原先用 `<DictSelect dictType="uom" />` 取选项，
 * 而 `sys_dict_items` 里**根本没有 `uom` 这个字典** → 下拉恒为空、只能靠手填，
 * 导致 BOM 里出现 `PCS` 这类与 `erp_products.unit`（`pcs`）对不上的值。
 * 现在统一走本 hook，数据源 = 单位主数据表，与物料管理完全一致。
 */
export function useUoms() {
  const [uoms, setUoms] = useState<Uom[]>([]);
  const [groups, setGroups] = useState<UomGroup[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [groupRes, uomRes] = await Promise.all([
          supabase
            .from(UOM_GROUP_TABLE)
            .select('*')
            .eq('is_deleted', 'n')
            .eq('status', 'active'),
          supabase.from(UOM_TABLE).select('*').eq('is_deleted', 'n').eq('is_active', true),
        ]);
        if (groupRes.error) throw groupRes.error;
        if (uomRes.error) throw uomRes.error;
        if (!alive) return;
        setGroups((groupRes.data as UomGroup[]) || []);
        setUoms((uomRes.data as Uom[]) || []);
      } catch (error) {
        console.error('Error fetching uoms:', error);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const uomMap = useMemo(() => new Map<number, Uom>(uoms.map((u) => [u.id, u])), [uoms]);
  const groupNameMap = useMemo(
    () => new Map<number, string>(groups.map((g) => [g.id, g.name])),
    [groups],
  );

  return { uoms, groups, uomMap, groupNameMap, loading };
}
