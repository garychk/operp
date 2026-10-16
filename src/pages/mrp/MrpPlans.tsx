import { useEffect, useState } from 'react';
import type { Key } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Input, Tag, Modal, Form, Select, Space, message, DatePicker, Alert, Table, Card, Col, Row, Statistic } from 'antd';
import { PlusOutlined, DeleteOutlined, PlayCircleOutlined, FileTextOutlined, SwapOutlined, EditOutlined } from '@ant-design/icons';
import { Pie, Line } from '@ant-design/charts';
import { supabase } from '../../utils/supabase';
import { nextDocumentNo } from '../../utils/documentNaming';
import type { Tables } from '../../utils/supabase';
import { SuperTable } from '../../components/SuperTable';
import { formatMoney } from '../../utils/money';
import dayjs from 'dayjs';
import SimpleModal from '../../components/SimpleModal';
import { useAuth } from '../../contexts/AuthContext';
import { resolveMrpApiBaseUrl, aiServerAuthHeaders } from '../../utils/aiServer';
import { useErpDarkMode } from '../../hooks/useErpDarkMode';

type MrpPlan = Tables['erp_mrp_plans_s_539dcf81_b']['Row'];

const { Option } = Select;
const { TextArea } = Input;
const mrpPlanTable = 'erp_mrp_plans_s_539dcf81_b';

/** 转单去向量：采购件 → 采购订单草稿，制造件 → 生产订单 */
type ConversionTarget = 'purchase_order' | 'production_order';

interface ConversionCandidate {
  requirementId: number;
  productId: number;
  productCode: string;
  productName: string;
  quantity: number;
  requirementDate: string;
  orderDate: string;
  target: ConversionTarget;
  bomId: number | null;
  unitPrice: number;
  warnings: string[];
}

interface ConversionItemResult {
  requirementId: number;
  productCode: string;
  productName: string;
  target: ConversionTarget;
  quantity: number;
  ok: boolean;
  documentNo?: string;
  error?: string;
  warnings: string[];
}

interface ConversionPreviewState {
  planId: number;
  planNo: string;
  candidates: ConversionCandidate[];
  skipped: { productCode: string; reason: string; quantity: number }[];
  totalPurchaseAmount: number;
}

interface ConversionResultState {
  planNo: string;
  created: number;
  failed: number;
  items: ConversionItemResult[];
}

interface MrpRunWarning {
  productId: number;
  code: string;
  message: string;
}

/** 引擎 stats（对应 mrpEngine.MrpEngineResult.stats），用于报告弹窗画图 */
interface MrpShortageSummary {
  productId: number;
  code: string;
  name: string;
  firstShortDate: string;
  totalNetRequirement: number;
  plannedOrderCount: number;
  firstPlannedReleaseDate: string | null;
}

interface MrpStats {
  relevantProducts: number;
  plannedProducts: number;
  bucketDays: number;
  productsWithShortage: number;
  totalNetRequirement: number;
  plannedOrders: number;
  shortages: MrpShortageSummary[];
  reorderPointProducts: number;
  reorderTriggers: number;
  workCalendar: string | null;
}

/** 逐日净需求（按物料 × 需求日期，不聚合），来自 erp_mrp_requirements 表，关联产品编码/名称 */
interface DailyNetReq {
  productId: number;
  code: string;
  name: string;
  date: string;
  value: number;
}

interface MrpRunResponse {
  ok: boolean;
  error?: string;
  plan_no?: string;
  report?: string;
  report_generated_by?: 'llm' | 'fallback';
  report_error?: string | null;
  /** 引擎警告（P0-4 起在结果弹窗里展示，此前拿到就被丢掉） */
  warnings?: MrpRunWarning[];
  stats?: MrpStats;
}

/** 报告弹窗的图表层：把引擎 stats 里的汇总数字 + 缺口清单画成图表，降低纯文字阅读负担 */
function ReportCharts({
  stats,
  dailyNetReq,
  t,
}: {
  stats: MrpStats;
  dailyNetReq: DailyNetReq[];
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const isDark = useErpDarkMode();
  const chartTheme = isDark ? 'classicDark' : 'classic';
  const shortages = [...stats.shortages].sort(
    (a, b) => b.totalNetRequirement - a.totalNetRequirement,
  );
  const topShortages = shortages.slice(0, 10);

  const topData = topShortages.map((s) => ({
    name: s.code ? `${s.code} ${s.name}` : s.name || `#${s.productId}`,
    value: s.totalNetRequirement,
  }));

  // 逐日净需求（来自 erp_mrp_requirements 表，按物料分序列），折线图数据源
  const dateData = [...dailyNetReq]
    .sort((a, b) => (a.date < b.date ? -1 : a.name < b.name ? -1 : 1))
    .map((r) => ({
      series: r.code ? `${r.code} ${r.name}` : r.name,
      date: r.date,
      value: r.value,
    }));

  const summaryItems = [
    { label: t('mrp.plans.reportStatsRelevant'), value: stats.relevantProducts },
    { label: t('mrp.plans.reportStatsPlanned'), value: stats.plannedProducts },
    { label: t('mrp.plans.reportStatsShortage'), value: stats.productsWithShortage },
    { label: t('mrp.plans.reportStatsOrders'), value: stats.plannedOrders },
    {
      label: t('mrp.plans.reportStatsNet'),
      value: stats.totalNetRequirement,
    },
  ];

  const topColumns = [
    { title: t('mrp.plans.reportColMaterial'), dataIndex: 'name', key: 'name', ellipsis: true },
    { title: t('mrp.plans.reportColNetReq'), dataIndex: 'value', key: 'value', align: 'right' as const },
  ];

  const dateColumns = [
    { title: t('mrp.plans.reportColMaterial'), dataIndex: 'series', key: 'series', ellipsis: true },
    { title: t('mrp.plans.reportColDate'), dataIndex: 'date', key: 'date' },
    { title: t('mrp.plans.reportColNetReq'), dataIndex: 'value', key: 'value', align: 'right' as const },
  ];

  return (
    <div style={{ marginBottom: 16 }}>
      <Card
        size="small"
        title={t('mrp.plans.reportStatsTitle')}
        style={{ marginBottom: 12 }}
      >
        <Row gutter={[12, 12]}>
          {summaryItems.map((item) => (
            <Col key={item.label} span={8} xs={12} sm={8}>
              <Statistic title={item.label} value={item.value} />
            </Col>
          ))}
        </Row>
      </Card>

      {topShortages.length > 0 ? (
        <Card
          size="small"
          title={t('mrp.plans.reportShortageChart')}
          style={{ marginBottom: 12 }}
        >
          <Row gutter={[12, 12]} align="middle">
            <Col xs={24} lg={8}>
              <Pie
                data={topData}
                angleField="value"
                colorField="name"
                innerRadius={0.5}
                height={280}
                theme={chartTheme}
                label={{ text: 'value', style: { fontSize: 11 } }}
                legend={{ color: { position: 'bottom' } }}
              />
            </Col>
            <Col xs={24} lg={16}>
              <Table
                size="small"
                rowKey="name"
                columns={topColumns}
                dataSource={topData}
                pagination={false}
              />
            </Col>
          </Row>
        </Card>
      ) : (
        <Alert
          type="success"
          showIcon
          style={{ marginBottom: 12 }}
          message={t('mrp.plans.reportShortageEmpty')}
        />
      )}

      {dateData.length > 0 && (
        <Card size="small" title={t('mrp.plans.reportShortageDateChart')}>
          <Row gutter={[0, 12]}>
            <Col span={24}>
              <Line
                data={dateData}
                xField="date"
                yField="value"
                colorField="series"
                height={220}
                theme={chartTheme}
                style={{ lineWidth: 2, shape: 'smooth' }}
                point={{ style: { r: 3 } }}
                axis={{ x: { title: false }, y: { title: false } }}
                legend={{ color: { position: 'bottom' } }}
              />
            </Col>
            <Col span={24}>
              <Table
                size="small"
                rowKey={(r) => `${r.series}__${r.date}`}
                columns={dateColumns}
                dataSource={dateData}
                pagination={false}
                scroll={{ y: 300 }}
              />
            </Col>
          </Row>
        </Card>
      )}
    </div>
  );
}

export function MrpPlans() {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const [plans, setPlans] = useState<MrpPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedRowKeys, setSelectedRowKeys] = useState<Key[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingPlan, setEditingPlan] = useState<MrpPlan | null>(null);
  const [runningPlanId, setRunningPlanId] = useState<number | null>(null);
  const [reportView, setReportView] = useState<{
    open: boolean;
    planNo: string;
    report: string;
    generatedBy: 'llm' | 'fallback';
    llmError: string | null;
    warnings: MrpRunWarning[];
    workCalendar: string | null;
    stats: MrpStats | null;
    dailyNetReq: DailyNetReq[];
    /** true = 本次运算的结果弹窗（warning / 日历提示有效）；false = 回看历史报告 */
    fromRun: boolean;
  } | null>(null);
  const [convertPreview, setConvertPreview] = useState<ConversionPreviewState | null>(null);
  const [convertResult, setConvertResult] = useState<ConversionResultState | null>(null);
  const [previewingPlanId, setPreviewingPlanId] = useState<number | null>(null);
  const [converting, setConverting] = useState(false);
  const [form] = Form.useForm();

  useEffect(() => {
    fetchPlans();
  }, []);

  const fetchPlans = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from(mrpPlanTable)
        .select('*')
        .eq('is_deleted', 'n')
        .order('plan_date', { ascending: false });

      if (error) throw error;
      setPlans(data || []);
    } catch (error) {
      console.error('Error fetching plans:', error);
      message.error(t('common.fetchFailed'));
    } finally {
      setLoading(false);
    }
  };

  // 逐日净需求：从 erp_mrp_requirements 取该计划所有「净需求 > 0」的需求行，
  // 按物料 × 需求日期逐条返回（不聚合），关联产品编码/名称，供折线图按物料分序列展示。
  const fetchDailyNetRequirement = async (planId: number): Promise<DailyNetReq[]> => {
    try {
      const { data, error } = await supabase
        .from('erp_mrp_requirements_s_539dcf81_b')
        .select('product_id, requirement_date, net_requirement')
        .eq('plan_id', planId)
        .eq('is_deleted', 'n')
        .gt('net_requirement', 0);
      if (error) throw error;

      // 收集涉及的 product_id，一次查产品编码/名称
      const productIds = Array.from(
        new Set((data ?? []).map((r) => r.product_id).filter((id): id is number => id != null)),
      );
      const prodMap = new Map<number, { code: string; name: string }>();
      if (productIds.length > 0) {
        const { data: prods, error: perr } = await supabase
          .from('erp_products_s_539dcf81_b')
          .select('id, code, name')
          .in('id', productIds)
          .eq('is_deleted', 'n');
        if (perr) throw perr;
        for (const p of prods ?? []) {
          prodMap.set(p.id, { code: p.code ?? '', name: p.name ?? '' });
        }
      }

      const rows: DailyNetReq[] = [];
      for (const row of data ?? []) {
        const date = String(row.requirement_date ?? '').slice(0, 10);
        if (!date) continue;
        const pid = row.product_id;
        const meta = pid != null ? prodMap.get(pid) : undefined;
        rows.push({
          productId: pid ?? 0,
          code: meta?.code ?? '',
          name: meta?.name ?? `#${pid ?? 0}`,
          date,
          value: Number(row.net_requirement) || 0,
        });
      }
      return rows.sort((a, b) => (a.date < b.date ? -1 : 1));
    } catch (error) {
      console.error('Error fetching daily net requirement:', error);
      return [];
    }
  };

  const handleSubmit = async (values: any) => {
    // DatePicker 的 dayjs 值必须转成 YYYY-MM-DD 字符串再写库（否则 UTC 偏移导致日期错位）
    const payload = { ...values };
    for (const key of ['plan_date', 'start_date', 'end_date']) {
      if (payload[key] && typeof payload[key] === 'object' && 'format' in payload[key]) {
        payload[key] = payload[key].format('YYYY-MM-DD');
      }
    }

    try {
      if (editingPlan) {
        const { error } = await supabase
          .from(mrpPlanTable)
          .update(payload)
          .eq('id', editingPlan.id);
        if (error) throw error;
        message.success(t('mrp.plans.editSuccess'));
      } else {
        const { error } = await supabase
          .from(mrpPlanTable)
          .insert([payload]);
        if (error) throw error;
        message.success(t('common.createSuccess'));
      }
      setIsModalOpen(false);
      setEditingPlan(null);
      form.resetFields();
      fetchPlans();
    } catch (error) {
      console.error('Error saving plan:', error);
      message.error(t('common.saveFailed'));
    }
  };

  const handleDelete = async (id: number) => {
    Modal.confirm({
      title: t('common.confirmDelete'),
      content: t('mrp.plans.deleteConfirm'),
      onOk: async () => {
        try {
          const { error } = await supabase
            .from(mrpPlanTable)
            .update({ is_deleted: 'y' })
            .eq('id', id);
          if (error) throw error;
          message.success(t('common.deleteSuccess'));
          fetchPlans();
        } catch (error) {
          console.error('Error deleting plan:', error);
          message.error(t('common.deleteFailed'));
        }
      },
    });
  };

  const handleRunMrp = async (record: MrpPlan) => {
    if (!user?.profile.id || !user?.tenantId) {
      message.error(t('auth.noTenantAssigned'));
      return;
    }
    Modal.confirm({
      title: t('mrp.plans.confirmRun'),
      content: t('mrp.plans.confirmRunContent'),
      onOk: async () => {
        setRunningPlanId(record.id);
        try {
          const response = await fetch(`${resolveMrpApiBaseUrl()}/run`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(await aiServerAuthHeaders()),
            },
            body: JSON.stringify({
              user_id: user.profile.id,
              tenant_id: user.tenantId,
              plan_id: record.id,
            }),
          });
          const data = (await response.json()) as MrpRunResponse;
          if (!response.ok || !data.ok) {
            throw new Error(data.error || `HTTP ${response.status}`);
          }
          message.success(t('mrp.plans.runSuccess'));
          const dailyNetReq = await fetchDailyNetRequirement(record.id);
          setReportView({
            open: true,
            planNo: data.plan_no || record.plan_no,
            report: data.report || '',
            generatedBy: data.report_generated_by === 'llm' ? 'llm' : 'fallback',
            llmError: data.report_error ?? null,
            warnings: data.warnings ?? [],
            workCalendar: data.stats?.workCalendar ?? null,
            stats: data.stats ?? null,
            dailyNetReq,
            fromRun: true,
          });
          fetchPlans();
        } catch (error) {
          console.error('Error running MRP:', error);
          message.error(`${t('mrp.plans.runFailed')}：${(error as Error).message}`);
        } finally {
          setRunningPlanId(null);
        }
      },
    });
  };

  const handleViewReport = async (record: MrpPlan) => {
    if (!user?.profile.id || !user?.tenantId) {
      message.error(t('auth.noTenantAssigned'));
      return;
    }
    try {
      const params = new URLSearchParams({
        user_id: String(user.profile.id),
        tenant_id: String(user.tenantId),
      });
      const response = await fetch(
        `${resolveMrpApiBaseUrl()}/report/${record.id}?${params.toString()}`,
        { headers: await aiServerAuthHeaders() },
      );
      const data = (await response.json()) as {
        ok: boolean;
        error?: string;
        report?: string;
        stats?: MrpStats | null;
      };
      if (!response.ok || !data.ok) {
        throw new Error(data.error || `HTTP ${response.status}`);
      }
      const dailyNetReq = await fetchDailyNetRequirement(record.id);
      setReportView({
        open: true,
        planNo: record.plan_no,
        report: data.report || '',
        generatedBy: 'llm',
        llmError: null,
        // 历史报告：引擎警告不落库，只在运算当次返回，所以这里没有可展示的内容
        warnings: [],
        workCalendar: data.stats?.workCalendar ?? null,
        stats: data.stats ?? null,
        dailyNetReq,
        fromRun: false,
      });
    } catch (error) {
      console.error('Error fetching MRP report:', error);
      message.error(`${t('mrp.plans.reportFetchFailed')}：${(error as Error).message}`);
    }
  };

  // 计划转单：先预览（不写任何单据），确认后再真正建单。
  // 服务端保证：只对 planned_order_receipt > 0 且尚未转单的行建单，重复触发不会重复下单。
  const handlePreviewConvert = async (record: MrpPlan) => {
    if (!user?.profile.id || !user?.tenantId) {
      message.error(t('auth.noTenantAssigned'));
      return;
    }
    try {
      setPreviewingPlanId(record.id);
      const response = await fetch(`${resolveMrpApiBaseUrl()}/convert`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(await aiServerAuthHeaders()),
        },
        body: JSON.stringify({
          user_id: user.profile.id,
          tenant_id: user.tenantId,
          plan_id: record.id,
          mode: 'preview',
          filter: 'all',
        }),
      });
      const data = (await response.json()) as {
        ok: boolean;
        error?: string;
        plan_no?: string;
        summary?: { total: number; purchaseOrders: number; productionOrders: number };
        candidates?: ConversionCandidate[];
        skipped?: { productCode: string; reason: string; quantity: number }[];
      };
      if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);

      const candidates = data.candidates || [];
      if (candidates.length === 0) {
        message.info(t('mrp.plans.convertEmpty'));
        return;
      }
      setConvertPreview({
        planId: record.id,
        planNo: data.plan_no || record.plan_no,
        candidates,
        skipped: data.skipped || [],
        totalPurchaseAmount: candidates
          .filter((c) => c.target === 'purchase_order')
          .reduce((sum, c) => sum + c.quantity * c.unitPrice, 0),
      });
    } catch (error) {
      console.error('Error previewing MRP conversion:', error);
      message.error(`${t('mrp.plans.convertPreviewFailed')}：${(error as Error).message}`);
    } finally {
      setPreviewingPlanId(null);
    }
  };

  const handleApplyConvert = async () => {
    if (!convertPreview || !user?.profile.id || !user?.tenantId) return;
    try {
      setConverting(true);
      const response = await fetch(`${resolveMrpApiBaseUrl()}/convert`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(await aiServerAuthHeaders()),
        },
        body: JSON.stringify({
          user_id: user.profile.id,
          tenant_id: user.tenantId,
          plan_id: convertPreview.planId,
          mode: 'apply',
          filter: 'all',
        }),
      });
      const data = (await response.json()) as {
        ok: boolean;
        error?: string;
        plan_no?: string;
        created?: number;
        failed?: number;
        items?: ConversionItemResult[];
      };
      if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);

      setConvertPreview(null);
      setConvertResult({
        planNo: data.plan_no || convertPreview.planNo,
        created: data.created ?? 0,
        failed: data.failed ?? 0,
        items: data.items || [],
      });
      if ((data.failed ?? 0) > 0) {
        message.warning(
          t('mrp.plans.convertPartial', { created: data.created ?? 0, failed: data.failed ?? 0 }),
        );
      } else {
        message.success(t('mrp.plans.convertSuccess', { count: data.created ?? 0 }));
      }
    } catch (error) {
      console.error('Error converting MRP plan:', error);
      message.error(`${t('mrp.plans.convertFailed')}：${(error as Error).message}`);
    } finally {
      setConverting(false);
    }
  };

  const handleAdd = async () => {    let planNo: string;
    try {
      planNo = await nextDocumentNo('mrp_plan');
    } catch (error) {
      message.error(`${t('common.documentNoFailed')}：${(error as Error).message}`);
      return;
    }
    setEditingPlan(null);
    form.setFieldsValue({
      plan_no: planNo,
      plan_date: dayjs(new Date()),
      start_date: '',
      end_date: '',
      plan_type: 'master',
      remark: '',
      status: 'draft',
    });
    setIsModalOpen(true);
  };

  // 编辑：仅未完成（非 completed）的计划可改，completed 结果已落库、改单会与结果脱节
  const handleEdit = (record: MrpPlan) => {
    setEditingPlan(record);
    form.setFieldsValue({
      plan_no: record.plan_no,
      plan_type: record.plan_type || 'master',
      plan_date: record.plan_date ? dayjs(record.plan_date) : null,
      start_date: record.start_date ? dayjs(record.start_date) : null,
      end_date: record.end_date ? dayjs(record.end_date) : null,
      remark: record.remark ?? '',
      status: record.status || 'draft',
    });
    setIsModalOpen(true);
  };

  // 服务端返回的是机器码（结构性事实），只把已知码翻成文案，未知码原样显示便于排查
  const labelFrom = (prefix: string, code: string) => {
    const key = `${prefix}.${code.split(":")[0]}`;
    return i18n.exists(key) ? t(key) : code;
  };

  const filteredPlans = plans.filter(
    (p) =>
      p.plan_no.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (p.remark && p.remark.toLowerCase().includes(searchTerm.toLowerCase()))
  );

  const typeLabels: Record<string, string> = {
    master: t('mrp.plans.typeMaster'),
    material: t('mrp.plans.typeMaterial'),
    capacity: t('mrp.plans.typeCapacity'),
    procurement: t('mrp.plans.typeProcurement'),
  };

  const statusLabels: Record<string, { text: string; color: string }> = {
    draft: { text: t('mrp.plans.statusDraft'), color: 'default' },
    running: { text: t('mrp.plans.statusRunning'), color: 'processing' },
    completed: { text: t('mrp.plans.statusCompleted'), color: 'success' },
    failed: { text: t('mrp.plans.statusFailed'), color: 'error' },
    cancelled: { text: t('mrp.plans.statusCancelled'), color: 'error' },
  };

  const columns = [
    {
      title: t('mrp.plans.planNo'),
      dataIndex: 'plan_no',
      key: 'plan_no',
    },
    {
      title: t('mrp.plans.planDate'),
      dataIndex: 'plan_date',
      key: 'plan_date',
    },
    {
      title: t('mrp.plans.startDate'),
      dataIndex: 'start_date',
      key: 'start_date',
      render: (text: string) => text || '-',
    },
    {
      title: t('mrp.plans.endDate'),
      dataIndex: 'end_date',
      key: 'end_date',
      render: (text: string) => text || '-',
    },
    {
      title: t('common.type'),
      dataIndex: 'plan_type',
      key: 'plan_type',
      render: (type: string) => typeLabels[type] || type,
    },
    {
      title: t('common.status'),
      dataIndex: 'status',
      key: 'status',
      render: (status: string) => {
        const config = statusLabels[status] || { text: status, color: 'default' };
        return <Tag color={config.color}>{config.text}</Tag>;
      },
    },
    {
      title: t('common.actions'),
      key: 'action',
      render: (_: any, record: MrpPlan) => (
        <Space size="middle">
          {record.status !== 'completed' && (
            <Button type="text" icon={<EditOutlined />} onClick={() => handleEdit(record)}>
              {t('mrp.plans.edit')}
            </Button>
          )}
          {(record.status === 'draft' || record.status === 'failed') && (
            <Button
              type="text"
              icon={<PlayCircleOutlined />}
              loading={runningPlanId === record.id}
              onClick={() => handleRunMrp(record)}
            >
              {t('mrp.plans.run')}
            </Button>
          )}
          {record.analysis_report && (
            <Button
              type="text"
              icon={<FileTextOutlined />}
              onClick={() => handleViewReport(record)}
            >
              {t('mrp.plans.reportButton')}
            </Button>
          )}
          {record.status === 'completed' && (
            <Button
              type="text"
              icon={<SwapOutlined />}
              loading={previewingPlanId === record.id}
              onClick={() => handlePreviewConvert(record)}
            >
              {t('mrp.plans.convert')}
            </Button>
          )}
          <Button type="text" danger icon={<DeleteOutlined />} onClick={() => handleDelete(record.id)}>
            {t('common.delete')}
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <SuperTable
        columns={columns}
        dataSource={filteredPlans}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 10 }}
        storageKey="mrp-plans"
        headerTitle={t('mrp.plans.title')}
        rowSelection={{
          selectedRowKeys,
          onChange: setSelectedRowKeys,
        }}
        queryBar={
          <Space wrap>
            <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>{t('mrp.plans.add')}</Button>
            <Input.Search
              allowClear
              placeholder={t('mrp.plans.searchPlaceholder')}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              onSearch={fetchPlans}
              style={{ width: 240 }}
            />
          </Space>
        }
      />

      <SimpleModal
        title={editingPlan ? t('mrp.plans.editTitle') : t('mrp.plans.addTitle')}
        open={isModalOpen}
        onCancel={() => {
          setIsModalOpen(false);
          setEditingPlan(null);
          form.resetFields();
        }}
        footer={<Space>
              <Button onClick={() => {
                setIsModalOpen(false);
                setEditingPlan(null);
              }}>{t('common.cancel')}</Button>
              <Button type="primary" onClick={() => form.submit()}>
                {t('common.save')}
              </Button>
            </Space>}
      >
        <Form form={form} layout="vertical" onFinish={handleSubmit} style={{ marginTop: 16 }}>
          <Form.Item
            label={t('mrp.plans.planNo')}
            name="plan_no"
            rules={[{ required: true, message: t('mrp.plans.planNoPrompt') }]}
          >
            <Input placeholder={t('mrp.plans.planNoPrompt')} />
          </Form.Item>
          <Form.Item label={t('mrp.plans.planType')} name="plan_type" initialValue="master">
            <Select>
              <Option value="master">{t('mrp.plans.typeMaster')}</Option>
              <Option value="material">{t('mrp.plans.typeMaterial')}</Option>
              <Option value="capacity">{t('mrp.plans.typeCapacity')}</Option>
              <Option value="procurement">{t('mrp.plans.typeProcurement')}</Option>
            </Select>
          </Form.Item>
          <Form.Item label={t('mrp.plans.planDate')} name="plan_date">
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item label={t('mrp.plans.startDate')} name="start_date">
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item label={t('mrp.plans.endDate')} name="end_date">
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item label={t('mrp.plans.remark')} name="remark">
            <TextArea rows={3} placeholder={t('mrp.plans.remarkPrompt')} />
          </Form.Item>
          <Form.Item label={t('common.status')} name="status" initialValue="draft">
            <Select>
              <Option value="draft">{t('mrp.plans.statusDraft')}</Option>
              <Option value="running">{t('mrp.plans.statusRunning')}</Option>
              <Option value="completed">{t('mrp.plans.statusCompleted')}</Option>
            </Select>
          </Form.Item>
        </Form>
      </SimpleModal>

      <Modal
        title={`${t('mrp.plans.reportTitle')} - ${reportView?.planNo ?? ''}`}
        open={reportView?.open ?? false}
        onCancel={() => setReportView(null)}
        footer={[
          <Button key="close" onClick={() => setReportView(null)}>
            {t('common.close')}
          </Button>,
        ]}
        width="70%"
      >
        {reportView?.generatedBy === 'fallback' && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            message={t('mrp.plans.reportFromFallback')}
            description={reportView.llmError || undefined}
          />
        )}
        {/* P0-4：没有启用工作日历会让提前期退回自然日（下达日可能落在周末），必须提示 */}
        {reportView?.fromRun && !reportView.workCalendar && (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message={t('mrp.plans.noWorkCalendar')}
          />
        )}
        {/* 引擎警告：max_qty 未维护上限 / 提前期倒排早于计划期 / 安全库存与订货点并存等 */}
        {reportView && reportView.warnings.length > 0 && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            message={t('mrp.plans.runWarningsTitle', { count: reportView.warnings.length })}
            description={
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {reportView.warnings.map((w, index) => (
                  <li key={`${w.productId}-${index}`}>
                    {w.code ? `[${w.code}] ` : ''}
                    {w.message}
                  </li>
                ))}
              </ul>
            }
          />
        )}
        {/* 图表层：结构化 stats 存在时优先上图，降低纯文字阅读负担 */}
        {reportView?.stats ? (
          <ReportCharts stats={reportView.stats} dailyNetReq={reportView.dailyNetReq} t={t} />
        ) : (
          reportView &&
          reportView.fromRun === false && (
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 12 }}
              message={t('mrp.plans.reportStatsUnavailable')}
            />
          )
        )}
        <div style={{ whiteSpace: 'pre-wrap', maxHeight: '60vh', overflowY: 'auto' }}>
          {reportView?.report || t('mrp.plans.reportEmpty')}
        </div>
      </Modal>

      {/* 转单预览：只列候选，不写任何单据 */}
      <Modal
        title={`${t('mrp.plans.convertTitle')} - ${convertPreview?.planNo ?? ''}`}
        open={!!convertPreview}
        onCancel={() => setConvertPreview(null)}
        width={880}
        footer={[
          <Button key="cancel" onClick={() => setConvertPreview(null)}>
            {t('common.cancel')}
          </Button>,
          <Button key="ok" type="primary" loading={converting} onClick={handleApplyConvert}>
            {t('mrp.plans.convertConfirm', { count: convertPreview?.candidates.length ?? 0 })}
          </Button>,
        ]}
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message={t('mrp.plans.convertPreviewHint')}
          description={
            <span>
              {t('mrp.plans.convertPreviewSummary', {
                purchase: convertPreview?.candidates.filter((c) => c.target === 'purchase_order').length ?? 0,
                production: convertPreview?.candidates.filter((c) => c.target === 'production_order').length ?? 0,
                amount: formatMoney(convertPreview?.totalPurchaseAmount),
              })}
            </span>
          }
        />
        <Table
          size="small"
          rowKey="requirementId"
          pagination={false}
          scroll={{ y: 320 }}
          dataSource={convertPreview?.candidates ?? []}
          columns={[
            {
              title: t('mrp.plans.convertProduct'),
              dataIndex: 'productCode',
              render: (_: unknown, row: ConversionCandidate) =>
                row.productName ? `${row.productCode} - ${row.productName}` : row.productCode,
            },
            {
              title: t('mrp.plans.convertTarget'),
              dataIndex: 'target',
              width: 130,
              render: (target: ConversionTarget) => (
                <Tag color={target === 'purchase_order' ? 'blue' : 'purple'}>
                  {t(`mrp.plans.convertTarget.${target}`)}
                </Tag>
              ),
            },
            {
              title: t('mrp.plans.convertQuantity'),
              dataIndex: 'quantity',
              align: 'right' as const,
              render: (qty: number) => Number(qty).toLocaleString(),
            },
            {
              title: t('mrp.plans.convertRequirementDate'),
              dataIndex: 'requirementDate',
            },
            {
              title: t('mrp.plans.convertUnitPrice'),
              dataIndex: 'unitPrice',
              align: 'right' as const,
              render: (price: number) => formatMoney(price),
            },
            {
              title: t('mrp.plans.convertWarnings'),
              dataIndex: 'warnings',
              render: (warnings: string[]) =>
                warnings.length === 0 ? (
                  '-'
                ) : (
                  <Space wrap size={4}>
                    {warnings.map((code) => (
                      <Tag key={code} color="orange">
                        {labelFrom('mrp.plans.convertWarning', code)}
                      </Tag>
                    ))}
                  </Space>
                ),
            },
          ]}
        />
        {(convertPreview?.skipped.length ?? 0) > 0 && (
          <Alert
            type="warning"
            showIcon
            style={{ marginTop: 12 }}
            message={t('mrp.plans.convertSkipped', { count: convertPreview?.skipped.length ?? 0 })}
            description={
              <Space wrap size={4}>
                {convertPreview?.skipped.map((s, idx) => (
                  <Tag key={`${s.productCode}-${idx}`}>
                    {s.productCode || '-'}：{labelFrom('mrp.plans.convertReason', s.reason)}
                  </Tag>
                ))}
              </Space>
            }
          />
        )}
      </Modal>

      {/* 转单结果：逐条给出生成的单据号或失败原因 */}
      <Modal
        title={`${t('mrp.plans.convertResultTitle')} - ${convertResult?.planNo ?? ''}`}
        open={!!convertResult}
        onCancel={() => setConvertResult(null)}
        width={760}
        footer={[
          <Button key="close" type="primary" onClick={() => setConvertResult(null)}>
            {t('common.close')}
          </Button>,
        ]}
      >
        <Alert
          type={(convertResult?.failed ?? 0) > 0 ? 'warning' : 'success'}
          showIcon
          style={{ marginBottom: 12 }}
          message={t('mrp.plans.convertResultSummary', {
            created: convertResult?.created ?? 0,
            failed: convertResult?.failed ?? 0,
          })}
        />
        <Table
          size="small"
          rowKey="requirementId"
          pagination={false}
          scroll={{ y: 320 }}
          dataSource={convertResult?.items ?? []}
          columns={[
            {
              title: t('mrp.plans.convertProduct'),
              dataIndex: 'productCode',
            },
            {
              title: t('mrp.plans.convertTarget'),
              dataIndex: 'target',
              width: 120,
              render: (target: ConversionTarget) => t(`mrp.plans.convertTarget.${target}`),
            },
            {
              title: t('mrp.plans.convertDocumentNo'),
              dataIndex: 'documentNo',
              render: (no: string | undefined, row: ConversionItemResult) =>
                row.ok ? no || '-' : <span style={{ color: '#cf1322' }}>{row.error || '-'}</span>,
            },
          ]}
        />
      </Modal>
    </div>
  );
}
