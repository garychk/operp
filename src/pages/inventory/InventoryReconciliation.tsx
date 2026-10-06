import { useCallback, useEffect, useState } from 'react';
import { Button, Card, DatePicker, Input, Select, Space, Statistic, Row, Col, Tag, message } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import type { Dayjs } from 'dayjs';
import dayjs from 'dayjs';
import { supabase } from '../../utils/supabase';
import { SuperTable } from '../../components/SuperTable';
import { formatMoney, useCurrencyRegistry } from '../../utils/money';

/**
 * 存货 vs 总账对账（P1-9b 的界面，视图由 deploy_97 建）。
 *
 * 回答一个问题：**库存动了、账没动** 的地方在哪？
 *
 * 两个页签：
 *   ① 按期间对账（`vw_erp_inventory_gl_recon`）— 按 (期间 × 来源单据类型) 比
 *      "库存侧净额" 与 "总账存货科目录入净额"，给出差额与状态：
 *        matched        对平
 *        diff           不平（真差异，要查）
 *        voucher_skipped 该有凭证但没生成（月结未开/科目缺失等，差额=全部库存净额）
 *        not_required   该业务本就不出凭证（调拨/状态流转/期初）
 *   ② 差异明细（`vw_erp_inventory_gl_recon_detail`）— 逐笔列出
 *      被跳过的凭证（kind=voucher_skipped）与只有总账没有库存流水的孤儿凭证
 *      （kind=orphan_gl），并给出 `still_outstanding` 表示到今天还没清。
 *
 * 关键口径（deploy_87/97，容易踩）：
 *   · 业务单据 ↔ 凭证的反查落在**凭证头** `erp_vouchers.inventory_source_type/id`；
 *     `erp_gl_entries.source_type` 恒为字面量 'voucher'，不是业务类型。
 *   · 凭证是平衡的，逐科目净额天然为 0。所以"挂了多少钱"要用借方发生额
 *     （视图已用 `gl_debit_total` 处理孤儿分支），不要用 net。
 */

type ReconRow = {
  period_start: string;
  period_year: number;
  period_month: number;
  source_type: string;
  source_type_name: string | null;
  stock_subject_code: string | null;
  counter_subject_code: string | null;
  generate_voucher: boolean;
  transaction_types: string | null;
  txn_count: number;
  first_date: string | null;
  last_date: string | null;
  inventory_amount: number;
  gl_stock_amount: number;
  difference: number;
  voucher_count: number;
  exception_count: number;
  skip_reasons: string | null;
  recon_status: string;
};

type ReconDetailRow = {
  kind: string;
  source_type: string;
  source_type_name: string | null;
  source_id: number | null;
  document_no: string | null;
  document_date: string | null;
  reason: string;
  detail: string | null;
  transaction_type: string | null;
  attempts: number | null;
  inventory_amount: number;
  gl_amount: number;
  difference: number;
  voucher_no: string | null;
  still_outstanding: boolean;
  subject_code: string | null;
};

const { Option } = Select;
const { RangePicker } = DatePicker;

const RECON_STATUSES = ['matched', 'diff', 'voucher_skipped', 'not_required'] as const;
const DETAIL_KINDS = ['voucher_skipped', 'orphan_gl'] as const;

const RESULT_LIMIT = 2000;

/** 状态 / 差异类型的 i18n key 映射（避免在 JSX 里拼 key，拼错了不会报错只会显示原文） */
const STATUS_LABEL_KEY: Record<string, string> = {
  matched: 'inventoryReconciliation.statusMatched',
  diff: 'inventoryReconciliation.statusDiff',
  voucher_skipped: 'inventoryReconciliation.statusSkipped',
  not_required: 'inventoryReconciliation.statusNotRequired',
};

const KIND_LABEL_KEY: Record<string, string> = {
  voucher_skipped: 'inventoryReconciliation.kindSkipped',
  orphan_gl: 'inventoryReconciliation.kindOrphanGl',
};

export function InventoryReconciliation() {
  const { t } = useTranslation();
  const { baseCurrency } = useCurrencyRegistry();
  const baseCurrencyCode = (baseCurrency || 'CNY').toUpperCase();

  const [range, setRange] = useState<[Dayjs, Dayjs] | null>([
    dayjs().subtract(5, 'month').startOf('month'),
    dayjs().endOf('month'),
  ]);
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [sourceFilter, setSourceFilter] = useState<string | null>(null);
  const [rows, setRows] = useState<ReconRow[]>([]);
  const [loading, setLoading] = useState(true);

  const [detailKind, setDetailKind] = useState<string | null>(null);
  const [onlyOutstanding, setOnlyOutstanding] = useState(false);
  const [detailKeyword, setDetailKeyword] = useState('');
  const [detailRows, setDetailRows] = useState<ReconDetailRow[]>([]);
  const [detailLoading, setDetailLoading] = useState(true);

  const fetchRecon = useCallback(async () => {
    setLoading(true);
    try {
      let q = supabase
        .from('vw_erp_inventory_gl_recon' as any)
        .select('*')
        .order('period_start', { ascending: false })
        .order('source_type', { ascending: true })
        .limit(RESULT_LIMIT);
      if (range) {
        q = q
          .gte('period_start', range[0].startOf('month').format('YYYY-MM-DD'))
          .lte('period_start', range[1].endOf('month').format('YYYY-MM-DD'));
      }
      if (statusFilter) q = q.eq('recon_status', statusFilter);
      if (sourceFilter) q = q.eq('source_type', sourceFilter);
      const { data, error } = await q;
      if (error) throw error;
      setRows((data || []) as ReconRow[]);
    } catch (error) {
      console.error('Error fetching inventory GL reconciliation:', error);
      message.error(t('common.fetchFailed'));
    } finally {
      setLoading(false);
    }
  }, [range, statusFilter, sourceFilter, t]);

  const fetchDetails = useCallback(async () => {
    setDetailLoading(true);
    try {
      let q = supabase
        .from('vw_erp_inventory_gl_recon_detail' as any)
        .select('*')
        .order('still_outstanding', { ascending: false })
        .order('document_date', { ascending: false })
        .limit(RESULT_LIMIT);
      if (detailKind) q = q.eq('kind', detailKind);
      if (onlyOutstanding) q = q.eq('still_outstanding', true);
      const kw = detailKeyword.trim();
      if (kw) q = q.or(`document_no.ilike.%${kw}%,source_type.ilike.%${kw}%,reason.ilike.%${kw}%`);
      const { data, error } = await q;
      if (error) throw error;
      setDetailRows((data || []) as ReconDetailRow[]);
    } catch (error) {
      console.error('Error fetching inventory GL reconciliation detail:', error);
      message.error(t('common.fetchFailed'));
    } finally {
      setDetailLoading(false);
    }
  }, [detailKind, onlyOutstanding, detailKeyword, t]);

  useEffect(() => { fetchRecon(); }, [fetchRecon]);
  useEffect(() => { fetchDetails(); }, [fetchDetails]);

  const diffRows = rows.filter((r) => r.recon_status === 'diff');
  const skippedRows = rows.filter((r) => r.recon_status === 'voucher_skipped');
  const absDiffTotal = diffRows.reduce((s, r) => s + Math.abs(Number(r.difference || 0)), 0);
  const skippedTotal = skippedRows.reduce((s, r) => s + Math.abs(Number(r.difference || 0)), 0);
  const outstandingRows = detailRows.filter((r) => r.still_outstanding);
  const outstandingTotal = outstandingRows.reduce((s, r) => s + Math.abs(Number(r.difference || 0)), 0);

  const statusTag = (status: string) => {
    const map: Record<string, { color: string; key: string }> = {
      matched: { color: 'success', key: 'statusMatched' },
      diff: { color: 'error', key: 'statusDiff' },
      voucher_skipped: { color: 'warning', key: 'statusSkipped' },
      not_required: { color: 'default', key: 'statusNotRequired' },
    };
    const cfg = map[status] || { color: 'default', key: 'statusNotRequired' };
    return <Tag color={cfg.color}>{t(`inventoryReconciliation.${cfg.key}`)}</Tag>;
  };

  const reconColumns = [
    {
      title: t('inventoryReconciliation.period'),
      dataIndex: 'period_start',
      key: 'period_start',
      width: 110,
      render: (_: string, r: ReconRow) => `${r.period_year}-${String(r.period_month).padStart(2, '0')}`,
    },
    {
      title: t('inventoryReconciliation.sourceType'),
      dataIndex: 'source_type',
      key: 'source_type',
      width: 200,
      render: (v: string, r: ReconRow) => (r.source_type_name ? `${v} · ${r.source_type_name}` : v),
    },
    {
      title: t('inventoryReconciliation.status'),
      dataIndex: 'recon_status',
      key: 'recon_status',
      width: 120,
      render: (v: string) => statusTag(v),
    },
    { title: t('inventoryReconciliation.txnCount'), dataIndex: 'txn_count', key: 'txn_count', width: 80 },
    {
      title: t('inventoryReconciliation.inventoryAmount'),
      dataIndex: 'inventory_amount',
      key: 'inventory_amount',
      width: 130,
      render: (v: number) => formatMoney(v, baseCurrencyCode),
    },
    {
      title: t('inventoryReconciliation.glAmount'),
      dataIndex: 'gl_stock_amount',
      key: 'gl_stock_amount',
      width: 130,
      render: (v: number) => formatMoney(v, baseCurrencyCode),
    },
    {
      title: t('inventoryReconciliation.difference'),
      dataIndex: 'difference',
      key: 'difference',
      width: 130,
      render: (v: number) => (
        <strong style={{ color: Math.abs(Number(v || 0)) < 0.005 ? undefined : '#cf1322' }}>
          {formatMoney(v, baseCurrencyCode)}
        </strong>
      ),
    },
    {
      title: t('inventoryReconciliation.subjects'),
      key: 'subjects',
      width: 170,
      render: (_: unknown, r: ReconRow) =>
        r.stock_subject_code ? `${r.stock_subject_code} → ${r.counter_subject_code ?? '-'}` : '-',
    },
    { title: t('inventoryReconciliation.voucherCount'), dataIndex: 'voucher_count', key: 'voucher_count', width: 100, render: (v: number) => v ?? 0 },
    {
      title: t('inventoryReconciliation.exceptionCount'),
      dataIndex: 'exception_count',
      key: 'exception_count',
      width: 100,
      render: (v: number) => (v > 0 ? <Tag color="warning">{v}</Tag> : 0),
    },
    {
      title: t('inventoryReconciliation.skipReasons'),
      dataIndex: 'skip_reasons',
      key: 'skip_reasons',
      width: 200,
      render: (v: string) => (v ? v : '-'),
    },
  ];

  const detailColumns = [
    {
      title: t('inventoryReconciliation.kind'),
      dataIndex: 'kind',
      key: 'kind',
      width: 150,
      render: (v: string) =>
        v === 'orphan_gl' ? (
          <Tag color="purple">{t('inventoryReconciliation.kindOrphanGl')}</Tag>
        ) : (
          <Tag color="warning">{t('inventoryReconciliation.kindSkipped')}</Tag>
        ),
    },
    { title: t('inventoryReconciliation.sourceType'), dataIndex: 'source_type', key: 'source_type', width: 170 },
    {
      title: t('inventoryReconciliation.documentNo'),
      dataIndex: 'document_no',
      key: 'document_no',
      width: 150,
      render: (v: string, r: ReconDetailRow) => v || (r.source_id != null ? `#${r.source_id}` : '-'),
    },
    { title: t('inventoryReconciliation.documentDate'), dataIndex: 'document_date', key: 'document_date', width: 120, render: (v: string) => v || '-' },
    {
      title: t('inventoryReconciliation.reason'),
      dataIndex: 'reason',
      key: 'reason',
      width: 180,
      render: (v: string) => t(`inventoryVoucher.reason.${v}`, v),
    },
    {
      title: t('inventoryReconciliation.inventoryAmount'),
      dataIndex: 'inventory_amount',
      key: 'inventory_amount',
      width: 130,
      render: (v: number) => formatMoney(v, baseCurrencyCode),
    },
    {
      title: t('inventoryReconciliation.glAmount'),
      dataIndex: 'gl_amount',
      key: 'gl_amount',
      width: 130,
      render: (v: number) => formatMoney(v, baseCurrencyCode),
    },
    {
      title: t('inventoryReconciliation.difference'),
      dataIndex: 'difference',
      key: 'difference',
      width: 130,
      render: (v: number) => <strong style={{ color: '#cf1322' }}>{formatMoney(v, baseCurrencyCode)}</strong>,
    },
    {
      title: t('inventoryReconciliation.stillOutstanding'),
      dataIndex: 'still_outstanding',
      key: 'still_outstanding',
      width: 110,
      render: (v: boolean) =>
        v ? <Tag color="red">{t('inventoryReconciliation.yes')}</Tag> : <Tag color="green">{t('inventoryReconciliation.no')}</Tag>,
    },
    { title: t('inventoryReconciliation.detail'), dataIndex: 'detail', key: 'detail', ellipsis: true, render: (v: string) => v || '-' },
  ];

  return (
    <Card variant="borderless" title={t('inventoryReconciliation.title')}>
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={8}>
          <Card>
            <Statistic title={t('inventoryReconciliation.diffTotal')} value={absDiffTotal} prefix={baseCurrencyCode} precision={2} />
          </Card>
        </Col>
        <Col span={8}>
          <Card>
            <Statistic title={t('inventoryReconciliation.skippedTotal')} value={skippedTotal} prefix={baseCurrencyCode} precision={2} />
          </Card>
        </Col>
        <Col span={8}>
          <Card>
            <Statistic
              title={t('inventoryReconciliation.outstandingCount')}
              value={outstandingRows.length}
              suffix={`/ ${formatMoney(outstandingTotal, baseCurrencyCode)}`}
              valueStyle={outstandingRows.length > 0 ? { color: '#cf1322' } : undefined}
            />
          </Card>
        </Col>
      </Row>

      <SuperTable
        columns={reconColumns}
        dataSource={rows}
        rowKey={(r) => `${r.period_start}-${r.source_type}`}
        loading={loading}
        pagination={{ pageSize: 15 }}
        storageKey="inventory-reconciliation"
        toolbarActions={['export']}
        headerTitle={t('inventoryReconciliation.tabByPeriod')}
        queryBar={
          <Space wrap>
            <RangePicker
              picker="month"
              value={range}
              onChange={(v) => setRange(v as [Dayjs, Dayjs] | null)}
              allowClear
            />
            <Select
              allowClear
              placeholder={t('inventoryReconciliation.allStatuses')}
              value={statusFilter}
              onChange={setStatusFilter}
              style={{ width: 160 }}
            >
              {RECON_STATUSES.map((s) => (
                <Option key={s} value={s}>
                  {t(STATUS_LABEL_KEY[s])}
                </Option>
              ))}
            </Select>
            <Input
              allowClear
              placeholder={t('inventoryReconciliation.sourceTypeFilter')}
              value={sourceFilter ?? ''}
              onChange={(e) => setSourceFilter(e.target.value || null)}
              style={{ width: 200 }}
            />
            <Button icon={<ReloadOutlined />} onClick={fetchRecon}>
              {t('common.refresh')}
            </Button>
          </Space>
        }
      />

      <div style={{ height: 32 }} />

      <SuperTable
        columns={detailColumns}
        dataSource={detailRows}
        rowKey={(r) => `${r.kind}-${r.source_type}-${r.source_id ?? 0}-${r.reason}`}
        loading={detailLoading}
        pagination={{ pageSize: 15 }}
        storageKey="inventory-reconciliation-detail"
        toolbarActions={['export']}
        headerTitle={t('inventoryReconciliation.tabDetail')}
        queryBar={
          <Space wrap>
            <Select
              allowClear
              placeholder={t('inventoryReconciliation.allKinds')}
              value={detailKind}
              onChange={setDetailKind}
              style={{ width: 180 }}
            >
              {DETAIL_KINDS.map((k) => (
                <Option key={k} value={k}>
                  {t(KIND_LABEL_KEY[k])}
                </Option>
              ))}
            </Select>
            <Select
              allowClear
              placeholder={t('inventoryReconciliation.outstandingFilter')}
              value={onlyOutstanding ? 'open' : null}
              onChange={(v) => setOnlyOutstanding(v === 'open')}
              style={{ width: 170 }}
            >
              <Option value="open">{t('inventoryReconciliation.onlyOutstanding')}</Option>
            </Select>
            <Input.Search
              allowClear
              placeholder={t('inventoryReconciliation.detailSearchPlaceholder')}
              value={detailKeyword}
              onChange={(e) => setDetailKeyword(e.target.value)}
              onSearch={fetchDetails}
              style={{ width: 240 }}
            />
            <Button icon={<ReloadOutlined />} onClick={fetchDetails}>
              {t('common.refresh')}
            </Button>
          </Space>
        }
      />
    </Card>
  );
}

export default InventoryReconciliation;
