import { supabase } from './supabase';

type AnalysisDomain = 'finance' | 'inventory' | 'production';

type DbRow = Record<string, unknown>;

interface AnalysisSection {
  domain: AnalysisDomain;
  title: string;
  content: string;
}

interface AnalysisContext {
  domains: AnalysisDomain[];
  sections: AnalysisSection[];
  prompt: string;
}

const domainKeywords: Record<AnalysisDomain, string[]> = {
  finance: ['财务', '应收', '应付', '凭证', '资产', '负债', '收款', '付款', '账款', '现金', '利润', '成本'],
  inventory: ['库存', '存货', '物料', '产品', '仓库', '缺料', '安全库存', '低库存', '积压', '采购', '销售出货'],
  production: ['生产', '工单', '生产订单', '制造', 'mrp', 'bom', '工序', '工作中心', '报工', '完工', '延期'],
};

const analysisWords = ['分析', '查询', '统计', '情况', '看一下', '汇总', '风险', '异常', '建议'];

const table = {
  receivables: 'erp_receivables_s_539dcf81_b',
  payables: 'erp_payables_s_539dcf81_b',
  vouchers: 'erp_vouchers_s_539dcf81_b',
  fixedAssets: 'erp_fixed_assets_s_539dcf81_b',
  inventory: 'erp_inventory_s_539dcf81_b',
  products: 'erp_products_s_539dcf81_b',
  warehouses: 'erp_warehouses_s_539dcf81_b',
  purchaseOrders: 'erp_purchase_orders_s_539dcf81_b',
  salesOrders: 'erp_sales_orders_s_539dcf81_b',
  productionOrders: 'erp_production_orders_s_539dcf81_b',
  mrpPlans: 'erp_mrp_plans_s_539dcf81_b',
  mrpRequirements: 'erp_mrp_requirements_s_539dcf81_b',
  workCenters: 'erp_work_centers_s_539dcf81_b',
} as const;

const n = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : Number(value || 0));
const s = (value: unknown) => (typeof value === 'string' ? value : '');
const fmt = (value: number) => Number(value.toFixed(2)).toLocaleString('zh-CN');
const pct = (value: number) => `${Number(value.toFixed(1)).toLocaleString('zh-CN')}%`;
const today = () => new Date().toISOString().slice(0, 10);

const compactRows = <T extends DbRow>(rows: T[] | null) => rows || [];

const fetchRows = async (tableName: string, orderColumn = 'created_at', limit = 300) => {
  const { data, error } = await supabase
    .from(tableName)
    .select('*')
    .eq('is_deleted', 'n')
    .order(orderColumn, { ascending: false })
    .limit(limit);

  if (error) {
    throw error;
  }

  return compactRows(data as DbRow[] | null);
};

const sumBy = (rows: DbRow[], field: string) => rows.reduce((sum, row) => sum + n(row[field]), 0);

const countBy = (rows: DbRow[], field: string) =>
  rows.reduce<Record<string, number>>((acc, row) => {
    const key = s(row[field]) || '未设置';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

const topRows = (rows: DbRow[], field: string, limit = 5) =>
  [...rows].sort((a, b) => n(b[field]) - n(a[field])).slice(0, limit);

const formatStatusCounts = (counts: Record<string, number>) =>
  Object.entries(counts)
    .map(([key, value]) => `${key}: ${value}`)
    .join('，') || '暂无';

const mapById = (rows: DbRow[]) => new Map(rows.map((row) => [n(row.id), row]));

const productLabel = (productsById: Map<number, DbRow>, productId: unknown) => {
  const product = productsById.get(n(productId));
  if (!product) {
    return `产品ID ${productId ?? '-'}`;
  }
  return `${s(product.name) || '-'}(${s(product.code) || '-'})`;
};

const warehouseLabel = (warehousesById: Map<number, DbRow>, warehouseId: unknown) => {
  const warehouse = warehousesById.get(n(warehouseId));
  return warehouse ? s(warehouse.name) || `仓库ID ${warehouseId}` : `仓库ID ${warehouseId ?? '-'}`;
};

export const detectAnalysisDomains = (prompt: string): AnalysisDomain[] => {
  const normalized = prompt.toLowerCase();
  const asksForAnalysis = analysisWords.some((word) => normalized.includes(word.toLowerCase()));

  return (Object.keys(domainKeywords) as AnalysisDomain[]).filter((domain) => {
    const matched = domainKeywords[domain].some((word) => normalized.includes(word.toLowerCase()));
    return matched && (asksForAnalysis || matched);
  });
};

const buildFinanceSummary = async (): Promise<AnalysisSection> => {
  const [receivables, payables, vouchers, fixedAssets] = await Promise.all([
    fetchRows(table.receivables, 'doc_date'),
    fetchRows(table.payables, 'doc_date'),
    fetchRows(table.vouchers, 'voucher_date'),
    fetchRows(table.fixedAssets, 'created_at'),
  ]);

  const currentDate = today();
  const receivableBalance = sumBy(receivables, 'balance');
  const payableBalance = sumBy(payables, 'balance');
  const overdueReceivables = receivables.filter((row) => s(row.due_date) < currentDate && n(row.balance) > 0);
  const overduePayables = payables.filter((row) => s(row.due_date) < currentDate && n(row.balance) > 0);
  const voucherAmount = sumBy(vouchers, 'total_amount');
  const assetNetValue = sumBy(fixedAssets, 'net_value');
  const topReceivables = topRows(receivables, 'balance')
    .map((row) => `${s(row.doc_no)}: ${fmt(n(row.balance))}`)
    .join('；') || '暂无';
  const topPayables = topRows(payables, 'balance')
    .map((row) => `${s(row.doc_no)}: ${fmt(n(row.balance))}`)
    .join('；') || '暂无';

  return {
    domain: 'finance',
    title: '财务情况摘要',
    content: [
      `应收单据 ${receivables.length} 条，应收余额 ${fmt(receivableBalance)}，逾期应收 ${overdueReceivables.length} 条，逾期金额 ${fmt(sumBy(overdueReceivables, 'balance'))}。`,
      `应付单据 ${payables.length} 条，应付余额 ${fmt(payableBalance)}，逾期应付 ${overduePayables.length} 条，逾期金额 ${fmt(sumBy(overduePayables, 'balance'))}。`,
      `凭证 ${vouchers.length} 张，凭证金额合计 ${fmt(voucherAmount)}，状态分布：${formatStatusCounts(countBy(vouchers, 'status'))}。`,
      `固定资产 ${fixedAssets.length} 项，资产净值合计 ${fmt(assetNetValue)}。`,
      `应收余额Top：${topReceivables}。`,
      `应付余额Top：${topPayables}。`,
    ].join('\n'),
  };
};

const buildInventorySummary = async (): Promise<AnalysisSection> => {
  const [inventory, products, warehouses, purchaseOrders, salesOrders] = await Promise.all([
    fetchRows(table.inventory),
    fetchRows(table.products),
    fetchRows(table.warehouses),
    fetchRows(table.purchaseOrders, 'order_date'),
    fetchRows(table.salesOrders, 'order_date'),
  ]);

  const productsById = mapById(products);
  const warehousesById = mapById(warehouses);
  const lowStock = inventory.filter((row) => {
    const product = productsById.get(n(row.product_id));
    const safetyStock = n(product?.safety_stock);
    return safetyStock > 0 && n(row.available_quantity) <= safetyStock;
  });
  const negativeStock = inventory.filter((row) => n(row.quantity) < 0 || n(row.available_quantity) < 0);
  const lockedStock = inventory.filter((row) => n(row.locked_quantity) > 0);
  const topInventory = topRows(inventory, 'total_cost')
    .map((row) => `${productLabel(productsById, row.product_id)} / ${warehouseLabel(warehousesById, row.warehouse_id)}: ${fmt(n(row.total_cost))}`)
    .join('；') || '暂无';
  const lowStockList = lowStock.slice(0, 8)
    .map((row) => {
      const product = productsById.get(n(row.product_id));
      return `${productLabel(productsById, row.product_id)} 可用 ${fmt(n(row.available_quantity))}，安全库存 ${fmt(n(product?.safety_stock))}`;
    })
    .join('；') || '暂无';

  return {
    domain: 'inventory',
    title: '库存情况摘要',
    content: [
      `库存记录 ${inventory.length} 条，库存数量合计 ${fmt(sumBy(inventory, 'quantity'))}，可用数量合计 ${fmt(sumBy(inventory, 'available_quantity'))}，锁定数量合计 ${fmt(sumBy(inventory, 'locked_quantity'))}。`,
      `库存总成本 ${fmt(sumBy(inventory, 'total_cost'))}，物料 ${products.length} 个，仓库 ${warehouses.length} 个。`,
      `低于或等于安全库存 ${lowStock.length} 条，负库存/负可用 ${negativeStock.length} 条，有锁定库存 ${lockedStock.length} 条。`,
      `采购订单状态分布：${formatStatusCounts(countBy(purchaseOrders, 'status'))}。销售订单状态分布：${formatStatusCounts(countBy(salesOrders, 'status'))}。`,
      `库存价值Top：${topInventory}。`,
      `低库存明细Top：${lowStockList}。`,
    ].join('\n'),
  };
};

const buildProductionSummary = async (): Promise<AnalysisSection> => {
  const [orders, mrpPlans, mrpRequirements, workCenters, products] = await Promise.all([
    fetchRows(table.productionOrders, 'order_date'),
    fetchRows(table.mrpPlans, 'plan_date'),
    fetchRows(table.mrpRequirements, 'requirement_date'),
    fetchRows(table.workCenters),
    fetchRows(table.products),
  ]);

  const productsById = mapById(products);
  const currentDate = today();
  const activeOrders = orders.filter((row) => !['completed', 'closed', 'cancelled'].includes(s(row.status)));
  const overdueOrders = activeOrders.filter((row) => s(row.planned_end_date) && s(row.planned_end_date) < currentDate);
  const plannedQty = sumBy(orders, 'planned_quantity');
  const completedQty = sumBy(orders, 'completed_quantity');
  const scrappedQty = sumBy(orders, 'scrapped_quantity');
  const completionRate = plannedQty > 0 ? (completedQty / plannedQty) * 100 : 0;
  const scrapRate = plannedQty > 0 ? (scrappedQty / plannedQty) * 100 : 0;
  const netRequirements = mrpRequirements.filter((row) => n(row.net_requirement) > 0);
  const topRequirements = topRows(netRequirements, 'net_requirement')
    .map((row) => `${productLabel(productsById, row.product_id)} 净需求 ${fmt(n(row.net_requirement))}，需求日期 ${s(row.requirement_date) || '-'}`)
    .join('；') || '暂无';
  const overdueList = overdueOrders.slice(0, 8)
    .map((row) => `${s(row.order_no)} ${productLabel(productsById, row.product_id)}，计划结束 ${s(row.planned_end_date) || '-'}`)
    .join('；') || '暂无';

  return {
    domain: 'production',
    title: '生产情况摘要',
    content: [
      `生产订单 ${orders.length} 条，未完结订单 ${activeOrders.length} 条，延期订单 ${overdueOrders.length} 条。`,
      `计划数量 ${fmt(plannedQty)}，完成数量 ${fmt(completedQty)}，报废数量 ${fmt(scrappedQty)}，完成率 ${pct(completionRate)}，报废率 ${pct(scrapRate)}。`,
      `生产订单状态分布：${formatStatusCounts(countBy(orders, 'status'))}。`,
      `MRP计划 ${mrpPlans.length} 条，MRP净需求 ${netRequirements.length} 条，净需求合计 ${fmt(sumBy(netRequirements, 'net_requirement'))}。`,
      `工作中心 ${workCenters.length} 个，状态分布：${formatStatusCounts(countBy(workCenters, 'status'))}。`,
      `延期订单Top：${overdueList}。`,
      `MRP净需求Top：${topRequirements}。`,
    ].join('\n'),
  };
};

const builders: Record<AnalysisDomain, () => Promise<AnalysisSection>> = {
  finance: buildFinanceSummary,
  inventory: buildInventorySummary,
  production: buildProductionSummary,
};

export const buildERPAnalysisContext = async (prompt: string): Promise<AnalysisContext> => {
  const domains = detectAnalysisDomains(prompt);
  if (!domains.length) {
    return { domains, sections: [], prompt };
  }

  const settled = await Promise.allSettled(domains.map((domain) => builders[domain]()));
  const sections = settled.map((result, index): AnalysisSection => {
    if (result.status === 'fulfilled') {
      return result.value;
    }

    const domain = domains[index];
    return {
      domain,
      title: `${domain} 数据摘要失败`,
      content: `读取 ${domain} 数据失败：${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
    };
  });

  const contextText = sections.map((section) => `## ${section.title}\n${section.content}`).join('\n\n');
  const injectedPrompt = [
    '你是 opelix 系统内的业务分析助手。请优先基于下面的真实 ERP 数据摘要回答用户问题。',
    '回答时请使用中文，给出关键指标、异常风险、可能原因和可执行建议。不要编造摘要中没有的数据；如果数据不足，请明确说明。',
    '',
    '# ERP 数据摘要',
    contextText,
    '',
    '# 用户问题',
    prompt,
  ].join('\n');

  return { domains, sections, prompt: injectedPrompt };
};