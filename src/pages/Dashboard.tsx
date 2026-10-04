import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Button,
  Card,
  Col,
  Empty,
  Row,
  Segmented,
  Skeleton,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import { Area, Bar, Column, Gauge, Pie } from '@ant-design/charts';
import type { AreaConfig, BarConfig, ColumnConfig, GaugeConfig, PieConfig } from '@ant-design/charts';
import {
  ContainerOutlined,
  DatabaseOutlined,
  DollarOutlined,
  InboxOutlined,
  ReloadOutlined,
  RiseOutlined,
  ShoppingCartOutlined,
  SyncOutlined,
  TeamOutlined,
  ToolOutlined,
  WalletOutlined,
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import dayjs from 'dayjs';
import { supabase } from '../utils/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useCurrencyRegistry } from '../utils/money';
import { formatShanghaiDateTime } from '../utils/datetime';

/**
 * 首页：经营驾驶舱（/）
 *
 * 定位与个人工作台（/workbench）不同：工作台是「人的页面」（我的待办、我的信息、
 * 我的通知），驾驶舱是「企业的页面」——把销售、采购、库存、生产、往来五个域的
 * 关键量与走势压在一屏里，供管理层一眼扫过。
 *
 * 统计口径全部走 RLS：查询只按 is_deleted='n' 过滤，租户隔离由数据库策略保证，
 * 前端不自行拼 tenant_id，避免和服务端的隔离规则出现两套口径（与 Workbench 一致）。
 * 「金额」一律取本位币列（base_*），因为第 2 期之后单据同时存原币与本位币，
 * 混币种求和没有业务含义。
 */

// 语义色：与图例、指标卡左侧色条共用一套，保证同一个指标在页面里颜色一致
const SALES_COLOR = '#1677ff';
const PURCHASE_COLOR = '#722ed1';
const INVENTORY_COLOR = '#13c2c2';
const RECEIVABLE_COLOR = '#1677ff';
const PAYABLE_COLOR = '#fa8c16';
const PRODUCTION_COLOR = '#52c41a';
const PIE_PALETTE = [
  '#1677ff',
  '#36cfc9',
  '#9254de',
  '#ffa940',
  '#597ef7',
  '#73d13d',
  '#f759ab',
  '#ff7875',
  '#40a9ff',
  '#ffc53d',
];

/** 销售订单状态 → i18n 键（与 SalesOrders 页保持同一套文案） */
const SALES_STATUS_LABEL_KEYS: Record<string, string> = {
  draft: 'salesOrders.statusDraft',
  pending: 'salesOrders.statusPending',
  approved: 'salesOrders.statusApproved',
  partially_delivered: 'salesOrders.statusPartiallyDelivered',
  delivered: 'salesOrders.statusDelivered',
  closed: 'salesOrders.statusClosed',
  cancelled: 'salesOrders.statusCancelled',
};

/** 不参与销售/采购金额统计的状态：取消单不是业务量 */
const EXCLUDED_STATUSES = ['cancelled'];

/** 应收/应付账龄分桶：未到期 / 逾期 30 天内 / 31-60 天 / 60 天以上 */
const AGING_NOT_DUE = 'dashboard.aging.notDue' as const;
const AGING_D0_30 = 'dashboard.aging.d0_30' as const;
const AGING_D31_60 = 'dashboard.aging.d31_60' as const;
const AGING_D60_PLUS = 'dashboard.aging.d60plus' as const;
const AGING_BUCKET_KEYS = [AGING_NOT_DUE, AGING_D0_30, AGING_D31_60, AGING_D60_PLUS] as const;
type AgingBucket = (typeof AGING_BUCKET_KEYS)[number];

// ---------------------------------------------------------------------------
// 数据类型：只声明页面真正用到的列，避免把整张表的类型搬进来
// ---------------------------------------------------------------------------
interface OrderRow {
  status: string | null;
  total_amount: number | null;
  base_total_amount: number | null;
  order_date: string | null;
}

interface InventoryRow {
  product_id: number | null;
  quantity: number | null;
  total_cost: number | null;
}

interface ProductRow {
  id: number;
  code: string;
  name: string;
  category_id: number | null;
}

interface CategoryRow {
  id: number;
  name: string;
}

interface ProductionRow {
  order_no: string;
  status: string | null;
  planned_quantity: number | null;
  completed_quantity: number | null;
}

interface OpenItemRow {
  status: string | null;
  due_date: string | null;
  balance: number | null;
  base_balance: number | null;
}

interface DashboardSnapshot {
  salesOrders: OrderRow[];
  purchaseOrders: OrderRow[];
  inventory: InventoryRow[];
  products: ProductRow[];
  categories: CategoryRow[];
  productionOrders: ProductionRow[];
  receivables: OpenItemRow[];
  payables: OpenItemRow[];
  counts: {
    material: number;
    customer: number;
    supplier: number;
    warehouse: number;
  };
}

const EMPTY_SNAPSHOT: DashboardSnapshot = {
  salesOrders: [],
  purchaseOrders: [],
  inventory: [],
  products: [],
  categories: [],
  productionOrders: [],
  receivables: [],
  payables: [],
  counts: { material: 0, customer: 0, supplier: 0, warehouse: 0 },
};

const num = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * 单据金额取本位币。
 * base_total_amount 是第 2 期才补的列，历史单据可能是 0（默认值），
 * 此时退回原币金额，避免趋势图整段缺数——比「静默算成 0」更容易发现问题。
 */
const orderAmount = (row: OrderRow): number => {
  const base = num(row.base_total_amount);
  if (base !== 0) return base;
  return num(row.total_amount);
};

/** 未结余额：应收回款会改写 base_balance，取不到时退回原币余额 */
const openAmount = (row: OpenItemRow): number => {
  const base = num(row.base_balance);
  if (base !== 0) return base;
  return num(row.balance);
};

const isOpen = (row: OpenItemRow): boolean => row.status !== 'closed' && num(row.base_balance) !== 0;

const agingBucketOf = (dueDate: string | null): AgingBucket => {
  if (!dueDate) return AGING_NOT_DUE;
  const overdueDays = dayjs().startOf('day').diff(dayjs(dueDate).startOf('day'), 'day');
  if (overdueDays <= 0) return AGING_NOT_DUE;
  if (overdueDays <= 30) return AGING_D0_30;
  if (overdueDays <= 60) return AGING_D31_60;
  return AGING_D60_PLUS;
};

/**
 * Ant Design Charts 的配置类型是「G2 Mark / Composition 的巨型联合类型」，
 * 逐字段标注既冗长又容易随 G2 版本漂移。这里统一做一次断言：
 * 配置项仍是官方文档的字段名（xField / colorField / scale / axis ...），
 * 类型风险被收敛在这一个函数里，而不是散落在每个图表上。
 */
function chartProps<T>(config: Record<string, unknown>): T {
  return config as unknown as T;
}

/** 深浅模式标记由 ProLayout 写在 <html data-erp-dark> 上，图表需要跟着换主题 */
function useErpDarkMode(): boolean {
  const [dark, setDark] = useState(
    () => typeof document !== 'undefined' && document.documentElement.dataset.erpDark === 'true',
  );

  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => {
      setDark(root.dataset.erpDark === 'true');
    });
    observer.observe(root, { attributes: true, attributeFilter: ['data-erp-dark'] });
    return () => observer.disconnect();
  }, []);

  return dark;
}

interface KpiConfig {
  key: string;
  labelKey: string;
  icon: ReactNode;
  color: string;
  amount: number;
  foot: string;
  path: string;
}

export function Dashboard() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const dark = useErpDarkMode();
  const { formatMoney, formatQuantity } = useCurrencyRegistry();

  const language = i18n.resolvedLanguage === 'en-US' ? 'en-US' : 'zh-CN';
  const [range, setRange] = useState<6 | 12>(6);
  const [snapshot, setSnapshot] = useState<DashboardSnapshot>(EMPTY_SNAPSHOT);
  const [loading, setLoading] = useState(true);
  const [loadedAt, setLoadedAt] = useState<string | null>(null);

  const chartTheme = dark ? 'classicDark' : 'classic';

  const intFormatter = useMemo(
    () => new Intl.NumberFormat(language, { maximumFractionDigits: 0 }),
    [language],
  );

  /** 坐标轴上的金额压成「万 / 亿」（中文）或「K / M / B」（英文），否则轴标签会挤爆 */
  const compactAmount = useCallback(
    (value: number): string => {
      const abs = Math.abs(value);
      if (language === 'en-US') {
        if (abs >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
        if (abs >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
        if (abs >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
      } else {
        if (abs >= 1e8) return `${(value / 1e8).toFixed(2)}亿`;
        if (abs >= 1e4) return `${(value / 1e4).toFixed(1)}万`;
      }
      return intFormatter.format(value);
    },
    [language, intFormatter],
  );

  const loadSnapshot = useCallback(async (): Promise<DashboardSnapshot> => {
    const [
      salesRes,
      purchaseRes,
      inventoryRes,
      productRes,
      categoryRes,
      productionRes,
      receivableRes,
      payableRes,
      materialRes,
      customerRes,
      supplierRes,
      warehouseRes,
    ] = await Promise.all([
      supabase
        .from('erp_sales_orders_s_539dcf81_b')
        .select('status, total_amount, base_total_amount, order_date')
        .eq('is_deleted', 'n'),
      supabase
        .from('erp_purchase_orders_s_539dcf81_b')
        .select('status, total_amount, base_total_amount, order_date')
        .eq('is_deleted', 'n'),
      supabase
        .from('erp_inventory_s_539dcf81_b')
        .select('product_id, quantity, total_cost')
        .eq('is_deleted', 'n'),
      supabase.from('erp_products_s_539dcf81_b').select('id, code, name, category_id').eq('is_deleted', 'n'),
      supabase.from('erp_product_categories_s_539dcf81_b').select('id, name').eq('is_deleted', 'n'),
      supabase
        .from('erp_production_orders_s_539dcf81_b')
        .select('order_no, status, planned_quantity, completed_quantity')
        .eq('is_deleted', 'n'),
      supabase
        .from('erp_receivables_s_539dcf81_b')
        .select('status, due_date, balance, base_balance')
        .eq('is_deleted', 'n'),
      supabase
        .from('erp_payables_s_539dcf81_b')
        .select('status, due_date, balance, base_balance')
        .eq('is_deleted', 'n'),
      supabase.from('erp_products_s_539dcf81_b').select('id', { count: 'exact', head: true }).eq('is_deleted', 'n'),
      supabase.from('erp_customers_s_539dcf81_b').select('id', { count: 'exact', head: true }).eq('is_deleted', 'n'),
      supabase.from('erp_suppliers_s_539dcf81_b').select('id', { count: 'exact', head: true }).eq('is_deleted', 'n'),
      supabase.from('erp_warehouses_s_539dcf81_b').select('id', { count: 'exact', head: true }).eq('is_deleted', 'n'),
    ]);

    // 单条查询失败不阻塞整页：记日志、该块留空，其余照常渲染
    const pick = <T,>(result: { data: unknown; error: unknown }, label: string): T[] => {
      if (result.error) {
        console.error(`Dashboard: failed to load ${label}`, result.error);
        return [];
      }
      return (result.data ?? []) as T[];
    };

    return {
      salesOrders: pick<OrderRow>(salesRes, 'sales orders'),
      purchaseOrders: pick<OrderRow>(purchaseRes, 'purchase orders'),
      inventory: pick<InventoryRow>(inventoryRes, 'inventory'),
      products: pick<ProductRow>(productRes, 'products'),
      categories: pick<CategoryRow>(categoryRes, 'product categories'),
      productionOrders: pick<ProductionRow>(productionRes, 'production orders'),
      receivables: pick<OpenItemRow>(receivableRes, 'receivables'),
      payables: pick<OpenItemRow>(payableRes, 'payables'),
      counts: {
        material: materialRes.error ? 0 : materialRes.count ?? 0,
        customer: customerRes.error ? 0 : customerRes.count ?? 0,
        supplier: supplierRes.error ? 0 : supplierRes.count ?? 0,
        warehouse: warehouseRes.error ? 0 : warehouseRes.count ?? 0,
      },
    };
  }, []);

  const loadAll = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      setSnapshot(await loadSnapshot());
      setLoadedAt(new Date().toISOString());
    } catch (error) {
      console.error('Dashboard: failed to load cockpit data', error);
      message.error(t('dashboard.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [user, loadSnapshot, t]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const { salesOrders, purchaseOrders, inventory, products, categories, productionOrders, receivables, payables } =
    snapshot;

  // -------------------------------------------------------------------------
  // 指标卡
  // -------------------------------------------------------------------------
  const metrics = useMemo(() => {
    const activeSales = salesOrders.filter((row) => !EXCLUDED_STATUSES.includes(row.status ?? ''));
    const activePurchase = purchaseOrders.filter((row) => !EXCLUDED_STATUSES.includes(row.status ?? ''));

    const salesAmount = activeSales.reduce((sum, row) => sum + orderAmount(row), 0);
    const purchaseAmount = activePurchase.reduce((sum, row) => sum + orderAmount(row), 0);
    const inventoryValue = inventory.reduce((sum, row) => sum + num(row.total_cost), 0);
    const inventoryQuantity = inventory.reduce((sum, row) => sum + num(row.quantity), 0);

    const openReceivableRows = receivables.filter(isOpen);
    const openPayableRows = payables.filter(isOpen);
    const receivableAmount = openReceivableRows.reduce((sum, row) => sum + openAmount(row), 0);
    const payableAmount = openPayableRows.reduce((sum, row) => sum + openAmount(row), 0);

    const overdueReceivable = openReceivableRows.filter(
      (row) => agingBucketOf(row.due_date) !== AGING_NOT_DUE,
    ).length;
    const overduePayable = openPayableRows.filter(
      (row) => agingBucketOf(row.due_date) !== AGING_NOT_DUE,
    ).length;

    const openProduction = productionOrders.filter(
      (row) => !['completed', 'closed', 'cancelled'].includes((row.status ?? '').toLowerCase()),
    ).length;
    const plannedOutput = productionOrders.reduce((sum, row) => sum + num(row.planned_quantity), 0);
    const completedOutput = productionOrders.reduce((sum, row) => sum + num(row.completed_quantity), 0);
    const completionRate = plannedOutput > 0 ? (completedOutput / plannedOutput) * 100 : 0;

    return {
      salesAmount,
      salesCount: activeSales.length,
      purchaseAmount,
      purchaseCount: activePurchase.length,
      inventoryValue,
      inventoryQuantity,
      receivableAmount,
      receivableCount: openReceivableRows.length,
      overdueReceivable,
      payableAmount,
      payableCount: openPayableRows.length,
      overduePayable,
      openProduction,
      plannedOutput,
      completedOutput,
      completionRate,
    };
  }, [salesOrders, purchaseOrders, inventory, receivables, payables, productionOrders]);

  const kpis: KpiConfig[] = useMemo(
    () => [
      {
        key: 'sales',
        labelKey: 'dashboard.kpi.salesAmount',
        icon: <RiseOutlined />,
        color: SALES_COLOR,
        amount: metrics.salesAmount,
        foot: t('dashboard.kpi.orderCount', { count: intFormatter.format(metrics.salesCount) }),
        path: '/inventory/sales',
      },
      {
        key: 'purchase',
        labelKey: 'dashboard.kpi.purchaseAmount',
        icon: <ShoppingCartOutlined />,
        color: PURCHASE_COLOR,
        amount: metrics.purchaseAmount,
        foot: t('dashboard.kpi.orderCount', { count: intFormatter.format(metrics.purchaseCount) }),
        path: '/inventory/purchase',
      },
      {
        key: 'inventory',
        labelKey: 'dashboard.kpi.inventoryValue',
        icon: <DatabaseOutlined />,
        color: INVENTORY_COLOR,
        amount: metrics.inventoryValue,
        foot: t('dashboard.kpi.stockQuantity', {
          value: formatQuantity(metrics.inventoryQuantity, 0),
        }),
        path: '/inventory/stock',
      },
      {
        key: 'receivable',
        labelKey: 'dashboard.kpi.receivable',
        icon: <WalletOutlined />,
        color: RECEIVABLE_COLOR,
        amount: metrics.receivableAmount,
        foot: t('dashboard.kpi.openItems', {
          count: intFormatter.format(metrics.receivableCount),
          overdue: intFormatter.format(metrics.overdueReceivable),
        }),
        path: '/finance/receivables',
      },
      {
        key: 'payable',
        labelKey: 'dashboard.kpi.payable',
        icon: <DollarOutlined />,
        color: PAYABLE_COLOR,
        amount: metrics.payableAmount,
        foot: t('dashboard.kpi.openItems', {
          count: intFormatter.format(metrics.payableCount),
          overdue: intFormatter.format(metrics.overduePayable),
        }),
        path: '/finance/payables',
      },
      {
        key: 'production',
        labelKey: 'dashboard.kpi.productionOpen',
        icon: <ToolOutlined />,
        color: PRODUCTION_COLOR,
        amount: metrics.openProduction,
        foot: t('dashboard.kpi.completionRate', {
          rate: metrics.completionRate.toFixed(1),
        }),
        path: '/mrp/production',
      },
    ],
    [metrics, t, intFormatter, formatQuantity],
  );

  // -------------------------------------------------------------------------
  // 图表数据
  // -------------------------------------------------------------------------

  /** 近 N 个月的月份序列（含当月），用来补齐没有单据的月份，趋势线才不会断 */
  const monthKeys = useMemo(() => {
    const list: string[] = [];
    const now = dayjs();
    for (let i = range - 1; i >= 0; i -= 1) {
      list.push(now.subtract(i, 'month').format('YYYY-MM'));
    }
    return list;
  }, [range]);

  const trendData = useMemo(() => {
    const monthLabel = (key: string) => dayjs(`${key}-01`).format(language === 'en-US' ? 'MMM YY' : 'YY-MM');
    const bucket = (rows: OrderRow[]) => {
      const map = new Map<string, number>();
      rows
        .filter((row) => !EXCLUDED_STATUSES.includes(row.status ?? ''))
        .forEach((row) => {
          if (!row.order_date) return;
          const key = dayjs(row.order_date).format('YYYY-MM');
          map.set(key, (map.get(key) ?? 0) + orderAmount(row));
        });
      return map;
    };

    const salesByMonth = bucket(salesOrders);
    const purchaseByMonth = bucket(purchaseOrders);
    const salesLabel = t('dashboard.chart.trend.sales');
    const purchaseLabel = t('dashboard.chart.trend.purchase');

    return monthKeys.flatMap((key) => [
      { month: monthLabel(key), type: salesLabel, value: salesByMonth.get(key) ?? 0 },
      { month: monthLabel(key), type: purchaseLabel, value: purchaseByMonth.get(key) ?? 0 },
    ]);
  }, [salesOrders, purchaseOrders, monthKeys, language, t]);

  const salesStatusData = useMemo(() => {
    const map = new Map<string, number>();
    salesOrders.forEach((row) => {
      const status = (row.status ?? 'draft').toLowerCase();
      map.set(status, (map.get(status) ?? 0) + 1);
    });
    return Array.from(map.entries())
      .map(([status, value], index) => ({
        name: SALES_STATUS_LABEL_KEYS[status] ? t(SALES_STATUS_LABEL_KEYS[status]) : status,
        value,
        color: PIE_PALETTE[index % PIE_PALETTE.length],
      }))
      .sort((a, b) => b.value - a.value);
  }, [salesOrders, t]);

  const topInventoryData = useMemo(() => {
    const nameById = new Map(products.map((product) => [product.id, product.name]));
    const valueByProduct = new Map<number, number>();
    inventory.forEach((row) => {
      if (row.product_id === null) return;
      valueByProduct.set(row.product_id, (valueByProduct.get(row.product_id) ?? 0) + num(row.total_cost));
    });
    return Array.from(valueByProduct.entries())
      .map(([productId, value]) => ({
        name: nameById.get(productId) ?? `#${productId}`,
        value,
      }))
      .filter((item) => item.value !== 0)
      .sort((a, b) => b.value - a.value)
      .slice(0, 10);
  }, [inventory, products]);

  const agingData = useMemo(() => {
    const buckets = (rows: OpenItemRow[], label: string, color: string) => {
      const map = new Map<AgingBucket, number>();
      AGING_BUCKET_KEYS.forEach((key) => map.set(key, 0));
      rows.filter(isOpen).forEach((row) => {
        const key = agingBucketOf(row.due_date);
        map.set(key, (map.get(key) ?? 0) + openAmount(row));
      });
      // 余额为 0 的分桶不画柱子，否则图例里会多出一堆空类别
      return AGING_BUCKET_KEYS.flatMap((key) => {
        const value = map.get(key) ?? 0;
        if (value === 0) return [];
        return [{ bucket: t(key), type: label, value, color }];
      });
    };

    return [
      ...buckets(receivables, t('dashboard.chart.arap.receivable'), RECEIVABLE_COLOR),
      ...buckets(payables, t('dashboard.chart.arap.payable'), PAYABLE_COLOR),
    ];
  }, [receivables, payables, t]);

  const productionCompareData = useMemo(() => {
    const plannedLabel = t('dashboard.chart.production.planned');
    const completedLabel = t('dashboard.chart.production.completed');
    return productionOrders
      .filter((row) => num(row.planned_quantity) > 0)
      .sort((a, b) => num(b.planned_quantity) - num(a.planned_quantity))
      .slice(0, 6)
      .flatMap((row) => [
        { name: row.order_no, type: plannedLabel, value: num(row.planned_quantity) },
        { name: row.order_no, type: completedLabel, value: num(row.completed_quantity) },
      ]);
  }, [productionOrders, t]);

  const categoryData = useMemo(() => {
    const nameById = new Map(categories.map((category) => [category.id, category.name]));
    const unassigned = t('dashboard.chart.category.unassigned');
    const map = new Map<string, number>();
    products.forEach((product) => {
      const name = product.category_id === null ? unassigned : nameById.get(product.category_id) ?? unassigned;
      map.set(name, (map.get(name) ?? 0) + 1);
    });
    return Array.from(map.entries())
      .map(([name, value], index) => ({ name, value, color: PIE_PALETTE[index % PIE_PALETTE.length] }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 8);
  }, [products, categories, t]);

  // -------------------------------------------------------------------------
  // 图表配置
  // -------------------------------------------------------------------------
  const trendConfig = useMemo(
    () =>
      chartProps<AreaConfig>({
        data: trendData,
        xField: 'month',
        yField: 'value',
        colorField: 'type',
        shapeField: 'smooth',
        height: 300,
        theme: chartTheme,
        scale: { color: { domain: [t('dashboard.chart.trend.sales'), t('dashboard.chart.trend.purchase')], range: [SALES_COLOR, PURCHASE_COLOR] } },
        style: { fillOpacity: 0.18, lineWidth: 2 },
        axis: { y: { labelFormatter: (value: number) => compactAmount(value) } },
        legend: { color: { position: 'top', layout: { justifyContent: 'flex-end' } } },
        tooltip: { items: [{ channel: 'y', valueFormatter: (value: number) => formatMoney(value) }] },
      }),
    [trendData, t, chartTheme, compactAmount, formatMoney],
  );

  const salesStatusConfig = useMemo(
    () =>
      chartProps<PieConfig>({
        data: salesStatusData,
        angleField: 'value',
        colorField: 'name',
        innerRadius: 0.62,
        height: 300,
        theme: chartTheme,
        scale: {
          color: { domain: salesStatusData.map((item) => item.name), range: salesStatusData.map((item) => item.color) },
        },
        legend: { color: { position: 'right', rowPadding: 6 } },
        label: { text: 'value', style: { fontSize: 11, fontWeight: 600 } },
        tooltip: { items: [{ channel: 'y', valueFormatter: (value: number) => intFormatter.format(value) }] },
        annotations: [
          {
            type: 'text',
            style: {
              text: `${intFormatter.format(salesOrders.length)}\n${t('dashboard.chart.status.total')}`,
              x: '50%',
              y: '50%',
              textAlign: 'center',
              fontSize: 16,
              fontWeight: 600,
              fill: dark ? '#e2e8f0' : '#0f172a',
            },
          },
        ],
      }),
    [salesStatusData, salesOrders.length, t, chartTheme, intFormatter, dark],
  );

  const topInventoryConfig = useMemo(
    () =>
      chartProps<BarConfig>({
        data: topInventoryData,
        xField: 'value',
        yField: 'name',
        height: 320,
        theme: chartTheme,
        sort: { by: 'x', reverse: true },
        style: { fill: (datum: { value: number }) => (datum.value >= 0 ? SALES_COLOR : '#ff7875'), radiusTopLeft: 4, radiusBottomLeft: 4 },
        axis: {
          x: { labelFormatter: (value: number) => compactAmount(value) },
          y: { labelFontSize: 11 },
        },
        legend: false,
        label: false,
        tooltip: { items: [{ channel: 'x', valueFormatter: (value: number) => formatMoney(value) }] },
      }),
    [topInventoryData, chartTheme, compactAmount, formatMoney],
  );

  const agingConfig = useMemo(
    () =>
      chartProps<ColumnConfig>({
        data: agingData,
        xField: 'bucket',
        yField: 'value',
        colorField: 'type',
        group: true,
        height: 320,
        theme: chartTheme,
        scale: {
          color: {
            domain: [t('dashboard.chart.arap.receivable'), t('dashboard.chart.arap.payable')],
            range: [RECEIVABLE_COLOR, PAYABLE_COLOR],
          },
        },
        style: { radiusTopLeft: 4, radiusTopRight: 4 },
        axis: { y: { labelFormatter: (value: number) => compactAmount(value) } },
        legend: { color: { position: 'top', layout: { justifyContent: 'flex-end' } } },
        tooltip: { items: [{ channel: 'y', valueFormatter: (value: number) => formatMoney(value) }] },
      }),
    [agingData, t, chartTheme, compactAmount, formatMoney],
  );

  const productionGaugeConfig = useMemo(() => {
    const total = metrics.plannedOutput > 0 ? metrics.plannedOutput : 1;
    return chartProps<GaugeConfig>({
      data: {
        // 超产（完工 > 计划）时把指针压到满格，否则仪表盘会画出超过一圈的弧
        target: Math.min(metrics.completedOutput, total),
        total,
        name: t('dashboard.chart.production.rate'),
        thresholds: [total / 3, (total * 2) / 3, total],
      },
      height: 250,
      theme: chartTheme,
      legend: false,
      scale: { color: { range: ['#ff7875', '#ffc53d', '#52c41a'] } },
      style: {
        textContent: () => `${metrics.completionRate.toFixed(1)}%`,
      },
    });
  }, [metrics.plannedOutput, metrics.completedOutput, metrics.completionRate, t, chartTheme]);

  const productionCompareConfig = useMemo(
    () =>
      chartProps<ColumnConfig>({
        data: productionCompareData,
        xField: 'name',
        yField: 'value',
        colorField: 'type',
        group: true,
        height: 250,
        theme: chartTheme,
        scale: {
          color: {
            domain: [t('dashboard.chart.production.planned'), t('dashboard.chart.production.completed')],
            range: ['#91caff', PRODUCTION_COLOR],
          },
        },
        style: { radiusTopLeft: 4, radiusTopRight: 4 },
        axis: { x: { labelFontSize: 10, labelAutoRotate: true } },
        legend: { color: { position: 'top', layout: { justifyContent: 'flex-end' } } },
      }),
    [productionCompareData, t, chartTheme],
  );

  const categoryConfig = useMemo(
    () =>
      chartProps<PieConfig>({
        data: categoryData,
        angleField: 'value',
        colorField: 'name',
        radius: 0.92,
        height: 250,
        theme: chartTheme,
        scale: {
          color: { domain: categoryData.map((item) => item.name), range: categoryData.map((item) => item.color) },
        },
        legend: { color: { position: 'right', rowPadding: 4 } },
        label: false,
        tooltip: { items: [{ channel: 'y', valueFormatter: (value: number) => intFormatter.format(value) }] },
      }),
    [categoryData, chartTheme, intFormatter],
  );

  const hasTrend = trendData.some((item) => item.value !== 0);
  const hasTopInventory = topInventoryData.length > 0;
  const hasAging = agingData.length > 0;
  const hasProduction = metrics.plannedOutput > 0;
  const hasProductionCompare = productionCompareData.length > 0;
  const hasCategory = categoryData.length > 0;

  const displayName = user?.profile.real_name || user?.profile.username || user?.auth.email || '';
  const rangeOptions = [
    { label: t('dashboard.range6'), value: 6 },
    { label: t('dashboard.range12'), value: 12 },
  ];

  const chartCard = (title: string, hint: string | null, hasData: boolean, chart: ReactNode) => (
    <Card variant="borderless" className="cockpit-chart">
      <div className="cockpit-chart__head">
        <span className="cockpit-chart__title">{title}</span>
        {hint ? <span className="cockpit-chart__hint">{hint}</span> : null}
      </div>
      <div className="cockpit-chart__body">
        {hasData ? chart : <Empty className="cockpit-chart__empty" image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('dashboard.empty')} />}
      </div>
    </Card>
  );

  return (
    <Card variant="borderless">
      <div className="cockpit">
        <Card variant="borderless" className="cockpit-hero" style={{ marginBottom: 16 }}>
          <div className="cockpit-hero__blob cockpit-hero__blob--sky" aria-hidden="true" />
          <div className="cockpit-hero__blob cockpit-hero__blob--violet" aria-hidden="true" />
          <div className="cockpit-hero__blob cockpit-hero__blob--mint" aria-hidden="true" />
          <div className="cockpit-hero__content">
            <Row gutter={[16, 16]} align="middle" justify="space-between">
              <Col flex="auto">
                <div className="cockpit-hero__title">
                  {t('dashboard.title')}
                  {displayName ? ` · ${t('dashboard.welcome', { name: displayName })}` : ''}
                </div>
                <div className="cockpit-hero__meta">
                  {t('dashboard.today', { date: dayjs().format('YYYY-MM-DD dddd') })}
                  {loadedAt ? ` · ${t('dashboard.updatedAt', { time: formatShanghaiDateTime(loadedAt) })}` : ''}
                </div>
                <div className="cockpit-hero__chips">
                  <Tag icon={<InboxOutlined />} color="blue">
                    {t('dashboard.kpi.materialCount')} {intFormatter.format(snapshot.counts.material)}
                  </Tag>
                  <Tag icon={<TeamOutlined />} color="geekblue">
                    {t('dashboard.kpi.customerCount')} {intFormatter.format(snapshot.counts.customer)}
                  </Tag>
                  <Tag icon={<ShoppingCartOutlined />} color="purple">
                    {t('dashboard.kpi.supplierCount')} {intFormatter.format(snapshot.counts.supplier)}
                  </Tag>
                  <Tag icon={<ContainerOutlined />} color="cyan">
                    {t('dashboard.kpi.warehouseCount')} {intFormatter.format(snapshot.counts.warehouse)}
                  </Tag>
                </div>
              </Col>
              <Col flex="none">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Segmented
                    value={range}
                    options={rangeOptions}
                    onChange={(value) => setRange(value as 6 | 12)}
                  />
                  <Tooltip title={t('common.refresh')}>
                    <Button
                      icon={loading ? <SyncOutlined spin /> : <ReloadOutlined />}
                      loading={loading}
                      onClick={() => void loadAll()}
                    >
                      {t('common.refresh')}
                    </Button>
                  </Tooltip>
                </div>
              </Col>
            </Row>
          </div>
        </Card>

        <Skeleton loading={loading} active paragraph={{ rows: 1 }}>
          <Row gutter={[16, 16]} align="stretch" style={{ marginBottom: 16 }}>
            {kpis.map((kpi) => (
              <Col xs={12} sm={12} md={8} xl={4} key={kpi.key}>
                <div
                  className={`cockpit-kpi${kpi.path ? ' cockpit-kpi--clickable' : ''}`}
                  onClick={() => (kpi.path ? navigate(kpi.path) : undefined)}
                >
                  <span className="cockpit-kpi__accent" style={{ background: kpi.color }} aria-hidden="true" />
                  <div className="cockpit-kpi__head">
                    <span
                      className="cockpit-kpi__icon"
                      style={{ background: `${kpi.color}1f`, color: kpi.color }}
                    >
                      {kpi.icon}
                    </span>
                    <span className="cockpit-kpi__label">{t(kpi.labelKey)}</span>
                  </div>
                  <div className="cockpit-kpi__value">
                    {kpi.key === 'production'
                      ? intFormatter.format(kpi.amount)
                      : formatMoney(kpi.amount, null, { decimalPlaces: 2 })}
                  </div>
                  <div className="cockpit-kpi__foot">{kpi.foot}</div>
                </div>
              </Col>
            ))}
          </Row>

          <Row gutter={[16, 16]} align="stretch" style={{ marginBottom: 16 }}>
            <Col xs={24} xl={16}>
              {chartCard(
                t('dashboard.chart.trend.title', { range }),
                null,
                hasTrend,
                <Area {...trendConfig} />,
              )}
            </Col>
            <Col xs={24} xl={8}>
              {chartCard(
                t('dashboard.chart.status.title'),
                null,
                salesStatusData.length > 0,
                <Pie {...salesStatusConfig} />,
              )}
            </Col>
          </Row>

          <Row gutter={[16, 16]} align="stretch" style={{ marginBottom: 16 }}>
            <Col xs={24} xl={12}>
              {chartCard(
                t('dashboard.chart.inventoryTop.title'),
                null,
                hasTopInventory,
                <Bar {...topInventoryConfig} />,
              )}
            </Col>
            <Col xs={24} xl={12}>
              {chartCard(
                t('dashboard.chart.arap.title'),
                null,
                hasAging,
                <Column {...agingConfig} />,
              )}
            </Col>
          </Row>

          <Row gutter={[16, 16]} align="stretch">
            <Col xs={24} lg={8}>
              {chartCard(
                t('dashboard.chart.production.title'),
                null,
                hasProduction,
                <Gauge {...productionGaugeConfig} />,
              )}
            </Col>
            <Col xs={24} lg={8}>
              {chartCard(
                t('dashboard.chart.productionCompare.title'),
                null,
                hasProductionCompare,
                <Column {...productionCompareConfig} />,
              )}
            </Col>
            <Col xs={24} lg={8}>
              {chartCard(
                t('dashboard.chart.category.title'),
                null,
                hasCategory,
                <Pie {...categoryConfig} />,
              )}
            </Col>
          </Row>

          <Typography.Paragraph type="secondary" style={{ margin: '16px 4px 12px', fontSize: 12 }}>
            {t('dashboard.footnote')}
          </Typography.Paragraph>
        </Skeleton>
      </div>
    </Card>
  );
}

export default Dashboard;
