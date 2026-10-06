import { useCallback, useEffect, useState } from 'react';
import { Button, Input, Tag, Select, Card, message, Row, Col, Statistic, Space, Switch } from 'antd';
import { SearchOutlined, ReloadOutlined } from '@ant-design/icons';
import { supabase } from '../../utils/supabase';
import type { Tables } from '../../utils/supabase';
import { useTranslation } from 'react-i18next';
import { SuperTable } from '../../components/SuperTable';
import { formatMoney, useCurrencyRegistry } from '../../utils/money';

/**
 * 库存查询（P1-6 改造：全表 JS 关联 → 服务端聚合）。
 *
 * 改造前：把 `erp_inventory` / `erp_products` / `erp_warehouses` / `erp_bins`
 * **四张表全量**拉到浏览器，再用 `Array.find` 做关联；三张统计卡片是拿**已加载行**
 * 求和的，与分页/筛选口径不一致。
 *
 * 改造后（deploy_99 的 security_invoker 视图）：
 *   · 明细读 `vw_erp_inventory_stock_list` —— 名称关联、`is_low_stock` 判定在库里算；
 *     搜索/仓库/状态/呆滞过滤全部走服务端 `.or/.eq`，只回传命中的行。
 *   · 卡片读 `vw_erp_inventory_stock_totals` —— 按仓库聚合后只有几行，前端相加即全局合计，
 *     与当前页无关，所以翻页不会让合计跳变。
 *
 * 注：物料/仓库/库位主数据不再需要全量拉取，只保留仓库（下拉筛选项）。
 */

type Warehouse = Tables['erp_warehouses_s_539dcf81_b']['Row'];

type StockRow = {
  id: number;
  product_id: number;
  product_code: string | null;
  product_name: string | null;
  specification: string | null;
  unit: string | null;
  safety_stock: number | null;
  warehouse_id: number | null;
  warehouse_name: string | null;
  location_id: number | null;
  bin_code: string | null;
  bin_name: string | null;
  batch_no: string | null;
  expiry_date: string | null;
  stock_status: string;
  quantity: number;
  available_quantity: number | null;
  locked_quantity: number | null;
  unit_cost: number;
  total_cost: number;
  is_low_stock: boolean;
};

type StockTotalsRow = {
  warehouse_id: number | null;
  warehouse_name: string | null;
  row_count: number;
  product_count: number;
  on_hand_quantity: number;
  available_quantity: number;
  locked_quantity: number;
  inspection_quantity: number;
  hold_quantity: number;
  rejected_quantity: number;
  total_cost: number;
  low_stock_count: number;
};

const { Option } = Select;

const STOCK_STATUSES = ['available', 'inspection', 'hold', 'rejected'] as const;

/** 明细一次性回传上限。超了应提示用户收紧筛选条件，而不是静默截断。 */
const RESULT_LIMIT = 3000;

const num = (v: number | null | undefined) => Number(v || 0);

const emptyTotals: StockTotalsRow = {
  warehouse_id: null,
  warehouse_name: null,
  row_count: 0,
  product_count: 0,
  on_hand_quantity: 0,
  available_quantity: 0,
  locked_quantity: 0,
  inspection_quantity: 0,
  hold_quantity: 0,
  rejected_quantity: 0,
  total_cost: 0,
  low_stock_count: 0,
};

export function Inventory() {
  const { t } = useTranslation();
  const { baseCurrency } = useCurrencyRegistry();
  const baseCurrencyCode = (baseCurrency || 'CNY').toUpperCase();

  const [rows, setRows] = useState<StockRow[]>([]);
  const [totals, setTotals] = useState<StockTotalsRow>(emptyTotals);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedWarehouse, setSelectedWarehouse] = useState<number | null>(null);
  const [selectedStatus, setSelectedStatus] = useState<string | null>(null);
  const [onlyLowStock, setOnlyLowStock] = useState(false);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.from('erp_warehouses_s_539dcf81_b').select('*').eq('is_deleted', 'n');
      setWarehouses(data || []);
    })();
  }, []);

  // 明细：服务端筛选，名称与 is_low_stock 由视图给出
  const fetchStock = useCallback(async () => {
    setLoading(true);
    try {
      let q = supabase
        .from('vw_erp_inventory_stock_list' as any)
        .select('*')
        .order('product_code', { ascending: true })
        .order('warehouse_id', { ascending: true })
        .limit(RESULT_LIMIT);

      if (selectedWarehouse) q = q.eq('warehouse_id', selectedWarehouse);
      if (selectedStatus) q = q.eq('stock_status', selectedStatus);
      if (onlyLowStock) q = q.eq('is_low_stock', true);
      const kw = searchTerm.trim();
      if (kw) q = q.or(`product_code.ilike.%${kw}%,product_name.ilike.%${kw}%,batch_no.ilike.%${kw}%`);

      const { data, error } = await q;
      if (error) throw error;
      setRows((data || []) as StockRow[]);
    } catch (error) {
      console.error('Error fetching inventory:', error);
      message.error(t('common.fetchFailed'));
    } finally {
      setLoading(false);
    }
  }, [selectedWarehouse, selectedStatus, onlyLowStock, searchTerm, t]);

  // 卡片：服务端聚合（按仓库分组，几行而已），与明细行数、分页都无关
  const fetchTotals = useCallback(async () => {
    try {
      let q = supabase.from('vw_erp_inventory_stock_totals' as any).select('*');
      if (selectedWarehouse) q = q.eq('warehouse_id', selectedWarehouse);
      const { data, error } = await q;
      if (error) throw error;
      const merged = ((data || []) as StockTotalsRow[]).reduce<StockTotalsRow>(
        (acc, r) => ({
          ...acc,
          row_count: acc.row_count + num(r.row_count),
          // 跨仓库相加品种数会重复计数，取最大值仅为展示上界；单一仓库时是精确值
          product_count: Math.max(acc.product_count, num(r.product_count)),
          on_hand_quantity: acc.on_hand_quantity + num(r.on_hand_quantity),
          available_quantity: acc.available_quantity + num(r.available_quantity),
          locked_quantity: acc.locked_quantity + num(r.locked_quantity),
          inspection_quantity: acc.inspection_quantity + num(r.inspection_quantity),
          hold_quantity: acc.hold_quantity + num(r.hold_quantity),
          rejected_quantity: acc.rejected_quantity + num(r.rejected_quantity),
          total_cost: acc.total_cost + num(r.total_cost),
          low_stock_count: acc.low_stock_count + num(r.low_stock_count),
        }),
        { ...emptyTotals },
      );
      setTotals(merged);
    } catch (error) {
      console.error('Error fetching inventory totals:', error);
    }
  }, [selectedWarehouse]);

  useEffect(() => {
    fetchStock();
  }, [fetchStock]);

  useEffect(() => {
    fetchTotals();
  }, [fetchTotals]);

  const reload = () => {
    fetchStock();
    fetchTotals();
  };

  const statusLabels: Record<string, { text: string; color: string }> = {
    available: { text: t('stockInventory.statusAvailable'), color: 'success' },
    inspection: { text: t('stockInventory.statusInspection'), color: 'warning' },
    hold: { text: t('stockInventory.statusHold'), color: 'blue' },
    rejected: { text: t('stockInventory.statusRejected'), color: 'error' },
  };

  const columns = [
    { title: t('stockInventory.productCode'), dataIndex: 'product_code', key: 'product_code', width: 120, render: (v: string) => v || '-' },
    { title: t('stockInventory.productName'), dataIndex: 'product_name', key: 'product_name', render: (v: string) => v || '-' },
    {
      title: t('stockInventory.specification'),
      dataIndex: 'specification',
      key: 'specification',
      width: 120,
      render: (v: string) => v || '-',
    },
    { title: t('stockInventory.unit'), dataIndex: 'unit', key: 'unit', width: 70, render: (v: string) => v || '-' },
    {
      title: t('stockInventory.warehouse'),
      dataIndex: 'warehouse_name',
      key: 'warehouse_name',
      width: 110,
      render: (v: string) => v || '-',
    },
    {
      title: t('stockInventory.bin'),
      dataIndex: 'bin_name',
      key: 'bin_name',
      width: 110,
      render: (v: string, r: StockRow) => (v ? `${r.bin_code ?? ''} ${v}`.trim() : '-'),
    },
    { title: t('stockInventory.batchNo'), dataIndex: 'batch_no', key: 'batch_no', width: 110, render: (v: string) => v || '-' },
    {
      title: t('stockInventory.stockStatus'),
      dataIndex: 'stock_status',
      key: 'stock_status',
      width: 100,
      render: (v: string) => {
        const cfg = statusLabels[v] || { text: v, color: 'default' };
        return <Tag color={cfg.color}>{cfg.text}</Tag>;
      },
    },
    {
      title: t('stockInventory.quantity'),
      dataIndex: 'quantity',
      key: 'quantity',
      width: 110,
      render: (v: number) => num(v).toLocaleString(),
    },
    {
      title: t('stockInventory.availableQuantity'),
      dataIndex: 'available_quantity',
      key: 'available_quantity',
      width: 110,
      render: (v: number) => num(v).toLocaleString(),
    },
    {
      title: t('stockInventory.lockedQuantity'),
      dataIndex: 'locked_quantity',
      key: 'locked_quantity',
      width: 110,
      render: (v: number) => num(v).toLocaleString(),
    },
    {
      title: t('stockInventory.unitCost'),
      dataIndex: 'unit_cost',
      key: 'unit_cost',
      width: 110,
      render: (cost: number) => formatMoney(cost, baseCurrencyCode),
    },
    {
      title: t('stockInventory.totalCost'),
      dataIndex: 'total_cost',
      key: 'total_cost',
      width: 130,
      render: (cost: number) => formatMoney(cost, baseCurrencyCode),
    },
    { title: t('stockInventory.expiryDate'), dataIndex: 'expiry_date', key: 'expiry_date', width: 120, render: (v: string) => v || '-' },
    {
      title: t('common.status'),
      key: 'safety',
      width: 100,
      render: (_: unknown, record: StockRow) => (
        <Tag color={record.is_low_stock ? 'error' : 'success'}>
          {record.is_low_stock ? t('stockInventory.lowStock') : t('stockInventory.normal')}
        </Tag>
      ),
    },
  ];

  return (
    <Card
      variant="borderless"
      title={t('stockInventory.title')}
      extra={
        <Button icon={<ReloadOutlined />} onClick={reload}>
          {t('common.refresh')}
        </Button>
      }
    >
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={6}>
          <Card>
            <Statistic title={t('stockInventory.totalQuantity')} value={totals.on_hand_quantity} precision={2} />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic title={t('stockInventory.availableQuantity')} value={totals.available_quantity} precision={2} />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic title={t('stockInventory.totalValue')} value={totals.total_cost} prefix={baseCurrencyCode} precision={2} />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic
              title={t('stockInventory.lowStockRows')}
              value={totals.low_stock_count}
              valueStyle={totals.low_stock_count > 0 ? { color: '#cf1322' } : undefined}
            />
          </Card>
        </Col>
      </Row>

      <SuperTable
        columns={columns}
        dataSource={rows}
        storageKey="stockInventory"
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 15 }}
        toolbarActions={['export']}
        queryBar={
          <Space wrap>
            <Input
              placeholder={t('stockInventory.searchPlaceholder')}
              prefix={<SearchOutlined />}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              onPressEnter={fetchStock}
              allowClear
              style={{ width: 280 }}
            />
            <Select
              placeholder={t('stockInventory.allWarehouses')}
              value={selectedWarehouse}
              onChange={(value) => setSelectedWarehouse(value)}
              style={{ width: 180 }}
              allowClear
            >
              {warehouses.map((w) => (
                <Option key={w.id} value={w.id}>
                  {w.name}
                </Option>
              ))}
            </Select>
            <Select
              placeholder={t('stockInventory.allStatuses')}
              value={selectedStatus}
              onChange={(value) => setSelectedStatus(value)}
              style={{ width: 150 }}
              allowClear
            >
              {STOCK_STATUSES.map((s) => (
                <Option key={s} value={s}>
                  {statusLabels[s].text}
                </Option>
              ))}
            </Select>
            <Space size={4}>
              <Switch checked={onlyLowStock} onChange={setOnlyLowStock} size="small" />
              <span>{t('stockInventory.onlyLowStock')}</span>
            </Space>
            <Button icon={<ReloadOutlined />} onClick={reload}>
              {t('common.refresh')}
            </Button>
          </Space>
        }
      />
    </Card>
  );
}

export default Inventory;
