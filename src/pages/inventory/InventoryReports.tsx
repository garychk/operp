import { useCallback, useEffect, useState } from 'react';
import { Button, Input, Tabs, Select, Space, Tag, Card, Statistic, Row, Col, DatePicker, message } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import type { Dayjs } from 'dayjs';
import dayjs from 'dayjs';
import { supabase } from '../../utils/supabase';
import type { Tables } from '../../utils/supabase';
import { SuperTable } from '../../components/SuperTable';
import { formatMoney, useCurrencyRegistry } from '../../utils/money';

/**
 * 库存报表（P1-6）。
 *
 * 三个页签全部读 deploy_96 建的 `security_invoker` 视图 —— 关联（物料/仓库/库位名称）、
 * 汇总（收发存期初期末）、滚动余额、库龄分桶**都在数据库里算**，前端只负责筛选与展示。
 * 这是对 `Inventory.tsx` 原「拉四张全表再 JS 关联」做法的正向对照实现。
 *
 * 口径提醒（详见 deploy_96 文件头，别当成 bug）：
 *   · 收发存汇总只输出**有流水发生**的月份，中间空月不补零行；
 *   · 明细账的 running_qty/running_amount 按「物料×仓库×库位×批次×状态」滚动；
 *   · 库龄是「该账页最早入库流水日」的估算，不是 FIFO 分层，对呆滞识别保守偏高。
 */

type Warehouse = Tables['erp_warehouses_s_539dcf81_b']['Row'];

type SummaryRow = {
  tenant_id: number;
  period_start: string;
  period_year: number;
  period_month: number;
  product_id: number;
  product_code: string | null;
  product_name: string | null;
  unit: string | null;
  warehouse_id: number | null;
  warehouse_name: string | null;
  opening_qty: number;
  opening_amount: number;
  in_qty: number;
  in_amount: number;
  out_qty: number;
  out_amount: number;
  closing_qty: number;
  closing_amount: number;
  txn_count: number;
};

type LedgerRow = {
  transaction_id: number;
  transaction_no: string | null;
  transaction_date: string;
  product_id: number;
  product_code: string | null;
  product_name: string | null;
  unit: string | null;
  warehouse_id: number | null;
  warehouse_name: string | null;
  location_id: number | null;
  location_code: string | null;
  batch_no: string | null;
  stock_status: string | null;
  transaction_type: string | null;
  transaction_type_name: string | null;
  direction: string | null;
  reference_type: string | null;
  reference_id: number | null;
  remark: string | null;
  in_qty: number | null;
  out_qty: number | null;
  unit_cost: number | null;
  amount: number | null;
  running_qty: number | null;
  running_amount: number | null;
};

type AgingRow = {
  product_id: number;
  product_code: string | null;
  product_name: string | null;
  unit: string | null;
  warehouse_id: number | null;
  warehouse_name: string | null;
  location_code: string | null;
  batch_no: string | null;
  stock_status: string | null;
  quantity: number;
  available_quantity: number;
  locked_quantity: number;
  unit_cost: number;
  total_cost: number;
  expiry_date: string | null;
  first_in_date: string | null;
  age_days: number;
  age_bucket: string;
  age_bucket_order: number;
};

const { Option } = Select;
const { RangePicker } = DatePicker;

/** 一次性拉取上限：报表是"看趋势"的，超过这个量应该缩小筛选条件而不是硬拉全表。 */
const RESULT_LIMIT = 2000;

const AGE_BUCKETS = ['0-30', '31-60', '61-90', '91-180', '180+'] as const;

const num = (v: number | null | undefined) => Number(v || 0);
const qtyText = (v: number | null | undefined) => num(v).toLocaleString();

export function InventoryReports() {
  const { t } = useTranslation();
  const { baseCurrency } = useCurrencyRegistry();
  const baseCurrencyCode = (baseCurrency || 'CNY').toUpperCase();

  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.from('erp_warehouses_s_539dcf81_b').select('*').eq('is_deleted', 'n');
      setWarehouses(data || []);
    })();
  }, []);

  // ---------------------------------------------------------------- 收发存汇总
  const [summaryRange, setSummaryRange] = useState<[Dayjs, Dayjs] | null>([
    dayjs().subtract(5, 'month').startOf('month'),
    dayjs().endOf('month'),
  ]);
  const [summaryWarehouse, setSummaryWarehouse] = useState<number | null>(null);
  const [summaryKeyword, setSummaryKeyword] = useState('');
  const [summaryRows, setSummaryRows] = useState<SummaryRow[]>([]);
  const [summaryLoading, setSummaryLoading] = useState(false);

  const fetchSummary = useCallback(async () => {
    setSummaryLoading(true);
    try {
      // 服务端过滤：期间 + 仓库 + 物料关键字（编码或名称）
      let q = supabase
        .from('vw_erp_inventory_summary' as any)
        .select('*')
        .order('period_start', { ascending: false })
        .order('product_code', { ascending: true })
        .limit(RESULT_LIMIT);
      if (summaryRange) {
        q = q
          .gte('period_start', summaryRange[0].startOf('month').format('YYYY-MM-DD'))
          .lte('period_start', summaryRange[1].endOf('month').format('YYYY-MM-DD'));
      }
      if (summaryWarehouse) q = q.eq('warehouse_id', summaryWarehouse);
      const kw = summaryKeyword.trim();
      if (kw) q = q.or(`product_code.ilike.%${kw}%,product_name.ilike.%${kw}%`);

      const { data, error } = await q;
      if (error) throw error;
      setSummaryRows((data || []) as SummaryRow[]);
    } catch (error) {
      console.error('Error fetching inventory summary:', error);
      message.error(t('common.fetchFailed'));
    } finally {
      setSummaryLoading(false);
    }
  }, [summaryRange, summaryWarehouse, summaryKeyword, t]);

  // ---------------------------------------------------------------- 库存明细账
  const [ledgerRange, setLedgerRange] = useState<[Dayjs, Dayjs] | null>([
    dayjs().subtract(2, 'month').startOf('month'),
    dayjs().endOf('month'),
  ]);
  const [ledgerWarehouse, setLedgerWarehouse] = useState<number | null>(null);
  const [ledgerKeyword, setLedgerKeyword] = useState('');
  const [ledgerRows, setLedgerRows] = useState<LedgerRow[]>([]);
  const [ledgerLoading, setLedgerLoading] = useState(false);

  const fetchLedger = useCallback(async () => {
    setLedgerLoading(true);
    try {
      let q = supabase
        .from('vw_erp_inventory_ledger' as any)
        .select('*')
        .order('transaction_date', { ascending: false })
        .order('transaction_id', { ascending: false })
        .limit(RESULT_LIMIT);
      if (ledgerRange) {
        q = q
          .gte('transaction_date', ledgerRange[0].startOf('day').format('YYYY-MM-DD'))
          .lte('transaction_date', ledgerRange[1].endOf('day').format('YYYY-MM-DD'));
      }
      if (ledgerWarehouse) q = q.eq('warehouse_id', ledgerWarehouse);
      const kw = ledgerKeyword.trim();
      if (kw) q = q.or(`product_code.ilike.%${kw}%,product_name.ilike.%${kw}%,transaction_no.ilike.%${kw}%`);

      const { data, error } = await q;
      if (error) throw error;
      setLedgerRows((data || []) as LedgerRow[]);
    } catch (error) {
      console.error('Error fetching inventory ledger:', error);
      message.error(t('common.fetchFailed'));
    } finally {
      setLedgerLoading(false);
    }
  }, [ledgerRange, ledgerWarehouse, ledgerKeyword, t]);

  // ---------------------------------------------------------------- 库龄分析
  const [agingBucket, setAgingBucket] = useState<string | null>(null);
  const [agingWarehouse, setAgingWarehouse] = useState<number | null>(null);
  const [agingKeyword, setAgingKeyword] = useState('');
  const [agingRows, setAgingRows] = useState<AgingRow[]>([]);
  const [agingLoading, setAgingLoading] = useState(false);

  const fetchAging = useCallback(async () => {
    setAgingLoading(true);
    try {
      let q = supabase
        .from('vw_erp_inventory_aging' as any)
        .select('*')
        .order('age_days', { ascending: false })
        .limit(RESULT_LIMIT);
      if (agingBucket) q = q.eq('age_bucket', agingBucket);
      if (agingWarehouse) q = q.eq('warehouse_id', agingWarehouse);
      const kw = agingKeyword.trim();
      if (kw) q = q.or(`product_code.ilike.%${kw}%,product_name.ilike.%${kw}%`);

      const { data, error } = await q;
      if (error) throw error;
      setAgingRows((data || []) as AgingRow[]);
    } catch (error) {
      console.error('Error fetching inventory aging:', error);
      message.error(t('common.fetchFailed'));
    } finally {
      setAgingLoading(false);
    }
  }, [agingBucket, agingWarehouse, agingKeyword, t]);

  useEffect(() => { fetchSummary(); }, [fetchSummary]);
  useEffect(() => { fetchLedger(); }, [fetchLedger]);
  useEffect(() => { fetchAging(); }, [fetchAging]);

  // 卡片合计来自服务端聚合后的结果（按当前筛选），不是「当前页」的合计
  const summaryTotals = summaryRows.reduce(
    (acc, r) => ({
      inAmount: acc.inAmount + num(r.in_amount),
      outAmount: acc.outAmount + num(r.out_amount),
      closingAmount: acc.closingAmount + num(r.closing_amount),
    }),
    { inAmount: 0, outAmount: 0, closingAmount: 0 },
  );
  const agingTotals = agingRows.reduce(
    (acc, r) => ({
      quantity: acc.quantity + num(r.quantity),
      amount: acc.amount + num(r.total_cost),
      stale: acc.stale + (num(r.age_days) > 180 ? num(r.total_cost) : 0),
    }),
    { quantity: 0, amount: 0, stale: 0 },
  );

  const summaryColumns = [
    {
      title: t('inventoryReports.period'),
      dataIndex: 'period_start',
      key: 'period_start',
      width: 110,
      render: (_: string, r: SummaryRow) => `${r.period_year}-${String(r.period_month).padStart(2, '0')}`,
    },
    { title: t('inventoryReports.productCode'), dataIndex: 'product_code', key: 'product_code', width: 120 },
    { title: t('inventoryReports.productName'), dataIndex: 'product_name', key: 'product_name' },
    { title: t('inventoryReports.unit'), dataIndex: 'unit', key: 'unit', width: 80 },
    { title: t('inventoryReports.warehouse'), dataIndex: 'warehouse_name', key: 'warehouse_name', width: 120 },
    { title: t('inventoryReports.openingQty'), dataIndex: 'opening_qty', key: 'opening_qty', width: 110, render: qtyText },
    {
      title: t('inventoryReports.openingAmount'),
      dataIndex: 'opening_amount',
      key: 'opening_amount',
      width: 120,
      render: (v: number) => formatMoney(v, baseCurrencyCode),
    },
    { title: t('inventoryReports.inQty'), dataIndex: 'in_qty', key: 'in_qty', width: 100, render: qtyText },
    {
      title: t('inventoryReports.inAmount'),
      dataIndex: 'in_amount',
      key: 'in_amount',
      width: 120,
      render: (v: number) => formatMoney(v, baseCurrencyCode),
    },
    { title: t('inventoryReports.outQty'), dataIndex: 'out_qty', key: 'out_qty', width: 100, render: qtyText },
    {
      title: t('inventoryReports.outAmount'),
      dataIndex: 'out_amount',
      key: 'out_amount',
      width: 120,
      render: (v: number) => formatMoney(v, baseCurrencyCode),
    },
    { title: t('inventoryReports.closingQty'), dataIndex: 'closing_qty', key: 'closing_qty', width: 110, render: qtyText },
    {
      title: t('inventoryReports.closingAmount'),
      dataIndex: 'closing_amount',
      key: 'closing_amount',
      width: 130,
      render: (v: number) => formatMoney(v, baseCurrencyCode),
    },
    { title: t('inventoryReports.txnCount'), dataIndex: 'txn_count', key: 'txn_count', width: 90 },
  ];

  const ledgerColumns = [
    { title: t('inventoryReports.txnDate'), dataIndex: 'transaction_date', key: 'transaction_date', width: 120 },
    { title: t('inventoryReports.txnNo'), dataIndex: 'transaction_no', key: 'transaction_no', width: 140, render: (v: string) => v || '-' },
    {
      title: t('inventoryReports.direction'),
      dataIndex: 'direction',
      key: 'direction',
      width: 80,
      render: (v: string, r: LedgerRow) => (
        <Tag color={v === 'in' ? 'green' : 'red'}>
          {v === 'in' ? t('inventoryReports.directionIn') : t('inventoryReports.directionOut')}
          {r.transaction_type_name ? ` · ${r.transaction_type_name}` : ''}
        </Tag>
      ),
    },
    { title: t('inventoryReports.productCode'), dataIndex: 'product_code', key: 'product_code', width: 120 },
    { title: t('inventoryReports.productName'), dataIndex: 'product_name', key: 'product_name' },
    { title: t('inventoryReports.warehouse'), dataIndex: 'warehouse_name', key: 'warehouse_name', width: 110 },
    { title: t('inventoryReports.bin'), dataIndex: 'location_code', key: 'location_code', width: 100, render: (v: string) => v || '-' },
    { title: t('inventoryReports.batchNo'), dataIndex: 'batch_no', key: 'batch_no', width: 110, render: (v: string) => v || '-' },
    { title: t('inventoryReports.stockStatus'), dataIndex: 'stock_status', key: 'stock_status', width: 100, render: (v: string) => t(`inventoryReports.status.${v || 'available'}`) },
    { title: t('inventoryReports.inQty'), dataIndex: 'in_qty', key: 'in_qty', width: 100, render: qtyText },
    { title: t('inventoryReports.outQty'), dataIndex: 'out_qty', key: 'out_qty', width: 100, render: qtyText },
    {
      title: t('inventoryReports.unitCost'),
      dataIndex: 'unit_cost',
      key: 'unit_cost',
      width: 110,
      render: (v: number) => formatMoney(v, baseCurrencyCode),
    },
    {
      title: t('inventoryReports.amount'),
      dataIndex: 'amount',
      key: 'amount',
      width: 120,
      render: (v: number) => formatMoney(v, baseCurrencyCode),
    },
    {
      title: t('inventoryReports.runningQty'),
      dataIndex: 'running_qty',
      key: 'running_qty',
      width: 110,
      render: (v: number) => <strong>{qtyText(v)}</strong>,
    },
    {
      title: t('inventoryReports.runningAmount'),
      dataIndex: 'running_amount',
      key: 'running_amount',
      width: 130,
      render: (v: number) => <strong>{formatMoney(v, baseCurrencyCode)}</strong>,
    },
    { title: t('inventoryReports.source'), dataIndex: 'reference_type', key: 'reference_type', width: 130, render: (v: string, r: LedgerRow) => (v ? `${v}#${r.reference_id ?? '-'}` : '-') },
  ];

  const agingColumns = [
    { title: t('inventoryReports.productCode'), dataIndex: 'product_code', key: 'product_code', width: 120 },
    { title: t('inventoryReports.productName'), dataIndex: 'product_name', key: 'product_name' },
    { title: t('inventoryReports.warehouse'), dataIndex: 'warehouse_name', key: 'warehouse_name', width: 110 },
    { title: t('inventoryReports.bin'), dataIndex: 'location_code', key: 'location_code', width: 100, render: (v: string) => v || '-' },
    { title: t('inventoryReports.batchNo'), dataIndex: 'batch_no', key: 'batch_no', width: 110, render: (v: string) => v || '-' },
    { title: t('inventoryReports.stockStatus'), dataIndex: 'stock_status', key: 'stock_status', width: 100, render: (v: string) => t(`inventoryReports.status.${v || 'available'}`) },
    { title: t('inventoryReports.quantity'), dataIndex: 'quantity', key: 'quantity', width: 100, render: qtyText },
    { title: t('inventoryReports.availableQuantity'), dataIndex: 'available_quantity', key: 'available_quantity', width: 110, render: qtyText },
    { title: t('inventoryReports.firstInDate'), dataIndex: 'first_in_date', key: 'first_in_date', width: 120, render: (v: string) => v || '-' },
    {
      title: t('inventoryReports.ageDays'),
      dataIndex: 'age_days',
      key: 'age_days',
      width: 100,
      render: (v: number) => {
        const color = v > 180 ? 'red' : v > 90 ? 'orange' : 'default';
        return <Tag color={color}>{v}</Tag>;
      },
    },
    { title: t('inventoryReports.ageBucket'), dataIndex: 'age_bucket', key: 'age_bucket', width: 110 },
    {
      title: t('inventoryReports.totalCost'),
      dataIndex: 'total_cost',
      key: 'total_cost',
      width: 130,
      render: (v: number) => formatMoney(v, baseCurrencyCode),
    },
    { title: t('inventoryReports.expiryDate'), dataIndex: 'expiry_date', key: 'expiry_date', width: 120, render: (v: string) => v || '-' },
  ];

  const warehouseFilter = (
    value: number | null,
    onChange: (v: number | null) => void,
  ) => (
    <Select
      allowClear
      placeholder={t('inventoryReports.allWarehouses')}
      value={value}
      onChange={onChange}
      style={{ width: 180 }}
    >
      {warehouses.map((w) => (
        <Option key={w.id} value={w.id}>
          {w.name}
        </Option>
      ))}
    </Select>
  );

  const summaryTab = (
    <>
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={8}>
          <Card>
            <Statistic title={t('inventoryReports.totalInAmount')} value={summaryTotals.inAmount} prefix={baseCurrencyCode} precision={2} />
          </Card>
        </Col>
        <Col span={8}>
          <Card>
            <Statistic title={t('inventoryReports.totalOutAmount')} value={summaryTotals.outAmount} prefix={baseCurrencyCode} precision={2} />
          </Card>
        </Col>
        <Col span={8}>
          <Card>
            <Statistic title={t('inventoryReports.totalClosingAmount')} value={summaryTotals.closingAmount} prefix={baseCurrencyCode} precision={2} />
          </Card>
        </Col>
      </Row>
      <SuperTable
        columns={summaryColumns}
        dataSource={summaryRows}
        rowKey={(r) => `${r.period_start}-${r.product_id}-${r.warehouse_id ?? 0}`}
        loading={summaryLoading}
        pagination={{ pageSize: 10 }}
        storageKey="inventory-reports-summary"
        toolbarActions={['export']}
        queryBar={
          <Space wrap>
            <RangePicker
              picker="month"
              value={summaryRange}
              onChange={(v) => setSummaryRange(v as [Dayjs, Dayjs] | null)}
              allowClear
            />
            {warehouseFilter(summaryWarehouse, setSummaryWarehouse)}
            <Input.Search
              allowClear
              placeholder={t('inventoryReports.productSearchPlaceholder')}
              value={summaryKeyword}
              onChange={(e) => setSummaryKeyword(e.target.value)}
              onSearch={fetchSummary}
              style={{ width: 240 }}
            />
            <Button icon={<ReloadOutlined />} onClick={fetchSummary}>
              {t('common.refresh')}
            </Button>
          </Space>
        }
      />
    </>
  );

  const ledgerTab = (
    <SuperTable
      columns={ledgerColumns}
      dataSource={ledgerRows}
      rowKey="transaction_id"
      loading={ledgerLoading}
      pagination={{ pageSize: 15 }}
      storageKey="inventory-reports-ledger"
      toolbarActions={['export']}
      queryBar={
        <Space wrap>
          <RangePicker value={ledgerRange} onChange={(v) => setLedgerRange(v as [Dayjs, Dayjs] | null)} allowClear />
          {warehouseFilter(ledgerWarehouse, setLedgerWarehouse)}
          <Input.Search
            allowClear
            placeholder={t('inventoryReports.ledgerSearchPlaceholder')}
            value={ledgerKeyword}
            onChange={(e) => setLedgerKeyword(e.target.value)}
            onSearch={fetchLedger}
            style={{ width: 260 }}
          />
          <Button icon={<ReloadOutlined />} onClick={fetchLedger}>
            {t('common.refresh')}
          </Button>
        </Space>
      }
    />
  );

  const agingTab = (
    <>
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={8}>
          <Card>
            <Statistic title={t('inventoryReports.agingQuantity')} value={agingTotals.quantity} precision={2} />
          </Card>
        </Col>
        <Col span={8}>
          <Card>
            <Statistic title={t('inventoryReports.agingAmount')} value={agingTotals.amount} prefix={baseCurrencyCode} precision={2} />
          </Card>
        </Col>
        <Col span={8}>
          <Card>
            <Statistic title={t('inventoryReports.staleAmount')} value={agingTotals.stale} prefix={baseCurrencyCode} precision={2} />
          </Card>
        </Col>
      </Row>
      <SuperTable
        columns={agingColumns}
        dataSource={agingRows}
        rowKey={(r) => `${r.product_id}-${r.warehouse_id ?? 0}-${r.location_code ?? ''}-${r.batch_no ?? ''}-${r.stock_status}`}
        loading={agingLoading}
        pagination={{ pageSize: 10 }}
        storageKey="inventory-reports-aging"
        toolbarActions={['export']}
        queryBar={
          <Space wrap>
            <Select
              allowClear
              placeholder={t('inventoryReports.allBuckets')}
              value={agingBucket}
              onChange={setAgingBucket}
              style={{ width: 160 }}
            >
              {AGE_BUCKETS.map((b) => (
                <Option key={b} value={b}>
                  {b} {t('inventoryReports.days')}
                </Option>
              ))}
            </Select>
            {warehouseFilter(agingWarehouse, setAgingWarehouse)}
            <Input.Search
              allowClear
              placeholder={t('inventoryReports.productSearchPlaceholder')}
              value={agingKeyword}
              onChange={(e) => setAgingKeyword(e.target.value)}
              onSearch={fetchAging}
              style={{ width: 240 }}
            />
            <Button icon={<ReloadOutlined />} onClick={fetchAging}>
              {t('common.refresh')}
            </Button>
          </Space>
        }
      />
    </>
  );

  return (
    <div>
      <Tabs
        items={[
          { key: 'summary', label: t('inventoryReports.tabSummary'), children: summaryTab },
          { key: 'ledger', label: t('inventoryReports.tabLedger'), children: ledgerTab },
          { key: 'aging', label: t('inventoryReports.tabAging'), children: agingTab },
        ]}
      />
    </div>
  );
}

export default InventoryReports;
