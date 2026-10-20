import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  Button,
  Card,
  Col,
  Drawer,
  Input,
  Progress,
  Row,
  Select,
  Space,
  Statistic,
  Tabs,
  Tag,
} from 'antd';
import { ReloadOutlined, AimOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { message } from 'antd';
import { supabase } from '../../utils/supabase';
import { SuperTable } from '../../components/SuperTable';
import { useCurrencyRegistry } from '../../utils/money';
import { useErpDarkMode } from '../../hooks/useErpDarkMode';
import { clamp, useElementWidth } from '../../features/page-builder/widgetUtils';
import { Factory3DViewer } from '../../components/Factory3DViewer';

/**
 * 生产报表（P0-5）。
 *
 * 五个页签全部读 deploy_108 建的 `security_invoker` 视图 —— 关联（物料/工作中心）、
 * 进度百分比、料工费归集、在制结转、产能负荷**都在数据库里算**，前端只做筛选与展示。
 *
 * 口径（详见 deploy_108 文件头，别当成 bug）：
 *   · 进度表的「已完成」取**已过账完工入库**（库存流水是唯一事实源），
 *     另列展示工单表头申报值 declared_completed_quantity；
 *   · 工单成本表是**按生产订单**的全部期间累计（与 ai-server 按「月×产品」的成本卷算
 *     是不同粒度，后者看「在制报表」页签）；
 *   · 只计入 `status='posted'` 的领料/入库与 `status='confirmed'` 的报工；
 *   · 产能负荷 = 实际工时负荷 ÷ 月产能。月产能口径见下（deploy_119 改过）。
 *
 * ⚠️ 产能口径变更（deploy_119）：
 *   `vw_erp_capacity_load` 原先按月**自然日**数算月产能，周末与节假日也被当成
 *   可生产的日子，负荷率被系统性低估。deploy_119 起改为按**当月工作日数**
 *   （读租户「默认+启用」的工作日历，例外日优先于周规律；没有日历则退化为
 *   自然日＝旧行为），日产能则优先取「班次净工时 × 每天班次数」，
 *   未配班次的工作中心仍回退 `capacity_per_day`。
 *   视图新增 `work_day_count` 与 `capacity_source` 两列把口径摊开显示。
 *   ⚠️ ai-server 的 MPS RCCP（mpsService）仍按自然日 —— 尚未对齐，见该文件注释。
 */

type ProgressRow = {
  tenant_id: number;
  order_id: number;
  order_no: string;
  order_date: string;
  status: string;
  priority: number | null;
  product_id: number | null;
  product_code: string | null;
  product_name: string | null;
  unit: string | null;
  planned_quantity: number;
  declared_completed_quantity: number;
  scrapped_quantity: number;
  received_quantity: number;
  remaining_quantity: number;
  progress_pct: number;
  scrap_rate: number;
  planned_start_date: string | null;
  planned_end_date: string | null;
  actual_start_date: string | null;
  actual_end_date: string | null;
  delay_days: number;
  bom_no: string | null;
  routing_no: string | null;
  work_center_name: string | null;
};

type CostRowView = {
  tenant_id: number;
  order_id: number;
  order_no: string;
  order_date: string;
  status: string;
  product_id: number | null;
  product_code: string | null;
  product_name: string | null;
  material_cost: number;
  labor_cost: number;
  overhead_cost: number;
  total_cost: number;
  received_quantity: number;
  unit_cost: number;
};

type WipRow = {
  tenant_id: number;
  period_year: number;
  period_month: number;
  period_start: string;
  product_id: number;
  product_code: string | null;
  product_name: string | null;
  beginning_wip: number;
  current_material: number;
  current_labor: number;
  current_overhead: number;
  current_input: number;
  finished_quantity: number;
  unit_cost: number;
  ending_wip: number;
};

type CapacityRow = {
  tenant_id: number;
  work_center_id: number;
  work_center_code: string | null;
  work_center_name: string | null;
  month_start: string;
  capacity_per_day: number;
  capacity_hours: number;
  labor_hours: number;
  machine_hours: number;
  load_hours: number;
  load_rate: number;
  // deploy_119 新增：产能口径诊断列
  work_day_count: number | null;
  capacity_source: 'shift' | 'manual' | null;
  shift_no: string | null;
  shift_name: string | null;
  shift_net_hours: number | null;
};

const { Option } = Select;

/** 一次性拉取上限：报表是"看趋势"的，超过这个量应该缩小筛选条件而不是硬拉全表。 */
const RESULT_LIMIT = 2000;

const num = (v: number | null | undefined) => Number(v || 0);
const qty = (v: number | null | undefined) => num(v).toLocaleString();

/** 工单状态 → 复用生产订单页既有 key，避免重复维护文案 */
const STATUS_KEYS = ['draft', 'planned', 'released', 'in_progress', 'completed', 'closed', 'cancelled'];
const statusKeyOf = (s: string) => {
  const camel = (s || '').replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  return STATUS_KEYS.includes(s) ? `mrp.productionOrders.status${camel.charAt(0).toUpperCase()}${camel.slice(1)}` : '';
};

/**
 * 逾期工单 TOP —— 参考页面设计器的「实时明细流 (Live Stream)」组件视觉：
 * LIVE 徽标（呼吸红点）+ 时间列 + 状态圆点 + 单行文案，逐条淡入。
 * 因 page-builder.css 非全局引入，这里把样式内联，保持与设计器一致的观感。
 */
function OverdueStream({ items }: { items: ProgressRow[] }) {
  const { t } = useTranslation();
  const dark = useErpDarkMode();
  // 暗色下 var(--text)/var(--text-h) 解析不可靠（截图里时间列几乎不可见），
  // 与页面设计器一致改为按主题显式取色。
  const textColor = dark ? '#e6e8eb' : '#1f2329';
  const mutedColor = dark ? 'rgba(230, 232, 235, 0.62)' : 'rgba(31, 35, 41, 0.62)';
  const itemBg = dark ? 'rgba(255, 255, 255, 0.06)' : 'rgba(127, 127, 127, 0.07)';
  // 每条逾期工单的「流入时刻」——仅用于展示；首次出现即固定，避免刷新跳变。
  const firstSeen = useRef<Map<number, string>>(new Map());

  const feed = items.map((r) => {
    if (!firstSeen.current.has(r.order_id)) {
      firstSeen.current.set(r.order_id, `${r.delay_days}${t('mrp.productionAnalytics.days')}`);
    }
    return {
      id: r.order_id,
      time: firstSeen.current.get(r.order_id)!,
      text: `${r.order_no}  ${[r.product_code, r.product_name].filter(Boolean).join(' / ') || '-'}`,
    };
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingBottom: 6 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, letterSpacing: '0.06em', color: '#ff4d4f' }}>
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: '#ff4d4f',
              animation: 'erp-pb-pulse 1.4s ease-in-out infinite',
            }}
          />
          {t('pageRenderer.liveBadge')}
        </span>
        <span style={{ fontSize: 12, color: mutedColor, fontVariantNumeric: 'tabular-nums' }}>
          {t('pageRenderer.streamCount', { count: feed.length })}
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {feed.map((item, index) => (
          <div
            key={item.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 8px',
              borderRadius: 6,
              background: itemBg,
              animation: `erp-pb-fade-up 0.3s ease both`,
              animationDelay: `${Math.min(index, 6) * 45}ms`,
            }}
          >
            <span style={{ flex: '0 0 auto', width: 58, fontSize: 11, color: mutedColor, fontVariantNumeric: 'tabular-nums' }}>
              {item.time}
            </span>
            <span style={{ flex: '0 0 auto', width: 6, height: 6, borderRadius: '50%', background: '#ff4d4f' }} />
            <span
              style={{
                flex: '1 1 auto',
                minWidth: 0,
                fontSize: 12.5,
                color: textColor,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={item.text}
            >
              {item.text}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * 产能负荷仪表盘 —— 参考页面设计器的「仪表盘 (Gauge)」组件：自绘 SVG，
 * 270° 弧形 + 渐变进度 + 刻度 + 中央数值 + 标签 + 百分比。负荷率 0~100% 为
 * 额定区间，超过 100% 即超负荷（红色告警）。颜色：<80% 正常绿 → 80~100% 黄 → >100% 红。
 */
function CapacityGauge({ label, loadRate }: { label: string; loadRate: number }) {
  const { t } = useTranslation();
  const dark = useErpDarkMode();
  const { ref, width } = useElementWidth<HTMLDivElement>();
  const rawId = useId();
  const gradientId = `cap-gauge-${rawId.replace(/[^a-zA-Z0-9]/g, '')}`;

  const value = num(loadRate);
  // 仪表盘上限取 max(100, 负荷率向上取整)，保证超负荷时指针仍落在刻度内
  const max = Math.max(100, Math.ceil(value / 50) * 50);
  const ratio = clamp(value / max, 0, 1);

  const size = Math.round(clamp(Math.min(width || 220, 220), 150, 220));
  const stroke = clamp(size * 0.075, 10, 18);
  const center = size / 2;
  const radius = center - stroke / 2 - 8;

  const START = 135;
  const SWEEP = 270;

  const polar = (degree: number, r: number) => {
    const rad = (degree * Math.PI) / 180;
    return { x: center + r * Math.cos(rad), y: center + r * Math.sin(rad) };
  };
  const arc = (from: number, to: number) => {
    const a = polar(from, radius);
    const b = polar(to, radius);
    const large = to - from > 180 ? 1 : 0;
    return `M ${a.x.toFixed(2)} ${a.y.toFixed(2)} A ${radius} ${radius} 0 ${large} 1 ${b.x.toFixed(2)} ${b.y.toFixed(2)}`;
  };

  // 分段着色：按负荷率区间给进度弧上色
  const color =
    value > 100 ? '#ff4d4f' : value >= 80 ? '#faad14' : '#52c41a';
  const trackColor = dark ? 'rgba(255, 255, 255, 0.10)' : 'rgba(17, 24, 39, 0.07)';
  const tickColor = dark ? 'rgba(255, 255, 255, 0.26)' : 'rgba(17, 24, 39, 0.22)';
  const mutedColor = dark ? 'rgba(230, 232, 235, 0.62)' : 'rgba(31, 35, 41, 0.62)';

  return (
    <div ref={ref} style={{ display: 'flex', justifyContent: 'center' }}>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={`${label} ${value.toFixed(1)}%`}
      >
        <defs>
          <linearGradient id={gradientId} x1="0%" y1="100%" x2="100%" y2="0%">
            <stop offset="0%" stopColor={color} />
            <stop offset="100%" stopColor={color} />
          </linearGradient>
        </defs>

        <path
          d={arc(START, START + SWEEP)}
          fill="none"
          stroke={trackColor}
          strokeWidth={stroke}
          strokeLinecap="round"
        />

        {ratio > 0.004 && (
          <path
            d={arc(START, START + SWEEP * ratio)}
            fill="none"
            stroke={`url(#${gradientId})`}
            strokeWidth={stroke}
            strokeLinecap="round"
          />
        )}

        {[0, 0.25, 0.5, 0.75, 1].map((step) => {
          const degree = START + SWEEP * step;
          const outer = polar(degree, radius + stroke / 2 + 3);
          const inner = polar(degree, radius + stroke / 2 - 3);
          return (
            <line
              key={step}
              x1={inner.x.toFixed(2)}
              y1={inner.y.toFixed(2)}
              x2={outer.x.toFixed(2)}
              y2={outer.y.toFixed(2)}
              stroke={tickColor}
              strokeWidth={1.5}
              strokeLinecap="round"
            />
          );
        })}

        <text
          x={center}
          y={center - size * 0.02}
          textAnchor="middle"
          dominantBaseline="middle"
          fill={color}
          fontSize={size * 0.2}
          fontWeight={700}
        >
          {value.toFixed(1)}
          <tspan fontSize={size * 0.1} dx={2} fill={mutedColor}>
            %
          </tspan>
        </text>
        <text
          x={center}
          y={center + size * 0.17}
          textAnchor="middle"
          dominantBaseline="middle"
          fill={mutedColor}
          fontSize={size * 0.072}
        >
          {label.length > 16 ? `${label.slice(0, 15)}…` : label}
        </text>
        <text
          x={center}
          y={center + size * 0.3}
          textAnchor="middle"
          dominantBaseline="middle"
          fill={mutedColor}
          fontSize={size * 0.062}
        >
          {value > 100 ? t('mrp.productionAnalytics.overload') : t('mrp.productionAnalytics.colLoadRate')}
        </text>
      </svg>
    </div>
  );
}

export function ProductionAnalytics() {
  const { t } = useTranslation();
  const { baseCurrency } = useCurrencyRegistry();
  const baseCurrencyCode = (baseCurrency || 'CNY').toUpperCase();
  const [factory3DOpen, setFactory3DOpen] = useState(false);

  // ---------------------------------------------------------------- 生产进度
  const [progressRows, setProgressRows] = useState<ProgressRow[]>([]);
  const [progressLoading, setProgressLoading] = useState(false);
  const [progressStatus, setProgressStatus] = useState<string | null>(null);
  const [progressKeyword, setProgressKeyword] = useState('');

  const fetchProgress = useCallback(async () => {
    setProgressLoading(true);
    try {
      let q = supabase
        .from('vw_erp_production_progress' as any)
        .select('*')
        .order('order_date', { ascending: false })
        .order('order_id', { ascending: false })
        .limit(RESULT_LIMIT);
      if (progressStatus) q = q.eq('status', progressStatus);
      const kw = progressKeyword.trim();
      if (kw) q = q.or(`order_no.ilike.%${kw}%,product_code.ilike.%${kw}%,product_name.ilike.%${kw}%`);
      const { data, error } = await q;
      if (error) throw error;
      setProgressRows((data || []) as ProgressRow[]);
    } catch (error) {
      console.error('Error fetching production progress:', error);
      message.error(t('common.fetchFailed'));
    } finally {
      setProgressLoading(false);
    }
  }, [progressStatus, progressKeyword, t]);

  // ---------------------------------------------------------------- 工单成本
  const [costRows, setCostRows] = useState<CostRowView[]>([]);
  const [costLoading, setCostLoading] = useState(false);
  const [costKeyword, setCostKeyword] = useState('');

  const fetchCost = useCallback(async () => {
    setCostLoading(true);
    try {
      let q = supabase
        .from('vw_erp_production_cost' as any)
        .select('*')
        .order('order_date', { ascending: false })
        .order('order_id', { ascending: false })
        .limit(RESULT_LIMIT);
      const kw = costKeyword.trim();
      if (kw) q = q.or(`order_no.ilike.%${kw}%,product_code.ilike.%${kw}%,product_name.ilike.%${kw}%`);
      const { data, error } = await q;
      if (error) throw error;
      setCostRows((data || []) as CostRowView[]);
    } catch (error) {
      console.error('Error fetching production cost:', error);
      message.error(t('common.fetchFailed'));
    } finally {
      setCostLoading(false);
    }
  }, [costKeyword, t]);

  // ---------------------------------------------------------------- 在制报表
  const [wipRows, setWipRows] = useState<WipRow[]>([]);
  const [wipLoading, setWipLoading] = useState(false);
  const [wipKeyword, setWipKeyword] = useState('');

  const fetchWip = useCallback(async () => {
    setWipLoading(true);
    try {
      let q = supabase
        .from('vw_erp_wip_report' as any)
        .select('*')
        .order('period_year', { ascending: false })
        .order('period_month', { ascending: false })
        .order('product_id', { ascending: true })
        .limit(RESULT_LIMIT);
      const kw = wipKeyword.trim();
      if (kw) q = q.or(`product_code.ilike.%${kw}%,product_name.ilike.%${kw}%`);
      const { data, error } = await q;
      if (error) throw error;
      setWipRows((data || []) as WipRow[]);
    } catch (error) {
      console.error('Error fetching wip report:', error);
      message.error(t('common.fetchFailed'));
    } finally {
      setWipLoading(false);
    }
  }, [wipKeyword, t]);

  // ---------------------------------------------------------------- 产能负荷
  const [capacityRows, setCapacityRows] = useState<CapacityRow[]>([]);
  const [capacityLoading, setCapacityLoading] = useState(false);
  const [capacityKeyword, setCapacityKeyword] = useState('');

  const fetchCapacity = useCallback(async () => {
    setCapacityLoading(true);
    try {
      let q = supabase
        .from('vw_erp_capacity_load' as any)
        .select('*')
        .order('month_start', { ascending: false })
        .order('work_center_id', { ascending: true })
        .limit(RESULT_LIMIT);
      const kw = capacityKeyword.trim();
      if (kw) q = q.or(`work_center_code.ilike.%${kw}%,work_center_name.ilike.%${kw}%`);
      const { data, error } = await q;
      if (error) throw error;
      setCapacityRows((data || []) as CapacityRow[]);
    } catch (error) {
      console.error('Error fetching capacity load:', error);
      message.error(t('common.fetchFailed'));
    } finally {
      setCapacityLoading(false);
    }
  }, [capacityKeyword, t]);

  useEffect(() => { fetchProgress(); }, [fetchProgress]);
  useEffect(() => { fetchCost(); }, [fetchCost]);
  useEffect(() => { fetchWip(); }, [fetchWip]);
  useEffect(() => { fetchCapacity(); }, [fetchCapacity]);

  // ---------------------------------------------------------------- 看板 KPI
  const board = useMemo(() => {
    const open = progressRows.filter((r) => !['completed', 'closed', 'cancelled'].includes(r.status));
    const inProgress = open.filter((r) => r.status === 'in_progress' || r.status === 'released');
    const overdue = open.filter((r) => num(r.delay_days) > 0);
    const finishedQty = progressRows.reduce((s, r) => s + num(r.received_quantity), 0);
    const plannedQty = progressRows.reduce((s, r) => s + num(r.planned_quantity), 0);
    const totalCost = costRows.reduce((s, r) => s + num(r.total_cost), 0);
    const endingWip = wipRows.reduce((s, r) => s + num(r.ending_wip), 0);
    const latestMonth = capacityRows.length ? capacityRows[0].month_start : null;
    const monthLoad = capacityRows
      .filter((r) => r.month_start === latestMonth)
      .reduce((s, r) => s + num(r.load_rate), 0);
    const monthCount = capacityRows.filter((r) => r.month_start === latestMonth).length;
    const topOverdue = [...overdue].sort((a, b) => num(b.delay_days) - num(a.delay_days)).slice(0, 8);
    return {
      total: progressRows.length,
      openCount: open.length,
      inProgressCount: inProgress.length,
      overdueCount: overdue.length,
      avgProgress: progressRows.length
        ? progressRows.reduce((s, r) => s + num(r.progress_pct), 0) / progressRows.length
        : 0,
      finishedQty,
      plannedQty,
      totalCost,
      endingWip,
      avgLoadRate: monthCount ? monthLoad / monthCount : 0,
      latestMonth,
      topOverdue,
    };
  }, [progressRows, costRows, wipRows, capacityRows]);

  // ---------------------------------------------------------------- 列定义
  const statusTag = (s: string) => {
    const key = statusKeyOf(s);
    const color =
      s === 'completed' || s === 'closed' ? 'green'
        : s === 'cancelled' ? 'red'
          : s === 'in_progress' ? 'blue'
            : s === 'released' ? 'cyan' : 'default';
    return <Tag color={color}>{key ? t(key) : s}</Tag>;
  };

  const progressColumns = [
    { title: t('mrp.productionAnalytics.colOrderNo'), dataIndex: 'order_no', key: 'order_no', width: 150, fixed: 'left' as const },
    { title: t('mrp.productionAnalytics.colOrderDate'), dataIndex: 'order_date', key: 'order_date', width: 110 },
    {
      title: t('mrp.productionAnalytics.colProduct'), key: 'product', width: 200,
      render: (_: unknown, r: ProgressRow) => [r.product_code, r.product_name].filter(Boolean).join(' / ') || '-',
    },
    { title: t('mrp.productionAnalytics.colPlanned'), dataIndex: 'planned_quantity', key: 'planned_quantity', width: 100, render: qty, align: 'right' as const },
    { title: t('mrp.productionAnalytics.colReceived'), dataIndex: 'received_quantity', key: 'received_quantity', width: 100, render: qty, align: 'right' as const },
    { title: t('mrp.productionAnalytics.colRemaining'), dataIndex: 'remaining_quantity', key: 'remaining_quantity', width: 100, render: qty, align: 'right' as const },
    {
      title: t('mrp.productionAnalytics.colProgress'), dataIndex: 'progress_pct', key: 'progress_pct', width: 160,
      render: (v: number) => <Progress percent={Number(num(v).toFixed(1))} size="small" />,
    },
    { title: t('mrp.productionAnalytics.colScrapRate'), dataIndex: 'scrap_rate', key: 'scrap_rate', width: 100, render: (v: number) => `${num(v).toFixed(2)}%`, align: 'right' as const },
    { title: t('mrp.productionAnalytics.colPlannedEnd'), dataIndex: 'planned_end_date', key: 'planned_end_date', width: 120 },
    {
      title: t('mrp.productionAnalytics.colDelay'), dataIndex: 'delay_days', key: 'delay_days', width: 100,
      render: (v: number) => (num(v) > 0 ? <Tag color="red">{num(v)} {t('mrp.productionAnalytics.days')}</Tag> : <Tag color="green">{t('mrp.productionAnalytics.onTime')}</Tag>),
    },
    { title: t('mrp.productionAnalytics.colWorkCenter'), dataIndex: 'work_center_name', key: 'work_center_name', width: 140 },
    { title: t('common.status'), dataIndex: 'status', key: 'status', width: 110, render: statusTag },
  ];

  const costColumns = [
    { title: t('mrp.productionAnalytics.colOrderNo'), dataIndex: 'order_no', key: 'order_no', width: 150, fixed: 'left' as const },
    { title: t('mrp.productionAnalytics.colOrderDate'), dataIndex: 'order_date', key: 'order_date', width: 110 },
    {
      title: t('mrp.productionAnalytics.colProduct'), key: 'product', width: 200,
      render: (_: unknown, r: CostRowView) => [r.product_code, r.product_name].filter(Boolean).join(' / ') || '-',
    },
    { title: t('mrp.productionAnalytics.colMaterial'), dataIndex: 'material_cost', key: 'material_cost', width: 130, render: (v: number) => `${baseCurrencyCode} ${num(v).toFixed(2)}`, align: 'right' as const },
    { title: t('mrp.productionAnalytics.colLabor'), dataIndex: 'labor_cost', key: 'labor_cost', width: 130, render: (v: number) => `${baseCurrencyCode} ${num(v).toFixed(2)}`, align: 'right' as const },
    { title: t('mrp.productionAnalytics.colOverhead'), dataIndex: 'overhead_cost', key: 'overhead_cost', width: 130, render: (v: number) => `${baseCurrencyCode} ${num(v).toFixed(2)}`, align: 'right' as const },
    { title: t('mrp.productionAnalytics.colTotal'), dataIndex: 'total_cost', key: 'total_cost', width: 130, render: (v: number) => `${baseCurrencyCode} ${num(v).toFixed(2)}`, align: 'right' as const },
    { title: t('mrp.productionAnalytics.colReceived'), dataIndex: 'received_quantity', key: 'received_quantity', width: 100, render: qty, align: 'right' as const },
    { title: t('mrp.productionAnalytics.colUnitCost'), dataIndex: 'unit_cost', key: 'unit_cost', width: 130, render: (v: number) => `${baseCurrencyCode} ${num(v).toFixed(4)}`, align: 'right' as const },
    { title: t('common.status'), dataIndex: 'status', key: 'status', width: 110, render: statusTag },
  ];

  const wipColumns = [
    {
      title: t('mrp.productionAnalytics.colPeriod'), key: 'period', width: 110,
      render: (_: unknown, r: WipRow) => `${r.period_year}-${String(r.period_month).padStart(2, '0')}`,
    },
    { title: t('mrp.productionAnalytics.colProduct'), key: 'product', width: 200, render: (_: unknown, r: WipRow) => [r.product_code, r.product_name].filter(Boolean).join(' / ') || '-' },
    { title: t('mrp.productionAnalytics.colBeginningWip'), dataIndex: 'beginning_wip', key: 'beginning_wip', width: 130, render: (v: number) => `${baseCurrencyCode} ${num(v).toFixed(2)}`, align: 'right' as const },
    { title: t('mrp.productionAnalytics.colMaterial'), dataIndex: 'current_material', key: 'current_material', width: 130, render: (v: number) => `${baseCurrencyCode} ${num(v).toFixed(2)}`, align: 'right' as const },
    { title: t('mrp.productionAnalytics.colLabor'), dataIndex: 'current_labor', key: 'current_labor', width: 130, render: (v: number) => `${baseCurrencyCode} ${num(v).toFixed(2)}`, align: 'right' as const },
    { title: t('mrp.productionAnalytics.colOverhead'), dataIndex: 'current_overhead', key: 'current_overhead', width: 130, render: (v: number) => `${baseCurrencyCode} ${num(v).toFixed(2)}`, align: 'right' as const },
    { title: t('mrp.productionAnalytics.colFinished'), dataIndex: 'finished_quantity', key: 'finished_quantity', width: 100, render: qty, align: 'right' as const },
    { title: t('mrp.productionAnalytics.colUnitCost'), dataIndex: 'unit_cost', key: 'unit_cost', width: 130, render: (v: number) => `${baseCurrencyCode} ${num(v).toFixed(4)}`, align: 'right' as const },
    {
      title: t('mrp.productionAnalytics.colEndingWip'), dataIndex: 'ending_wip', key: 'ending_wip', width: 130,
      render: (v: number) => <span style={{ color: num(v) > 0 ? '#cf1322' : undefined }}>{`${baseCurrencyCode} ${num(v).toFixed(2)}`}</span>,
      align: 'right' as const,
    },
  ];

  const capacityColumns = [
    { title: t('mrp.productionAnalytics.colMonth'), key: 'month', width: 110, render: (_: unknown, r: CapacityRow) => String(r.month_start).slice(0, 7) },
    {
      title: t('mrp.productionAnalytics.colWorkCenter'), key: 'work_center', width: 200,
      render: (_: unknown, r: CapacityRow) => [r.work_center_code, r.work_center_name].filter(Boolean).join(' / ') || '-',
    },
    { title: t('mrp.productionAnalytics.colCapacityHours'), dataIndex: 'capacity_hours', key: 'capacity_hours', width: 130, render: (v: number) => num(v).toFixed(2), align: 'right' as const },
    {
      // deploy_119：月产能改了口径（工作日 + 班次），把依据摊开，免得看着数字变化无从解释
      title: t('mrp.productionAnalytics.colCapacityBasis'), key: 'capacity_basis', width: 210,
      render: (_: unknown, r: CapacityRow) => (
        <Space size={4} wrap>
          <Tag color="default">{t('mrp.productionAnalytics.capacityWorkDays', { days: num(r.work_day_count) })}</Tag>
          <Tag color={r.capacity_source === 'shift' ? 'blue' : 'default'}>
            {r.capacity_source === 'shift'
              ? t('mrp.productionAnalytics.capacityByShift', { name: r.shift_name || r.shift_no || '-', hours: num(r.shift_net_hours) })
              : t('mrp.productionAnalytics.capacityManual')}
          </Tag>
        </Space>
      ),
    },
    { title: t('mrp.productionAnalytics.colLaborHours'), dataIndex: 'labor_hours', key: 'labor_hours', width: 110, render: (v: number) => num(v).toFixed(2), align: 'right' as const },
    { title: t('mrp.productionAnalytics.colMachineHours'), dataIndex: 'machine_hours', key: 'machine_hours', width: 110, render: (v: number) => num(v).toFixed(2), align: 'right' as const },
    { title: t('mrp.productionAnalytics.colLoadHours'), dataIndex: 'load_hours', key: 'load_hours', width: 110, render: (v: number) => num(v).toFixed(2), align: 'right' as const },
    {
      title: t('mrp.productionAnalytics.colLoadRate'), dataIndex: 'load_rate', key: 'load_rate', width: 180,
      render: (v: number) => (
        <Progress percent={Number(num(v).toFixed(1))} size="small" status={num(v) > 100 ? 'exception' : 'normal'} />
      ),
    },
  ];

  const refreshBtn = (fn: () => void) => (
    <Button icon={<ReloadOutlined />} onClick={fn}>{t('common.refresh')}</Button>
  );

  // ---------------------------------------------------------------- 页签
  const boardTab = (
    <>
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={6}><Card><Statistic title={t('mrp.productionAnalytics.kpiTotal')} value={board.total} /></Card></Col>
        <Col span={6}><Card><Statistic title={t('mrp.productionAnalytics.kpiInProgress')} value={board.inProgressCount} /></Card></Col>
        <Col span={6}><Card><Statistic title={t('mrp.productionAnalytics.kpiOpen')} value={board.openCount} /></Card></Col>
        <Col span={6}>
          <Card>
            <Statistic
              title={t('mrp.productionAnalytics.kpiOverdue')}
              value={board.overdueCount}
              valueStyle={{ color: board.overdueCount > 0 ? '#cf1322' : undefined }}
            />
          </Card>
        </Col>
      </Row>
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={6}><Card><Statistic title={t('mrp.productionAnalytics.kpiAvgProgress')} value={num(board.avgProgress).toFixed(1)} suffix="%" /></Card></Col>
        <Col span={6}><Card><Statistic title={t('mrp.productionAnalytics.kpiFinishedQty')} value={board.finishedQty} precision={2} /></Card></Col>
        <Col span={6}><Card><Statistic title={t('mrp.productionAnalytics.kpiTotalCost')} value={board.totalCost} precision={2} prefix={baseCurrencyCode} /></Card></Col>
        <Col span={6}><Card><Statistic title={t('mrp.productionAnalytics.kpiEndingWip')} value={board.endingWip} precision={2} prefix={baseCurrencyCode} /></Card></Col>
      </Row>
      <Row gutter={16}>
        <Col span={12}>
          <Card title={t('mrp.productionAnalytics.boardOverdueTitle')} size="small">
            {board.topOverdue.length === 0 ? (
              <div style={{ color: '#8c8c8c' }}>{t('mrp.productionAnalytics.boardNoOverdue')}</div>
            ) : (
              <OverdueStream items={board.topOverdue} />
            )}
          </Card>
        </Col>
        <Col span={12}>
          <Card title={t('mrp.productionAnalytics.boardCapacityTitle')} size="small">
            {board.latestMonth ? (
              <CapacityGauge
                label={`${String(board.latestMonth).slice(0, 7)} ${t('mrp.productionAnalytics.avgLoadRate')}`}
                loadRate={board.avgLoadRate}
              />
            ) : (
              <div style={{ color: '#8c8c8c' }}>{t('mrp.productionAnalytics.boardNoCapacity')}</div>
            )}
          </Card>
        </Col>
      </Row>
    </>
  );

  const progressTab = (
    <SuperTable
      columns={progressColumns}
      dataSource={progressRows}
      rowKey="order_id"
      loading={progressLoading}
      pagination={{ pageSize: 10 }}
      storageKey="mrp-production-analytics-progress"
      toolbarActions={['export']}
      queryBar={
        <Space wrap>
          <Select allowClear placeholder={t('mrp.productionAnalytics.allStatus')} value={progressStatus} onChange={setProgressStatus} style={{ width: 160 }}>
            {STATUS_KEYS.map((s) => <Option key={s} value={s}>{statusKeyOf(s) ? t(statusKeyOf(s)) : s}</Option>)}
          </Select>
          <Input.Search
            allowClear
            placeholder={t('mrp.productionAnalytics.progressSearchPlaceholder')}
            value={progressKeyword}
            onChange={(e) => setProgressKeyword(e.target.value)}
            onSearch={fetchProgress}
            style={{ width: 260 }}
          />
          {refreshBtn(fetchProgress)}
        </Space>
      }
    />
  );

  const costTab = (
    <SuperTable
      columns={costColumns}
      dataSource={costRows}
      rowKey="order_id"
      loading={costLoading}
      pagination={{ pageSize: 10 }}
      storageKey="mrp-production-analytics-cost"
      toolbarActions={['export']}
      queryBar={
        <Space wrap>
          <Input.Search
            allowClear
            placeholder={t('mrp.productionAnalytics.costSearchPlaceholder')}
            value={costKeyword}
            onChange={(e) => setCostKeyword(e.target.value)}
            onSearch={fetchCost}
            style={{ width: 260 }}
          />
          {refreshBtn(fetchCost)}
        </Space>
      }
    />
  );

  const wipTab = (
    <>
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={8}><Card><Statistic title={t('mrp.productionAnalytics.kpiEndingWip')} value={wipRows.reduce((s, r) => s + num(r.ending_wip), 0)} precision={2} prefix={baseCurrencyCode} /></Card></Col>
        <Col span={8}><Card><Statistic title={t('mrp.productionAnalytics.colFinished')} value={wipRows.reduce((s, r) => s + num(r.finished_quantity), 0)} precision={2} /></Card></Col>
        <Col span={8}><Card><Statistic title={t('mrp.productionAnalytics.kpiWipRows')} value={wipRows.length} /></Card></Col>
      </Row>
      <SuperTable
        columns={wipColumns}
        dataSource={wipRows}
        rowKey={(r) => `${r.period_year}-${r.period_month}-${r.product_id}`}
        loading={wipLoading}
        pagination={{ pageSize: 10 }}
        storageKey="mrp-production-analytics-wip"
        toolbarActions={['export']}
        queryBar={
          <Space wrap>
            <Input.Search
              allowClear
              placeholder={t('mrp.productionAnalytics.costSearchPlaceholder')}
              value={wipKeyword}
              onChange={(e) => setWipKeyword(e.target.value)}
              onSearch={fetchWip}
              style={{ width: 260 }}
            />
            {refreshBtn(fetchWip)}
          </Space>
        }
      />
    </>
  );

  const capacityTab = (
    <SuperTable
      columns={capacityColumns}
      dataSource={capacityRows}
      rowKey={(r) => `${r.work_center_id}-${String(r.month_start).slice(0, 7)}`}
      loading={capacityLoading}
      pagination={{ pageSize: 10 }}
      storageKey="mrp-production-analytics-capacity"
      toolbarActions={['export']}
      queryBar={
        <Space wrap>
          <Input.Search
            allowClear
            placeholder={t('mrp.productionAnalytics.capacitySearchPlaceholder')}
            value={capacityKeyword}
            onChange={(e) => setCapacityKeyword(e.target.value)}
            onSearch={fetchCapacity}
            style={{ width: 260 }}
          />
          {refreshBtn(fetchCapacity)}
        </Space>
      }
    />
  );
  return (
    <Card
      variant="borderless"
      title={t('mrp.productionAnalytics.title')}
      extra={
        <Button icon={<AimOutlined />} onClick={() => setFactory3DOpen(true)}>
          {t('mrp.productionAnalytics.factory3d')}
        </Button>
      }
    >
      <Tabs
        items={[
          { key: 'board', label: t('mrp.productionAnalytics.tabBoard'), children: boardTab },
          { key: 'progress', label: t('mrp.productionAnalytics.tabProgress'), children: progressTab },
          { key: 'cost', label: t('mrp.productionAnalytics.tabCost'), children: costTab },
          { key: 'wip', label: t('mrp.productionAnalytics.tabWip'), children: wipTab },
          { key: 'capacity', label: t('mrp.productionAnalytics.tabCapacity'), children: capacityTab },
        ]}
      />
      <Drawer
        title={t('factory3dViewer.title')}
        open={factory3DOpen}
        onClose={() => setFactory3DOpen(false)}
        width="100%"
        styles={{ body: { padding: 0, height: '100%' } }}
        destroyOnClose
      >
        <Factory3DViewer open={factory3DOpen} onClose={() => setFactory3DOpen(false)} />
      </Drawer>
    </Card>
  );
}

export default ProductionAnalytics;
