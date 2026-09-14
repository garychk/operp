import { useEffect, useState } from "react";
import { supabase } from "../utils/supabase";
import type { Tables } from "../utils/supabase";

type Product = Tables["erp_products_s_539dcf81_b"]["Row"];
type Uom = Tables["erp_uoms_s_539dcf81_b"]["Row"];
type ProductUom = Tables["erp_product_uoms_s_539dcf81_b"]["Row"];

const productTable = "erp_products_s_539dcf81_b";
const uomTable = "erp_uoms_s_539dcf81_b";
const productUomTable = "erp_product_uoms_s_539dcf81_b";

interface ProductUnitProps {
  productId: number | null | undefined;
  /** 单位用途，默认 sales。 */
  usageType?: string;
}

interface ProductUnitCache {
  /** `${productId}:${usageType}` -> uom_id */
  usageUomIds: Map<string, number>;
  /** uom_id -> uom */
  uoms: Map<number, Uom>;
  /** product_id -> product */
  products: Map<number, Product>;
}

// 模块级缓存：整个应用会话内只拉取一次，物料单位数据变更后调用
// invalidateProductUnitCache() 才会在下次渲染时重新拉取。
let cache: ProductUnitCache | null = null;
let loading: Promise<ProductUnitCache> | null = null;

const usageKey = (productId: number, usageType: string) => `${productId}:${usageType}`;

const loadCache = async (): Promise<ProductUnitCache> => {
  if (cache) return cache;
  if (!loading) {
    loading = (async () => {
      const [productUomRes, uomRes, productRes] = await Promise.all([
        supabase.from(productUomTable).select("*").eq("is_deleted", "n"),
        supabase.from(uomTable).select("*").eq("is_deleted", "n"),
        supabase.from(productTable).select("id, base_uom_id, unit"),
      ]);
      if (productUomRes.error) throw productUomRes.error;
      if (uomRes.error) throw uomRes.error;
      if (productRes.error) throw productRes.error;

      const usageUomIds = new Map<string, number>();
      ((productUomRes.data as ProductUom[]) || []).forEach((pu) => {
        usageUomIds.set(usageKey(pu.product_id, pu.usage_type), pu.uom_id);
      });

      cache = {
        usageUomIds,
        uoms: new Map(((uomRes.data as Uom[]) || []).map((u) => [u.id, u])),
        products: new Map(((productRes.data as Product[]) || []).map((p) => [p.id, p])),
      };
      return cache;
    })().finally(() => {
      loading = null;
    });
  }
  return loading;
};

/** 清空物料单位缓存；物料单位发生增删改后调用，使下次渲染重新拉取。 */
export function invalidateProductUnitCache() {
  cache = null;
}

const resolveUnit = (
  data: ProductUnitCache,
  productId: number,
  usageType: string,
): string => {
  const usageUomId = data.usageUomIds.get(usageKey(productId, usageType));
  const product = data.products.get(productId);
  const uom =
    (usageUomId != null ? data.uoms.get(usageUomId) : undefined) ??
    (product?.base_uom_id != null
      ? data.uoms.get(product.base_uom_id)
      : undefined);
  if (uom) return `${uom.name}${uom.symbol ? ` (${uom.symbol})` : ""}`;
  return product?.unit || "-";
};

/**
 * 展示物料在指定用途下的单位：优先取挂在物料上的对应用途单位，
 * 缺失时回退到物料的基本单位，再缺失则回退到物料的 unit 文本。
 * 数据由组件内部一次性拉取并缓存，渲染时直接查 map。
 */
export function ProductUnit({ productId, usageType = "sales" }: ProductUnitProps) {
  const [data, setData] = useState<ProductUnitCache | null>(cache);

  useEffect(() => {
    if (data) return;
    let alive = true;
    loadCache()
      .then((loaded) => {
        if (alive) setData(loaded);
      })
      .catch((error) => {
        console.error("Error loading product units:", error);
      });
    return () => {
      alive = false;
    };
  }, [data]);

  if (productId === null || productId === undefined) return <>-</>;
  if (!data) return <>-</>;
  return <>{resolveUnit(data, productId, usageType)}</>;
}

export default ProductUnit;
