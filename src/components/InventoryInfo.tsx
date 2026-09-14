import { useEffect, useState } from "react";
import { supabase } from "../utils/supabase";
import type { Tables } from "../utils/supabase";

type Inventory = Tables["erp_inventory_s_539dcf81_b"]["Row"];

export type InventoryMetric = "available" | "onHand" | "unitCost";

interface InventoryInfoProps {
  /** 物料 id，必填；为空时直接显示 fallback。 */
  productId?: number | null;
  /** 仓库 id；为空则不限制仓库。 */
  warehouseId?: number | null;
  /** 库位（erp_bins）id；为空则不限制库位。 */
  locationId?: number | null;
  /** 批次号；为空则不限制批次。 */
  batchNo?: string | null;
  /** 展示的度量：available=可用库存（默认）、onHand=即时库存、unitCost=单位成本。 */
  metric?: InventoryMetric;
  /** 小数位，默认 2。 */
  precision?: number;
  /** 展示前缀，如货币符号。 */
  prefix?: string;
  /** 无匹配数据时展示的内容，默认 "-"。 */
  fallback?: string;
}

interface InventoryCache {
  rows: Inventory[];
  byProduct: Map<number, Inventory[]>;
}

interface InventoryQuery {
  productId?: number | null;
  warehouseId?: number | null;
  locationId?: number | null;
  batchNo?: string | null;
  metric?: InventoryMetric;
}

// 模块级缓存：整个应用会话内只拉取一次；库存变动后调用
// invalidateInventoryCache() 才会在下次渲染时重新拉取。
let cache: InventoryCache | null = null;
let loading: Promise<InventoryCache> | null = null;

/** 清空库存缓存；库存发生变动后调用，使下次渲染重新拉取。 */
export function invalidateInventoryCache() {
  cache = null;
}

const loadCache = async (): Promise<InventoryCache> => {
  if (cache) return cache;
  if (!loading) {
    loading = (async () => {
      const { data, error } = await supabase
        .from("erp_inventory_s_539dcf81_b")
        .select("*")
        .eq("is_deleted", "n");
      if (error) throw error;

      const rows = (data as Inventory[]) || [];
      const byProduct = new Map<number, Inventory[]>();
      rows.forEach((row) => {
        if (row.product_id == null) return;
        const list = byProduct.get(row.product_id);
        if (list) list.push(row);
        else byProduct.set(row.product_id, [row]);
      });

      cache = { rows, byProduct };
      return cache;
    })().finally(() => {
      loading = null;
    });
  }
  return loading;
};

/**
 * 按 product_id / 仓库 / 库位 / 批次号匹配库存行（未传的维度忽略），
 * 多行时数量求和、单位成本按 total_cost/quantity 加权平均。
 * 无匹配返回 null。
 */
const resolveMetric = (data: InventoryCache, query: InventoryQuery): number | null => {
  const { productId, warehouseId, locationId, batchNo, metric = "available" } = query;
  if (productId == null) return null;

  const rows = (data.byProduct.get(productId) || []).filter((row) => {
    if (warehouseId != null && row.warehouse_id !== warehouseId) return false;
    if (locationId != null && row.location_id !== locationId) return false;
    if (batchNo && row.batch_no !== batchNo) return false;
    return true;
  });
  if (rows.length === 0) return null;

  if (metric === "available") {
    return rows.reduce((sum, r) => sum + (r.available_quantity || 0), 0);
  }
  if (metric === "onHand") {
    return rows.reduce((sum, r) => sum + (r.quantity || 0), 0);
  }

  // unitCost：优先用 total_cost/quantity 加权平均，缺失时回退各行 unit_cost 均值。
  const quantity = rows.reduce((sum, r) => sum + (r.quantity || 0), 0);
  if (rows.some((r) => r.total_cost != null) && quantity !== 0) {
    const totalCost = rows.reduce((sum, r) => sum + (r.total_cost || 0), 0);
    return totalCost / quantity;
  }
  const costs = rows.map((r) => r.unit_cost).filter((v): v is number => v != null);
  return costs.length ? costs.reduce((a, b) => a + b, 0) / costs.length : null;
};

/**
 * 展示库存信息（可用库存 / 即时库存 / 单位成本）。
 * 数据由组件内部一次性拉取并缓存，渲染时按 map 查询。
 */
export function InventoryInfo({
  productId,
  warehouseId,
  locationId,
  batchNo,
  metric = "available",
  precision = 2,
  prefix,
  fallback = "-",
}: InventoryInfoProps) {
  const [data, setData] = useState<InventoryCache | null>(cache);

  useEffect(() => {
    if (data) return;
    let alive = true;
    loadCache()
      .then((loaded) => {
        if (alive) setData(loaded);
      })
      .catch((error) => {
        console.error("Error loading inventory:", error);
      });
    return () => {
      alive = false;
    };
  }, [data]);

  if (!data) return <>{fallback}</>;

  const value = resolveMetric(data, {
    productId,
    warehouseId,
    locationId,
    batchNo,
    metric,
  });
  if (value === null) return <>{fallback}</>;

  return <>{`${prefix || ""}${value.toFixed(precision)}`}</>;
}

export default InventoryInfo;
