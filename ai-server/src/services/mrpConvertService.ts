/**
 * MRP 计划订单转单服务（阶段 4）。
 *
 * 把 erp_mrp_requirements 里「有计划订单」的行（planned_order_receipt > 0）落成真实单据：
 *   · 制造件 → 生产订单（MO{YYYY}{####}），建好后调 explode_production_order_bom 展开子件
 *   · 采购件 → 采购订单草稿（PO{YYYY}{####}），单价取 purchase_price 回退 cost_price
 *
 * 两条铁律（本文件是 ai-server 第二个写业务数据的模块，必须守住）：
 *   1. service_role 不过 RLS —— 每一次查询、每一笔写入都显式带 tenant_id。
 *   2. 幂等靠「计划行上的转单追踪列」+ 部分唯一索引兜底：已转单的行不再出现在候选里；
 *      重跑 MRP 时 mrpService.persistResult 只删未转单的行，追踪因此不会被抹掉。
 *
 * 刻意不做（v1）：
 *   · 不拆供应商（没有货源清单表）：采购订单 supplier_id 留空，只出警告，由人工在采购订单上补。
 *   · 不合并多行成一张单：一条计划订单 = 一张单据（1:1 pegging，最好追溯）。
 *   · 不自动审批：生成的都是 draft，走既有的 草稿 → 审批 → 收货/领料 闭环。
 */
import { supabase } from "../config/supabase.js";
import { loadPlan, type MrpPlanRow } from "./mrpService.js";

const T = {
  requirements: "erp_mrp_requirements_s_539dcf81_b",
  products: "erp_products_s_539dcf81_b",
  productCategories: "erp_product_categories_s_539dcf81_b",
  suppliers: "erp_suppliers_s_539dcf81_b",
  boms: "erp_boms_s_539dcf81_b",
  purchaseOrders: "erp_purchase_orders_s_539dcf81_b",
  purchaseOrderDetails: "erp_purchase_order_details_s_539dcf81_b",
  productionOrders: "erp_production_orders_s_539dcf81_b",
} as const;

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** supabase-js 无类型客户端的返回值统一归一化成行数组 */
const asRows = (value: unknown): Record<string, unknown>[] =>
  (Array.isArray(value) ? value : []) as Record<string, unknown>[];

const todayStr = () => new Date().toISOString().slice(0, 10);

const round4 = (n: number) => Math.round(n * 10000) / 10000;

export type ConversionTarget = "purchase_order" | "production_order";

export interface ConversionCandidate {
  requirementId: number;
  productId: number;
  productCode: string;
  productName: string;
  quantity: number;
  requirementDate: string;
  orderDate: string;
  target: ConversionTarget;
  bomId: number | null;
  /**
   * 默认供应商（deploy_120）：物料显式值 → 类别默认值，且必须是本租户启用中的
   * 供应商；取不到 / 已停用 = null（留空由人工指定，不给建议单带死数据）。
   */
  supplierId: number | null;
  unitPrice: number;
  warnings: string[];
}

export interface SkippedRequirement {
  requirementId: number;
  productId: number;
  productCode: string;
  quantity: number;
  requirementDate: string;
  reason: string;
}

export interface ConversionPreview {
  plan: MrpPlanRow;
  candidates: ConversionCandidate[];
  skipped: SkippedRequirement[];
  summary: {
    total: number;
    purchaseOrders: number;
    productionOrders: number;
    skipped: number;
    totalPurchaseAmount: number;
  };
}

export interface ConversionItemResult {
  requirementId: number;
  productCode: string;
  productName: string;
  target: ConversionTarget;
  quantity: number;
  ok: boolean;
  documentType?: ConversionTarget;
  documentId?: number;
  documentNo?: string;
  error?: string;
  warnings: string[];
}

export interface ConversionOutcome {
  plan: MrpPlanRow;
  created: number;
  failed: number;
  items: ConversionItemResult[];
  skipped: SkippedRequirement[];
  notified: boolean;
}

export type ConversionFilter = "all" | "purchased" | "manufactured";

// ---------------------------------------------------------------------------
// 候选构建（预览与执行共用，保证「看到什么就执行什么」）
// ---------------------------------------------------------------------------

interface ProductMeta {
  id: number;
  code: string;
  name: string;
  isPurchased: boolean;
  isManufactured: boolean;
  purchasePrice: number;
  costPrice: number;
  /** deploy_120：物料显式默认供应商（可能为 null = 跟随类别默认） */
  defaultSupplierId: number | null;
  categoryId: number | null;
}

export async function buildConversionPreview(
  tenantId: number,
  planId: number,
  filter: ConversionFilter = "all",
): Promise<ConversionPreview> {
  const plan = await loadPlan(tenantId, planId);
  if (plan.status !== "completed") {
    throw new Error(
      `计划 ${plan.plan_no} 尚未完成运算（当前状态 ${plan.status ?? "未知"}），请先运行 MRP 再转单。`,
    );
  }

  const { data: reqData, error: reqErr } = await supabase
    .from(T.requirements)
    .select("id, product_id, requirement_date, planned_order_receipt, order_release_date")
    .eq("tenant_id", tenantId)
    .eq("plan_id", planId)
    .eq("is_deleted", "n")
    .is("converted_document_id", null)
    .gt("planned_order_receipt", 0)
    .order("requirement_date", { ascending: true });
  if (reqErr) throw reqErr;

  const rows = asRows(reqData);
  if (rows.length === 0) {
    return emptyPreview(plan);
  }

  const productIds = Array.from(new Set(rows.map((r) => num(r.product_id)).filter((id) => id > 0)));

  const { data: prodData, error: prodErr } = await supabase
    .from(T.products)
    .select(
      "id, code, name, is_purchased, is_manufactured, purchase_price, cost_price, " +
        "category_id, default_supplier_id",
    )
    .eq("tenant_id", tenantId)
    .eq("is_deleted", "n")
    .in("id", productIds);
  if (prodErr) throw prodErr;

  const products = new Map<number, ProductMeta>();
  for (const p of asRows(prodData)) {
    products.set(num(p.id), {
      id: num(p.id),
      code: String(p.code ?? ""),
      name: String(p.name ?? ""),
      isPurchased: p.is_purchased === true || p.is_purchased === "true",
      isManufactured: p.is_manufactured === true || p.is_manufactured === "true",
      purchasePrice: num(p.purchase_price),
      costPrice: num(p.cost_price),
      defaultSupplierId:
        p.default_supplier_id === null || p.default_supplier_id === undefined
          ? null
          : num(p.default_supplier_id) || null,
      categoryId: p.category_id === null || p.category_id === undefined ? null : num(p.category_id) || null,
    });
  }

  // deploy_120：类别默认供应商 + 启用校验
  //   供应商必须「本租户 + 未删除 + 启用」才回填；取不到就留空并告警，
  //   绝不让建议单带着停用供应商出去。
  const categoryIds = Array.from(
    new Set(
      [...products.values()]
        .map((p) => p.categoryId)
        .filter((id): id is number => id !== null && id > 0),
    ),
  );
  const categorySupplierById = new Map<number, number | null>();
  if (categoryIds.length > 0) {
    const { data: catData, error: catErr } = await supabase
      .from(T.productCategories)
      .select("id, default_supplier_id")
      .eq("tenant_id", tenantId)
      .eq("is_deleted", "n")
      .in("id", categoryIds);
    if (catErr) throw catErr;
    for (const c of asRows(catData)) {
      categorySupplierById.set(
        num(c.id),
        c.default_supplier_id === null || c.default_supplier_id === undefined
          ? null
          : num(c.default_supplier_id) || null,
      );
    }
  }

  const candidateSupplierIds = new Set<number>();
  for (const p of products.values()) {
    const sid = p.defaultSupplierId ?? (p.categoryId !== null ? (categorySupplierById.get(p.categoryId) ?? null) : null);
    if (sid !== null && sid > 0) candidateSupplierIds.add(sid);
  }
  const activeSupplierIds = new Set<number>();
  if (candidateSupplierIds.size > 0) {
    const { data: supData, error: supErr } = await supabase
      .from(T.suppliers)
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("is_deleted", "n")
      .eq("status", "active")
      .in("id", [...candidateSupplierIds]);
    if (supErr) throw supErr;
    for (const s of asRows(supData)) activeSupplierIds.add(num(s.id));
  }

  /** 物料显式 → 类别默认 → 校验启用；失败返回 null（建单留空） */
  const resolveSupplierId = (p: ProductMeta): number | null => {
    const sid =
      p.defaultSupplierId ??
      (p.categoryId !== null ? (categorySupplierById.get(p.categoryId) ?? null) : null);
    return sid !== null && sid > 0 && activeSupplierIds.has(sid) ? sid : null;
  };

  // 默认 BOM：优先 is_default，其次 id 最小
  const { data: bomData, error: bomErr } = await supabase
    .from(T.boms)
    .select("id, product_id, is_default, is_active")
    .eq("tenant_id", tenantId)
    .eq("is_deleted", "n")
    .in("product_id", productIds);
  if (bomErr) throw bomErr;

  const bomByProduct = new Map<number, { id: number; isDefault: boolean }>();
  for (const b of asRows(bomData)) {
    if (b.is_active === false || b.is_active === "false") continue;
    const pid = num(b.product_id);
    const candidate = { id: num(b.id), isDefault: b.is_default === true || b.is_default === "true" };
    const existing = bomByProduct.get(pid);
    if (!existing) {
      bomByProduct.set(pid, candidate);
    } else if (candidate.isDefault && !existing.isDefault) {
      bomByProduct.set(pid, candidate);
    } else if (candidate.isDefault === existing.isDefault && candidate.id < existing.id) {
      bomByProduct.set(pid, candidate);
    }
  }

  const candidates: ConversionCandidate[] = [];
  const skipped: SkippedRequirement[] = [];

  for (const row of rows) {
    const productId = num(row.product_id);
    const product = products.get(productId);
    const quantity = round4(num(row.planned_order_receipt));
    const requirementDate = String(row.requirement_date ?? "");
    const orderDate = String(row.order_release_date ?? row.requirement_date ?? "");

    if (!product) {
      skipped.push({
        requirementId: num(row.id),
        productId,
        productCode: "",
        quantity,
        requirementDate,
        reason: "product_not_found",
      });
      continue;
    }

    let target: ConversionTarget;
    if (product.isManufactured) {
      target = "production_order";
    } else if (product.isPurchased) {
      target = "purchase_order";
    } else {
      skipped.push({
        requirementId: num(row.id),
        productId,
        productCode: product.code,
        quantity,
        requirementDate,
        reason: "no_supply_type",
      });
      continue;
    }

    if (filter === "purchased" && target !== "purchase_order") continue;
    if (filter === "manufactured" && target !== "production_order") continue;

    const warnings: string[] = [];
    let bomId: number | null = null;
    // deploy_120：默认供应商取值链 + 启用校验（只有采购建议单关心）
    const rawSupplierId =
      product.defaultSupplierId ??
      (product.categoryId !== null ? (categorySupplierById.get(product.categoryId) ?? null) : null);
    const supplierId = rawSupplierId !== null && activeSupplierIds.has(rawSupplierId) ? rawSupplierId : null;
    if (target === "purchase_order") {
      if (rawSupplierId !== null && supplierId === null) {
        warnings.push("supplier_inactive"); // 配了默认供应商但已停用/删除
      } else if (supplierId === null) {
        warnings.push("supplier_missing"); // 没配默认供应商，留空由人工指定
      }
    }

    if (target === "production_order") {
      bomId = bomByProduct.get(productId)?.id ?? null;
      if (bomId === null) {
        warnings.push("no_default_bom"); // 仍建单，明细可稍后在页面上手动展开
      }
    } else if (product.purchasePrice <= 0 && product.costPrice <= 0) {
      warnings.push("no_purchase_price"); // 单价为 0，金额不可信
    }

    candidates.push({
      requirementId: num(row.id),
      productId,
      productCode: product.code,
      productName: product.name,
      quantity,
      requirementDate,
      orderDate,
      target,
      bomId,
      supplierId,
      unitPrice: round4(product.purchasePrice > 0 ? product.purchasePrice : product.costPrice),
      warnings,
    });
  }

  return {
    plan,
    candidates,
    skipped,
    summary: {
      total: candidates.length,
      purchaseOrders: candidates.filter((c) => c.target === "purchase_order").length,
      productionOrders: candidates.filter((c) => c.target === "production_order").length,
      skipped: skipped.length,
      totalPurchaseAmount: round4(
        candidates
          .filter((c) => c.target === "purchase_order")
          .reduce((sum, c) => sum + c.quantity * c.unitPrice, 0),
      ),
    },
  };
}

function emptyPreview(plan: MrpPlanRow): ConversionPreview {
  return {
    plan,
    candidates: [],
    skipped: [],
    summary: {
      total: 0,
      purchaseOrders: 0,
      productionOrders: 0,
      skipped: 0,
      totalPurchaseAmount: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// 执行转单
// ---------------------------------------------------------------------------

async function nextDocumentNo(
  tenantId: number,
  documentType: string,
  date: string,
): Promise<string> {
  const { data, error } = await supabase.rpc("generate_document_no_for_tenant", {
    p_document_type: documentType,
    p_date: date || todayStr(),
    p_tenant_id: tenantId,
  });
  if (error) throw error;
  const value = typeof data === "string" ? data : "";
  if (!value.trim()) {
    throw new Error(`取号失败（document_type=${documentType}），请检查 sys_document_types 命名规则。`);
  }
  return value;
}

async function createPurchaseOrder(
  tenantId: number,
  candidate: ConversionCandidate,
  planNo: string,
): Promise<{ id: number; no: string; warnings: string[] }> {
  const warnings: string[] = [];
  const orderNo = await nextDocumentNo(tenantId, "purchase_order", candidate.orderDate);
  const amount = round4(candidate.quantity * candidate.unitPrice);

  const { data, error } = await supabase
    .from(T.purchaseOrders)
    .insert({
      order_no: orderNo,
      order_date: candidate.orderDate || todayStr(),
      // deploy_120：回填默认供应商（物料显式 → 类别默认，建单前已校验启用）；
      // null = 留空由人工指定
      supplier_id: candidate.supplierId,
      delivery_date: candidate.requirementDate || candidate.orderDate,
      total_amount: amount,
      tax_amount: 0,
      discount_amount: 0,
      payable_amount: amount,
      currency: "CNY",
      exchange_rate: 1,
      remark: `由 MRP 计划 ${planNo} 自动生成（计划订单 ${candidate.requirementDate}）`,
      status: "draft",
      tenant_id: tenantId,
      is_deleted: "n",
    })
    .select("id")
    .single();
  if (error) throw error;

  const orderId = num((data as { id?: unknown } | null)?.id);

  const { error: dErr } = await supabase.from(T.purchaseOrderDetails).insert({
    order_id: orderId,
    line_no: 1,
    product_id: candidate.productId,
    quantity: candidate.quantity,
    unit_price: candidate.unitPrice,
    amount,
    tax_rate: 0,
    tax_amount: 0,
    received_quantity: 0,
    remark: `MRP 计划订单：需求日 ${candidate.requirementDate}`,
    tenant_id: tenantId,
    is_deleted: "n",
  });
  if (dErr) {
    // 明细写失败则整单作废，避免留下没有明细的空单
    await supabase
      .from(T.purchaseOrders)
      .update({ is_deleted: "y", updated_at: new Date().toISOString() })
      .eq("id", orderId)
      .eq("tenant_id", tenantId);
    throw dErr;
  }

  if (candidate.supplierId === null) {
    warnings.push("supplier_missing");
  }
  return { id: orderId, no: orderNo, warnings };
}

async function createProductionOrder(
  tenantId: number,
  candidate: ConversionCandidate,
  planNo: string,
): Promise<{ id: number; no: string; warnings: string[] }> {
  const warnings: string[] = [];
  const orderNo = await nextDocumentNo(tenantId, "production_order", candidate.orderDate);

  const { data, error } = await supabase
    .from(T.productionOrders)
    .insert({
      order_no: orderNo,
      order_date: candidate.orderDate || todayStr(),
      product_id: candidate.productId,
      bom_id: candidate.bomId,
      planned_quantity: candidate.quantity,
      completed_quantity: 0,
      scrapped_quantity: 0,
      planned_start_date: candidate.orderDate || candidate.requirementDate,
      planned_end_date: candidate.requirementDate,
      status: "draft",
      priority: 5,
      remark: `由 MRP 计划 ${planNo} 自动生成（计划订单 ${candidate.requirementDate}）`,
      tenant_id: tenantId,
      is_deleted: "n",
    })
    .select("id")
    .single();
  if (error) throw error;

  const orderId = num((data as { id?: unknown } | null)?.id);

  if (candidate.bomId === null) {
    warnings.push("no_default_bom");
    return { id: orderId, no: orderNo, warnings };
  }

  // 展开子件：失败不回滚订单（订单本身有效，页面可手动重试展开）
  const { error: explodeErr } = await supabase.rpc("explode_production_order_bom", {
    p_order_id: orderId,
    p_replace: true,
  });
  if (explodeErr) {
    warnings.push(`explode_failed:${explodeErr.message}`);
  }

  return { id: orderId, no: orderNo, warnings };
}

/** 把转单结果写回计划行（部分唯一索引兜底并发重复转单） */
async function markConverted(
  tenantId: number,
  requirementId: number,
  target: ConversionTarget,
  documentId: number,
  documentNo: string,
  userId: number,
): Promise<void> {
  const { error } = await supabase
    .from(T.requirements)
    .update({
      converted_document_type: target,
      converted_document_id: documentId,
      converted_document_no: documentNo,
      converted_at: new Date().toISOString(),
      converted_by_user_id: userId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", requirementId)
    .eq("tenant_id", tenantId);
  if (error) throw error;
}

/** 转单完成通知：软失败（通知不到不影响转单结果） */
async function notifyConversion(
  tenantId: number,
  planNo: string,
  userId: number,
  created: number,
  failed: number,
): Promise<boolean> {
  try {
    const { error } = await supabase.rpc("notify_push", {
      p_notification_type: "task_completed",
      p_severity: failed > 0 ? "warning" : "info",
      p_title: `MRP 转单完成：${planNo}`,
      p_content:
        `计划 ${planNo} 已生成 ${created} 张单据` +
        (failed > 0 ? `，${failed} 条失败需人工处理。` : "。"),
      p_source_type: "mrp_plan",
      p_source_id: null,
      p_source_no: planNo,
      p_link_path: "/mrp/plans",
      p_dedup_key: null,
      p_recipient_user_ids: [userId],
      p_recipient_role_code: "mrp_manager",
      p_dedup_window_hours: 24,
    });
    return !error;
  } catch {
    return false;
  }
}

export async function convertPlanToDocuments(
  tenantId: number,
  planId: number,
  userId: number,
  filter: ConversionFilter = "all",
): Promise<ConversionOutcome> {
  const preview = await buildConversionPreview(tenantId, planId, filter);
  const items: ConversionItemResult[] = [];

  // 串行执行：逐条容错，单条失败不影响其余（ERP 场景允许部分成功）
  for (const candidate of preview.candidates) {
    const base: ConversionItemResult = {
      requirementId: candidate.requirementId,
      productCode: candidate.productCode,
      productName: candidate.productName,
      target: candidate.target,
      quantity: candidate.quantity,
      ok: false,
      warnings: [...candidate.warnings],
    };

    try {
      const created =
        candidate.target === "purchase_order"
          ? await createPurchaseOrder(tenantId, candidate, preview.plan.plan_no)
          : await createProductionOrder(tenantId, candidate, preview.plan.plan_no);

      base.warnings.push(...created.warnings);
      base.warnings = Array.from(new Set(base.warnings)); // 候选阶段与建单阶段可能报同一警告
      await markConverted(
        tenantId,
        candidate.requirementId,
        candidate.target,
        created.id,
        created.no,
        userId,
      );

      items.push({
        ...base,
        ok: true,
        documentType: candidate.target,
        documentId: created.id,
        documentNo: created.no,
      });
    } catch (err) {
      items.push({
        ...base,
        warnings: Array.from(new Set(base.warnings)),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const created = items.filter((i) => i.ok).length;
  const failed = items.length - created;
  const notified = created > 0 ? await notifyConversion(
    tenantId,
    preview.plan.plan_no,
    userId,
    created,
    failed,
  ) : false;

  return {
    plan: preview.plan,
    created,
    failed,
    items,
    skipped: preview.skipped,
    notified,
  };
}
